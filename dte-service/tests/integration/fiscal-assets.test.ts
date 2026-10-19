import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, buildApp, createTenant, db, hasDb, type TestTenant } from './helpers.js';
import { balances, setupAccounting } from './accounting.helpers.js';

const supplierDte = (code: string, overrides: Record<string, unknown> = {}) => JSON.stringify({
  identificacion: { tipoDte: '03', numeroControl: `DTE-03-ABCD1234-${code.slice(0, 15).padStart(15, '0')}`, codigoGeneracion: code, fecEmi: '2026-05-10' },
  emisor: { nit: '06141234567890', nrc: '9876-5', nombre: 'Ferretería Central S.A. de C.V.', descActividad: 'Venta de ferretería',
            direccion: { departamento: '06', municipio: '14', complemento: 'San Salvador' }, correo: 'ventas@ferreteria.test' },
  receptor: { nit: '06140101261001', nrc: '1234567', nombre: 'EMPRESA DE PRUEBA' },
  cuerpoDocumento: [{ descripcion: 'Herramientas' }],
  resumen: { totalGravada: 200, totalExenta: 0, totalNoSuj: 0, tributos: [{ codigo: '20', descripcion: 'IVA', valor: 26 }],
             ivaPerci1: 2, ivaRete1: 0, reteRenta: 0, montoTotalOperacion: 226, totalPagar: 228 },
  selloRecibido: `SELLO${code.slice(0, 8)}`,
  ...overrides,
});

describe.skipIf(!hasDb)('posición fiscal, DTEs recibidos, importaciones y activos fijos', () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let ids: Map<string, number>;

  beforeAll(async () => {
    app = await buildApp();
    t = await createTenant();
    ids = await setupAccounting(app, t);
    const { query } = await db();
    await query(`INSERT INTO tenant_emisor (tenant_id, mh_env, mh_nit, mh_password_enc, firmador_password_enc, cert_path, emisor_nrc, emisor_nombre,
                   emisor_cod_actividad, emisor_desc_actividad, emisor_tipo_establecimiento, emisor_departamento, emisor_municipio,
                   emisor_complemento, emisor_email, punto_venta_establecimiento, punto_venta_punto)
                 VALUES ($1, 'sandbox', '06140101261001', 'x', 'x', 'x', '1234567', 'EMPRESA DE PRUEBA', '1', 'x', '01', '06', '14', 'x', 'x@x.test', 'M001', 'P001')`, [t.tenantId]);
    await app.inject({ method: 'PUT', url: '/v2/acc/integration/settings', headers: auth(t.token), payload: {
      auto_post: true, posting_start_date: '2026-01-01', sales_cash_role: 'cash', purchases_cash_mode: 'payables', default_credit_days: 30 } });
  });
  afterAll(async () => { await app?.close(); });

  it('DTEs recibidos: registra, detecta duplicados y rechaza lo que no es de la empresa o no tiene sello', async () => {
    const res = await app.inject({ method: 'POST', url: '/v2/received/upload', headers: auth(t.token), payload: { files: [
      { name: 'ok.json', content: supplierDte('AAAAAAAA-1111-2222-3333-444444444444') },
      { name: 'dup.json', content: supplierDte('AAAAAAAA-1111-2222-3333-444444444444') },
      { name: 'otro.json', content: supplierDte('BBBBBBBB-1111-2222-3333-444444444444', { receptor: { nit: '06149999999999', nrc: '1111', nombre: 'OTRA' } }) },
      { name: 'sinsello.json', content: supplierDte('CCCCCCCC-1111-2222-3333-444444444444', { selloRecibido: undefined }) },
      { name: 'basura.json', content: '{"hola": 1}' },
    ] } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results.map((r: { status: string }) => r.status)).toEqual(['registrado', 'duplicado', 'rechazado', 'rechazado', 'error']);
    // Entró al libro de compras con la percepción, el proveedor se creó y quedó en CxP por 228
    const { query } = await db();
    const compra = await query<{ id: string; metadata: Record<string, string> }>(`SELECT id, metadata FROM compras WHERE tenant_id = $1`, [t.tenantId]);
    expect(compra.rows[0]!.metadata.ivaPercibido).toBe('2.00');
    const parties = await app.inject({ method: 'GET', url: '/v2/acc/cxp/parties', headers: auth(t.token) });
    expect(parties.json().items[0].party_key).toMatch(/^id:/);
    expect(parties.json().items[0].balance).toBe(228);
  });

  it('importación: valida la ley y contabiliza solo lo pagado en aduana', async () => {
    const before = await balances(app, t);
    const bad = await app.inject({ method: 'POST', url: '/v2/imports', headers: auth(t.token), payload: {
      duca_number: '4000123456', acceptance_date: '2026-05-15', fob: 1000, freight: 100, insurance: 10, other_costs: 0,
      customs_value: 1200, dai: 55.5, iva: 151.52, other_taxes: 0, destination_account_id: ids.get('4.1') } });
    expect(bad.statusCode).toBe(400);   // 1000 + 100 + 10 ≠ 1200
    const ok = await app.inject({ method: 'POST', url: '/v2/imports', headers: auth(t.token), payload: {
      duca_number: '4000123456', acceptance_date: '2026-05-15', fob: 1000, freight: 100, insurance: 10, other_costs: 0,
      customs_value: 1110, dai: 166.5, iva: 165.95, other_taxes: 12, destination_account_id: ids.get('4.1') } });
    expect(ok.statusCode, ok.body).toBe(200);
    const after = await balances(app, t);
    const d = (code: string) => Math.round(((after.get(code) ?? 0) - (before.get(code) ?? 0)) * 100) / 100;
    expect(d('4.1')).toBe(178.5);        // DAI + otros tributos
    expect(d('1.1.03')).toBe(165.95);    // IVA crédito fiscal
    expect(d('2.1.01')).toBe(-344.45);   // a Tesorería
    const dup = await app.inject({ method: 'POST', url: '/v2/imports', headers: auth(t.token), payload: {
      duca_number: '4000123456', acceptance_date: '2026-05-15', fob: 1000, freight: 100, insurance: 10, other_costs: 0,
      customs_value: 1110, dai: 166.5, iva: 165.95, other_taxes: 12, destination_account_id: ids.get('4.1') } });
    expect(dup.statusCode).toBe(400);
  });

  it('posición fiscal: IVA con remanente encadenado y F-14', async () => {
    const { query } = await db();
    // mayo: ventas FCF 1,130 (IVA 130); junio: ventas FCF 2,260 (IVA 260) con retención de renta en un CCF
    await query(`INSERT INTO ventas (tenant_id, kind, fecha, descripcion, monto) VALUES ($1, 'consumidor', '2026-05-20', 'x', 1130)`, [t.tenantId]);
    await query(`INSERT INTO ventas (tenant_id, kind, fecha, descripcion, monto) VALUES ($1, 'consumidor', '2026-06-20', 'x', 2260)`, [t.tenantId]);
    const set = await app.inject({ method: 'PUT', url: '/v2/fiscal/settings', headers: auth(t.token), payload: {
      opening_period: '2026-05-01', opening_remanente: 300, pago_a_cuenta_rate: 0.0175 } });
    expect(set.statusCode).toBe(200);
    const res = await app.inject({ method: 'GET', url: '/v2/fiscal/months?to=2026-06-30', headers: auth(t.token) });
    const [jun, may] = res.json().items;
    // mayo: débito 130 − crédito (26 + 165.95) − percepción 2 − remanente 300 → negativo: pasa remanente
    expect(may.debito).toBe(130);
    expect(may.credito).toBe(191.95);
    expect(may.iva_a_pagar).toBe(0);
    expect(may.remanente_siguiente).toBe(363.95);
    expect(may.pago_a_cuenta).toBe(17.5);   // 1.75% de 1,000 (ventas netas)
    expect(jun.remanente_anterior).toBe(363.95);
    expect(jun.iva_a_pagar).toBe(0);
    expect(jun.remanente_siguiente).toBe(103.95);
  });

  it('liquidación del IVA y pago del F-14 cuadran contra la contabilidad', async () => {
    const liq = await app.inject({ method: 'POST', url: '/v2/fiscal/liquidate', headers: auth(t.token), payload: { period: '2026-05-01' } });
    expect(liq.statusCode, liq.body).toBe(200);
    const b = await balances(app, t, '2026-01-01', '2026-05-31');
    expect(b.get('2.1.02') ?? 0).toBe(0);          // débito de mayo saldado
    expect(b.get('1.1.04') ?? 0).toBe(0);          // percepción aplicada
    // el crédito que no se usó queda como remanente en IVA crédito fiscal (191.95 + 2 − 130 = 63.95 del mes)
    expect(b.get('1.1.03')).toBe(63.95);
    const again = await app.inject({ method: 'POST', url: '/v2/fiscal/liquidate', headers: auth(t.token), payload: { period: '2026-05-01' } });
    expect(again.statusCode).toBe(400);
    const pay = await app.inject({ method: 'POST', url: '/v2/fiscal/payments', headers: auth(t.token), payload: {
      form: 'F14', period: '2026-05-01', payment_date: '2026-06-10', main: 17.5, withholdings: 0, fund_account_id: ids.get('1.1.01.03') } });
    expect(pay.statusCode, pay.body).toBe(200);
    const months = await app.inject({ method: 'GET', url: '/v2/fiscal/months?to=2026-05-31', headers: auth(t.token) });
    expect(months.json().items[0].pagado_f14).toBe(17.5);
    expect(months.json().items[0].pendiente).toBe(0);
  });

  it('activos fijos: alta con asiento, depreciación línea recta, venta con ganancia', async () => {
    const cats = await app.inject({ method: 'GET', url: '/v2/assets/categories', headers: auth(t.token) });
    const cat = cats.json().items.find((c: { name: string }) => c.name === 'Equipo de cómputo');
    const noAcc = await app.inject({ method: 'POST', url: '/v2/assets', headers: auth(t.token), payload: {
      name: 'Laptop', category_id: cat.id, acquisition_date: '2026-01-10', cost: 1200 } });
    expect(noAcc.statusCode).toBe(400);   // categoría sin cuentas
    const upd = await app.inject({ method: 'PUT', url: `/v2/assets/categories/${cat.id}`, headers: auth(t.token), payload: {
      name: cat.name, tax_class: 'otros_bienes_muebles', annual_rate: 0.5, asset_account_id: ids.get('1.2.01'),
      depreciation_account_id: ids.get('1.2.02'), expense_account_id: ids.get('4.2.01') } });
    expect(upd.statusCode, upd.body).toBe(200);
    const tooFast = await app.inject({ method: 'POST', url: '/v2/assets', headers: auth(t.token), payload: {
      name: 'Laptop', category_id: cat.id, acquisition_date: '2026-01-10', cost: 1200, annual_rate: 0.6 } });
    expect(tooFast.statusCode).toBe(400); // supera el 50% del Art. 30
    const res = await app.inject({ method: 'POST', url: '/v2/assets', headers: auth(t.token), payload: {
      name: 'Laptop', category_id: cat.id, acquisition_date: '2026-01-10', cost: 1200, counter_account_id: ids.get('1.1.01.03') } });
    expect(res.statusCode, res.body).toBe(200);
    const id = res.json().id;
    const sched = await app.inject({ method: 'GET', url: `/v2/assets/${id}/schedule`, headers: auth(t.token) });
    expect(sched.json().items).toHaveLength(24);            // 50% anual = 24 meses
    expect(sched.json().items[0].amount).toBe(50);
    const dep = await app.inject({ method: 'POST', url: '/v2/assets/depreciate', headers: auth(t.token), payload: { through: '2026-03-31' } });
    expect(dep.json().entries).toBe(3);
    const b = await balances(app, t, '2026-01-01', '2026-03-31');
    expect(b.get('1.2.02')).toBe(-150);
    // venta en abril por 1,100: libros 1,050 → ganancia 50 (abril aún sin depreciar: se exige hasta marzo)
    const sell = await app.inject({ method: 'POST', url: `/v2/assets/${id}/dispose`, headers: auth(t.token), payload: {
      kind: 'venta', date: '2026-04-15', amount: 1100, proceeds_account_id: ids.get('1.1.01.03') } });
    expect(sell.statusCode, sell.body).toBe(400);   // falta asignar la cuenta de resultado por venta
    await app.inject({ method: 'PUT', url: '/v2/acc/roles', headers: auth(t.token), payload: { assignments: { asset_disposal_result: ids.get('5.2') } } });
    const sell2 = await app.inject({ method: 'POST', url: `/v2/assets/${id}/dispose`, headers: auth(t.token), payload: {
      kind: 'venta', date: '2026-04-15', amount: 1100, proceeds_account_id: ids.get('1.1.01.03') } });
    expect(sell2.statusCode, sell2.body).toBe(200);
    const after = await balances(app, t, '2026-01-01', '2026-04-30');
    expect(after.get('1.2.01') ?? 0).toBe(0);
    expect(after.get('1.2.02') ?? 0).toBe(0);
    expect(after.get('5.2')).toBe(-50);
  });
});
