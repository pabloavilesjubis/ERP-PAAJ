import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../../auth/auth.middleware.js';
import { decryptSecret, encryptSecret } from '../../auth/crypto.js';
import { ValidationError } from '../../errors.js';
import { authedPlugin, ctx, idParam, intParam, parse, q } from '../http.js';
import { imapClient, ingestText, runMailbox, safeError } from './service.js';

/**
 * DTEs recibidos (F6): subir JSON de proveedores o leerlos del buzón IMAP de
 * la empresa; cada DTE válido entra al libro de compras y se contabiliza.
 */

const MailboxBody = z.object({
  label: z.string().trim().max(60).nullable().optional().transform(v => v || null),
  host: z.string().trim().min(3, 'Indica el servidor IMAP'),
  port: z.number().int().min(1).max(65535).default(993),
  username: z.string().trim().min(3, 'Indica el usuario'),
  password: z.string().optional(),            // vacío = conservar la actual
  folder: z.string().trim().min(1).default('INBOX'),
  enabled: z.boolean().default(true),
});

export async function registerReceivedRoutes(app: FastifyInstance): Promise<void> {
  await authedPlugin(app, (r) => {
    r.post('/v2/received/upload', { preHandler: requirePerm('accounting:post') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({ files: z.array(z.object({ name: z.string().max(200), content: z.string().max(600_000) })).min(1).max(200) }), req.body);
      const results = [];
      for (const f of b.files) {
        try {
          const out = await ingestText(c, f.content, 'upload', { file_name: f.name });
          results.push(out.ok
            ? { file: f.name, code: out.code, ...out.result, warnings: out.warnings }
            : { file: f.name, status: 'error', detail: out.error });
        } catch (e) {
          results.push({ file: f.name, status: 'error', detail: e instanceof Error ? e.message : String(e) });
        }
      }
      return { results };
    });

    r.get('/v2/received', { preHandler: requirePerm('accounting:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const qp = req.query as Record<string, string | undefined>;
      const params: unknown[] = [tenantId];
      let where = 'tenant_id = $1';
      if (qp.status) { params.push(qp.status); where += ` AND status = $${params.length}`; }
      if (qp.q) { params.push(`%${qp.q}%`); where += ` AND (issuer_name ILIKE $${params.length} OR control_number ILIKE $${params.length} OR generation_code ILIKE $${params.length})`; }
      const limit = intParam(qp.limit, 300, 2000);
      const res = await q(`SELECT id, source, status, detail, generation_code, control_number, document_type, issue_date, issuer_name, issuer_nrc,
                                  taxable_amount, iva_amount, total_amount, compra_id, file_name, mail_from, created_at
                             FROM accounting.received_dtes WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit}`, params);
      return { items: res.rows };
    });

    r.get('/v2/received/:id', { preHandler: requirePerm('accounting:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const res = await q('SELECT * FROM accounting.received_dtes WHERE id = $1 AND tenant_id = $2', [idParam(req), tenantId]);
      if (!res.rows.length) throw new ValidationError('No encontrado');
      return res.rows[0];
    });

    // ── Cuentas de correo (IMAP) de la empresa: pueden ser varias ───────────
    const COLS = 'id, label, host, port, username, folder, enabled, last_run_at, last_status, last_detail';
    const boxId = (req: { params: unknown }) => {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id) || id <= 0) throw new ValidationError('Cuenta inválida');
      return id;
    };
    const assertUnique = async (tenantId: number, b: z.infer<typeof MailboxBody>, exceptId: number | null) => {
      const dup = await q(`SELECT 1 FROM accounting.mailboxes WHERE tenant_id = $1 AND lower(host) = lower($2) AND lower(username) = lower($3)
                             AND folder = $4 AND id IS DISTINCT FROM $5`, [tenantId, b.host, b.username, b.folder, exceptId]);
      if (dup.rows.length) throw new ValidationError(`La cuenta ${b.username} (${b.folder}) ya está agregada`);
    };

    r.get('/v2/received-mailboxes', { preHandler: requirePerm('accounting:view') }, async (req) => {
      const { tenantId } = ctx(req);
      return { items: (await q(`SELECT ${COLS} FROM accounting.mailboxes WHERE tenant_id = $1 ORDER BY id`, [tenantId])).rows };
    });

    r.post('/v2/received-mailboxes', { preHandler: requirePerm('accounting:config') }, async (req) => {
      const { tenantId } = ctx(req);
      const b = parse(MailboxBody.extend({ password: z.string({ required_error: 'Indica la contraseña del correo' }).min(1, 'Indica la contraseña del correo') }), req.body);
      await assertUnique(tenantId, b, null);
      const res = await q<{ id: number }>(`INSERT INTO accounting.mailboxes (tenant_id, label, host, port, username, password_enc, folder, enabled)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [tenantId, b.label, b.host, b.port, b.username, encryptSecret(b.password), b.folder, b.enabled]);
      return { id: res.rows[0]!.id };
    });

    r.put('/v2/received-mailboxes/:id', { preHandler: requirePerm('accounting:config') }, async (req) => {
      const { tenantId } = ctx(req);
      const id = boxId(req);
      const b = parse(MailboxBody, req.body);
      await assertUnique(tenantId, b, id);
      // Contraseña vacía = conservar la actual
      const res = await q(`UPDATE accounting.mailboxes SET label = $3, host = $4, port = $5, username = $6,
                             password_enc = COALESCE($7, password_enc), folder = $8, enabled = $9, updated_at = NOW()
                            WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId, b.label, b.host, b.port, b.username, b.password ? encryptSecret(b.password) : null, b.folder, b.enabled]);
      if (!res.rowCount) throw new ValidationError('La cuenta de correo no existe');
      return { success: true };
    });

    r.delete('/v2/received-mailboxes/:id', { preHandler: requirePerm('accounting:config') }, async (req) => {
      const { tenantId } = ctx(req);
      await q('DELETE FROM accounting.mailboxes WHERE id = $1 AND tenant_id = $2', [boxId(req), tenantId]);
      return { success: true };
    });

    // Prueba la conexión. Al editar una cuenta existente sin escribir la contraseña, usa la guardada.
    r.post('/v2/received-mailboxes/test', { preHandler: requirePerm('accounting:config') }, async (req) => {
      const { tenantId } = ctx(req);
      const b = parse(MailboxBody.extend({ id: z.number().int().positive().optional() }), req.body);
      let password = b.password;
      if (!password && b.id) {
        const row = (await q<{ password_enc: string }>('SELECT password_enc FROM accounting.mailboxes WHERE id = $1 AND tenant_id = $2', [b.id, tenantId])).rows[0];
        if (row) password = decryptSecret(row.password_enc);
      }
      if (!password) throw new ValidationError('Indica la contraseña para probar');
      const client = imapClient({ host: b.host, port: b.port, username: b.username, password });
      try {
        await client.connect();
        const lock = await client.getMailboxLock(b.folder, { readOnly: true });
        const exists = client.mailbox ? client.mailbox.exists : 0;
        lock.release();
        return { ok: true, messages: exists };
      } catch (e) {
        return { ok: false, error: safeError(e, [password, b.username]) };
      } finally {
        await client.logout().catch(() => client.close());
      }
    });

    // Revisar ahora: sin meses, los últimos 30 días; con { from, to } (YYYY-MM) los meses completos
    r.post('/v2/received-mailboxes/:id/run', { preHandler: requirePerm('accounting:post') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({
        from: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mes inicial inválido').nullable().optional(),
        to: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mes final inválido').nullable().optional(),
      }), req.body);
      if (!b.from) return runMailbox(c, boxId(req), { trigger: 'manual' });
      const to = b.to ?? b.from;
      if (to < b.from) throw new ValidationError('El mes final no puede ser anterior al inicial');
      const [ty, tm] = to.split('-').map(Number) as [number, number];
      const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
      return runMailbox(c, boxId(req), { since: `${b.from}-01`, until: `${to}-${String(lastDay).padStart(2, '0')}`, trigger: 'manual' });
    });
  });
}
