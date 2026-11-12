import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, buildApp, createTenant, db, hasDb, type TestTenant } from './helpers.js';
import { balances, setupAccounting } from './accounting.helpers.js';

describe.skipIf(!hasDb)('obligaciones patronales (ISSS, AFP, renta y honorarios)', () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let ids: Map<string, number>;
  const emp: Record<string, number> = {};
  const get = (month = '2026-03') => app.inject({ method: 'GET', url: `/v2/fiscal/obligations?month=${month}`, headers: auth(t.token) });
  type Payee = { key: string; amount: number | null; paid: number; parts: Record<string, number> };
  const payee = (o: { payees: Payee[] }, key: string) => o.payees.find(p => p.key === key)!;

  beforeAll(async () => {
    app = await buildApp();
    t = await createTenant();
    ids = await setupAccounting(app, t);
    const cc = await app.inject({ method: 'GET', url: '/v2/payroll/cost-centers', headers: auth(t.token) });
    const general = cc.json().items.find((x: { name: string }) => x.name === 'General').id;
    const employee = async (first: string, salary: number, hire: string, afp: string) => {
      const res = await app.inject({ method: 'POST', url: '/v2/payroll/employees', headers: auth(t.token), payload: {
        first_name: first, last_name: 'Prueba', position: 'Puesto', cost_center_id: general, hire_date: hire, monthly_salary: salary,
        pay_frequency: 'mensual', payment_method: 'transferencia', afp_name: afp, applies_isss: true, applies_afp: true, applies_isr: true } });
      expect(res.statusCode, res.body).toBe(200);
      return res.json().id as number;
    };
    emp.ana = await employee('Ana', 1200, '2020-01-15', 'confia');
    emp.beto = await employee('Beto', 600, '2026-03-16', 'crecer');
    // Honorario ya registrado en el libro de compras con su retención de renta
    const { query } = await db();
    await query(`INSERT INTO compras (tenant_id, fecha, proveedor_nombre, descripcion, gravado, total, metadata)
                 VALUES ($1, '2026-03-10', 'Diseñadora Ficticia', 'Honorarios', 250, 250, '{"retencionRenta": "25.00"}')`, [t.tenantId]);
  });
  afterAll(async () => { await app?.close(); });

  it('sin planillas emitidas estima con el salario, la renta variable y los honorarios', async () => {
    const res = await app.inject({ method: 'POST', url: '/v2/fiscal/obligations/preview', headers: auth(t.token), payload: {
      month: '2026-03', inputs: {
        variable: { [String(emp.ana)]: { amount: 100, note: 'horas extra' } },
        fees: [{ name: 'Contador', kind: 'domiciliado', amount: 500 }, { name: 'Consultor externo', kind: 'no_domiciliado', amount: 200 }],
      } } });
    expect(res.statusCode, res.body).toBe(200);
    const o = res.json();
    expect(o.mode).toBe('estimado');
    const ana = o.employees.find((e: { employee_id: number }) => e.employee_id === emp.ana);
    expect(ana.gross).toBe(1300);
    expect(ana.isss_employee).toBe(30);          // tope de $1,000
    expect(ana.afp_employee).toBe(94.25);
    expect(ana.isr).toBe(116.1);                 // 60 + (1,175.75 − 895.24) × 20 %
    const beto = o.employees.find((e: { employee_id: number }) => e.employee_id === emp.beto);
    expect(beto.fixed).toBe(300);                // ingresó el 16: 15 días
    expect(beto.isr).toBe(0);
    expect(payee(o, 'isss').amount).toBe(136.5);
    expect(payee(o, 'afp_confia').amount).toBe(208);
    expect(payee(o, 'afp_crecer').amount).toBe(48);
    expect(o.fees.withheld).toBe(115);           // 25 del libro + 10 % de 500 + 20 % de 200
    const f14 = payee(o, 'f14');
    expect(f14.amount).toBe(231.1);
    expect(f14.parts.isr_fees).toBe(115);
    expect(payee(o, 'f07').amount).toBeNull();   // sin punto de partida de IVA
    expect(o.fiscal_configured).toBe(false);
    expect(o.due).toBe('2026-04-14');            // 10.º día hábil de abril
  });

  it('guarda la estimación del mes', async () => {
    const save = await app.inject({ method: 'PUT', url: '/v2/fiscal/obligations', headers: auth(t.token), payload: {
      month: '2026-03', inputs: { variable: { [String(emp.ana)]: { amount: 100 } }, fees: [{ name: 'Contador', kind: 'domiciliado', amount: 500 }] } } });
    expect(save.statusCode, save.body).toBe(200);
    const o = (await get()).json();
    expect(o.saved).toBe(true);
    expect(o.inputs.fees).toHaveLength(1);
    expect(o.fees.withheld).toBe(75);
  });

  it('con la planilla emitida usa las cifras reales', async () => {
    const pl = await app.inject({ method: 'POST', url: '/v2/payroll/payrolls', headers: auth(t.token), payload: {
      kind: 'ordinaria', frequency: 'mensual', period_start: '2026-03-01', period_end: '2026-03-31', payment_date: '2026-03-31' } });
    expect(pl.statusCode, pl.body).toBe(200);
    const emit = await app.inject({ method: 'POST', url: `/v2/payroll/payrolls/${pl.json().id}/emit`, headers: auth(t.token) });
    expect(emit.statusCode, emit.body).toBe(200);
    const o = (await get()).json();
    expect(o.mode).toBe('real');
    expect(o.emitted_payrolls).toBe(1);
    const ana = o.employees.find((e: { employee_id: number }) => e.employee_id === emp.ana);
    expect(ana.gross).toBe(1200);
    expect(ana.isr).toBe(97.55);
    expect(payee(o, 'isss').amount).toBe(30 + 75 + 9 + 22.5);
    expect(payee(o, 'afp_confia').amount).toBe(87 + 105);
    // el usuario puede volver a estimar aunque haya planilla
    const est = await app.inject({ method: 'POST', url: '/v2/fiscal/obligations/preview', headers: auth(t.token), payload: {
      month: '2026-03', inputs: { mode: 'estimado' } } });
    expect(est.json().mode).toBe('estimado');
  });

  it('el pago al ISSS salda ISSS por pagar contra el banco y se puede anular', async () => {
    const before = await balances(app, t);
    const pay = await app.inject({ method: 'POST', url: '/v2/fiscal/obligations/payments', headers: auth(t.token), payload: {
      payee_key: 'isss', period: '2026-03', payment_date: '2026-04-10', amount: 136.5, fund_account_id: ids.get('1.1.01.03'), reference: 'NPE 123' } });
    expect(pay.statusCode, pay.body).toBe(200);
    const after = await balances(app, t);
    expect(Math.round(((after.get('2.1.07') ?? 0) - (before.get('2.1.07') ?? 0)) * 100) / 100).toBe(136.5);
    expect(after.get('2.1.07') ?? 0).toBe(0);    // emitida −136.50, pagada +136.50
    let o = (await get()).json();
    expect(payee(o, 'isss').paid).toBe(136.5);
    expect(o.payments).toHaveLength(1);
    const voided = await app.inject({ method: 'POST', url: `/v2/fiscal/obligations/payments/${pay.json().id}/void`, headers: auth(t.token), payload: { reason: 'Monto equivocado' } });
    expect(voided.statusCode, voided.body).toBe(200);
    o = (await get()).json();
    expect(payee(o, 'isss').paid).toBe(0);
    expect((await balances(app, t)).get('2.1.07')).toBe(-136.5);
  });

  it('sin permiso de planillas solo se ven los totales; RRHH no ve la posición fiscal', async () => {
    const aux = await t.tokenFor('auxiliar');
    const res = await app.inject({ method: 'GET', url: '/v2/fiscal/obligations?month=2026-03', headers: auth(aux) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().employees).toEqual([]);
    expect(res.json().employee_totals.count).toBe(2);
    expect((await app.inject({ method: 'PUT', url: '/v2/fiscal/obligations', headers: auth(aux), payload: { month: '2026-03', inputs: {} } })).statusCode).toBe(403);
    const rrhh = await t.tokenFor('rrhh');
    expect((await app.inject({ method: 'GET', url: '/v2/fiscal/obligations?month=2026-03', headers: auth(rrhh) })).statusCode).toBe(403);
  });

  it('las tasas de honorarios se configuran en Planillas', async () => {
    const s = (await app.inject({ method: 'GET', url: '/v2/payroll/settings', headers: auth(t.token) })).json().settings;
    expect(Number(s.fee_withholding_rate)).toBe(0.1);
    const { tenant_id: _t, updated_at: _u, updated_by: _b, ...body } = s;
    const num = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === 'boolean' || v === null ? v : Number(v)]));
    const upd = await app.inject({ method: 'PUT', url: '/v2/payroll/settings', headers: auth(t.token), payload: { ...num, fee_nonresident_rate: 0.25 } });
    expect(upd.statusCode, upd.body).toBe(200);
    const o = (await app.inject({ method: 'POST', url: '/v2/fiscal/obligations/preview', headers: auth(t.token), payload: {
      month: '2026-03', inputs: { fees: [{ name: 'X', kind: 'no_domiciliado', amount: 100 }] } } })).json();
    expect(o.fees.manual[0].withheld).toBe(25);
  });

  it('boletas del empleado: sus planillas emitidas', async () => {
    const res = await app.inject({ method: 'GET', url: `/v2/payroll/employees/${emp.ana}/payslips`, headers: auth(t.token) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].payroll.status).toBe('emitida');
  });
});
