import { inPeriod, newId, num } from './format';
import type { Compra, Contribuyente, ReporteGenerado } from '@/types/domain';

/**
 * Generador del Anexo F-14 — Retenciones de Renta.
 *
 * Formato exacto del MH El Salvador (verificado contra sample real, 23 campos
 * separados por `;`, sin headers, una línea por retención):
 *
 *   1.  Tipo de persona            "1" natural · "2" jurídica
 *   2.  Código de retención MH     "9300" natural · "9450" jurídica (otros: 9438/9642/9705)
 *   3.  Nombre del retenido
 *   4.  NIT                        (vacío si la persona natural se reporta por DUI)
 *   5.  DUI                        (vacío si reporta por NIT)
 *   6.  Tipo de operación          "01" empleados · "11" servicios · "36" exterior · "60" empleados sin ISR
 *   7.  Monto sujeto a retención   = base sin IVA
 *   8.  Reservado                  "0.00"
 *   9.  Monto retenido (ISR)
 *   10. ISR exento                 "0.00"
 *   11. Reservado                  "0.00"
 *   12. AFP retenida               7.25% del salario para empleados (op 01/60); 0 en otros casos
 *   13. ISSS retenido              3% del salario con tope $30 para empleados; 0 en otros casos
 *   14-18. Reservados              "0.00"
 *   19. Constante                  "1"
 *   20. Sub-categoría              "2" si código de ingreso (campo 22) = 2 (permanente);
 *                                  "1" en cualquier otro caso (eventuales, jurídicas, especiales).
 *   21. Constante                  "4"
 *   22. Código de ingreso          "2" natural permanente · "4" jurídica · "5" honorarios · "1" eventual
 *   23. Período                    MMYYYY (ej. "032026" para marzo 2026)
 *
 * Salida: CRLF, sin BOM. Validación estricta del portal del MH.
 */

const SEP = ';';

function fmt2(value: string | number): string {
  return num(value).toFixed(2);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export interface F14BuildOptions {
  month: number;          // 0-11
  year: number;
  compras: Compra[];
  /** Catálogo de contribuyentes para fallback de NIT/DUI cuando la metadata
   *  de la compra no los tenga (typical para compras antiguas creadas antes
   *  de capturar identidad fiscal). Match por NRC. */
  contribuyentes?: Contribuyente[];
}

export interface F14MissingIdentity {
  id: string;
  proveedor: string;
  fecha: string;
  retenido: number;
  motivo: string;
}

export interface F14BuildResult {
  csv: string;
  filename: string;
  rowCount: number;
  totalBase: number;
  totalRetenido: number;
  missingIdentity: F14MissingIdentity[];   // filas excluidas por falta de NIT/DUI
}

export function buildF14Retenciones(opts: F14BuildOptions): F14BuildResult {
  const { month, year, compras, contribuyentes = [] } = opts;
  const monthOneBased = month + 1;
  const periodo = `${pad2(monthOneBased)}${year}`;

  // Index por NRC para fallback de NIT/DUI desde el catálogo de contribuyentes.
  const contribByNrc = new Map<string, Contribuyente>();
  for (const c of contribuyentes) if (c.nrc) contribByNrc.set(c.nrc, c);

  /** Resuelve NIT y DUI efectivos: primero metadata, luego catálogo de contribuyentes. */
  function resolveIdentity(c: Compra): { nit: string; dui: string } {
    const m = c.metadata ?? {};
    const linked = c.nrc ? contribByNrc.get(c.nrc) : undefined;
    const nit = (m.nit && m.nit.trim()) ? m.nit.trim() : (linked?.nit ?? '');
    const dui = (m.dui && m.dui.trim()) ? m.dui.trim() : (linked?.dui ?? '');
    return { nit: nit.replace(/-/g, ''), dui: dui.replace(/-/g, '') };
  }

  // Solo las compras del período con retención > 0.
  const candidates = compras
    .filter(c => inPeriod(c.fecha, month, year))
    .filter(c => num(c.metadata?.retencionRenta ?? 0) > 0)
    .sort((a, b) => b.fecha.localeCompare(a.fecha));

  const missingIdentity: F14MissingIdentity[] = [];

  // Filtrar candidatos: descarta los que no tienen NIT ni DUI (el portal del MH
  // los rechaza con "Debe completar campo de NIT o DUI").
  const eligibles = candidates.filter(c => {
    const { nit, dui } = resolveIdentity(c);
    if (!nit && !dui) {
      missingIdentity.push({
        id: c.id,
        proveedor: c.proveedor,
        fecha: c.fecha,
        retenido: num(c.metadata?.retencionRenta),
        motivo: 'Falta NIT o DUI del proveedor',
      });
      return false;
    }
    return true;
  });

  const lines = eligibles.map(c => {
    const m = c.metadata ?? {};
    const base = num(c.monto) - num(c.ivaCredito);
    const retenido = num(m.retencionRenta);

    const esJuridica = m.tipoPersona === 'juridica';
    const tipoPersonaCode = esJuridica ? '2' : '1';
    const codigoMH = m.retencionCodigoMH ?? (esJuridica ? '9450' : '9300');

    // NIT vs DUI: jurídica siempre por NIT. Natural: si DUI está lleno → DUI;
    // si solo hay NIT → NIT (porque algunas naturales se reportan por NIT).
    const { nit, dui } = resolveIdentity(c);
    let nitField = '';
    let duiField = '';
    if (esJuridica) {
      nitField = nit;
    } else {
      if (dui) duiField = dui;
      else nitField = nit;
    }

    const tipoOperacion = m.retencionConcepto ?? '11';

    // Código de ingreso (campo 22) — el portal lo valida contra la clase de
    // contribuyente. Por default 2=natural, 4=jurídica; el usuario puede sobre-
    // escribir desde el modal con valores especiales (1, 5, etc.).
    const codigoIngreso = m.retencionCodigoIngreso ?? (esJuridica ? '4' : '2');

    // AFP/ISSS solo aplican a planilla (op 01 = empleados con ISR · op 60 = sin
    // ISR). En servicios/exportación van en 0. Si la metadata trae valores los
    // respetamos (override del usuario); si no, calculamos los defaults legales.
    const esEmpleado = tipoOperacion === '01' || tipoOperacion === '60';
    const afpDefault = esEmpleado ? +(base * 0.0725).toFixed(2) : 0;
    const isssDefault = esEmpleado ? Math.min(+(base * 0.03).toFixed(2), 30) : 0;
    const afpField = m.afpRetenido !== undefined && m.afpRetenido !== ''
      ? fmt2(m.afpRetenido)
      : fmt2(afpDefault);
    const isssField = m.isssRetenido !== undefined && m.isssRetenido !== ''
      ? fmt2(m.isssRetenido)
      : fmt2(isssDefault);

    // Campo 20: 2 cuando es permanente (código de ingreso = 2); 1 en cualquier
    // otro caso (jurídicas con código 4, eventuales con 1, honorarios con 5).
    // Verificado contra archivo aceptado por MH (marzo 2026).
    const subCategoria = codigoIngreso === '2' ? '2' : '1';

    const fields = [
      tipoPersonaCode,                           // 1
      codigoMH,                                  // 2
      c.proveedor,                               // 3
      nitField,                                  // 4
      duiField,                                  // 5
      tipoOperacion,                             // 6
      fmt2(base),                                // 7
      '0.00',                                    // 8
      fmt2(retenido),                            // 9
      '0.00',                                    // 10
      '0.00',                                    // 11
      afpField,                                  // 12 AFP
      isssField,                                 // 13 ISSS
      '0.00',                                    // 14
      '0.00',                                    // 15
      '0.00',                                    // 16
      '0.00',                                    // 17
      '0.00',                                    // 18
      '1',                                       // 19
      subCategoria,                              // 20
      '4',                                       // 21
      codigoIngreso,                             // 22
      periodo,                                   // 23
    ];
    return fields.join(SEP);
  });

  const csv = lines.join('\r\n');
  const totalBase = eligibles.reduce((s, c) => s + (num(c.monto) - num(c.ivaCredito)), 0);
  const totalRetenido = eligibles.reduce((s, c) => s + num(c.metadata?.retencionRenta ?? 0), 0);
  const filename = `F14_RETENCIONES_${year}-${pad2(monthOneBased)}.csv`;

  return {
    csv,
    filename,
    rowCount: eligibles.length,
    totalBase,
    totalRetenido,
    missingIdentity,
  };
}

export function makeReporteFromF14(
  built: F14BuildResult,
  month: number,
  year: number,
): ReporteGenerado {
  return {
    id: newId(),
    tipo: 'f14_retenciones',
    periodoMonth: month + 1,
    periodoYear: year,
    filename: built.filename,
    csvContent: built.csv,
    rowCount: built.rowCount,
    totalAmount: built.totalRetenido.toFixed(2),
    generatedAt: new Date().toISOString(),
  };
}
