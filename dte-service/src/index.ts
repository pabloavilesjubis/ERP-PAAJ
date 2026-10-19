import 'dotenv/config';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import path from 'node:path';
import { loadConfig } from './config.js';
import { errorHandler } from './http/error-handler.js';
import { registerRoutes } from './routes.js';
import { registerBeonRoutes } from './beon/routes.js';
import { Storage } from './beon/storage.js';

const cfg = loadConfig();

const app = Fastify({
  logger: {
    level: cfg.LOG_LEVEL,
    transport: cfg.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
    // No volcar tokens, JWS firmados ni API keys a logs.
    redact: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'res.body.documento',
    ],
  },
});

// CORS allow-list. Unifica las dos vars históricas:
//   - BEON_ALLOWED_ORIGINS (legacy single-tenant)
//   - CORS_ALLOWED_ORIGINS (multi-tenant PIPELINE ERP — frontend Vercel)
// Soporta wildcards globstar para subdominios:
//   - `https://*.vercel.app`  → matchea cualquier preview de Vercel
//   - `https://*.airboxpipeline.com`  → matchea subdominios propios
const allowedOriginsRaw = [
  ...cfg.BEON_ALLOWED_ORIGINS.split(','),
  ...(process.env.CORS_ALLOWED_ORIGINS ?? '').split(','),
].map(s => s.trim()).filter(Boolean);

// Convertimos cada entrada en una RegExp si lleva `*`, sino comparación literal.
// Ejemplo: 'https://*.vercel.app' → /^https:\/\/[^.]+\.vercel\.app$/
const allowedOriginPatterns = allowedOriginsRaw.map(raw => {
  if (!raw.includes('*')) return { literal: raw };
  const escaped = raw.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+');
  return { regex: new RegExp(`^${escaped}$`) };
});

function originAllowed(origin: string): boolean {
  for (const p of allowedOriginPatterns) {
    if ('literal' in p && p.literal && p.literal === origin) return true;
    if ('regex' in p && p.regex && p.regex.test(origin)) return true;
  }
  return false;
}

await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);              // requests no-CORS (curl, server-to-server)
    if (originAllowed(origin)) return cb(null, true);
    if (cfg.NODE_ENV !== 'production') return cb(null, true);  // dev: permissive
    return cb(null, false);
  },
  credentials: true,
  allowedHeaders: [
    'Content-Type',
    'Accept',
    'Authorization',
    'X-API-Key',
    'Idempotency-Key',
    'X-Tenant-Id',
    'X-Establecimiento-Id',
    'X-Punto-Venta-Id',
    'X-Caja-Id',
  ],
  exposedHeaders: ['Idempotency-Key'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});

// Antes de registrar rutas: los plugins encapsulados heredan este handler.
app.setErrorHandler(errorHandler);

// Storage inicializado antes de registrar rutas
const storage = new Storage(cfg.STORAGE_DIR);
await storage.init();

// Servir archivos generados (PDF, JSON, ticket) bajo /files/*
await app.register(fastifyStatic, {
  root: storage.filesDir(),
  prefix: '/files/',
  decorateReply: false,
  // Sin listing de directorio. Solo lectura de archivos por nombre.
  index: false,
  list: false,
  // Cache corto: los PDFs/JSON pueden regenerarse (rediseño de plantilla, etc.)
  // y no queremos que el navegador muestre versiones viejas durante horas.
  maxAge: 60_000,
});

// Rutas DTE existentes (consumidas por el ERP PAAJ) — necesitan storage
// para reservar/consumir correlativos desde el SoT único.
registerRoutes(app, cfg, storage);

// Rutas BEON (capa de compatibilidad)
registerBeonRoutes(app, cfg, storage);

// Rutas v2 multi-tenant (PIPELINE ERP SaaS). Gated por JWT Supabase + tenant
// resolution. Conviven con las legacy hasta que migremos todos los clientes.
if (process.env.DATABASE_URL) {
  const fastifyMultipart = (await import('@fastify/multipart')).default;
  await app.register(fastifyMultipart, {
    limits: { fileSize: 5 * 1024 * 1024 },   // 5 MB cap para certs MH
  });
  const { registerAuthRoutes } = await import('./v2/auth.routes.js');
  const { registerV2Routes } = await import('./v2/dte.routes.js');
  const { registerOnboardingRoutes } = await import('./v2/onboarding.routes.js');
  const { registerV2EntityRoutes } = await import('./v2/entity.routes.js');
  const { registerAdminRoutes } = await import('./v2/admin.routes.js');
  const { registerDocRoutes } = await import('./v2/doc.routes.js');
  const { registerErpModules } = await import('./erp/index.js');
  registerAuthRoutes(app);
  registerV2Routes(app, cfg);
  registerOnboardingRoutes(app);
  registerV2EntityRoutes(app);
  registerAdminRoutes(app);
  registerDocRoutes(app, cfg);
  await registerErpModules(app);
  app.log.info('v2 multi-tenant routes + auth local + onboarding + entity CRUD + admin activas');
} else {
  app.log.warn('DATABASE_URL ausente — rutas v2 multi-tenant deshabilitadas');
}

try {
  const addr = await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
  app.log.info(`DTE service listening on ${addr} · MH_ENV=${cfg.MH_ENV} · STORAGE_DIR=${cfg.STORAGE_DIR}`);
  app.log.info(`CORS allowed origins: ${allowedOriginsRaw.join(', ') || '(none — dev permissive)'}`);
  app.log.info(`BEON API-Key enforcement: ${cfg.BEON_API_KEY ? 'ON' : 'OFF (no key configured)'}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Aviso de uso por si alguien consulta el path:
void path;  // placeholder to keep import alive if future imports needed
