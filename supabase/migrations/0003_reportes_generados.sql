-- =============================================================
-- ABX Pyme — Tabla de reportes generados
-- Almacena los archivos CSV producidos por la app (Anexo Consumidor
-- Final, F-955, etc.) para que queden disponibles en la pestaña de
-- "Reportes generados" y se puedan re-descargar.
-- =============================================================

create table if not exists public.reportes_generados (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  tipo          text not null,                  -- 'anexo_consumidor_final', etc.
  periodo_year  int  not null,
  periodo_month int  not null check (periodo_month between 1 and 12),
  filename      text not null,
  csv_content   text not null,
  row_count     int  not null default 0,
  total_amount  numeric(14,2) not null default 0,
  generated_at  timestamptz not null default now()
);

create index if not exists rg_company_periodo_idx
  on public.reportes_generados(company_id, periodo_year, periodo_month);

alter table public.reportes_generados enable row level security;

drop policy if exists "rg_select_own" on public.reportes_generados;
drop policy if exists "rg_modify_own" on public.reportes_generados;

create policy "rg_select_own"
  on public.reportes_generados for select
  using (exists (
    select 1 from public.companies c
    where c.id = reportes_generados.company_id and c.owner_id = auth.uid()
  ));

create policy "rg_modify_own"
  on public.reportes_generados for all
  using (exists (
    select 1 from public.companies c
    where c.id = reportes_generados.company_id and c.owner_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.companies c
    where c.id = reportes_generados.company_id and c.owner_id = auth.uid()
  ));
