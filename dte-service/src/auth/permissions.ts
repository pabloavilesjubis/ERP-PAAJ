/**
 * Permisos por rol (RBAC). Única fuente de verdad: el frontend los pide a
 * GET /v2/me/permissions para armar el menú, y cada ruta los exige con
 * `requirePerm(...)`.
 *
 * Los roles viven en `users.role` (migración 005). Un permiso es
 * `<recurso>:<acción>`; `admin` los tiene todos.
 */

export const ROLES = ['admin', 'contador', 'auxiliar', 'rrhh', 'cajero', 'viewer'] as const;
export type Role = typeof ROLES[number];

export const PERMISSIONS = [
  'users:manage', 'company:view', 'company:manage',
  'accounting:view', 'accounting:post', 'accounting:review', 'accounting:config', 'accounting:close',
  'receivables:view', 'receivables:manage',
  'payables:view', 'payables:manage',
  'banks:view', 'banks:manage',
  'payroll:view', 'payroll:manage', 'payroll:terminate',
  'fiscal:view', 'fiscal:manage',
  'assets:view', 'assets:manage',
] as const;
export type Permission = typeof PERMISSIONS[number];

const ALL: readonly Permission[] = PERMISSIONS;

const BY_ROLE: Record<Role, readonly Permission[]> = {
  admin: ALL,
  // El contador consulta planillas (las gestiona RRHH o el admin) y los datos de la
  // empresa; las credenciales del MH y el certificado solo los maneja el admin
  contador: ALL.filter(p => !['users:manage', 'company:manage', 'payroll:manage', 'payroll:terminate'].includes(p)),
  auxiliar: [
    'accounting:view', 'accounting:post',
    'receivables:view', 'receivables:manage',
    'payables:view', 'payables:manage',
    'banks:view', 'banks:manage',
    'fiscal:view', 'assets:view',
  ],
  rrhh: ['payroll:view', 'payroll:manage', 'payroll:terminate'],
  cajero: ['receivables:view'],
  viewer: ['accounting:view', 'receivables:view', 'payables:view', 'banks:view', 'fiscal:view', 'assets:view'],
};

export function permissionsOf(role: string | undefined | null): Permission[] {
  if (!role || !(ROLES as readonly string[]).includes(role)) return [];
  return [...BY_ROLE[role as Role]];
}

export function hasPermission(role: string | undefined | null, perm: Permission): boolean {
  return permissionsOf(role).includes(perm);
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrador',
  contador: 'Contador',
  auxiliar: 'Auxiliar contable',
  rrhh: 'Recursos humanos',
  cajero: 'Cajero',
  viewer: 'Consulta',
};
