# PIPELINE ERP — Arquitectura multi-tenant

Documento vivo. Actualizar a medida que avanzamos las fases.

## Stack locked

| Capa | Tecnología |
|---|---|
| Frontend | Vite + React + Zustand. Hosted en Vercel. |
| Routing | Path-based: `pipeline-erp.com/t/<slug>/...` |
| API/Backend | Node 20 + Fastify, multi-tenant. Docker Compose en VM. |
| Database | Postgres 16 self-hosted (volumen `pg-data`). |
| Auth | Supabase Auth cloud (free tier). JWT HS256 validado server-side. |
| Firmador MH | Single `svfe-api-firmador` con multi-cert en `/uploads/<NIT>.crt`. |
| Storage de archivos | Filesystem (`/app/data/files/`) para PDFs, JSONs, tickets. |
| Encryption-at-rest | AES-256-GCM para `mh_password`, `firmador_password` con key en `TENANT_SECRETS_KEY`. |

## Aislación de datos

- **Cada fila lleva `tenant_id`.** Sin excepción. `WHERE tenant_id = $X` obligatorio.
- **Middleware** `requireAuth` inyecta `req.tenantId` desde el JWT (`app_metadata.tenant_id`).
- **Cross-check** opcional con el path `/t/<slug>` — si no coinciden → 403 TENANT_MISMATCH.
- **Defensa en profundidad** (futuro): Postgres RLS activado, policies por `current_setting('app.tenant_id')`.

## Modelo de datos

Ver `dte-service/db/migrations/001_initial.sql`. Tablas:

```
tenants              (id, slug, nombre_legal, nombre_comercial, status, brand_config)
tenant_emisor        (tenant_id PK, mh_*_enc, cert_path, emisor_*, punto_venta_*)
tenant_correlativos  (tenant_id, tipo_dte) — UNA secuencia atómica por tenant×tipo
users                (id UUID, email, tenant_id, role)
dtes                 (id, tenant_id, codigo_generacion UNIQUE, numero_control UNIQUE, …)
ventas               (id, tenant_id, kind, dte_id, monto/gravado/exento, …)
compras              (id, tenant_id, …)
contribuyentes       (id, tenant_id, …)
productos            (id, tenant_id, …)
audit_events         (id, tenant_id, event_type, payload jsonb)
```

**Correlativos atómicos**: reemplazan el mutex in-process por `SELECT ... FOR UPDATE` dentro de una transacción Postgres. Esto desbloquea horizontal scaling — ya no estamos limitados a una instancia.

## Flujo de emisión multi-tenant

```
[Frontend autenticado]
  POST /t/acme/dte/emit  (Authorization: Bearer <jwt-supabase>)
       │
       ▼
[Middleware requireAuth]
  decoded JWT.app_metadata.tenant_id = 7
  path slug = 'acme' ✓ (cross-check pasa)
  req.tenantId = 7
       │
       ▼
[Handler /dte/emit]
  emisor = await getEmisor(7)              // decripta mh_password, firmador_password
  consecutivo = await reservarCorrelativo(7, '01')  // tx Postgres FOR UPDATE
  dte = buildFcf(emisor, body)
  jws = await firmar(emisor.cert_path, emisor.firmador_password, dte)
  res = await submitDte(emisor.mh_nit, emisor.mh_password, jws)
  → si PROCESADO: consumirCorrelativo + INSERT dtes + INSERT ventas
  → si RECHAZADO: devolverCorrelativo + audit_events log
       │
       ▼
{ codigo_generacion, numero_control, sello_recibido, … }
```

## Onboarding de un tenant nuevo

1. **Signup**: usuario se registra en Supabase Auth con email/password (UI propia).
2. **Wizard datos fiscales** (4 pasos):
   1. Datos del contribuyente: nombre legal, nombre comercial, NRC, actividad económica.
   2. Ubicación: departamento, municipio, dirección.
   3. Códigos MH: NIT, password Hacienda, password del cert privado, sube `.crt`, `EMISOR_COD_ESTABLE_MH`, `EMISOR_COD_PUNTO_VENTA_MH`, `PUNTO_VENTA_ESTABLECIMIENTO`, `PUNTO_VENTA_PUNTO`.
   4. Seed correlativos: tipoDte→último consecutivo histórico (o 0 si nunca emitió).
3. **Validación**: el server hace un emit de prueba en sandbox MH para confirmar que el cert + credenciales funcionan.
4. **Activación**: si todo OK, `tenants.status` pasa a `'active'` y el usuario puede operar.

## Estado actual del proyecto

- ✅ Schema inicial (migrations/001_initial.sql, 002_seed_paaj_tenant.sql)
- ✅ Docker Compose con Postgres + secret de password
- ✅ Cliente pg + runner de migraciones (`npm run db:migrate`)
- ✅ Encryption AES-256-GCM para secrets del tenant
- ✅ Repo CRUD tenants + emisor
- ✅ JWT Supabase validation + middleware `requireAuth`
- 🚧 **Próximo turno**: refactor de `routes.ts` y `beon/routes.ts` para usar `req.tenantId` en vez de `cfg` global
- 🚧 Refactor de `Storage` filesystem → Postgres-backed (gradual: emisor + correlativos primero, luego dtes/ventas)
- 🚧 Endpoint `POST /onboarding` + UI wizard
- 🚧 Rebrand frontend (quitar "AIRBOX/PAAJ/Pablo"), `pipeline-erp.com`
- 🚧 Branding dinámico desde `tenants.brand_config`
- 🚧 Migración del PAAJ actual: leer `.env`, insertar como tenant_id=1, leer correlativos del filesystem, importar dtes existentes

## Deploy

```bash
# En la VM, por primera vez:
cd dte-service
mkdir -p secrets
openssl rand -base64 32 > secrets/postgres_password.txt
echo "TENANT_SECRETS_KEY=$(openssl rand -base64 32)" >> .env
echo "SUPABASE_URL=…" >> .env
echo "SUPABASE_ANON_KEY=…" >> .env
echo "SUPABASE_JWT_SECRET=…" >> .env

docker compose up -d --build       # postgres + firmador + dte-service
npm run db:migrate:prod             # aplica db/migrations/*.sql en orden
```

## Decisiones críticas tomadas

| # | Decisión | Razón |
|---|---|---|
| 1 | Postgres self-hosted en la VM (no Supabase managed para data) | Datos fiscales en la jurisdicción del cliente, control total |
| 2 | Supabase Auth cloud (solo auth) | UX de signup/recovery probada, JWT HS256 simple de validar |
| 3 | Path-based routing `/t/<slug>` | Sin requisitos de wildcard DNS, simple operación |
| 4 | Cert MH en filesystem `/app/data/certs/<NIT>.crt` (read-only mount al firmador) | El firmador requiere acceso por path; encriptar el filesystem entero queda como hardening futuro |
| 5 | AES-256-GCM para mh_password/firmador_password en DB | Defiende contra dump de DB sin la key |
| 6 | PAAJ migra como tenant_id=1 | Cero pérdida de datos. Onboarding solo afecta tenants nuevos |
