import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, createTenant, db, hasDb, type TestTenant } from './helpers.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const CODIGO = '1A2B3C4D-0000-4000-8000-00000000ABCD';
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64');

describe.skipIf(!hasDb)('adjuntos de compras (PDF y JSON)', () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let compraId: number;
  beforeAll(async () => {
    // Módulos ERP + el listado de compras (vive en las rutas de entidades v2)
    const Fastify = (await import('fastify')).default;
    const { errorHandler } = await import('../../src/http/error-handler.js');
    const { registerErpModules } = await import('../../src/erp/index.js');
    const { registerV2EntityRoutes } = await import('../../src/v2/entity.routes.js');
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    registerV2EntityRoutes(app);
    await registerErpModules(app);
    await app.ready();
    t = await createTenant();
    const { query } = await db();
    compraId = Number((await query(`INSERT INTO compras (tenant_id, fecha, proveedor_nombre, total, metadata)
      VALUES ($1, '2026-10-30', 'Proveedor', 100, $2::jsonb) RETURNING id`, [t.tenantId, JSON.stringify({ numeroDocumento: CODIGO })])).rows[0]!.id);
  });
  afterAll(async () => { await app?.close(); });

  const put = (kind: string, body: object, token = t.token, id = compraId) =>
    app.inject({ method: 'PUT', url: `/v2/compras/${id}/adjuntos/${kind}`, headers: auth(token), payload: body });

  it('sube y descarga el PDF y el JSON; el listado de compras lo indica', async () => {
    expect((await put('pdf', { filename: 'factura.pdf', content_base64: b64(PDF) })).statusCode).toBe(200);
    const json = JSON.stringify({ identificacion: { codigoGeneracion: CODIGO.toLowerCase() }, emisor: { nombre: 'Proveedor Ñandú' } });
    const up = await put('json', { filename: 'dte.json', content_base64: b64(json) });
    expect(up.statusCode, up.body).toBe(200);

    const pdf = await app.inject({ method: 'GET', url: `/v2/compras/${compraId}/adjuntos/pdf`, headers: auth(t.token) });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.equals(PDF)).toBe(true);
    const js = await app.inject({ method: 'GET', url: `/v2/compras/${compraId}/adjuntos/json`, headers: auth(t.token) });
    expect(js.json().emisor.nombre).toBe('Proveedor Ñandú');

    const list = await app.inject({ method: 'GET', url: '/v2/compras', headers: auth(t.token) });
    const row = list.json().items.find((c: { id: string }) => Number(c.id) === compraId);
    expect(row.adjuntos).toEqual({ pdf: { filename: 'factura.pdf', size: PDF.length }, json: { filename: 'dte.json', size: Buffer.byteLength(json) } });
  });

  it('rechaza un PDF falso, un JSON inválido o el JSON de otro DTE', async () => {
    expect((await put('pdf', { filename: 'x.pdf', content_base64: b64('hola') })).json().message).toMatch(/no es un PDF/);
    expect((await put('json', { filename: 'x.json', content_base64: b64('{roto') })).json().message).toMatch(/JSON válido/);
    const otro = await put('json', { filename: 'x.json', content_base64: b64(JSON.stringify({ identificacion: { codigoGeneracion: 'FFFFFFFF-0000-4000-8000-000000000000' } })) });
    expect(otro.statusCode).toBe(400);
    expect(otro.json().message).toMatch(/no de esta compra/);
  });

  it('otra empresa no ve ni toca los adjuntos; un usuario de consulta no sube', async () => {
    const other = await createTenant();
    expect((await app.inject({ method: 'GET', url: `/v2/compras/${compraId}/adjuntos/pdf`, headers: auth(other.token) })).statusCode).toBe(404);
    expect((await put('pdf', { filename: 'x.pdf', content_base64: b64(PDF) }, other.token)).json().message).toMatch(/Compra no encontrada/);
    expect((await put('pdf', { filename: 'x.pdf', content_base64: b64(PDF) }, await t.tokenFor('viewer'))).statusCode).toBe(403);
  });

  it('se borran al quitarlos y con la compra', async () => {
    expect((await app.inject({ method: 'DELETE', url: `/v2/compras/${compraId}/adjuntos/json`, headers: auth(t.token) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/v2/compras/${compraId}/adjuntos/json`, headers: auth(t.token) })).statusCode).toBe(404);
    const { query } = await db();
    await query('DELETE FROM compras WHERE id = $1', [compraId]);
    expect((await query('SELECT count(*)::int n FROM compra_adjuntos WHERE compra_id = $1', [compraId])).rows[0]!.n).toBe(0);
  });
});
