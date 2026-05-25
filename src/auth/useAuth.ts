import { useEffect, useState } from 'react';
import { env } from '@/config/env';

/**
 * Auth local — sin Supabase. Persiste el JWT en localStorage y lo expone
 * para que cualquier componente reaccione a login/logout/refresh.
 *
 * Endpoints backend:
 *   POST /v2/auth/signup   { email, password, full_name? }
 *   POST /v2/auth/login    { email, password }
 *   POST /v2/auth/refresh  (con Bearer token actual)
 *   GET  /v2/auth/me       (con Bearer)
 */

const STORAGE_KEY = 'pipeline-auth';

export interface AuthUser {
  id: string;
  email: string;
  tenant_id: number | null;
  role: 'admin' | 'cajero' | 'contador' | 'viewer';
  full_name: string | null;
}

interface StoredAuth {
  access_token: string;
  user: AuthUser;
  /** unix ms — clock cliente; usar solo como hint, el server siempre re-valida */
  expires_at?: number;
}

export interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  loading: boolean;
  tenantId: number | null;
  role: string;
}

function readStored(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredAuth;
  } catch {
    return null;
  }
}

function writeStored(a: StoredAuth | null): void {
  if (a) localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
  else localStorage.removeItem(STORAGE_KEY);
  // Notifica a otros tabs y a este mismo (vía evento storage si fuera otro tab).
  window.dispatchEvent(new CustomEvent('pipeline-auth-changed'));
}

/** Hook reactivo: re-renderiza cuando hay login/logout/refresh. */
export function useAuth(): AuthState {
  const [state, setState] = useState<StoredAuth | null>(() => readStored());

  useEffect(() => {
    const onChange = () => setState(readStored());
    window.addEventListener('pipeline-auth-changed', onChange);
    window.addEventListener('storage', onChange);    // sincroniza entre tabs
    return () => {
      window.removeEventListener('pipeline-auth-changed', onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  return {
    user: state?.user ?? null,
    accessToken: state?.access_token ?? null,
    loading: false,    // sin async init — el storage es síncrono
    tenantId: state?.user?.tenant_id ?? null,
    role: state?.user?.role ?? 'viewer',
  };
}

// ── Actions ────────────────────────────────────────────────────────────────

async function apiCall<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const stored = readStored();
  if (stored?.access_token) headers['Authorization'] = `Bearer ${stored.access_token}`;
  const res = await fetch(`${env.dteServiceUrl.replace(/\/$/, '')}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = (data as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

export async function signup(input: { email: string; password: string; full_name?: string }): Promise<void> {
  const res = await apiCall<{ access_token: string; user: AuthUser }>('/v2/auth/signup', input);
  writeStored({ access_token: res.access_token, user: res.user });
}

export async function login(input: { email: string; password: string }): Promise<void> {
  const res = await apiCall<{ access_token: string; user: AuthUser }>('/v2/auth/login', input);
  writeStored({ access_token: res.access_token, user: res.user });
}

export async function refreshSession(): Promise<void> {
  const res = await apiCall<{ access_token: string; user: AuthUser }>('/v2/auth/refresh');
  writeStored({ access_token: res.access_token, user: res.user });
}

export function signOut(): void {
  writeStored(null);
  // Forzar reload limpio para resetear todo el estado en memoria.
  window.location.href = '/';
}

export function isAuthEnabled(): boolean {
  // El SaaS multi-tenant SIEMPRE requiere auth — siempre true cuando hay
  // dte-service URL. Eldot legacy single-tenant (sin VITE_DATA_ADAPTER=api)
  // bypass se hace en AuthGate.
  return env.adapter === 'api';
}
