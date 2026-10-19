import { describe, expect, it } from 'vitest'
import { guessMapping, parseAmount, parseDate, parseGeneric, previewCsv } from './genericParser'

const AGRICOLA = [
  'Banco Agrícola - Estado de cuenta',
  'Cuenta: 123-456789-0',
  'Fecha;Descripción;Referencia;Cargo;Abono;Saldo',
  '03/05/2026;DEPOSITO EN EFECTIVO;881;;500,00;1.500,00',
  '05/05/2026;PAGO PROVEEDOR UNO;TEF9;113,00;;1.387,00',
  ';;;;;',
].join('\n')

describe('lector CSV genérico', () => {
  it('interpreta montos con coma o punto decimal y negativos', () => {
    expect(parseAmount('1.234,56')).toBe(1234.56)
    expect(parseAmount('1,234.56')).toBe(1234.56)
    expect(parseAmount('(15.00)')).toBe(-15)
    expect(parseAmount('-7.5')).toBe(-7.5)
    expect(parseAmount('$ 10')).toBe(10)
  })

  it('interpreta fechas en varios formatos', () => {
    expect(parseDate('3/5/2026')).toBe('2026-05-03')
    expect(parseDate('05/03/2026', 'MM/DD/YYYY')).toBe('2026-05-03')
    expect(parseDate('2026-05-03', 'YYYY-MM-DD')).toBe('2026-05-03')
    expect(parseDate('xx')).toBeNull()
  })

  it('salta el encabezado del banco, adivina columnas y lee los movimientos', () => {
    const base = { skip_rows: 2, delimiter: ';' }
    const { headers } = previewCsv(AGRICOLA, base)
    const mapping = { ...base, ...guessMapping(headers) }
    expect(mapping.debit_col).toBe('Cargo')
    expect(mapping.credit_col).toBe('Abono')
    const s = parseGeneric(AGRICOLA, mapping)
    expect(s.rows).toEqual([
      { date: '2026-05-03', debit: 0, credit: 500, description: 'DEPOSITO EN EFECTIVO', reference: '881', balance: 1500 },
      { date: '2026-05-05', debit: 113, credit: 0, description: 'PAGO PROVEEDOR UNO', reference: 'TEF9', balance: 1387 },
    ])
  })

  it('una sola columna de monto con signo', () => {
    const csv = 'Fecha,Detalle,Monto\n01/06/2026,Abono,250.00\n02/06/2026,Cargo,-40.00'
    const s = parseGeneric(csv, { date_col: 'Fecha', description_col: 'Detalle', amount_col: 'Monto' })
    expect(s.rows.map(r => [r.debit, r.credit])).toEqual([[0, 250], [40, 0]])
  })
})
