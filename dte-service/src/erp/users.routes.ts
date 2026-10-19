import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalidateAccountStatus, requirePerm } from '../auth/auth.middleware.js';
import { hashPassword, newUserId } from '../auth/local-auth.js';
import { isPlatformAdmin } from '../auth/platform-admin.js';
import { permissionsOf, ROLE_LABELS, ROLES } from '../auth/permissions.js';
import { query } from '../db/client.js';
import { ValidationError } from '../errors.js';
import { authedPlugin, ctx, parse, tx } from './http.js';

/**
 * Usuarios de la empresa. El admin de cada empresa da de alta a su contador,
 * auxiliares, RRHH y cajeros; nadie ve usuarios de otra empresa.
 *
 *   GET  /v2/me/permissions       permisos del usuario actual (arma el menú)
 *   GET  /v2/users                lista (users:manage)
 *   POST /v2/users                alta
 *   PUT  /v2/users/:id            rol, nombre, activo
 *   POST /v2/users/:id/password   nueva contraseña
 */

const RoleEnum = z.enum(ROLES);

const CreateBody = z.object({
  email: z.string().trim().email('Email inválido'),
  full_name: z.string().trim().min(1, 'Indica el nombre').max(120),
  role: RoleEnum,
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
});

const UpdateBody = z.object({
  full_name: z.string().trim().min(1).max(120).optional(),
  role: RoleEnum.optional(),
  active: z.boolean().optional(),
});

const PasswordBody = z.object({ password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres') });

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  await authedPlugin(app, (r) => {
    r.get('/v2/me/permissions', async (req) => {
      const role = req.auth!.role;
      return {
        role,
        role_label: ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role,
        permissions: permissionsOf(role),
        is_platform_admin: isPlatformAdmin(req.auth!.email),
      };
    });

    r.get('/v2/users/roles', { preHandler: requirePerm('users:manage') }, async () => ({
      items: ROLES.map(role => ({ role, label: ROLE_LABELS[role], permissions: permissionsOf(role) })),
    }));

    r.get('/v2/users', { preHandler: requirePerm('users:manage') }, async (req) => {
      const { tenantId } = ctx(req);
      const res = await query(`
        SELECT id, email, full_name, role, active, created_at, last_login_at
          FROM users WHERE tenant_id = $1 ORDER BY active DESC, lower(email)`, [tenantId]);
      return { items: res.rows };
    });

    r.post('/v2/users', { preHandler: requirePerm('users:manage') }, async (req) => {
      const c = ctx(req);
      const b = parse(CreateBody, req.body);
      const dup = await query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [b.email]);
      if (dup.rows.length) throw new ValidationError(`El email ${b.email} ya está registrado en el sistema`);
      const id = newUserId();
      await query(`
        INSERT INTO users (id, email, password_hash, tenant_id, role, full_name, active, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7)`,
        [id, b.email, await hashPassword(b.password), c.tenantId, b.role, b.full_name, c.userId]);
      await audit(c.tenantId, c.userId, 'USER_CREATED', { id, email: b.email, role: b.role });
      return { id };
    });

    r.put('/v2/users/:id', { preHandler: requirePerm('users:manage') }, async (req) => {
      const c = ctx(req);
      const id = (req.params as { id: string }).id;
      const b = parse(UpdateBody, req.body);
      if (id === c.userId && (b.active === false || (b.role && b.role !== 'admin'))) {
        throw new ValidationError('No puedes desactivarte ni quitarte el rol de administrador a ti mismo');
      }
      await tx(async (db) => {
        const res = await db.query(`
          UPDATE users SET
            full_name = COALESCE($3, full_name),
            role      = COALESCE($4, role),
            active    = COALESCE($5, active)
          WHERE id = $1 AND tenant_id = $2
          RETURNING id`, [id, c.tenantId, b.full_name ?? null, b.role ?? null, b.active ?? null]);
        if (!res.rows.length) throw new ValidationError('Usuario no encontrado');
        const admins = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM users WHERE tenant_id = $1 AND role = 'admin' AND active`, [c.tenantId]);
        if ((admins.rows[0]?.n ?? 0) === 0) {
          throw new ValidationError('La empresa debe conservar al menos un administrador activo');
        }
      });
      invalidateAccountStatus(id);
      await audit(c.tenantId, c.userId, 'USER_UPDATED', { id, ...b });
      return { success: true };
    });

    r.post('/v2/users/:id/password', { preHandler: requirePerm('users:manage') }, async (req) => {
      const c = ctx(req);
      const id = (req.params as { id: string }).id;
      const b = parse(PasswordBody, req.body);
      const res = await query('UPDATE users SET password_hash = $3 WHERE id = $1 AND tenant_id = $2 RETURNING id',
        [id, c.tenantId, await hashPassword(b.password)]);
      if (!res.rows.length) throw new ValidationError('Usuario no encontrado');
      await audit(c.tenantId, c.userId, 'USER_PASSWORD_RESET', { id });
      return { success: true };
    });
  });
}

async function audit(tenantId: number, userId: string, event: string, payload: unknown): Promise<void> {
  await query('INSERT INTO audit_events (tenant_id, user_id, event_type, payload) VALUES ($1, $2, $3, $4::jsonb)',
    [tenantId, userId, event, JSON.stringify(payload)]);
}
