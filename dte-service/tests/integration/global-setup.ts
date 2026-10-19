import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';

/**
 * Prepara la base de pruebas (TEST_DATABASE_URL) desde cero: borra todo,
 * carga el esquema base de producción (db/test/base_schema.sql) y aplica las
 * migraciones del runner. Sin TEST_DATABASE_URL los tests de integración se
 * saltan.
 *
 *   docker run -d --name erp-acct-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=erp_test \
 *     -p 127.0.0.1:55432:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/erp_test npm test
 */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    const schemas = await pool.query<{ nspname: string }>(`
      SELECT nspname FROM pg_namespace
       WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND nspname NOT LIKE 'pg_%'`);
    for (const s of schemas.rows) await pool.query(`DROP SCHEMA "${s.nspname}" CASCADE`);
    await pool.query('CREATE SCHEMA public');
    const base = await readFile(path.resolve(__dirname, '../../db/test/base_schema.sql'), 'utf-8');
    await pool.query(base);
    await migrate({ pool, log: () => undefined });
  } finally {
    await pool.end();
  }
}
