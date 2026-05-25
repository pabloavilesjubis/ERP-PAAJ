/**
 * Migración PAAJ (single-tenant legacy) → tenant_id=1 en Postgres.
 *
 * Lee:
 *   - process.env (las credenciales actuales del .env)
 *   - {STORAGE_DIR}/correlativos/{tipo}.json — el estado fiscal vigente
 *   - {STORAGE_DIR}/dtes/*.json (opcional, --import-dtes)
 *
 * Escribe:
 *   - tenants(id=1, slug='paaj', status='active', ...)
 *   - tenant_emisor(tenant_id=1, ...) — passwords ENCRIPTADOS
 *   - tenant_correlativos(tenant_id=1, tipo_dte=*) — estado actual preservado
 *   - dtes(tenant_id=1, ...) — solo con --import-dtes
 *
 * Idempotente. Re-correr es seguro (ON CONFLICT DO UPDATE en emisor; los
 * correlativos solo suben, nunca bajan).
 *
 * Uso:
 *   tsx src/scripts/migrate-paaj.ts                  # crea tenant + emisor + correlativos
 *   tsx src/scripts/migrate-paaj.ts --import-dtes    # +importa todos los DTEs históricos
 *   tsx src/scripts/migrate-paaj.ts --dry-run        # muestra qué haría, sin escribir
 */

import { readFile, readdir, copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { closePool, query, withTx } from '../db/client.js';
import { encryptSecret } from '../auth/crypto.js';
import { hashPassword, newUserId } from '../auth/local-auth.js';

interface CorrelativoFile {
  tipo_dte?: string;
  seeded?: boolean;
  ultimo?: number;           // schema v1 legacy
  ultimo_consumido?: number; // schema v2+
  reservados?: number[];
  updated_at?: string;
}

interface DteRecordFile {
  erp_invoice_id: string;
  beon_sale_id: string | null;
  origen?: 'POS' | 'BEON' | 'API';
  vendedor_nombre?: string | null;
  tipo_dte: '01' | '03' | '05' | '14';
  estado: 'EMITIDO' | 'RECHAZADO' | 'ANULADO';
  codigo_generacion: string;
  numero_control: string;
  sello_recibido: string | null;
  fh_procesamiento: string | null;
  fec_emi: string;
  hor_emi: string;
  ambiente: '00' | '01';
  receptor_correo: string | null;
  receptor_nombre: string | null;
  consecutivo: number;
  dte_json: Record<string, unknown>;
  documento_jws: string;
  mh_raw: Record<string, unknown>;
  anulacion?: Record<string, unknown>;
  erp_synced_at?: string | null;
  created_at: string;
  updated_at: string;
}

const PAAJ_TENANT_ID = 1;
const PAAJ_SLUG = 'paaj';

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');
const IMPORT_DTES = ARGS.includes('--import-dtes');

function log(...a: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log('[migrate-paaj]', ...a);
}

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Falta env ${k} — necesario para migrar PAAJ`);
  return v;
}

async function ensureTenant(): Promise<void> {
  const existing = await query<{ id: number }>('SELECT id FROM tenants WHERE id = $1', [PAAJ_TENANT_ID]);
  if (existing.rows.length > 0) {
    log(`tenant ${PAAJ_TENANT_ID} (${PAAJ_SLUG}) ya existe — skip insert`);
    return;
  }
  if (DRY_RUN) { log('DRY-RUN: crearía tenant id=1 slug=paaj status=active'); return; }
  await query(`
    INSERT INTO tenants (id, slug, nombre_legal, nombre_comercial, status, brand_config)
    VALUES ($1, $2, $3, $4, 'active', $5::JSONB)
  `, [
    PAAJ_TENANT_ID, PAAJ_SLUG,
    requireEnv('EMISOR_NOMBRE'),
    process.env.EMISOR_NOMBRE_COMERCIAL ?? null,
    JSON.stringify({ color_primary: '#10b981', color_accent: '#059669' }),
  ]);
  await query("SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), 1))");
  log(`✓ tenant id=${PAAJ_TENANT_ID} slug=${PAAJ_SLUG} creado`);
}

async function ensureEmisor(): Promise<void> {
  const certPath = `/app/certs/${requireEnv('MH_NIT')}.crt`;
  if (DRY_RUN) {
    log('DRY-RUN: upsert tenant_emisor con MH_NIT=', requireEnv('MH_NIT'), 'cert_path=', certPath);
    return;
  }
  await query(`
    INSERT INTO tenant_emisor (
      tenant_id, mh_env, mh_nit, mh_password_enc, firmador_password_enc, cert_path,
      emisor_nrc, emisor_nombre, emisor_cod_actividad, emisor_desc_actividad,
      emisor_tipo_establecimiento, emisor_departamento, emisor_municipio,
      emisor_complemento, emisor_telefono, emisor_email,
      punto_venta_establecimiento, punto_venta_punto,
      emisor_cod_estable_mh, emisor_cod_punto_venta_mh
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
    )
    ON CONFLICT (tenant_id) DO UPDATE SET
      mh_env = EXCLUDED.mh_env,
      mh_nit = EXCLUDED.mh_nit,
      mh_password_enc = EXCLUDED.mh_password_enc,
      firmador_password_enc = EXCLUDED.firmador_password_enc,
      cert_path = EXCLUDED.cert_path,
      emisor_nrc = EXCLUDED.emisor_nrc,
      emisor_nombre = EXCLUDED.emisor_nombre,
      emisor_cod_actividad = EXCLUDED.emisor_cod_actividad,
      emisor_desc_actividad = EXCLUDED.emisor_desc_actividad,
      emisor_tipo_establecimiento = EXCLUDED.emisor_tipo_establecimiento,
      emisor_departamento = EXCLUDED.emisor_departamento,
      emisor_municipio = EXCLUDED.emisor_municipio,
      emisor_complemento = EXCLUDED.emisor_complemento,
      emisor_telefono = EXCLUDED.emisor_telefono,
      emisor_email = EXCLUDED.emisor_email,
      punto_venta_establecimiento = EXCLUDED.punto_venta_establecimiento,
      punto_venta_punto = EXCLUDED.punto_venta_punto,
      emisor_cod_estable_mh = EXCLUDED.emisor_cod_estable_mh,
      emisor_cod_punto_venta_mh = EXCLUDED.emisor_cod_punto_venta_mh
  `, [
    PAAJ_TENANT_ID,
    process.env.MH_ENV ?? 'production',
    requireEnv('MH_NIT'),
    encryptSecret(requireEnv('MH_PASSWORD')),
    encryptSecret(requireEnv('FIRMADOR_PASSWORD')),
    certPath,
    requireEnv('EMISOR_NRC'),
    requireEnv('EMISOR_NOMBRE'),
    requireEnv('EMISOR_COD_ACTIVIDAD'),
    requireEnv('EMISOR_DESC_ACTIVIDAD'),
    requireEnv('EMISOR_TIPO_ESTABLECIMIENTO'),
    requireEnv('EMISOR_DEPARTAMENTO'),
    requireEnv('EMISOR_MUNICIPIO'),
    requireEnv('EMISOR_COMPLEMENTO'),
    process.env.EMISOR_TELEFONO ?? null,
    requireEnv('EMISOR_EMAIL'),
    requireEnv('PUNTO_VENTA_ESTABLECIMIENTO'),
    requireEnv('PUNTO_VENTA_PUNTO'),
    process.env.EMISOR_COD_ESTABLE_MH ?? null,
    process.env.EMISOR_COD_PUNTO_VENTA_MH ?? null,
  ]);
  log(`✓ tenant_emisor upserteado para tenant_id=${PAAJ_TENANT_ID}`);
}

async function ensureCertOnFilesystem(): Promise<void> {
  // Asegurar que el cert esté donde el firmador lo busca. Ya está en
  // ./firmador/temp/<NIT>.crt en el setup actual; este step solo verifica.
  const nit = requireEnv('MH_NIT');
  const srcDir = process.env.FIRMADOR_TEMP_DIR ?? '/home/pablo/projects/ERP-PAAJ/dte-service/firmador/temp';
  const src = path.join(srcDir, `${nit}.crt`);
  if (!existsSync(src)) {
    log(`⚠ cert ${src} no existe — el firmador no podrá firmar. Copiá manualmente el .crt antes de emitir.`);
    return;
  }
  log(`✓ cert encontrado en ${src} (montado read-only en /app/certs en el container)`);
}

async function migrateCorrelativos(): Promise<void> {
  const storageDir = process.env.STORAGE_DIR ?? '/app/data';
  const corrDir = path.join(storageDir, 'correlativos');
  if (!existsSync(corrDir)) {
    log(`directorio ${corrDir} no existe — no hay correlativos legacy que migrar`);
    return;
  }
  const files = (await readdir(corrDir)).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const raw = await readFile(path.join(corrDir, f), 'utf-8');
    const data = JSON.parse(raw) as CorrelativoFile;
    const tipoDte = (data.tipo_dte ?? f.replace('.json', '')) as '01' | '03' | '05' | '14';
    const ultimo = typeof data.ultimo_consumido === 'number'
      ? data.ultimo_consumido
      : typeof data.ultimo === 'number' ? data.ultimo : 0;
    const seeded = data.seeded ?? true;       // archivos legacy estaban en uso => seeded
    if (DRY_RUN) {
      log(`DRY-RUN: ${tipoDte} → ultimo=${ultimo} seeded=${seeded}`);
      continue;
    }
    await query(`
      INSERT INTO tenant_correlativos
        (tenant_id, tipo_dte, seeded, seeded_at, seeded_by, ultimo_consumido, reservados)
      VALUES ($1, $2, $3, $4, 'migrate-paaj', $5, ARRAY[]::BIGINT[])
      ON CONFLICT (tenant_id, tipo_dte) DO UPDATE SET
        seeded = EXCLUDED.seeded OR tenant_correlativos.seeded,
        seeded_at = COALESCE(tenant_correlativos.seeded_at, EXCLUDED.seeded_at),
        seeded_by = COALESCE(tenant_correlativos.seeded_by, EXCLUDED.seeded_by),
        ultimo_consumido = GREATEST(tenant_correlativos.ultimo_consumido, EXCLUDED.ultimo_consumido)
    `, [
      PAAJ_TENANT_ID, tipoDte, seeded,
      data.updated_at ?? new Date().toISOString(),
      ultimo,
    ]);
    log(`✓ correlativo ${tipoDte}: ultimo=${ultimo}, seeded=${seeded}`);
  }
}

async function importDtes(): Promise<void> {
  if (!IMPORT_DTES) {
    log('skip import de DTEs (pasá --import-dtes para incluir)');
    return;
  }
  const storageDir = process.env.STORAGE_DIR ?? '/app/data';
  const dtesDir = path.join(storageDir, 'dtes');
  if (!existsSync(dtesDir)) { log('no hay /dtes/ legacy'); return; }
  const files = (await readdir(dtesDir)).filter(f => f.endsWith('.json'));
  let added = 0, skipped = 0;
  for (const f of files) {
    const raw = await readFile(path.join(dtesDir, f), 'utf-8');
    const r = JSON.parse(raw) as DteRecordFile;
    if (DRY_RUN) {
      log(`DRY-RUN: importaría ${r.erp_invoice_id} (${r.numero_control})`);
      added++;
      continue;
    }
    try {
      await query(`
        INSERT INTO dtes (
          tenant_id, erp_invoice_id, beon_sale_id, origen, vendedor_nombre,
          tipo_dte, estado, codigo_generacion, numero_control, sello_recibido,
          fh_procesamiento, fec_emi, hor_emi, ambiente,
          receptor_correo, receptor_nombre, consecutivo,
          dte_json, documento_jws, mh_raw, anulacion, erp_synced_at,
          created_at, updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
          $18::JSONB,$19,$20::JSONB,$21::JSONB,$22,$23,$24
        )
        ON CONFLICT (tenant_id, codigo_generacion) DO NOTHING
      `, [
        PAAJ_TENANT_ID, r.erp_invoice_id, r.beon_sale_id,
        r.origen ?? 'BEON', r.vendedor_nombre ?? null,
        r.tipo_dte, r.estado, r.codigo_generacion, r.numero_control,
        r.sello_recibido, r.fh_procesamiento, r.fec_emi, r.hor_emi, r.ambiente,
        r.receptor_correo, r.receptor_nombre, r.consecutivo,
        JSON.stringify(r.dte_json), r.documento_jws,
        JSON.stringify(r.mh_raw),
        r.anulacion ? JSON.stringify(r.anulacion) : null,
        r.erp_synced_at ?? null,
        r.created_at, r.updated_at,
      ]);
      added++;
    } catch (e) {
      skipped++;
      log(`✗ skip ${r.erp_invoice_id}: ${e instanceof Error ? e.message : e}`);
    }
  }
  log(`✓ DTEs importados: ${added} (skipped ${skipped})`);
}

async function ensureAdminUser(): Promise<void> {
  const adminEmail = process.env.PAAJ_ADMIN_EMAIL ?? process.env.EMISOR_EMAIL;
  const adminPassword = process.env.PAAJ_ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    log('⚠ PAAJ_ADMIN_EMAIL / PAAJ_ADMIN_PASSWORD no seteados — skip creación de user admin');
    log('   Para crear ahora: PAAJ_ADMIN_EMAIL=tu@email PAAJ_ADMIN_PASSWORD=xxxxxxxx npm run paaj:migrate');
    return;
  }
  const existing = await query<{ id: string }>('SELECT id FROM users WHERE LOWER(email) = $1', [adminEmail.toLowerCase()]);
  if (existing.rows.length > 0) {
    log(`✓ user admin ${adminEmail} ya existe`);
    return;
  }
  if (DRY_RUN) {
    log(`DRY-RUN: crearía user admin ${adminEmail} con tenant_id=${PAAJ_TENANT_ID}`);
    return;
  }
  const userId = newUserId();
  const hash = await hashPassword(adminPassword);
  await query(`
    INSERT INTO users (id, email, password_hash, tenant_id, role, full_name)
    VALUES ($1, $2, $3, $4, 'admin', $5)
  `, [userId, adminEmail, hash, PAAJ_TENANT_ID, requireEnv('EMISOR_NOMBRE')]);
  log(`✓ user admin creado: ${adminEmail} → tenant_id=${PAAJ_TENANT_ID}`);
}

async function main(): Promise<void> {
  log(DRY_RUN ? '=== DRY RUN ===' : '=== EJECUTANDO ===');
  await ensureTenant();
  await ensureEmisor();
  await ensureCertOnFilesystem();
  await migrateCorrelativos();
  await ensureAdminUser();
  await importDtes();
  log('migración PAAJ completada');
}

main()
  .then(() => closePool())
  .catch(e => {
    // eslint-disable-next-line no-console
    console.error('[migrate-paaj] FATAL:', e);
    process.exit(1);
  });
