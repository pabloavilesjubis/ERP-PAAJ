import { inPeriod, newId, num } from './format';
import type { Compra, ReporteGenerado } from '@/types/domain';

/**
 * Generador del Anexo de Compras (formato F-930 / Libro de Compras IVA, MH El Salvador).
 *
 * 21 campos separados por `;`, sin headers, una línea por documento de compra:
 *   1.  Fecha emisión documento     DD/MM/AAAA
 *   2.  Clase de documento          1=Imprenta · 2=Formulario único · 3=Otros · 4=DTE
 *   3.  Tipo de documento           03=CCF · 14=Sujeto Excluido · 05=Nota Crédito · etc.
 *   4.  Número de documento         Cód. Generación sin guiones (DTE) o correlativo (impreso)
 *   5.  NRC proveedor
 *   6.  Nombre proveedor
 *   7.  Compras internas exentas              0.00
 *   8.  Internaciones exentas y no sujetas    0.00
 *   9.  Importaciones exentas y no sujetas    0.00
 *   10. Compras internas gravadas             = monto - ivaCredito (base sin IVA)
 *   11. Internaciones gravadas                0.00
 *   12. Importaciones gravadas (bienes)       0.00
 *   13. Importaciones gravadas (servicios)    0.00
 *   14. Crédito fiscal IVA                    = ivaCredito
 *   15. Total compras                         = monto - ivaCredito (igual al campo 10)
 *   16. Número de anexo                       (vacío)
 *   17. Tipo de operación                     1 = Local
 *   18. Clasificación                         1=Costo, 2=Gasto (default 2)
 *   19. Sector                                1=Industria, 2=Comercio, 3=Servicio (default 2)
 *   20. Tipo de costo/gasto                   default 2
 *   21. (giro / actividad)                    default 3
 *
 * Notas:
 *   - El "Total" (campo 15) en este anexo es la BASE (sin IVA), no el monto pagado.
 *     Eso replica exactamente la convención del MH para libro de compras.
 *   - Para DTE, el Núm. de Documento es el Código de Generación SIN guiones (32 hex).
 *   - Salida: CRLF, sin BOM. El portal del MH valida byte a byte.
 */

const SEP = ';';

function ddmmyyyy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function stripDashes(s: string): string {
  return (s ?? '').replace(/-/g, '');
}

function fmt2(value: string | number): string {
  return num(value).toFixed(2);
}

export interface AnexoComprasOptions {
  month: number;          // 0-11
  year: number;
  compras: Compra[];
}

export interface AnexoComprasResult {
  csv: string;
  filename: string;
  rowCount: number;
  totalAmount: number;
  excludedNoMetadata: number;
}

export function buildAnexoCompras(opts: AnexoComprasOptions): AnexoComprasResult {
  const { month, year, compras } = opts;
  const monthOneBased = month + 1;

  const eligibles = compras
    .filter(c => inPeriod(c.fecha, month, year))
    .sort((a, b) => b.fecha.localeCompare(a.fecha));

  // Filtra solo las que tienen metadata fiscal mínima (clase, tipo, número doc).
  const exportable = eligibles.filter(c => {
    const m = c.metadata;
    return !!m?.claseDocumento && !!m?.tipoDocumento && !!m?.numeroDocumento;
  });
  const excludedNoMetadata = eligibles.length - exportable.length;

  const lines = exportable.map(c => {
    const m = c.metadata!;
    const monto = num(c.monto);
    const iva = num(c.ivaCredito);
    const baseGravada = +(monto - iva).toFixed(2);

    // Para DTE, el Núm. Documento es el Cód. Generación SIN guiones.
    const isDTE = m.claseDocumento === '4';
    const numDoc = isDTE ? stripDashes(m.numeroDocumento ?? '') : (m.numeroDocumento ?? '');

    const fields = [
      ddmmyyyy(c.fecha),                       // 1
      m.claseDocumento ?? '',                  // 2
      m.tipoDocumento ?? '',                   // 3
      numDoc,                                  // 4
      c.nrc ?? '',                             // 5
      c.proveedor ?? '',                       // 6
      '0.00',                                  // 7
      '0.00',                                  // 8
      '0.00',                                  // 9
      fmt2(baseGravada),                       // 10
      '0.00',                                  // 11
      '0.00',                                  // 12
      '0.00',                                  // 13
      fmt2(iva),                               // 14
      fmt2(baseGravada),                       // 15
      '',                                      // 16
      m.tipoOperacion ?? '1',                  // 17
      m.clasificacion ?? '2',                  // 18
      m.sector ?? '2',                         // 19
      m.tipoCostoGasto ?? '2',                 // 20
      m.numeroAnexo ?? '3',                    // 21
    ];
    return fields.join(SEP);
  });

  const csv = lines.join('\r\n');
  const totalAmount = exportable.reduce((s, c) => s + (num(c.monto) - num(c.ivaCredito)), 0);
  const pad = String(monthOneBased).padStart(2, '0');
  const filename = `ANEXO_COMPRAS_${year}-${pad}.csv`;

  return {
    csv,
    filename,
    rowCount: exportable.length,
    totalAmount,
    excludedNoMetadata,
  };
}

export function makeReporteFromAnexoCompras(
  built: AnexoComprasResult,
  month: number,
  year: number,
): ReporteGenerado {
  return {
    id: newId(),
    tipo: 'anexo_compras',
    periodoMonth: month + 1,
    periodoYear: year,
    filename: built.filename,
    csvContent: built.csv,
    rowCount: built.rowCount,
    totalAmount: built.totalAmount.toFixed(2),
    generatedAt: new Date().toISOString(),
  };
}
