/**
 * Crea o resetea el password de un user admin.
 *
 * Uso (dentro del container):
 *   docker compose exec \
 *     -e ADMIN_EMAIL=tu@email.com \
 *     -e ADMIN_PASSWORD=tu_nuevo_password \
 *     -e ADMIN_TENANT_ID=1 \
 *     dte-service \
 *     npx tsx src/scripts/reset-admin-password.ts
 *
 * - Si el user no existe → lo crea con role=admin y tenant_id del env.
 * - Si existe → solo updatea password_hash (y tenant_id si está provisto).
 */

import 'dotenv/config';
import { closePool, query } from '../db/client.js';
import { hashPassword, newUserId } from '../auth/local-auth.js';

const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
const tenantId = process.env.ADMIN_TENANT_ID ? parseInt(process.env.ADMIN_TENANT_ID, 10) : 1;

function log(...a: unknown[]) { console.log('[reset-admin]', ...a); }

async function main() {
  if (!email || !password) {
    console.error('FALTAN: ADMIN_EMAIL y ADMIN_PASSWORD requeridos');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password debe tener mínimo 8 chars');
    process.exit(1);
  }

  const existing = await query<{ id: string; tenant_id: number | null }>(
    'SELECT id, tenant_id FROM users WHERE LOWER(email) = $1',
    [email.toLowerCase()],
  );

  const hash = await hashPassword(password);

  if (existing.rows.length > 0) {
    const cur = existing.rows[0]!;
    await query(
      'UPDATE users SET password_hash = $2, tenant_id = COALESCE(tenant_id, $3) WHERE id = $1',
      [cur.id, hash, tenantId],
    );
    log(`✓ password RESETEADO para ${email} (tenant_id=${cur.tenant_id ?? tenantId})`);
  } else {
    const id = newUserId();
    await query(`
      INSERT INTO users (id, email, password_hash, tenant_id, role, full_name)
      VALUES ($1, $2, $3, $4, 'admin', NULL)
    `, [id, email, hash, tenantId]);
    log(`✓ user CREADO: ${email} → tenant_id=${tenantId}, role=admin`);
  }

  log(`Listo. Ya podés loguear en el frontend con:`);
  log(`  email: ${email}`);
  log(`  password: (el que pasaste)`);
}

main().then(closePool).catch(e => { console.error(e); process.exit(1); });
