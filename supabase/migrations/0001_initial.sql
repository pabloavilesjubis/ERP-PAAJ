-- =============================================================
-- ABX Pyme — ERP Fiscal: esquema inicial
-- Multi-tenant por `companies` con RLS basado en auth.uid().
-- Pega este archivo en Supabase Studio → SQL Editor → Run.
-- =============================================================

create extension if not exists "pgcrypto";

-- ---------- Empresas (multi-tenant) ----------
create table if not exists public.companies (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  nombre      text not null,
  nit         text,
  nrc         text,
  created_at  timestamptz not null default now()
);
create index if not exists companies_owner_idx on public.companies(owner_id);

-- ---------- Contribuyentes (clientes/proveedores) ----------
create table if not exists public.contribuyentes (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  nombre      text not null,
  nit         text not null,
  nrc         text not null,
  giro        text,
  telefono    text,
  email       text,
  direccion   text,
  tipo        text not null check (tipo in ('Cliente','Proveedor','Ambos')),
  created_at  timestamptz not null default now()
);
create index if not exists contribuyentes_company_idx on public.contribuyentes(company_id);
create unique index if not exists contribuyentes_company_nrc_uidx on public.contribuyentes(company_id, nrc);

-- ---------- Ventas al consumidor (FE) ----------
create table if not exists public.ventas_consumidor (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  fecha        date not null,
  descripcion  text not null default '',
  monto        numeric(14,2) not null,
  notas        text,
  created_at   timestamptz not null default now()
);
create index if not exists vc_company_fecha_idx on public.ventas_consumidor(company_id, fecha);

-- ---------- Ventas al contribuyente (CCF) ----------
create table if not exists public.ventas_contribuyente (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  contribuyente_id  uuid references public.contribuyentes(id) on delete set null,
  fecha             date not null,
  cliente           text not null,
  nrc               text not null,
  descripcion       text not null default '',
  gravado           numeric(14,2) not null default 0,
  exento            numeric(14,2) not null default 0,
  notas             text,
  created_at        timestamptz not null default now()
);
create index if not exists vt_company_fecha_idx on public.ventas_contribuyente(company_id, fecha);

-- ---------- Compras ----------
create table if not exists public.compras (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  contribuyente_id  uuid references public.contribuyentes(id) on delete set null,
  fecha             date not null,
  proveedor         text not null,
  nrc               text not null,
  descripcion       text not null default '',
  monto             numeric(14,2) not null,
  iva_credito       numeric(14,2) not null default 0,
  notas             text,
  created_at        timestamptz not null default now()
);
create index if not exists cp_company_fecha_idx on public.compras(company_id, fecha);

-- ---------- Plantillas CSV personalizadas ----------
create table if not exists public.csv_templates (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  nombre      text not null,
  tipo        text not null,
  columnas    jsonb not null,
  created_at  timestamptz not null default now()
);
create index if not exists csv_templates_company_idx on public.csv_templates(company_id);

-- =============================================================
-- ROW LEVEL SECURITY
-- =============================================================
alter table public.companies            enable row level security;
alter table public.contribuyentes       enable row level security;
alter table public.ventas_consumidor    enable row level security;
alter table public.ventas_contribuyente enable row level security;
alter table public.compras              enable row level security;
alter table public.csv_templates        enable row level security;

-- Helper inline: una empresa pertenece al usuario autenticado.
-- Las tablas hijas se filtran por la ownership de su company_id.

-- companies
drop policy if exists "companies_select_own"  on public.companies;
drop policy if exists "companies_modify_own"  on public.companies;
create policy "companies_select_own"
  on public.companies for select
  using (owner_id = auth.uid());
create policy "companies_modify_own"
  on public.companies for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- macro para hijos
do $$
declare
  t text;
  child_tables text[] := array[
    'contribuyentes','ventas_consumidor','ventas_contribuyente','compras','csv_templates'
  ];
begin
  foreach t in array child_tables loop
    execute format('drop policy if exists "%I_select_own" on public.%I', t, t);
    execute format('drop policy if exists "%I_modify_own" on public.%I', t, t);
    execute format($f$
      create policy "%I_select_own"
        on public.%I for select
        using (exists (
          select 1 from public.companies c
          where c.id = %I.company_id and c.owner_id = auth.uid()
        ))
    $f$, t, t, t);
    execute format($f$
      create policy "%I_modify_own"
        on public.%I for all
        using (exists (
          select 1 from public.companies c
          where c.id = %I.company_id and c.owner_id = auth.uid()
        ))
        with check (exists (
          select 1 from public.companies c
          where c.id = %I.company_id and c.owner_id = auth.uid()
        ))
    $f$, t, t, t, t);
  end loop;
end $$;
