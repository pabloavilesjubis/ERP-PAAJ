import { ImapFlow } from 'imapflow';
import type { MessageStructureObject } from 'imapflow';
import type pg from 'pg';
import { decryptSecret } from '../../auth/crypto.js';
import { q, tx, type Ctx } from '../http.js';
import { parseDteJson, type ParsedDte } from './dteParser.js';

/**
 * Buzón de DTEs recibidos (portado de ChuchoWash api/_lib/mail/*): cada
 * empresa configura su IMAP; se lee en solo lectura (EXAMINE + BODY.PEEK),
 * se toman los adjuntos .json que sean DTE y cada uno pasa por
 * accounting.ingest_received_dte (duplicados, receptor, proveedor, libro de
 * compras → contabilidad). Los correos ya procesados no se vuelven a leer;
 * los que fallaron se reintentan (hasta 10 veces en automático).
 */

export const MAX_DTE_JSON_BYTES = 512 * 1024;
const LOOKBACK_DAYS = 30;
const MAX_AUTO_ATTEMPTS = 10;
const BUDGET_MS = 120_000;

export interface IngestResult { id: number; status: 'registrado' | 'duplicado' | 'rechazado'; detail: string | null; compra_id: number | null }

export function docForSql(d: ParsedDte): Record<string, unknown> {
  return {
    generation_code: d.generationCode, control_number: d.controlNumber || null, reception_stamp: d.receptionStamp,
    document_type: d.documentType, issue_date: d.issueDate || null, description: d.description || null,
    receiver_nit: d.receiver?.nit || null, receiver_nrc: d.receiver?.nrc || null, receiver_dui: d.receiver?.dui || null,
    receiver_name: d.receiver?.name || null,
    issuer_nit: d.issuer.nit || null, issuer_nrc: d.issuer.nrc || null, issuer_name: d.issuer.name || null, issuer: d.issuer,
    taxable_amount: d.taxableAmount, exempt_amount: d.exemptAmount, non_subject_amount: d.nonSubjectAmount,
    iva_amount: d.ivaAmount, other_taxes: d.otherTaxes, iva_perceived: d.ivaPerceived, iva_withheld: d.ivaWithheld,
    income_tax_withheld: d.incomeTaxWithheld, total_amount: d.totalAmount,
  };
}

/** DTE en UTF-8; algunos emisores mandan Windows-1252 (Ñ, tildes). */
export function decodeJson(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Un JSON → resultado de ingesta. Errores de lectura se devuelven como texto. */
export async function ingestText(c: Ctx, text: string, source: 'upload' | 'email', meta: Record<string, unknown>):
  Promise<{ ok: true; result: IngestResult; warnings: string[]; code: string; control: string | null } | { ok: false; error: string }> {
  const parsed = parseDteJson(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (!parsed.data.generationCode) return { ok: false, error: 'El JSON no tiene código de generación' };
  const d = parsed.data;
  const res = await tx(db => q<{ r: IngestResult }>('SELECT accounting.ingest_received_dte($1, $2::jsonb, $3::jsonb, $4, $5::jsonb) AS r',
    [c.tenantId, JSON.stringify(docForSql(d)), JSON.stringify(d.raw), source, JSON.stringify(meta)], db), c);
  return { ok: true, result: res.rows[0]!.r, warnings: d.warnings, code: d.generationCode, control: d.controlNumber || null };
}

// ── IMAP ─────────────────────────────────────────────────────────────────────
interface Attachment { part: string; filename: string; kind: 'json' | 'pdf' | 'other' }

export function listAttachments(node: MessageStructureObject | undefined): Attachment[] {
  if (!node) return [];
  const out: Attachment[] = [];
  const walk = (n: MessageStructureObject) => {
    const mimeType = (n.type ?? '').toLowerCase();
    if (n.childNodes?.length && mimeType !== 'message/rfc822') { n.childNodes.forEach(walk); return; }
    const filename = n.dispositionParameters?.filename ?? n.parameters?.name ?? null;
    const isFile = n.disposition?.toLowerCase() === 'attachment' || !!filename || mimeType === 'application/json' || mimeType === 'application/pdf';
    if (isFile && n.part) {
      const lower = (filename ?? '').toLowerCase();
      const kind = lower.endsWith('.json') || mimeType === 'application/json' ? 'json'
        : lower.endsWith('.pdf') || mimeType === 'application/pdf' ? 'pdf' : 'other';
      out.push({ part: n.part, filename: filename ?? `parte-${n.part}`, kind });
    }
    if (mimeType === 'message/rfc822') n.childNodes?.forEach(walk);
  };
  walk(node);
  return out;
}

export interface MailboxRow { id: number; tenant_id: number; host: string; port: number; username: string; password_enc: string; folder: string }

export function imapClient(m: { host: string; port: number; username: string; password: string }): ImapFlow {
  return new ImapFlow({
    host: m.host, port: m.port, secure: true,
    auth: { user: m.username, pass: m.password },
    logger: false, disableAutoIdle: true,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000,
  });
}

/** Mensaje de error sin credenciales. */
export function safeError(e: unknown, secrets: string[]): string {
  const err = e as { message?: string; responseText?: string };
  let s = `${err?.message ?? String(e)}${err?.responseText ? ` (${err.responseText})` : ''}`;
  for (const secret of secrets) if (secret) s = s.split(secret).join('[REDACTED]');
  return s.replace(/\b(LOGIN|AUTHENTICATE)\b[^\n]*/gi, '$1 [REDACTED]').slice(0, 400);
}

export interface RunSummary { scanned: number; imported: number; duplicates: number; rejected: number; errors: number; pending: number; status: 'done' | 'partial' | 'error'; detail: string | null }

/**
 * Revisa una cuenta de correo. Sin rango: los últimos LOOKBACK_DAYS días. Con
 * `since`/`until` (YYYY-MM-DD, ambos inclusive) revisa los correos recibidos en
 * ese período, p. ej. meses completos. Corta a los BUDGET_MS y devuelve
 * `partial` con lo pendiente: repetir la misma llamada continúa donde quedó.
 */
export async function runMailbox(c: Ctx, mailboxId: number, opts: { since?: string | null; until?: string | null; trigger: 'auto' | 'manual' }): Promise<RunSummary> {
  const sum: RunSummary = { scanned: 0, imported: 0, duplicates: 0, rejected: 0, errors: 0, pending: 0, status: 'done', detail: null };
  const box = (await q<MailboxRow>('SELECT * FROM accounting.mailboxes WHERE id = $1 AND tenant_id = $2', [mailboxId, c.tenantId])).rows[0];
  if (!box) throw new Error('La cuenta de correo no existe');
  // Sin datos fiscales no se puede validar que un DTE sea para la empresa: no se
  // lee nada (los correos quedan pendientes para cuando se completen).
  const emisor = await q('SELECT 1 FROM public.tenant_emisor WHERE tenant_id = $1', [c.tenantId]);
  if (!emisor.rows.length) {
    const detail = 'Completa los datos fiscales de la empresa en Mi empresa (NIT y NRC) para leer el buzón';
    await q(`UPDATE accounting.mailboxes SET last_run_at = NOW(), last_status = 'error', last_detail = $2 WHERE id = $1`, [box.id, detail]);
    return { ...sum, status: 'error', detail };
  }
  const password = decryptSecret(box.password_enc);
  const secrets = [password, box.username];
  const started = Date.now();
  const since = opts.since ?? new Date(started - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const client = imapClient({ host: box.host, port: box.port, username: box.username, password });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(box.folder, { readOnly: true });
    try {
      const mb = client.mailbox;
      if (!mb || !mb.readOnly) throw new Error('El buzón no se abrió en modo de solo lectura');
      const uidValidity = String(mb.uidValidity);
      // IMAP filtra por fecha de recepción del correo; BEFORE es exclusivo: día siguiente a `until`
      const before = opts.until ? new Date(new Date(`${opts.until}T00:00:00-06:00`).getTime() + 86_400_000) : undefined;
      const found = await client.search({ since: new Date(`${since}T00:00:00-06:00`), ...(before ? { before } : {}) }, { uid: true });
      const uids = (Array.isArray(found) ? found : []).sort((a, b) => a - b);
      const known = new Map((await q<{ uid: number; status: string; attempts: number; dte_count: number; pdf_checked: boolean }>(
        'SELECT uid, status, attempts, dte_count, pdf_checked FROM accounting.mail_messages WHERE mailbox_id = $1 AND folder = $2 AND uid_validity = $3 AND uid = ANY($4::bigint[])',
        [box.id, box.folder, uidValidity, uids])).rows.map(k => [Number(k.uid), k]));
      const todo = uids.filter(uid => {
        const k = known.get(uid);
        if (!k) return true;
        if (k.status !== 'error') return false;
        return opts.trigger === 'manual' || k.attempts < MAX_AUTO_ATTEMPTS;
      });
      for (let i = 0; i < todo.length; i++) {
        if (Date.now() - started > BUDGET_MS) { sum.pending = todo.length - i; break; }
        const uid = todo[i]!;
        let msg: Awaited<ReturnType<ImapFlow['fetchOne']>> | undefined;
        try {
          msg = await client.fetchOne(String(uid), { uid: true, envelope: true, bodyStructure: true, internalDate: true }, { uid: true });
        } catch (e) { sum.errors++; await saveMessage(c, box.id, box.folder, uidValidity, uid, 'error', 0, null, safeError(e, secrets)); continue; }
        if (!msg) continue;
        sum.scanned++;
        const from = msg.envelope?.from?.[0];
        const header = { mail_from: from ? (from.name ? `${from.name} <${from.address ?? ''}>` : from.address ?? null) : null, mail_subject: msg.envelope?.subject ?? null };
        const attachments = listAttachments(msg.bodyStructure);
        const jsons = attachments.filter(a => a.kind === 'json');
        const pdfs = attachments.filter(a => a.kind === 'pdf');
        const registrados: Array<{ compraId: number; code: string; control: string | null }> = [];
        if (!jsons.length) { await saveMessage(c, box.id, box.folder, uidValidity, uid, 'sin_dte', 0, header, null); continue; }
        const notes: string[] = [];
        let failed = false;
        let count = 0;
        for (const j of jsons) {
          try {
            const dl = await client.download(String(uid), j.part, { uid: true, maxBytes: MAX_DTE_JSON_BYTES + 1 });
            if (!dl.content) { notes.push(`${j.filename}: no se pudo descargar`); failed = true; continue; }
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of dl.content) {
              const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
              size += b.length; chunks.push(b);
              if (size > MAX_DTE_JSON_BYTES) break;
            }
            if (size > MAX_DTE_JSON_BYTES) { notes.push(`${j.filename}: demasiado grande`); continue; }
            const out = await ingestText(c, decodeJson(Buffer.concat(chunks)), 'email', { file_name: j.filename, ...header });
            if (!out.ok) { notes.push(`${j.filename}: ${out.error}`); continue; }
            count++;
            if (out.result.status === 'registrado') {
              sum.imported++;
              if (out.result.compra_id) registrados.push({ compraId: out.result.compra_id, code: out.code, control: out.control });
            }
            else if (out.result.status === 'duplicado') sum.duplicates++;
            else sum.rejected++;
            notes.push(`${out.code}: ${out.result.status}`);
          } catch (e) {
            failed = true; sum.errors++;
            notes.push(`${j.filename}: ${safeError(e, secrets)}`);
          }
        }
        // El PDF del correo queda como adjunto de la compra (si es claro a cuál pertenece)
        if (registrados.length && pdfs.length) {
          try { await attachMailPdfs(c, client, uid, pdfs, registrados); }
          catch (e) { notes.push(`PDF: ${safeError(e, secrets)}`); }
        }
        await saveMessage(c, box.id, box.folder, uidValidity, uid, failed ? 'error' : 'procesado', count, header, notes.join(' · ').slice(0, 1000));
        await markPdfChecked(box.id, box.folder, uidValidity, uid);
      }

      // Revisión manual de meses: completa el PDF de las compras de correos procesados antes de que se guardara
      const backfill = opts.trigger === 'manual' && opts.since && !sum.pending
        ? uids.filter(uid => { const k = known.get(uid); return k && k.status === 'procesado' && k.dte_count > 0 && !k.pdf_checked; })
        : [];
      for (let i = 0; i < backfill.length; i++) {
        if (Date.now() - started > BUDGET_MS) { sum.pending = backfill.length - i; break; }
        const uid = backfill[i]!;
        try {
          const msg = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
          const att = msg ? listAttachments(msg.bodyStructure) : [];
          const pdfs = att.filter(a => a.kind === 'pdf');
          if (pdfs.length) {
            const registrados: Array<{ compraId: number; code: string; control: string | null }> = [];
            for (const j of att.filter(a => a.kind === 'json')) {
              const dl = await client.download(String(uid), j.part, { uid: true, maxBytes: MAX_DTE_JSON_BYTES + 1 });
              if (!dl.content) continue;
              const chunks: Buffer[] = [];
              for await (const chunk of dl.content) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
              const parsed = parseDteJson(decodeJson(Buffer.concat(chunks)));
              if (!parsed.ok || !parsed.data.generationCode) continue;
              const r = (await q<{ compra_id: number }>(
                `SELECT compra_id FROM accounting.received_dtes WHERE tenant_id = $1 AND upper(generation_code) = upper($2)
                   AND status = 'registrado' AND compra_id IS NOT NULL LIMIT 1`, [c.tenantId, parsed.data.generationCode])).rows[0];
              if (r) registrados.push({ compraId: Number(r.compra_id), code: parsed.data.generationCode, control: parsed.data.controlNumber || null });
            }
            if (registrados.length) await attachMailPdfs(c, client, uid, pdfs, registrados);
          }
          await markPdfChecked(box.id, box.folder, uidValidity, uid);
        } catch (e) { sum.errors++; }
      }
    } finally {
      lock.release();
    }
    if (sum.pending) { sum.status = 'partial'; sum.detail = `Quedan ${sum.pending} correos por revisar`; }
  } catch (e) {
    sum.status = 'error';
    sum.detail = safeError(e, secrets);
  } finally {
    await client.logout().catch(() => client.close());
  }
  await q(`UPDATE accounting.mailboxes SET last_run_at = NOW(), last_status = $2, last_detail = $3 WHERE id = $1`,
    [box.id, sum.status, sum.detail ?? `${sum.imported} registrados, ${sum.duplicates} duplicados, ${sum.rejected} rechazados de ${sum.scanned} correos`]);
  return sum;
}

const MAX_PDF_BYTES = 10 * 1024 * 1024;

/**
 * Guarda el PDF del correo como adjunto de la compra registrada. Con un solo
 * DTE en el correo, el primer PDF es suyo; con varios, cada PDF va con el DTE
 * cuyo código de generación o número de control aparece en el nombre del
 * archivo (si no es claro, no se adivina). Nunca reemplaza un PDF ya subido.
 */
async function attachMailPdfs(c: Ctx, client: ImapFlow, uid: number, pdfs: Attachment[],
  registrados: Array<{ compraId: number; code: string; control: string | null }>): Promise<void> {
  const norm = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const pares: Array<{ pdf: Attachment; compraId: number }> = [];
  if (registrados.length === 1) pares.push({ pdf: pdfs[0]!, compraId: registrados[0]!.compraId });
  else {
    for (const r of registrados) {
      const pdf = pdfs.find(p => norm(p.filename).includes(norm(r.code)) || (r.control && norm(p.filename).includes(norm(r.control))));
      if (pdf) pares.push({ pdf, compraId: r.compraId });
    }
  }
  for (const { pdf, compraId } of pares) {
    const dl = await client.download(String(uid), pdf.part, { uid: true, maxBytes: MAX_PDF_BYTES + 1 });
    if (!dl.content) continue;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of dl.content) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += b.length; chunks.push(b);
      if (size > MAX_PDF_BYTES) break;
    }
    const content = Buffer.concat(chunks);
    if (size > MAX_PDF_BYTES || content.subarray(0, 5).toString('latin1') !== '%PDF-') continue;
    await q(`INSERT INTO public.compra_adjuntos (tenant_id, compra_id, kind, filename, mime, size, content, uploaded_by)
             VALUES ($1, $2, 'pdf', $3, 'application/pdf', $4, $5, 'Buzón DTE') ON CONFLICT (compra_id, kind) DO NOTHING`,
      [c.tenantId, compraId, pdf.filename || 'dte.pdf', content.length, content]);
  }
}

async function markPdfChecked(mailboxId: number, folder: string, uidValidity: string, uid: number): Promise<void> {
  await q('UPDATE accounting.mail_messages SET pdf_checked = true WHERE mailbox_id = $1 AND folder = $2 AND uid_validity = $3 AND uid = $4',
    [mailboxId, folder, uidValidity, uid]);
}

async function saveMessage(c: Ctx, mailboxId: number, folder: string, uidValidity: string, uid: number, status: string, count: number,
  header: { mail_from: string | null; mail_subject: string | null } | null, detail: string | null, db?: pg.PoolClient): Promise<void> {
  await q(`INSERT INTO accounting.mail_messages (tenant_id, mailbox_id, folder, uid_validity, uid, status, dte_count, mail_from, subject, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (mailbox_id, folder, uid_validity, uid) DO UPDATE SET status = $6, dte_count = $7,
             attempts = accounting.mail_messages.attempts + 1, detail = $10, updated_at = NOW()`,
    [c.tenantId, mailboxId, folder, uidValidity, uid, status, count, header?.mail_from ?? null, header?.mail_subject ?? null, detail], db);
}

/** Revisa las cuentas de correo habilitadas de todas las empresas cada 30 minutos. */
export function startMailboxScheduler(log: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }): NodeJS.Timeout {
  const tick = async () => {
    try {
      const boxes = await q<{ id: number; tenant_id: number }>(`
        SELECT m.id, m.tenant_id FROM accounting.mailboxes m JOIN public.tenants t ON t.id = m.tenant_id
         WHERE m.enabled AND t.status = 'active' ORDER BY m.tenant_id, m.id`);
      for (const b of boxes.rows) {
        const res = await runMailbox({ tenantId: b.tenant_id, userId: 'sistema', userName: 'Buzón DTE' }, b.id, { trigger: 'auto' })
          .catch(e => ({ status: 'error', detail: String(e) }));
        log.info({ tenant: b.tenant_id, mailbox: b.id, res }, 'buzón DTE revisado');
      }
    } catch (e) {
      // Base sin la migración 012 aún: el programador espera a la siguiente vuelta
      log.error({ err: e }, 'buzón DTE: fallo del programador');
    }
  };
  const timer = setInterval(() => void tick(), 30 * 60_000);
  timer.unref();
  setTimeout(() => void tick(), 60_000).unref();
  return timer;
}
