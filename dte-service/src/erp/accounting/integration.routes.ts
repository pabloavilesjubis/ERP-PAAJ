import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../../auth/auth.middleware.js';
import { ValidationError } from '../../errors.js';
import { authedPlugin, ctx, idParam, intParam, parse, q, tx } from '../http.js';

/**
 * Contabilización automática de ventas y compras (F2).
 *
 *   GET  /v2/acc/integration/settings          configuración de la empresa
 *   PUT  /v2/acc/integration/settings
 *   GET  /v2/acc/integration/summary           conteo por estado (ventas/compras)
 *   GET  /v2/acc/integration/documents         documentos con su estado contable
 *   POST /v2/acc/integration/post-pending      contabiliza pendientes y errores
 *   POST /v2/acc/integration/retry             reintenta un documento
 *   GET  /v2/acc/compras/:id/distribution      distribución contable de una compra
 *   PUT  /v2/acc/compras/:id/distribution
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)');

const SettingsBody = z.object({
  auto_post: z.boolean(),
  posting_start_date: isoDate.nullable(),
  sales_cash_role: z.enum(['cash', 'bank', 'receivables']),
  purchases_cash_mode: z.enum(['payables', 'cash']),
  default_credit_days: z.number().int().min(0).max(365),
});

const Module = z.enum(['ventas', 'compras']);

/** Documentos de un módulo con su estado contable (pendiente = sin registro). */
function documentsSql(module: 'ventas' | 'compras'): string {
  if (module === 'ventas') {
    return `
      SELECT 'ventas' AS module, v.id, v.fecha AS doc_date, v.kind AS subtype,
             coalesce(NULLIF(v.metadata->>'numeroControl', ''), NULLIF(v.metadata->>'numeroDocumento', ''), 'Venta ' || v.id) AS doc_ref,
             coalesce(NULLIF(v.cliente_nombre, ''), CASE WHEN v.kind = 'consumidor' THEN 'Consumidor final' ELSE '—' END) AS party_name,
             CASE WHEN v.kind = 'consumidor' AND v.gravado IS NULL THEN coalesce(v.monto, 0)
                  ELSE coalesce(v.gravado, 0) + coalesce(v.exento, 0) + coalesce(v.iva, 0) END AS total,
             coalesce(p.status, 'pendiente') AS status, p.message, p.entry_id, e.entry_number
        FROM public.ventas v
        LEFT JOIN accounting.document_postings p ON p.tenant_id = v.tenant_id AND p.module = 'ventas' AND p.source_id = v.id
        LEFT JOIN accounting.journal_entries e ON e.id = p.entry_id
       WHERE v.tenant_id = $1`;
  }
  return `
      SELECT 'compras' AS module, c.id, c.fecha AS doc_date, coalesce(c.metadata->>'tipoDocumento', '03') AS subtype,
             coalesce(NULLIF(c.metadata->>'numeroControl', ''), NULLIF(c.metadata->>'numeroDocumento', ''), 'Compra ' || c.id) AS doc_ref,
             c.proveedor_nombre AS party_name,
             coalesce(c.gravado, 0) + coalesce(c.exento, 0) + coalesce(c.iva, 0) AS total,
             coalesce(p.status, 'pendiente') AS status, p.message, p.entry_id, e.entry_number
        FROM public.compras c
        LEFT JOIN accounting.document_postings p ON p.tenant_id = c.tenant_id AND p.module = 'compras' AND p.source_id = c.id
        LEFT JOIN accounting.journal_entries e ON e.id = p.entry_id
       WHERE c.tenant_id = $1`;
}

export async function registerIntegrationRoutes(app: FastifyInstance): Promise<void> {
  await authedPlugin(app, (r) => {
    r.get('/v2/acc/integration/settings', { preHandler: requirePerm('accounting:view') }, async (req) => {
      const c = ctx(req);
      const res = await tx(db => q('SELECT * FROM accounting.get_settings($1)', [c.tenantId], db), c);
      return res.rows[0];
    });

    r.put('/v2/acc/integration/settings', { preHandler: requirePerm('accounting:config') }, async (req) => {
      const c = ctx(req);
      const b = parse(SettingsBody, req.body);
      if (b.auto_post && !b.posting_start_date) {
        throw new ValidationError('Indica desde qué fecha se contabilizan las ventas y compras');
      }
      await q(`
        INSERT INTO accounting.settings (tenant_id, auto_post, posting_start_date, sales_cash_role, purchases_cash_mode,
                                         default_credit_days, updated_at, updated_by)
        VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
        ON CONFLICT (tenant_id) DO UPDATE SET auto_post = $2, posting_start_date = $3, sales_cash_role = $4,
          purchases_cash_mode = $5, default_credit_days = $6, updated_at = NOW(), updated_by = $7`,
        [c.tenantId, b.auto_post, b.posting_start_date, b.sales_cash_role, b.purchases_cash_mode, b.default_credit_days, c.userName]);
      return { success: true };
    });

    r.get('/v2/acc/integration/summary', { preHandler: requirePerm('accounting:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const res = await q<{ module: string; status: string; n: number; total: number }>(`
        WITH s AS (SELECT posting_start_date AS d FROM accounting.settings WHERE tenant_id = $1),
        docs AS (${documentsSql('ventas')} UNION ALL ${documentsSql('compras')})
        SELECT module, status, count(*)::int AS n, coalesce(sum(total), 0) AS total
          FROM docs
         WHERE status <> 'pendiente' OR doc_date >= coalesce((SELECT d FROM s), '1900-01-01')
         GROUP BY module, status`, [tenantId]);
      return { items: res.rows };
    });

    r.get('/v2/acc/integration/documents', { preHandler: requirePerm('accounting:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const qp = req.query as Record<string, string | undefined>;
      const module = Module.parse(qp.module ?? 'ventas');
      const params: unknown[] = [tenantId];
      let where = 'TRUE';
      if (qp.status) { params.push(qp.status); where += ` AND status = $${params.length}`; }
      if (qp.from) { params.push(qp.from); where += ` AND doc_date >= $${params.length}`; }
      if (qp.to) { params.push(qp.to); where += ` AND doc_date <= $${params.length}`; }
      if (qp.q) { params.push(`%${qp.q}%`); where += ` AND (doc_ref ILIKE $${params.length} OR party_name ILIKE $${params.length})`; }
      const limit = intParam(qp.limit, 200, 2000);
      const offset = intParam(qp.offset, 0, 1_000_000);
      const res = await q(`
        SELECT *, count(*) OVER () AS total_count FROM (${documentsSql(module)}) d
         WHERE ${where}
         ORDER BY doc_date DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, params);
      const total = res.rows[0] ? Number((res.rows[0] as { total_count: number }).total_count) : 0;
      return { items: res.rows.map(({ total_count: _t, ...row }) => row), total };
    });

    r.post('/v2/acc/integration/post-pending', { preHandler: requirePerm('accounting:post') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({ module: Module.optional(), limit: z.number().int().min(1).max(5000).default(2000) }), req.body);
      const settings = (await tx(db => q<{ posting_start_date: string | null }>('SELECT * FROM accounting.get_settings($1)', [c.tenantId], db), c)).rows[0]!;
      if (!settings.posting_start_date) throw new ValidationError('Primero indica la fecha de inicio de la contabilización automática');
      const modules = b.module ? [b.module] : (['ventas', 'compras'] as const);
      const result: Record<string, Record<string, number>> = {};
      for (const m of modules) {
        const pending: { rows: Array<{ id: number }> } = await q<{ id: number }>(`
          SELECT id FROM (${documentsSql(m)}) d
           WHERE status IN ('pendiente', 'error') AND doc_date >= $2
           ORDER BY doc_date, id LIMIT ${b.limit}`, [c.tenantId, settings.posting_start_date]);
        const counts: Record<string, number> = {};
        for (const row of pending.rows) {
          // Un documento por transacción: un error no deshace a los demás
          const out: { rows: Array<{ r: string }> } = await tx(
            db => q<{ r: string }>('SELECT accounting.try_sync_document($1, $2, $3) AS r', [c.tenantId, m, row.id], db), c);
          const key = out.rows[0]!.r;
          counts[key] = (counts[key] ?? 0) + 1;
        }
        result[m] = counts;
      }
      return { result };
    });

    r.post('/v2/acc/integration/retry', { preHandler: requirePerm('accounting:post') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({ module: Module, id: z.number().int().positive() }), req.body);
      // Sin try: si falla, el usuario ve el motivo directamente
      const out = await tx(db => q<{ r: string }>('SELECT accounting.sync_document($1, $2, $3) AS r', [c.tenantId, b.module, b.id], db), c);
      return { result: out.rows[0]!.r };
    });

    // ── Distribución contable de una compra ──────────────────────────────────
    r.get('/v2/acc/compras/:id/distribution', { preHandler: requirePerm('accounting:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const id = idParam(req);
      const compra = await q(`SELECT id, fecha, proveedor_nombre, proveedor_nit, proveedor_nrc, gravado, exento, iva, descripcion,
                                     metadata->>'otrosTributos' AS otros
                                FROM public.compras WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
      if (!compra.rows.length) throw new ValidationError('Compra no encontrada');
      const lines = await q(`SELECT d.account_id, a.code, a.name, d.amount, d.cost_center, d.description
                               FROM accounting.purchase_distribution d JOIN accounting.accounts a ON a.id = d.account_id
                              WHERE d.tenant_id = $1 AND d.compra_id = $2 ORDER BY d.id`, [tenantId, id]);
      const posting = await q(`SELECT p.status, p.message, p.entry_id, e.entry_number FROM accounting.document_postings p
                                 LEFT JOIN accounting.journal_entries e ON e.id = p.entry_id
                                WHERE p.tenant_id = $1 AND p.module = 'compras' AND p.source_id = $2`, [tenantId, id]);
      const c0 = compra.rows[0] as { proveedor_nit: string | null; proveedor_nrc: string | null; proveedor_nombre: string };
      const party = await q<{ id: number }>('SELECT accounting.match_party($1, $2, $3, NULL, $4) AS id',
        [tenantId, c0.proveedor_nit, c0.proveedor_nrc, c0.proveedor_nombre]);
      return { compra: compra.rows[0], lines: lines.rows, posting: posting.rows[0] ?? null, party_id: party.rows[0]?.id ?? null };
    });

    r.put('/v2/acc/compras/:id/distribution', { preHandler: requirePerm('accounting:post') }, async (req) => {
      const c = ctx(req);
      const id = idParam(req);
      const b = parse(z.object({
        lines: z.array(z.object({
          account_id: z.number().int().positive(),
          amount: z.number().positive(),
          cost_center: z.string().max(60).nullable().optional(),
          description: z.string().max(200).nullable().optional(),
        })).max(50),
        remember_for_supplier: z.boolean().default(false),
      }), req.body);
      return tx(async (db) => {
        const compra = await q<{ base: number; party_id: number | null }>(`
          SELECT coalesce(gravado, 0) + coalesce(exento, 0) + accounting.num(metadata->>'otrosTributos') AS base,
                 accounting.match_party(tenant_id, proveedor_nit, proveedor_nrc, proveedor_dui, proveedor_nombre) AS party_id
            FROM public.compras WHERE id = $1 AND tenant_id = $2`, [id, c.tenantId], db);
        if (!compra.rows.length) throw new ValidationError('Compra no encontrada');
        const { base, party_id } = compra.rows[0]!;
        const sum = Math.round(b.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
        if (b.lines.length && Math.abs(sum - base) > 0.004) {
          throw new ValidationError(`La distribución suma ${sum.toFixed(2)} y la base de la compra es ${base.toFixed(2)}`);
        }
        for (const l of b.lines) {
          const acc = await q<{ allows_movements: boolean }>('SELECT allows_movements FROM accounting.accounts WHERE id = $1 AND tenant_id = $2',
            [l.account_id, c.tenantId], db);
          if (!acc.rows[0]?.allows_movements) throw new ValidationError('Solo se usan cuentas de movimiento de tu catálogo');
        }
        await q('DELETE FROM accounting.purchase_distribution WHERE tenant_id = $1 AND compra_id = $2', [c.tenantId, id], db);
        for (const l of b.lines) {
          await q(`INSERT INTO accounting.purchase_distribution (tenant_id, compra_id, account_id, amount, cost_center, description)
                   VALUES ($1, $2, $3, $4, $5, $6)`, [c.tenantId, id, l.account_id, l.amount, l.cost_center ?? null, l.description ?? null], db);
        }
        if (b.remember_for_supplier && party_id && b.lines.length) {
          const main = [...b.lines].sort((x, y) => y.amount - x.amount)[0]!;
          await q(`INSERT INTO accounting.party_accounts (tenant_id, party_id, expense_account_id) VALUES ($1, $2, $3)
                   ON CONFLICT (tenant_id, party_id) DO UPDATE SET expense_account_id = $3, updated_at = NOW()`,
            [c.tenantId, party_id, main.account_id], db);
        }
        const out = await q<{ r: string }>('SELECT accounting.sync_document($1, $2, $3) AS r', [c.tenantId, 'compras', id], db);
        return { result: out.rows[0]!.r };
      }, c);
    });

    // ── Cuentas sugeridas por tercero ────────────────────────────────────────
    r.get('/v2/acc/party-accounts', { preHandler: requirePerm('accounting:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const res = await q(`
        SELECT c.id AS party_id, c.nombre, c.nit, c.nrc, c.tipo, pa.expense_account_id, pa.income_account_id, pa.credit_days
          FROM public.contribuyentes c
          LEFT JOIN accounting.party_accounts pa ON pa.tenant_id = c.tenant_id AND pa.party_id = c.id
         WHERE c.tenant_id = $1 ORDER BY c.nombre`, [tenantId]);
      return { items: res.rows };
    });

    r.put('/v2/acc/party-accounts/:id', { preHandler: requirePerm('accounting:config') }, async (req) => {
      const c = ctx(req);
      const id = idParam(req);
      const b = parse(z.object({
        expense_account_id: z.number().int().positive().nullable(),
        income_account_id: z.number().int().positive().nullable(),
        credit_days: z.number().int().min(0).max(365).nullable(),
      }), req.body);
      const owned = await q('SELECT 1 FROM public.contribuyentes WHERE id = $1 AND tenant_id = $2', [id, c.tenantId]);
      if (!owned.rows.length) throw new ValidationError('Contribuyente no encontrado');
      await q(`INSERT INTO accounting.party_accounts (tenant_id, party_id, expense_account_id, income_account_id, credit_days)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (tenant_id, party_id) DO UPDATE SET expense_account_id = $3, income_account_id = $4, credit_days = $5, updated_at = NOW()`,
        [c.tenantId, id, b.expense_account_id, b.income_account_id, b.credit_days]);
      return { success: true };
    });
  });
}
