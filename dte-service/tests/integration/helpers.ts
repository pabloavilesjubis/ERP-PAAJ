import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { errorHandler } from '../../src/http/error-handler.js';
import { issueJwt } from '../../src/auth/local-auth.js';
import type { Role } from '../../src/auth/permissions.js';

/** Configura el entorno ANTES de importar módulos que abren el pool. */
export const hasDb = !!process.env.TEST_DATABASE_URL;
if (hasDb) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  delete process.env.PGPASSWORD;
  delete process.env.POSTGRES_PASSWORD;
}
process.env.AUTH_JWT_SECRET ??= 'test-secret-test-secret-test-secret';
process.env.TENANT_SECRETS_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.FIRMADOR_CERTS_DIR = mkdtempSync(path.join(tmpdir(), 'erp-certs-'));

export async function buildApp(): Promise<FastifyInstance> {
  const { registerErpModules } = await import('../../src/erp/index.js');
  const app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  await registerErpModules(app);
  await app.ready();
  return app;
}

export async function db() {
  return import('../../src/db/client.js');
}

export interface TestTenant { tenantId: number; userId: string; token: string; tokenFor: (role: Role) => Promise<string> }

/** Crea una empresa aislada con un usuario admin y devuelve su JWT. */
export async function createTenant(role: Role = 'admin'): Promise<TestTenant> {
  const { query } = await db();
  const slug = 't-' + randomBytes(5).toString('hex');
  const t = await query<{ id: number }>(
    `INSERT INTO tenants (slug, nombre_legal, status) VALUES ($1, $2, 'active') RETURNING id`, [slug, `Empresa ${slug}`]);
  const tenantId = Number(t.rows[0]!.id);
  const mk = async (r: Role) => {
    const userId = 'usr_' + randomBytes(8).toString('hex');
    const email = `${userId}@test.local`;
    await query(`INSERT INTO users (id, email, password_hash, tenant_id, role, full_name) VALUES ($1, $2, 'x', $3, $4, $5)`,
      [userId, email, tenantId, r, `Usuario ${r}`]);
    return { userId, token: issueJwt({ userId, email, tenantId, role: r }) };
  };
  const admin = await mk(role);
  return { tenantId, userId: admin.userId, token: admin.token, tokenFor: async (r) => (await mk(r)).token };
}

export function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}
