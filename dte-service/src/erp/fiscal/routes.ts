import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../../auth/auth.middleware.js';
import { authedPlugin, ctx, idParam, parse, q, tx } from '../http.js';

/**
 * Posición fiscal (F6): IVA F-07 con remanente encadenado y F-14 (pago a
 * cuenta + renta retenida), liquidación del IVA y pagos con su asiento.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)');

export async function registerFiscalRoutes(app: FastifyInstance): Promise<void> {
  await authedPlugin(app, (r) => {
    r.get('/v2/fiscal/settings', { preHandler: requirePerm('fiscal:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const res = await q('SELECT opening_period, opening_remanente, pago_a_cuenta_rate, updated_by, updated_at FROM accounting.fiscal_settings WHERE tenant_id = $1', [tenantId]);
      return { settings: res.rows[0] ?? null };
    });

    r.put('/v2/fiscal/settings', { preHandler: requirePerm('fiscal:manage') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({ opening_period: isoDate, opening_remanente: z.number().min(0), pago_a_cuenta_rate: z.number().min(0).max(1) }), req.body);
      await q(`INSERT INTO accounting.fiscal_settings (tenant_id, opening_period, opening_remanente, pago_a_cuenta_rate, updated_by)
               VALUES ($1, date_trunc('month', $2::date), $3, $4, $5)
               ON CONFLICT (tenant_id) DO UPDATE SET opening_period = date_trunc('month', $2::date), opening_remanente = $3,
                 pago_a_cuenta_rate = $4, updated_by = $5, updated_at = NOW()`,
        [c.tenantId, b.opening_period, b.opening_remanente, b.pago_a_cuenta_rate, c.userName]);
      return { success: true };
    });

    r.get('/v2/fiscal/months', { preHandler: requirePerm('fiscal:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const to = (req.query as Record<string, string>).to ?? new Date().toISOString().slice(0, 10);
      const res = await q<{ m: Record<string, unknown> }>('SELECT m FROM accounting.fiscal_months($1, $2) m', [tenantId, to]);
      const payments = await q(`SELECT id, form, period, payment_date, amount, breakdown, reference, status, entry_id, void_reason
                                  FROM accounting.fiscal_payments WHERE tenant_id = $1 ORDER BY period DESC, id DESC`, [tenantId]);
      return { items: res.rows.map(r0 => r0.m).reverse(), payments: payments.rows };
    });

    r.post('/v2/fiscal/liquidate', { preHandler: requirePerm('fiscal:manage') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({ period: isoDate }), req.body);
      const res = await tx(db => q<{ id: number }>('SELECT accounting.liquidate_vat($1, $2) AS id', [c.tenantId, b.period], db), c);
      return { entry_id: res.rows[0]!.id };
    });

    r.post('/v2/fiscal/liquidate/undo', { preHandler: requirePerm('fiscal:manage') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({ period: isoDate, reason: z.string().trim().min(3, 'Indica el motivo') }), req.body);
      await tx(db => q('SELECT accounting.undo_vat_liquidation($1, $2, $3)', [c.tenantId, b.period, b.reason], db), c);
      return { success: true };
    });

    r.post('/v2/fiscal/payments', { preHandler: requirePerm('fiscal:manage') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({
        form: z.enum(['F07', 'F14']), period: isoDate, payment_date: isoDate, main: z.number().min(0), withholdings: z.number().min(0),
        fund_account_id: z.number().int().positive(), reference: z.string().max(120).nullable().optional(),
      }), req.body);
      const res = await tx(db => q<{ id: number }>('SELECT accounting.register_fiscal_payment($1, $2, $3, $4, $5, $6, $7, $8) AS id',
        [c.tenantId, b.form, b.period, b.payment_date, b.main, b.withholdings, b.fund_account_id, b.reference ?? null], db), c);
      return { id: res.rows[0]!.id };
    });

    r.post('/v2/fiscal/payments/:id/void', { preHandler: requirePerm('fiscal:manage') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({ reason: z.string().trim().min(3, 'Indica el motivo') }), req.body);
      await tx(db => q('SELECT accounting.void_fiscal_payment($1, $2, $3)', [c.tenantId, idParam(req), b.reason], db), c);
      return { success: true };
    });
  });
}
