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
  /** Correlativo finalmente usado — viene del SoT (dte-service). */
  consecutivo: number;
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

/**
 * Record canónico devuelto por GET /dte/listar — incluye `dte_json` para
 * reconstruir la VentaConsumidor/VentaContribuyente local con datos completos
 * (descripción, totales, receptor) sin tener que hacer otra llamada.
 */
export interface DteListedRecord {
  success: boolean;
  erp_invoice_id: string;
  beon_sale_id: string | null;
  /** 'POS' = emitido desde ERP UI · 'BEON' = emitido vía API externa */
  origen: 'POS' | 'BEON' | 'API';
  tipo_dte: '01' | '03' | '05' | '14';
  estado: 'EMITIDO' | 'RECHAZADO' | 'ANULADO';
  codigo_generacion: string;
  numero_control: string;
  sello_recibido: string | null;
  fh_procesamiento: string | null;
  fec_emi: string;        // YYYY-MM-DD
  hor_emi: string;        // HH:MM:SS
  ambiente: '00' | '01';
  receptor_correo: string | null;
  receptor_nombre: string | null;
  vendedor_nombre: string | null;
  consecutivo: number;
  dte_json: Record<string, unknown>;
  documento_jws: string;
  pdf_url: string | null;
  json_url: string | null;
  ticket_url: string | null;
  qr_url: string | null;
  anulacion: {
    codigo_generacion_evento: string;
    sello_evento: string | null;
    fec_anula: string;
    motivo: string;
  } | null;
  created_at: string;
  updated_at: string;
  erp_synced_at: string | null;
}

/** Lista DTEs almacenados en dte-service. Filtros opcionales para sync incremental. */
export async function listDtes(opts: {
  since?: string;
  tipoDte?: '01' | '03' | '05' | '14';
  estado?: 'EMITIDO' | 'RECHAZADO' | 'ANULADO';
  limit?: number;
} = {}): Promise<{ items: DteListedRecord[]; count: number; limit: number }> {
  const params = new URLSearchParams();
  if (opts.since) params.set('since', opts.since);
  if (opts.tipoDte) params.set('tipo_dte', opts.tipoDte);
  if (opts.estado) params.set('estado', opts.estado);
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const url = `${env.dteServiceUrl.replace(/\/$/, '')}/dte/listar${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new DteServiceError(
      `HTTP ${res.status} listando DTEs`,
      'LIST_FAILED',
      res.status,
      undefined,
      null,
    );
  }
  return res.json();
}

/**
 * Confirma al server que el ERP ya pulleó este DTE. Setea erp_synced_at en
 * el storage de dte-service para que /dte/replay-sync?only_unsynced=true sepa
 * qué falta. Falla silenciosa (no-op si el server no responde).
 */
export async function ackDteSync(codigoGeneracion: string): Promise<void> {
  const url = `${env.dteServiceUrl.replace(/\/$/, '')}/dte/ack-sync`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codigo_generacion: codigoGeneracion }),
    });
  } catch {
    // no-op — el sync no es crítico para la operación fiscal
  }
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
