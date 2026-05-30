-- ═══════════════════════════════════════════════════════════════════════════
-- RLS — defensa en profundidad sobre tenant_id
-- ═══════════════════════════════════════════════════════════════════════════
-- Aunque el middleware backend ya bindea WHERE tenant_id=$X en cada query,
-- activamos RLS como segunda capa. La sesión Postgres setea
-- `app.current_tenant_id` mediante `SET LOCAL` al inicio de cada request, y
-- las policies filtran automáticamente.
--
-- Si el backend olvidara el WHERE en alguna query nueva, RLS evita data leak
-- cross-tenant. Si se quisiera dar acceso DIRECTO a un cliente psql (ej.
-- soporte avanzado), basta con `SET app.current_tenant_id = X` y todas las
-- queries quedan auto-scoped.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Función helper: devuelve el tenant actual de la sesión (NULL si no set).
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS BIGINT AS $$
DECLARE
  v TEXT;
BEGIN
  v := current_setting('app.current_tenant_id', true);
  IF v IS NULL OR v = '' THEN RETURN NULL; END IF;
  RETURN v::BIGINT;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- Activar RLS en tablas con tenant_id
ALTER TABLE tenant_emisor       ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_correlativos ENABLE ROW LEVEL SECURITY;
ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE dtes                ENABLE ROW LEVEL SECURITY;
ALTER TABLE ventas              ENABLE ROW LEVEL SECURITY;
ALTER TABLE compras             ENABLE ROW LEVEL SECURITY;
ALTER TABLE contribuyentes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE productos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events        ENABLE ROW LEVEL SECURITY;

-- Policy genérica: solo filas del tenant actual. Cuando current_tenant_id() es
-- NULL (ej. scripts admin que no setearon la var), policy NO matchea → 0 filas.
-- Para bypassear desde admin: SET ROLE postgres + querys directos o uso de
-- BYPASSRLS role.

CREATE POLICY tenant_isolation ON tenant_emisor       USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON tenant_correlativos USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON users               USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON dtes                USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON ventas              USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON compras             USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON contribuyentes      USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON productos           USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON audit_events        USING (tenant_id = current_tenant_id());

-- Permisos: el role 'pipeline' (backend) recibe BYPASSRLS para que sus
-- queries NO se filtren — el backend ya enforce tenant_id en WHERE de cada
-- query. RLS queda como defensa contra:
--   1. Conexiones directas con roles no-bypass (soporte, audit, dashboards).
--   2. Bugs futuros donde alguna query nueva olvide el WHERE tenant_id.
--
-- Si querés enforce RLS sobre el backend también, remové BYPASSRLS y
-- wrappeá cada request en transacción con `SET LOCAL app.current_tenant_id`.
-- (Ver `withTenant()` en src/db/client.ts.)

ALTER ROLE pipeline BYPASSRLS;

-- `tenants` (la tabla padre) NO se filtra — el middleware necesita poder
-- buscar tenant por slug ANTES de saber el tenant_id (caso onboarding,
-- resolución de path /t/<slug>).

INSERT INTO schema_migrations (version) VALUES ('003_rls_policies') ON CONFLICT (version) DO NOTHING;

COMMIT;
