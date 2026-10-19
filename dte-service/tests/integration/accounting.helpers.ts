import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { auth, type TestTenant } from './helpers.js';
import { CATALOG_ROWS, ROLE_CODES } from './fixtures/catalog.js';

/** Importa el catálogo de prueba, asigna todos los roles y devuelve code → id. */
export async function setupAccounting(app: FastifyInstance, t: TestTenant): Promise<Map<string, number>> {
  const imp = await app.inject({ method: 'POST', url: '/v2/acc/accounts/import', headers: auth(t.token), payload: { rows: CATALOG_ROWS } });
  expect(imp.statusCode, imp.body).toBe(200);
  const ids = await accountIds(app, t);
  const assignments: Record<string, number> = {};
  for (const [role, code] of Object.entries(ROLE_CODES)) assignments[role] = ids.get(code)!;
  const roles = await app.inject({ method: 'PUT', url: '/v2/acc/roles', headers: auth(t.token), payload: { assignments } });
  expect(roles.statusCode, roles.body).toBe(200);
  return ids;
}

export async function accountIds(app: FastifyInstance, t: TestTenant): Promise<Map<string, number>> {
  const res = await app.inject({ method: 'GET', url: '/v2/acc/accounts', headers: auth(t.token) });
  return new Map(res.json().items.map((a: { code: string; id: string }) => [a.code, Number(a.id)]));
}

/** Saldo deudor neto (debe − haber) por código al cierre de un rango. */
export async function balances(app: FastifyInstance, t: TestTenant, from = '2000-01-01', to = '2100-12-31'): Promise<Map<string, number>> {
  const ids = await accountIds(app, t);
  const byId = new Map([...ids].map(([code, id]) => [id, code]));
  const res = await app.inject({ method: 'GET', url: `/v2/acc/reports/movements?from=${from}&to=${to}`, headers: auth(t.token) });
  const out = new Map<string, number>();
  for (const m of res.json().items as Array<{ account_id: string; debit_before: number; credit_before: number; debit: number; credit: number }>) {
    out.set(byId.get(Number(m.account_id))!, Math.round((m.debit_before - m.credit_before + m.debit - m.credit) * 100) / 100);
  }
  return out;
}
