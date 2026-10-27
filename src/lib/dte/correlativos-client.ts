import { env } from '@/config/env';
import { dteAuthHeaders, usesTenantDteApi } from './tenant-routing';
import type { TipoDteCode } from '@/types/domain';

/**
 * Cliente HTTP para el correlativo-service dentro de dte-service. dte-service
 * es la ÚNICA fuente de verdad para la secuencia fiscal. El frontend solo
 * lee (`peek`, `listar`) para mostrar el estado al usuario, y escribe vía
 * `sembrar` cuando un humano lo solicita explícitamente desde CorrelativosTab.
 *
 * NO llamar reservar/consumir/devolver desde el frontend — el ciclo de vida
 * (reserva atómica → MH → commit/release) corre dentro de /emit y /dte/emitir.
 */

export interface CorrelativoRecord {
  tipo_dte: string;
  /** true SOLO tras una acción explícita de siembra. Sin esto las emisiones fallan. */
  seeded: boolean;
  seeded_at: string | null;
  seeded_by: string | null;
  ultimo_consumido: number;
  reservados: number[];
  updated_at: string;
}

function baseUrl(): string {
  return env.dteServiceUrl.replace(/\/$/, '');
}

/** Correlativos de la empresa de la sesión (rutas /v2, ver tenant-routing.ts). */
async function listarTenant(): Promise<CorrelativoRecord[]> {
  const res = await fetch(`${baseUrl()}/v2/correlativos/listar`, { headers: dteAuthHeaders() });
  if (!res.ok) throw new Error(`listar: HTTP ${res.status}`);
  return (await res.json() as { items: CorrelativoRecord[] }).items;
}

const notSeeded = (tipoDte: string): CorrelativoRecord => ({
  tipo_dte: tipoDte, seeded: false, seeded_at: null, seeded_by: null, ultimo_consumido: 0, reservados: [], updated_at: '',
});

export async function peekCorrelativo(tipoDte: TipoDteCode): Promise<CorrelativoRecord> {
  if (usesTenantDteApi()) return (await listarTenant()).find(r => r.tipo_dte === tipoDte) ?? notSeeded(tipoDte);
  const res = await fetch(`${baseUrl()}/correlativos/peek?tipo_dte=${tipoDte}`);
  if (!res.ok) throw new Error(`peek ${tipoDte}: HTTP ${res.status}`);
  return res.json();
}

export async function listarCorrelativos(): Promise<CorrelativoRecord[]> {
  if (usesTenantDteApi()) return listarTenant();
  const res = await fetch(`${baseUrl()}/correlativos/listar`);
  if (!res.ok) throw new Error(`listar: HTTP ${res.status}`);
  const body = await res.json() as { items: CorrelativoRecord[] };
  return body.items;
}

export interface SembrarResult {
  tipo_dte: string;
  antes: number;
  despues: number;
  seeded_antes: boolean;
  seeded_ahora: boolean;
  seeded_at: string | null;
  aplicado: boolean;
}

/**
 * Acción administrativa: marca un tipoDte como sembrado y fija el último
 * consecutivo histórico conocido. Idempotente — solo sube ultimo_consumido
 * (nunca baja). Habilita las emisiones posteriores. Debe llamarse SOLO
 * desde flujos de seed explícitos (CorrelativosTab, scripts admin) — NUNCA
 * desde init() o desde cache del navegador.
 */
export async function sembrarCorrelativos(
  items: Array<{ tipo_dte: TipoDteCode; ultimo_consumido: number }>,
  seededBy?: string,
): Promise<{ resultados: SembrarResult[] }> {
  if (usesTenantDteApi()) {
    // Mismo endpoint que Mi empresa: exige company:manage y nunca baja el número
    const r = await fetch(`${baseUrl()}/v2/company/correlativos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...dteAuthHeaders() }, body: JSON.stringify({ items }),
    });
    if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { message?: string } | null)?.message ?? `sembrar: HTTP ${r.status}`);
    return { resultados: [] };
  }
  const res = await fetch(`${baseUrl()}/correlativos/sembrar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, seeded_by: seededBy ?? 'ERP-UI-admin' }),
  });
  if (!res.ok) throw new Error(`sembrar: HTTP ${res.status}`);
  return res.json();
}
