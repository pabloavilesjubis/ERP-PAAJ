import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, buildApp, createTenant, hasDb, type TestTenant } from './helpers.js';

describe.skipIf(!hasDb)('usuarios por empresa y permisos', () => {
  let app: FastifyInstance;
  let a: TestTenant;
  let b: TestTenant;

  beforeAll(async () => {
    app = await buildApp();
    a = await createTenant();
    b = await createTenant();
  });
  afterAll(async () => { await app?.close(); });

  it('el admin crea a su contador y solo ve los usuarios de su empresa', async () => {
    const res = await app.inject({ method: 'POST', url: '/v2/users', headers: auth(a.token),
      payload: { email: `contador-${a.tenantId}@test.local`, full_name: 'Contadora', role: 'contador', password: 'supersecreta' } });
    expect(res.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/v2/users', headers: auth(a.token) });
    const emails = list.json().items.map((u: { email: string }) => u.email);
    expect(emails).toContain(`contador-${a.tenantId}@test.local`);
    const other = await app.inject({ method: 'GET', url: '/v2/users', headers: auth(b.token) });
    expect(other.json().items.map((u: { email: string }) => u.email)).not.toContain(`contador-${a.tenantId}@test.local`);
  });

  it('un cajero no puede gestionar usuarios', async () => {
    const cajero = await a.tokenFor('cajero');
    const res = await app.inject({ method: 'GET', url: '/v2/users', headers: auth(cajero) });
    expect(res.statusCode).toBe(403);
    const perms = await app.inject({ method: 'GET', url: '/v2/me/permissions', headers: auth(cajero) });
    expect(perms.json().permissions).not.toContain('accounting:view');
  });

  it('la empresa conserva al menos un administrador activo', async () => {
    const res = await app.inject({ method: 'PUT', url: `/v2/users/${a.userId}`, headers: auth(a.token), payload: { active: false } });
    expect(res.statusCode).toBe(400);
  });

  it('no se modifica un usuario de otra empresa', async () => {
    const res = await app.inject({ method: 'PUT', url: `/v2/users/${b.userId}`, headers: auth(a.token), payload: { role: 'viewer' } });
    expect(res.statusCode).toBe(400);
  });
});
