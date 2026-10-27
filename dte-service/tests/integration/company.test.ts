import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, buildApp, createTenant, hasDb, type TestTenant } from './helpers.js';

const EMISOR = {
  mh_env: 'sandbox', mh_nit: '0614-010126-109-8', emisor_nrc: '1234-5', emisor_nombre: 'MI EMPRESA S.A. DE C.V.', emisor_cod_actividad: '46900',
  emisor_desc_actividad: 'Comercio', emisor_tipo_establecimiento: '02', emisor_departamento: '06', emisor_municipio: '14',
  emisor_complemento: 'San Salvador', emisor_telefono: '2222-0000', emisor_email: 'fe@miempresa.test', punto_venta_establecimiento: 'm001', punto_venta_punto: 'P001',
};
const CERT = Buffer.from(`<CertificadoMH><nit>06140101261098</nit><publicKey>${'A'.repeat(200)}</publicKey></CertificadoMH>`).toString('base64');

describe.skipIf(!hasDb)('Mi empresa (/v2/company)', () => {
  let app: FastifyInstance;
  let t: TestTenant;
  beforeAll(async () => { app = await buildApp(); t = await createTenant(); });
  afterAll(async () => { await app?.close(); });

  it('el admin carga datos generales, fiscales, certificado y correlativos', async () => {
    const empty = await app.inject({ method: 'GET', url: '/v2/company', headers: auth(t.token) });
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json().emisor).toBeNull();
    expect(empty.json().checklist).toMatchObject({ general: true, fiscal: false, cert: false });

    const gen = await app.inject({ method: 'PUT', url: '/v2/company', headers: auth(t.token), payload: { nombre_legal: 'MI EMPRESA S.A. DE C.V.', nombre_comercial: 'Mi Empresa' } });
    expect(gen.statusCode, gen.body).toBe(200);

    // el certificado se asocia al NIT: primero los datos fiscales
    expect((await app.inject({ method: 'POST', url: '/v2/company/cert', headers: auth(t.token), payload: { cert_base64: CERT } })).statusCode).toBe(400);

    const noPw = await app.inject({ method: 'PUT', url: '/v2/company/emisor', headers: auth(t.token), payload: EMISOR });
    expect(noPw.statusCode).toBe(400);
    expect(noPw.json().message).toMatch(/clave/i);
    const ok = await app.inject({ method: 'PUT', url: '/v2/company/emisor', headers: auth(t.token), payload: { ...EMISOR, mh_password: 'api', firmador_password: 'firma' } });
    expect(ok.statusCode, ok.body).toBe(200);
    const again = await app.inject({ method: 'PUT', url: '/v2/company/emisor', headers: auth(t.token), payload: { ...EMISOR, emisor_telefono: '2222-2222' } });
    expect(again.statusCode, again.body).toBe(200);

    const cert = await app.inject({ method: 'POST', url: '/v2/company/cert', headers: auth(t.token), payload: { cert_base64: CERT } });
    expect(cert.statusCode, cert.body).toBe(200);
    const file = path.join(process.env.FIRMADOR_CERTS_DIR!, '06140101261098.crt');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('<CertificadoMH>');
    const bad = await app.inject({ method: 'POST', url: '/v2/company/cert', headers: auth(t.token), payload: { cert_base64: Buffer.from('hola').toString('base64') } });
    expect(bad.statusCode).toBe(400);

    const corr = await app.inject({ method: 'POST', url: '/v2/company/correlativos', headers: auth(t.token), payload: { items: [{ tipo_dte: '01', ultimo_consumido: 120 }] } });
    expect(corr.statusCode, corr.body).toBe(200);

    const full = (await app.inject({ method: 'GET', url: '/v2/company', headers: auth(t.token) })).json();
    expect(full.tenant.nombre_comercial).toBe('Mi Empresa');
    expect(full.emisor).toMatchObject({ mh_nit: '06140101261098', punto_venta_establecimiento: 'M001', emisor_telefono: '2222-2222',
      has_mh_password: true, has_firmador_password: true });
    expect(full.emisor).not.toHaveProperty('mh_password_enc');
    expect(full.checklist).toEqual({ general: true, fiscal: true, credentials: true, cert: true, correlativos: true });
    expect(full.correlativos).toContainEqual({ tipo_dte: '01', seeded: true, ultimo_consumido: 120 });
  });

  it('el NIT no se puede repetir entre empresas', async () => {
    const other = await createTenant();
    const res = await app.inject({ method: 'PUT', url: '/v2/company/emisor', headers: auth(other.token), payload: { ...EMISOR, mh_password: 'a', firmador_password: 'b' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/otra empresa/);
  });

  it('el contador consulta pero no cambia; otros roles no entran', async () => {
    const contador = await t.tokenFor('contador');
    expect((await app.inject({ method: 'GET', url: '/v2/company', headers: auth(contador) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/v2/company', headers: auth(contador), payload: { nombre_legal: 'X S.A.' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v2/company/test-mh', headers: auth(contador), payload: {} })).statusCode).toBe(403);
    const cajero = await t.tokenFor('cajero');
    expect((await app.inject({ method: 'GET', url: '/v2/company', headers: auth(cajero) })).statusCode).toBe(403);
  });
});
