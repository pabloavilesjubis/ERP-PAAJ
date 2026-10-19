import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import path from 'node:path';
import { invalidateAccountStatus, requireAuth } from '../auth/auth.middleware.js';
import { isPlatformAdmin } from '../auth/platform-admin.js';
import { query, withTx } from '../db/client.js';
import { encryptSecret } from '../auth/crypto.js';
import { hashPassword, newUserId, verifyPassword } from '../auth/local-auth.js';
import { ROLES } from '../auth/permissions.js';
import * as correlativos from '../tenants/correlativo.repo.js';
import { ValidationError } from '../errors.js';

/**
 * Consola de PLATAFORMA (super-admin). Crear y controlar tenants del SaaS.
 * Todas las rutas /v2/admin/* exigen un usuario en PLATFORM_ADMIN_EMAILS.
 *
 *   GET    /v2/admin/tenants              — lista todas las empresas con su actividad
 *   POST   /v2/admin/tenants              — crea tenant + usuario admin (+ emisor y correlativos opcionales)
 *   GET    /v2/admin/tenants/:id          — detalle: empresa, emisor (sin claves), usuarios, correlativos
 *   PUT    /v2/admin/tenants/:id          — edita slug, nombres y/o estado
 *   PUT    /v2/admin/tenants/:id/emisor   — crea o edita los datos fiscales (claves vacías = conservar)
 *   DELETE /v2/admin/tenants/:id          — elimina una empresa sin actividad fiscal (reconfirma contraseña)
 *   POST   /v2/admin/tenants/:id/users    — agrega un usuario a la empresa
 *   PUT    /v2/admin/users/:id            — rol, nombre, activo
 *   POST   /v2/admin/users/:id/password   — nueva contraseña
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
  emisor: EmisorSchema.nullable().optional(),
  correlativos: z.array(z.object({
    tipo_dte: z.enum(['01', '03', '05', '14']),
    ultimo_consumido: z.number().int().min(0),
  })).default([]),
});

const EMISOR_COLS = ['mh_env', 'mh_nit', 'emisor_nrc', 'emisor_nombre', 'emisor_cod_actividad', 'emisor_desc_actividad',
  'emisor_tipo_establecimiento', 'emisor_departamento', 'emisor_municipio', 'emisor_complemento', 'emisor_telefono', 'emisor_email',
  'punto_venta_establecimiento', 'punto_venta_punto', 'emisor_cod_estable_mh', 'emisor_cod_punto_venta_mh'] as const;

const tenantIdOf = (req: FastifyRequest) => {
  const id = parseInt((req.params as { id: string }).id, 10);
  if (!Number.isFinite(id)) throw new ValidationError('id inválido');
  return id;
};

async function audit(tenantId: number | null, userId: string | undefined, event: string, payload: unknown): Promise<void> {
  await query(`INSERT INTO audit_events (tenant_id, user_id, event_type, payload) VALUES ($1, $2, $3, $4::JSONB)`,
    [tenantId, userId ?? null, event, JSON.stringify(payload)]);
}

async function insertEmisor(client: { query: typeof query }, tenantId: number, e: z.infer<typeof EmisorSchema>): Promise<void> {
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
    tenantId, e.mh_env, e.mh_nit,
    encryptSecret(e.mh_password), encryptSecret(e.firmador_password), path.join(FIRMADOR_CERTS_DIR, `${e.mh_nit}.crt`),
    e.emisor_nrc, e.emisor_nombre, e.emisor_cod_actividad, e.emisor_desc_actividad,
    e.emisor_tipo_establecimiento, e.emisor_departamento, e.emisor_municipio,
    e.emisor_complemento, e.emisor_telefono ?? null, e.emisor_email,
    e.punto_venta_establecimiento, e.punto_venta_punto,
    e.emisor_cod_estable_mh ?? null, e.emisor_cod_punto_venta_mh ?? null,
  ]);
}

/** Conteo de una tabla por tenant; 0 si la tabla no existe todavía (migraciones pendientes). */
async function countOf(table: string, tenantId: number, extra = ''): Promise<number> {
  const exists = await query<{ t: string | null }>('SELECT to_regclass($1) AS t', [table]);
  if (!exists.rows[0]?.t) return 0;
  const r = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 ${extra}`, [tenantId]);
  return r.rows[0]?.n ?? 0;
}

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

  // ── Listar empresas con su actividad ────────────────────────────────────────
  app.get('/v2/admin/tenants', async (_req, reply) => {
    const res = await query(`
      SELECT t.id, t.slug, t.nombre_legal, t.nombre_comercial, t.status, t.created_at,
             (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id) AS users,
             (SELECT max(u.last_login_at) FROM users u WHERE u.tenant_id = t.id) AS last_login_at,
             EXISTS (SELECT 1 FROM tenant_emisor e WHERE e.tenant_id = t.id) AS has_emisor,
             (SELECT e.mh_nit FROM tenant_emisor e WHERE e.tenant_id = t.id) AS nit,
             (SELECT e.mh_env FROM tenant_emisor e WHERE e.tenant_id = t.id) AS mh_env,
             (SELECT count(*)::int FROM dtes d WHERE d.tenant_id = t.id) AS dtes,
             (SELECT count(*)::int FROM dtes d WHERE d.tenant_id = t.id AND d.fec_emi >= date_trunc('month', CURRENT_DATE)) AS dtes_month,
             (SELECT max(d.fec_emi) FROM dtes d WHERE d.tenant_id = t.id) AS last_dte,
             (SELECT count(*)::int FROM ventas v WHERE v.tenant_id = t.id) AS ventas,
             (SELECT count(*)::int FROM compras c WHERE c.tenant_id = t.id) AS compras
        FROM tenants t
       ORDER BY t.id
    `);
    return reply.send({ items: res.rows });
  });

  // ── Detalle ─────────────────────────────────────────────────────────────────
  app.get('/v2/admin/tenants/:id', async (req, reply) => {
    const id = tenantIdOf(req);
    const t = await query('SELECT id, slug, nombre_legal, nombre_comercial, status, created_at, updated_at FROM tenants WHERE id = $1', [id]);
    if (!t.rows.length) throw new ValidationError('Empresa no encontrada');
    const e = await query(`SELECT ${EMISOR_COLS.join(', ')}, cert_path, updated_at FROM tenant_emisor WHERE tenant_id = $1`, [id]);
    const users = await query(`SELECT id, email, full_name, role, to_jsonb(users)->>'active' AS active, created_at, last_login_at
                                 FROM users WHERE tenant_id = $1 ORDER BY lower(email)`, [id]);
    const corr = await query('SELECT tipo_dte, seeded, ultimo_consumido FROM tenant_correlativos WHERE tenant_id = $1 ORDER BY tipo_dte', [id]);
    const counts = {
      dtes: await countOf('public.dtes', id), ventas: await countOf('public.ventas', id), compras: await countOf('public.compras', id),
      contribuyentes: await countOf('public.contribuyentes', id),
      asientos: await countOf('accounting.journal_entries', id, `AND status <> 'borrador'`),
      empleados: await countOf('payroll.employees', id),
    };
    return reply.send({
      tenant: t.rows[0],
      emisor: e.rows[0] ?? null,
      users: users.rows.map(u => ({ ...u, active: u.active !== 'false' })),
      correlativos: corr.rows,
      counts,
    });
  });

  // ── Crear empresa ───────────────────────────────────────────────────────────
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

    const pwHash = await hashPassword(b.admin.password);
    const userId = newUserId();

    const tenantId = await withTx(async (client) => {
      const tRes = await client.query<{ id: number }>(`
        INSERT INTO tenants (slug, nombre_legal, nombre_comercial, status, brand_config)
        VALUES ($1, $2, $3, 'active', '{}'::JSONB)
        RETURNING id
      `, [b.tenant.slug, b.tenant.nombre_legal, b.tenant.nombre_comercial ?? null]);
      const newTenantId = tRes.rows[0]!.id;
      if (b.emisor) await insertEmisor(client as unknown as { query: typeof query }, newTenantId, b.emisor);
      await client.query(`
        INSERT INTO users (id, email, password_hash, tenant_id, role, full_name)
        VALUES ($1, $2, $3, $4, 'admin', $5)
      `, [userId, b.admin.email, pwHash, newTenantId, b.admin.full_name ?? null]);
      return newTenantId;
    });

    if (b.emisor) {
      for (const c of b.correlativos) {
        await correlativos.sembrar(tenantId, c.tipo_dte, c.ultimo_consumido, req.auth?.email ?? 'platform-admin');
      }
    }
    await audit(tenantId, req.auth?.userId, 'TENANT_CREATED_BY_ADMIN', { slug: b.tenant.slug, by: req.auth?.email, admin_email: b.admin.email });
    req.log.info({ audit: 'TENANT_CREATED_BY_ADMIN', tenantId, slug: b.tenant.slug, by: req.auth?.email }, 'tenant creado por admin');
    return reply.send({ success: true, tenant_id: tenantId, slug: b.tenant.slug, admin_email: b.admin.email });
  });

  // ── Editar empresa (slug, nombres, estado) ──────────────────────────────────
  app.put('/v2/admin/tenants/:id', async (req, reply) => {
    const id = tenantIdOf(req);
    const b = z.object({
      slug: z.string().min(2).max(32).regex(/^[a-z0-9-]+$/, 'Slug: minúsculas, números y guiones').optional(),
      nombre_legal: z.string().trim().min(2).optional(),
      nombre_comercial: z.string().trim().nullable().optional(),
      status: z.enum(['active', 'suspended', 'archived', 'pending_onboarding']).optional(),
    }).safeParse(req.body ?? {});
    if (!b.success) throw new ValidationError(b.error.issues[0]?.message ?? 'Datos inválidos');
    const v = b.data;
    if (id === 1 && v.status && v.status !== 'active') throw new ValidationError('No se puede suspender ni archivar el tenant 1 (PAAJ).');
    if (v.slug) {
      const dup = await query('SELECT 1 FROM tenants WHERE slug = $1 AND id <> $2', [v.slug, id]);
      if (dup.rows.length) throw new ValidationError(`El slug "${v.slug}" ya está en uso.`);
    }
    const res = await query<{ id: number }>(`
      UPDATE tenants SET slug = COALESCE($2, slug), nombre_legal = COALESCE($3, nombre_legal),
             nombre_comercial = CASE WHEN $4::boolean THEN $5 ELSE nombre_comercial END,
             status = COALESCE($6, status), updated_at = NOW()
       WHERE id = $1 RETURNING id`,
      [id, v.slug ?? null, v.nombre_legal ?? null, 'nombre_comercial' in v, v.nombre_comercial ?? null, v.status ?? null]);
    if (res.rows.length === 0) throw new ValidationError(`Tenant ${id} no existe.`);
    if (v.status) invalidateAccountStatus();
    await audit(id, req.auth?.userId, 'TENANT_UPDATED_BY_ADMIN', { ...v, by: req.auth?.email });
    return reply.send({ success: true, id, status: v.status });
  });

  // ── Datos fiscales (emisor) ─────────────────────────────────────────────────
  app.put('/v2/admin/tenants/:id/emisor', async (req, reply) => {
    const id = tenantIdOf(req);
    const parsed = EmisorSchema.extend({ mh_password: z.string().optional(), firmador_password: z.string().optional() }).safeParse(req.body);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      throw new ValidationError(`${i?.path.join('.')}: ${i?.message}`, { issues: parsed.error.flatten() });
    }
    const e = parsed.data;
    const t = await query('SELECT 1 FROM tenants WHERE id = $1', [id]);
    if (!t.rows.length) throw new ValidationError('Empresa no encontrada');
    const existing = await query<{ mh_password_enc: string; firmador_password_enc: string }>(
      'SELECT mh_password_enc, firmador_password_enc FROM tenant_emisor WHERE tenant_id = $1', [id]);
    if (!existing.rows.length) {
      if (!e.mh_password || !e.firmador_password) throw new ValidationError('Para registrar los datos fiscales indica la clave API del MH y la del firmador');
      await insertEmisor({ query }, id, { ...e, mh_password: e.mh_password, firmador_password: e.firmador_password });
    } else {
      const vals = EMISOR_COLS.map(k => (e as Record<string, unknown>)[k] ?? null);
      await query(`
        UPDATE tenant_emisor SET ${EMISOR_COLS.map((k, i) => `${k} = $${i + 2}`).join(', ')},
               mh_password_enc = COALESCE($${EMISOR_COLS.length + 2}, mh_password_enc),
               firmador_password_enc = COALESCE($${EMISOR_COLS.length + 3}, firmador_password_enc),
               cert_path = $${EMISOR_COLS.length + 4}, updated_at = NOW()
         WHERE tenant_id = $1`,
        [id, ...vals, e.mh_password ? encryptSecret(e.mh_password) : null, e.firmador_password ? encryptSecret(e.firmador_password) : null,
         path.join(FIRMADOR_CERTS_DIR, `${e.mh_nit}.crt`)]);
    }
    await audit(id, req.auth?.userId, 'TENANT_EMISOR_UPDATED_BY_ADMIN', { nit: e.mh_nit, env: e.mh_env, by: req.auth?.email, passwords_changed: !!(e.mh_password || e.firmador_password) });
    return reply.send({ success: true });
  });

  // ── Eliminar empresa ────────────────────────────────────────────────────────
  // Solo empresas SIN actividad fiscal ni contable (prueba o creadas por error).
  // Una empresa con DTEs, ventas, compras o asientos se ARCHIVA: la ley obliga a
  // conservar los registros contables y tributarios.
  app.delete('/v2/admin/tenants/:id', async (req, reply) => {
    const id = tenantIdOf(req);
    const b = z.object({ confirm_slug: z.string(), password: z.string().min(1, 'Confirma con tu contraseña') }).safeParse(req.body ?? {});
    if (!b.success) throw new ValidationError(b.error.issues[0]?.message ?? 'Confirma con el slug y tu contraseña');
    if (id === 1) throw new ValidationError('El tenant 1 (PAAJ) no se puede eliminar.');
    const t = await query<{ slug: string }>('SELECT slug FROM tenants WHERE id = $1', [id]);
    if (!t.rows.length) throw new ValidationError('Empresa no encontrada');
    if (t.rows[0]!.slug !== b.data.confirm_slug.trim()) throw new ValidationError('El slug escrito no coincide con el de la empresa');
    const me = await query<{ password_hash: string | null; tenant_id: number }>('SELECT password_hash, tenant_id FROM users WHERE id = $1', [req.auth!.userId]);
    if (!me.rows[0]?.password_hash || !(await verifyPassword(b.data.password, me.rows[0].password_hash))) {
      return reply.code(403).send({ success: false, code: 'BAD_PASSWORD', message: 'Contraseña incorrecta' });
    }
    if (Number(me.rows[0].tenant_id) === id) throw new ValidationError('No puedes eliminar la empresa a la que pertenece tu propio usuario.');
    const counts = {
      dtes: await countOf('public.dtes', id), ventas: await countOf('public.ventas', id), compras: await countOf('public.compras', id),
      asientos: await countOf('accounting.journal_entries', id, `AND status <> 'borrador'`),
      planillas: await countOf('payroll.payrolls', id, `AND status <> 'borrador'`),
    };
    const busy = Object.entries(counts).filter(([, n]) => n > 0);
    if (busy.length) {
      return reply.code(409).send({
        success: false, code: 'TENANT_HAS_DATA',
        message: `La empresa tiene actividad (${busy.map(([k, n]) => `${n} ${k}`).join(', ')}): archívala en lugar de eliminarla; los registros fiscales y contables deben conservarse.`,
        details: counts,
      });
    }
    await withTx(async (client) => {
      // Borradores contables y configuración (los asientos contabilizados ya se descartaron arriba)
      if ((await client.query(`SELECT to_regclass('accounting.journal_entries') AS t`)).rows[0]?.t) {
        await client.query('DELETE FROM accounting.journal_entries WHERE tenant_id = $1', [id]);
      }
      await client.query('DELETE FROM audit_events WHERE tenant_id = $1', [id]);
      await client.query('DELETE FROM tenants WHERE id = $1', [id]);   // el resto cae en cascada
    });
    invalidateAccountStatus();
    await audit(null, req.auth?.userId, 'TENANT_DELETED_BY_ADMIN', { id, slug: t.rows[0]!.slug, by: req.auth?.email });
    req.log.warn({ audit: 'TENANT_DELETED_BY_ADMIN', id, slug: t.rows[0]!.slug, by: req.auth?.email }, 'tenant eliminado');
    return reply.send({ success: true });
  });

  // ── Usuarios de una empresa ─────────────────────────────────────────────────
  app.post('/v2/admin/tenants/:id/users', async (req, reply) => {
    const id = tenantIdOf(req);
    const b = z.object({
      email: z.string().trim().email('Email inválido'), full_name: z.string().trim().nullable().optional(),
      role: z.enum(ROLES), password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
    }).safeParse(req.body);
    if (!b.success) throw new ValidationError(b.error.issues[0]?.message ?? 'Datos inválidos');
    const dup = await query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [b.data.email]);
    if (dup.rows.length) throw new ValidationError(`El email ${b.data.email} ya está registrado.`);
    const uid = newUserId();
    await query(`INSERT INTO users (id, email, password_hash, tenant_id, role, full_name) VALUES ($1, $2, $3, $4, $5, $6)`,
      [uid, b.data.email, await hashPassword(b.data.password), id, b.data.role, b.data.full_name ?? null]);
    await audit(id, req.auth?.userId, 'USER_CREATED_BY_ADMIN', { id: uid, email: b.data.email, role: b.data.role, by: req.auth?.email });
    return reply.send({ id: uid });
  });

  app.put('/v2/admin/users/:id', async (req, reply) => {
    const uid = (req.params as { id: string }).id;
    const b = z.object({ role: z.enum(ROLES).optional(), full_name: z.string().trim().nullable().optional(), active: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!b.success) throw new ValidationError(b.error.issues[0]?.message ?? 'Datos inválidos');
    if (uid === req.auth?.userId && (b.data.active === false || (b.data.role && b.data.role !== 'admin'))) {
      throw new ValidationError('No puedes desactivarte ni quitarte el rol de administrador a ti mismo.');
    }
    const res = await query<{ tenant_id: number }>(`
      UPDATE users SET role = COALESCE($2, role), full_name = COALESCE($3, full_name), active = COALESCE($4, active)
       WHERE id = $1 RETURNING tenant_id`, [uid, b.data.role ?? null, b.data.full_name ?? null, b.data.active ?? null]);
    if (!res.rows.length) throw new ValidationError('Usuario no encontrado');
    invalidateAccountStatus(uid);
    await audit(res.rows[0]!.tenant_id, req.auth?.userId, 'USER_UPDATED_BY_ADMIN', { id: uid, ...b.data, by: req.auth?.email });
    return reply.send({ success: true });
  });

  app.post('/v2/admin/users/:id/password', async (req, reply) => {
    const uid = (req.params as { id: string }).id;
    const b = z.object({ password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres') }).safeParse(req.body);
    if (!b.success) throw new ValidationError(b.error.issues[0]?.message ?? 'Datos inválidos');
    const res = await query<{ tenant_id: number }>('UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING tenant_id', [uid, await hashPassword(b.data.password)]);
    if (!res.rows.length) throw new ValidationError('Usuario no encontrado');
    await audit(res.rows[0]!.tenant_id, req.auth?.userId, 'USER_PASSWORD_RESET_BY_ADMIN', { id: uid, by: req.auth?.email });
    return reply.send({ success: true });
  });
}
