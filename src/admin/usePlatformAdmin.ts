import { useEffect, useState } from 'react';
import { useAuth } from '@/auth/useAuth';
import { v2 } from '@/lib/api/client';

// Cache a nivel módulo: una sola consulta por sesión.
let cached: boolean | null = null;

/** True si el usuario actual es super-admin de plataforma (puede gestionar tenants). */
export function usePlatformAdmin(): boolean {
  const [isAdmin, setIsAdmin] = useState<boolean>(cached ?? false);
  const auth = useAuth();
  useEffect(() => {
    if (cached !== null) { setIsAdmin(cached); return; }
    if (!auth.accessToken) return;
    let cancelled = false;
    v2.meFull()
      .then(r => { if (!cancelled) { cached = !!r.is_platform_admin; setIsAdmin(cached); } })
      .catch(() => { /* silencioso */ });
    return () => { cancelled = true; };
  }, [auth.accessToken]);
  return isAdmin;
}

/** Limpia el cache (ej. al cerrar sesión). */
export function resetPlatformAdminCache(): void {
  cached = null;
}
