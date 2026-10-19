import { api } from '@/lib/api/client';

export interface PlatformTenant {
  id: number; slug: string; nombre_legal: string; nombre_comercial: string | null; status: string; created_at: string;
  users: number; last_login_at: string | null; has_emisor: boolean; nit: string | null; mh_env: string | null;
  dtes: number; dtes_month: number; last_dte: string | null; ventas: number; compras: number;
}
export interface Emisor {
  mh_env: 'sandbox' | 'production'; mh_nit: string; emisor_nrc: string; emisor_nombre: string; emisor_cod_actividad: string;
  emisor_desc_actividad: string; emisor_tipo_establecimiento: string; emisor_departamento: string; emisor_municipio: string;
  emisor_complemento: string; emisor_telefono: string | null; emisor_email: string; punto_venta_establecimiento: string;
  punto_venta_punto: string; emisor_cod_estable_mh: string | null; emisor_cod_punto_venta_mh: string | null;
  mh_password?: string; firmador_password?: string;
}
export interface TenantUser { id: string; email: string; full_name: string | null; role: string; active: boolean; created_at: string; last_login_at: string | null }
export interface TenantDetail {
  tenant: { id: number; slug: string; nombre_legal: string; nombre_comercial: string | null; status: string; created_at: string };
  emisor: (Emisor & { cert_path: string }) | null;
  users: TenantUser[];
  correlativos: Array<{ tipo_dte: string; seeded: boolean; ultimo_consumido: number }>;
  counts: { dtes: number; ventas: number; compras: number; contribuyentes: number; asientos: number; empleados: number };
}

export const platformApi = {
  list: () => api.get<{ items: PlatformTenant[] }>('/v2/admin/tenants').then(r => r.items),
  detail: (id: number) => api.get<TenantDetail>(`/v2/admin/tenants/${id}`),
  create: (b: { tenant: { slug: string; nombre_legal: string; nombre_comercial?: string | null }; admin: { email: string; password: string; full_name?: string | null };
    emisor?: Emisor | null; correlativos?: Array<{ tipo_dte: string; ultimo_consumido: number }> }) =>
    api.post<{ tenant_id: number; slug: string }>('/v2/admin/tenants', b),
  update: (id: number, b: { slug?: string; nombre_legal?: string; nombre_comercial?: string | null; status?: string }) => api.put<{ success: boolean }>(`/v2/admin/tenants/${id}`, b),
  saveEmisor: (id: number, b: Emisor) => api.put<{ success: boolean }>(`/v2/admin/tenants/${id}/emisor`, b),
  remove: (id: number, confirm_slug: string, password: string) =>
    api.request<{ success: boolean }>('DELETE', `/v2/admin/tenants/${id}`, { confirm_slug, password }),
  addUser: (id: number, b: { email: string; full_name?: string | null; role: string; password: string }) => api.post<{ id: string }>(`/v2/admin/tenants/${id}/users`, b),
  updateUser: (uid: string, b: { role?: string; full_name?: string | null; active?: boolean }) => api.put<{ success: boolean }>(`/v2/admin/users/${uid}`, b),
  resetPassword: (uid: string, password: string) => api.post<{ success: boolean }>(`/v2/admin/users/${uid}/password`, { password }),
  uploadCert: (mh_nit: string, cert_base64: string) => api.post<{ success: boolean }>('/v2/onboarding/cert', { mh_nit, cert_base64 }),
};

export const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrador', contador: 'Contador', auxiliar: 'Auxiliar contable', rrhh: 'Recursos humanos', cajero: 'Cajero', viewer: 'Consulta',
};
export const STATUS_LABEL: Record<string, string> = { active: 'Activa', suspended: 'Suspendida', archived: 'Archivada', pending_onboarding: 'Pendiente' };
