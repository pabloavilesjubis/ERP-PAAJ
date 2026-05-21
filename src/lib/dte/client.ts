import { env } from '@/config/env';

/**
 * Cliente HTTP para el microservicio `dte-service` (Node/TS) que firma y
 * envía DTEs al portal del MH. Vive en `dte-service/` dentro del repo.
 *
 * Configurado por `VITE_DTE_SERVICE_URL` (default `http://localhost:3000`).
 */

export type DteTipo = 'fcf' | 'ccf' | 'nc' | 'fse';

export interface DteEmitRequest {
  tipo: DteTipo;
  data: Record<string, unknown>;
}

export interface DteEmitSuccess {
  codigoGeneracion: string;
  numeroControl: string;
  estado: 'PROCESADO' | 'RECHAZADO';
  selloRecibido: string | null;
  dte: Record<string, unknown>;
  documento: string;            // JWS firmado
  mh: Record<string, unknown>;
}

export interface DteServiceErrorResponse {
  code: string;                 // 'VALIDATION' | 'MH_REJECTED' | 'FIRMADOR_FAILED' | etc.
  message: string;
  mhMessage?: string;
  observaciones?: string[];
  details?: Record<string, unknown>;
}

export class DteServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number,
    public readonly details: Record<string, unknown> | undefined,
    public readonly raw: DteServiceErrorResponse | null,
  ) {
    super(message);
    this.name = 'DteServiceError';
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const url = `${env.dteServiceUrl.replace(/\/$/, '')}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Sin red';
    throw new DteServiceError(
      `No se pudo conectar al dte-service en ${env.dteServiceUrl}: ${msg}`,
      'NETWORK', 0, { url }, null,
    );
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    const err = parsed as DteServiceErrorResponse | null;
    throw new DteServiceError(
      err?.message ?? `HTTP ${res.status}`,
      err?.code ?? 'UNKNOWN',
      res.status,
      err?.details,
      err,
    );
  }
  return parsed as T;
}

/** Emite un DTE (FCF/CCF/NC/FSE). */
export function emitDte(req: DteEmitRequest): Promise<DteEmitSuccess> {
  return postJson<DteEmitSuccess>('/emit', req);
}

/** Anula un DTE previamente emitido. */
export function annulDte(payload: Record<string, unknown>): Promise<{
  codigoGeneracionEvento: string;
  selloEvento: string | null;
  mh: Record<string, unknown>;
}> {
  return postJson('/annul', payload);
}

/** Health check rápido del servicio. */
export async function pingDteService(): Promise<{ ok: boolean; mhEnv?: string }> {
  try {
    const res = await fetch(`${env.dteServiceUrl}/health`, { method: 'GET' });
    if (!res.ok) return { ok: false };
    const body = await res.json() as { mhEnv?: string };
    return { ok: true, mhEnv: body.mhEnv };
  } catch {
    return { ok: false };
  }
}
