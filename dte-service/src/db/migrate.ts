import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { getPool, closePool } from './client.js';

/**
 * Runner de migraciones. Lee `db/migrations/*.sql` en orden alfabético y aplica
 * las que falten según la tabla `schema_migrations`.
 *
 *  - Las migraciones nuevas (005+) NO llevan BEGIN/COMMIT: el runner abre la
 *    transacción, ejecuta el archivo y registra la versión en la misma
 *    transacción. Si algo falla, no queda nada a medias.
 *  - Las legacy (001–004) traen su propio BEGIN/COMMIT y se registran solas;
 *    se ejecutan tal cual (en Supabase ya figuran como aplicadas por la 0009).
 *
 * Uso:
 *   npm run db:migrate            # aplica pendientes (dist)
 *   npm run db:migrate:dev        # idem con tsx
 *   MIGRATIONS_DIR=/ruta …        # directorio alternativo (tests)
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.resolve(__dirname, '../../db/migrations');

async function ensureMigrationsTable(db: pg.Pool | pg.PoolClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function listMigrationFiles(dir = DEFAULT_DIR): Promise<string[]> {
  const files = await readdir(dir);
  return files.filter(f => f.endsWith('.sql')).sort();
}

/** True si el archivo maneja su propia transacción (migraciones legacy 001–004). */
function selfManagedTx(sql: string): boolean {
  return /^\s*BEGIN\s*;/im.test(sql) && /^\s*COMMIT\s*;/im.test(sql);
}

export async function migrate(opts: { dir?: string; pool?: pg.Pool; log?: (m: string) => void } = {}): Promise<number> {
  const dir = opts.dir ?? process.env.MIGRATIONS_DIR ?? DEFAULT_DIR;
  const pool = opts.pool ?? getPool();
  // eslint-disable-next-line no-console
  const log = opts.log ?? ((m: string) => console.log(m));

  await ensureMigrationsTable(pool);
  const applied = new Set(
    (await pool.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map(r => r.version),
  );
  let count = 0;
  for (const f of await listMigrationFiles(dir)) {
    const version = f.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = await readFile(path.join(dir, f), 'utf-8');
    log(`[migrate] aplicando ${version}…`);
    const client = await pool.connect();
    try {
      if (selfManagedTx(sql)) {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING', [version]);
      } else {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
      }
      count++;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      log(`[migrate] FALLO en ${version}: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    } finally {
      client.release();
    }
  }
  log(`[migrate] OK — ${count} migración(es) aplicada(s), ${applied.size} previa(s)`);
  return count;
}

// Permite correr como script directo: `node dist/src/db/migrate.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => closePool())
    .catch(e => {
      // eslint-disable-next-line no-console
      console.error(e);
      process.exit(1);
    });
}
