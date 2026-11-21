import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import PDFDocument from 'pdfkit';
import { auth, buildApp, createTenant, db, hasDb, type TestTenant } from './helpers.js';
import { balances, setupAccounting } from './accounting.helpers.js';
import { parseStatement } from '../../src/erp/received/statementParser.js';

// Titular ficticio (persona natural): el DUI es también su NIT
const DUI = '076543210';
const HOLDER = 'MARIA JOSE PEREZ LOPEZ';
const receptor = { tipoDocumento: '13', numDocumento: '07654321-0', nrc: null, nombre: HOLDER };

const bankDte = (code: string, emisor: Record<string, unknown>, lines: Array<[string, number]>, fecEmi: string) => {
  const total = lines.reduce((s, [, m]) => s + m, 0);
  return JSON.stringify({
    identificacion: { tipoDte: '01', numeroControl: `DTE-01-M001P001-${code.slice(0, 15).padStart(15, '0')}`, codigoGeneracion: code, fecEmi },
    emisor, receptor,
    cuerpoDocumento: lines.map(([descripcion, m], i) => ({ numItem: i + 1, descripcion, ventaExenta: m, ventaGravada: 0, ventaNoSuj: 0, noGravado: 0 })),
    resumen: { totalGravada: 0, totalExenta: total, totalNoSuj: 0, totalIva: 0, montoTotalOperacion: total, totalPagar: total },
    selloRecibido: `SELLO${code.slice(0, 8)}`,
  });
};
const cuscatlan = { nit: '06140806720015', nrc: '1465', nombre: 'BANCO CUSCATLAN DE EL SALVADOR, S.A.', codActividad: '64190', descActividad: 'Bancos' };
const promerica = { nit: '05110402951018', nrc: '830860', nombre: 'BANCO PROMERICA, SOCIEDAD ANONIMA', codActividad: '64190', descActividad: 'BANCOS' };

/** Estado de cuenta de tarjeta con el formato de columnas de los bancos (fecha · detalle · monto). */
function statementPdf(holder: string, userPassword?: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 30, ...(userPassword ? { userPassword, pdfVersion: '1.7' as const } : {}) });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.fontSize(9);
    const row = (y: number, ...cols: Array<[number, string]>) => cols.forEach(([x, s]) => doc.text(s, x, y, { lineBreak: false }));
    row(30, [30, 'BANCO CUSCATLAN']);
    row(45, [30, 'Estado de Cuenta de su tarjeta VISA']);
    row(60, [30, holder]);
    row(90, [30, 'No. de Cuenta'], [150, '00040001000000012345']);
    row(105, [30, 'Fecha de Corte'], [150, '08/11/2026']);
    row(120, [300, '+ Interés Corriente'], [500, '$376.58']);
    row(160, [60, 'DETALLE DE TRANSACCIONES']);
    const tx: Array<[string, string, string]> = [
      ['08/11/2026', 'RECARGO INCUMPLIMIENTO DE PAGO', '$33.68'],
      ['08/11/2026', 'INTERES EXTRAFINANCIAMIENTO', '$210.56'],
      ['15/10/2026', 'SUSCRIPCION DIGITAL', '$199.99'],
      ['06/11/2026', 'PAGO RECIBIDO BANCA DIGITAL', '-$1,054.62'],
      ['08/11/2026', 'CUOTA EXTRAFINANCIAM', '$222.20'],
      ['08/11/2026', 'INTERES CORRIENTE BONIFICABLE', '$61.26'],
      ['08/11/2026', 'INTERES CORRIENTE', '$376.58'],
    ];
    tx.forEach(([d, s, m], i) => row(180 + i * 14, [60, d], [140, s], [500, m]));
    row(290, [60, 'SUB TOTAL DE TARJETA 457374******1234'], [500, '$1,162.21']);
    row(320, [40, '06/11/2026'], [100, '$1,054.62'], [160, '$240.81'], [220, '$345.31']);
    doc.end();
  });
}

describe.skipIf(!hasDb)('gastos financieros: intereses de bancos y estados de cuenta', () => {
  let app: FastifyInstance;
  let t: TestTenant;

  beforeAll(async () => {
    app = await buildApp();
    t = await createTenant();
    await setupAccounting(app, t);
    const { query } = await db();
    await query(`INSERT INTO tenant_emisor (tenant_id, mh_env, mh_nit, emisor_dui, cert_path, emisor_nrc, emisor_nombre,
                   emisor_cod_actividad, emisor_desc_actividad, emisor_tipo_establecimiento, emisor_departamento, emisor_municipio,
                   emisor_complemento, emisor_email, punto_venta_establecimiento, punto_venta_punto)
                 VALUES ($1, 'sandbox', $2, $2, 'x', '7654321', $3, '1', 'x', '01', '06', '14', 'x', 'x@x.test', 'M001', 'P001')`,
      [t.tenantId, DUI, HOLDER]);
    await app.inject({ method: 'PUT', url: '/v2/acc/integration/settings', headers: auth(t.token), payload: {
      auto_post: true, posting_start_date: '2026-01-01', sales_cash_role: 'cash', purchases_cash_mode: 'payables', default_credit_days: 30 } });
  });
  afterAll(async () => { await app?.close(); });

  const compra = async (id: number) => (await (await db()).query<{ total: string; exento: string; iva: string; descripcion: string; metadata: Record<string, unknown> }>(
    'SELECT total, exento, iva, descripcion, metadata FROM compras WHERE id = $1', [id])).rows[0]!;

  it('factura del banco con abono a intereses: todo es gasto financiero y va a gastos bancarios', async () => {
    const before = await balances(app, t);
    const res = await app.inject({ method: 'POST', url: '/v2/received/upload', headers: auth(t.token), payload: { files: [
      { name: 'hipoteca.json', content: bankDte('406C1541-0000-4DE8-A4E9-A0EE9047B53E', cuscatlan, [['ABONO A INTERES NORMAL ******2598', 1265.59]], '2026-11-21') }] } });
    const r = res.json().results[0];
    expect(r, res.body).toMatchObject({ status: 'registrado', detail: expect.stringMatching(/gasto financiero: intereses \$1,265\.59/) });
    const c = await compra(r.compra_id);
    expect(c.metadata).toMatchObject({ categoria: 'gasto_financiero', intereses: '1265.59', tipoDocumento: '01', deducibleRenta: true });
    expect(Number(c.iva)).toBe(0);
    expect(c.descripcion).toMatch(/^Intereses/);
    const after = await balances(app, t);
    expect(Math.round(((after.get('4.2.02') ?? 0) - (before.get('4.2.02') ?? 0)) * 100) / 100).toBe(1265.59);
  });

  it('préstamo con póliza: solo la línea de intereses cuenta como interés', async () => {
    const res = await app.inject({ method: 'POST', url: '/v2/received/upload', headers: auth(t.token), payload: { files: [
      { name: 'prestamo.json', content: bankDte('5AD84BD2-0000-4BB5-BBDD-C047A433B967', promerica,
        [['CREDITO No. 1113399', 0], ['Capital: $431.64', 0], ['Interes Corriente', 402.56], ['Poliza Exenta', 40.8]], '2026-10-24') }] } });
    const r = res.json().results[0];
    expect(r.status, res.body).toBe('registrado');
    const c = await compra(r.compra_id);
    expect(Number(c.total)).toBe(443.36);
    expect(c.metadata.intereses).toBe('402.56');
    // La póliza va al gasto normal, los intereses a gastos bancarios
    const plan = (await (await db()).query<{ p: { lines: Array<{ debit: number; account_id: number }> } }>(
      'SELECT accounting.plan_compra($1, $2) AS p', [t.tenantId, r.compra_id])).rows[0]!.p;
    const ids = (await app.inject({ method: 'GET', url: '/v2/acc/accounts', headers: auth(t.token) })).json().items as Array<{ id: string; code: string }>;
    const code = (id: number) => ids.find(a => Number(a.id) === Number(id))?.code;
    const debits = plan.lines.filter(l => l.debit > 0).map(l => [code(l.account_id), l.debit]);
    expect(debits).toEqual(expect.arrayContaining([['4.2.02', 402.56], ['4.2.01', 40.8]]));
    expect(debits).toHaveLength(2);
  });

  it('una factura normal de un proveedor no se marca como gasto financiero', async () => {
    const res = await app.inject({ method: 'POST', url: '/v2/received/upload', headers: auth(t.token), payload: { files: [
      { name: 'tienda.json', content: bankDte('7A7A7A7A-0000-4BB5-BBDD-C047A433B967',
        { nit: '06141234567890', nrc: '98765', nombre: 'Tienda de Intereses Varios S.A.', codActividad: '47190' }, [['Libro: intereses compuestos', 25]], '2026-10-24') }] } });
    const c = await compra(res.json().results[0].compra_id);
    expect(c.metadata.categoria).toBeUndefined();
  });

  it('el lector de estados de cuenta suma solo los intereses con fecha del detalle', () => {
    const text = [
      'BANCO CUSCATLAN', 'Estado de Cuenta de su tarjeta VISA', 'Fecha de Corte 08/11/2026', '+ Interés Corriente $376.58',
      '08/11/2026 INTERES EXTRAFINANCIAMIENTO $210.56', '08/11/2026 INTERES CORRIENTE BONIFICABLE $61.26', '08/11/2026 INTERES CORRIENTE $376.58',
      '08/11/2026 RECARGO INCUMPLIMIENTO DE PAGO $33.68', '06/11/2026 $1,054.62 $240.81 $345.31', 'SUB TOTAL DE TARJETA 457374******4861 $1,162.21',
    ].join('\n');
    const st = parseStatement(text)!;
    expect(st.interestTotal).toBe(648.4);
    expect(st.lines).toHaveLength(3);
    expect(st.otherLines.map(l => l.monto)).toEqual([33.68]);
    expect(st).toMatchObject({ bankKey: 'CUSCATLAN', cutDate: '2026-11-08', account: 'Tarjeta ****4861', number: 'EC-CUSCATLAN-4861-20261108' });
    expect(parseStatement('Factura de consumidor final 08/11/2026')).toBeNull();
  });

  it('estado de cuenta en PDF: vista previa, registro con su PDF, duplicado y titular ajeno', async () => {
    const pdf = await statementPdf(HOLDER);
    const send = (content: Buffer, preview = false) => app.inject({ method: 'POST', url: '/v2/received/statement', headers: auth(t.token),
      payload: { name: 'estado.pdf', content_base64: content.toString('base64'), preview } });
    const prev = await send(pdf, true);
    expect(prev.statusCode, prev.body).toBe(200);
    expect(prev.json()).toMatchObject({ belongs: true, result: null, statement: { interestTotal: 648.4, cutDate: '2026-11-08', account: 'Tarjeta ****1234' } });
    const ok = await send(pdf);
    expect(ok.json().result).toMatchObject({ status: 'registrado' });
    const c = await compra(ok.json().result.compra_id);
    expect(c.metadata).toMatchObject({ tipoDocumento: 'EC', categoria: 'gasto_financiero', intereses: '648.40' });
    expect(Number(c.total)).toBe(648.4);
    const { query } = await db();
    expect((await query('SELECT count(*)::int n FROM compra_adjuntos WHERE compra_id = $1', [ok.json().result.compra_id])).rows[0]!.n).toBe(1);
    expect((await send(pdf)).json().result.status).toBe('duplicado');
    const ajeno = await send(await statementPdf('JUAN CARLOS RAMIREZ ORTIZ'));
    expect(ajeno.json().result).toMatchObject({ status: 'rechazado', detail: expect.stringMatching(/titular/) });
    // Protegido con el DUI del titular (como lo mandan los bancos): se abre solo
    const protegido = await send(await statementPdf(HOLDER, DUI), true);
    expect(protegido.statusCode, protegido.body).toBe(200);
    expect(protegido.json().statement.interestTotal).toBe(648.4);
    const otraClave = await send(await statementPdf(HOLDER, 'clave-secreta'), true);
    expect(otraClave.json().message).toMatch(/contraseña/);
    const noPdf = await send(Buffer.from('hola mundo, esto no es un pdf'));
    expect(noPdf.statusCode).toBe(400);
  });

  it('si el banco emite factura de intereses de la tarjeta en el mes, el estado de cuenta no se considera', async () => {
    const { query } = await db();
    const ec = (await query<{ id: number }>(`SELECT id FROM compras WHERE tenant_id = $1 AND metadata->>'numeroDocumento' = 'EC-CUSCATLAN-1234-20261108'`, [t.tenantId])).rows[0]!;
    // Llega la factura del pago de intereses de la tarjeta (noviembre): el estado de cuenta de noviembre se anula
    const res = await app.inject({ method: 'POST', url: '/v2/received/upload', headers: auth(t.token), payload: { files: [
      { name: 'tarjeta.json', content: bankDte('9B9B9B9B-0000-4DE8-A4E9-A0EE9047B53E', cuscatlan, [['PAGO INTERES TARJ DE CREDITO', 552.55]], '2026-11-06') }] } });
    expect(res.json().results[0].status, res.body).toBe('registrado');
    const anulado = (await query<{ metadata: Record<string, unknown> }>('SELECT metadata FROM compras WHERE id = $1', [ec.id])).rows[0]!.metadata;
    expect(anulado).toMatchObject({ anulado: true, motivoAnulacion: expect.stringMatching(/factura de intereses/) });
    // Otro estado de cuenta de tarjeta del mismo banco y mes: ya hay factura, no se registra
    const r = (await query<{ r: { status: string; detail: string } }>('SELECT accounting.ingest_financial_statement($1, $2::jsonb, $3, $4::jsonb) AS r', [t.tenantId,
      JSON.stringify({ number: 'EC-CUSCATLAN-9999-20261108', bank_name: 'BANCO CUSCATLAN DE EL SALVADOR, S.A.', bank_nit: '06140806720015',
        account: 'Tarjeta ****9999', cut_date: '2026-11-08', interest_total: 100, lines: [] }), 'upload', '{}'])).rows[0]!.r;
    expect(r).toMatchObject({ status: 'duplicado', detail: expect.stringMatching(/ya emitió factura de intereses de tarjeta/) });
    // La factura del hipotecario (préstamo) no tapa un estado de cuenta de préstamo de otro banco ni de tarjeta de otro mes
    const otroMes = (await query<{ r: { status: string } }>('SELECT accounting.ingest_financial_statement($1, $2::jsonb, $3, $4::jsonb) AS r', [t.tenantId,
      JSON.stringify({ number: 'EC-CUSCATLAN-9999-20261208', bank_name: 'BANCO CUSCATLAN DE EL SALVADOR, S.A.', bank_nit: '06140806720015',
        account: 'Tarjeta ****9999', cut_date: '2026-12-08', interest_total: 100, lines: [] }), 'upload', '{}'])).rows[0]!.r;
    expect(otroMes.status).toBe('registrado');
  });

  it('DTE de producción sin sello en el JSON: toma el sello del PDF o queda con sello pendiente', async () => {
    const sinSello = (code: string) => {
      const j = JSON.parse(bankDte(code, { nit: '06142203131020', nrc: '2241857', nombre: 'SAC Multimoney, S.A.', codActividad: '64199' },
        [['INTERESES CREDITO', 368.17]], '2026-10-14'));
      delete j.selloRecibido;
      j.identificacion.ambiente = '01';
      return JSON.stringify(j);
    };
    const sello = '2026542068FC527D4DCBBF2FDF9C81866A0A988I';
    const pdf = await new Promise<Buffer>((resolve) => {
      const doc = new PDFDocument({ size: 'LETTER' });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.fontSize(9).text('COD. GENERADOR: BAF9FB7E-AE65-4895-94E3-33A2662FDF95', 40, 40).text(`SELLO RECEPCIÓN: ${sello}`, 40, 60);
      doc.end();
    });
    const res = await app.inject({ method: 'POST', url: '/v2/received/upload', headers: auth(t.token), payload: { files: [
      { name: 'mm.json', content: sinSello('BAF9FB7E-AE65-4895-94E3-33A2662FDF95') },
      { name: 'mm.pdf', content_base64: pdf.toString('base64') },
      { name: 'mm2.json', content: sinSello('3C44CABE-9D37-4A14-877E-B69490284F11') },
    ] } });
    const [conPdf, sinPdf] = res.json().results;
    expect(conPdf, res.body).toMatchObject({ status: 'registrado', warnings: expect.arrayContaining(['Sello de recepción tomado del PDF']) });
    const c1 = await compra(conPdf.compra_id);
    expect(c1.metadata).toMatchObject({ selloRecibido: sello, categoria: 'gasto_financiero' });
    expect(c1.metadata.selloPendiente).toBeUndefined();
    expect(sinPdf).toMatchObject({ status: 'registrado', detail: expect.stringMatching(/no trae sello/) });
    expect((await compra(sinPdf.compra_id)).metadata.selloPendiente).toBe(true);
  });

  it('receptor identificado como NIT (36) con los 9 dígitos del DUI: es la empresa', async () => {
    const j = JSON.parse(bankDte('C1C1C1C1-0000-4BB5-BBDD-C047A433B967',
      { nit: '06142711081020', nrc: '123456', nombre: 'Restaurante de Prueba, S.A. de C.V.', codActividad: '56101' }, [['Consumo', 103.13]], '2026-03-29'));
    j.receptor = { tipoDocumento: '36', numDocumento: DUI, nrc: null, nombre: 'MARIA PEREZ' };
    const res = await app.inject({ method: 'POST', url: '/v2/received/upload', headers: auth(t.token), payload: { files: [{ name: 'nit9.json', content: JSON.stringify(j) }] } });
    expect(res.json().results[0], res.body).toMatchObject({ status: 'registrado' });
  });
});
