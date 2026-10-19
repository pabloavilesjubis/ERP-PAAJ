import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { CorrelativoNotConfiguredError, CorrelativoNotSeededError, DteError, MhRejectedError, ValidationError } from '../errors.js';
import { MailerNotConfigured } from '../beon/mailer.js';

/**
 * Manejador de errores global (compartido por index.ts y los tests de
 * integración). Traduce errores de dominio, de MH y de Postgres a HTTP.
 */

const PG_ERRORS: Record<string, { status: number; code: string }> = {
  '22023': { status: 400, code: 'INVALID' },        // regla de negocio (RAISE ... ERRCODE 22023)
  '23514': { status: 400, code: 'UNBALANCED' },     // cuadre / CHECK
  '23505': { status: 409, code: 'DUPLICATE' },
  '23503': { status: 409, code: 'IN_USE' },
  '42501': { status: 403, code: 'FORBIDDEN' },
  'P0002': { status: 404, code: 'NOT_FOUND' },
  'P0001': { status: 400, code: 'INVALID' },
};

export function errorHandler(rawErr: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  const err = rawErr as Error;
  req.log.error({ err }, 'request failed');
  if (err instanceof CorrelativoNotSeededError || err instanceof CorrelativoNotConfiguredError) {
    // 422 (Unprocessable Entity) — el body es estructuralmente válido pero
    // no existe correlativo fiscal inicial sembrado para el tipo. El caller
    // debe sembrar explícitamente antes de volver a emitir.
    return reply.code(422).send({ success: false, code: err.code, message: err.message, details: err.details });
  }
  if (err instanceof ValidationError) {
    return reply.code(400).send({ success: false, code: err.code, message: err.message, details: err.details });
  }
  if (err instanceof MhRejectedError) {
    return reply.code(422).send({
      success: false,
      code: err.code,
      message: err.message,
      mhMessage: err.mhMessage,
      observaciones: err.observaciones,
      details: err.details,
    });
  }
  if (err instanceof MailerNotConfigured) {
    return reply.code(503).send({ success: false, code: err.code, message: err.message });
  }
  if (err instanceof DteError) {
    const status = err.code === 'MH_AUTH_FAILED' ? 502
      : err.code === 'FIRMADOR_FAILED' ? 502
      : err.code === 'MH_TRANSIENT' ? 503
      : 500;
    return reply.code(status).send({ success: false, code: err.code, message: err.message, details: err.details });
  }
  // Errores de Postgres lanzados por las reglas de la base (RAISE ... ERRCODE):
  // asiento descuadrado, período cerrado, permisos, duplicados, etc.
  const pgCode = (err as { code?: unknown }).code;
  if (typeof pgCode === 'string' && /^[0-9A-Z]{5}$/.test(pgCode)) {
    const mapped = PG_ERRORS[pgCode] ?? (pgCode.startsWith('22') || pgCode.startsWith('23') ? { status: 400, code: 'INVALID' } : null);
    if (mapped) return reply.code(mapped.status).send({ success: false, code: mapped.code, message: err.message });
  }
  if ((err as FastifyError).statusCode && (err as FastifyError).statusCode! < 500) {
    return reply.code((err as FastifyError).statusCode!).send({ success: false, code: (err as FastifyError).code ?? 'BAD_REQUEST', message: err.message });
  }
  // Catch-all: surfaceamos el mensaje real para que el caller pueda
  // diagnosticar sin entrar al contenedor. El stack lo dejamos solo en logs
  // (req.log.error arriba ya lo capturó con redaction de tokens/JWS).
  return reply.code(500).send({
    success: false,
    code: 'INTERNAL',
    message: err.message || 'Error inesperado',
    errorName: err.name,
    // Stack frame top — útil para identificar el archivo/línea sin ver logs.
    // No exponemos el stack completo para no filtrar paths internos.
    where: extractTopFrame(err),
  });
}

function extractTopFrame(err: Error): string | undefined {
  const stack = err.stack;
  if (!stack) return undefined;
  const lines = stack.split('\n');
  // Primera línea que apunte a código nuestro (src/dist), no a node_modules.
  for (const line of lines) {
    const m = line.match(/at\s+.+\((.+):(\d+):(\d+)\)/) ?? line.match(/at\s+(.+):(\d+):(\d+)/);
    if (!m) continue;
    const file = m[1];
    if (file && !file.includes('node_modules') && (file.includes('/src/') || file.includes('/dist/'))) {
      const idx = file.lastIndexOf('/');
      return `${file.slice(idx + 1)}:${m[2]}:${m[3]}`;
    }
  }
  return lines[1]?.trim();
}

