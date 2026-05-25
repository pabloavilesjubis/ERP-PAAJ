-- ═══════════════════════════════════════════════════════════════════════════
-- PIPELINE ERP — Schema inicial multi-tenant
-- ═══════════════════════════════════════════════════════════════════════════
-- Diseño: cada fila lleva tenant_id. La aislación se garantiza por:
--   1. Middleware backend que inyecta tenant_id en todas las queries
--   2. RLS opcional en una segunda pasada (defensa en profundidad)
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── Tenants ────────────────────────────────────────────────────────────────
-- Un tenant = una "empresa cliente" del SaaS. PAAJ es tenant_id=1.
CREATE TABLE tenants (
  id              BIGSERIAL PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,              -- 'paaj', 'acme', usado en /t/<slug>
  nombre_legal    TEXT NOT NULL,                     -- "PABLO ALBERTO AVILES JUBIS"
  nombre_comercial TEXT,                             -- "BEON NUTRITION WELLNESS"
  status          TEXT NOT NULL DEFAULT 'active'     -- active | suspended | archived
                  CHECK (status IN ('active','suspended','archived','pending_onboarding')),
  /* brand_config: { logo_url, color_primary, color_accent, font, etc. } */
  brand_config    JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tenants_slug ON tenants(slug);
CREATE INDEX idx_tenants_status ON tenants(status);

-- ─── Datos fiscales del tenant (emisor MH) ──────────────────────────────────
-- Una sola fila por tenant. Aislada en su propia tabla para encryption-at-rest
-- selectivo (passwords + cert) y para query rápida sin scan de tenants.
CREATE TABLE tenant_emisor (
  tenant_id       BIGINT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  mh_env          TEXT NOT NULL DEFAULT 'sandbox'    -- sandbox | production | mock
                  CHECK (mh_env IN ('sandbox','production','mock')),
  mh_nit          TEXT NOT NULL CHECK (mh_nit ~ '^[0-9]{14}$'),
  /* Encriptados en aplicación con AES-256 antes de INSERT. Ver src/auth/crypto.ts */
  mh_password_enc TEXT NOT NULL,
  firmador_password_enc TEXT NOT NULL,
  /* Path al .crt en filesystem del firmador (/uploads/<nit>.crt). Guardamos
     el path para soportar futuras migraciones (S3, vault). */
  cert_path       TEXT NOT NULL,
  emisor_nrc      TEXT NOT NULL,
  emisor_nombre   TEXT NOT NULL,
  emisor_cod_actividad TEXT NOT NULL,
  emisor_desc_actividad TEXT NOT NULL,
  emisor_tipo_establecimiento TEXT NOT NULL CHECK (emisor_tipo_establecimiento ~ '^[0-9]{2}$'),
  emisor_departamento TEXT NOT NULL CHECK (emisor_departamento ~ '^[0-9]{2}$'),
  emisor_municipio TEXT NOT NULL CHECK (emisor_municipio ~ '^[0-9]{2}$'),
  emisor_complemento TEXT NOT NULL,
  emisor_telefono TEXT,
  emisor_email    TEXT NOT NULL,
  punto_venta_establecimiento TEXT NOT NULL CHECK (punto_venta_establecimiento ~ '^[A-Z0-9]{4}$'),
  punto_venta_punto TEXT NOT NULL CHECK (punto_venta_punto ~ '^[A-Z0-9]{4}$'),
  emisor_cod_estable_mh TEXT CHECK (emisor_cod_estable_mh IS NULL OR emisor_cod_estable_mh ~ '^[A-Z0-9]{4}$'),
  emisor_cod_punto_venta_mh TEXT CHECK (emisor_cod_punto_venta_mh IS NULL OR emisor_cod_punto_venta_mh ~ '^[A-Z0-9]{4}$'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Usuarios (referencia a Supabase Auth) ──────────────────────────────────
-- El user_id es el UUID que Supabase Auth emite. Acá guardamos solo la relación
-- (user, tenant, role). Auth (password, recovery) vive en Supabase.
CREATE TABLE users (
  id              UUID PRIMARY KEY,                  -- == auth.users.id de Supabase
  email           TEXT NOT NULL,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'admin'      -- admin | cajero | contador | viewer
                  CHECK (role IN ('admin','cajero','contador','viewer')),
  full_name       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at   TIMESTAMPTZ
);
CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_users_email ON users(email);

-- ─── Correlativos fiscales (por tenant + tipo_dte) ──────────────────────────
-- Migra el storage filesystem actual. UNA secuencia por (tenant, tipo).
-- La unicidad de la PK + transacciones Postgres dan atomicidad SIN mutex
-- in-process — esto resuelve el TODO de horizontal scaling.
CREATE TABLE tenant_correlativos (
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tipo_dte        TEXT NOT NULL CHECK (tipo_dte IN ('01','03','05','14')),
  seeded          BOOLEAN NOT NULL DEFAULT FALSE,
  seeded_at       TIMESTAMPTZ,
  seeded_by       TEXT,
  ultimo_consumido BIGINT NOT NULL DEFAULT 0 CHECK (ultimo_consumido >= 0),
  /* Reservaciones in-flight como array de BIGINT */
  reservados      BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[],
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, tipo_dte)
);

-- ─── DTEs emitidos (registro fiscal) ────────────────────────────────────────
-- Equivalente al actual /app/data/dtes/<id>.json. Una fila por DTE.
CREATE TABLE dtes (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  erp_invoice_id  TEXT NOT NULL,                     -- 'inv_<hex>', único por tenant
  beon_sale_id    TEXT,
  origen          TEXT NOT NULL DEFAULT 'POS' CHECK (origen IN ('POS','BEON','API')),
  vendedor_nombre TEXT,
  tipo_dte        TEXT NOT NULL CHECK (tipo_dte IN ('01','03','05','14')),
  estado          TEXT NOT NULL CHECK (estado IN ('EMITIDO','RECHAZADO','ANULADO')),
  codigo_generacion TEXT NOT NULL,                   -- UUID v4 MH, único globalmente
  numero_control  TEXT NOT NULL,                     -- DTE-NN-XXXXXXXX-NNNNNNNNNNNNNNN
  sello_recibido  TEXT,
  fh_procesamiento TEXT,
  fec_emi         DATE NOT NULL,
  hor_emi         TEXT NOT NULL,
  ambiente        TEXT NOT NULL CHECK (ambiente IN ('00','01')),
  receptor_correo TEXT,
  receptor_nombre TEXT,
  consecutivo     BIGINT NOT NULL,
  dte_json        JSONB NOT NULL,                    -- el DTE canónico firmado
  documento_jws   TEXT NOT NULL,                     -- JWS compacto
  mh_raw          JSONB NOT NULL,                    -- respuesta cruda de MH
  pdf_path        TEXT,
  json_path       TEXT,
  ticket_path     TEXT,
  /* Anulación (si existe) */
  anulacion       JSONB,
  erp_synced_at   TIMESTAMPTZ,                       -- ack del frontend
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, erp_invoice_id),
  UNIQUE (tenant_id, codigo_generacion),
  UNIQUE (tenant_id, numero_control)
);
CREATE INDEX idx_dtes_tenant_fecha ON dtes(tenant_id, fec_emi DESC);
CREATE INDEX idx_dtes_tenant_beon ON dtes(tenant_id, beon_sale_id) WHERE beon_sale_id IS NOT NULL;
CREATE INDEX idx_dtes_tenant_estado ON dtes(tenant_id, estado);
CREATE INDEX idx_dtes_unsynced ON dtes(tenant_id) WHERE erp_synced_at IS NULL;

-- ─── Ventas (la "vista ERP" del DTE — lo que ven los reportes mensuales) ────
-- Equivalente a ventasConsumidor + ventasContribuyente del store actual.
-- En vez de dos tablas con shape distinto, una sola con `kind`.
CREATE TABLE ventas (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  /* kind=consumidor: FCF (tipo_dte=01). kind=contribuyente: CCF/NC (03/05). */
  kind            TEXT NOT NULL CHECK (kind IN ('consumidor','contribuyente')),
  dte_id          BIGINT REFERENCES dtes(id) ON DELETE SET NULL,
  fecha           DATE NOT NULL,
  descripcion     TEXT NOT NULL,
  /* Para FCF: solo `monto` (con IVA incluido). Para CCF/NC: `gravado` + `exento`. */
  monto           NUMERIC(14,2),
  gravado         NUMERIC(14,2),
  exento          NUMERIC(14,2),
  iva             NUMERIC(14,2),
  cliente_nombre  TEXT,
  cliente_nrc     TEXT,
  cliente_nit     TEXT,
  notas           TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}',       -- todo lo demás (vendedorNombre, anulado, etc.)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ventas_tenant_fecha ON ventas(tenant_id, fecha DESC);
CREATE INDEX idx_ventas_tenant_kind ON ventas(tenant_id, kind);
CREATE INDEX idx_ventas_tenant_dte ON ventas(tenant_id, dte_id);

-- ─── Compras ────────────────────────────────────────────────────────────────
CREATE TABLE compras (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fecha           DATE NOT NULL,
  proveedor_nombre TEXT NOT NULL,
  proveedor_nit   TEXT,
  proveedor_dui   TEXT,
  proveedor_nrc   TEXT,
  descripcion     TEXT,
  gravado         NUMERIC(14,2) NOT NULL DEFAULT 0,
  exento          NUMERIC(14,2) NOT NULL DEFAULT 0,
  iva             NUMERIC(14,2) NOT NULL DEFAULT 0,
  total           NUMERIC(14,2) NOT NULL DEFAULT 0,
  notas           TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_compras_tenant_fecha ON compras(tenant_id, fecha DESC);

-- ─── Contribuyentes (clientes/proveedores guardados) ────────────────────────
CREATE TABLE contribuyentes (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre          TEXT NOT NULL,
  nit             TEXT,
  dui             TEXT,
  nrc             TEXT,
  giro            TEXT,
  telefono        TEXT,
  email           TEXT,
  direccion       TEXT,
  departamento    TEXT,
  municipio       TEXT,
  cod_actividad   TEXT,
  tipo            TEXT NOT NULL CHECK (tipo IN ('Cliente','Proveedor','Ambos')),
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_contribuyentes_tenant ON contribuyentes(tenant_id);
CREATE INDEX idx_contribuyentes_tenant_nit ON contribuyentes(tenant_id, nit) WHERE nit IS NOT NULL;

-- ─── Productos / servicios ──────────────────────────────────────────────────
CREATE TABLE productos (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  codigo          TEXT,
  nombre          TEXT NOT NULL,
  tipo            TEXT NOT NULL CHECK (tipo IN ('producto','servicio')),
  precio_unitario NUMERIC(14,2) NOT NULL DEFAULT 0,
  uni_medida      INTEGER NOT NULL DEFAULT 59,        -- CAT-014 MH
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_productos_tenant ON productos(tenant_id);

-- ─── Audit log fiscal (preserva trazabilidad multi-tenant) ──────────────────
-- Cada evento (CORRELATIVO_RESERVED, ERP_SYNC_INTENT, MH_REJECTED, etc.)
-- queda persistido. Permite reconstruir incidentes sin grep en logs del
-- contenedor.
CREATE TABLE audit_events (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,                     -- 'CORRELATIVO_RESERVED' etc.
  payload         JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_tenant_created ON audit_events(tenant_id, created_at DESC);
CREATE INDEX idx_audit_event_type ON audit_events(event_type, created_at DESC);

-- ─── Trigger genérico de updated_at ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tenants_updated BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_tenant_emisor_updated BEFORE UPDATE ON tenant_emisor
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_tenant_correlativos_updated BEFORE UPDATE ON tenant_correlativos
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_dtes_updated BEFORE UPDATE ON dtes
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_ventas_updated BEFORE UPDATE ON ventas
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_compras_updated BEFORE UPDATE ON compras
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_contribuyentes_updated BEFORE UPDATE ON contribuyentes
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_productos_updated BEFORE UPDATE ON productos
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ─── Tabla de control de migraciones ────────────────────────────────────────
CREATE TABLE schema_migrations (
  version         TEXT PRIMARY KEY,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (version) VALUES ('001_initial');

COMMIT;
