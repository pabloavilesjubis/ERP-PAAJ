import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';

/**
 * Guard de API-Key para endpoints BEON. Si `BEON_API_KEY` está configurado,
 * exige `X-API-Key` con ese valor. Si no se configura, autoriza por defecto
 * (modo dev). El header se compara con tiempo constante para evitar timing
 * attacks aunque la superficie es baja.
 */
export function requireApiKey(cfg: Config) {
  const expected = cfg.BEON_API_KEY ?? '';
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!expected) return;                  // sin guard si no se configura
    const got = req.headers['x-api-key'];
    const provided = Array.isArray(got) ? got[0] : got;
    if (!provided || !timingSafeEqual(provided, expected)) {
      reply.code(401).send({ code: 'UNAUTHORIZED', message: 'X-API-Key requerido o inválido' });
    }
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
