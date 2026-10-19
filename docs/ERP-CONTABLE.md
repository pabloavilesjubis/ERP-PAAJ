# ERP contable — módulos y convenciones

Módulos contables portados desde ChuchoWash y generalizados para cualquier
empresa (tenant). Este documento se actualiza al cerrar cada fase.

| Fase | Módulo | Estado |
|---|---|---|
| F0 | Fundaciones: roles y permisos, usuarios por empresa, migraciones, tests, CI | ✅ |
| F1 | Núcleo contable: catálogo, asientos, partidas, períodos, diario, mayor, balanza | ✅ |
| F2 | Ventas/compras contabilizadas, CxC y CxP | ⏳ |
| F3 | Estados financieros y cierres | ⏳ |
| F4 | Bancos y conciliación | ⏳ |
| F5 | Planillas | ⏳ |
| F6 | Posición fiscal, DTEs recibidos, importaciones, activos fijos | ⏳ |

## Despliegue

1. **Migraciones**: `dte-service/db/migrations/005+` se aplican con el runner
   contra la base de producción (Supabase):

   ```bash
   cd dte-service
   docker compose exec dte-service node dist/src/db/migrate.js
   ```

   El runner envuelve cada archivo en una transacción y registra la versión en
   `schema_migrations`; si algo falla no queda nada a medias.
2. **Backend**: `docker compose up -d --build dte-service` en la VM.
3. **Frontend**: push a `main` → Vercel.

Orden: migraciones → backend → frontend.

## Roles y permisos (F0)

Cada empresa administra sus usuarios (`/usuarios`). Los permisos por rol viven
en `dte-service/src/auth/permissions.ts` y el frontend los consulta en
`GET /v2/me/permissions`.

| Rol | Puede |
|---|---|
| admin | todo, incluida la gestión de usuarios |
| contador | contabilidad completa, cierres, fiscal, bancos, CxC/CxP, activos, ver planillas |
| auxiliar | partidas, cobros, pagos, conciliaciones (no cierra ni configura) |
| rrhh | planillas, empleados, liquidaciones |
| cajero | facturación y ventas |
| viewer | consulta |

Un usuario desactivado o una empresa suspendida pierden acceso de inmediato
(el middleware verifica el estado con un cache de 30 s).

## Núcleo contable (F1) — migración 006

Esquema `accounting`:

| Tabla | Para qué |
|---|---|
| `accounts` | Catálogo de cada empresa (código con puntos, guiones o solo dígitos; padre por prefijo) |
| `role_definitions` / `account_roles` | Funciones contables (IVA débito, clientes, banco…) → cuenta de la empresa |
| `journal_entries` / `journal_lines` | Asientos. Cuadre al COMMIT, inmutables una vez contabilizados |
| `periods` | Cierre mensual: un mes cerrado no admite registros ni anulaciones |
| `counters` | Numeración de asientos y documentos internos |

Funciones clave: `create_entry` (idempotente por documento+evento),
`reverse_entry` (reversión en la fecha original si el período sigue abierto),
`reverse_source`, `save_manual_entry` / `post_manual_entry`,
`import_accounts`, `account_movements`, `account_ledger`.

Pantallas: Asientos, Libros (diario, mayor, balanza), Catálogo (importación
CSV con vista previa), Períodos, Configuración contable. Una empresa nueva:
1) importa su catálogo, 2) asigna las cuentas por función, 3) registra sus
saldos iniciales (CSV codigo,debe,haber → partida de apertura en borrador).

## Convenciones del backend

- Los módulos nuevos viven en `dte-service/src/erp/` y se registran como
  plugins encapsulados (`authedPlugin`), con permisos por ruta
  (`requirePerm('accounting:post')`).
- La lógica contable vive en funciones de Postgres (esquemas `accounting`,
  `payroll`) que reciben `p_tenant` y `p_user` explícitos. La base garantiza
  cuadre, inmutabilidad de asientos contabilizados e idempotencia.
- Errores de negocio se lanzan con `RAISE ... USING ERRCODE = '22023'` y el
  manejador global los devuelve como 400 con el mensaje en español.
- Bodies validados con zod (`parse`).
- Consultas con `q()` (src/erp/http.ts): BIGINT/NUMERIC llegan como number y
  DATE como 'YYYY-MM-DD'. Las transacciones con `tx(fn, ctx)` fijan
  `app.user_id` / `app.user_name` para la bitácora de asientos.

## Convenciones del frontend

- Los módulos contables NO usan el `data.store` (que carga todo al iniciar):
  cada pantalla consulta su endpoint paginado con TanStack Query.
- Menú filtrado por permiso (`perm` en `AppShell.NAV`).

## Tests

```bash
cd dte-service
npm run test:db:up   # una vez: Postgres de pruebas en 127.0.0.1:55432
npm run test:db      # unitarios + integración contra la base de pruebas
```

La base de pruebas se recrea en cada corrida desde `db/test/base_schema.sql`
(copia del esquema de producción) + migraciones.
