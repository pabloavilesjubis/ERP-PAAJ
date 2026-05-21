# DTE Service · Hacienda El Salvador

Microservicio Node.js + TypeScript para emitir, anular y consultar Documentos
Tributarios Electrónicos (DTE) contra la API del Ministerio de Hacienda de
El Salvador.

## Tipos de DTE soportados

| Código | Tipo                              | Tipo de uso                                                    |
|--------|-----------------------------------|----------------------------------------------------------------|
| `01`   | FCF — Factura Consumidor Final    | Ventas a consumidor (precios CON IVA)                          |
| `03`   | CCF — Comprobante Crédito Fiscal  | Ventas a contribuyentes registrados (precios SIN IVA)          |
| `05`   | NC  — Nota de Crédito             | Ajustes/devoluciones sobre un CCF previo                       |
| `14`   | FSE — Sujeto Excluido             | Compras a personas sin NRC (servicios profesionales, etc.)     |
| —      | Anulación (evento v2)             | Invalida cualquiera de los anteriores                          |

## Arquitectura

```
ERP (Vite/React) ──HTTP──▶ dte-service (Node/TS) ──HTTP local──▶ firmador (Java sidecar)
                              │                                       │
                              │                                       └─ cert MH (.crt) — nunca sale
                              ▼
                          MH API (apitest.dtes.mh.gob.sv)
```

El **certificado del MH nunca toca el código Node** — vive aislado en el
contenedor del firmador. El servicio Node sólo conoce la contraseña del cert
para invocar al firmador por `localhost:8113`. Esta separación es la práctica
más segura: el firmador es el binario oficial del MH (probado contra su
algoritmo de firma), y aislarlo simplifica el blast radius de un incidente.

## Setup paso a paso

### 1. Imagen del firmador

`docker-compose.yml` usa la imagen oficial publicada por el MH:
`svfe/svfe-api-firmador:v20230109`. No hay que construirla — Docker la baja en
el primer `up`.

### 2. Colocar el certificado

El MH te entrega un archivo `.crt` (formato XML propietario, **no es PKCS#12**)
al activar facturación electrónica. Cópialo en `firmador/temp/<TU_NIT>.crt`:

```bash
mkdir -p firmador/temp
cp /ruta/al/cert/06140000000000.crt firmador/temp/06140000000000.crt
```

Ver `firmador/README.md` para detalles del formato del cert.

### 3. Configurar variables de entorno

```bash
cp .env.example .env
```

Edita `.env` y rellena:

| Variable                   | Descripción                                              |
|----------------------------|----------------------------------------------------------|
| `MH_ENV`                   | `sandbox` (apitest) o `production` (api)                 |
| `MH_NIT`                   | NIT del contribuyente, 14 dígitos sin guiones            |
| `MH_PASSWORD`              | Clave del **API** entregada por el MH (no la del cert)   |
| `FIRMADOR_PASSWORD`        | Contraseña de la **clave privada del cert**              |
| `EMISOR_*`                 | Datos del emisor (NRC, código actividad, dirección)      |
| `PUNTO_VENTA_*`            | Códigos para construir `numeroControl`                   |

### 4. Levantar todo con Docker Compose

```bash
docker compose up -d --build
```

Verificar:
```bash
curl http://localhost:3000/health
# {"status":"ok","mhEnv":"sandbox","time":"..."}
```

### 5. Modo dev (sin Docker)

```bash
npm install
# Asegúrate de tener el firmador corriendo aparte:
docker compose up -d firmador
npm run dev
```

### 6. Tests

```bash
npm test            # vitest run
npm run typecheck   # tsc --noEmit
```

## Uso del API

### Emitir un FCF (Factura Consumidor)

```bash
curl -X POST http://localhost:3000/emit \
  -H "Content-Type: application/json" \
  -d '{
    "tipo": "fcf",
    "data": {
      "consecutivo": 1,
      "items": [{
        "tipoItem": 2,
        "cantidad": 1,
        "uniMedida": 59,
        "descripcion": "Consultoría",
        "precioUni": 113.00,
        "montoDescu": 0,
        "ventaNoSuj": 0,
        "ventaExenta": 0,
        "ventaGravada": 113.00,
        "tributos": null,
        "psv": 0,
        "noGravado": 0,
        "codigo": null,
        "codTributo": null,
        "numeroDocumento": null
      }]
    }
  }'
```

Respuesta:
```json
{
  "codigoGeneracion": "F47AC10B-58CC-4372-A567-0E02B2C3D479",
  "numeroControl": "DTE-01-C0010001-000000000000001",
  "estado": "PROCESADO",
  "selloRecibido": "20251234567890ABCDEF...",
  "dte": { ... },
  "documento": "eyJhbGciOiJSUzUxMi...",
  "mh": { ... }
}
```

### Emitir un CCF

```bash
curl -X POST http://localhost:3000/emit \
  -H "Content-Type: application/json" \
  -d '{
    "tipo": "ccf",
    "data": {
      "consecutivo": 1,
      "receptor": {
        "nit": "06141234567890",
        "nrc": "999999-1",
        "nombre": "ACME SA DE CV",
        "codActividad": "47711",
        "descActividad": "Comercio",
        "nombreComercial": null,
        "telefono": null,
        "correo": "billing@acme.sv",
        "direccion": { "departamento": "06", "municipio": "14", "complemento": "Calle X #123" }
      },
      "items": [{ ... ventaGravada SIN IVA ... }]
    }
  }'
```

### Emitir una Nota de Crédito (NC)

```bash
curl -X POST http://localhost:3000/emit \
  -H "Content-Type: application/json" \
  -d '{
    "tipo": "nc",
    "data": {
      "consecutivo": 1,
      "receptor": { ... mismo formato que CCF ... },
      "documentoRelacionado": [{
        "tipoDocumento": "03",
        "tipoGeneracion": 2,
        "numeroDocumento": "<codigoGeneracion del CCF original>",
        "fechaEmision": "2026-04-15"
      }],
      "items": [{ ... montos a acreditar ... }]
    }
  }'
```

### Emitir un Sujeto Excluido (FSE)

```bash
curl -X POST http://localhost:3000/emit \
  -H "Content-Type: application/json" \
  -d '{
    "tipo": "fse",
    "data": {
      "consecutivo": 1,
      "sujetoExcluido": {
        "tipoDocumento": "13",
        "numDocumento": "12345678-9",
        "nombre": "Juan Pérez",
        "codActividad": null,
        "descActividad": null,
        "telefono": null,
        "correo": null,
        "direccion": { "departamento": "06", "municipio": "14", "complemento": "X" }
      },
      "items": [{
        "tipoItem": 2, "cantidad": 1, "codigo": null, "uniMedida": 59,
        "descripcion": "Servicio profesional", "precioUni": 500, "montoDescu": 0,
        "compra": 500
      }],
      "reteRenta": 50
    }
  }'
```

### Anular un DTE

```bash
curl -X POST http://localhost:3000/annul \
  -H "Content-Type: application/json" \
  -d '{
    "tipoDte": "03",
    "codigoGeneracion": "<codigoGeneracion del DTE a anular>",
    "selloRecibido": "<sello del MH>",
    "numeroControl": "DTE-03-C0010001-000000000000001",
    "fecEmi": "2026-04-30",
    "montoIva": 14.69,
    "tipoDocumentoReceptor": "36",
    "numDocumentoReceptor": "06141234567890",
    "nombreReceptor": "ACME SA",
    "tipoAnulacion": 2,
    "motivoAnulacion": "Rescisión del contrato",
    "nombreResponsable": "Pablo Aviles",
    "tipDocResponsable": "13",
    "numDocResponsable": "12345678-9",
    "nombreSolicita": "ACME SA",
    "tipDocSolicita": "36",
    "numDocSolicita": "06141234567890"
  }'
```

## Errores

El servicio mapea errores a códigos estables:

| Código              | HTTP | Significado                                                     |
|---------------------|------|------------------------------------------------------------------|
| `VALIDATION`        | 400  | Body inválido / campos faltantes                                |
| `MH_REJECTED`       | 422  | El MH rechazó el DTE (ver `observaciones` en el response)       |
| `MH_AUTH_FAILED`    | 502  | Login al MH falló (credenciales)                                |
| `FIRMADOR_FAILED`   | 502  | Firmador rechazó el documento (cert vencido, password mal)      |
| `MH_TRANSIENT`      | 503  | 5xx/timeouts/red — agotó reintentos. El cliente debe reintentar |
| `INTERNAL`          | 500  | Bug en el servicio                                              |

## Ventanas operacionales (vigentes abril 2026)

| Documento     | Plazo de envío | Plazo de anulación |
|---------------|----------------|---------------------|
| FCF (01)      | 24 h           | 3 meses             |
| CCF (03)      | 24 h           | 24 h                |
| NC  (05)      | 24 h           | 24 h                |
| FSE (14)      | 24 h           | 24 h                |
| Contingencia  | 72 h           | n/a                 |

## Limitaciones del primer slice

- ✅ FCF, CCF, NC, FSE, Anulación
- ✅ Auth con cache de JWT (12h, MH dura 24h)
- ✅ Retry con backoff exponencial + jitter para 5xx/429
- ✅ Refresh automático de token al recibir 401
- ✅ Cert aislado en sidecar (imagen oficial del MH)
- ✅ **Validación AJV** contra los JSON Schemas oficiales del MH (`schemas/`).
   Se ejecuta antes de firmar — atrapa shape inválido localmente sin gastar
   firmador ni MH.
- ⚠️  **`totalEnLetras`** es placeholder — para producción, reemplaza por
   [`numero-a-letras`](https://www.npmjs.com/package/numero-a-letras) o un
   helper interno equivalente. Ver `src/dte/builders/common.ts`.
- ⚠️  **Envío por lote** (`/recepciondte/lote`, hasta ~500 DTEs) no implementado.
- ⚠️  **Eventos de contingencia** explícitos no implementados.
- ⚠️  Cuando consigas el cert del MH, **valida un envío real en sandbox antes
   de tocar producción**. El primer envío suele revelar reglas de validación
   no documentadas.

## Validación AJV contra schemas oficiales

`schemas/` contiene los JSON Schemas oficiales que el MH publica
(`fe-fc-v1.json`, `fe-ccf-v3.json`, `fe-nc-v3.json`, `fe-fse-v1.json`,
`anulacion-schema-v2.json`, etc.). Antes de firmar y enviar, cada DTE se valida
con AJV (`src/dte/validate.ts`). Si falla, el endpoint devuelve `400 VALIDATION`
con la lista detallada de errores:

```json
{
  "code": "VALIDATION",
  "message": "El DTE no cumple el schema oficial (ccf, 3 errores)",
  "details": {
    "schema": "ccf",
    "failures": [
      { "path": "/resumen", "keyword": "required",
        "message": "must have required property 'totalPagar'", "params": {...} }
    ]
  }
}
```

Los schemas son la fuente de verdad — si el MH los actualiza, reemplaza los
archivos en `schemas/` y los validators recargan al reiniciar el servicio.

## Estructura del repositorio

```
dte-service/
├── src/
│   ├── config.ts               · validación zod del entorno
│   ├── errors.ts               · jerarquía de errores
│   ├── index.ts                · entry Fastify
│   ├── routes.ts               · /health /emit /annul
│   ├── mh/
│   │   ├── auth.ts             · login + cache de JWT
│   │   ├── client.ts           · POST con retry/backoff
│   │   ├── submit.ts           · /fesv/recepciondte
│   │   └── annul.ts            · /fesv/anulardte
│   ├── signing/
│   │   └── firmador.ts         · llama al sidecar Java
│   └── dte/
│       ├── numero-control.ts   · formato + UUID
│       ├── types.ts            · TS types del esquema DTE
│       └── builders/
│           ├── common.ts
│           ├── fcf.ts          · Factura Consumidor (01)
│           ├── ccf.ts          · Crédito Fiscal (03)
│           ├── nc.ts           · Nota de Crédito (05)
│           ├── fse.ts          · Sujeto Excluido (14)
│           └── anulacion.ts    · evento de anulación (v2)
├── tests/                      · vitest unit tests
├── firmador/                   · sidecar Java (JAR + cert)
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── package.json
└── tsconfig.json
```

## Integración con el ERP

El ERP (Vite/React) consume este servicio por `fetch` desde la página de Ventas
o vía Supabase Edge Function que hace de proxy. Como `dte-service` y el ERP
viven en el mismo `docker compose`, el ERP puede llamar a
`http://dte-service:3000/emit` desde su backend, o `http://localhost:3000/emit`
desde el navegador en dev.

## Seguridad

- HTTPS en todas las llamadas a MH (forzado por la URL)
- Puertos 3000 y 8113 publicados sólo en `127.0.0.1` — nunca al exterior
- Cert MH aislado en contenedor del firmador (volumen read-only)
- Tokens y JWS firmados redactados en logs (ver `redact` en `src/index.ts`)
- Variables sensibles vía Docker env vars, nunca en repo
- Tokens cacheados en memoria 12h — no se persisten a disco

## Roadmap

1. Reemplazar `totalEnLetras` con librería real
2. Validación zod end-to-end del shape DTE (cuando se publiquen los schemas)
3. Endpoint `/batch` que mapee a `/fesv/recepciondte/lote`
4. Eventos de contingencia
5. Persistencia opcional de DTEs emitidos (ahora se devuelven al caller — el ERP los persiste)
6. Health check del firmador antes de aceptar `/emit`
7. Métricas Prometheus (latencia, tasa de errores por tipo de DTE)
