import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { auth, buildApp, createTenant, db, hasDb, type TestTenant } from './helpers.js';
import { setupAccounting } from './accounting.helpers.js';

describe.skipIf(!hasDb)('consola de plataforma (tenants)', () => {
  let app: FastifyInstance;
  let erp: FastifyInstance;
  let owner: TestTenant;       // empresa del super-admin
  let adminToken: string;
  const ADMIN_EMAIL = 'plataforma@test.local';

  beforeAll(async () => {
    process.env.PLATFORM_ADMIN_EMAILS = ADMIN_EMAIL;
    const { errorHandler } = await import('../../src/http/error-handler.js');
    const { registerAdminRoutes } = await import('../../src/v2/admin.routes.js');
    const { issueJwt, hashPassword } = await import('../../src/auth/local-auth.js');
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    registerAdminRoutes(app);
    await app.ready();
    erp = await buildApp();
    owner = await createTenant();
    const { query } = await db();
    await query(`INSERT INTO users (id, email, password_hash, tenant_id, role, full_name) VALUES ('usr_platform', $1, $2, $3, 'admin', 'Plataforma')
                 ON CONFLICT (id) DO NOTHING`, [ADMIN_EMAIL, await hashPassword('clave-segura-1'), owner.tenantId]);
    adminToken = issueJwt({ userId: 'usr_platform', email: ADMIN_EMAIL, tenantId: owner.tenantId, role: 'admin' });
  });
  afterAll(async () => { await app?.close(); await erp?.close(); });

  it('solo el super-admin de plataforma entra', async () => {
    const other = await createTenant();
    expect((await app.inject({ method: 'GET', url: '/v2/admin/tenants', headers: auth(other.token) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v2/admin/tenants', headers: auth(adminToken) })).statusCode).toBe(200);
  });

  let tenantId: number;
  it('crea una empresa sin datos fiscales, la edita, le agrega datos fiscales y usuarios', async () => {
    const res = await app.inject({ method: 'POST', url: '/v2/admin/tenants', headers: auth(adminToken), payload: {
      tenant: { slug: 'acme-test', nombre_legal: 'ACME S.A. DE C.V.' }, admin: { email: 'admin@acme.test', password: 'clave-segura-1' } } });
    expect(res.statusCode, res.body).toBe(200);
    tenantId = Number(res.json().tenant_id);
    const upd = await app.inject({ method: 'PUT', url: `/v2/admin/tenants/${tenantId}`, headers: auth(adminToken), payload: { nombre_comercial: 'ACME', slug: 'acme' } });
    expect(upd.statusCode, upd.body).toBe(200);
    const emisor = { mh_env: 'sandbox', mh_nit: '06140101261099', emisor_nrc: '1234-5', emisor_nombre: 'ACME S.A. DE C.V.', emisor_cod_actividad: '46900',
      emisor_desc_actividad: 'Comercio', emisor_tipo_establecimiento: '02', emisor_departamento: '06', emisor_municipio: '14', emisor_complemento: 'San Salvador',
      emisor_telefono: '2222-0000', emisor_email: 'fe@acme.test', punto_venta_establecimiento: 'M001', punto_venta_punto: 'P001' };
    const noPw = await app.inject({ method: 'PUT', url: `/v2/admin/tenants/${tenantId}/emisor`, headers: auth(adminToken), payload: emisor });
    expect(noPw.statusCode).toBe(400);   // la primera vez exige las claves
    const ok = await app.inject({ method: 'PUT', url: `/v2/admin/tenants/${tenantId}/emisor`, headers: auth(adminToken), payload: { ...emisor, mh_password: 'x', firmador_password: 'y' } });
    expect(ok.statusCode, ok.body).toBe(200);
    const edit = await app.inject({ method: 'PUT', url: `/v2/admin/tenants/${tenantId}/emisor`, headers: auth(adminToken), payload: { ...emisor, emisor_telefono: '2222-2222' } });
    expect(edit.statusCode, edit.body).toBe(200);   // sin claves: conserva las anteriores
    const user = await app.inject({ method: 'POST', url: `/v2/admin/tenants/${tenantId}/users`, headers: auth(adminToken), payload: {
      email: 'contador@acme.test', role: 'contador', password: 'clave-segura-2', full_name: 'Contadora ACME' } });
    expect(user.statusCode, user.body).toBe(200);
    const detail = await app.inject({ method: 'GET', url: `/v2/admin/tenants/${tenantId}`, headers: auth(adminToken) });
    expect(detail.json().tenant.slug).toBe('acme');
    expect(detail.json().emisor.emisor_telefono).toBe('2222-2222');
    expect(detail.json().emisor).not.toHaveProperty('mh_password_enc');
    expect(detail.json().users).toHaveLength(2);
  });

  it('eliminar exige el slug y la contraseña; una empresa con configuración contable se elimina completa', async () => {
    // configuración: catálogo, roles y un borrador
    const { issueJwt } = await import('../../src/auth/local-auth.js');
    const tok = issueJwt({ userId: 'x', email: 'x@x', tenantId, role: 'admin' });
    const fake: TestTenant = { tenantId, userId: 'x', token: tok, tokenFor: async () => tok };
    const { query } = await db();
    await query(`INSERT INTO users (id, email, password_hash, tenant_id, role) VALUES ('x', 'x@acme.test', 'x', $1, 'admin')`, [tenantId]);
    await setupAccounting(erp, fake);
    const wrongSlug = await app.inject({ method: 'DELETE', url: `/v2/admin/tenants/${tenantId}`, headers: auth(adminToken), payload: { confirm_slug: 'otra', password: 'clave-segura-1' } });
    expect(wrongSlug.statusCode).toBe(400);
    const wrongPw = await app.inject({ method: 'DELETE', url: `/v2/admin/tenants/${tenantId}`, headers: auth(adminToken), payload: { confirm_slug: 'acme', password: 'mala' } });
    expect(wrongPw.statusCode).toBe(403);
    const del = await app.inject({ method: 'DELETE', url: `/v2/admin/tenants/${tenantId}`, headers: auth(adminToken), payload: { confirm_slug: 'acme', password: 'clave-segura-1' } });
    expect(del.statusCode, del.body).toBe(200);
    expect((await query('SELECT 1 FROM tenants WHERE id = $1', [tenantId])).rows).toHaveLength(0);
    expect((await query('SELECT 1 FROM accounting.accounts WHERE tenant_id = $1', [tenantId])).rows).toHaveLength(0);
  });

  it('una empresa con actividad no se elimina: se archiva', async () => {
    const t = await createTenant();
    const { query } = await db();
    await query(`INSERT INTO ventas (tenant_id, kind, fecha, descripcion, monto) VALUES ($1, 'consumidor', '2026-05-01', 'x', 10)`, [t.tenantId]);
    const slug = (await query<{ slug: string }>('SELECT slug FROM tenants WHERE id = $1', [t.tenantId])).rows[0]!.slug;
    const del = await app.inject({ method: 'DELETE', url: `/v2/admin/tenants/${t.tenantId}`, headers: auth(adminToken), payload: { confirm_slug: slug, password: 'clave-segura-1' } });
    expect(del.statusCode).toBe(409);
    const arch = await app.inject({ method: 'PUT', url: `/v2/admin/tenants/${t.tenantId}`, headers: auth(adminToken), payload: { status: 'archived' } });
    expect(arch.statusCode).toBe(200);
    // los usuarios de una empresa archivada pierden el acceso
    expect((await erp.inject({ method: 'GET', url: '/v2/me/permissions', headers: auth(t.token) })).statusCode).toBe(403);
  });
});
