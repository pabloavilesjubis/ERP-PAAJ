import type { FastifyBaseLogger } from 'fastify';
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
  /** Número de control que viaja dentro del JWS — se loguea pre/post envío para diagnóstico. */
  numeroControl: string;
  /** NIT del emisor (== cfg.MH_NIT, lo replicamos para que aparezca en el log estructurado). */
  nitEmisor: string;
  /** id incremental del envío — el MH no lo valida estrictamente, default 1. */
  idEnvio?: number;
  /** Logger fastify (req.log) — si se omite cae a console. */
  log?: FastifyBaseLogger;
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
  // Componentes del numeroControl (formato fijo: DTE-NN-EEEEPPPP-NNNNNNNNNNNNNNN)
  // 0..3  = "DTE-"
  // 4..6  = tipoDte + "-"
  // 7..14 = codEstable(4) + codPuntoVenta(4)
  // 15    = "-"
  // 16..30 = correlativo(15)
  const nc = args.numeroControl;
  const codEstable    = nc.length === 31 ? nc.slice(7, 11)  : null;
  const codPuntoVenta = nc.length === 31 ? nc.slice(11, 15) : null;
  const correlativo   = nc.length === 31 ? nc.slice(16)     : null;
  const ambiente = AMBIENTE[args.cfg.MH_ENV];

  // Contexto base — se repite en cada log para que el rechazo sea autocontenido
  // en logs/observabilidad sin tener que cruzar varias líneas.
  const baseCtx = {
    tipoDte: args.tipoDte,
    codigoGeneracion: args.codigoGeneracion,
    numeroControl: nc,
    numeroControlLen: nc.length,
    codEstable,
    codPuntoVenta,
    correlativo,
    nitEmisor: args.nitEmisor,
    ambiente,
    mhEnv: args.cfg.MH_ENV,
  };

  args.log?.info(baseCtx, 'MH submit: enviando DTE');

  if (args.cfg.MH_ENV === 'mock') {
    return mockSubmit(args);
  }
  const url = `${MH_BASE[args.cfg.MH_ENV]}/fesv/recepciondte`;
  const body = {
    ambiente,
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
    args.log?.error({
      ...baseCtx,
      httpStatus: res.status,
      mhEstado: res.body.estado,
      mhDescripcionMsg: res.body.descripcionMsg,
      mhClasificaMsg: res.body.clasificaMsg,
      mhCodigoMsg: res.body.codigoMsg,
      mhObservaciones: res.body.observaciones,
      mhRawBody: res.body,
    }, 'MH submit: DTE rechazado');

    throw new MhRejectedError(
      res.body.descripcionMsg ?? `HTTP ${res.status}`,
      res.body.observaciones ?? [],
      {
        httpStatus: res.status,
        body: res.body,
        numeroControl: nc,
        codigoGeneracion: args.codigoGeneracion,
        codEstable,
        codPuntoVenta,
        correlativo,
        nitEmisor: args.nitEmisor,
        ambiente,
        tipoDte: args.tipoDte,
      },
    );
  }

  args.log?.info({
    ...baseCtx,
    selloRecibido: res.body.selloRecibido,
    fhProcesamiento: res.body.fhProcesamiento,
  }, 'MH submit: DTE aceptado');

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
