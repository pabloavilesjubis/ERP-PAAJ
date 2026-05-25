import { ackDteSync, listDtes, type DteListedRecord } from './client';
import type { AppData, VentaConsumidor, VentaContribuyente } from '@/types/domain';
import { newId } from '@/lib/utils/format';

/**
 * Sincroniza DTEs emitidos vía API (`POST /dte/emitir` desde BEON u otro
 * sistema externo) hacia el store local del ERP.
 *
 * Problema que resuelve: la UI emite por `POST /emit` y `persistVenta()` mete
 * la venta al store Zustand. Pero cuando BEON emite vía `POST /dte/emitir`,
 * el dte-service guarda en su filesystem pero el ERP nunca se entera — las
 * pestañas Ventas Consumidor / Ventas Contribuyente quedan vacías aunque el
 * MH sí recibió el DTE.
 *
 * Este módulo cierra el ciclo: trae lo listado vía `GET /dte/listar` y lo
 * mergea al store deduplicando por `codigoGeneracion` (clave estable que el
 * MH garantiza único por NIT).
 *
 * Diseño deliberado:
 * - Tolera fallas de red (no crashea la app si dte-service está caído).
 * - Idempotente — re-ejecutar no duplica.
 * - Sync incremental usando max(fecha) del store como cursor `since`, sin
 *   necesidad de persistir un timestamp aparte.
 * - Mapea estado:
 *   - EMITIDO → venta normal (anulado=false)
 *   - ANULADO → venta con metadata.anulado=true (queda visible en histórico)
 *   - RECHAZADO → se descarta (no es venta real)
 */

export interface SyncResult {
  ok: boolean;
  fetched: number;
  added: number;
  updated: number;
  skipped: number;
  error?: string;
}

/**
 * Computa el cursor `since`: el max(created_at) de las ventas existentes que
 * tengan source ∈ {beon, imported}. Si no hay ninguna, devuelve undefined →
 * primer sync trae todo. Usa `fecha` (YYYY-MM-DD) menos 1 día por seguridad
 * para tolerar DTEs emitidos el mismo día.
 */
function computeSince(data: AppData): string | undefined {
  const dates: string[] = [];
  for (const v of data.ventasConsumidor) {
    if (v.metadata?.source === 'pos' || v.metadata?.codigoGeneracion) dates.push(v.fecha);
  }
  for (const v of data.ventasContribuyente) {
    if (v.metadata?.numeroDocumento) dates.push(v.fecha);
  }
  if (dates.length === 0) return undefined;
  const maxDate = dates.sort().at(-1)!; // YYYY-MM-DD ordena lex correctamente
  const d = new Date(maxDate);
  d.setUTCDate(d.getUTCDate() - 1);     // -1 día de overlap por seguridad
  return d.toISOString();
}

/**
 * Sincroniza DTEs del dte-service al store local. Idempotente.
 * - `patch`: callback del store (useDataStore.patch).
 * - `getData`: callback que devuelve el snapshot actual del store.
 */
export async function syncDtesFromApi(
  getData: () => AppData,
  patch: (updater: (prev: AppData) => AppData) => Promise<void>,
  opts: { full?: boolean } = {},
): Promise<SyncResult> {
  // `full: true` ignora el cursor incremental — trae TODO lo que tiene el
  // server. Útil como botón de re-import manual. Sigue siendo idempotente
  // (dedup por codigoGeneracion).
  let response;
  try {
    const since = opts.full ? undefined : computeSince(getData());
    response = await listDtes({ since, limit: opts.full ? 5000 : 1000 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error de red';
    return { ok: false, fetched: 0, added: 0, updated: 0, skipped: 0, error: msg };
  }

  const fetched = response.items.length;
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const ackedCodigos: string[] = [];

  await patch(prev => {
    const ventasConsumidor = [...prev.ventasConsumidor];
    const ventasContribuyente = [...prev.ventasContribuyente];

    // Índices por codigoGeneracion para dedup O(1).
    const consumidorIdx = new Map(
      ventasConsumidor
        .map((v, i) => [v.metadata?.codigoGeneracion ?? v.metadata?.numeroDocumento, i] as const)
        .filter(([k]) => !!k) as Array<[string, number]>,
    );
    const contribuyenteIdx = new Map(
      ventasContribuyente
        .map((v, i) => [v.metadata?.numeroDocumento, i] as const)
        .filter(([k]) => !!k) as Array<[string, number]>,
    );

    for (const rec of response.items) {
      if (rec.estado === 'RECHAZADO') { skipped++; continue; }
      const codGen = rec.codigo_generacion;
      const isFcf = rec.tipo_dte === '01';
      const isCcfOrNc = rec.tipo_dte === '03' || rec.tipo_dte === '05';
      if (!isFcf && !isCcfOrNc) { skipped++; continue; }   // FSE no es venta

      if (isFcf) {
        const existingIdx = consumidorIdx.get(codGen);
        const venta = dteToVentaConsumidor(rec);
        if (existingIdx !== undefined) {
          const cur = ventasConsumidor[existingIdx]!;
          if (cur.metadata?.anulado !== venta.metadata?.anulado) {
            ventasConsumidor[existingIdx] = { ...cur, metadata: { ...cur.metadata, ...venta.metadata } };
            updated++;
            ackedCodigos.push(codGen);
          } else {
            skipped++;
          }
        } else {
          ventasConsumidor.push(venta);
          added++;
          ackedCodigos.push(codGen);
        }
      } else {
        const existingIdx = contribuyenteIdx.get(codGen);
        const venta = dteToVentaContribuyente(rec);
        if (existingIdx !== undefined) {
          const cur = ventasContribuyente[existingIdx]!;
          if (cur.metadata?.anulado !== venta.metadata?.anulado) {
            ventasContribuyente[existingIdx] = { ...cur, metadata: { ...cur.metadata, ...venta.metadata } };
            updated++;
            ackedCodigos.push(codGen);
          } else {
            skipped++;
          }
        } else {
          ventasContribuyente.push(venta);
          added++;
          ackedCodigos.push(codGen);
        }
      }
    }

    return { ...prev, ventasConsumidor, ventasContribuyente };
  });

  // Ack al server por cada DTE recién importado/actualizado — el server marca
  // erp_synced_at para que /replay-sync?only_unsynced sepa qué falta. Fire
  // and forget (no bloqueamos el sync principal).
  for (const cg of ackedCodigos) {
    void ackDteSync(cg);
  }

  return { ok: true, fetched, added, updated, skipped };
}

// ── Mapping ──────────────────────────────────────────────────────────────────

interface DteJsonReceptor {
  nombre?: string;
  nit?: string;
  nrc?: string;
  numDocumento?: string;
  tipoDocumento?: string;
}

interface DteJsonItem {
  descripcion?: string;
  cantidad?: number;
}

interface DteJsonResumen {
  totalPagar?: number;
  totalGravada?: number;
  totalExenta?: number;
  totalNoSuj?: number;
  totalIva?: number;
  subTotal?: number;
  reteRenta?: number;
}

function readReceptor(dte: Record<string, unknown>): DteJsonReceptor | null {
  const r = (dte.receptor ?? null) as DteJsonReceptor | null;
  return r;
}

function readResumen(dte: Record<string, unknown>): DteJsonResumen {
  return (dte.resumen ?? {}) as DteJsonResumen;
}

function readDescripcion(dte: Record<string, unknown>): string {
  const items = (dte.cuerpoDocumento ?? []) as DteJsonItem[];
  if (!Array.isArray(items) || items.length === 0) return '(DTE sin detalle)';
  return items
    .map(it => `${it.cantidad ?? 1}× ${it.descripcion ?? 'item'}`)
    .join(' · ');
}

function dteToVentaConsumidor(rec: DteListedRecord): VentaConsumidor {
  const resumen = readResumen(rec.dte_json);
  const receptor = readReceptor(rec.dte_json);
  const total = resumen.totalPagar ?? resumen.subTotal ?? 0;
  const iva = resumen.totalIva ?? 0;
  const subtotal = total - iva;
  return {
    id: newId(),
    fecha: rec.fec_emi,
    descripcion: readDescripcion(rec.dte_json),
    monto: total.toFixed(2),
    notas: '',
    metadata: {
      source: 'pos',
      origen: rec.origen,
      vendedorNombre: rec.vendedor_nombre ?? undefined,
      beonSaleId: rec.beon_sale_id ?? undefined,
      tipoDocumento: '01',
      numeroDocumento: rec.codigo_generacion,
      numeroControl: rec.numero_control,
      codigoGeneracion: rec.codigo_generacion,
      selloRecibido: rec.sello_recibido ?? undefined,
      hora: rec.hor_emi,
      cliente: receptor?.nombre,
      subtotal: subtotal.toFixed(2),
      iva: iva.toFixed(2),
      documentoJws: rec.documento_jws,
      anulado: rec.estado === 'ANULADO',
      codigoEventoAnulacion: rec.anulacion?.codigo_generacion_evento,
      selloEventoAnulacion: rec.anulacion?.sello_evento ?? undefined,
      fechaAnulacion: rec.anulacion?.fec_anula,
      motivoAnulacion: rec.anulacion?.motivo,
    },
  };
}

function dteToVentaContribuyente(rec: DteListedRecord): VentaContribuyente {
  const resumen = readResumen(rec.dte_json);
  const receptor = readReceptor(rec.dte_json);
  const isNc = rec.tipo_dte === '05';
  const descripcion = readDescripcion(rec.dte_json);
  return {
    id: newId(),
    fecha: rec.fec_emi,
    cliente: receptor?.nombre ?? '(sin nombre)',
    nrc: receptor?.nrc ?? '',
    descripcion: isNc ? `NC: ${descripcion}` : descripcion,
    gravado: (resumen.totalGravada ?? 0).toFixed(2),
    exento: (resumen.totalExenta ?? 0).toFixed(2),
    notas: '',
    metadata: {
      source: 'imported',
      origen: rec.origen,
      vendedorNombre: rec.vendedor_nombre ?? undefined,
      beonSaleId: rec.beon_sale_id ?? undefined,
      claseDocumento: '4',
      tipoDocumento: rec.tipo_dte,
      numeroDocumento: rec.codigo_generacion,
      numeroControl: rec.numero_control,
      selloRecibido: rec.sello_recibido ?? undefined,
      nit: receptor?.nit ?? receptor?.numDocumento,
      retencionRenta: resumen.reteRenta ? resumen.reteRenta.toFixed(2) : undefined,
      documentoJws: rec.documento_jws,
      anulado: rec.estado === 'ANULADO',
      codigoEventoAnulacion: rec.anulacion?.codigo_generacion_evento,
      selloEventoAnulacion: rec.anulacion?.sello_evento ?? undefined,
      fechaAnulacion: rec.anulacion?.fec_anula,
      motivoAnulacion: rec.anulacion?.motivo,
    },
  };
}
