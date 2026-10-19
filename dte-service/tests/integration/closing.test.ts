import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, buildApp, createTenant, hasDb, type TestTenant } from './helpers.js';
import { balances, setupAccounting } from './accounting.helpers.js';

describe.skipIf(!hasDb)('estados financieros y cierre del ejercicio', () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let ids: Map<string, number>;

  const post = (date: string, concept: string, lines: Array<[string, number, number]>) =>
    app.inject({ method: 'POST', url: '/v2/acc/entries', headers: auth(t.token), payload: {
      entry_date: date, concept, post: true,
      lines: lines.map(([code, debit, credit]) => ({ account_id: ids.get(code), debit, credit })) } });

  beforeAll(async () => {
    app = await buildApp();
    t = await createTenant();
    ids = await setupAccounting(app, t);
    // 2024: un ingreso pequeño (año anterior sin cerrar)
    await post('2024-06-01', 'Venta 2024', [['1.1.01.01', 100, 0], ['5.1', 0, 100]]);
    // 2025: capital, ventas y gastos
    await post('2025-01-02', 'Capital', [['1.1.01.03', 5000, 0], ['3.1', 0, 5000]]);
    await post('2025-03-10', 'Ventas', [['1.1.01.03', 3000, 0], ['5.1', 0, 3000]]);
    await post('2025-04-10', 'Costo', [['4.1', 1200, 0], ['1.1.01.03', 0, 1200]]);
    await post('2025-05-10', 'Gastos', [['4.2.01', 800, 0], ['1.1.01.03', 0, 800]]);
  });
  afterAll(async () => { await app?.close(); });

  it('no deja cerrar 2025 si 2024 tiene resultados sin cerrar', async () => {
    const prev = await app.inject({ method: 'GET', url: '/v2/acc/fiscal-years/2025/preview', headers: auth(t.token) });
    expect(prev.json().issues.join(' ')).toMatch(/ejercicios anteriores/);
    const res = await app.inject({ method: 'POST', url: '/v2/acc/fiscal-years/2025/close', headers: auth(t.token), payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('cierra 2024 y luego 2025 con traslado a utilidades acumuladas', async () => {
    const c24 = await app.inject({ method: 'POST', url: '/v2/acc/fiscal-years/2024/close', headers: auth(t.token), payload: { transfer: true } });
    expect(c24.statusCode, c24.body).toBe(200);
    expect(c24.json().result).toBe(100);

    const prev = await app.inject({ method: 'GET', url: '/v2/acc/fiscal-years/2025/preview', headers: auth(t.token) });
    expect(prev.json().issues).toEqual([]);
    expect(prev.json().result).toBe(1000);
    const c25 = await app.inject({ method: 'POST', url: '/v2/acc/fiscal-years/2025/close', headers: auth(t.token), payload: { transfer: true } });
    expect(c25.statusCode, c25.body).toBe(200);
    expect(c25.json().result).toBe(1000);

    // Al 31/12/2025 las cuentas de resultados quedan en cero y la utilidad en 3.3
    const end25 = await balances(app, t, '2025-01-01', '2025-12-31');
    expect(end25.get('5.1') ?? 0).toBe(0);
    expect(end25.get('4.1') ?? 0).toBe(0);
    expect(end25.get('3.3')).toBe(-1000);
    // El 1/1/2026 la utilidad pasa a utilidades acumuladas (incluida la de 2024)
    const jan26 = await balances(app, t, '2026-01-01', '2026-01-01');
    expect(jan26.get('3.3') ?? 0).toBe(0);
    expect(jan26.get('3.2')).toBe(-1100);
  });

  it('el estado de resultados de un año cerrado conserva sus cifras sin la partida de cierre', async () => {
    const res = await app.inject({ method: 'GET', url: '/v2/acc/reports/movements?from=2025-01-01&to=2025-12-31&exclude_closing=1', headers: auth(t.token) });
    const byId = new Map(res.json().items.map((m: { account_id: number; credit: number; debit: number }) => [m.account_id, m]));
    const ventas = byId.get(ids.get('5.1')!) as { credit: number; debit: number };
    expect(ventas.credit - ventas.debit).toBe(3000);
  });

  it('el ejercicio cerrado bloquea registros; reabrir revierte el cierre', async () => {
    const late = await post('2025-07-01', 'Tarde', [['4.2.01', 10, 0], ['1.1.01.03', 0, 10]]);
    expect(late.statusCode).toBe(400);
    const no = await app.inject({ method: 'POST', url: '/v2/acc/fiscal-years/2024/reopen', headers: auth(t.token), payload: { reason: 'x revisión' } });
    expect(no.statusCode).toBe(400);   // 2025 está cerrado
    const re = await app.inject({ method: 'POST', url: '/v2/acc/fiscal-years/2025/reopen', headers: auth(t.token), payload: { reason: 'Ajuste de auditoría' } });
    expect(re.statusCode, re.body).toBe(200);
    const end25 = await balances(app, t, '2025-01-01', '2025-12-31');
    expect(end25.get('5.1')).toBe(-3000);   // vuelven los ingresos de 2025 (los de 2024 siguen saldados por su cierre)
    const years = await app.inject({ method: 'GET', url: '/v2/acc/fiscal-years', headers: auth(t.token) });
    expect(years.json().items.find((y: { year: number }) => y.year === 2025).status).toBe('abierto');
  });

  it('firmantes y datos de la empresa para el encabezado', async () => {
    const put = await app.inject({ method: 'PUT', url: '/v2/acc/signatories', headers: auth(t.token), payload: {
      legal_rep_name: 'Ana López', accountant_name: 'Luis Pérez', accountant_license: 'CVPCPA 1234' } });
    expect(put.statusCode).toBe(200);
    const comp = await app.inject({ method: 'GET', url: '/v2/acc/company', headers: auth(t.token) });
    expect(comp.json().signatories.accountant_license).toBe('CVPCPA 1234');
    expect(comp.json().nombre_legal).toMatch(/Empresa/);
  });
});
