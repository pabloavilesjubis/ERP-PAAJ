import { randomBytes } from 'node:crypto';
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
 *
 * En `MH_ENV=mock` se devuelve un JWS sintético — útil para desarrollo y demos
 * sin certificado real. El JWS tiene formato válido pero firma falsa.
 */
export async function firmar(cfg: Config, dteJson: unknown): Promise<string> {
  if (cfg.MH_ENV === 'mock') {
    return mockFirmar(dteJson);
  }
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

/**
 * JWS sintético para `MH_ENV=mock`. Formato: header.payload.signature (compacto).
 * Header y payload son JSON real codificado en base64url; signature es aleatoria.
 * Sirve para que el flujo end-to-end del ERP funcione sin cert.
 */
function mockFirmar(dteJson: unknown): string {
  const header = base64url(JSON.stringify({ alg: 'RS512', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(dteJson));
  const signature = randomBytes(256).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function base64url(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64url');
}
