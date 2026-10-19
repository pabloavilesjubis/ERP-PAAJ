-- Esquema base de PRODUCCIÓN (copia de supabase/migrations/0009 sin la parte legacy).
-- Solo para la base de pruebas: tests de integración y desarrollo local.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE public.tenants (
  id               BIGSERIAL PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  nombre_legal     TEXT NOT NULL,
  nombre_comercial TEXT,
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','suspended','archived','pending_onboarding')),
  brand_config     JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.tenant_emisor (
  tenant_id        BIGINT PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  mh_env           TEXT NOT NULL DEFAULT 'sandbox' CHECK (mh_env IN ('sandbox','production','mock')),
  mh_nit           TEXT NOT NULL,
  mh_password_enc  TEXT NOT NULL,
  firmador_password_enc TEXT NOT NULL,
  cert_path        TEXT NOT NULL,
  emisor_nrc       TEXT NOT NULL,
  emisor_nombre    TEXT NOT NULL,
  emisor_cod_actividad TEXT NOT NULL,
  emisor_desc_actividad TEXT NOT NULL,
  emisor_tipo_establecimiento TEXT NOT NULL,
  emisor_departamento TEXT NOT NULL,
  emisor_municipio TEXT NOT NULL,
  emisor_complemento TEXT NOT NULL,
  emisor_telefono  TEXT,
  emisor_email     TEXT NOT NULL,
  punto_venta_establecimiento TEXT NOT NULL,
  punto_venta_punto TEXT NOT NULL,
  emisor_cod_estable_mh TEXT,
  emisor_cod_punto_venta_mh TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- users.id ya en TEXT (estado final tras dte-service migration 004)
CREATE TABLE public.users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  password_hash TEXT,
  tenant_id     BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','cajero','contador','viewer')),
  full_name     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);
CREATE INDEX idx_users_tenant ON public.users(tenant_id);
CREATE UNIQUE INDEX idx_users_email_unique ON public.users(LOWER(email));

CREATE TABLE public.auth_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('reset','verify')),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.tenant_correlativos (
  tenant_id        BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  tipo_dte         TEXT NOT NULL CHECK (tipo_dte IN ('01','03','05','14')),
  seeded           BOOLEAN NOT NULL DEFAULT FALSE,
  seeded_at        TIMESTAMPTZ,
  seeded_by        TEXT,
  ultimo_consumido BIGINT NOT NULL DEFAULT 0 CHECK (ultimo_consumido >= 0),
  reservados       BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[],
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, tipo_dte)
);

CREATE TABLE public.dtes (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  erp_invoice_id    TEXT NOT NULL,
  beon_sale_id      TEXT,
  origen            TEXT NOT NULL DEFAULT 'POS' CHECK (origen IN ('POS','BEON','API')),
  vendedor_nombre   TEXT,
  tipo_dte          TEXT NOT NULL CHECK (tipo_dte IN ('01','03','05','14')),
  estado            TEXT NOT NULL CHECK (estado IN ('EMITIDO','RECHAZADO','ANULADO')),
  codigo_generacion TEXT NOT NULL,
  numero_control    TEXT NOT NULL,
  sello_recibido    TEXT,
  fh_procesamiento  TEXT,
  fec_emi           DATE NOT NULL,
  hor_emi           TEXT NOT NULL,
  ambiente          TEXT NOT NULL CHECK (ambiente IN ('00','01')),
  receptor_correo   TEXT,
  receptor_nombre   TEXT,
  consecutivo       BIGINT NOT NULL,
  dte_json          JSONB NOT NULL,
  documento_jws     TEXT NOT NULL,
  mh_raw            JSONB NOT NULL,
  pdf_path          TEXT,
  json_path         TEXT,
  ticket_path       TEXT,
  anulacion         JSONB,
  erp_synced_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, erp_invoice_id),
  UNIQUE (tenant_id, codigo_generacion),
  UNIQUE (tenant_id, numero_control)
);
CREATE INDEX idx_dtes_tenant_fecha ON public.dtes(tenant_id, fec_emi DESC);

CREATE TABLE public.ventas (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('consumidor','contribuyente')),
  dte_id         BIGINT REFERENCES public.dtes(id) ON DELETE SET NULL,
  fecha          DATE NOT NULL,
  descripcion    TEXT NOT NULL,
  monto          NUMERIC(14,2),
  gravado        NUMERIC(14,2),
  exento         NUMERIC(14,2),
  iva            NUMERIC(14,2),
  cliente_nombre TEXT,
  cliente_nrc    TEXT,
  cliente_nit    TEXT,
  notas          TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ventas_tenant_fecha ON public.ventas(tenant_id, fecha DESC);
CREATE INDEX idx_ventas_tenant_kind  ON public.ventas(tenant_id, kind);

CREATE TABLE public.compras (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  fecha            DATE NOT NULL,
  proveedor_nombre TEXT NOT NULL,
  proveedor_nit    TEXT,
  proveedor_dui    TEXT,
  proveedor_nrc    TEXT,
  descripcion      TEXT,
  gravado          NUMERIC(14,2) NOT NULL DEFAULT 0,
  exento           NUMERIC(14,2) NOT NULL DEFAULT 0,
  iva              NUMERIC(14,2) NOT NULL DEFAULT 0,
  total            NUMERIC(14,2) NOT NULL DEFAULT 0,
  notas            TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_compras_tenant_fecha ON public.compras(tenant_id, fecha DESC);

CREATE TABLE public.contribuyentes (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  nombre        TEXT NOT NULL,
  nit           TEXT,
  dui           TEXT,
  nrc           TEXT,
  giro          TEXT,
  telefono      TEXT,
  email         TEXT,
  direccion     TEXT,
  departamento  TEXT,
  municipio     TEXT,
  cod_actividad TEXT,
  tipo          TEXT NOT NULL CHECK (tipo IN ('Cliente','Proveedor','Ambos')),
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_contribuyentes_tenant ON public.contribuyentes(tenant_id);

CREATE TABLE public.productos (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  codigo          TEXT,
  nombre          TEXT NOT NULL,
  tipo            TEXT NOT NULL CHECK (tipo IN ('producto','servicio')),
  precio_unitario NUMERIC(14,2) NOT NULL DEFAULT 0,
  uni_medida      INTEGER NOT NULL DEFAULT 59,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_productos_tenant ON public.productos(tenant_id);

CREATE TABLE public.audit_events (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id    TEXT REFERENCES public.users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- trigger updated_at
CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_ventas_updated         BEFORE UPDATE ON public.ventas         FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_compras_updated        BEFORE UPDATE ON public.compras        FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_contribuyentes_updated BEFORE UPDATE ON public.contribuyentes FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_productos_updated      BEFORE UPDATE ON public.productos      FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_tenants_updated        BEFORE UPDATE ON public.tenants        FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO public.schema_migrations (version)
VALUES ('001_initial'),('002_seed_paaj_tenant'),('003_rls_policies'),('004_local_auth'),('0009_adopt_tenant_schema')
ON CONFLICT (version) DO NOTHING;

