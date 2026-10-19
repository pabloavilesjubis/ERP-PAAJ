// =============================================================================
// Deterministic checks of a DUCA read by the AI (or edited by the contador).
// The law: valor en aduana = FOB + flete + seguro (+ otros gastos); DAI on the
// valor en aduana; IVA 13% on valor en aduana + DAI. VTS / ITS and any other
// tributo are import cost, never IVA. The AI never registers anything: these
// checks and the contador's review do.
// =============================================================================
import type { DucaData, DucaLine } from './types'

export interface DucaCheck {
  level: 'ok' | 'warning' | 'error'
  message: string
}

const r2 = (n: number) => Math.round(n * 100) / 100
const fmt = (n: number) => `$${r2(n).toFixed(2)}`
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol + 1e-9

export const taxOf = (taxes: { code: string; amount: number }[], code: string) =>
  r2(taxes.filter(t => t.code.trim().toUpperCase() === code).reduce((s, t) => s + (Number(t.amount) || 0), 0))

/** Tributos that are import cost (everything but DAI and IVA): VTS, ITS, AIV... */
export const otherTaxesOf = (taxes: { code: string; amount: number }[]) =>
  r2(taxes.filter(t => !['DAI', 'IVA'].includes(t.code.trim().toUpperCase())).reduce((s, t) => s + (Number(t.amount) || 0), 0))

export interface DucaSummary {
  fob: number
  freight: number
  insurance: number
  other_costs: number
  customs_value: number
  dai: number
  iva: number
  /** VTS, ITS... (cost) */
  other_taxes: number
  /** What was paid to Aduanas: every tributo */
  total_taxes: number
  /** Libro de compras column L: base of the IVA = valor en aduana + DAI */
  iva_base: number
}

/** Header totals; the per-tributo amounts come from the liquidación general */
export function summarize(d: DucaData): DucaSummary {
  const dai = taxOf(d.taxes, 'DAI')
  return {
    fob: r2(d.fob), freight: r2(d.freight), insurance: r2(d.insurance), other_costs: r2(d.other_costs),
    customs_value: r2(d.customs_value), dai, iva: taxOf(d.taxes, 'IVA'), other_taxes: otherTaxesOf(d.taxes),
    total_taxes: r2(d.taxes.reduce((s, t) => s + (Number(t.amount) || 0), 0)),
    iva_base: r2(d.customs_value + dai),
  }
}

/** Landed cost of one line before the expediente's extra costs: valor en aduana + DAI + other tributos */
export const lineCost = (l: DucaLine) => r2(l.customs_value + taxOf(l.taxes, 'DAI') + otherTaxesOf(l.taxes))

export function checkDuca(d: DucaData, ctx: { orgNit?: string | null; alreadyRegistered?: boolean } = {}): DucaCheck[] {
  const out: DucaCheck[] = []
  const ok = (message: string) => out.push({ level: 'ok', message })
  const warn = (message: string) => out.push({ level: 'warning', message })
  const err = (message: string) => out.push({ level: 'error', message })
  const s = summarize(d)

  if (!/^\d{6,20}$/.test(d.duca_number.trim())) err('El número de DUCA debe tener solo dígitos.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.acceptance_date) || Number.isNaN(Date.parse(d.acceptance_date))) err('Falta la fecha de aceptación.')
  if (ctx.alreadyRegistered) err(`La DUCA ${d.duca_number} ya está registrada.`)
  if (!d.lines.length) err('La DUCA no tiene líneas de mercancía.')

  const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '')
  if (ctx.orgNit && d.importer_nit) {
    if (digits(ctx.orgNit) === digits(d.importer_nit)) ok('El importador es nuestra empresa.')
    else err(`El importador (NIT ${d.importer_nit}) no es nuestra empresa.`)
  } else if (!d.importer_nit) warn('No se leyó el NIT del importador.')

  // Header: valor en aduana = FOB + flete + seguro + otros
  const cif = r2(s.fob + s.freight + s.insurance + s.other_costs)
  if (near(cif, s.customs_value, 0.05)) ok(`Valor en aduana ${fmt(s.customs_value)} = FOB + flete + seguro.`)
  else err(`El valor en aduana ${fmt(s.customs_value)} no es FOB + flete + seguro + otros (${fmt(cif)}).`)

  // Lines add up to the header
  const sum = (f: (l: DucaLine) => number) => r2(d.lines.reduce((a, l) => a + f(l), 0))
  const tol = Math.max(0.05, d.lines.length * 0.02)
  const pairs: [string, number, number][] = [
    ['FOB', sum(l => l.fob), s.fob],
    ['flete', sum(l => l.freight), s.freight],
    ['seguro', sum(l => l.insurance), s.insurance],
    ['valor en aduana', sum(l => l.customs_value), s.customs_value],
    ['DAI', sum(l => taxOf(l.taxes, 'DAI')), s.dai],
    ['IVA', sum(l => taxOf(l.taxes, 'IVA')), s.iva],
    ['otros tributos (VTS, ITS...)', sum(l => otherTaxesOf(l.taxes)), s.other_taxes],
  ]
  const off = pairs.filter(([, a, b]) => !near(a, b, tol))
  if (!off.length) ok('Las líneas suman los totales de la DUCA.')
  for (const [name, lines, total] of off) err(`Las líneas suman ${fmt(lines)} de ${name} y el total dice ${fmt(total)}.`)

  // Per line: valor en aduana, DAI on it, IVA on valor en aduana + DAI
  for (const l of d.lines) {
    const n = `Línea ${l.line_no}`
    const lcif = r2(l.fob + l.freight + l.insurance + l.other_costs)
    if (!near(lcif, l.customs_value, 0.03)) err(`${n}: valor en aduana ${fmt(l.customs_value)} ≠ FOB + flete + seguro (${fmt(lcif)}).`)
    const dai = l.taxes.find(t => t.code.trim().toUpperCase() === 'DAI')
    const daiAmount = taxOf(l.taxes, 'DAI')
    if (dai?.rate != null && !near(r2(l.customs_value * dai.rate / 100), daiAmount, 0.03)) {
      err(`${n}: el DAI ${fmt(daiAmount)} no es el ${dai.rate}% del valor en aduana (${fmt(l.customs_value * dai.rate / 100)}).`)
    }
    const iva = taxOf(l.taxes, 'IVA')
    const expected = r2((l.customs_value + daiAmount) * 0.13)
    if (iva > 0 && !near(expected, iva, 0.03)) err(`${n}: el IVA ${fmt(iva)} no es el 13% de valor en aduana + DAI (${fmt(expected)}).`)
    if (l.quantity <= 0) err(`${n}: falta la cantidad.`)
  }

  // Whole document: IVA = 13% of (valor en aduana + DAI), with line rounding
  if (near(r2(s.iva_base * 0.13), s.iva, tol)) ok(`IVA ${fmt(s.iva)} = 13% de valor en aduana + DAI (${fmt(s.iva_base)}): crédito fiscal.`)
  if (s.other_taxes > 0) ok(`Otros tributos ${fmt(s.other_taxes)} (${d.taxes.filter(t => !['DAI', 'IVA'].includes(t.code.toUpperCase())).map(t => t.code).join(', ')}): costo de la importación, no IVA.`)
  if (!near(s.total_taxes, r2(d.total_taxes), 0.05)) err(`La suma de los tributos (${fmt(s.total_taxes)}) no coincide con el total liquidado (${fmt(d.total_taxes)}).`)
  if (d.notes?.trim()) warn(`Nota de la lectura: ${d.notes.trim()}`)
  return out
}

export const hasErrors = (checks: DucaCheck[]) => checks.some(c => c.level === 'error')
