-- =============================================================
-- ABX Pyme — Catálogo de productos / servicios para facturación POS
-- =============================================================

create table if not exists public.productos (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  codigo          text,
  nombre          text not null,
  descripcion     text,
  tipo            text not null check (tipo in ('bien', 'servicio')),
  precio_unitario numeric(14, 4) not null default 0,
  uni_medida      integer not null default 59,
  cod_actividad   text,
  activo          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists productos_company_idx on public.productos(company_id);
create index if not exists productos_nombre_idx  on public.productos(company_id, nombre);
create unique index if not exists productos_codigo_unique
  on public.productos(company_id, codigo) where codigo is not null;

alter table public.productos enable row level security;

create policy "productos: select own" on public.productos
  for select using (
    company_id in (select id from public.companies where owner_id = auth.uid())
  );

create policy "productos: insert own" on public.productos
  for insert with check (
    company_id in (select id from public.companies where owner_id = auth.uid())
  );

create policy "productos: update own" on public.productos
  for update using (
    company_id in (select id from public.companies where owner_id = auth.uid())
  );

create policy "productos: delete own" on public.productos
  for delete using (
    company_id in (select id from public.companies where owner_id = auth.uid())
  );
