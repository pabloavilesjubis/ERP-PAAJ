import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, buildApp, createTenant, hasDb, type TestTenant } from './helpers.js';
import { balances, setupAccounting } from './accounting.helpers.js';

describe.skipIf(!hasDb)('planillas (ley salvadoreña)', () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let ids: Map<string, number>;
  let ccGeneral: number;
  let ccVentas: number;
  const emp: Record<string, number> = {};

  const employee = async (first: string, salary: number, hire: string, cc: number, extra: Record<string, unknown> = {}) => {
    const res = await app.inject({ method: 'POST', url: '/v2/payroll/employees', headers: auth(t.token), payload: {
      first_name: first, last_name: 'Prueba', position: 'Puesto', cost_center_id: cc, hire_date: hire, monthly_salary: salary,
      pay_frequency: 'mensual', payment_method: 'transferencia', applies_isss: true, applies_afp: true, applies_isr: true, ...extra } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().id as number;
  };

  beforeAll(async () => {
    app = await buildApp();
    t = await createTenant();
    ids = await setupAccounting(app, t);
    const cc = await app.inject({ method: 'GET', url: '/v2/payroll/cost-centers', headers: auth(t.token) });
    ccGeneral = cc.json().items.find((x: { name: string }) => x.name === 'General').id;
    const v = await app.inject({ method: 'POST', url: '/v2/payroll/cost-centers', headers: auth(t.token), payload: {
      name: 'Ventas', salary_account_id: ids.get('4.2.07'), isss_account_id: null, afp_account_id: null } });
    ccVentas = v.json().id;
    emp.ana = await employee('Ana', 1200, '2020-01-15', ccGeneral, { dui: '01234567-8' });
    emp.luis = await employee('Luis', 408.8, '2025-03-01', ccVentas);
    emp.nueva = await employee('Nueva', 600, '2026-03-16', ccGeneral);
  });
  afterAll(async () => { await app?.close(); });

  let payrollId: number;
  it('calcula ISSS con tope, AFP, renta por tramos y días proporcionales', async () => {
    const res = await app.inject({ method: 'POST', url: '/v2/payroll/payrolls', headers: auth(t.token), payload: {
      kind: 'ordinaria', frequency: 'mensual', period_start: '2026-03-01', period_end: '2026-03-31', payment_date: '2026-03-31' } });
    expect(res.statusCode, res.body).toBe(200);
    payrollId = res.json().id;
    const detail = await app.inject({ method: 'GET', url: `/v2/payroll/payrolls/${payrollId}`, headers: auth(t.token) });
    const lines = new Map(detail.json().lines.map((l: { employee_id: number }) => [l.employee_id, l]));
    const ana = lines.get(emp.ana) as Record<string, number>;
    expect(ana.base_salary).toBe(1200);
    expect(ana.isss_employee).toBe(30);       // 3% del tope de $1,000
    expect(ana.isss_employer).toBe(75);
    expect(ana.afp_employee).toBe(87);        // 7.25% de 1,200
    expect(ana.afp_employer).toBe(105);
    expect(ana.isr).toBe(97.55);              // 60 + (1,083 − 895.24) × 20%
    expect(ana.net).toBe(985.45);
    const luis = lines.get(emp.luis) as Record<string, number>;
    expect(luis.isss_employee).toBe(12.26);
    expect(luis.afp_employee).toBe(29.64);
    expect(luis.isr).toBe(0);                 // base 366.90 está exenta
    const nueva = lines.get(emp.nueva) as Record<string, number>;
    expect(nueva.period_days).toBe(15);       // ingresó el 16 de marzo
    expect(nueva.base_salary).toBe(300);
  });

  it('horas extra con recargo del 100% recalculan la boleta', async () => {
    const detail = await app.inject({ method: 'GET', url: `/v2/payroll/payrolls/${payrollId}`, headers: auth(t.token) });
    const line = detail.json().lines.find((l: { employee_id: number }) => l.employee_id === emp.ana);
    const upd = await app.inject({ method: 'PUT', url: `/v2/payroll/lines/${line.id}`, headers: auth(t.token), payload: { overtime_day_hours: 4 } });
    expect(upd.statusCode, upd.body).toBe(200);
    const after = await app.inject({ method: 'GET', url: `/v2/payroll/payrolls/${payrollId}`, headers: auth(t.token) });
    expect(after.json().lines.find((l: { employee_id: number }) => l.employee_id === emp.ana).overtime_pay).toBe(40);   // $5/h × 2 × 4 h
  });

  it('no permite dos planillas del mismo período', async () => {
    const dup = await app.inject({ method: 'POST', url: '/v2/payroll/payrolls', headers: auth(t.token), payload: {
      kind: 'ordinaria', frequency: 'mensual', period_start: '2026-03-15', period_end: '2026-04-14', payment_date: '2026-04-14' } });
    expect(dup.statusCode).toBe(400);
  });

  it('emitir contabiliza la planilla por centro de costo y pagarla sale del banco', async () => {
    const before = await balances(app, t);
    const emit = await app.inject({ method: 'POST', url: `/v2/payroll/payrolls/${payrollId}/emit`, headers: auth(t.token) });
    expect(emit.statusCode, emit.body).toBe(200);
    const p = (await app.inject({ method: 'GET', url: `/v2/payroll/payrolls/${payrollId}`, headers: auth(t.token) })).json().payroll;
    const after = await balances(app, t);
    const d = (code: string) => Math.round(((after.get(code) ?? 0) - (before.get(code) ?? 0)) * 100) / 100;
    expect(d('4.2.07')).toBe(408.8);                       // sueldos del centro de costo Ventas
    expect(d('4.2.03')).toBe(1240 + 300);                  // General: Ana (con extras) + Nueva
    expect(d('2.1.06')).toBe(-p.net);
    expect(d('2.1.03.02')).toBe(-p.isr);
    const pay = await app.inject({ method: 'POST', url: `/v2/payroll/payrolls/${payrollId}/pay`, headers: auth(t.token), payload: {
      payment_date: '2026-03-31', fund_account_id: ids.get('1.1.01.03') } });
    expect(pay.statusCode, pay.body).toBe(200);
    const paid = await balances(app, t);
    expect(paid.get('2.1.06') ?? 0).toBeCloseTo(before.get('2.1.06') ?? 0, 2);
  });

  it('aguinaldo: 19 días con 6 años de antigüedad, exento de ISSS, AFP y renta', async () => {
    const res = await app.inject({ method: 'POST', url: '/v2/payroll/payrolls', headers: auth(t.token), payload: {
      kind: 'aguinaldo', frequency: 'mensual', period_start: '2026-12-01', period_end: '2026-12-12', payment_date: '2026-12-12' } });
    expect(res.statusCode, res.body).toBe(200);
    const detail = await app.inject({ method: 'GET', url: `/v2/payroll/payrolls/${res.json().id}`, headers: auth(t.token) });
    const ana = detail.json().lines.find((l: { employee_id: number }) => l.employee_id === emp.ana);
    expect(ana.aguinaldo_days).toBe(19);
    expect(ana.aguinaldo).toBe(760);
    expect(ana.isss_employee + ana.afp_employee + ana.isr).toBe(0);
  });

  it('despido sin causa: 30 días por año proporcional; renuncia con menos de 2 años sin prestación', async () => {
    const prev = await app.inject({ method: 'POST', url: '/v2/payroll/terminations/preview', headers: auth(t.token), payload: {
      employee_id: emp.ana, kind: 'despido_injustificado', termination_date: '2026-06-30' } });
    expect(prev.statusCode, prev.body).toBe(200);
    // 2,359 días de servicio (15/01/2020 – 30/06/2026) × $1,200 / 365
    expect(prev.json().service_days).toBe(2359);
    expect(prev.json().indemnity).toBe(7755.62);
    expect(prev.json().pending_days).toBe(90);             // planilla pagada hasta el 31/03
    const ren = await app.inject({ method: 'POST', url: '/v2/payroll/terminations/preview', headers: auth(t.token), payload: {
      employee_id: emp.luis, kind: 'renuncia', termination_date: '2026-06-30' } });
    expect(ren.json().indemnity).toBe(0);

    const reg = await app.inject({ method: 'POST', url: '/v2/payroll/terminations', headers: auth(t.token), payload: {
      employee_id: emp.luis, kind: 'renuncia', termination_date: '2026-06-30', reason: 'Renuncia voluntaria' } });
    expect(reg.statusCode, reg.body).toBe(200);
    const emps = await app.inject({ method: 'GET', url: '/v2/payroll/employees', headers: auth(t.token) });
    expect(emps.json().items.find((e: { id: number }) => e.id === emp.luis).status).toBe('retirado');
    const voided = await app.inject({ method: 'POST', url: `/v2/payroll/terminations/${reg.json().id}/void`, headers: auth(t.token), payload: { reason: 'Se retractó' } });
    expect(voided.statusCode).toBe(200);
  });

  it('F-910 suma lo retenido en el año por empleado', async () => {
    const res = await app.inject({ method: 'GET', url: '/v2/payroll/reports/f910?year=2026', headers: auth(t.token) });
    const ana = res.json().items.find((x: { employee_id: number }) => x.employee_id === emp.ana);
    expect(ana.isr).toBeGreaterThan(97);
  });

  it('RRHH gestiona planillas; el contador solo las consulta', async () => {
    const rrhh = await t.tokenFor('rrhh');
    expect((await app.inject({ method: 'GET', url: '/v2/payroll/employees', headers: auth(rrhh) })).statusCode).toBe(200);
    const contador = await t.tokenFor('contador');
    expect((await app.inject({ method: 'GET', url: '/v2/payroll/employees', headers: auth(contador) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v2/payroll/terminations/preview', headers: auth(contador), payload: {} })).statusCode).toBe(403);
    const cajero = await t.tokenFor('cajero');
    expect((await app.inject({ method: 'GET', url: '/v2/payroll/employees', headers: auth(cajero) })).statusCode).toBe(403);
  });
});
