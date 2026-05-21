import Papa from 'papaparse';
import { joinDate, newId } from './format';
import { findDuplicate } from './duplicates';
import type { VentaConsumidor } from '@/types/domain';

/**
 * Importador del reporte POS de tickets (formato DTE-MH).
 *
 * Detecta las columnas **por nombre del header**, no por posición fija. Así soporta
 * exports con distinto número y orden de columnas (algunos POS exportan 30 columnas
 * detalladas; otros sólo 15-20 resumidas). Tolera headers con tilde, mal codificados
 * (`aÃ±o`), variaciones (`Fecha`, `Fecha emisión`, `dia`/`día`), y archivos con
 * separador `,` o `;`.
 */

interface ColumnMap {
  orden?: number;
  tipoComprobante?: number;
  numeroControl?: number;
  codigoGen?: number;
  selloRecibido?: number;
  dia?: number;
  mes?: number;
  anio?: number;
  fecha?: number;          // alternativa: una sola columna combinada
  hora?: number;
  autorizadoPor?: number;
  cliente?: number;
  tipoDocumento?: number;
  numeroDocumento?: number;
  subtotal?: number;
  iva?: number;
  ventasGravadas?: number;
  total?: number;
}

/** Patrones de match para cada campo. El primer patrón que matchee gana. */
const HEADER_PATTERNS: Record<keyof ColumnMap, RegExp[]> = {
  orden:            [/^(orden|n[uú]mero\s+de\s+orden|order|#)$/i],
  tipoComprobante:  [/tipo.*comprobante|tipo.*dte/i],
  numeroControl:    [/(n[uú]mero|num\.?|no\.?)\s*(de\s+)?control/i, /^numero\s+control$/i, /^control$/i],
  codigoGen:        [/c[oó]digo.*generaci[oó]n|generaci[oó]n/i],
  selloRecibido:    [/sello/i],
  dia:              [/^d[ií]a$/i],
  mes:              [/^mes$/i],
  anio:             [/^a.{1,3}o$/i, /^year$/i],          // matches año, aÃ±o, anio
  fecha:            [/^fecha(\s+(de\s+)?(emisi[oó]n|venta|documento))?$/i],
  hora:             [/^hora$/i],
  autorizadoPor:    [/autorizad/i],
  cliente:          [/^cliente$/i, /raz[oó]n\s+social/i, /nombre.*cliente/i],
  tipoDocumento:    [/^tipo\s+(de\s+)?documento$/i],
  numeroDocumento:  [/(n[uú]mero|num\.?|no\.?)\s*(de\s+)?documento/i, /^dui$/i, /^nit$/i],
  subtotal:         [/^subtotal$/i, /^sub.?total$/i, /sub.?total.*iva/i],
  iva:              [/^iva(\s+\d+%?)?$/i, /impuesto.*iva/i],
  ventasGravadas:   [/^ventas\s+gravadas$/i, /monto.*gravad/i],
  total:            [/^total$/i, /total\s+(general|venta|factura)/i, /monto\s+total/i],
};

function clean(value: unknown): string {
  if (value == null) return '';
  return String(value).replace(/^[﻿​]+/, '').trim();
}

/**
 * Construye un mapa header→índice. Para cada campo, el primer header que matchee
 * un patrón de su lista será asignado.
 */
function buildColumnMap(headers: string[]): ColumnMap {
  const map: ColumnMap = {};
  headers.forEach((rawHeader, idx) => {
    const h = clean(rawHeader);
    if (!h) return;
    for (const field of Object.keys(HEADER_PATTERNS) as (keyof ColumnMap)[]) {
      if (map[field] !== undefined) continue;
      if (HEADER_PATTERNS[field].some(p => p.test(h))) {
        map[field] = idx;
        break;
      }
    }
  });
  return map;
}

/** Acepta números con coma decimal `8,4` o punto `8.4` y quita símbolos `$`, etc. */
function flexibleNum(value: string): number {
  if (!value) return 0;
  const cleaned = value.replace(/[^\d,.\-]/g, '');
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized: string;
  if (lastComma > lastDot) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    normalized = cleaned.replace(/,/g, '');
  }
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Convierte una fecha en cualquier formato común a `YYYY-MM-DD`.
 * Acepta:
 *   "DD/MM/YYYY", "DD-MM-YYYY", "DD/MM/YY"
 *   "YYYY-MM-DD"
 *   "D/M/YYYY HH:MM:SS"
 *   ISO con tiempo
 */
function parseFlexibleDate(value: string): string | null {
  if (!value) return null;
  const v = value.trim();

  // ISO: YYYY-MM-DD (con o sin tiempo)
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;

  // DD/MM/YYYY o DD-MM-YYYY
  m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/.exec(v);
  if (m) {
    let yyyy = m[3];
    if (yyyy.length === 2) yyyy = (parseInt(yyyy) > 50 ? '19' : '20') + yyyy;
    return `${yyyy}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }

  return null;
}

const RX_DTE_FE  = /^DTE-01-/i;
const RX_DTE_CCF = /^DTE-03-/i;

function classify(numeroControl: string, tipoComprobante: string): 'fe' | 'ccf' | 'other' | 'unknown' {
  if (RX_DTE_FE.test(numeroControl))  return 'fe';
  if (RX_DTE_CCF.test(numeroControl)) return 'ccf';
  if (/^DTE-/i.test(numeroControl))   return 'other';
  const t = tipoComprobante.toLowerCase();
  if (/factura|ticket|consumidor|fe\b/.test(t)) return 'fe';
  if (/ccf|cr[eé]dito\s+fiscal/.test(t))         return 'ccf';
  return 'unknown';
}

export interface PosImportResult {
  ok: VentaConsumidor[];
  skippedCCF: number;
  skippedOther: number;
  skippedEmpty: number;
  errors: { row: number; reason: string }[];
  detectedTipos: string[];
  diagnostics: {
    delimiter: string;
    totalRows: number;
    headers: string[];
    columnMap: Record<string, number | string>;
    sampleFirstRow: Record<string, string>;
  };
}

export function parsePosCsv(file: File): Promise<PosImportResult> {
  return new Promise((resolve, reject) => {
    Papa.parse<string[]>(file, {
      header: false,
      skipEmptyLines: true,
      delimiter: '',
      delimitersToGuess: [',', ';', '\t', '|'],
      complete: results => {
        const detectedDelimiter = results.meta?.delimiter ?? ',';
        const rows = results.data;
        const out: PosImportResult = {
          ok: [], skippedCCF: 0, skippedOther: 0, skippedEmpty: 0, errors: [], detectedTipos: [],
          diagnostics: {
            delimiter: detectedDelimiter,
            totalRows: rows.length,
            headers: [],
            columnMap: {},
            sampleFirstRow: {},
          },
        };

        if (rows.length === 0) {
          resolve(out);
          return;
        }

        // Primera fila = headers. Detectamos por la palabra "orden" o "control".
        const firstRow = rows[0].map(clean);
        const looksLikeHeader = firstRow.some(h => /orden|control|fecha|d[ií]a/i.test(h));
        const startIdx = looksLikeHeader ? 1 : 0;
        const headers = looksLikeHeader ? firstRow : [];
        const colMap = looksLikeHeader ? buildColumnMap(headers) : {};

        out.diagnostics.headers = headers;
        out.diagnostics.columnMap = Object.fromEntries(
          Object.entries(colMap).map(([k, v]) => [k, `${v} → "${headers[v as number] ?? ''}"`]),
        );

        // Sample de la primera fila de datos para diagnóstico
        const sampleRow = rows[startIdx];
        if (sampleRow) {
          const at = (i?: number) => i != null ? clean(sampleRow[i]) : '(no mapeada)';
          out.diagnostics.sampleFirstRow = {
            'orden':         at(colMap.orden),
            'tipo':          at(colMap.tipoComprobante),
            'DTE':           at(colMap.numeroControl),
            'fecha (única)': at(colMap.fecha),
            'día/mes/año':   `${at(colMap.dia)} / ${at(colMap.mes)} / ${at(colMap.anio)}`,
            'subtotal':      at(colMap.subtotal),
            'IVA':           at(colMap.iva),
            'total':         at(colMap.total),
            'gravadas':      at(colMap.ventasGravadas),
          };
        }

        const tiposSet = new Set<string>();

        for (let i = startIdx; i < rows.length; i++) {
          const row = rows[i];
          const lineNumber = i + 1;

          try {
            const orden          = at(row, colMap.orden);
            const tipoComprobante = at(row, colMap.tipoComprobante);
            const numeroControl  = at(row, colMap.numeroControl);

            if (!orden && !tipoComprobante && !numeroControl) {
              out.skippedEmpty++;
              continue;
            }

            if (tipoComprobante) tiposSet.add(tipoComprobante);

            const kind = classify(numeroControl, tipoComprobante);
            if (kind === 'ccf') { out.skippedCCF++; continue; }
            if (kind === 'other') { out.skippedOther++; continue; }

            // Fecha: prefiere día/mes/año, si no, fecha única
            let fecha: string | null = null;
            if (colMap.dia != null && colMap.mes != null && colMap.anio != null) {
              const dia = at(row, colMap.dia);
              const mes = at(row, colMap.mes);
              const anio = at(row, colMap.anio);
              if (dia && mes && anio) fecha = joinDate(dia, mes, anio);
            }
            if (!fecha && colMap.fecha != null) {
              fecha = parseFlexibleDate(at(row, colMap.fecha));
            }
            if (!fecha) {
              out.errors.push({ row: lineNumber, reason: 'No se pudo determinar la fecha' });
              continue;
            }

            // Total: prefiere col Total, si no, Ventas Gravadas, si no, Subtotal+IVA
            let total = flexibleNum(at(row, colMap.total));
            if (total <= 0 && colMap.ventasGravadas != null) {
              total = flexibleNum(at(row, colMap.ventasGravadas));
            }
            if (total <= 0 && colMap.subtotal != null && colMap.iva != null) {
              total = flexibleNum(at(row, colMap.subtotal)) + flexibleNum(at(row, colMap.iva));
            }
            if (total <= 0) {
              out.skippedEmpty++;
              continue;
            }

            const vendedor = at(row, colMap.autorizadoPor);
            const cliente = at(row, colMap.cliente);
            const descripcionParts = [
              `Factura POS #${orden || '?'}`,
              vendedor && `· ${vendedor}`,
              cliente && `· ${cliente}`,
            ].filter(Boolean);

            out.ok.push({
              id: newId(),
              fecha,
              descripcion: descripcionParts.join(' '),
              monto: total.toFixed(2),
              notas: '',
              metadata: {
                source: 'pos',
                orden,
                numeroControl,
                codigoGeneracion: at(row, colMap.codigoGen),
                selloRecibido: at(row, colMap.selloRecibido),
                hora: at(row, colMap.hora),
                autorizadoPor: vendedor,
                cliente,
                tipoDocumento: at(row, colMap.tipoDocumento),
                numeroDocumento: at(row, colMap.numeroDocumento),
                subtotal: flexibleNum(at(row, colMap.subtotal)).toFixed(2),
                iva: flexibleNum(at(row, colMap.iva)).toFixed(2),
              },
            });
          } catch (e) {
            out.errors.push({
              row: lineNumber,
              reason: e instanceof Error ? e.message : 'Error de parseo',
            });
          }
        }

        out.detectedTipos = Array.from(tiposSet);
        resolve(out);
      },
      error: reject,
    });
  });
}

/** Lee `row[idx]` con el clean aplicado, devolviendo '' si idx es undefined. */
function at(row: string[], idx: number | undefined): string {
  if (idx == null) return '';
  return clean(row[idx]);
}

/**
 * Filtra el CSV importado contra:
 *   1) Lo que ya existe en la BD (`existing`).
 *   2) Lo que se va aceptando dentro del MISMO archivo (evita que un POS exporte
 *      dos veces el mismo ticket y entre duplicado).
 *
 * Match por Núm. Control / Cód. Generación / Sello (vía findDuplicate). Como
 * fallback para tickets sin DTE, usa fecha+monto+orden.
 */
export function dedupePosImports(
  existing: VentaConsumidor[],
  incoming: VentaConsumidor[],
): { newOnes: VentaConsumidor[]; duplicates: number } {
  const accepted: VentaConsumidor[] = [];
  const seenFallbackKey = new Set<string>();
  for (const r of existing) {
    const k = `${r.fecha}|${r.monto}|${r.metadata?.orden ?? ''}`;
    seenFallbackKey.add(k);
  }

  let duplicates = 0;
  for (const r of incoming) {
    const fingerprint = {
      numeroControl: r.metadata?.numeroControl,
      codigoGeneracion: r.metadata?.codigoGeneracion,
      selloRecibido: r.metadata?.selloRecibido,
    };
    const hasDteFingerprint = !!(fingerprint.numeroControl || fingerprint.codigoGeneracion || fingerprint.selloRecibido);

    // Match contra existentes + ya aceptados de este mismo archivo
    if (hasDteFingerprint) {
      if (findDuplicate(existing, fingerprint) || findDuplicate(accepted, fingerprint)) {
        duplicates++;
        continue;
      }
    } else {
      // Sin DTE: caemos al fallback por fecha + monto + orden
      const k = `${r.fecha}|${r.monto}|${r.metadata?.orden ?? ''}`;
      if (seenFallbackKey.has(k)) { duplicates++; continue; }
      seenFallbackKey.add(k);
    }

    accepted.push(r);
  }
  return { newOnes: accepted, duplicates };
}
