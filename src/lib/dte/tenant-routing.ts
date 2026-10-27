import { env } from '@/config/env';

/**
 * ¿Por qué rutas del dte-service emite la empresa de la sesión?
 *
 * Las rutas sin prefijo (/emit, /annul, /correlativos/*) son las del modo
 * single-tenant original: firman con la configuración global del servidor y
 * usan los correlativos del tenant 1 (PAAJ, BEON_TENANT_ID). Cualquier otra
 * empresa debe ir por /v2/*, que con el JWT resuelve su propio NIT,
 * certificado y correlativos. PAAJ sigue por las rutas originales porque ahí
 * vive su historial de DTEs.
 */
export const LEGACY_DTE_TENANT_ID = 1;

interface StoredAuth { access_token?: string; user?: { tenant_id?: number | null } }

function stored(): StoredAuth | null {
  try {
    const raw = localStorage.getItem('pipeline-auth');
    return raw ? JSON.parse(raw) as StoredAuth : null;
  } catch {
    return null;
  }
}

export function usesTenantDteApi(): boolean {
  const tenantId = stored()?.user?.tenant_id;
  return env.adapter === 'api' && tenantId != null && Number(tenantId) !== LEGACY_DTE_TENANT_ID;
}

export function dteAuthHeaders(): Record<string, string> {
  const token = stored()?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
