import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from './client.js';

/**
 * Runner de migraciones sencillo. Lee `db/migrations/*.sql` en orden alfabético
 * y aplica las que falten según la tabla `schema_migrations`.
 *
 * Uso:
 *   npm run db:migrate        # aplica pending
 *   npm run db:migrate -- --reset  # peligroso: dropea todo
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

async function ensureMigrationsTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function appliedVersions(): Promise<Set<string>> {
  const res = await getPool().query<{ version: string }>('SELECT version FROM schema_migrations');
  return new Set(res.rows.map(r => r.version));
}

async function listMigrationFiles(): Promise<string[]> {
  const files = await readdir(MIGRATIONS_DIR);
  return files
    .filter(f => f.endsWith('.sql'))
    .sort();
}

export async function migrate(): Promise<void> {
  await ensureMigrationsTable();
  const applied = await appliedVersions();
  const files = await listMigrationFiles();
  let count = 0;
  for (const f of files) {
    const version = f.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, f), 'utf-8');
    // eslint-disable-next-line no-console
    console.log(`[migrate] aplicando ${version}…`);
    try {
      await getPool().query(sql);
      count++;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[migrate] FALLO en ${version}:`, e);
      throw e;
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[migrate] OK — ${count} migración(es) aplicada(s), ${applied.size} previa(s)`);
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
