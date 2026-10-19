import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyJwt, type AuthClaims } from './local-auth.js';
import { getTenantBySlug } from '../tenants/tenant.repo.js';
import { query } from '../db/client.js';
import { isPlatformAdmin } from './platform-admin.js';
import { hasPermission, type Permission } from './permissions.js';

/**
 * Middleware: extrae JWT del header `Authorization: Bearer …`, lo verifica con
 * `AUTH_JWT_SECRET`, y resuelve tenant_id desde:
 *
 *   1. claims.tenant_id (lo más confiable — viene del DB al login/refresh)
 *   2. path `/t/<slug>/…` como fallback
 *
 * Si el claim trae tenant_id y el path trae slug, hacemos cross-check para
 * bloquear intentos de tenant-spoofing.
 */

declare module 'fastify' {
  interface FastifyRequest {
    auth?: { userId: string; email: string; role: AuthClaims['role'] };
    tenantId?: number;
    tenantSlug?: string;
  }
}

function extractBearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || typeof h !== 'string' || !h.startsWith('Bearer ')) return null;
  return h.slice(7);
}

function extractSlugFromPath(req: FastifyRequest): string | null {
  const m = req.url.match(/^\/t\/([a-z0-9][a-z0-9-]*)(?:\/|\?|$)/);
  return m ? m[1]! : null;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = extractBearer(req);
  if (!token) {
    reply.code(401).send({ success: false, code: 'AUTH_MISSING', message: 'Bearer token requerido' });
    return reply;
  }
  let claims: AuthClaims;
  try {
    claims = verifyJwt(token);
  } catch (e) {
    reply.code(401).send({
      success: false, code: 'AUTH_INVALID',
      message: e instanceof Error ? e.message : 'JWT inválido',
    });
    return reply;
  }
  req.auth = { userId: claims.sub, email: claims.email, role: claims.role };

  // Estado vigente del usuario y su empresa (cache corto): un usuario
  // desactivado o una empresa suspendida pierden acceso sin esperar a que
  // venza el JWT, y un cambio de rol aplica de inmediato.
  const status = await accountStatus(claims.sub);
  if (status) {
    if (status.active === false) {
      reply.code(401).send({ success: false, code: 'USER_INACTIVE', message: 'Usuario desactivado' });
      return reply;
    }
    if (status.tenantStatus && ['suspended', 'archived'].includes(status.tenantStatus) && !isPlatformAdmin(claims.email)) {
      reply.code(403).send({ success: false, code: 'TENANT_SUSPENDED', message: 'La empresa está suspendida' });
      return reply;
    }
    req.auth.role = status.role as AuthClaims['role'];
  }

  const claimTenantId = claims.tenant_id;
  const pathSlug = extractSlugFromPath(req);

  if (claimTenantId !== null && claimTenantId !== undefined) {
    req.tenantId = claimTenantId;
    if (pathSlug) {
      const tenant = await getTenantBySlug(pathSlug);
      if (!tenant || tenant.id !== claimTenantId) {
        reply.code(403).send({
          success: false, code: 'TENANT_MISMATCH',
          message: `JWT pertenece a tenant ${claimTenantId} pero el path apunta a ${pathSlug}`,
        });
        return reply;
      }
      req.tenantSlug = pathSlug;
    }
  } else if (pathSlug) {
    const tenant = await getTenantBySlug(pathSlug);
    if (!tenant) {
      reply.code(404).send({ success: false, code: 'TENANT_NOT_FOUND', message: `Slug ${pathSlug} no existe` });
      return reply;
    }
    req.tenantId = tenant.id;
    req.tenantSlug = tenant.slug;
  } else {
    reply.code(400).send({
      success: false, code: 'TENANT_UNRESOLVED',
      message: 'No se pudo resolver tenant_id. Completá onboarding o navegá vía /t/<slug>/.',
    });
    return reply;
  }
}

export function requireRole(...allowed: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireAuth(req, reply);
    if (reply.sent) return;
    if (!req.auth || !allowed.includes(req.auth.role)) {
      reply.code(403).send({
        success: false, code: 'ROLE_FORBIDDEN',
        message: `Rol requerido: ${allowed.join('|')}, actual: ${req.auth?.role ?? 'none'}`,
      });
    }
  };
}

interface AccountStatus { active: boolean | null; role: string; tenantStatus: string | null }
const STATUS_TTL_MS = 30_000;
const statusCache = new Map<string, { at: number; value: AccountStatus | null }>();

/** Limpia el cache de estado (al cambiar rol/activo de un usuario). */
export function invalidateAccountStatus(userId?: string): void {
  if (userId) statusCache.delete(userId);
  else statusCache.clear();
}

async function accountStatus(userId: string): Promise<AccountStatus | null> {
  const hit = statusCache.get(userId);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.value;
  let value: AccountStatus | null = null;
  try {
    // to_jsonb: tolera una base sin la columna `active` (migración 005 pendiente)
    const res = await query<{ active: string | null; role: string; tenant_status: string | null }>(`
      SELECT to_jsonb(u)->>'active' AS active, u.role, t.status AS tenant_status
        FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1`, [userId]);
    const r = res.rows[0];
    value = r ? { active: r.active === null ? null : r.active === 'true', role: r.role, tenantStatus: r.tenant_status } : null;
  } catch {
    value = null;   // sin DB (rutas legacy) → se confía en el JWT
  }
  statusCache.set(userId, { at: Date.now(), value });
  return value;
}

/**
 * preHandler para rutas que ya pasaron por requireAuth: exige un permiso del
 * rol (ver permissions.ts). Uso: `{ preHandler: requirePerm('accounting:post') }`.
 */
export function requirePerm(...perms: Permission[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.auth) {
      await requireAuth(req, reply);
      if (reply.sent) return;
    }
    const role = req.auth?.role;
    if (!perms.every(p => hasPermission(role, p))) {
      reply.code(403).send({
        success: false, code: 'PERMISSION_DENIED',
        message: `Tu rol (${role ?? 'sin rol'}) no tiene permiso para esta acción (${perms.join(', ')})`,
      });
      return reply;
    }
  };
}
