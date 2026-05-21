import { IVA_RATE } from '@/config/constants';
import { inPeriod, newId, num } from './format';
import type { ReporteGenerado, VentaContribuyente } from '@/types/domain';

/**
 * Generador del Anexo de Ventas a Contribuyentes (F-955, MH El Salvador).
 *
 * 20 campos separados por `;`, sin headers, una línea por documento:
 *   1.  Fecha emisión             DD/MM/AAAA
 *   2.  Clase de documento        4 = DTE (típico)
 *   3.  Tipo de documento         03 = CCF · 11 = Exportación · 05/06 Notas · 14 FSE
 *   4.  Número de Control         sin guiones (DTE03M001P001...)
 *   5.  Sello de Recepción
 *   6.  Código de Generación      sin guiones (32 hex)
 *   7.  Doc. relacionado          vacío para CCF normal; para Notas Crédito/Débito
 *                                 sería el cód. gen. del DTE original
 *   8.  NIT del cliente
 *   9.  Nombre del cliente
 *   10. Ventas exentas
 *   11. Ventas no sujetas         0.00
 *   12. Ventas gravadas           = base sin IVA
 *   13. Débito fiscal             = gravado × 0.13
 *   14. IVA percibido             0.00
 *   15. IVA retenido (1%)         0.00
 *   16. Total                     = gravado + IVA + exento
 *   17. Anexo                     vacío
 *   18. Tipo de operación         01 = Local
 *   19. Tipo de ingreso           02 (default)
 *   20. Otro código               1  (default)
 *
 * Salida: CRLF, sin BOM. El portal del MH valida byte a byte.
 */

const SEP = ';';

function ddmmyyyy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function stripDashes(s: string | undefined): string {
  return (s ?? '').replace(/-/g, '');
}

function fmt2(value: string | number): string {
  return num(value).toFixed(2);
}

export interface AnexoVentasContribuyenteOptions {
  month: number;          // 0-11
  year: number;
  ventas: VentaContribuyente[];
  /** Tipo de ingreso (campo 19). 1=servicios, 2=bienes, 3=mixto. Default 2. */
  tipoIngreso?: string;
}

export interface AnexoVentasContribuyenteResult {
  csv: string;
  filename: string;
  rowCount: number;
  totalAmount: number;
  excludedNoMetadata: number;
}

export function buildAnexoVentasContribuyente(
  opts: AnexoVentasContribuyenteOptions,
): AnexoVentasContribuyenteResult {
  const { month, year, ventas, tipoIngreso = '02' } = opts;
  const monthOneBased = month + 1;

  const eligibles = ventas
    .filter(v => inPeriod(v.fecha, month, year))
    .sort((a, b) => b.fecha.localeCompare(a.fecha));

  // Solo exportamos los que tengan metadata fiscal mínima (clase, tipo, doc).
  const exportable = eligibles.filter(v => {
    const m = v.metadata;
    return !!m?.claseDocumento && !!m?.tipoDocumento && !!m?.numeroDocumento;
  });
  const excludedNoMetadata = eligibles.length - exportable.length;

  const lines = exportable.map(v => {
    const m = v.metadata!;
    const gravado = num(v.gravado);
    const exento = num(v.exento);
    const ivaDebito = +(gravado * IVA_RATE).toFixed(2);
    const total = +(gravado + ivaDebito + exento).toFixed(2);

    const isDTE = m.claseDocumento === '4';
    const numControl = isDTE ? stripDashes(m.numeroControl) : (m.numeroControl ?? '');
    const codGen = stripDashes(m.numeroDocumento);

    const fields = [
      ddmmyyyy(v.fecha),                       // 1
      m.claseDocumento ?? '4',                  // 2
      m.tipoDocumento ?? '03',                  // 3
      numControl,                               // 4
      m.selloRecibido ?? '',                    // 5
      codGen,                                   // 6
      '',                                       // 7 (doc relacionado)
      m.nit ?? '',                              // 8
      v.cliente,                                // 9
      fmt2(exento),                             // 10
      '0.00',                                   // 11
      fmt2(gravado),                            // 12
      fmt2(ivaDebito),                          // 13
      '0.00',                                   // 14
      '0.00',                                   // 15
      fmt2(total),                              // 16
      '',                                       // 17
      '01',                                     // 18
      tipoIngreso,                              // 19
      '1',                                      // 20
    ];
    return fields.join(SEP);
  });

  const csv = lines.join('\r\n');
  const totalAmount = exportable.reduce((s, v) => {
    const g = num(v.gravado);
    return s + g + g * IVA_RATE + num(v.exento);
  }, 0);
  const pad = String(monthOneBased).padStart(2, '0');
  const filename = `ANEXO_VENTAS_CONTRIBUYENTE_${year}-${pad}.csv`;

  return {
    csv,
    filename,
    rowCount: exportable.length,
    totalAmount,
    excludedNoMetadata,
  };
}

export function makeReporteFromAnexoVentasContribuyente(
  built: AnexoVentasContribuyenteResult,
  month: number,
  year: number,
): ReporteGenerado {
  return {
    id: newId(),
    tipo: 'anexo_ventas_contribuyente',
    periodoMonth: month + 1,
    periodoYear: year,
    filename: built.filename,
    csvContent: built.csv,
    rowCount: built.rowCount,
    totalAmount: built.totalAmount.toFixed(2),
    generatedAt: new Date().toISOString(),
  };
}
