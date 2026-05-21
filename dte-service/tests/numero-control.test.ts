import { describe, expect, it } from 'vitest';
import { buildNumeroControl, newCodigoGeneracion } from '../src/dte/numero-control.js';

describe('buildNumeroControl', () => {
  it('produce el formato exacto DTE-NN-XXXXXXXX-NNNNNNNNNNNNNNN', () => {
    const nc = buildNumeroControl({
      tipoDte: '01', establecimiento: 'C001', puntoVenta: '0001', consecutivo: 1,
    });
    expect(nc).toBe('DTE-01-C0010001-000000000000001');
    expect(nc).toHaveLength(31);
  });

  it('paddea consecutivos grandes a 15 dígitos', () => {
    const nc = buildNumeroControl({
      tipoDte: '03', establecimiento: 'M001', puntoVenta: 'P001', consecutivo: 9999,
    });
    expect(nc).toBe('DTE-03-M001P001-000000000009999');
  });

  it('rechaza tipoDte mal formado', () => {
    expect(() => buildNumeroControl({
      tipoDte: '1', establecimiento: 'C001', puntoVenta: '0001', consecutivo: 1,
    })).toThrow(/tipoDte/);
  });

  it('rechaza establecimiento con minúsculas', () => {
    expect(() => buildNumeroControl({
      tipoDte: '01', establecimiento: 'c001', puntoVenta: '0001', consecutivo: 1,
    })).toThrow(/establecimiento/);
  });

  it('rechaza consecutivo fuera de rango', () => {
    expect(() => buildNumeroControl({
      tipoDte: '01', establecimiento: 'C001', puntoVenta: '0001', consecutivo: 0,
    })).toThrow(/consecutivo/);
    expect(() => buildNumeroControl({
      tipoDte: '01', establecimiento: 'C001', puntoVenta: '0001', consecutivo: 1e16,
    })).toThrow(/consecutivo/);
  });
});

describe('newCodigoGeneracion', () => {
  it('genera UUID v4 en mayúsculas', () => {
    const id = newCodigoGeneracion();
    expect(id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
    expect(id).toBe(id.toUpperCase());
  });

  it('produce IDs únicos en cada invocación', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newCodigoGeneracion()));
    expect(ids.size).toBe(100);
  });
});
