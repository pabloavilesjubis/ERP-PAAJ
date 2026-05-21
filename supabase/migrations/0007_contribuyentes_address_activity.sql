-- =============================================================
-- ABX Pyme — Contribuyentes: agrega catálogos MH (departamento, municipio, actividad)
-- Necesarios para emisión de DTE: el receptor de un CCF requiere
-- direccion.{departamento, municipio, complemento} y codActividad.
-- =============================================================

alter table public.contribuyentes
  add column if not exists departamento   text,   -- CAT-012 (2 dígitos)
  add column if not exists municipio      text,   -- CAT-013 (2 dígitos por depto)
  add column if not exists cod_actividad  text;   -- CAT-019 (2-6 dígitos)
