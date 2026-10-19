// =============================================================================
// Parser of the MH DTE JSON (El Salvador) for purchases: we are the receptor,
// the supplier is the `emisor`. Portado de ChuchoWash (shared/purchasing/
// dteParser.ts), que a su vez extendió el dte-json-parser del frontend de este
// ERP con exentos / no sujetos, percepción y los datos del emisor.
//
// Typical shape:
//   { identificacion: { tipoDte, numeroControl, codigoGeneracion, fecEmi },
//     emisor: { nit, nrc, nombre, nombreComercial, codActividad, descActividad,
//               direccion: { departamento, municipio, complemento }, telefono, correo },
//     receptor: { nit, nrc, nombre },
//     cuerpoDocumento: [{ descripcion, ivaItem, ... }],
//     resumen: { totalGravada, totalExenta, totalNoSuj, totalIva, tributos[],
//                ivaPerci1, ivaRete1, reteRenta, montoTotalOperacion, totalPagar },
//     selloRecibido }
// Some systems wrap it in `documento` / `dteJson` / `dte` / `jsonDte`.
// =============================================================================

type Num = number | string | null | undefined

interface DteParty {
  nit?: string
  nrc?: string
  nombre?: string
  nombreComercial?: string | null
  codActividad?: string | null
  descActividad?: string | null
  direccion?: { departamento?: string; municipio?: string; complemento?: string } | null
  telefono?: string | null
  correo?: string | null
}

interface DteShape {
  identificacion?: { tipoDte?: string; numeroControl?: string; codigoGeneracion?: string; fecEmi?: string }
  selloRecepcion?: string
  responseMH?: { selloRecibido?: string; sello?: string }
  emisor?: DteParty
  receptor?: DteParty
  cuerpoDocumento?: { descripcion?: string; ivaItem?: Num }[]
  resumen?: {
    totalGravada?: Num; subTotalVentas?: Num; subTotal?: Num
    totalExenta?: Num; totalNoSuj?: Num
    descuGravada?: Num; descuExenta?: Num; descuNoSuj?: Num
    totalIva?: Num; tributos?: { codigo?: string; descripcion?: string; valor?: Num }[] | null
    ivaPerci1?: Num; ivaRete1?: Num; reteRenta?: Num
    montoTotalOperacion?: Num; totalPagar?: Num
  }
  selloRecibido?: string
}

/** Supplier data as it comes in the DTE emisor (digits only for ids) */
export interface DteIssuer {
  name: string
  commercialName: string | null
  nit: string
  nrc: string
  activityCode: string | null
  activityDesc: string | null
  departmentCode: string | null
  /** CAT-013 code as it comes in direccion.municipio */
  municipalityCode: string | null
  address: string | null
  phone: string | null
  email: string | null
}

export interface ParsedDte {
  documentType: string        // '03', '05', ...
  issueDate: string           // YYYY-MM-DD ('' when unreadable)
  generationCode: string      // UUID, uppercase
  controlNumber: string
  receptionStamp: string | null
  issuer: DteIssuer
  receiver: { nit: string; nrc: string; name: string } | null
  taxableAmount: number
  exemptAmount: number
  nonSubjectAmount: number
  ivaAmount: number
  /** Tributos other than IVA (FOVIAL D1, COTRANS C8...): part of the total and of the cost, not crédito fiscal */
  otherTaxes: number
  otherTaxesDetail: { code: string; description: string; amount: number }[]
  ivaPerceived: number
  ivaWithheld: number
  incomeTaxWithheld: number
  totalAmount: number         // total de la operación (con IVA)
  description: string
  warnings: string[]
  raw: unknown                // the unwrapped DTE, stored as dte_json
}

export type DteParseOutcome = { ok: true; data: ParsedDte } | { ok: false; error: string }

const PURCHASE_TYPES = ['03', '05', '06', '14']

const toNum = (v: Num): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round(n * 100) / 100
const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '')
const text = (v: unknown) => (typeof v === 'string' && v.trim()) ? v.trim() : null

function unwrap(raw: unknown): DteShape | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (obj.identificacion && (obj.emisor || obj.receptor)) return obj as DteShape
  for (const key of ['documento', 'dteJson', 'dte', 'jsonDte']) {
    const inner = obj[key]
    if (inner && typeof inner === 'object' && (inner as Record<string, unknown>).identificacion) {
      // The sello can sit on the wrapper instead of the document
      const dte = inner as DteShape
      return receptionStampOf(dte) ? dte : { ...dte, selloRecibido: receptionStampOf(obj) ?? undefined }
    }
  }
  return null
}

const STAMP_KEYS = ['sellorecibido', 'sellorecepcion']
/** Objects where issuers keep the MH answer: responseMH, respuestaMh, RespuestaHacienda, firmaElectronica... */
const MH_ANSWER = /respuesta|response|hacienda|firma|mh$/i

/**
 * Sello de recepción: selloRecibido / selloRecepcion on the document, or inside
 * the MH answer the issuer stored next to it (any casing).
 */
function receptionStampOf(node: unknown, depth = 1): string | null {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null
  const entries = Object.entries(node as Record<string, unknown>)
  for (const [k, v] of entries) if (STAMP_KEYS.includes(k.toLowerCase()) && text(v)) return text(v)
  if (depth === 0) return null
  for (const [k, v] of entries) {
    if (!MH_ANSWER.test(k) || !v || typeof v !== 'object') continue
    const inner = receptionStampOf(v, depth - 1) ?? text((v as Record<string, unknown>).sello)
    if (inner) return inner
  }
  return null
}

/** IVA: resumen.totalIva (FE) → tributo código 20 (CCF) → Σ ivaItem */
function extractIva(resumen: NonNullable<DteShape['resumen']>, items: NonNullable<DteShape['cuerpoDocumento']>): number {
  const total = toNum(resumen.totalIva)
  if (total > 0) return total
  for (const t of resumen.tributos ?? []) {
    if (String(t.codigo ?? '') === '20' || /\biva\b/i.test(String(t.descripcion ?? ''))) {
      const v = toNum(t.valor)
      if (v > 0) return v
    }
  }
  return items.reduce((s, it) => s + toNum(it.ivaItem), 0)
}

/** ISO, DD/MM/YYYY, DD-MM-YYYY or DD/MM/YY → YYYY-MM-DD */
export function parseDteDate(value: string): string {
  const raw = value.trim()
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw)
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(raw)
  if (m) {
    const year = m[3]!.length === 2 ? (parseInt(m[3]!, 10) > 50 ? '19' : '20') + m[3] : m[3]!
    return `${year}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
  }
  return ''
}

export function parseDteJson(rawText: string): DteParseOutcome {
  let json: unknown
  try {
    json = JSON.parse(rawText.replace(/^\uFEFF/, ''))
  } catch {
    return { ok: false, error: 'El archivo no es un JSON válido.' }
  }
  const dte = unwrap(json)
  if (!dte?.identificacion || !dte.resumen) {
    return { ok: false, error: 'No tiene la estructura de un DTE del MH (faltan identificacion / resumen).' }
  }
  if (!dte.emisor) return { ok: false, error: 'Falta el nodo "emisor" (el proveedor) en el JSON.' }

  const ident = dte.identificacion
  const resumen = dte.resumen
  const items = Array.isArray(dte.cuerpoDocumento) ? dte.cuerpoDocumento : []
  const warnings: string[] = []

  const documentType = String(ident.tipoDte ?? '').padStart(2, '0')
  if (!PURCHASE_TYPES.includes(documentType)) warnings.push(`Tipo de DTE "${documentType}" no es típico de una compra.`)

  const issueDate = parseDteDate(String(ident.fecEmi ?? ''))
  if (!issueDate) warnings.push(`Fecha de emisión no reconocida: "${ident.fecEmi ?? ''}".`)

  const generationCode = String(ident.codigoGeneracion ?? '').trim().toUpperCase()
  const controlNumber = String(ident.numeroControl ?? '').trim().toUpperCase()
  if (!generationCode) warnings.push('No se encontró el código de generación.')

  const e = dte.emisor
  const issuer: DteIssuer = {
    name: String(e.nombre ?? '').trim(),
    commercialName: text(e.nombreComercial),
    nit: digits(e.nit),
    nrc: digits(e.nrc),
    activityCode: text(e.codActividad),
    activityDesc: text(e.descActividad),
    departmentCode: text(e.direccion?.departamento),
    municipalityCode: text(e.direccion?.municipio),
    address: text(e.direccion?.complemento),
    phone: text(e.telefono),
    email: text(e.correo)?.toLowerCase() ?? null,
  }
  if (!issuer.name) warnings.push('No se encontró el nombre del emisor.')
  if (!issuer.nrc && documentType !== '14') warnings.push('No se encontró el NRC del emisor.')

  const receiver = dte.receptor
    ? { nit: digits(dte.receptor.nit), nrc: digits(dte.receptor.nrc), name: String(dte.receptor.nombre ?? '').trim() }
    : null

  const ivaAmount = round2(extractIva(resumen, items))
  const otherTaxesDetail = (resumen.tributos ?? [])
    .filter(t => String(t.codigo ?? '') !== '20' && !/\biva\b/i.test(String(t.descripcion ?? '')) && toNum(t.valor) > 0)
    .map(t => ({ code: String(t.codigo ?? ''), description: String(t.descripcion ?? '').trim(), amount: round2(toNum(t.valor)) }))
  const otherTaxes = round2(otherTaxesDetail.reduce((s, t) => s + t.amount, 0))
  if (ivaAmount === 0 && documentType === '03') warnings.push('El IVA es 0 — revisa los tributos del JSON.')

  // Global discounts (CCF v3 descu*) reduce each base; ERP-PAAJ ignored them
  const taxableAmount = round2(toNum(resumen.totalGravada ?? resumen.subTotalVentas ?? resumen.subTotal) - toNum(resumen.descuGravada))
  const exemptAmount = round2(toNum(resumen.totalExenta) - toNum(resumen.descuExenta))
  const nonSubjectAmount = round2(toNum(resumen.totalNoSuj) - toNum(resumen.descuNoSuj))

  let totalAmount = round2(toNum(resumen.montoTotalOperacion ?? resumen.totalPagar))
  if (totalAmount === 0) {
    totalAmount = round2(taxableAmount + exemptAmount + nonSubjectAmount + ivaAmount + otherTaxes)
    if (totalAmount === 0) warnings.push('No se pudo determinar el monto total.')
  }

  const description = items.slice(0, 3).map(i => i.descripcion ?? '').filter(Boolean).join('; ').slice(0, 200)

  return {
    ok: true,
    data: {
      documentType, issueDate, generationCode, controlNumber,
      receptionStamp: receptionStampOf(dte)?.toUpperCase() ?? null,
      issuer, receiver,
      taxableAmount, exemptAmount, nonSubjectAmount, ivaAmount, otherTaxes, otherTaxesDetail,
      ivaPerceived: round2(toNum(resumen.ivaPerci1)),
      ivaWithheld: round2(toNum(resumen.ivaRete1)),
      incomeTaxWithheld: round2(toNum(resumen.reteRenta)),
      totalAmount, description, warnings, raw: dte,
    },
  }
}
