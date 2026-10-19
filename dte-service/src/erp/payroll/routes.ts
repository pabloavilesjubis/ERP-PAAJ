import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../../auth/auth.middleware.js';
import { ValidationError } from '../../errors.js';
import { authedPlugin, ctx, idParam, parse, q, tx } from '../http.js';

/**
 * Planillas (F5): parámetros de ley, centros de costo, empleados, planillas
 * ordinarias y de aguinaldo, boletas, liquidaciones, pagos y reportes
 * (resumen ISSS/AFP y F-910). Cálculo en las funciones payroll.* (010).
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)');
const optText = z.string().trim().max(200).nullable().optional().transform(v => (v ? v : null));

const EmployeeBody = z.object({
  employee_code: optText,
  first_name: z.string().trim().min(1, 'Indica los nombres'),
  last_name: z.string().trim().min(1, 'Indica los apellidos'),
  dui: z.string().trim().regex(/^\d{8}-\d$/, 'DUI con formato 00000000-0').nullable().optional().or(z.literal('').transform(() => null)),
  nit: optText, isss_number: optText, nup: optText,
  afp_name: z.enum(['confia', 'crecer']).nullable().optional(),
  birth_date: isoDate.nullable().optional(),
  phone: optText, email: optText, address: optText,
  position: z.string().trim().min(1, 'Indica el cargo'),
  cost_center_id: z.number().int().positive(),
  hire_date: isoDate,
  monthly_salary: z.number().positive('Indica el salario mensual'),
  pay_frequency: z.enum(['mensual', 'quincenal']),
  payment_method: z.enum(['transferencia', 'efectivo', 'cheque']),
  bank_name: optText, bank_account: optText,
  applies_isss: z.boolean(), applies_afp: z.boolean(), applies_isr: z.boolean(),
  notes: optText,
});

const SettingsBody = z.object({
  isss_employee_rate: z.number().min(0).max(1), isss_employer_rate: z.number().min(0).max(1), isss_cap: z.number().positive(),
  afp_employee_rate: z.number().min(0).max(1), afp_employer_rate: z.number().min(0).max(1), afp_cap: z.number().positive().nullable(),
  insaforp_applies: z.boolean(), insaforp_rate: z.number().min(0).max(1), minimum_wage: z.number().positive(),
  aguinaldo_exempt: z.number().min(0), workday_hours: z.number().positive(), overtime_surcharge: z.number().min(0),
  night_surcharge: z.number().min(0), holiday_surcharge: z.number().min(0), vacation_premium: z.number().min(0),
});

const TerminationBody = z.object({
  employee_id: z.number().int().positive(),
  kind: z.enum(['despido_injustificado', 'despido_justificado', 'renuncia']),
  termination_date: isoDate,
  options: z.object({
    paid_through: isoDate.nullable().optional(),
    include_vacation: z.boolean().optional(),
    pending_vacation_periods: z.number().int().min(0).max(20).optional(),
    include_aguinaldo: z.boolean().optional(),
    other_income: z.number().min(0).optional(),
    other_deductions: z.number().min(0).optional(),
  }).default({}),
  reason: z.string().max(500).nullable().optional(),
});

const EMPLOYEE_COLS = ['employee_code', 'first_name', 'last_name', 'dui', 'nit', 'isss_number', 'nup', 'afp_name', 'birth_date', 'phone',
  'email', 'address', 'position', 'cost_center_id', 'hire_date', 'monthly_salary', 'pay_frequency', 'payment_method', 'bank_name',
  'bank_account', 'applies_isss', 'applies_afp', 'applies_isr', 'notes'] as const;

export async function registerPayrollRoutes(app: FastifyInstance): Promise<void> {
  await authedPlugin(app, (r) => {
    // ── Configuración ────────────────────────────────────────────────────────
    r.get('/v2/payroll/settings', { preHandler: requirePerm('payroll:view') }, async (req) => {
      const c = ctx(req);
      return tx(async (db) => {
        await q('SELECT payroll.ensure_settings($1)', [c.tenantId], db);
        const s = await q('SELECT * FROM payroll.settings WHERE tenant_id = $1', [c.tenantId], db);
        const b = await q('SELECT frequency, tramo, lower_limit, rate, excess_over, fixed_fee FROM payroll.isr_brackets WHERE tenant_id = $1 ORDER BY frequency, tramo', [c.tenantId], db);
        return { settings: s.rows[0], isr_brackets: b.rows };
      }, c);
    });

    r.put('/v2/payroll/settings', { preHandler: requirePerm('payroll:manage') }, async (req) => {
      const c = ctx(req);
      const b = parse(SettingsBody, req.body);
      const keys = Object.keys(b) as Array<keyof typeof b>;
      await tx(async (db) => {
        await q('SELECT payroll.ensure_settings($1)', [c.tenantId], db);
        await q(`UPDATE payroll.settings SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = NOW(), updated_by = $${keys.length + 2}
                 WHERE tenant_id = $1`, [c.tenantId, ...keys.map(k => b[k]), c.userName], db);
      }, c);
      return { success: true };
    });

    r.put('/v2/payroll/isr/:frequency', { preHandler: requirePerm('payroll:manage') }, async (req) => {
      const c = ctx(req);
      const frequency = (req.params as { frequency: string }).frequency;
      const b = parse(z.object({ rows: z.array(z.object({
        lower_limit: z.number().min(0), rate: z.number().min(0).max(1), excess_over: z.number().min(0), fixed_fee: z.number().min(0),
      })).min(1).max(20) }), req.body);
      await tx(db => q('SELECT payroll.save_isr_brackets($1, $2, $3::jsonb)', [c.tenantId, frequency, JSON.stringify(b.rows)], db), c);
      return { success: true };
    });

    // ── Centros de costo ─────────────────────────────────────────────────────
    r.get('/v2/payroll/cost-centers', { preHandler: requirePerm('payroll:view') }, async (req) => {
      const c = ctx(req);
      await tx(db => q('SELECT payroll.ensure_settings($1)', [c.tenantId], db), c);
      const res = await q(`
        SELECT cc.*, s.code AS salary_code, s.name AS salary_name, i.code AS isss_code, i.name AS isss_name, a.code AS afp_code, a.name AS afp_name,
               (SELECT count(*)::int FROM payroll.employees e WHERE e.cost_center_id = cc.id AND e.status = 'activo') AS employees
          FROM payroll.cost_centers cc
          LEFT JOIN accounting.accounts s ON s.id = cc.salary_account_id
          LEFT JOIN accounting.accounts i ON i.id = cc.isss_account_id
          LEFT JOIN accounting.accounts a ON a.id = cc.afp_account_id
         WHERE cc.tenant_id = $1 ORDER BY cc.name`, [c.tenantId]);
      return { items: res.rows };
    });

    const CcBody = z.object({
      name: z.string().trim().min(1, 'Indica el nombre').max(80),
      salary_account_id: z.number().int().positive().nullable(),
      isss_account_id: z.number().int().positive().nullable(),
      afp_account_id: z.number().int().positive().nullable(),
      is_active: z.boolean().default(true),
    });
    const checkAccounts = async (tenantId: number, ids: Array<number | null>) => {
      for (const id of ids) {
        if (!id) continue;
        const a = await q<{ allows_movements: boolean }>('SELECT allows_movements FROM accounting.accounts WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
        if (!a.rows[0]?.allows_movements) throw new ValidationError('Usa cuentas de movimiento de tu catálogo');
      }
    };

    r.post('/v2/payroll/cost-centers', { preHandler: requirePerm('payroll:manage') }, async (req) => {
      const { tenantId } = ctx(req);
      const b = parse(CcBody, req.body);
      await checkAccounts(tenantId, [b.salary_account_id, b.isss_account_id, b.afp_account_id]);
      const res = await q<{ id: number }>(`INSERT INTO payroll.cost_centers (tenant_id, name, salary_account_id, isss_account_id, afp_account_id, is_active)
                                           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [tenantId, b.name, b.salary_account_id, b.isss_account_id, b.afp_account_id, b.is_active]);
      return { id: res.rows[0]!.id };
    });

    r.put('/v2/payroll/cost-centers/:id', { preHandler: requirePerm('payroll:manage') }, async (req) => {
      const { tenantId } = ctx(req);
      const b = parse(CcBody, req.body);
      await checkAccounts(tenantId, [b.salary_account_id, b.isss_account_id, b.afp_account_id]);
      const res = await q(`UPDATE payroll.cost_centers SET name = $3, salary_account_id = $4, isss_account_id = $5, afp_account_id = $6, is_active = $7
                            WHERE id = $1 AND tenant_id = $2 RETURNING id`,
        [idParam(req), tenantId, b.name, b.salary_account_id, b.isss_account_id, b.afp_account_id, b.is_active]);
      if (!res.rows.length) throw new ValidationError('Centro de costo no encontrado');
      return { success: true };
    });

    // ── Empleados ────────────────────────────────────────────────────────────
    r.get('/v2/payroll/employees', { preHandler: requirePerm('payroll:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const status = (req.query as Record<string, string>).status;
      const res = await q(`
        SELECT e.*, cc.name AS cost_center_name, payroll.employee_paid_through(e.id) AS paid_through
          FROM payroll.employees e JOIN payroll.cost_centers cc ON cc.id = e.cost_center_id
         WHERE e.tenant_id = $1 ${status ? 'AND e.status = $2' : ''}
         ORDER BY e.status, e.last_name, e.first_name`, status ? [tenantId, status] : [tenantId]);
      return { items: res.rows };
    });

    const saveEmployee = async (tenantId: number, b: z.infer<typeof EmployeeBody>, id?: number) => {
      const cc = await q('SELECT 1 FROM payroll.cost_centers WHERE id = $1 AND tenant_id = $2', [b.cost_center_id, tenantId]);
      if (!cc.rows.length) throw new ValidationError('Centro de costo no encontrado');
      const values = EMPLOYEE_COLS.map(k => b[k] ?? null);
      if (id) {
        const res = await q(`UPDATE payroll.employees SET ${EMPLOYEE_COLS.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = NOW()
                             WHERE id = $1 AND tenant_id = $2 RETURNING id`, [id, tenantId, ...values]);
        if (!res.rows.length) throw new ValidationError('Empleado no encontrado');
        return id;
      }
      const res = await q<{ id: number }>(`INSERT INTO payroll.employees (tenant_id, ${EMPLOYEE_COLS.join(', ')})
                                           VALUES ($1, ${EMPLOYEE_COLS.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`, [tenantId, ...values]);
      return res.rows[0]!.id;
    };

    r.post('/v2/payroll/employees', { preHandler: requirePerm('payroll:manage') }, async (req) => {
      const { tenantId } = ctx(req);
      return { id: await saveEmployee(tenantId, parse(EmployeeBody, req.body)) };
    });

    r.put('/v2/payroll/employees/:id', { preHandler: requirePerm('payroll:manage') }, async (req) => {
      const { tenantId } = ctx(req);
      return { id: await saveEmployee(tenantId, parse(EmployeeBody, req.body), idParam(req)) };
    });

    // ── Planillas ────────────────────────────────────────────────────────────
    r.get('/v2/payroll/payrolls', { preHandler: requirePerm('payroll:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const res = await q(`
        SELECT p.*, e.entry_number, pe.entry_number AS paid_entry_number
          FROM payroll.payrolls p
          LEFT JOIN accounting.journal_entries e ON e.id = p.journal_entry_id
          LEFT JOIN accounting.journal_entries pe ON pe.id = p.paid_entry_id
         WHERE p.tenant_id = $1 ORDER BY p.period_end DESC, p.id DESC LIMIT 200`, [tenantId]);
      return { items: res.rows };
    });

    r.post('/v2/payroll/payrolls', { preHandler: requirePerm('payroll:manage') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({
        kind: z.enum(['ordinaria', 'aguinaldo']), frequency: z.enum(['mensual', 'quincenal']),
        period_start: isoDate, period_end: isoDate, payment_date: isoDate, notes: z.string().max(500).nullable().optional(),
      }), req.body);
      const res = await tx(db => q<{ id: number }>('SELECT payroll.create_payroll($1, $2, $3, $4, $5, $6, $7) AS id',
        [c.tenantId, b.kind, b.frequency, b.period_start, b.period_end, b.payment_date, b.notes ?? null], db), c);
      return { id: res.rows[0]!.id };
    });

    r.get('/v2/payroll/payrolls/:id', { preHandler: requirePerm('payroll:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const id = idParam(req);
      const p = await q(`SELECT p.*, e.entry_number, pe.entry_number AS paid_entry_number FROM payroll.payrolls p
                           LEFT JOIN accounting.journal_entries e ON e.id = p.journal_entry_id
                           LEFT JOIN accounting.journal_entries pe ON pe.id = p.paid_entry_id
                          WHERE p.id = $1 AND p.tenant_id = $2`, [id, tenantId]);
      if (!p.rows.length) throw new ValidationError('Planilla no encontrada');
      const lines = await q(`SELECT l.*, cc.name AS cost_center_name FROM payroll.payroll_lines l
                               JOIN payroll.cost_centers cc ON cc.id = l.cost_center_id
                              WHERE l.payroll_id = $1 ORDER BY l.employee_name`, [id]);
      return { payroll: p.rows[0], lines: lines.rows };
    });

    r.post('/v2/payroll/payrolls/:id/refresh', { preHandler: requirePerm('payroll:manage') }, async (req) => {
      const c = ctx(req);
      const id = idParam(req);
      await tx(async (db) => {
        await q('SELECT payroll.assert_draft($1, $2)', [c.tenantId, id], db);
        await q('SELECT payroll.sync_lines($1)', [id], db);
      }, c);
      return { success: true };
    });

    r.put('/v2/payroll/lines/:id', { preHandler: requirePerm('payroll:manage') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({
        absence_days: z.number().min(0).optional(), overtime_day_hours: z.number().min(0).optional(),
        overtime_night_hours: z.number().min(0).optional(), holiday_days: z.number().min(0).optional(),
        vacation: z.boolean().optional(), bonuses: z.number().min(0).optional(), bonuses_note: z.string().max(200).nullable().optional(),
        other_deductions: z.number().min(0).optional(), deductions_note: z.string().max(200).nullable().optional(),
      }), req.body);
      await tx(db => q('SELECT payroll.update_line($1, $2, $3::jsonb)', [c.tenantId, idParam(req), JSON.stringify(b)], db), c);
      return { success: true };
    });

    r.delete('/v2/payroll/lines/:id', { preHandler: requirePerm('payroll:manage') }, async (req) => {
      const c = ctx(req);
      const id = idParam(req);
      await tx(async (db) => {
        const l = await q<{ payroll_id: number }>('SELECT payroll_id FROM payroll.payroll_lines WHERE id = $1 AND tenant_id = $2', [id, c.tenantId], db);
        if (!l.rows.length) throw new ValidationError('Línea no encontrada');
        await q('SELECT payroll.assert_draft($1, $2)', [c.tenantId, l.rows[0]!.payroll_id], db);
        await q('DELETE FROM payroll.payroll_lines WHERE id = $1', [id], db);
        await q('SELECT payroll.refresh_totals($1)', [l.rows[0]!.payroll_id], db);
      }, c);
      return { success: true };
    });

    r.delete('/v2/payroll/payrolls/:id', { preHandler: requirePerm('payroll:manage') }, async (req) => {
      const c = ctx(req);
      const id = idParam(req);
      await tx(async (db) => {
        await q('SELECT payroll.assert_draft($1, $2)', [c.tenantId, id], db);
        await q('DELETE FROM payroll.payrolls WHERE id = $1', [id], db);
      }, c);
      return { success: true };
    });

    r.post('/v2/payroll/payrolls/:id/emit', { preHandler: requirePerm('payroll:manage') }, async (req) => {
      const c = ctx(req);
      const res = await tx(db => q<{ n: number }>('SELECT payroll.emit_payroll($1, $2) AS n', [c.tenantId, idParam(req)], db), c);
      return { payroll_number: res.rows[0]!.n };
    });

    r.post('/v2/payroll/payrolls/:id/pay', { preHandler: requirePerm('payroll:manage') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({ payment_date: isoDate, fund_account_id: z.number().int().positive() }), req.body);
      const res = await tx(db => q<{ id: number }>('SELECT payroll.pay_payroll($1, $2, $3, $4) AS id',
        [c.tenantId, idParam(req), b.payment_date, b.fund_account_id], db), c);
      return { entry_id: res.rows[0]!.id };
    });

    r.post('/v2/payroll/payrolls/:id/void', { preHandler: requirePerm('payroll:manage') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({ reason: z.string().trim().min(3, 'Indica el motivo') }), req.body);
      await tx(db => q('SELECT payroll.void_payroll($1, $2, $3)', [c.tenantId, idParam(req), b.reason], db), c);
      return { success: true };
    });

    // ── Liquidaciones ────────────────────────────────────────────────────────
    r.post('/v2/payroll/terminations/preview', { preHandler: requirePerm('payroll:terminate') }, async (req) => {
      const c = ctx(req);
      const b = parse(TerminationBody, req.body);
      const res = await tx(db => q<{ d: unknown }>('SELECT payroll.compute_termination($1, $2, $3, $4, $5::jsonb) AS d',
        [c.tenantId, b.employee_id, b.kind, b.termination_date, JSON.stringify(b.options)], db), c);
      return res.rows[0]!.d;
    });

    r.post('/v2/payroll/terminations', { preHandler: requirePerm('payroll:terminate') }, async (req) => {
      const c = ctx(req);
      const b = parse(TerminationBody, req.body);
      const res = await tx(db => q<{ id: number }>('SELECT payroll.register_termination($1, $2, $3, $4, $5::jsonb, $6) AS id',
        [c.tenantId, b.employee_id, b.kind, b.termination_date, JSON.stringify(b.options), b.reason ?? null], db), c);
      return { id: res.rows[0]!.id };
    });

    r.get('/v2/payroll/terminations', { preHandler: requirePerm('payroll:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const res = await q(`SELECT t.*, e.entry_number, pe.entry_number AS paid_entry_number FROM payroll.terminations t
                             LEFT JOIN accounting.journal_entries e ON e.id = t.journal_entry_id
                             LEFT JOIN accounting.journal_entries pe ON pe.id = t.paid_entry_id
                            WHERE t.tenant_id = $1 ORDER BY t.termination_date DESC, t.id DESC`, [tenantId]);
      return { items: res.rows };
    });

    r.post('/v2/payroll/terminations/:id/pay', { preHandler: requirePerm('payroll:terminate') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({ payment_date: isoDate, fund_account_id: z.number().int().positive() }), req.body);
      const res = await tx(db => q<{ id: number }>('SELECT payroll.pay_termination($1, $2, $3, $4) AS id',
        [c.tenantId, idParam(req), b.payment_date, b.fund_account_id], db), c);
      return { entry_id: res.rows[0]!.id };
    });

    r.post('/v2/payroll/terminations/:id/void', { preHandler: requirePerm('payroll:terminate') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({ reason: z.string().trim().min(3, 'Indica el motivo') }), req.body);
      await tx(db => q('SELECT payroll.void_termination($1, $2, $3)', [c.tenantId, idParam(req), b.reason], db), c);
      return { success: true };
    });

    // ── Reportes ─────────────────────────────────────────────────────────────
    r.get('/v2/payroll/reports/f910', { preHandler: requirePerm('payroll:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const year = parseInt((req.query as Record<string, string>).year ?? '', 10) || new Date().getFullYear() - 1;
      // F-910: por empleado, total devengado, ISSS, AFP y renta retenida en el año (planillas emitidas + liquidaciones)
      const res = await q(`
        WITH lines AS (
          SELECT l.employee_id, l.gross - l.aguinaldo AS taxable, l.aguinaldo, l.isss_employee, l.afp_employee, l.isr
            FROM payroll.payroll_lines l JOIN payroll.payrolls p ON p.id = l.payroll_id
           WHERE p.tenant_id = $1 AND p.status = 'emitida' AND extract(year FROM p.payment_date) = $2
          UNION ALL
          SELECT t.employee_id, t.pending_salary + t.vacation + t.other_income, t.aguinaldo + t.indemnity, t.isss_employee, t.afp_employee, t.isr
            FROM payroll.terminations t WHERE t.tenant_id = $1 AND t.status = 'registrada' AND extract(year FROM t.termination_date) = $2
        )
        SELECT e.id AS employee_id, e.full_name, e.dui, e.nit, sum(lines.taxable) AS taxable_income, sum(lines.aguinaldo) AS aguinaldo_and_other,
               sum(lines.isss_employee) AS isss, sum(lines.afp_employee) AS afp, sum(lines.isr) AS isr
          FROM lines JOIN payroll.employees e ON e.id = lines.employee_id
         GROUP BY e.id, e.full_name, e.dui, e.nit ORDER BY e.full_name`, [tenantId, year]);
      return { year, items: res.rows };
    });
  });
}
