import type { Config } from '../config.js';
import { AMBIENTE, MH_BASE } from '../config.js';
import { MhRejectedError } from '../errors.js';
import { clearTokenCache, getToken } from './auth.js';
import { postJson } from './client.js';

export interface RecepcionResponse {
  version: number;
  ambiente: string;
  versionApp: number;
  estado: 'PROCESADO' | 'RECHAZADO';
  codigoGeneracion: string;
  selloRecibido: string | null;
  fhProcesamiento: string;
  clasificaMsg?: string;
  codigoMsg?: string;
  descripcionMsg?: string;
  observaciones?: string[] | null;
}

export interface SubmitArgs {
  cfg: Config;
  tipoDte: string;
  version: number;
  documento: string;       // JWS compacto del DTE firmado
  codigoGeneracion: string;
  /** id incremental del envío — el MH no lo valida estrictamente, default 1. */
  idEnvio?: number;
}

export interface SubmitResult {
  estado: 'PROCESADO' | 'RECHAZADO';
  selloRecibido: string | null;
  raw: RecepcionResponse;
}

/** Envía un DTE firmado al endpoint de recepción del MH. Refresca el token y
 *  reintenta una vez si recibe 401. Lanza `MhRejectedError` si el MH rechaza.
 *  En `MH_ENV=mock` devuelve una respuesta sintética (sello + estado PROCESADO)
 *  sin llamar al MH — útil para flujo end-to-end sin cert. */
export async function submitDte(args: SubmitArgs): Promise<SubmitResult> {
  if (args.cfg.MH_ENV === 'mock') {
    return mockSubmit(args);
  }
  const url = `${MH_BASE[args.cfg.MH_ENV]}/fesv/recepciondte`;
  const body = {
    ambiente: AMBIENTE[args.cfg.MH_ENV],
    idEnvio: args.idEnvio ?? 1,
    version: args.version,
    tipoDte: args.tipoDte,
    documento: args.documento,
    codigoGeneracion: args.codigoGeneracion,
  };

  let token = await getToken(args.cfg);
  let res = await postJson<RecepcionResponse>(url, body, {
    headers: { Authorization: token },
  });

  if (res.status === 401) {
    clearTokenCache();
    token = await getToken(args.cfg, true);
    res = await postJson<RecepcionResponse>(url, body, {
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
  return {
    estado: res.body.estado,
    selloRecibido: res.body.selloRecibido,
    raw: res.body,
  };
}

/** Genera un sello fake con el formato MH: 40 chars uppercase alfanuméricos. */
function fakeSello(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 40 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/** Respuesta sintética para mock mode — replica el shape del MH. */
async function mockSubmit(args: SubmitArgs): Promise<SubmitResult> {
  const now = new Date();
  const fh = `${pad2(now.getDate())}/${pad2(now.getMonth() + 1)}/${now.getFullYear()} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  const sello = fakeSello();
  const raw: RecepcionResponse = {
    version: 2,
    ambiente: '00',
    versionApp: 2,
    estado: 'PROCESADO',
    codigoGeneracion: args.codigoGeneracion,
    selloRecibido: sello,
    fhProcesamiento: fh,
    clasificaMsg: '11',
    codigoMsg: '001',
    descripcionMsg: 'MOCK MODE — no se envió al MH real',
    observaciones: null,
  };
  return { estado: 'PROCESADO', selloRecibido: sello, raw };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
