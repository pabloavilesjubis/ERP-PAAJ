-- =============================================================================
-- 005_users_roles — Usuarios por empresa con roles de trabajo (F0).
--
-- Cada empresa (tenant) administra sus propios usuarios: el admin de la
-- empresa da de alta a su contador, auxiliares, RRHH y cajeros. Nosotros solo
-- brindamos el sistema; los permisos por rol viven en el backend
-- (src/auth/permissions.ts), así que aquí solo se amplía el CHECK de roles.
--
--   admin     todo dentro de su empresa, incluida la gestión de usuarios
--   contador  contabilidad completa, cierres, fiscal, bancos, CxC/CxP
--   auxiliar  registra partidas, cobros, pagos y conciliaciones (no cierra)
--   rrhh      planillas y empleados
--   cajero    facturación / punto de venta
--   viewer    consulta
-- =============================================================================

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'contador', 'auxiliar', 'rrhh', 'cajero', 'viewer'));

ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_events_tenant ON audit_events(tenant_id, created_at DESC);
