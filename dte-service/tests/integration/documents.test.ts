import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, buildApp, createTenant, db, hasDb, type TestTenant } from './helpers.js';
import { balances, setupAccounting } from './accounting.helpers.js';

describe.skipIf(!hasDb)('ventas y compras contabilizadas, CxC y CxP', () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let ids: Map<string, number>;

  const venta = async (tenantId: number, v: Record<string, unknown>) => {
    const { query } = await db();
    const res = await query<{ id: string }>(`
      INSERT INTO ventas (tenant_id, kind, fecha, descripcion, monto, gravado, exento, iva, cliente_nombre, cliente_nit, cliente_nrc, metadata)
      VALUES ($1, $2, $3, 'test', $4, $5, $6, $7, $8, $9, $10, $11::jsonb) RETURNING id`,
      [tenantId, v.kind ?? 'consumidor', v.fecha ?? '2026-04-10', v.monto ?? null, v.gravado ?? null, v.exento ?? null, v.iva ?? null,
       v.cliente_nombre ?? null, v.cliente_nit ?? null, v.cliente_nrc ?? null, JSON.stringify(v.metadata ?? {})]);
    return Number(res.rows[0]!.id);
  };
  const compra = async (tenantId: number, c: Record<string, unknown>) => {
    const { query } = await db();
    const res = await query<{ id: string }>(`
      INSERT INTO compras (tenant_id, fecha, proveedor_nombre, proveedor_nit, proveedor_nrc, descripcion, gravado, exento, iva, total, metadata)
      VALUES ($1, $2, $3, $4, $5, 'test', $6, $7, $8, $9, $10::jsonb) RETURNING id`,
      [tenantId, c.fecha ?? '2026-04-12', c.proveedor_nombre ?? 'Proveedor S.A.', c.proveedor_nit ?? '06140101001010', c.proveedor_nrc ?? '1234-5',
       c.gravado ?? 0, c.exento ?? 0, c.iva ?? 0, c.total ?? 0, JSON.stringify(c.metadata ?? {})]);
    return Number(res.rows[0]!.id);
  };
  const posting = async (tenantId: number, module: string, id: number) => {
    const { query } = await db();
    const r = await query<{ status: string; message: string | null; entry_id: string | null }>(
      'SELECT status, message, entry_id FROM accounting.document_postings WHERE tenant_id = $1 AND module = $2 AND source_id = $3',
      [tenantId, module, id]);
    return r.rows[0];
  };
  const enable = (tok: string, start = '2026-01-01', extra: Record<string, unknown> = {}) =>
    app.inject({ method: 'PUT', url: '/v2/acc/integration/settings', headers: auth(tok), payload: {
      auto_post: true, posting_start_date: start, sales_cash_role: 'cash', purchases_cash_mode: 'payables', default_credit_days: 30, ...extra } });

  beforeAll(async () => {
    app = await buildApp();
    t = await createTenant();
    ids = await setupAccounting(app, t);
    const { query } = await db();
    await query(`INSERT INTO contribuyentes (tenant_id, nombre, nit, nrc, tipo) VALUES ($1, 'Cliente Grande S.A.', '06141111111111', '111-1', 'Cliente')`, [t.tenantId]);
  });
  afterAll(async () => { await app?.close(); });

  it('apagado por defecto: una venta no se contabiliza', async () => {
    const id = await venta(t.tenantId, { monto: 50 });
    expect(await posting(t.tenantId, 'ventas', id)).toBeUndefined();
  });

  it('activar exige fecha de inicio', async () => {
    const res = await app.inject({ method: 'PUT', url: '/v2/acc/integration/settings', headers: auth(t.token), payload: {
      auto_post: true, posting_start_date: null, sales_cash_role: 'cash', purchases_cash_mode: 'payables', default_credit_days: 30 } });
    expect(res.statusCode).toBe(400);
    expect((await enable(t.token)).statusCode).toBe(200);
  });

  it('FCF de contado: caja contra ventas e IVA débito (monto con IVA incluido)', async () => {
    const before = await balances(app, t);
    const id = await venta(t.tenantId, { monto: 113 });
    expect((await posting(t.tenantId, 'ventas', id))?.status).toBe('contabilizado');
    const after = await balances(app, t);
    expect((after.get('1.1.01.01') ?? 0) - (before.get('1.1.01.01') ?? 0)).toBe(113);
    expect((after.get('5.1') ?? 0) - (before.get('5.1') ?? 0)).toBe(-100);
    expect((after.get('2.1.02') ?? 0) - (before.get('2.1.02') ?? 0)).toBe(-13);
  });

  let ccfId: number;
  it('CCF al crédito con retención de renta: documento en CxC por el neto a cobrar', async () => {
    ccfId = await venta(t.tenantId, { kind: 'contribuyente', gravado: 1000, exento: 0, iva: 130, cliente_nombre: 'Cliente Grande S.A.',
      cliente_nit: '0614-111111-111-1', metadata: { condicionOperacion: '2', retencionRenta: '100.00', numeroControl: 'DTE-03-0001' } });
    expect((await posting(t.tenantId, 'ventas', ccfId))?.status).toBe('contabilizado');
    const parties = await app.inject({ method: 'GET', url: '/v2/acc/cxc/parties', headers: auth(t.token) });
    const p = parties.json().items.find((x: { party_name: string }) => x.party_name === 'Cliente Grande S.A.');
    expect(p.balance).toBe(1030);
    expect(p.party_key).toMatch(/^id:/);   // reconocido en Contribuyentes por NIT
  });

  it('cobros parciales, anticipo por lo no aplicado y auxiliar cuadrado con la cuenta de control', async () => {
    const docs = await app.inject({ method: 'GET', url: '/v2/acc/cxc/documents?status=open', headers: auth(t.token) });
    const doc = docs.json().items.find((d: { doc_number: string }) => d.doc_number === 'DTE-03-0001');
    const party_key = doc.party_key;
    const pay1 = await app.inject({ method: 'POST', url: '/v2/acc/cxc/payments', headers: auth(t.token), payload: {
      payment_date: '2026-04-20', party_key, method: 'transferencia', fund_account_id: ids.get('1.1.01.03'), amount: 500,
      allocations: [{ document_id: doc.id, amount: 500 }] } });
    expect(pay1.statusCode, pay1.body).toBe(200);
    const over = await app.inject({ method: 'POST', url: '/v2/acc/cxc/payments', headers: auth(t.token), payload: {
      payment_date: '2026-04-21', party_key, method: 'transferencia', fund_account_id: ids.get('1.1.01.03'), amount: 600,
      allocations: [{ document_id: doc.id, amount: 600 }] } });
    expect(over.statusCode).toBe(400);   // se pasa del saldo (530)
    const pay2 = await app.inject({ method: 'POST', url: '/v2/acc/cxc/payments', headers: auth(t.token), payload: {
      payment_date: '2026-04-21', party_key, method: 'transferencia', fund_account_id: ids.get('1.1.01.03'), amount: 600,
      allocations: [{ document_id: doc.id, amount: 530 }] } });
    expect(pay2.statusCode, pay2.body).toBe(200);
    const parties = await app.inject({ method: 'GET', url: '/v2/acc/cxc/parties', headers: auth(t.token) });
    const p = parties.json().items.find((x: { party_key: string }) => x.party_key === party_key);
    expect(p.balance).toBe(0);
    expect(p.advances).toBe(70);
    const b = await balances(app, t);
    expect(b.get('2.1.04')).toBe(-70);   // anticipos de clientes
    const check = await app.inject({ method: 'GET', url: '/v2/acc/cxc/check', headers: auth(t.token) });
    expect(check.json().difference).toBe(0);
  });

  it('editar el monto de una venta con cobros aplicados queda en error y no se pierde el asiento', async () => {
    const { query } = await db();
    await query('UPDATE ventas SET gravado = 2000, iva = 260 WHERE id = $1', [ccfId]);
    const p = await posting(t.tenantId, 'ventas', ccfId);
    expect(p?.status).toBe('error');
    expect(p?.message).toMatch(/cobros\/pagos aplicados/);
    const check = await app.inject({ method: 'GET', url: '/v2/acc/cxc/check', headers: auth(t.token) });
    expect(check.json().difference).toBe(0);
    await query('UPDATE ventas SET gravado = 1000, iva = 130 WHERE id = $1', [ccfId]);
    expect((await posting(t.tenantId, 'ventas', ccfId))?.status).toBe('contabilizado');
  });

  let compraId: number;
  it('compra con percepción: CxP por el total y crédito fiscal', async () => {
    const before = await balances(app, t);
    compraId = await compra(t.tenantId, { gravado: 200, iva: 26, total: 228, metadata: { ivaPercibido: '2.00', clasificacion: '2', numeroControl: 'DTE-03-PROV-1' } });
    expect((await posting(t.tenantId, 'compras', compraId))?.status).toBe('contabilizado');
    const after = await balances(app, t);
    expect((after.get('4.2.01') ?? 0) - (before.get('4.2.01') ?? 0)).toBe(200);
    expect((after.get('1.1.03') ?? 0) - (before.get('1.1.03') ?? 0)).toBe(26);
    expect((after.get('1.1.04') ?? 0) - (before.get('1.1.04') ?? 0)).toBe(2);
    expect((after.get('2.1.01') ?? 0) - (before.get('2.1.01') ?? 0)).toBe(-228);
  });

  it('el contador distribuye la compra en dos cuentas y se recontabiliza', async () => {
    const res = await app.inject({ method: 'PUT', url: `/v2/acc/compras/${compraId}/distribution`, headers: auth(t.token), payload: {
      lines: [{ account_id: ids.get('4.1'), amount: 150 }, { account_id: ids.get('4.2.01'), amount: 50 }] } });
    expect(res.statusCode, res.body).toBe(200);
    const bad = await app.inject({ method: 'PUT', url: `/v2/acc/compras/${compraId}/distribution`, headers: auth(t.token), payload: {
      lines: [{ account_id: ids.get('4.1'), amount: 10 }] } });
    expect(bad.statusCode).toBe(400);
    const b = await balances(app, t, '2026-04-12', '2026-04-12');
    expect(b.get('4.1')).toBe(150);
  });

  it('pago al proveedor salda el documento; borrar la compra pagada queda en error', async () => {
    const docs = await app.inject({ method: 'GET', url: '/v2/acc/cxp/documents?status=open', headers: auth(t.token) });
    const doc = docs.json().items.find((d: { doc_number: string }) => d.doc_number === 'DTE-03-PROV-1');
    expect(doc.balance).toBe(228);
    const pay = await app.inject({ method: 'POST', url: '/v2/acc/cxp/payments', headers: auth(t.token), payload: {
      payment_date: '2026-04-25', party_key: doc.party_key, method: 'cheque', fund_account_id: ids.get('1.1.01.03'), amount: 228,
      allocations: [{ document_id: doc.id, amount: 228 }], reference: 'CH-0001' } });
    expect(pay.statusCode, pay.body).toBe(200);
    const check = await app.inject({ method: 'GET', url: '/v2/acc/cxp/check', headers: auth(t.token) });
    expect(check.json().difference).toBe(0);

    const { query } = await db();
    await query('DELETE FROM compras WHERE id = $1', [compraId]);
    expect((await posting(t.tenantId, 'compras', compraId))?.status).toBe('error');

    // anular el pago libera el documento
    const voided = await app.inject({ method: 'POST', url: `/v2/acc/cxp/payments/${pay.json().id}/void`, headers: auth(t.token), payload: { reason: 'Cheque rechazado' } });
    expect(voided.statusCode).toBe(200);
  });

  it('borrar una compra sin pagos revierte su asiento', async () => {
    const id = await compra(t.tenantId, { gravado: 10, iva: 1.3, total: 11.3 });
    const before = await balances(app, t);
    const { query } = await db();
    await query('DELETE FROM compras WHERE id = $1', [id]);
    const after = await balances(app, t);
    expect((after.get('2.1.01') ?? 0) - (before.get('2.1.01') ?? 0)).toBeCloseTo(11.3, 2);
    expect(await posting(t.tenantId, 'compras', id)).toBeUndefined();
  });

  it('una venta anulada se revierte', async () => {
    const id = await venta(t.tenantId, { monto: 22.6 });
    const { query } = await db();
    await query(`UPDATE ventas SET metadata = metadata || '{"anulado": true}' WHERE id = $1`, [id]);
    const p = await posting(t.tenantId, 'ventas', id);
    expect(p?.status).toBe('omitido');
    expect(p?.message).toBe('anulado');
  });

  it('sin cuentas configuradas la venta se guarda igual y el error queda en la cola', async () => {
    const other = await createTenant();
    await enable(other.token);
    const id = await venta(other.tenantId, { monto: 10 });
    const { query } = await db();
    const exists = await query('SELECT 1 FROM ventas WHERE id = $1', [id]);
    expect(exists.rows.length).toBe(1);
    const p = await posting(other.tenantId, 'ventas', id);
    expect(p?.status).toBe('error');
    expect(p?.message).toMatch(/Falta asignar la cuenta/);
  });

  it('un mes cerrado deja la venta en error con el motivo', async () => {
    await app.inject({ method: 'POST', url: '/v2/acc/periods/close', headers: auth(t.token), payload: { year: 2026, month: 2 } });
    const id = await venta(t.tenantId, { monto: 11.3, fecha: '2026-02-15' });
    const p = await posting(t.tenantId, 'ventas', id);
    expect(p?.status).toBe('error');
    expect(p?.message).toMatch(/cerrado/);
  });

  it('contabilizar pendientes (histórico) desde la fecha de inicio', async () => {
    const other = await createTenant();
    await setupAccounting(app, other);
    const a = await venta(other.tenantId, { monto: 11.3, fecha: '2025-12-31' });
    const b = await venta(other.tenantId, { monto: 22.6, fecha: '2026-01-05' });
    const c = await compra(other.tenantId, { gravado: 100, iva: 13, total: 113, fecha: '2026-01-06' });
    await enable(other.token, '2026-01-01');
    const run = await app.inject({ method: 'POST', url: '/v2/acc/integration/post-pending', headers: auth(other.token), payload: {} });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json().result.ventas.contabilizado).toBe(1);
    expect(run.json().result.compras.contabilizado).toBe(1);
    expect(await posting(other.tenantId, 'ventas', a)).toBeUndefined();   // antes del inicio
    expect((await posting(other.tenantId, 'ventas', b))?.status).toBe('contabilizado');
    expect((await posting(other.tenantId, 'compras', c))?.status).toBe('contabilizado');
    const summary = await app.inject({ method: 'GET', url: '/v2/acc/integration/summary', headers: auth(other.token) });
    expect(summary.statusCode).toBe(200);
  });

  it('documento manual de saldo inicial en CxC', async () => {
    const { query } = await db();
    const party = await query<{ id: string }>(`INSERT INTO contribuyentes (tenant_id, nombre, nit, tipo) VALUES ($1, 'Cliente Antiguo', '06142222222222', 'Cliente') RETURNING id`, [t.tenantId]);
    const res = await app.inject({ method: 'POST', url: '/v2/acc/cxc/documents', headers: auth(t.token), payload: {
      party_id: Number(party.rows[0]!.id), doc_number: 'SALDO-2025', doc_date: '2026-01-01', amount: 350, counter_account_id: ids.get('3.2'),
      description: 'Saldo inicial al 31/12/2025' } });
    expect(res.statusCode, res.body).toBe(200);
    const aging = await app.inject({ method: 'GET', url: '/v2/acc/cxc/aging?as_of=2026-06-30', headers: auth(t.token) });
    const row = aging.json().items.find((x: { party_name: string }) => x.party_name === 'Cliente Antiguo');
    expect(row.d90_plus).toBe(350);
    const check = await app.inject({ method: 'GET', url: '/v2/acc/cxc/check', headers: auth(t.token) });
    expect(check.json().difference).toBe(0);
  });

  it('el cajero no ve CxP ni registra cobros', async () => {
    const cajero = await t.tokenFor('cajero');
    expect((await app.inject({ method: 'GET', url: '/v2/acc/cxp/parties', headers: auth(cajero) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v2/acc/cxc/payments', headers: auth(cajero), payload: {} })).statusCode).toBe(403);
  });
});
