import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../errors.js';
import { query } from '../db/client.js';
import {
  hashPassword, verifyPassword, issueJwt, newUserId, type AuthClaims,
} from '../auth/local-auth.js';

/**
 * Endpoints de autenticación local (sin Supabase).
 *   POST /v2/auth/signup  — crea user + emite JWT
 *   POST /v2/auth/login   — verifica password + emite JWT
 *   POST /v2/auth/refresh — re-emite JWT con tenant_id actualizado (post-onboarding)
 *   GET  /v2/auth/me      — devuelve claims actuales del JWT
 *
 * El SIGNUP no asigna tenant_id — eso pasa en el onboarding wizard. Después
 * del onboarding el frontend debe llamar /v2/auth/refresh para obtener un
 * JWT nuevo con el tenant_id seteado.
 */

const SignupBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  full_name: z.string().optional(),
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  tenant_id: number | null;
  role: AuthClaims['role'];
  full_name: string | null;
}

export function registerAuthRoutes(app: FastifyInstance): void {
  // ── POST /v2/auth/signup ──────────────────────────────────────────────────
  app.post('/v2/auth/signup', async (req, reply) => {
    if (process.env.SIGNUP_ENABLED === 'false') {
      return reply.code(403).send({ success: false, code: 'SIGNUP_DISABLED', message: 'Signup deshabilitado' });
    }
    const parsed = SignupBody.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Body inválido', { issues: parsed.error.flatten() });
    }
    const { email, password, full_name } = parsed.data;
    const lc = email.toLowerCase();

    // Check duplicado
    const existing = await query<{ id: string }>('SELECT id FROM users WHERE LOWER(email) = $1', [lc]);
    if (existing.rows.length > 0) {
      return reply.code(409).send({ success: false, code: 'EMAIL_EXISTS', message: 'Ese email ya está registrado' });
    }

    const userId = newUserId();
    const hash = await hashPassword(password);
    await query(`
      INSERT INTO users (id, email, password_hash, tenant_id, role, full_name)
      VALUES ($1, $2, $3, NULL, 'admin', $4)
    `, [userId, email, hash, full_name ?? null]);

    const token = issueJwt({ userId, email, tenantId: null, role: 'admin' });
    return reply.send({
      success: true,
      access_token: token,
      user: { id: userId, email, tenant_id: null, role: 'admin', full_name: full_name ?? null },
    });
  });

  // ── POST /v2/auth/login ───────────────────────────────────────────────────
  app.post('/v2/auth/login', async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Body inválido', { issues: parsed.error.flatten() });
    }
    const { email, password } = parsed.data;
    const lc = email.toLowerCase();

    const res = await query<UserRow>(
      'SELECT id, email, password_hash, tenant_id, role, full_name FROM users WHERE LOWER(email) = $1',
      [lc],
    );
    const user = res.rows[0];
    // Compare contra hash dummy si user no existe — defensa timing-attack
    const hashToCheck = user?.password_hash ?? '$2a$12$XXXXXXXXXXXXXXXXXXXXXX0000000000000000000000000000000';
    const ok = await verifyPassword(password, hashToCheck);
    if (!user || !ok) {
      return reply.code(401).send({ success: false, code: 'INVALID_CREDENTIALS', message: 'Credenciales inválidas' });
    }

    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    const token = issueJwt({
      userId: user.id, email: user.email,
      tenantId: user.tenant_id, role: user.role,
    });
    return reply.send({
      success: true,
      access_token: token,
      user: {
        id: user.id, email: user.email,
        tenant_id: user.tenant_id, role: user.role,
        full_name: user.full_name,
      },
    });
  });

  // ── POST /v2/auth/refresh ─────────────────────────────────────────────────
  // Re-emite el JWT leyendo el estado actual del user en DB. Útil después del
  // onboarding para que el nuevo JWT lleve tenant_id sin requerir logout.
  app.post('/v2/auth/refresh', async (req, reply) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) {
      return reply.code(401).send({ success: false, code: 'AUTH_MISSING' });
    }
    const oldToken = h.slice(7);
    let claims;
    try {
      const { verifyJwt } = await import('../auth/local-auth.js');
      claims = verifyJwt(oldToken);
    } catch (e) {
      return reply.code(401).send({ success: false, code: 'AUTH_INVALID', message: e instanceof Error ? e.message : 'JWT inválido' });
    }
    const res = await query<UserRow>(
      'SELECT id, email, password_hash, tenant_id, role, full_name FROM users WHERE id = $1',
      [claims.sub],
    );
    const user = res.rows[0];
    if (!user) {
      return reply.code(401).send({ success: false, code: 'USER_NOT_FOUND' });
    }
    const token = issueJwt({
      userId: user.id, email: user.email,
      tenantId: user.tenant_id, role: user.role,
    });
    return reply.send({
      success: true,
      access_token: token,
      user: {
        id: user.id, email: user.email,
        tenant_id: user.tenant_id, role: user.role,
        full_name: user.full_name,
      },
    });
  });

  // ── GET /v2/auth/me ───────────────────────────────────────────────────────
  app.get('/v2/auth/me', async (req, reply) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) {
      return reply.code(401).send({ success: false, code: 'AUTH_MISSING' });
    }
    try {
      const { verifyJwt } = await import('../auth/local-auth.js');
      const claims = verifyJwt(h.slice(7));
      return reply.send({ success: true, claims });
    } catch (e) {
      return reply.code(401).send({ success: false, code: 'AUTH_INVALID', message: e instanceof Error ? e.message : 'JWT inválido' });
    }
  });
}
