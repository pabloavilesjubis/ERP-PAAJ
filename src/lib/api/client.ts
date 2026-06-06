import { env } from '@/config/env';

/**
 * Lee el JWT del storage de useAuth.ts. Síncrono, sin async ni SDK externo.
 */
function getStoredToken(): string | null {
  try {
    const raw = localStorage.getItem('pipeline-auth');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { access_token?: string };
    return parsed.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * Cliente HTTP autenticado para el dte-service multi-tenant.
 * - Inyecta `Authorization: Bearer <jwt>` automáticamente desde la sesión Supabase.
 * - Refresca el token si está cerca de expirar (Supabase SDK lo hace por nosotros).
 * - 401 → fuerza signOut (sesión expirada irrecuperable).
 *
 * Todas las rutas multi-tenant están bajo `/v2/...`. El tenant se deriva del
 * JWT — no necesitamos mandar `tenant_id` en el body.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly details: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function getAuthHeaders(): Record<string, string> {
  const token = getStoredToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${env.dteServiceUrl.replace(/\/$/, '')}${path}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...getAuthHeaders(),
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    localStorage.removeItem('pipeline-auth');
    window.dispatchEvent(new CustomEvent('pipeline-auth-changed'));
    throw new ApiError('Sesión expirada', 401, 'AUTH_EXPIRED', null);
  }

  const text = await res.text();
  const parsed = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = parsed as { code?: string; message?: string; details?: unknown } | null;
    throw new ApiError(
      err?.message ?? `HTTP ${res.status}`,
      res.status,
      err?.code ?? 'UNKNOWN',
      err?.details,
    );
  }
  return parsed as T;
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

/** Endpoints específicos del API v2 */
export const v2 = {
  me: () => api.get<{ user: { userId: string; email?: string; role: string }; tenant_id: number; tenant_slug: string }>('/v2/me'),
  emit: (body: { tipo: 'fcf' | 'ccf' | 'nc' | 'fse'; data: Record<string, unknown> }) =>
    api.post<{ success: boolean; codigoGeneracion: string; numeroControl: string; consecutivo: number; selloRecibido: string | null }>('/v2/dte/emit', body),
  listDtes: (opts: { since?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.since) q.set('since', opts.since);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return api.get<{ count: number; items: unknown[] }>(`/v2/dte/listar${qs ? `?${qs}` : ''}`);
  },
  correlativos: {
    list: () => api.get<{ items: Array<{ tipo_dte: string; seeded: boolean; ultimo_consumido: number; reservados: number[] }> }>('/v2/correlativos/listar'),
    sembrar: (items: Array<{ tipo_dte: string; ultimo_consumido: number }>) =>
      api.post<{ resultados: unknown[] }>('/v2/correlativos/sembrar', { items }),
  },
  /** Guarda branding del tenant (título del sidebar + logo). Vacío/null = quitar. */
  updateBrand: (body: {
    title?: string | null;
    logo_url?: string | null;
    color_primary?: string;
    color_accent?: string;
    footer_text?: string | null;
  }) => api.put<{ success: boolean; brand_config: Record<string, unknown> }>('/v2/me/brand', body),
};
