import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import path from 'node:path';
import { requireAuth } from '../auth/auth.middleware.js';
import { isPlatformAdmin } from '../auth/platform-admin.js';
import { query, withTx } from '../db/client.js';
import { encryptSecret } from '../auth/crypto.js';
import { hashPassword, newUserId } from '../auth/local-auth.js';
import * as correlativos from '../tenants/correlativo.repo.js';
import { ValidationError } from '../errors.js';

/**
 * Consola de PLATAFORMA (super-admin). Crear y controlar tenants del SaaS.
 * Todas las rutas /v2/admin/* exigen un usuario en PLATFORM_ADMIN_EMAILS.
 *
 *   GET   /v2/admin/tenants        — lista todas las empresas
 *   POST  /v2/admin/tenants        — crea tenant + emisor + usuario admin + correlativos
 *   PUT   /v2/admin/tenants/:id    — cambia estado (active|suspended|archived)
 *
 * El cert .crt se sube aparte vía /v2/onboarding/cert (por NIT) ANTES de crear.
 */

const FIRMADOR_CERTS_DIR = process.env.FIRMADOR_CERTS_DIR ?? '/app/certs';

const EmisorSchema = z.object({
  mh_env: z.enum(['sandbox', 'production']),
  mh_nit: z.string().regex(/^\d{14}$/),
  mh_password: z.string().min(1),
  firmador_password: z.string().min(1),
  emisor_nrc: z.string().min(1),
  emisor_nombre: z.string().min(1),
  emisor_cod_actividad: z.string().min(1),
  emisor_desc_actividad: z.string().min(1),
  emisor_tipo_establecimiento: z.string().regex(/^\d{2}$/),
  emisor_departamento: z.string().regex(/^\d{2}$/),
  emisor_municipio: z.string().regex(/^\d{2}$/),
  emisor_complemento: z.string().min(1),
  emisor_telefono: z.string().nullable().optional(),
  emisor_email: z.string().email(),
  punto_venta_establecimiento: z.string().regex(/^[A-Z0-9]{4}$/),
  punto_venta_punto: z.string().regex(/^[A-Z0-9]{4}$/),
  emisor_cod_estable_mh: z.string().regex(/^[A-Z0-9]{4}$/).nullable().optional(),
  emisor_cod_punto_venta_mh: z.string().regex(/^[A-Z0-9]{4}$/).nullable().optional(),
});

const CreateBody = z.object({
  tenant: z.object({
    slug: z.string().min(2).max(32).regex(/^[a-z0-9-]+$/),
    nombre_legal: z.string().min(2),
    nombre_comercial: z.string().nullable().optional(),
  }),
  admin: z.object({
    email: z.string().email(),
    password: z.string().min(8),
    full_name: z.string().nullable().optional(),
  }),
  emisor: EmisorSchema,
  correlativos: z.array(z.object({
    tipo_dte: z.enum(['01', '03', '05', '14']),
    ultimo_consumido: z.number().int().min(0),
  })).default([]),
});

export function registerAdminRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/v2/admin')) return;
    await requireAuth(req, reply);
    if (reply.sent) return;
    if (!isPlatformAdmin(req.auth?.email)) {
      reply.code(403).send({
        success: false, code: 'NOT_PLATFORM_ADMIN',
        message: 'Requiere super-admin de plataforma',
      });
      return reply;
    }
  });

  // ── Listar tenants ──────────────────────────────────────────────────────────
  app.get('/v2/admin/tenants', async (_req, reply) => {
    const res = await query(`
      SELECT t.id, t.slug, t.nombre_legal, t.nombre_comercial, t.status, t.created_at,
             (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id) AS users,
             EXISTS (SELECT 1 FROM tenant_emisor e WHERE e.tenant_id = t.id) AS has_emisor
        FROM tenants t
       ORDER BY t.id
    `);
    return reply.send({ items: res.rows });
  });

  // ── Crear tenant completo ───────────────────────────────────────────────────
  app.post('/v2/admin/tenants', async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Body inválido', { issues: parsed.error.flatten() });
    }
    const b = parsed.data;

    const slugC = await query<{ id: number }>('SELECT id FROM tenants WHERE slug = $1', [b.tenant.slug]);
    if (slugC.rows.length > 0) throw new ValidationError(`El slug "${b.tenant.slug}" ya está en uso.`);
    const emailC = await query<{ id: string }>('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [b.admin.email]);
    if (emailC.rows.length > 0) throw new ValidationError(`El email "${b.admin.email}" ya está registrado.`);

    const certPath = path.join(FIRMADOR_CERTS_DIR, `${b.emisor.mh_nit}.crt`);
    const pwHash = await hashPassword(b.admin.password);
    const userId = newUserId();
    const e = b.emisor;

    const tenantId = await withTx(async (client) => {
      const tRes = await client.query<{ id: number }>(`
        INSERT INTO tenants (slug, nombre_legal, nombre_comercial, status, brand_config)
        VALUES ($1, $2, $3, 'active', '{}'::JSONB)
        RETURNING id
      `, [b.tenant.slug, b.tenant.nombre_legal, b.tenant.nombre_comercial ?? null]);
      const newTenantId = tRes.rows[0]!.id;

      await client.query(`
        INSERT INTO tenant_emisor (
          tenant_id, mh_env, mh_nit, mh_password_enc, firmador_password_enc, cert_path,
          emisor_nrc, emisor_nombre, emisor_cod_actividad, emisor_desc_actividad,
          emisor_tipo_establecimiento, emisor_departamento, emisor_municipio,
          emisor_complemento, emisor_telefono, emisor_email,
          punto_venta_establecimiento, punto_venta_punto,
          emisor_cod_estable_mh, emisor_cod_punto_venta_mh
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      `, [
        newTenantId, e.mh_env, e.mh_nit,
        encryptSecret(e.mh_password), encryptSecret(e.firmador_password), certPath,
        e.emisor_nrc, e.emisor_nombre, e.emisor_cod_actividad, e.emisor_desc_actividad,
        e.emisor_tipo_establecimiento, e.emisor_departamento, e.emisor_municipio,
        e.emisor_complemento, e.emisor_telefono ?? null, e.emisor_email,
        e.punto_venta_establecimiento, e.punto_venta_punto,
        e.emisor_cod_estable_mh ?? null, e.emisor_cod_punto_venta_mh ?? null,
      ]);

      await client.query(`
        INSERT INTO users (id, email, password_hash, tenant_id, role, full_name)
        VALUES ($1, $2, $3, $4, 'admin', $5)
      `, [userId, b.admin.email, pwHash, newTenantId, b.admin.full_name ?? null]);

      return newTenantId;
    });

    for (const c of b.correlativos) {
      await correlativos.sembrar(tenantId, c.tipo_dte, c.ultimo_consumido, req.auth?.email ?? 'platform-admin');
    }

    await query(
      `INSERT INTO audit_events (tenant_id, user_id, event_type, payload)
       VALUES ($1, $2, 'TENANT_CREATED_BY_ADMIN', $3::JSONB)`,
      [tenantId, req.auth?.userId ?? null, JSON.stringify({ slug: b.tenant.slug, by: req.auth?.email, admin_email: b.admin.email })],
    );

    req.log.info({ audit: 'TENANT_CREATED_BY_ADMIN', tenantId, slug: b.tenant.slug, by: req.auth?.email }, 'tenant creado por admin');
    return reply.send({ success: true, tenant_id: tenantId, slug: b.tenant.slug, admin_email: b.admin.email });
  });

  // ── Cambiar estado (suspender / activar / archivar) ─────────────────────────
  app.put('/v2/admin/tenants/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const body = req.body as { status?: string } | null;
    const status = body?.status ?? '';
    if (!['active', 'suspended', 'archived', 'pending_onboarding'].includes(status)) {
      throw new ValidationError('status inválido (active|suspended|archived|pending_onboarding)');
    }
    if (id === 1) throw new ValidationError('No se puede cambiar el estado del tenant 1 (PAAJ).');
    const res = await query<{ id: number }>('UPDATE tenants SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id', [status, id]);
    if (res.rows.length === 0) throw new ValidationError(`Tenant ${id} no existe.`);
    return reply.send({ success: true, id, status });
  });
}
