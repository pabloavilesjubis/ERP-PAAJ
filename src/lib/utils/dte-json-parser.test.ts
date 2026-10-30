import { describe, expect, it } from 'vitest';
import { parseDteJson } from './dte-json-parser';

// FSE como lo emite el ERP: la empresa compradora es el emisor, el proveedor es el sujeto excluido
const FSE = {
  identificacion: { tipoDte: '14', numeroControl: 'DTE-14-M001P001-000000000000011', codigoGeneracion: '1a2b3c4d-0000-4000-8000-00000000abcd', fecEmi: '2026-10-30' },
  emisor: { nit: '06140101000001', nrc: '1234567', nombre: 'EMPRESA COMPRADORA SA DE CV' },
  sujetoExcluido: { tipoDocumento: '13', numDocumento: '012345678', nombre: 'Persona Natural De Prueba' },
  cuerpoDocumento: [{ descripcion: 'Honorarios', compra: 617.29 }],
  resumen: { totalCompra: 617.29, reteRenta: 61.73, totalPagar: 555.56, subTotal: 617.29 },
  selloRecibido: '2026AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

describe('parseDteJson — FSE en compras', () => {
  it('el proveedor es el sujeto excluido y el costo es el total de la compra', () => {
    const r = parseDteJson(JSON.stringify(FSE), 'compra');
    if (!r.ok) throw new Error(r.error);
    expect(r.data.contraparteNombre).toBe('Persona Natural De Prueba');
    expect(r.data.contraparteDui).toBe('012345678');
    expect(r.data.contraparteNit).toBeUndefined();
    expect(r.data.montoTotal).toBe('617.29');
    expect(r.data.reteRenta).toBe('61.73');
    expect(r.data.totalIva).toBe('0.00');
    expect(r.data.codigoGeneracion).toBe('1A2B3C4D-0000-4000-8000-00000000ABCD');
    expect(r.data.warnings.join(' ')).not.toMatch(/NRC/);
  });

  it('un CCF sigue tomando al emisor como proveedor', () => {
    const ccf = { ...FSE, identificacion: { ...FSE.identificacion, tipoDte: '03' }, sujetoExcluido: undefined,
      resumen: { totalGravada: 100, totalIva: 13, montoTotalOperacion: 113 } };
    const r = parseDteJson(JSON.stringify(ccf), 'compra');
    if (!r.ok) throw new Error(r.error);
    expect(r.data.contraparteNombre).toBe('EMPRESA COMPRADORA SA DE CV');
    expect(r.data.montoTotal).toBe('113.00');
  });
});
