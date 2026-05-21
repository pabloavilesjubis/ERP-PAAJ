import type { Config } from '../config.js';
import { MH_BASE } from '../config.js';
import { AuthError } from '../errors.js';
import { postJson } from './client.js';

interface AuthResponse {
  status?: string;
  body?: { token?: string };
  error?: { mensaje?: string };
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cached: CachedToken | null = null;

// El JWT del MH dura 24h. Cacheamos por 12h para tener margen ante drift de
// reloj y desincronización entre instancias en HA.
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

export async function getToken(cfg: Config, force = false): Promise<string> {
  if (!force && cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }
  const url = `${MH_BASE[cfg.MH_ENV]}/seguridad/auth`;
  const res = await postJson<AuthResponse>(
    url,
    { user: cfg.MH_NIT, pwd: cfg.MH_PASSWORD },
    { bodyKind: 'form' },
  );
  if (res.status !== 200 || res.body.status !== 'OK' || !res.body.body?.token) {
    throw new AuthError('Login a MH falló', {
      httpStatus: res.status,
      body: res.body,
    });
  }
  const raw = res.body.body.token;
  const token = raw.startsWith('Bearer ') ? raw : `Bearer ${raw}`;
  cached = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
  return token;
}

/** Limpia el cache — útil en tests y al recibir 401. */
export function clearTokenCache(): void {
  cached = null;
}
