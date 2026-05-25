# PIPELINE ERP — Deploy guide (production-ready)

Setup completo paso a paso. Si seguís este doc tenés el SaaS funcionando.

## Pre-requisitos

- VM Linux con Docker + Docker Compose
- Cuenta gratis en Supabase (https://supabase.com)
- Dominio apuntando a la VM (ej. `api.pipeline-erp.com`)
- Frontend en Vercel (o cualquier static host)

## 1. Supabase setup

1. Crear proyecto nuevo en https://supabase.com → free tier.
2. **Authentication → Providers → Email**: habilitar password-based.
3. **Settings → API** → copiar:
   - `Project URL` → `SUPABASE_URL`
   - `anon public` → `SUPABASE_ANON_KEY` (frontend)
   - `service_role secret` → `SUPABASE_SERVICE_ROLE_KEY` (backend — **NUNCA al frontend**)
   - `JWT Secret` → `SUPABASE_JWT_SECRET` (backend — para validar JWTs)

## 2. Secrets en la VM

```bash
cd dte-service
mkdir -p secrets
openssl rand -base64 32 > secrets/postgres_password.txt

cat >> .env <<EOF
POSTGRES_PASSWORD=$(cat secrets/postgres_password.txt)
DATABASE_URL=postgres://pipeline:$(cat secrets/postgres_password.txt)@postgres:5432/pipeline_erp
TENANT_SECRETS_KEY=$(openssl rand -base64 32)
SUPABASE_URL=https://xxxxxxxxxxxxxxxxxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJI...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJI...
SUPABASE_JWT_SECRET=tu-jwt-secret-de-supabase
FIRMADOR_CERTS_DIR=/app/certs
CORS_ALLOWED_ORIGINS=https://app.pipeline-erp.com,http://localhost:5173
SIGNUP_ENABLED=true
EOF
```

> **Crítico**: `TENANT_SECRETS_KEY` cifra los passwords MH/firmador de cada tenant. **Si lo perdés, todos los tenants quedan ilegibles** y hay que re-onboard. Hacé backup en un password manager.

## 3. Levantar todo

```bash
docker compose up -d --build
# Espera ~30s a que postgres esté healthy
docker compose exec dte-service npm run db:migrate
```

Verificá:
```bash
docker compose exec postgres psql -U pipeline -d pipeline_erp \
  -c "SELECT version FROM schema_migrations ORDER BY version"
# debe listar: 001_initial, 002_seed_paaj_tenant, 003_rls_policies
```

## 4. Migrar PAAJ como tenant_id=1

```bash
docker compose exec dte-service npm run paaj:migrate
# Opcional: importa también el histórico de DTEs
docker compose exec dte-service npm run paaj:migrate:full
```

Verificá:
```bash
curl http://localhost:3000/v2/me  # debe responder 401 sin auth — correcto
```

## 5. Crear primer usuario admin para PAAJ

En el dashboard Supabase → Authentication → Users → "Add user":
- Email: `pabloavilesjubis@gmail.com`
- Password: el que quieras
- **User Metadata** (JSON): vacío
- **App Metadata** (JSON):
  ```json
  { "tenant_id": 1, "role": "admin" }
  ```

Importante: `app_metadata.tenant_id` es lo que el backend lee del JWT.

## 6. Frontend en Vercel

En Vercel → Project Settings → Environment Variables:

```
VITE_SUPABASE_URL=https://xxxxxxxxxxxxxxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJI...
VITE_DTE_SERVICE_URL=https://api.pipeline-erp.com
VITE_DATA_ADAPTER=api
VITE_PRODUCT_NAME=PIPELINE ERP
```

Redeploy. Después de `git push`:

1. Visitar `https://app.pipeline-erp.com`
2. SignInPage → ingresar con el email/password creado en Supabase
3. Como `tenant_id` ya está en el JWT, entrás directo al dashboard con tus datos PAAJ.

## 7. Onboarding de un cliente nuevo

1. Cliente abre `https://app.pipeline-erp.com`
2. Click **"Crear cuenta"** → email + password → confirma vía email
3. Login → ve "Onboarding pendiente" → click "Iniciar onboarding"
4. Wizard 4 pasos:
   1. Empresa (nombre, NRC, actividad)
   2. Ubicación (depto/municipio/dirección)
   3. MH (NIT, contraseñas, upload `.crt`, códigos establecimiento)
   4. Correlativos (último histórico por tipo, o 0 si nuevo)
5. Click **"Completar onboarding"** → el backend:
   - Crea `tenants`, `tenant_emisor`, `users`, `tenant_correlativos` (TX)
   - Copia el `.crt` al firmador
   - Llama Supabase Admin API → setea `app_metadata.tenant_id` en el JWT
   - El frontend hace `refreshSession` automático → entra al dashboard

## 8. Estructura final

```
VM (Docker Compose)
├── postgres:16-alpine        — DB multi-tenant
├── svfe-api-firmador          — firma con cert de cada tenant
└── dte-service                — API Node/Fastify

Vercel
└── frontend (Vite + React)    — un único dominio, multi-tenant
                                  vía JWT.app_metadata.tenant_id

Supabase (cloud)
└── Authentication             — signup/login/recovery
                                  emite JWT con tenant_id en app_metadata
```

## 9. Endpoints disponibles

### Legacy single-tenant (PAAJ pre-SaaS — sigue activo)
| Method | Path | Notas |
|---|---|---|
| POST | `/emit` | POS desde ERP UI legacy |
| POST | `/dte/emitir` | BEON, requiere X-API-Key |
| POST | `/annul`, `/dte/anular` | anulaciones |

### Multi-tenant v2 (requiere JWT Supabase)
| Method | Path | Notas |
|---|---|---|
| GET | `/v2/me`, `/v2/me/full` | info del user + tenant |
| POST | `/v2/dte/emit` | emisión multi-tenant |
| GET | `/v2/dte/listar` | DTEs del tenant |
| GET | `/v2/correlativos/listar` | estado de correlativos |
| POST | `/v2/correlativos/sembrar` | seed administrativo |
| POST | `/v2/onboarding/test-mh` | valida creds MH antes de completar |
| POST | `/v2/onboarding/cert` | sube `.crt` (multipart o JSON base64) |
| POST | `/v2/onboarding/complete` | crea tenant + emisor + correlativos |
| GET, POST, PUT, DELETE | `/v2/ventas[/id]` | CRUD ventas |
| GET, POST, PUT, DELETE | `/v2/compras[/id]` | CRUD compras |
| GET, POST, PUT, DELETE | `/v2/contribuyentes[/id]` | CRUD catálogo de clientes |
| GET, POST, PUT, DELETE | `/v2/productos[/id]` | CRUD productos |

Todas las v2 son scoped por `tenant_id` desde el JWT — el cliente JAMÁS manda tenant_id en el body.

## 10. Verificación end-to-end

Una vez deployed:

```bash
# 1. Health
curl https://api.pipeline-erp.com/health

# 2. Login en frontend
# 3. Capturar JWT del browser (DevTools → Application → localStorage → sb-xxx-auth-token)
TOKEN="eyJhbGc..."

# 4. /me debe responder con tenant_id
curl -H "Authorization: Bearer $TOKEN" https://api.pipeline-erp.com/v2/me
# → { "user": {...}, "tenant_id": 1, "tenant_slug": "paaj" }

# 5. Correlativos del tenant
curl -H "Authorization: Bearer $TOKEN" https://api.pipeline-erp.com/v2/correlativos/listar
```

## 11. Lo que está hecho

✅ **Schema completo** — 9 tablas con constraints, triggers, RLS
✅ **Correlativos atómicos** — Postgres `SELECT FOR UPDATE` (sin mutex in-process, soporta horizontal scaling)
✅ **Encryption AES-256-GCM** — passwords MH/firmador cifrados en DB
✅ **Multi-tenant routing** — JWT Supabase + cross-check con path `/t/<slug>`
✅ **Tenant-aware emisión** — `/v2/dte/emit` lee emisor del DB, firma con cert del tenant, somete con sus creds MH
✅ **CRUD v2 completo** — ventas, compras, contribuyentes, productos
✅ **Onboarding wizard** — 4 pasos, valida creds MH antes de activar
✅ **Supabase Admin API** — setea `tenant_id` en JWT automáticamente (sin logout/login)
✅ **api-adapter frontend** — load + DIFF-save contra `/v2/*`, server IDs en Map externo
✅ **BrandingProvider auto-load** — branding del tenant desde `/v2/me/full`, aplica CSS vars + título
✅ **Rebrand** — "PIPELINE ERP" en title, SignInPage, sidebar logo
✅ **AuthGate** — redirige a SignInPage si no hay sesión; a /onboarding si no hay tenant
✅ **Multipart real** — `@fastify/multipart` para upload `.crt`
✅ **Sandbox test** — endpoint que valida creds MH antes de completar onboarding
✅ **RLS** — políticas creadas en Postgres; backend usa role BYPASSRLS
✅ **Migración PAAJ** — script idempotente que importa todo
✅ **Audit log multi-tenant** — `audit_events` con tenant_id, todos los eventos críticos
✅ **Verificado**: typecheck 0 errores (frontend + backend), 30/30 tests pasan

## 12. Lo que queda como hardening futuro (no bloquea deploy)

🔒 **Rate limiting por tenant** — agregar `@fastify/rate-limit` con key=`tenantId`
🔒 **Rotación de `TENANT_SECRETS_KEY`** — script `rotate-tenant-key.ts` que re-encripta todos los `*_enc`
🔒 **Backup automático** — `pg_dump` diario al S3 o storage local
🔒 **Webhook outbound** — para que tenants reciban callbacks cuando MH responde
🔒 **Page Visibility throttling del polling** — ya está, pero verificar en prod que no martillea
🔒 **Soft-delete** — el DELETE actual es hard; agregar `deleted_at` para retention legal
🔒 **Backfill de PAAJ ventas a Postgres** — el `paaj:migrate` solo importa DTEs; las ventas/compras viven en localStorage del navegador

## 13. Troubleshooting

**"CORRELATIVO_NOT_SEEDED"** → el tenant no terminó onboarding paso 4. Resolver: ir a Correlativos en el ERP y sembrar, o curl `/v2/correlativos/sembrar`.

**"TENANT_UNRESOLVED"** → JWT no trae `app_metadata.tenant_id`. Resolver: setear manualmente en Supabase Dashboard, o re-correr el onboarding (que llama Admin API).

**"TENANT_MISMATCH"** → el path `/t/<slug>` no corresponde al `tenant_id` del JWT. Resolver: re-loguear o navegar al slug correcto.

**Cert no firma** → verificar que `dte-service/firmador/temp/<NIT>.crt` existe. El multipart upload lo copia a `/app/certs/<NIT>.crt` montado del filesystem del firmador.

**MH rechaza con "DATO NO COINCIDE"** → bug viejo del FCF anónimo. Ver mensajes previos del proyecto.
