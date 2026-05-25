import pg from 'pg';

/**
 * Cliente Postgres compartido. Pool con sane defaults: 10 conexiones, 30s
 * idle timeout. Lo importa cualquier módulo que necesite query.
 *
 * Convención fuerte de aislación multi-tenant:
 *   - JAMÁS escribir queries sin `WHERE tenant_id = $X`.
 *   - El middleware `requireTenant` inyecta `req.tenantId` en cada request
 *     autenticada. Los repos lo reciben como primer parámetro y lo binden.
 *   - Si en una segunda pasada hardenamos con RLS, esto sigue funcionando
 *     porque el WHERE explícito no estorba a las row policies.
 */

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL no configurado — Postgres requerido para PIPELINE ERP multi-tenant');
  }
  pool = new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', err => {
    // eslint-disable-next-line no-console
    console.error('[pg] error inesperado del pool', err);
  });
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}

/**
 * Ejecuta callback con `app.current_tenant_id` seteado en la sesión Postgres.
 * Cualquier query dentro del callback queda automáticamente filtrada por
 * tenant_id gracias a RLS (migration 003). Usar desde el middleware de
 * Fastify para que TODA query de la request sea tenant-safe.
 */
export async function withTenant<T>(
  tenantId: number,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query(`SET LOCAL app.current_tenant_id = $1`, [String(tenantId)]);
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Helper para queries dentro de una transacción. Útil para reservar correlativo
 * + emitir DTE en un solo commit (atomicidad real, no mutex in-process).
 */
export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
