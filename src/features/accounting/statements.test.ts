import { describe, expect, it } from 'vitest'
import { balanceSheetReport, cashFlowReport, equityChangesReport, incomeStatementReport, rollUp, trialBalance } from './statements'
import type { Account, AccountMovement } from './types'

let nextId = 1
const acc = (code: string, name: string, account_type: Account['account_type'], parent: Account | null, leaf = true): Account => ({
  id: nextId++, code, name, account_type, nature: 'Deudora', parent_id: parent?.id ?? null, level: (parent?.level ?? 0) + 1,
  financial_statement: ['Ingreso', 'Costo', 'Gasto', 'Resultado'].includes(account_type) ? 'ER' : 'Balance',
  affects_result: ['Ingreso', 'Costo', 'Gasto', 'Resultado'].includes(account_type), result_section: null, balance_term: null,
  allows_movements: leaf, is_active: true,
})

// Catálogo sin balance_term: la clasificación sale del nombre de los grupos
const A = acc('1', 'ACTIVO', 'Activo', null, false)
const AC = acc('11', 'ACTIVO CORRIENTE', 'Activo', A, false)
const caja = acc('1101', 'Caja', 'Activo', AC)
const banco = acc('1102', 'Banco Agrícola cuenta corriente', 'Activo', AC)
const clientes = acc('1103', 'Clientes', 'Activo', AC)
const ANC = acc('12', 'ACTIVO NO CORRIENTE', 'Activo', A, false)
const equipo = acc('1201', 'Equipo', 'Activo', ANC)
const dep = acc('1202', 'Depreciación acumulada', 'Contraactivo', ANC)
const P = acc('2', 'PASIVO', 'Pasivo', null, false)
const PC = acc('21', 'PASIVO CORRIENTE', 'Pasivo', P, false)
const prov = acc('2101', 'Proveedores', 'Pasivo', PC)
const K = acc('3', 'PATRIMONIO', 'Patrimonio', null, false)
const capital = acc('31', 'Capital', 'Patrimonio', K)
const I = acc('5', 'INGRESOS', 'Ingreso', null, false)
const ventas = acc('51', 'Ventas', 'Ingreso', I)
const G = acc('4', 'GASTOS', 'Gasto', null, false)
const gastos = acc('41', 'Gastos de administración', 'Gasto', G)
const accounts = [A, AC, caja, banco, clientes, ANC, equipo, dep, P, PC, prov, K, capital, I, ventas, G, gastos]

// Período: capital 1000 al banco, compra de equipo 400 al crédito, venta 300 (200 contado, 100 crédito), gasto 50, depreciación 20
const mv = (a: Account, debit: number, credit: number, before: [number, number] = [0, 0]): AccountMovement =>
  ({ account_id: a.id, debit_before: before[0], credit_before: before[1], debit, credit })
const moves: AccountMovement[] = [
  mv(banco, 1000 + 200, 50), mv(capital, 0, 1000), mv(equipo, 400, 0), mv(prov, 0, 400),
  mv(clientes, 100, 0), mv(ventas, 0, 300), mv(gastos, 50 + 20, 0), mv(dep, 0, 20),
]
const rows = rollUp(accounts, moves)

describe('estados financieros genéricos', () => {
  it('balanza cuadrada y saldos de grupo acumulados', () => {
    const tb = trialBalance(rows)
    expect(tb.balanced).toEqual({ movements: true, opening: true, closing: true })
    expect(tb.lines.find(l => l.account.code === '11')!.closingDebit).toBe(1250)
  })

  it('balance: corriente / no corriente deducido del nombre y ecuación contable', () => {
    const r = balanceSheetReport(accounts, rows, { start: 'inicio', end: 'fin' })
    const label = (l: string) => r.rows.find(x => x.label === l)?.values[1]
    expect(label('Total activo corriente')).toBe(1250)
    expect(label('Total activo no corriente')).toBe(380)
    // Una cuenta llamada "cuenta corriente" no crea un grupo aparte
    expect(r.rows.some(x => x.label === 'Banco Agrícola cuenta corriente')).toBe(true)
    expect(label('Resultado del ejercicio (no cerrado)')).toBe(230)
    expect(r.checks!.every(c => c.ok)).toBe(true)
  })

  it('estado de resultados', () => {
    const r = incomeStatementReport(accounts, [rows], ['Período'])
    expect(r.rows.find(x => x.label === 'Total ingresos')!.values[0]).toBe(300)
    expect(r.rows.at(-1)!.values[0]).toBe(230)
  })

  it('cambios en el patrimonio', () => {
    const r = equityChangesReport(accounts, rows)
    expect(r.rows.at(-1)!.values).toEqual([0, 1230, 0, 1230])
  })

  it('flujo de efectivo indirecto cuadra con caja y bancos', () => {
    const r = cashFlowReport(accounts, rows, new Set([caja.id, banco.id]))
    expect(r.checks![0]!.ok).toBe(true)
    expect(r.rows.find(x => x.label === 'Aumento (disminución) neto del efectivo')!.values[0]).toBe(1150)
    expect(r.rows.find(x => x.label.startsWith('Efectivo neto de actividades de inversión'))!.values[0]).toBe(-400)
    expect(r.rows.find(x => x.label.startsWith('Efectivo neto de actividades de financiamiento'))!.values[0]).toBe(1000)
  })
})
