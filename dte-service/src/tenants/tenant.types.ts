/**
 * Tipos canónicos para tenant + emisor + correlativos. Se exportan a otros
 * módulos como single source of truth. Los repos los retornan; los handlers
 * los consumen.
 */

export type TenantStatus = 'active' | 'suspended' | 'archived' | 'pending_onboarding';

export interface BrandConfig {
  logo_url?: string;
  color_primary?: string;
  color_accent?: string;
  font?: string;
  /** Texto libre para footer de tickets, leyendas, etc. */
  footer_text?: string;
}

export interface Tenant {
  id: number;
  slug: string;
  nombre_legal: string;
  nombre_comercial: string | null;
  status: TenantStatus;
  brand_config: BrandConfig;
  created_at: string;
  updated_at: string;
}

export type MhEnv = 'sandbox' | 'production' | 'mock';

/**
 * Vista decriptada (passwords en plano) — SOLO usar dentro del backend, nunca
 * exponer al frontend. El repo expone una versión "safe" sin secrets para
 * /me y /tenant/me.
 */
export interface TenantEmisorFull {
  tenant_id: number;
  mh_env: MhEnv;
  mh_nit: string;
  mh_password: string;                // decriptado en runtime
  firmador_password: string;          // decriptado en runtime
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

/** Vista pública (sin secrets) — segura de exponer al frontend autenticado. */
export type TenantEmisorPublic = Omit<TenantEmisorFull, 'mh_password' | 'firmador_password'>;

export type UserRole = 'admin' | 'cajero' | 'contador' | 'viewer';

export interface User {
  id: string;                          // UUID de Supabase Auth
  email: string;
  tenant_id: number;
  role: UserRole;
  full_name: string | null;
  created_at: string;
  last_login_at: string | null;
}

export interface CorrelativoRow {
  tenant_id: number;
  tipo_dte: '01' | '03' | '05' | '14';
  seeded: boolean;
  seeded_at: string | null;
  seeded_by: string | null;
  ultimo_consumido: number;
  reservados: number[];
  updated_at: string;
}
