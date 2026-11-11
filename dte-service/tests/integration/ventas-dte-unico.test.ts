import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { auth, createTenant, db, hasDb, type TestTenant } from './helpers.js';

const venta = (codigo: string | null) => ({
  kind: 'consumidor', fecha: '2026-10-05', descripcion: 'Venta', monto: '35.00',
  metadata: codigo ? { source: 'pos', tipoDocumento: '01', codigoGeneracion: codigo, numeroControl: 'DTE-01-M001P000-000000000000362' } : { source: 'manual' },
});

describe.skipIf(!hasDb)('una venta por DTE', () => {
  let app: FastifyInstance;
  let t: TestTenant;
  beforeAll(async () => {
    const { errorHandler } = await import('../../src/http/error-handler.js');
    const { registerV2EntityRoutes } = await import('../../src/v2/entity.routes.js');
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    registerV2EntityRoutes(app);
    await app.ready();
    t = await createTenant();
  });
  afterAll(async () => { await app?.close(); });

  const post = (body: object, token = t.token) => app.inject({ method: 'POST', url: '/v2/ventas', headers: auth(token), payload: body });

  it('la segunda inserción del mismo DTE devuelve la venta existente', async () => {
    const a = await post(venta('aaaaaaaa-0000-4000-8000-000000000001'));
    const b = await post(venta('AAAAAAAA-0000-4000-8000-000000000001'));
    expect(a.statusCode, a.body).toBe(200);
    expect(b.json()).toEqual({ id: a.json().id, existing: true });
    const { query } = await db();
    expect((await query("SELECT count(*)::int n FROM ventas WHERE tenant_id = $1", [t.tenantId])).rows[0]!.n).toBe(1);
  });

  it('las ventas manuales sin DTE no se limitan, y otra empresa puede tener el mismo código', async () => {
    expect((await post(venta(null))).json().existing).toBeUndefined();
    expect((await post(venta(null))).json().existing).toBeUndefined();
    const other = await createTenant();
    expect((await post(venta('aaaaaaaa-0000-4000-8000-000000000001'), other.token)).json().existing).toBeUndefined();
  });
});
