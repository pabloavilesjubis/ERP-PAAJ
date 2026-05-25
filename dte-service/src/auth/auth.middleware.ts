import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyJwt, type AuthClaims } from './local-auth.js';
import { getTenantBySlug } from '../tenants/tenant.repo.js';

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
