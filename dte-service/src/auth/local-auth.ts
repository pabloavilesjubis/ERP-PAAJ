import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';

/**
 * Auth local — bcrypt para passwords + JWT firmado por el mismo backend.
 * Cero dependencias externas (sin Supabase / Auth0 / Clerk).
 *
 * JWT claims:
 *   sub:        user_id (text)
 *   email:      string
 *   tenant_id:  number | null  (null mientras no completó onboarding)
 *   role:       'admin' | 'cajero' | 'contador' | 'viewer'
 *   exp:        unix seconds
 *   iat:        unix seconds
 */

const SALT_ROUNDS = 12;
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;  // 7 días

export interface AuthClaims {
  sub: string;
  email: string;
  tenant_id: number | null;
  role: 'admin' | 'cajero' | 'contador' | 'viewer';
  iat: number;
  exp: number;
}

function secret(): string {
  const s = process.env.AUTH_JWT_SECRET;
  if (!s || s.length < 16) {
    throw new Error('AUTH_JWT_SECRET no configurada (mínimo 16 chars). Generar: openssl rand -base64 48');
  }
  return s;
}

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < 8) {
    throw new Error('Password debe tener mínimo 8 caracteres');
  }
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function newUserId(): string {
  // ID corto, URL-safe, unique. ~22 chars (más corto que UUID, alcanza).
  return 'usr_' + randomBytes(12).toString('base64url');
}

export function issueJwt(input: {
  userId: string;
  email: string;
  tenantId: number | null;
  role: AuthClaims['role'];
}): string {
  const payload: Omit<AuthClaims, 'iat' | 'exp'> = {
    sub: input.userId,
    email: input.email,
    tenant_id: input.tenantId,
    role: input.role,
  };
  return jwt.sign(payload, secret(), {
    algorithm: 'HS256',
    expiresIn: TOKEN_TTL_SECONDS,
  });
}

export function verifyJwt(token: string): AuthClaims {
  try {
    const decoded = jwt.verify(token, secret(), { algorithms: ['HS256'] }) as AuthClaims;
    return decoded;
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : 'JWT inválido');
  }
}

/**
 * Genera un token random URL-safe para reset password / verify email.
 * No firmado — la validez se chequea por presencia en tabla auth_tokens.
 */
export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}
