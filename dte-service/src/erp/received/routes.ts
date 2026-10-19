import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../../auth/auth.middleware.js';
import { encryptSecret } from '../../auth/crypto.js';
import { ValidationError } from '../../errors.js';
import { authedPlugin, ctx, idParam, intParam, parse, q } from '../http.js';
import { imapClient, ingestText, runMailbox, safeError } from './service.js';

/**
 * DTEs recibidos (F6): subir JSON de proveedores o leerlos del buzón IMAP de
 * la empresa; cada DTE válido entra al libro de compras y se contabiliza.
 */

const MailboxBody = z.object({
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

    // ── Buzón IMAP de la empresa ─────────────────────────────────────────────
    r.get('/v2/received-mailbox', { preHandler: requirePerm('accounting:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const res = await q(`SELECT host, port, username, folder, enabled, last_run_at, last_status, last_detail
                             FROM accounting.mailboxes WHERE tenant_id = $1`, [tenantId]);
      return { mailbox: res.rows[0] ?? null };
    });

    r.put('/v2/received-mailbox', { preHandler: requirePerm('accounting:config') }, async (req) => {
      const { tenantId } = ctx(req);
      const b = parse(MailboxBody, req.body);
      const existing = await q<{ password_enc: string }>('SELECT password_enc FROM accounting.mailboxes WHERE tenant_id = $1', [tenantId]);
      const enc = b.password ? encryptSecret(b.password) : existing.rows[0]?.password_enc;
      if (!enc) throw new ValidationError('Indica la contraseña del buzón');
      await q(`INSERT INTO accounting.mailboxes (tenant_id, host, port, username, password_enc, folder, enabled)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (tenant_id) DO UPDATE SET host = $2, port = $3, username = $4, password_enc = $5, folder = $6, enabled = $7, updated_at = NOW()`,
        [tenantId, b.host, b.port, b.username, enc, b.folder, b.enabled]);
      return { success: true };
    });

    r.post('/v2/received-mailbox/test', { preHandler: requirePerm('accounting:config') }, async (req) => {
      const b = parse(MailboxBody.extend({ password: z.string().min(1, 'Indica la contraseña para probar') }), req.body);
      const client = imapClient({ host: b.host, port: b.port, username: b.username, password: b.password });
      try {
        await client.connect();
        const lock = await client.getMailboxLock(b.folder, { readOnly: true });
        const exists = client.mailbox ? client.mailbox.exists : 0;
        lock.release();
        return { ok: true, messages: exists };
      } catch (e) {
        return { ok: false, error: safeError(e, [b.password, b.username]) };
      } finally {
        await client.logout().catch(() => client.close());
      }
    });

    r.post('/v2/received-mailbox/run', { preHandler: requirePerm('accounting:post') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({ since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() }), req.body);
      return runMailbox(c, { since: b.since ?? null, trigger: 'manual' });
    });
  });
}
