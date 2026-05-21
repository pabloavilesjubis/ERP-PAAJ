import type { Config } from '../config.js';
import { FirmadorError } from '../errors.js';
import { postJson } from '../mh/client.js';

interface FirmadorResponse {
  status?: 'OK' | 'ERROR';
  body?: string;       // JWS compacto si OK; mensaje de error si ERROR
}

/**
 * Llama al firmador Java (sidecar) y devuelve el JWS compacto del DTE firmado.
 * El cert nunca sale del contenedor del firmador. Esta función sólo conoce
 * el password del cert (clave privada).
 */
export async function firmar(cfg: Config, dteJson: unknown): Promise<string> {
  const url = `${cfg.FIRMADOR_URL}/firmardocumento/`;
  const res = await postJson<FirmadorResponse>(
    url,
    {
      nit: cfg.FIRMADOR_NIT,
      activo: true,
      passwordPri: cfg.FIRMADOR_PASSWORD,
      dteJson,
    },
    { timeoutMs: 15_000, maxRetries: 1 },
  );
  if (res.status !== 200 || res.body.status !== 'OK' || typeof res.body.body !== 'string') {
    throw new FirmadorError('Firmador rechazó el documento', {
      httpStatus: res.status,
      firmadorStatus: res.body.status,
      mensaje: res.body.body,
    });
  }
  return res.body.body;
}
