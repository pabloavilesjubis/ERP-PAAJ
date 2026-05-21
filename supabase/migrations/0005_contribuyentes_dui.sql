-- =============================================================
-- ABX Pyme — Agrega columna DUI a contribuyentes
-- Necesario para reportar retenciones del F-14 a personas naturales
-- que se identifican por DUI en lugar de NIT.
-- =============================================================

alter table public.contribuyentes
  add column if not exists dui text;
