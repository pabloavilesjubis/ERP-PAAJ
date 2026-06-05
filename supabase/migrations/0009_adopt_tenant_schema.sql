-- ═══════════════════════════════════════════════════════════════════════════
-- 0009 — Adoptar el esquema multi-tenant del dte-service DENTRO de Supabase
-- ═══════════════════════════════════════════════════════════════════════════
-- Objetivo: que el backend dte-service (que el frontend PROD usa vía ApiAdapter)
-- pueda leer la data histórica de PAAJ apuntando su DATABASE_URL a ESTE Supabase.
--
-- Qué hace, en orden:
--   1. Renombra a *_legacy las tablas viejas cuyo NOMBRE choca con el esquema
--      nuevo (contribuyentes, compras, productos). NO se borra nada.
--   2. Crea el esquema que el backend espera (tenants, ventas, compras,
--      contribuyentes, productos, users, correlativos, emisor, dtes, audit).
--   3. Siembra el tenant 1 = PAAJ.
--   4. Copia la data de la empresa PAAJ real → tablas nuevas, con tenant_id=1.
--      (la otra "company" af… está vacía y se ignora)
--   5. Habilita RLS deny-all en las tablas nuevas (defensa por si alguien pega
--      con la anon key de Supabase). El backend conecta como `postgres`
--      (superusuario → bypassa RLS), así que sigue leyendo todo.
--
-- SEGURO: todo aditivo + transaccional. Si algo falla, ROLLBACK total.
-- PROBALO PRIMERO EN UN BRANCH DE SUPABASE.
--
-- La empresa PAAJ real (confirmada por conteo de filas):
--   af7775d9-83f5-49a6-a5b2-7ed7921a05dc
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- para crypt()/gen_salt() del user admin

-- ─── 1. Resguardar tablas viejas que chocan de nombre ───────────────────────
ALTER TABLE public.contribuyentes RENAME TO contribuyentes_legacy;
ALTER TABLE public.compras        RENAME TO compras_legacy;
ALTER TABLE public.productos      RENAME TO productos_legacy;
-- (ventas_consumidor, ventas_contribuyente, correlativos_dte, companies,
--  csv_templates, reportes_generados NO chocan: quedan como fuente de lectura)

-- ─── 2. Esquema nuevo (igual al que crea el dte-service en migrations 001+004) ─

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

-- ─── 3. Sembrar tenant 1 = PAAJ ─────────────────────────────────────────────
INSERT INTO public.tenants (id, slug, nombre_legal, nombre_comercial, status, brand_config)
VALUES (1, 'paaj', 'PABLO ALBERTO AVILES JUBIS', 'BEON NUTRITION WELLNESS', 'active',
        '{"color_primary":"#10b981","color_accent":"#059669"}'::JSONB)
ON CONFLICT (id) DO NOTHING;
SELECT setval('public.tenants_id_seq', GREATEST((SELECT MAX(id) FROM public.tenants), 1));

-- ─── 4. Copiar la data de PAAJ (company af…) → esquema nuevo, tenant_id=1 ────

-- 4a. Contribuyentes (catálogo)
INSERT INTO public.contribuyentes
  (tenant_id, nombre, nit, dui, nrc, giro, telefono, email, direccion,
   departamento, municipio, cod_actividad, tipo, metadata, created_at)
SELECT 1, nombre, NULLIF(nit,''), NULLIF(dui,''), NULLIF(nrc,''), giro, telefono, email, direccion,
       departamento, municipio, cod_actividad, tipo, '{}'::JSONB, created_at
FROM public.contribuyentes_legacy
WHERE company_id = 'af7775d9-83f5-49a6-a5b2-7ed7921a05dc';

-- 4b. Productos ('bien' → 'producto'; descripcion/cod_actividad/activo → metadata)
INSERT INTO public.productos
  (tenant_id, codigo, nombre, tipo, precio_unitario, uni_medida, metadata, created_at)
SELECT 1, codigo, nombre,
       CASE WHEN tipo = 'servicio' THEN 'servicio' ELSE 'producto' END,
       ROUND(precio_unitario, 2), uni_medida,
       jsonb_strip_nulls(jsonb_build_object(
         'descripcion', descripcion, 'cod_actividad', cod_actividad, 'activo', activo)),
       created_at
FROM public.productos_legacy
WHERE company_id = 'af7775d9-83f5-49a6-a5b2-7ed7921a05dc';

-- 4c. Ventas a consumidor (FCF) → ventas.kind = 'consumidor'
INSERT INTO public.ventas
  (tenant_id, kind, fecha, descripcion, monto, notas, metadata, created_at)
SELECT 1, 'consumidor', fecha, COALESCE(descripcion, ''), monto, notas,
       COALESCE(metadata, '{}'::JSONB), created_at
FROM public.ventas_consumidor
WHERE company_id = 'af7775d9-83f5-49a6-a5b2-7ed7921a05dc';

-- 4d. Ventas a contribuyente (CCF) → ventas.kind = 'contribuyente'
--     ⚠️ IVA débito calculado = gravado * 0.13 (asunción; cambialo a NULL si
--        preferís que el reporte lo derive).
INSERT INTO public.ventas
  (tenant_id, kind, fecha, descripcion, gravado, exento, iva,
   cliente_nombre, cliente_nrc, notas, metadata, created_at)
SELECT 1, 'contribuyente', fecha, COALESCE(descripcion, ''), gravado, exento,
       ROUND(gravado * 0.13, 2), cliente, NULLIF(nrc,''), notas,
       COALESCE(metadata, '{}'::JSONB), created_at
FROM public.ventas_contribuyente
WHERE company_id = 'af7775d9-83f5-49a6-a5b2-7ed7921a05dc';

-- 4e. Compras (monto = base SIN IVA, confirmado). 0 filas hoy, pero queda listo.
INSERT INTO public.compras
  (tenant_id, fecha, proveedor_nombre, proveedor_nrc, descripcion,
   gravado, exento, iva, total, notas, metadata, created_at)
SELECT 1, fecha, proveedor, NULLIF(nrc,''), descripcion,
       monto, 0, iva_credito, monto + iva_credito, notas,
       COALESCE(metadata, '{}'::JSONB), created_at
FROM public.compras_legacy
WHERE company_id = 'af7775d9-83f5-49a6-a5b2-7ed7921a05dc';

-- 4f. Correlativos DTE — asegurar los 4 tipos y subir al último consecutivo real
INSERT INTO public.tenant_correlativos (tenant_id, tipo_dte, ultimo_consumido)
VALUES (1,'01',0),(1,'03',0),(1,'05',0),(1,'14',0)
ON CONFLICT (tenant_id, tipo_dte) DO NOTHING;

INSERT INTO public.tenant_correlativos
  (tenant_id, tipo_dte, seeded, seeded_at, seeded_by, ultimo_consumido)
SELECT 1, tipo_dte, TRUE, NOW(), 'migracion-supabase', ultimo_consecutivo
FROM public.correlativos_dte
WHERE company_id = 'af7775d9-83f5-49a6-a5b2-7ed7921a05dc'
  AND tipo_dte IN ('01','03','05','14')
ON CONFLICT (tenant_id, tipo_dte) DO UPDATE
  SET ultimo_consumido = GREATEST(public.tenant_correlativos.ultimo_consumido, EXCLUDED.ultimo_consumido),
      seeded = TRUE, seeded_at = NOW(), seeded_by = 'migracion-supabase';

-- 4g. Usuario admin para tenant 1 (para poder loguearte y VER la data).
--     Usa bcrypt vía pgcrypto, compatible con bcryptjs del backend.
--     ⚠️ CAMBIÁ el email y la password antes de correr. Alternativa "oficial":
--        dejá esto comentado y corré `npm run reset-admin` tras repuntar el backend.
INSERT INTO public.users (id, email, password_hash, tenant_id, role, full_name)
VALUES (
  'usr_' || encode(gen_random_bytes(12), 'hex'),
  'pabloavilesjubis@gmail.com',                          -- ← tu email de login
  crypt('CAMBIA_ESTA_PASSWORD', gen_salt('bf', 10)),     -- ← tu password
  1, 'admin', 'PABLO ALBERTO AVILES JUBIS'
)
ON CONFLICT DO NOTHING;

-- ─── 5. RLS deny-all en tablas nuevas (el backend conecta como postgres y bypassa) ─
ALTER TABLE public.tenants             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_emisor       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_tokens         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_correlativos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dtes                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ventas              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compras             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contribuyentes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.productos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events        ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN — corré esto aparte y chequeá que los números cuadren.
-- Esperado: ventas_new = 590 + 4 = 594, contribuyentes_new = 1, productos_new = 1
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT
--   (SELECT count(*) FROM public.ventas        WHERE tenant_id=1) AS ventas_new,        -- 594
--   (SELECT count(*) FROM public.ventas        WHERE tenant_id=1 AND kind='consumidor') AS vc,  -- 590
--   (SELECT count(*) FROM public.ventas        WHERE tenant_id=1 AND kind='contribuyente') AS vt, -- 4
--   (SELECT count(*) FROM public.contribuyentes WHERE tenant_id=1) AS contrib_new,      -- 1
--   (SELECT count(*) FROM public.productos      WHERE tenant_id=1) AS productos_new,     -- 1
--   (SELECT count(*) FROM public.tenant_correlativos WHERE tenant_id=1) AS correlativos; -- 4
