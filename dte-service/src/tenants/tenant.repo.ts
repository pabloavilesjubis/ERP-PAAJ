import { query } from '../db/client.js';
import { decryptSecret, encryptSecret } from '../auth/crypto.js';
import type {
  Tenant, TenantEmisorFull, TenantEmisorPublic, BrandConfig,
} from './tenant.types.js';

/**
 * Repo CRUD para tenants. Toda lectura de emisor pasa por acá — encriptación
 * de passwords en el INSERT/UPDATE, decriptación en el SELECT.
 */

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const res = await query<Tenant>(`
    SELECT id, slug, nombre_legal, nombre_comercial, status, brand_config,
           created_at, updated_at
      FROM tenants
     WHERE slug = $1
  `, [slug]);
  return res.rows[0] ?? null;
}

export async function getTenantById(id: number): Promise<Tenant | null> {
  const res = await query<Tenant>(`
    SELECT id, slug, nombre_legal, nombre_comercial, status, brand_config,
           created_at, updated_at
      FROM tenants
     WHERE id = $1
  `, [id]);
  return res.rows[0] ?? null;
}

export async function createTenant(input: {
  slug: string;
  nombre_legal: string;
  nombre_comercial?: string | null;
  brand_config?: BrandConfig;
}): Promise<Tenant> {
  const res = await query<Tenant>(`
    INSERT INTO tenants (slug, nombre_legal, nombre_comercial, status, brand_config)
    VALUES ($1, $2, $3, 'pending_onboarding', $4::JSONB)
    RETURNING id, slug, nombre_legal, nombre_comercial, status, brand_config,
              created_at, updated_at
  `, [
    input.slug,
    input.nombre_legal,
    input.nombre_comercial ?? null,
    JSON.stringify(input.brand_config ?? {}),
  ]);
  return res.rows[0]!;
}

export async function updateBrandConfig(tenantId: number, brand: BrandConfig): Promise<void> {
  await query(
    'UPDATE tenants SET brand_config = $1::JSONB WHERE id = $2',
    [JSON.stringify(brand), tenantId],
  );
}

export async function activateTenant(tenantId: number): Promise<void> {
  await query("UPDATE tenants SET status = 'active' WHERE id = $1", [tenantId]);
}

// ── Emisor ─────────────────────────────────────────────────────────────────

interface TenantEmisorRow {
  tenant_id: number;
  mh_env: TenantEmisorFull['mh_env'];
  mh_nit: string;
  mh_password_enc: string;
  firmador_password_enc: string;
  cert_path: string;
  emisor_nrc: string;
  emisor_nombre: string;
  emisor_cod_actividad: string;
  emisor_desc_actividad: string;
  emisor_tipo_establecimiento: string;
  emisor_departamento: string;
  emisor_municipio: string;
  emisor_complemento: string;
  emisor_telefono: string | null;
  emisor_email: string;
  punto_venta_establecimiento: string;
  punto_venta_punto: string;
  emisor_cod_estable_mh: string | null;
  emisor_cod_punto_venta_mh: string | null;
}

export async function getEmisor(tenantId: number): Promise<TenantEmisorFull | null> {
  const res = await query<TenantEmisorRow>(
    'SELECT * FROM tenant_emisor WHERE tenant_id = $1',
    [tenantId],
  );
  const row = res.rows[0];
  if (!row) return null;
  const { mh_password_enc, firmador_password_enc, ...rest } = row;
  return {
    ...rest,
    mh_password: decryptSecret(mh_password_enc),
    firmador_password: decryptSecret(firmador_password_enc),
  };
}

export async function getEmisorPublic(tenantId: number): Promise<TenantEmisorPublic | null> {
  const full = await getEmisor(tenantId);
  if (!full) return null;
  const { mh_password: _mh, firmador_password: _fp, ...safe } = full;
  void _mh; void _fp;
  return safe;
}

export interface CreateEmisorInput {
  tenant_id: number;
  mh_env: TenantEmisorFull['mh_env'];
  mh_nit: string;
  mh_password: string;             // plain — se encripta al INSERT
  firmador_password: string;       // plain — se encripta al INSERT
  cert_path: string;
  emisor_nrc: string;
  emisor_nombre: string;
  emisor_cod_actividad: string;
  emisor_desc_actividad: string;
  emisor_tipo_establecimiento: string;
  emisor_departamento: string;
  emisor_municipio: string;
  emisor_complemento: string;
  emisor_telefono?: string | null;
  emisor_email: string;
  punto_venta_establecimiento: string;
  punto_venta_punto: string;
  emisor_cod_estable_mh?: string | null;
  emisor_cod_punto_venta_mh?: string | null;
}

export async function upsertEmisor(input: CreateEmisorInput): Promise<void> {
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
    input.tenant_id, input.mh_env, input.mh_nit,
    encryptSecret(input.mh_password),
    encryptSecret(input.firmador_password),
    input.cert_path,
    input.emisor_nrc, input.emisor_nombre,
    input.emisor_cod_actividad, input.emisor_desc_actividad,
    input.emisor_tipo_establecimiento, input.emisor_departamento, input.emisor_municipio,
    input.emisor_complemento, input.emisor_telefono ?? null, input.emisor_email,
    input.punto_venta_establecimiento, input.punto_venta_punto,
    input.emisor_cod_estable_mh ?? null, input.emisor_cod_punto_venta_mh ?? null,
  ]);
}
