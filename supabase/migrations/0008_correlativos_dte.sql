-- =============================================================
-- ABX Pyme — Correlativos DTE (último consecutivo emitido por tipo)
-- Crítico para no duplicar números de control al emitir contra el MH.
-- =============================================================

create table if not exists public.correlativos_dte (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id) on delete cascade,
  tipo_dte            text not null check (tipo_dte in ('01','03','05','06','11','14')),
  ultimo_consecutivo  integer not null default 0 check (ultimo_consecutivo >= 0),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (company_id, tipo_dte)
);

create index if not exists correlativos_dte_company_idx
  on public.correlativos_dte(company_id);

alter table public.correlativos_dte enable row level security;

create policy "correlativos_dte: select own" on public.correlativos_dte
  for select using (
    company_id in (select id from public.companies where owner_id = auth.uid())
  );

create policy "correlativos_dte: insert own" on public.correlativos_dte
  for insert with check (
    company_id in (select id from public.companies where owner_id = auth.uid())
  );

create policy "correlativos_dte: update own" on public.correlativos_dte
  for update using (
    company_id in (select id from public.companies where owner_id = auth.uid())
  );

create policy "correlativos_dte: delete own" on public.correlativos_dte
  for delete using (
    company_id in (select id from public.companies where owner_id = auth.uid())
  );
