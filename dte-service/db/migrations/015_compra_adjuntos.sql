-- =============================================================================
-- 015_compra_adjuntos — PDF y JSON de cada compra, por empresa.
--
-- Hasta ahora el PDF de una compra dependía de Supabase Storage (modo PAAJ) y
-- en multi-empresa no había dónde guardarlo. Un archivo de cada tipo por
-- compra; se borran con la compra. El contenido vive en la base (bytea) para
-- que viaje con los respaldos de cada empresa.
-- =============================================================================

CREATE TABLE public.compra_adjuntos (
  tenant_id   BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  compra_id   BIGINT NOT NULL REFERENCES public.compras(id) ON DELETE CASCADE,
  kind        TEXT   NOT NULL CHECK (kind IN ('pdf', 'json')),
  filename    TEXT   NOT NULL,
  mime        TEXT   NOT NULL,
  size        INT    NOT NULL CHECK (size > 0 AND size <= 10485760),
  content     BYTEA  NOT NULL,
  uploaded_by TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (compra_id, kind)
);
CREATE INDEX compra_adjuntos_tenant ON public.compra_adjuntos (tenant_id);
