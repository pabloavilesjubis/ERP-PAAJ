# ABX Pyme — ERP Fiscal

ERP fiscal para PyMEs (El Salvador): control de **ingresos**, **egresos**, **declaración mensual de IVA**, **comprobantes de crédito fiscal (CCF)** y **facturas electrónicas (FE)**, con import/export en formato CSV.

## Stack

| Capa | Tecnología |
|---|---|
| Build / Dev server | Vite 5 |
| UI | React 18 + TypeScript |
| Routing | React Router 6 |
| State | Zustand (store) + persistencia automática |
| Server state | TanStack Query (preparado para queries Supabase) |
| Backend | Supabase (Auth + Postgres + RLS) |
| Forms | React Hook Form + Zod |
| CSV | PapaParse |
| Estilos | CSS Modules + design tokens (`src/styles/tokens.css`) |

## Arrancar

```bash
npm install
npm run dev
```

Se abre en `http://localhost:5173`. La app arranca **en modo offline** (localStorage), con datos de ejemplo. Todo lo que cambies queda persistido en tu navegador.

## Conectar Supabase

1. Sigue [`supabase/README.md`](./supabase/README.md) para crear el proyecto y correr la migración SQL.
2. Crea `.env.local` (basado en `.env.example`).
3. Reinicia el servidor — verás un login y la app pasará a modo nube con multi-tenant + RLS.

## Estructura

```
src/
├── app/                  # App root + rutas
├── components/
│   ├── icons/            # Sistema de íconos SVG
│   ├── layout/           # AppShell (sidebar + topbar)
│   └── ui/               # Primitivas (Button, Modal, Field, …)
├── config/               # Constantes y env
├── features/             # Módulos por dominio (Vertical Slice)
│   ├── auth/
│   ├── compras/
│   ├── contribuyentes/
│   ├── csv/              # Import/export con plantillas
│   ├── dashboard/
│   ├── ventas-consumidor/
│   └── ventas-contribuyente/
├── lib/
│   ├── data/             # Adaptador local ↔ Supabase
│   ├── supabase/         # Cliente
│   └── utils/            # format / tax / csv
├── stores/               # Zustand stores (period, data, auth)
├── styles/               # tokens / layout / components
└── types/                # Tipos del dominio + Database (Supabase)
supabase/
└── migrations/0001_initial.sql   # Esquema + RLS multi-tenant
```

## Decisiones para escalar

- **Vertical Slice por feature.** Cada módulo (`features/*`) tiene su page, sus formularios y eventualmente sus hooks/services. Mover/eliminar uno no rompe el resto.
- **Adapter pattern.** `LocalAdapter` y `SupabaseAdapter` implementan la misma interfaz. Migrar a la nube no toca la UI.
- **Tipos compartidos.** `types/domain.ts` (UI) y `types/supabase.ts` (DB) están desacoplados; los adapters traducen entre ambos.
- **Multi-tenant desde día 1.** El esquema usa `companies` con RLS, así un usuario futuro puede tener varias empresas (multi-RUC) sin migración destructiva.
- **CSV templates configurables.** Cada plantilla declara `headers`, `toRow`, `fromRow` y `sample`. Agregar un nuevo modelo es ~30 líneas en `lib/utils/csv.ts`.

## Scripts

| Comando | Descripción |
|---|---|
| `npm run dev` | Servidor de desarrollo en :5173 |
| `npm run build` | Build de producción |
| `npm run preview` | Sirve el build localmente |
| `npm run typecheck` | Validación de tipos sin emitir |
