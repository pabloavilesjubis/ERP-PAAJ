/**
 * Parser del JSON oficial del DTE (Documento Tributario Electrónico) del MH
 * de El Salvador. Soporta dos perspectivas:
 *
 *   - 'compra': nuestra empresa es el RECEPTOR del DTE.
 *               La contraparte (= proveedor) se lee de `emisor`.
 *
 *   - 'venta':  nuestra empresa es el EMISOR del DTE.
 *               La contraparte (= cliente) se lee de `receptor`.
 *
 * Un mismo JSON sirve para ambos lados — solo cambia de qué nodo del
 * documento se extrae el nombre/NRC/NIT.
 *
 * Estructura típica:
 *   {
 *     identificacion: { tipoDte, numeroControl, codigoGeneracion, fecEmi, ... },
 *     emisor:         { nit, nrc, nombre, ... },
 *     receptor:       { nit, nrc, nombre, ... },
 *     cuerpoDocumento: [{ descripcion, ventaGravada, ivaItem, ... }],
 *     resumen:        { totalGravada, totalIva, montoTotalOperacion, tributos[], ... },
 *     selloRecibido:  "..."
 *   }
 *
 * Algunos sistemas envían el DTE envuelto en `documento` / `dteJson` / `dte`;
 * lo manejamos.
 */

export type DtePerspective = 'compra' | 'venta';

export interface ParsedDte {
  fecha: string;             // YYYY-MM-DD
  tipoDte: string;           // '03', '14', '05', etc.
  numeroControl: string;     // DTE-XX-...
  codigoGeneracion: string;  // UUID con guiones, mayúsculas
  selloRecibido?: string;
  /** Nombre de la contraparte (proveedor en compra, cliente en venta). */
  contraparteNombre: string;
  contraparteNrc: string;
  contraparteNit?: string;
  /** Base gravada sin IVA, ej. "13137.88" */
  totalGravada: string;
  totalExenta: string;
  totalNoSujeta: string;
  /** IVA, ej. "1707.92" */
  totalIva: string;
  /** Retención de Renta (ISR) — típicamente 10% del gravado en servicios. */
  reteRenta: string;
  /** Retención de IVA (1% típicamente) — solo informativo. */
  reteIva: string;
  /** Total con IVA antes de retenciones (= base + IVA), ej. "14845.80" */
  montoTotal: string;
  descripcion: string;
  warnings: string[];
}

export type DteParseOutcome =
  | { ok: true; data: ParsedDte }
  | { ok: false; error: string };

interface DteTributo {
  codigo?: string;
  descripcion?: string;
  valor?: number | string;
}

interface DteParty { nit?: string; nrc?: string; nombre?: string }

interface DteJsonShape {
  identificacion?: {
    tipoDte?: string;
    numeroControl?: string;
    codigoGeneracion?: string;
    fecEmi?: string;
  };
  emisor?: DteParty;
  receptor?: DteParty;
  cuerpoDocumento?: Array<{
    descripcion?: string;
    ivaItem?: number | string;
    ventaGravada?: number | string;
  }>;
  resumen?: {
    totalIva?: number | string;
    montoTotalOperacion?: number | string;
    totalPagar?: number | string;
    totalGravada?: number | string;
    totalExenta?: number | string;
    totalNoSuj?: number | string;
    subTotal?: number | string;
    subTotalVentas?: number | string;
    reteRenta?: number | string;
    ivaRete1?: number | string;
    tributos?: DteTributo[];
  };
  selloRecibido?: string;
}

/**
 * Extrae el monto del IVA del JSON, manejando los 3 formatos del MH:
 *   1. DTE-01 (FE):    `resumen.totalIva` directo
 *   2. DTE-03 (CCF):   `resumen.tributos[]` con `codigo === "20"` (IVA 13%)
 *   3. Cualquiera:     suma de `cuerpoDocumento[].ivaItem`
 */
function extractIva(
  resumen: NonNullable<DteJsonShape['resumen']>,
  items: NonNullable<DteJsonShape['cuerpoDocumento']>,
): number {
  if (resumen.totalIva != null) {
    const v = parseFloat(String(resumen.totalIva));
    if (Number.isFinite(v) && v > 0) return v;
  }
  if (Array.isArray(resumen.tributos)) {
    for (const t of resumen.tributos) {
      const codigo = String(t.codigo ?? '');
      const desc = String(t.descripcion ?? '').toLowerCase();
      if (codigo === '20' || /\biva\b/.test(desc)) {
        const v = parseFloat(String(t.valor ?? ''));
        if (Number.isFinite(v) && v > 0) return v;
      }
    }
  }
  let sum = 0;
  for (const it of items) {
    const v = parseFloat(String(it.ivaItem ?? ''));
    if (Number.isFinite(v)) sum += v;
  }
  return sum;
}

function unwrapDte(raw: unknown): DteJsonShape | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.identificacion && (obj.emisor || obj.receptor)) return obj as DteJsonShape;
  for (const key of ['documento', 'dteJson', 'dte', 'jsonDte']) {
    const inner = obj[key];
    if (inner && typeof inner === 'object' && (inner as Record<string, unknown>).identificacion) {
      return inner as DteJsonShape;
    }
  }
  return null;
}

function num2(v: number | string | undefined | null): string {
  if (v == null) return '0.00';
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

export function parseDteJson(rawText: string, perspective: DtePerspective = 'compra'): DteParseOutcome {
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    return { ok: false, error: 'El archivo no es JSON válido.' };
  }

  const dte = unwrapDte(json);
  if (!dte || !dte.identificacion || !dte.resumen) {
    return {
      ok: false,
      error: 'No tiene la estructura de un DTE del MH (faltan identificacion / resumen).',
    };
  }

  const ident = dte.identificacion;
  const resumen = dte.resumen;
  const warnings: string[] = [];

  // Selección de la contraparte según perspectiva
  const contraparte: DteParty | undefined =
    perspective === 'compra' ? dte.emisor : dte.receptor;
  const partyLabel = perspective === 'compra' ? 'emisor' : 'receptor';
  if (!contraparte) {
    return {
      ok: false,
      error: `Falta el nodo "${partyLabel}" en el JSON (necesario para perspectiva ${perspective}).`,
    };
  }

  const tipoDte = String(ident.tipoDte ?? '').padStart(2, '0');
  const tiposEsperadosCompra = ['03', '05', '06', '14'];
  const tiposEsperadosVenta = ['01', '03', '05', '06', '11', '14'];
  const esperados = perspective === 'compra' ? tiposEsperadosCompra : tiposEsperadosVenta;
  if (!esperados.includes(tipoDte)) {
    warnings.push(`Tipo de DTE "${tipoDte}" no es típico para ${perspective}.`);
  }

  // Fecha — manejamos múltiples formatos:
  //   "YYYY-MM-DD" o "YYYY-MM-DDTHH:MM:SS" (ISO, lo más común en DTE oficial)
  //   "DD/MM/YYYY" o "DD-MM-YYYY" (export en formato salvadoreño)
  //   "DD/MM/YY"   (año corto, asumimos sigloXX > 50 → 19xx, ≤ 50 → 20xx)
  const fechaRaw = String(ident.fecEmi ?? '').trim();
  let fecha = '';
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(fechaRaw);
  if (m) {
    fecha = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  } else if ((m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/.exec(fechaRaw))) {
    let yyyy = m[3];
    if (yyyy.length === 2) yyyy = (parseInt(yyyy, 10) > 50 ? '19' : '20') + yyyy;
    fecha = `${yyyy}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  } else {
    warnings.push(`Fecha de emisión no reconocida: "${fechaRaw}"`);
  }

  const codigoGeneracion = String(ident.codigoGeneracion ?? '').toUpperCase();
  const numeroControl = String(ident.numeroControl ?? '');
  const selloRecibido = dte.selloRecibido ? String(dte.selloRecibido) : undefined;

  const contraparteNombre = String(contraparte.nombre ?? '').trim();
  const contraparteNrc = String(contraparte.nrc ?? '').trim();
  const contraparteNit = contraparte.nit ? String(contraparte.nit) : undefined;

  if (!codigoGeneracion) warnings.push('No se encontró el Código de Generación.');
  if (!contraparteNombre) warnings.push(`No se encontró el nombre del ${partyLabel}.`);
  if (!contraparteNrc) warnings.push(`No se encontró el NRC del ${partyLabel}.`);

  const items = Array.isArray(dte.cuerpoDocumento) ? dte.cuerpoDocumento : [];

  // Montos
  const ivaValue = extractIva(resumen, items);
  const totalIva = ivaValue.toFixed(2);
  if (ivaValue === 0 && tipoDte === '03') {
    warnings.push('IVA = 0 — revisa el campo `tributos` en el JSON.');
  }

  const totalGravada = num2(resumen.totalGravada ?? resumen.subTotalVentas ?? resumen.subTotal);
  const totalExenta = num2(resumen.totalExenta);
  const totalNoSujeta = num2(resumen.totalNoSuj);
  const reteRenta = num2(resumen.reteRenta);
  const reteIva = num2(resumen.ivaRete1);

  let montoTotal = num2(resumen.montoTotalOperacion ?? resumen.totalPagar);
  if (parseFloat(montoTotal) === 0) {
    const subTotal = parseFloat(totalGravada);
    if (subTotal > 0) {
      montoTotal = (subTotal + ivaValue).toFixed(2);
    } else {
      warnings.push('No se pudo determinar el monto total.');
    }
  }

  const descripcion = items.length
    ? items.slice(0, 3).map(i => i.descripcion ?? '').filter(Boolean).join('; ').slice(0, 200)
    : '';

  return {
    ok: true,
    data: {
      fecha,
      tipoDte,
      numeroControl,
      codigoGeneracion,
      selloRecibido,
      contraparteNombre,
      contraparteNrc,
      contraparteNit,
      totalGravada,
      totalExenta,
      totalNoSujeta,
      totalIva,
      reteRenta,
      reteIva,
      montoTotal,
      descripcion,
      warnings,
    },
  };
}
