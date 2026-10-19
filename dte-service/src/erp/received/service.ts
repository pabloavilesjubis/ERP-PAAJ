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
    receiver_nit: d.receiver?.nit || null, receiver_nrc: d.receiver?.nrc || null, receiver_name: d.receiver?.name || null,
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
  Promise<{ ok: true; result: IngestResult; warnings: string[]; code: string } | { ok: false; error: string }> {
  const parsed = parseDteJson(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (!parsed.data.generationCode) return { ok: false, error: 'El JSON no tiene código de generación' };
  const d = parsed.data;
  const res = await tx(db => q<{ r: IngestResult }>('SELECT accounting.ingest_received_dte($1, $2::jsonb, $3::jsonb, $4, $5::jsonb) AS r',
    [c.tenantId, JSON.stringify(docForSql(d)), JSON.stringify(d.raw), source, JSON.stringify(meta)], db), c);
  return { ok: true, result: res.rows[0]!.r, warnings: d.warnings, code: d.generationCode };
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

export interface MailboxRow { tenant_id: number; host: string; port: number; username: string; password_enc: string; folder: string }

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

export async function runMailbox(c: Ctx, opts: { since?: string | null; trigger: 'auto' | 'manual' }): Promise<RunSummary> {
  const sum: RunSummary = { scanned: 0, imported: 0, duplicates: 0, rejected: 0, errors: 0, pending: 0, status: 'done', detail: null };
  const box = (await q<MailboxRow>('SELECT * FROM accounting.mailboxes WHERE tenant_id = $1', [c.tenantId])).rows[0];
  if (!box) throw new Error('El buzón no está configurado');
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
      const found = await client.search({ since: new Date(`${since}T00:00:00-06:00`) }, { uid: true });
      const uids = (Array.isArray(found) ? found : []).sort((a, b) => a - b);
      const known = new Map((await q<{ uid: number; status: string; attempts: number }>(
        'SELECT uid, status, attempts FROM accounting.mail_messages WHERE tenant_id = $1 AND folder = $2 AND uid_validity = $3 AND uid = ANY($4::bigint[])',
        [c.tenantId, box.folder, uidValidity, uids])).rows.map(k => [Number(k.uid), k]));
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
        } catch (e) { sum.errors++; await saveMessage(c, box.folder, uidValidity, uid, 'error', 0, null, safeError(e, secrets)); continue; }
        if (!msg) continue;
        sum.scanned++;
        const from = msg.envelope?.from?.[0];
        const header = { mail_from: from ? (from.name ? `${from.name} <${from.address ?? ''}>` : from.address ?? null) : null, mail_subject: msg.envelope?.subject ?? null };
        const jsons = listAttachments(msg.bodyStructure).filter(a => a.kind === 'json');
        if (!jsons.length) { await saveMessage(c, box.folder, uidValidity, uid, 'sin_dte', 0, header, null); continue; }
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
            if (out.result.status === 'registrado') sum.imported++;
            else if (out.result.status === 'duplicado') sum.duplicates++;
            else sum.rejected++;
            notes.push(`${out.code}: ${out.result.status}`);
          } catch (e) {
            failed = true; sum.errors++;
            notes.push(`${j.filename}: ${safeError(e, secrets)}`);
          }
        }
        await saveMessage(c, box.folder, uidValidity, uid, failed ? 'error' : 'procesado', count, header, notes.join(' · ').slice(0, 1000));
      }
    } finally {
      lock.release();
    }
    if (sum.pending) { sum.status = 'partial'; sum.detail = `Quedan ${sum.pending} correos para la próxima revisión`; }
  } catch (e) {
    sum.status = 'error';
    sum.detail = safeError(e, secrets);
  } finally {
    await client.logout().catch(() => client.close());
  }
  await q(`UPDATE accounting.mailboxes SET last_run_at = NOW(), last_status = $2, last_detail = $3 WHERE tenant_id = $1`,
    [c.tenantId, sum.status, sum.detail ?? `${sum.imported} registrados, ${sum.duplicates} duplicados, ${sum.rejected} rechazados de ${sum.scanned} correos`]);
  return sum;
}

async function saveMessage(c: Ctx, folder: string, uidValidity: string, uid: number, status: string, count: number,
  header: { mail_from: string | null; mail_subject: string | null } | null, detail: string | null, db?: pg.PoolClient): Promise<void> {
  await q(`INSERT INTO accounting.mail_messages (tenant_id, folder, uid_validity, uid, status, dte_count, mail_from, subject, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (tenant_id, folder, uid_validity, uid) DO UPDATE SET status = $5, dte_count = $6,
             attempts = accounting.mail_messages.attempts + 1, detail = $9, updated_at = NOW()`,
    [c.tenantId, folder, uidValidity, uid, status, count, header?.mail_from ?? null, header?.mail_subject ?? null, detail], db);
}

/** Revisa los buzones habilitados de todas las empresas cada 30 minutos. */
export function startMailboxScheduler(log: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }): NodeJS.Timeout {
  const tick = async () => {
    try {
      const boxes = await q<{ tenant_id: number }>(`
        SELECT m.tenant_id FROM accounting.mailboxes m JOIN public.tenants t ON t.id = m.tenant_id
         WHERE m.enabled AND t.status = 'active'`);
      for (const b of boxes.rows) {
        const res = await runMailbox({ tenantId: b.tenant_id, userId: 'sistema', userName: 'Buzón DTE' }, { trigger: 'auto' })
          .catch(e => ({ status: 'error', detail: String(e) }));
        log.info({ tenant: b.tenant_id, res }, 'buzón DTE revisado');
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
