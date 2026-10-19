import { describe, expect, it } from 'vitest'
import { decodeBankFile, detectBAC, parseBAC } from './bacParser'

// Same layout the bank exports (sections, ", " spacing, trailing spaces in descriptions)
export const BAC_SAMPLE = [
  'Número de Clientes, Nombre, Producto, Moneda, Saldo Inicial, Saldo en Libros, Retenidos y Diferidos, Saldo Disponible, Fecha, STBGAV, STBUNC, Mensaje1, Mensaje2',
  '123456, EMPRESA DEMO S.A. DE C.V., 201028214, USD, 1000.00, 1650.50, 0.00, 1650.50, 31/10/2026, 0, 0, , ',
  '',
  'Detalle de Estado Bancario',
  'Fecha de Transacción, Referencia de Transacción, Código de Transacción, Descripción de Transacción, Débito de Transacción, Crédito de Transacción, Balance de Transacción',
  '01/10/2026, 0001, DP, DEPÓSITO EFECTIVO REMESA   , 0.00, 500.00, 1500.00',
  '02/10/2026, 0002, TF, "TEF UNI DE: ANRA S.A DE C.V   ", 0.00, "1,200.50", 2700.50',
  '05/10/2026, 0003, CH, PAGO PROVEEDOR ALIMENTOS, 1050.00, 0.00, 1650.50',
  '',
  'Resumen de Estado Bancario',
  'Código Transacción Totales, Cantidad Débitos Totales, Montos Débitos Totales, Cantidad Créditos Totales, Montos Créditos Totales',
  'DP, 0, 0.00, 1, 500.00',
  'Total, 1, 1050.00, 2, 1700.50',
].join('\r\n')

const win1252 = (s: string) => {
  // Encode Latin-1 range characters as single bytes (what BAC exports)
  const bytes = new Uint8Array([...s].map(c => c.charCodeAt(0) & 0xff))
  return bytes.buffer
}

describe('BAC statement (Airbox format)', () => {
  it('decodes the Windows-1252 export and detects it', () => {
    const text = decodeBankFile(win1252(BAC_SAMPLE))
    expect(text).toContain('Número de Clientes')
    expect(detectBAC(text)).toBe(1)
  })

  it('reads the account header, the movements and checks the totals', () => {
    const s = parseBAC(decodeBankFile(win1252(BAC_SAMPLE)))
    expect(s.accountNumberFromFile).toBe('201028214')
    expect(s.saldoInicial).toBe(1000)
    expect(s.saldoDisponible).toBe(1650.5)
    expect(s.fechaCorte).toBe('2026-10-31')
    expect(s.movements).toHaveLength(3)
    expect(s.movements[1]).toEqual({
      transactionDate: '2026-10-02', bankReference: '0002', bankCodeRaw: 'TF', description: 'TEF UNI DE: ANRA S.A DE C.V',
      debit: 0, credit: 1200.5, balanceCsv: 2700.5,
    })
    expect(s.totales?.ok).toBe(true)
    expect(s.warnings).toEqual([])
  })

  it('flags totals that do not match', () => {
    const s = parseBAC(BAC_SAMPLE.replace('Total, 1, 1050.00', 'Total, 1, 1000.00'))
    expect(s.totales?.ok).toBe(false)
    expect(s.warnings[0]).toMatch(/Totales no cuadran/)
  })

  it('rejects a file that is not a BAC statement', () => {
    expect(detectBAC('a,b,c')).toBe(0)
    expect(() => parseBAC('a,b,c\n1,2,3')).toThrow(/encabezado de cuenta/)
  })
})
