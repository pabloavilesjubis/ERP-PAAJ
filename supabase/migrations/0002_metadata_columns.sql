-- =============================================================
-- ABX Pyme — Metadata column for POS imports
-- Permite preservar campos enriquecidos del CSV de tickets POS
-- (DTE, hora, vendedor, código de generación, etc.) sin alterar
-- el esquema rígido de cada tabla.
-- =============================================================

alter table public.ventas_consumidor
  add column if not exists metadata jsonb;

alter table public.ventas_contribuyente
  add column if not exists metadata jsonb;

alter table public.compras
  add column if not exists metadata jsonb;

-- Índice GIN para consultas tipo `metadata @> '{"source":"pos"}'`.
create index if not exists vc_metadata_gin on public.ventas_consumidor using gin (metadata);
