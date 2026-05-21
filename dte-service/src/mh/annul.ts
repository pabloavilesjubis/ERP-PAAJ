import type { Config } from '../config.js';
import { AMBIENTE, MH_BASE } from '../config.js';
import { MhRejectedError } from '../errors.js';
import { clearTokenCache, getToken } from './auth.js';
import { postJson } from './client.js';

interface AnulacionResponse {
  estado?: 'PROCESADO' | 'RECHAZADO';
  codigoGeneracion?: string;
  selloRecibido?: string | null;
  descripcionMsg?: string;
  observaciones?: string[] | null;
  [key: string]: unknown;
}

export interface AnnulArgs {
  cfg: Config;
  /** JWS compacto del evento de anulación firmado. */
  documento: string;
  idEnvio?: number;
}

export interface AnnulResult {
  selloRecibido: string | null;
  raw: AnulacionResponse;
}

/** Envía el evento de anulación al MH. Mismas reglas de auth/retry que submit. */
export async function annulDte(args: AnnulArgs): Promise<AnnulResult> {
  const url = `${MH_BASE[args.cfg.MH_ENV]}/fesv/anulardte`;
  const body = {
    ambiente: AMBIENTE[args.cfg.MH_ENV],
    idEnvio: args.idEnvio ?? 1,
    version: 2,
    documento: args.documento,
  };

  let token = await getToken(args.cfg);
  let res = await postJson<AnulacionResponse>(url, body, {
    headers: { Authorization: token },
  });

  if (res.status === 401) {
    clearTokenCache();
    token = await getToken(args.cfg, true);
    res = await postJson<AnulacionResponse>(url, body, {
      headers: { Authorization: token },
    });
  }

  if (res.status >= 400 || res.body.estado === 'RECHAZADO') {
    throw new MhRejectedError(
      res.body.descripcionMsg ?? `HTTP ${res.status}`,
      res.body.observaciones ?? [],
      { httpStatus: res.status, body: res.body },
    );
  }
  return { selloRecibido: res.body.selloRecibido ?? null, raw: res.body };
}
