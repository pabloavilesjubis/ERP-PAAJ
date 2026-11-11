import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, buildApp, createTenant, db, hasDb, type TestTenant } from './helpers.js';

const cuenta = (username: string, extra: object = {}) => ({ label: 'Compras', host: 'imap.gmail.com', port: 993, username, folder: 'INBOX', enabled: true, ...extra });

describe.skipIf(!hasDb)('varias cuentas de correo por empresa', () => {
  let app: FastifyInstance;
  let t: TestTenant;
  beforeAll(async () => { app = await buildApp(); t = await createTenant(); });
  afterAll(async () => { await app?.close(); });

  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, token = t.token) =>
    app.inject({ method, url, headers: auth(token), ...(payload ? { payload } : {}) });

  it('agrega dos cuentas, rechaza la repetida y edita sin cambiar la contraseña', async () => {
    expect((await call('POST', '/v2/received-mailboxes', cuenta('uno@gmail.com'))).json().message).toMatch(/contraseña/);
    const a = await call('POST', '/v2/received-mailboxes', cuenta('uno@gmail.com', { password: 'app-1' }));
    const b = await call('POST', '/v2/received-mailboxes', cuenta('dos@empresa.com', { host: 'outlook.office365.com', password: 'app-2' }));
    expect(a.statusCode, a.body).toBe(200);
    expect(b.statusCode, b.body).toBe(200);
    expect((await call('POST', '/v2/received-mailboxes', cuenta('UNO@gmail.com', { password: 'x' }))).json().message).toMatch(/ya está agregada/);

    const id = a.json().id;
    const { query } = await db();
    const before = (await query('SELECT password_enc FROM accounting.mailboxes WHERE id = $1', [id])).rows[0]!.password_enc;
    expect((await call('PUT', `/v2/received-mailboxes/${id}`, cuenta('uno@gmail.com', { label: 'Personal', enabled: false }))).statusCode).toBe(200);
    const after = (await query('SELECT label, enabled, password_enc FROM accounting.mailboxes WHERE id = $1', [id])).rows[0]!;
    expect(after).toMatchObject({ label: 'Personal', enabled: false, password_enc: before });

    const list = (await call('GET', '/v2/received-mailboxes')).json().items;
    expect(list.map((m: { username: string }) => m.username)).toEqual(['uno@gmail.com', 'dos@empresa.com']);
    expect(list[0]).not.toHaveProperty('password_enc');
  });

  it('otra empresa no ve ni revisa las cuentas; los meses se validan; se elimina', async () => {
    const id = (await call('GET', '/v2/received-mailboxes')).json().items[0].id;
    const other = await createTenant();
    expect((await call('GET', '/v2/received-mailboxes', undefined, other.token)).json().items).toEqual([]);
    expect((await call('POST', `/v2/received-mailboxes/${id}/run`, {}, other.token)).json().message).toMatch(/no existe/);
    expect((await call('POST', `/v2/received-mailboxes/${id}/run`, { from: '2026-03', to: '2026-01' })).json().message).toMatch(/anterior al inicial/);
    expect((await call('POST', `/v2/received-mailboxes/${id}/run`, { from: '2026-13' })).statusCode).toBe(400);
    // Sin datos fiscales no lee el correo (no intenta conectarse)
    const run = (await call('POST', `/v2/received-mailboxes/${id}/run`, { from: '2026-01', to: '2026-03' })).json();
    expect(run).toMatchObject({ status: 'error', detail: expect.stringMatching(/datos fiscales/) });
    expect((await call('DELETE', `/v2/received-mailboxes/${id}`)).statusCode).toBe(200);
    expect((await call('GET', '/v2/received-mailboxes')).json().items).toHaveLength(1);
  });
});
