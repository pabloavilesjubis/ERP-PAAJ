import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { useAuth } from '@/auth/useAuth';

/**
 * Permisos del usuario actual según su rol (los define el backend en
 * dte-service/src/auth/permissions.ts). El menú y las acciones se gatean con
 * `can('accounting:post')`; el backend vuelve a validar en cada ruta.
 */
export interface MePermissions {
  role: string;
  role_label: string;
  permissions: string[];
  is_platform_admin: boolean;
}

export function usePermissions() {
  const { accessToken } = useAuth();
  const q = useQuery({
    queryKey: ['me', 'permissions', accessToken],
    queryFn: () => api.get<MePermissions>('/v2/me/permissions'),
    enabled: !!accessToken,
    staleTime: 5 * 60_000,
  });
  const perms = new Set(q.data?.permissions ?? []);
  return {
    loading: q.isLoading,
    role: q.data?.role,
    roleLabel: q.data?.role_label,
    can: (p: string) => perms.has(p),
    isPlatformAdmin: !!q.data?.is_platform_admin,
  };
}
