import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, buildApp, createTenant, db, hasDb, type TestTenant } from './helpers.js';
import { balances, setupAccounting } from './accounting.helpers.js';

describe.skipIf(!hasDb)('bancos y conciliación', () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let ids: Map<string, number>;
  let bankId: number;

  const movements = async (status?: string) => {
    const res = await app.inject({ method: 'GET', url: `/v2/banks/movements?account_id=${bankId}${status ? `&status=${status}` : ''}`, headers: auth(t.token) });
    return res.json().items as Array<{ id: number; description: string; status: string; debit: number; credit: number; link_label: string | null }>;
  };

  beforeAll(async () => {
    app = await buildApp();
    t = await createTenant();
    ids = await setupAccounting(app, t);
    await app.inject({ method: 'PUT', url: '/v2/acc/integration/settings', headers: auth(t.token), payload: {
      auto_post: true, posting_start_date: '2026-01-01', sales_cash_role: 'cash', purchases_cash_mode: 'payables', default_credit_days: 30 } });
    const { query } = await db();
    await query(`INSERT INTO contribuyentes (tenant_id, nombre, nit, tipo) VALUES ($1, 'Proveedor Uno', '06143333333333', 'Proveedor')`, [t.tenantId]);
    await query(`INSERT INTO compras (tenant_id, fecha, proveedor_nombre, proveedor_nit, gravado, iva, total, metadata)
                 VALUES ($1, '2026-05-02', 'Proveedor Uno', '06143333333333', 100, 13, 113, '{"numeroControl":"DTE-PROV-77"}')`, [t.tenantId]);
  });
  afterAll(async () => { await app?.close(); });

  it('crea la cuenta bancaria ligada a una cuenta de activo de movimiento', async () => {
    const bad = await app.inject({ method: 'POST', url: '/v2/banks/accounts', headers: auth(t.token), payload: {
      bank_name: 'Banco Agrícola', account_number: '123-456789-0', ledger_account_id: ids.get('2.1.01') } });
    expect(bad.statusCode).toBe(400);
    const res = await app.inject({ method: 'POST', url: '/v2/banks/accounts', headers: auth(t.token), payload: {
      bank_name: 'Banco Agrícola', account_number: '123-456789-0', ledger_account_id: ids.get('1.1.01.03') } });
    expect(res.statusCode, res.body).toBe(200);
    bankId = res.json().id;
  });

  it('importa un estado de cuenta sin duplicar y valida el número de cuenta', async () => {
    const rows = [
      { date: '2026-05-03', reference: 'DEP-1', description: 'DEPOSITO EFECTIVO', debit: 0, credit: 500, balance: 1500 },
      { date: '2026-05-05', reference: 'TEF-9', description: 'PAGO PROVEEDOR UNO', debit: 113, credit: 0, balance: 1387 },
      { date: '2026-05-31', reference: '', description: 'COMISION MANEJO DE CUENTA', debit: 5.65, credit: 0, balance: 1381.35 },
      { date: '2026-05-31', reference: '', description: 'COMISION MANEJO DE CUENTA', debit: 5.65, credit: 0, balance: 1375.70 },
    ];
    const wrong = await app.inject({ method: 'POST', url: `/v2/banks/accounts/${bankId}/import`, headers: auth(t.token), payload: { file_account: '999-000000-1', rows } });
    expect(wrong.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: `/v2/banks/accounts/${bankId}/import`, headers: auth(t.token), payload: { file_account: '1234567890', rows, opening_balance: 1000, closing_balance: 1375.70 } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().new).toBe(4);   // las dos comisiones idénticas se distinguen por su orden
    const again = await app.inject({ method: 'POST', url: `/v2/banks/accounts/${bankId}/import`, headers: auth(t.token), payload: { rows } });
    expect(again.json().new).toBe(0);
    expect(again.json().duplicates).toBe(4);
  });

  it('el cargo al banco crea el pago al proveedor aplicado a su factura', async () => {
    const mv = (await movements('pendiente')).find(m => m.description === 'PAGO PROVEEDOR UNO')!;
    const cands = await app.inject({ method: 'GET', url: `/v2/banks/movements/${mv.id}/candidates`, headers: auth(t.token) });
    const doc = cands.json().items.find((c: { kind: string }) => c.kind === 'document');
    expect(doc.amount).toBe(113);
    const rec = await app.inject({ method: 'POST', url: `/v2/banks/movements/${mv.id}/reconcile`, headers: auth(t.token), payload: { kind: 'document', target_id: doc.target_id } });
    expect(rec.statusCode, rec.body).toBe(200);
    const parties = await app.inject({ method: 'GET', url: '/v2/acc/cxp/parties', headers: auth(t.token) });
    expect(parties.json().items.find((p: { party_name: string }) => p.party_name === 'Proveedor Uno')).toBeUndefined();
  });

  it('las comisiones generan un asiento contra gastos bancarios', async () => {
    const before = await balances(app, t);
    const comms = (await movements('pendiente')).filter(m => m.description.startsWith('COMISION'));
    for (const m of comms) {
      const r = await app.inject({ method: 'POST', url: `/v2/banks/movements/${m.id}/reconcile`, headers: auth(t.token), payload: { kind: 'entry', counter_account_id: ids.get('4.2.02') } });
      expect(r.statusCode, r.body).toBe(200);
    }
    const after = await balances(app, t);
    expect((after.get('4.2.02') ?? 0) - (before.get('4.2.02') ?? 0)).toBeCloseTo(11.3, 2);
  });

  it('un depósito con un cobro registrado se concilia automáticamente', async () => {
    // cobro de contado registrado por el contador en ese banco (anticipo de cliente)
    const { query } = await db();
    const party = await query<{ id: string }>(`INSERT INTO contribuyentes (tenant_id, nombre, tipo) VALUES ($1, 'Cliente Contado', 'Cliente') RETURNING id`, [t.tenantId]);
    const pay = await app.inject({ method: 'POST', url: '/v2/acc/cxc/payments', headers: auth(t.token), payload: {
      payment_date: '2026-05-03', party_key: `id:${party.rows[0]!.id}`, method: 'efectivo', fund_account_id: ids.get('1.1.01.03'), amount: 500, allocations: [] } });
    expect(pay.statusCode, pay.body).toBe(200);
    const auto = await app.inject({ method: 'POST', url: `/v2/banks/accounts/${bankId}/auto-reconcile`, headers: auth(t.token) });
    expect(auto.json().reconciled).toBe(1);
    expect(await movements('pendiente')).toHaveLength(0);
  });

  it('la conciliación a fin de mes cuadra; deshacer anula lo creado', async () => {
    const rec = await app.inject({ method: 'GET', url: `/v2/banks/accounts/${bankId}/reconciliation?as_of=2026-05-31`, headers: auth(t.token) });
    expect(rec.statusCode, rec.body).toBe(200);
    // El banco abrió con 1000 que no están en libros: aparece como diferencia de apertura
    expect(rec.json().bank_balance).toBe(1375.7);
    expect(rec.json().book_balance).toBeCloseTo(375.7, 2);
    expect(rec.json().difference).toBeCloseTo(1000, 2);

    const mv = (await movements()).find(m => m.description === 'PAGO PROVEEDOR UNO')!;
    const un = await app.inject({ method: 'POST', url: `/v2/banks/movements/${mv.id}/unreconcile`, headers: auth(t.token) });
    expect(un.statusCode, un.body).toBe(200);
    const parties = await app.inject({ method: 'GET', url: '/v2/acc/cxp/parties', headers: auth(t.token) });
    expect(parties.json().items.find((p: { party_name: string }) => p.party_name === 'Proveedor Uno').balance).toBe(113);
  });

  it('disponibilidad: bancos − reserva − proveedores', async () => {
    await app.inject({ method: 'PUT', url: '/v2/banks/reserve', headers: auth(t.token), payload: { amount: 100, notes: 'Planilla' } });
    const res = await app.inject({ method: 'GET', url: '/v2/banks/availability', headers: auth(t.token) });
    expect(res.json().banks).toBe(1375.7);
    expect(res.json().available).toBeCloseTo(1375.7 - 100 - 113, 2);
  });

  it('el viewer consulta pero no concilia', async () => {
    const viewer = await t.tokenFor('viewer');
    expect((await app.inject({ method: 'GET', url: '/v2/banks/accounts', headers: auth(viewer) })).statusCode).toBe(200);
    const mv = (await movements())[0]!;
    expect((await app.inject({ method: 'POST', url: `/v2/banks/movements/${mv.id}/ignore`, headers: auth(viewer), payload: { reason: 'xxx' } })).statusCode).toBe(403);
  });
});
