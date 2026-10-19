import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../../auth/auth.middleware.js';
import type { Permission } from '../../auth/permissions.js';
import { ValidationError } from '../../errors.js';
import { authedPlugin, ctx, idParam, intParam, parse, q, tx } from '../http.js';

/**
 * Cuentas por cobrar (cxc) y por pagar (cxp): saldos por tercero, documentos,
 * antigüedad, cobros/pagos con aplicación a varios documentos, anticipos y
 * documentos manuales (saldos iniciales por cliente/proveedor).
 *
 *   GET  /v2/acc/:kind/parties         saldos por cliente / proveedor
 *   GET  /v2/acc/:kind/documents       documentos (abiertos o todos)
 *   POST /v2/acc/:kind/documents       documento manual
 *   POST /v2/acc/:kind/documents/:id/void
 *   GET  /v2/acc/:kind/aging           antigüedad de saldos
 *   GET  /v2/acc/:kind/payments        cobros / pagos
 *   GET  /v2/acc/:kind/payments/:id
 *   POST /v2/acc/:kind/payments
 *   POST /v2/acc/:kind/payments/:id/void
 *   GET  /v2/acc/:kind/check           auxiliar vs cuenta de control
 *   GET  /v2/acc/fund-accounts         cuentas de caja y bancos para cobrar/pagar
 */

type Kind = 'cxc' | 'cxp';
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)');

function kindOf(req: FastifyRequest): Kind {
  const k = (req.params as { kind?: string }).kind;
  if (k !== 'cxc' && k !== 'cxp') throw new ValidationError('Ruta inválida: use cxc o cxp');
  return k;
}

/** Permiso según el tipo de auxiliar (CxC → receivables, CxP → payables). */
function perm(action: 'view' | 'manage') {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const p = `${kindOf(req) === 'cxc' ? 'receivables' : 'payables'}:${action}` as Permission;
    return requirePerm(p)(req, reply);
  };
}

const asOf = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : new Date().toISOString().slice(0, 10));

const PaymentBody = z.object({
  payment_date: isoDate,
  party_key: z.string().min(3),
  method: z.enum(['efectivo', 'transferencia', 'cheque', 'tarjeta', 'compensacion', 'otro']),
  fund_account_id: z.number().int().positive().nullable().optional(),
  amount: z.number().min(0),
  allocations: z.array(z.object({ document_id: z.number().int().positive(), amount: z.number() })).max(500),
  reference: z.string().max(120).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

const ManualDocBody = z.object({
  party_id: z.number().int().positive(),
  doc_type: z.string().max(10).nullable().optional(),
  doc_number: z.string().max(60).nullable().optional(),
  doc_date: isoDate,
  due_date: isoDate.nullable().optional(),
  amount: z.number().refine(v => v !== 0, 'Indica el monto'),
  counter_account_id: z.number().int().positive(),
  description: z.string().max(300).nullable().optional(),
});

export async function registerSubledgerRoutes(app: FastifyInstance): Promise<void> {
  await authedPlugin(app, (r) => {
    r.get('/v2/acc/fund-accounts', async (req) => {
      const { tenantId } = ctx(req);
      // Cuentas asignadas a caja/caja chica/banco y sus hermanas (otras cuentas bancarias del mismo grupo)
      const res = await q(`
        WITH roles AS (
          SELECT account_id FROM accounting.account_roles WHERE tenant_id = $1 AND role_key IN ('cash', 'petty_cash', 'bank')
        ), parents AS (
          SELECT DISTINCT a.parent_id FROM accounting.accounts a JOIN roles r ON r.account_id = a.id WHERE a.parent_id IS NOT NULL
        )
        SELECT a.id, a.code, a.name
          FROM accounting.accounts a
         WHERE a.tenant_id = $1 AND a.allows_movements AND a.is_active
           AND (a.id IN (SELECT account_id FROM roles) OR a.parent_id IN (SELECT parent_id FROM parents))
         ORDER BY a.code`, [tenantId]);
      return { items: res.rows };
    });

    r.get('/v2/acc/:kind/parties', { preHandler: perm('view') }, async (req) => {
      const { tenantId } = ctx(req);
      const kind = kindOf(req);
      const qp = req.query as Record<string, string | undefined>;
      const date = asOf(qp.as_of);
      const res = await q(`
        WITH docs AS (
          SELECT d.party_key, d.party_id, d.party_name, d.due_date,
                 d.amount - coalesce((SELECT sum(a.amount) FROM accounting.payment_allocations a
                                       JOIN accounting.payments p ON p.id = a.payment_id
                                      WHERE a.document_id = d.id AND p.status = 'vigente' AND p.payment_date <= $3), 0) AS balance
            FROM accounting.documents d
           WHERE d.tenant_id = $1 AND d.kind = $2 AND d.status = 'vigente' AND d.doc_date <= $3
        ), adv AS (
          SELECT party_key, max(party_name) AS party_name, max(party_id) AS party_id, sum(unapplied) AS advances
            FROM accounting.payments
           WHERE tenant_id = $1 AND kind = $4 AND status = 'vigente' AND payment_date <= $3 AND unapplied > 0
           GROUP BY party_key
        ), bal AS (
          SELECT party_key, max(party_name) AS party_name, max(party_id) AS party_id,
                 count(*) FILTER (WHERE balance <> 0)::int AS open_docs,
                 sum(balance) AS balance,
                 sum(balance) FILTER (WHERE due_date < $3 AND balance > 0) AS overdue
            FROM docs GROUP BY party_key
        )
        SELECT coalesce(b.party_key, a.party_key) AS party_key,
               coalesce(b.party_name, a.party_name) AS party_name,
               coalesce(b.party_id, a.party_id) AS party_id,
               coalesce(b.open_docs, 0) AS open_docs,
               coalesce(b.balance, 0) AS balance,
               coalesce(b.overdue, 0) AS overdue,
               coalesce(a.advances, 0) AS advances
          FROM bal b FULL JOIN adv a ON a.party_key = b.party_key
         WHERE coalesce(b.balance, 0) <> 0 OR coalesce(a.advances, 0) <> 0 OR $5::boolean
         ORDER BY coalesce(b.balance, 0) DESC`,
        [tenantId, kind, date, kind === 'cxc' ? 'cobro' : 'pago', qp.all === '1']);
      return { as_of: date, items: res.rows };
    });

    r.get('/v2/acc/:kind/documents', { preHandler: perm('view') }, async (req) => {
      const { tenantId } = ctx(req);
      const kind = kindOf(req);
      const qp = req.query as Record<string, string | undefined>;
      const params: unknown[] = [tenantId, kind];
      let where = 'd.tenant_id = $1 AND d.kind = $2';
      if (qp.party_key) { params.push(qp.party_key); where += ` AND d.party_key = $${params.length}`; }
      if (qp.status === 'open') where += ` AND d.status = 'vigente' AND d.balance <> 0`;
      else if (qp.status === 'void') where += ` AND d.status = 'anulado'`;
      else where += ` AND d.status = 'vigente'`;
      if (qp.from) { params.push(qp.from); where += ` AND d.doc_date >= $${params.length}`; }
      if (qp.to) { params.push(qp.to); where += ` AND d.doc_date <= $${params.length}`; }
      if (qp.q) { params.push(`%${qp.q}%`); where += ` AND (d.doc_number ILIKE $${params.length} OR d.party_name ILIKE $${params.length})`; }
      const limit = intParam(qp.limit, 500, 5000);
      const res = await q(`
        SELECT d.id, d.source_module, d.source_id, d.party_key, d.party_id, d.party_name, d.party_nit, d.doc_type, d.doc_number,
               d.doc_date, d.due_date, d.amount, d.applied, d.balance, d.description, d.status, d.entry_id,
               (CURRENT_DATE - d.due_date) AS days_overdue
          FROM accounting.document_balances d
         WHERE ${where}
         ORDER BY d.due_date, d.id LIMIT ${limit}`, params);
      return { items: res.rows };
    });

    r.post('/v2/acc/:kind/documents', { preHandler: perm('manage') }, async (req) => {
      const c = ctx(req);
      const kind = kindOf(req);
      const b = parse(ManualDocBody, req.body);
      const res = await tx(db => q<{ id: number }>(
        'SELECT accounting.create_manual_document($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS id',
        [c.tenantId, kind, b.party_id, b.doc_type ?? null, b.doc_number ?? null, b.doc_date, b.due_date ?? null, b.amount,
         b.counter_account_id, b.description ?? null], db), c);
      return { id: res.rows[0]!.id };
    });

    r.post('/v2/acc/:kind/documents/:id/void', { preHandler: perm('manage') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({ reason: z.string().trim().min(3, 'Indica el motivo') }), req.body);
      await tx(db => q('SELECT accounting.void_manual_document($1, $2, $3)', [c.tenantId, idParam(req), b.reason], db), c);
      return { success: true };
    });

    r.get('/v2/acc/:kind/aging', { preHandler: perm('view') }, async (req) => {
      const { tenantId } = ctx(req);
      const kind = kindOf(req);
      const date = asOf((req.query as Record<string, string>).as_of);
      const res = await q(`
        WITH docs AS (
          SELECT d.party_key, d.party_name, d.due_date,
                 d.amount - coalesce((SELECT sum(a.amount) FROM accounting.payment_allocations a
                                       JOIN accounting.payments p ON p.id = a.payment_id
                                      WHERE a.document_id = d.id AND p.status = 'vigente' AND p.payment_date <= $3), 0) AS balance
            FROM accounting.documents d
           WHERE d.tenant_id = $1 AND d.kind = $2 AND d.status = 'vigente' AND d.doc_date <= $3
        )
        SELECT party_key, max(party_name) AS party_name,
               sum(balance) FILTER (WHERE $3::date - due_date <= 0) AS current,
               sum(balance) FILTER (WHERE $3::date - due_date BETWEEN 1 AND 30) AS d1_30,
               sum(balance) FILTER (WHERE $3::date - due_date BETWEEN 31 AND 60) AS d31_60,
               sum(balance) FILTER (WHERE $3::date - due_date BETWEEN 61 AND 90) AS d61_90,
               sum(balance) FILTER (WHERE $3::date - due_date > 90) AS d90_plus,
               sum(balance) AS total
          FROM docs WHERE balance <> 0
         GROUP BY party_key
         ORDER BY sum(balance) DESC`, [tenantId, kind, date]);
      const rows = res.rows.map(r0 => Object.fromEntries(Object.entries(r0).map(([k, v]) => [k, v ?? 0])));
      return { as_of: date, items: rows };
    });

    r.get('/v2/acc/:kind/payments', { preHandler: perm('view') }, async (req) => {
      const { tenantId } = ctx(req);
      const kind = kindOf(req);
      const qp = req.query as Record<string, string | undefined>;
      const params: unknown[] = [tenantId, kind === 'cxc' ? 'cobro' : 'pago'];
      let where = 'p.tenant_id = $1 AND p.kind = $2';
      if (qp.party_key) { params.push(qp.party_key); where += ` AND p.party_key = $${params.length}`; }
      if (qp.from) { params.push(qp.from); where += ` AND p.payment_date >= $${params.length}`; }
      if (qp.to) { params.push(qp.to); where += ` AND p.payment_date <= $${params.length}`; }
      const limit = intParam(qp.limit, 500, 5000);
      const res = await q(`
        SELECT p.id, p.number, p.payment_date, p.party_key, p.party_name, p.method, p.amount, p.unapplied, p.reference,
               p.status, p.entry_id, a.code AS fund_code, a.name AS fund_name, p.created_by_name, p.void_reason
          FROM accounting.payments p LEFT JOIN accounting.accounts a ON a.id = p.fund_account_id
         WHERE ${where}
         ORDER BY p.payment_date DESC, p.number DESC LIMIT ${limit}`, params);
      return { items: res.rows };
    });

    r.get('/v2/acc/:kind/payments/:id', { preHandler: perm('view') }, async (req) => {
      const { tenantId } = ctx(req);
      const id = idParam(req);
      const p = await q(`SELECT p.*, a.code AS fund_code, a.name AS fund_name FROM accounting.payments p
                          LEFT JOIN accounting.accounts a ON a.id = p.fund_account_id WHERE p.id = $1 AND p.tenant_id = $2`, [id, tenantId]);
      if (!p.rows.length) throw new ValidationError('Registro no encontrado');
      const allocs = await q(`SELECT a.document_id, a.amount, d.doc_type, d.doc_number, d.doc_date, d.amount AS doc_amount
                                FROM accounting.payment_allocations a JOIN accounting.documents d ON d.id = a.document_id
                               WHERE a.payment_id = $1 ORDER BY a.id`, [id]);
      return { payment: p.rows[0], allocations: allocs.rows };
    });

    r.post('/v2/acc/:kind/payments', { preHandler: perm('manage') }, async (req) => {
      const c = ctx(req);
      const kind = kindOf(req);
      const b = parse(PaymentBody, req.body);
      const res = await tx(db => q<{ id: number }>(
        'SELECT accounting.register_payment($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) AS id',
        [c.tenantId, kind === 'cxc' ? 'cobro' : 'pago', b.payment_date, b.party_key, b.method, b.fund_account_id ?? null,
         b.amount, JSON.stringify(b.allocations), b.reference ?? null, b.notes ?? null], db), c);
      return { id: res.rows[0]!.id };
    });

    r.post('/v2/acc/:kind/payments/:id/void', { preHandler: perm('manage') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({ reason: z.string().trim().min(3, 'Indica el motivo') }), req.body);
      await tx(db => q('SELECT accounting.void_payment($1, $2, $3)', [c.tenantId, idParam(req), b.reason], db), c);
      return { success: true };
    });

    r.get('/v2/acc/:kind/check', { preHandler: perm('view') }, async (req) => {
      const { tenantId } = ctx(req);
      const kind = kindOf(req);
      const date = asOf((req.query as Record<string, string>).as_of);
      const res = await q<{ ledger: number; subledger: number; advances: number }>(
        'SELECT * FROM accounting.subledger_check($1, $2, $3)', [tenantId, kind, date]);
      const row = res.rows[0]!;
      return { as_of: date, ...row, difference: Math.round((row.ledger - row.subledger) * 100) / 100 };
    });
  });
}
