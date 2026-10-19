import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../../auth/auth.middleware.js';
import { ValidationError } from '../../errors.js';
import { authedPlugin, ctx, idParam, parse, q, tx } from '../http.js';

/** Activos fijos (F6): categorías Art. 30 LISR, altas, tabla de depreciación, contabilización y bajas. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)');

export async function registerAssetRoutes(app: FastifyInstance): Promise<void> {
  await authedPlugin(app, (r) => {
    r.get('/v2/assets/categories', { preHandler: requirePerm('assets:view') }, async (req) => {
      const c = ctx(req);
      await tx(db => q('SELECT accounting.ensure_asset_categories($1)', [c.tenantId], db), c);
      const res = await q(`
        SELECT c.*, accounting.max_tax_rate(c.tax_class) AS max_rate,
               a.code AS asset_code, a.name AS asset_name, d.code AS dep_code, d.name AS dep_name, e.code AS exp_code, e.name AS exp_name
          FROM accounting.asset_categories c
          LEFT JOIN accounting.accounts a ON a.id = c.asset_account_id
          LEFT JOIN accounting.accounts d ON d.id = c.depreciation_account_id
          LEFT JOIN accounting.accounts e ON e.id = c.expense_account_id
         WHERE c.tenant_id = $1 ORDER BY c.name`, [c.tenantId]);
      return { items: res.rows };
    });

    const CatBody = z.object({
      name: z.string().trim().min(1).max(80),
      tax_class: z.enum(['edificaciones', 'maquinaria', 'vehiculos', 'otros_bienes_muebles']),
      annual_rate: z.number().positive().max(1),
      asset_account_id: z.number().int().positive().nullable(),
      depreciation_account_id: z.number().int().positive().nullable(),
      expense_account_id: z.number().int().positive().nullable(),
    });
    const saveCat = async (tenantId: number, b: z.infer<typeof CatBody>, id?: number) => {
      const max = { edificaciones: 0.05, maquinaria: 0.2, vehiculos: 0.25, otros_bienes_muebles: 0.5 }[b.tax_class];
      if (b.annual_rate > max) throw new ValidationError(`La tasa máxima fiscal (Art. 30 LISR) para esta clase es ${max * 100}%`);
      const vals = [tenantId, b.name, b.tax_class, b.annual_rate, b.asset_account_id, b.depreciation_account_id, b.expense_account_id];
      if (id) {
        const res = await q(`UPDATE accounting.asset_categories SET name = $2, tax_class = $3, annual_rate = $4, asset_account_id = $5,
                               depreciation_account_id = $6, expense_account_id = $7 WHERE tenant_id = $1 AND id = $8 RETURNING id`, [...vals, id]);
        if (!res.rows.length) throw new ValidationError('Categoría no encontrada');
        return id;
      }
      const res = await q<{ id: number }>(`INSERT INTO accounting.asset_categories (tenant_id, name, tax_class, annual_rate, asset_account_id,
                                             depreciation_account_id, expense_account_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, vals);
      return res.rows[0]!.id;
    };
    r.post('/v2/assets/categories', { preHandler: requirePerm('assets:manage') }, async (req) => ({ id: await saveCat(ctx(req).tenantId, parse(CatBody, req.body)) }));
    r.put('/v2/assets/categories/:id', { preHandler: requirePerm('assets:manage') }, async (req) => ({ id: await saveCat(ctx(req).tenantId, parse(CatBody, req.body), idParam(req)) }));

    r.get('/v2/assets', { preHandler: requirePerm('assets:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const asOf = (req.query as Record<string, string>).as_of ?? new Date().toISOString().slice(0, 10);
      const res = await q(`
        SELECT a.*, c.name AS category_name,
               coalesce((SELECT max(s.accumulated) FROM accounting.fixed_asset_schedule s WHERE s.asset_id = a.id AND s.entry_id IS NOT NULL), a.opening_accumulated) AS accumulated_posted,
               coalesce((SELECT max(s.accumulated) FROM accounting.fixed_asset_schedule s WHERE s.asset_id = a.id AND s.period <= $2::date), a.opening_accumulated) AS accumulated_to_date,
               (SELECT amount FROM accounting.fixed_asset_schedule s WHERE s.asset_id = a.id ORDER BY period LIMIT 1) AS monthly_amount,
               (SELECT count(*)::int FROM accounting.fixed_asset_schedule s WHERE s.asset_id = a.id AND s.entry_id IS NULL AND s.period <= $2::date) AS pending_months
          FROM accounting.fixed_assets a JOIN accounting.asset_categories c ON c.id = a.category_id
         WHERE a.tenant_id = $1 ORDER BY a.status, a.code`, [tenantId, asOf]);
      return { as_of: asOf, items: res.rows };
    });

    r.get('/v2/assets/:id/schedule', { preHandler: requirePerm('assets:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const res = await q(`SELECT s.period, s.amount, s.accumulated, s.book_value, s.entry_id, e.entry_number
                             FROM accounting.fixed_asset_schedule s JOIN accounting.fixed_assets a ON a.id = s.asset_id
                             LEFT JOIN accounting.journal_entries e ON e.id = s.entry_id
                            WHERE a.id = $1 AND a.tenant_id = $2 ORDER BY s.period`, [idParam(req), tenantId]);
      return { items: res.rows };
    });

    r.post('/v2/assets', { preHandler: requirePerm('assets:manage') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({
        code: z.string().max(30).nullable().optional(), name: z.string().trim().min(1, 'Indica el nombre').max(200),
        category_id: z.number().int().positive(), acquisition_date: isoDate, in_service_date: isoDate.nullable().optional(),
        cost: z.number().positive(), salvage_value: z.number().min(0).default(0), annual_rate: z.number().positive().max(1).nullable().optional(),
        opening_accumulated: z.number().min(0).default(0), opening_date: isoDate.nullable().optional(),
        serial_number: z.string().max(80).nullable().optional(), location: z.string().max(120).nullable().optional(),
        supplier: z.string().max(200).nullable().optional(), invoice_ref: z.string().max(80).nullable().optional(),
        notes: z.string().max(500).nullable().optional(),
        counter_account_id: z.number().int().positive().nullable().optional(),
      }), req.body);
      if (b.opening_accumulated > 0 && !b.opening_date) throw new ValidationError('Indica desde qué mes se deprecia en el sistema (fecha de los saldos iniciales)');
      const res = await tx(db => q<{ id: number }>('SELECT accounting.create_fixed_asset($1, $2::jsonb, $3) AS id',
        [c.tenantId, JSON.stringify(b), b.counter_account_id ?? null], db), c);
      return { id: res.rows[0]!.id };
    });

    r.post('/v2/assets/depreciate', { preHandler: requirePerm('assets:manage') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({ through: isoDate }), req.body);
      const res = await tx(db => q<{ n: number }>('SELECT accounting.post_depreciation($1, $2) AS n', [c.tenantId, b.through], db), c);
      return { entries: res.rows[0]!.n };
    });

    r.post('/v2/assets/:id/dispose', { preHandler: requirePerm('assets:manage') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({
        kind: z.enum(['venta', 'baja']), date: isoDate, amount: z.number().min(0).default(0),
        proceeds_account_id: z.number().int().positive().nullable().optional(), notes: z.string().max(500).nullable().optional(),
      }), req.body);
      const res = await tx(db => q<{ id: number }>('SELECT accounting.dispose_fixed_asset($1, $2, $3, $4, $5, $6, $7) AS id',
        [c.tenantId, idParam(req), b.kind, b.date, b.amount, b.proceeds_account_id ?? null, b.notes ?? null], db), c);
      return { entry_id: res.rows[0]!.id };
    });
  });
}
