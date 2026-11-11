import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, createTenant, db, hasDb, type TestTenant } from './helpers.js';

// La empresa de las rutas originales emite con la configuración del servidor (.env)
describe.skipIf(!hasDb)('Mi empresa: cargar los datos fiscales desde la configuración del servidor', () => {
  let app: FastifyInstance;
  let paaj: TestTenant;
  let otra: TestTenant;
  beforeAll(async () => {
    paaj = await createTenant();
    otra = await createTenant();
    Object.assign(process.env, {
      BEON_TENANT_ID: String(paaj.tenantId), MH_ENV: 'production', MH_NIT: '06149999990033', MH_PASSWORD: 'clave-api', FIRMADOR_PASSWORD: 'clave-cert',
      EMISOR_NRC: '3386242', EMISOR_NOMBRE: 'PERSONA NATURAL DE PRUEBA', EMISOR_COD_ACTIVIDAD: '70200', EMISOR_DESC_ACTIVIDAD: 'Consultoría',
      EMISOR_TIPO_ESTABLECIMIENTO: '02', EMISOR_DEPARTAMENTO: '06', EMISOR_MUNICIPIO: '14', EMISOR_COMPLEMENTO: 'Colonia Escalón',
      EMISOR_TELEFONO: '22223333', EMISOR_EMAIL: 'fe@test.sv', PUNTO_VENTA_ESTABLECIMIENTO: 'M001', PUNTO_VENTA_PUNTO: 'P000',
    });
    const { buildApp } = await import('./helpers.js');
    app = await buildApp();
  });
  afterAll(async () => { await app?.close(); });

  it('solo esa empresa lo ve y lo usa; copia los datos, cifra las claves y conserva el DUI', async () => {
    expect((await app.inject({ method: 'GET', url: '/v2/company', headers: auth(otra.token) })).json().server_config).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/v2/company/import-server-config', headers: auth(otra.token), payload: {} })).statusCode).toBe(400);

    const { query } = await db();
    await query(`INSERT INTO tenant_emisor (tenant_id, mh_env, mh_nit, cert_path, emisor_nrc, emisor_nombre, emisor_cod_actividad, emisor_desc_actividad,
      emisor_tipo_establecimiento, emisor_departamento, emisor_municipio, emisor_complemento, emisor_email, punto_venta_establecimiento, punto_venta_punto, emisor_dui)
      VALUES ($1, 'sandbox', '06149999990033', 'x', '1', 'x', '1', 'x', '01', '06', '14', 'x', 'x@x.test', 'M001', 'P001', '012345678')`, [paaj.tenantId]);
    expect((await app.inject({ method: 'GET', url: '/v2/company', headers: auth(paaj.token) })).json().server_config).toBe(true);
    const res = await app.inject({ method: 'POST', url: '/v2/company/import-server-config', headers: auth(paaj.token), payload: {} });
    expect(res.statusCode, res.body).toBe(200);
    const e = (await app.inject({ method: 'GET', url: '/v2/company', headers: auth(paaj.token) })).json();
    expect(e.emisor).toMatchObject({ mh_env: 'production', emisor_nrc: '3386242', emisor_nombre: 'PERSONA NATURAL DE PRUEBA', punto_venta_punto: 'P000',
      emisor_dui: '012345678', has_mh_password: true, has_firmador_password: true });
    const raw = (await query('SELECT mh_password_enc FROM tenant_emisor WHERE tenant_id = $1', [paaj.tenantId])).rows[0]!.mh_password_enc;
    expect(raw).not.toContain('clave-api');
  });
});
