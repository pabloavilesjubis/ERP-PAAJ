import type { FastifyInstance, FastifyRequest } from 'fastify';
import pg from 'pg';
import type { z } from 'zod';
import { requireAuth } from '../auth/auth.middleware.js';
import { getPool } from '../db/client.js';
import { ValidationError } from '../errors.js';

/**
 * Utilidades comunes de los módulos ERP (contabilidad, bancos, planillas…).
 *
 * Convenciones:
 *  - Cada módulo se registra como plugin encapsulado con `authedPlugin`, así
 *    su preHandler de auth no se filtra al resto de la app.
 *  - Toda consulta lleva el tenant de `ctx(req)`; las funciones SQL reciben
 *    `p_tenant` y `p_user` explícitos (no hay RLS ni sesión en la base).
 *  - Los bodies se validan con zod (`parse`).
 */

/**
 * Tipos para los módulos ERP: BIGINT (ids) y NUMERIC (montos) como number,
 * DATE como 'YYYY-MM-DD' (sin pasar por Date → sin corrimiento de zona).
 * Solo aplica a las consultas hechas con `q()`; las rutas legacy no cambian.
 */
const ERP_TYPES = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === 20 || oid === 1700) return (v: string) => (v === null ? null : Number(v));
    if (oid === 1082) return (v: string) => v;
    // int8[] / numeric[] → number[] (se parsean como text[] y se convierten)
    if (oid === 1016 || oid === 1231) {
      const parseTextArray = pg.types.getTypeParser(1009 as never, 'text') as (v: string) => string[];
      return (v: string) => parseTextArray(v).map(Number);
    }
    return pg.types.getTypeParser(oid as never, format ?? 'text');
  },
} as unknown as pg.CustomTypesConfig;

/** Consulta con los tipos ERP. Con `db`, dentro de la transacción indicada. */
export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string, params: unknown[] = [], db?: pg.PoolClient,
): Promise<pg.QueryResult<T>> {
  return (db ?? getPool()).query<T>({ text, values: params, types: ERP_TYPES });
}

export interface Ctx {
  tenantId: number;
  userId: string;
  /** Nombre visible en bitácoras (asientos, pagos…). */
  userName: string;
}

export function ctx(req: FastifyRequest): Ctx {
  if (!req.tenantId || !req.auth) throw new ValidationError('Sesión sin empresa resuelta');
  return { tenantId: req.tenantId, userId: req.auth.userId, userName: req.auth.name || req.auth.email };
}

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first?.path.length ? ` (${first.path.join('.')})` : '';
    throw new ValidationError(`${first?.message ?? 'Datos inválidos'}${where}`, { issues: r.error.flatten() });
  }
  return r.data;
}

/** Registra un grupo de rutas que exige sesión con empresa. */
export async function authedPlugin(app: FastifyInstance, fn: (r: FastifyInstance) => void | Promise<void>): Promise<void> {
  await app.register(async (r) => {
    r.addHook('preHandler', async (req, reply) => {
      await requireAuth(req, reply);
    });
    await fn(r);
  });
}

/**
 * Transacción con un cliente dedicado; los asientos se validan al COMMIT.
 * Con `c`, fija el usuario de la transacción (app.user_id / app.user_name),
 * que las funciones contables usan para "registrado por".
 */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>, c?: Ctx): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    if (c) {
      await client.query(`SELECT set_config('app.user_id', $1, true), set_config('app.user_name', $2, true)`, [c.userId, c.userName]);
    }
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** `?from=YYYY-MM-DD&to=YYYY-MM-DD` con defaults (mes en curso). */
export function dateRange(q: Record<string, unknown>): { from: string; to: string } {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const today = new Date();
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const from = typeof q.from === 'string' && iso.test(q.from) ? q.from : first;
  const to = typeof q.to === 'string' && iso.test(q.to) ? q.to : today.toISOString().slice(0, 10);
  if (from > to) throw new ValidationError('El rango de fechas es inválido (desde > hasta)');
  return { from, to };
}

export function intParam(v: unknown, def: number, max: number): number {
  const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

export function idParam(req: FastifyRequest, name = 'id'): number {
  const raw = (req.params as Record<string, string>)[name];
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) throw new ValidationError(`Parámetro ${name} inválido`);
  return n;
}
