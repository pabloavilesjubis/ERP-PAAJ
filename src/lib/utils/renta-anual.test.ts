import { describe, expect, it } from 'vitest';
import type { Compra, VentaConsumidor, VentaContribuyente } from '@/types/domain';
import { anualDeMensual, estimarRentaAnual, impuestoTabla, TABLA_MENSUAL_DEFAULT } from './renta-anual';

const tabla = anualDeMensual(TABLA_MENSUAL_DEFAULT);
const compra = (monto: number, iva: number, metadata: Record<string, unknown> = {}, fecha = '2026-05-10') =>
  ({ id: String(Math.random()), fecha, proveedor: 'P', nrc: '', descripcion: '', monto: String(monto), ivaCredito: String(iva), notas: '', metadata }) as unknown as Compra;

describe('renta anual estimada (persona natural)', () => {
  it('tabla anual = mensual × 12; exento hasta $6,600', () => {
    expect(impuestoTabla(6000, tabla).impuesto).toBe(0);
    expect(impuestoTabla(8000, tabla).impuesto).toBe(352.04);   // 212.04 + (8,000 − 6,600) × 10 %
  });

  it('ingresos sin IVA, costos sin IVA acreditable, intereses deducibles y anticipos (retención 10 % + pago a cuenta)', () => {
    const r = estimarRentaAnual({
      year: 2026, tablaAnual: tabla,
      ventasConsumidor: [{ id: '1', fecha: '2026-03-01', monto: '11300' }] as unknown as VentaConsumidor[],
      ventasContribuyente: [
        { id: '2', fecha: '2026-04-01', gravado: '10000', exento: '0', metadata: { retencionRenta: '1000' } },
        { id: '3', fecha: '2025-12-31', gravado: '99999', exento: '0' },
      ] as unknown as VentaContribuyente[],
      compras: [
        compra(2260, 0),                                                                   // factura 01: el IVA es costo
        compra(1130, 130),                                                                 // CCF: base 1,000
        compra(1000, 0, { categoria: 'gasto_financiero', intereses: '1000.00' }),          // hipotecario
        compra(443.36, 0, { categoria: 'gasto_financiero', intereses: '402.56' }),         // préstamo + póliza 40.80
        compra(500, 0, { categoria: 'gasto_financiero', intereses: '500.00', deducibleRenta: false }),
        compra(648.4, 0, { categoria: 'gasto_financiero', intereses: '648.40', anulado: true }),
      ],
    });
    expect(r.ingresos).toBe(20000);
    expect(r.costosGastos).toBe(3300.8);
    expect(r.gastosFinancieros).toBe(1402.56);
    expect(r.gastosFinancierosNoDeducibles).toBe(500);
    expect(r.rentaNeta).toBe(15296.64);
    expect(r.impuesto).toBe(1630.75);       // 720 + (15,296.64 − 10,742.88) × 20 %
    expect(r.retenciones).toBe(1000);
    expect(r.pagoACuenta).toBe(175);        // 1.75 % de las ventas sin retención (10,000)
    expect(r.aPagar).toBe(455.75);
  });
});
