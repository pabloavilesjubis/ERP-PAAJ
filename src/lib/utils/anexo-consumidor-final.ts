import { inPeriod, newId, num } from './format';
import type { ReporteGenerado, VentaConsumidor } from '@/types/domain';

/**
 * Generador del Anexo Consumidor Final (formato F-955 / Hacienda El Salvador).
 *
 * Especificación de campos (separador `;`, sin headers, una línea por DTE):
 *   1.  Fecha de emisión          DD/MM/YYYY
 *   2.  Clase de documento        4   (Documento Tributario Electrónico)
 *   3.  Tipo de DTE               01  (Factura)
 *   4.  Número de Control         sin guiones
 *   5.  Sello de Recepción        tal cual viene del POS
 *   6.  (siempre 0)               0
 *   7.  (siempre 0)               0
 *   8.  Código de Generación      sin guiones
 *   9.  Cód. Generación relacionado  igual al campo 8
 *   10. (vacío)
 *   11. Ventas exentas            0.00
 *   12. Ventas internas exentas no sujetas  0.00
 *   13. Ventas no sujetas         0.00
 *   14. Ventas gravadas           = total con IVA
 *   15. Exportación dentro CA     0.00
 *   16. Exportación fuera CA      0.00
 *   17. Exportación servicios     0.00
 *   18. Tasa cero                 0.00
 *   19. (otro)                    0.00
 *   20. Total                     = total con IVA (igual al 14)
 *   21. (siempre 01)              01
 *   22. Mes del período           1-12 sin padding
 *   23. Tipo de operación         2
 */

const SEP = ';';

function ddmmyyyy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function stripDashes(s: string): string {
  return s.replace(/-/g, '');
}

function fmt2(value: string | number): string {
  return num(value).toFixed(2);
}

export interface AnexoBuildOptions {
  month: number;          // 0-11 (JS) — convertimos a 1-12 internamente
  year: number;
  ventas: VentaConsumidor[];
  /** Tipo de ingreso (campo 23). 1=servicios, 2=bienes, 3=mixto, 4=otros. */
  tipoIngreso?: string;
}

export interface AnexoBuildResult {
  csv: string;
  filename: string;
  rowCount: number;
  totalAmount: number;
  excludedNoMetadata: number;
}

/** Construye el CSV listo para cargar en el portal del MH. */
export function buildAnexoConsumidorFinal(opts: AnexoBuildOptions): AnexoBuildResult {
  const { month, year, ventas, tipoIngreso = '3' } = opts;
  const monthOneBased = month + 1;

  // Filtra el período exacto y exige metadata DTE (sello + código + número de control).
  const eligibles = ventas
    .filter(v => inPeriod(v.fecha, month, year))
    .sort((a, b) => b.fecha.localeCompare(a.fecha));   // descendente por fecha

  const excludedNoMetadata = eligibles.filter(v => {
    const meta = v.metadata;
    return !meta?.numeroControl || !meta?.codigoGeneracion;
  }).length;

  const exportable = eligibles.filter(v => {
    const meta = v.metadata;
    return !!meta?.numeroControl && !!meta?.codigoGeneracion;
  });

  const lines = exportable.map(v => {
    const m = v.metadata!;
    const total = fmt2(v.monto);
    const fields = [
      ddmmyyyy(v.fecha),
      '4',
      '01',
      stripDashes(m.numeroControl ?? ''),
      m.selloRecibido ?? '',
      '0',
      '0',
      stripDashes(m.codigoGeneracion ?? ''),
      stripDashes(m.codigoGeneracion ?? ''),
      '',
      '0.00',
      '0.00',
      '0.00',
      total,
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      total,
      '01',
      tipoIngreso,    // 22 — Tipo de Ingreso (NO es el mes; '3' = actividades comerciales)
      '2',            // 23 — código fijo
    ];
    return fields.join(SEP);
  });

  // Usamos CRLF (\r\n) para coincidir exactamente con el formato que acepta el
  // portal del MH. El parser de Hacienda valida estrictamente.
  const csv = lines.join('\r\n');

  const totalAmount = exportable.reduce((s, v) => s + num(v.monto), 0);
  const pad = String(monthOneBased).padStart(2, '0');
  const filename = `ANEXO_CONSUMIDOR_FINAL_${year}-${pad}.csv`;

  return {
    csv,
    filename,
    rowCount: exportable.length,
    totalAmount,
    excludedNoMetadata,
  };
}

/** Crea el objeto ReporteGenerado para almacenarlo en la "pestaña de reportes". */
export function makeReporteFromAnexo(
  built: AnexoBuildResult,
  month: number,
  year: number,
): ReporteGenerado {
  return {
    id: newId(),
    tipo: 'anexo_consumidor_final',
    periodoMonth: month + 1,
    periodoYear: year,
    filename: built.filename,
    csvContent: built.csv,
    rowCount: built.rowCount,
    totalAmount: built.totalAmount.toFixed(2),
    generatedAt: new Date().toISOString(),
  };
}

/** Descarga un reporte como archivo .csv. */
export function downloadReporte(reporte: ReporteGenerado): void {
  // SIN BOM — el portal de Hacienda lee el archivo byte a byte y un BOM al
  // inicio rompe el parseo de la primera fila ("formato de fecha incorrecto").
  // El archivo es ASCII puro (dígitos, ';', '/', '.', '-'), encoding irrelevante.
  const blob = new Blob([reporte.csvContent], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = reporte.filename;
  a.click();
  URL.revokeObjectURL(url);
}
