import { IVA_RATE, PAGO_CUENTA_RATE } from '@/config/constants';
import type { Compra, VentaConsumidor, VentaContribuyente } from '@/types/domain';
import { matchesPeriod, num } from './format';

export interface TaxSummary {
  totalVentasConsumidor: number;
  totalVentasContribuyenteGravado: number;
  totalVentasContribuyenteExento: number;
  totalVentasContribuyente: number;
  totalVentas: number;
  totalCompras: number;
  ivaDebito: number;
  ivaCredito: number;
  ivaNeto: number;
  /** Total de ventas CCF que tuvieron retención de Renta — excluidas del 1.75%. */
  ventasConRetencion: number;
  /** Suma de los montos retenidos por clientes Sujetos de Retención. */
  totalRetenidoRenta: number;
  /** Base efectiva sobre la que se calcula el 1.75%. */
  basePagoACuenta: number;
  pagoACuenta: number;
  totalDeclarar: number;
  countVc: number;
  countVt: number;
  countVtConRetencion: number;
  countCp: number;
}

export function computeTaxSummary(args: {
  ventasConsumidor: VentaConsumidor[];
  ventasContribuyente: VentaContribuyente[];
  compras: Compra[];
  month: number;
  year: number;
  mode?: 'monthly' | 'annual';
}): TaxSummary {
  const { ventasConsumidor, ventasContribuyente, compras, month, year, mode = 'monthly' } = args;

  const vc = ventasConsumidor.filter(r => matchesPeriod(r.fecha, mode, month, year));
  const vt = ventasContribuyente.filter(r => matchesPeriod(r.fecha, mode, month, year));
  const cp = compras.filter(r => matchesPeriod(r.fecha, mode, month, year));

  const totalVentasConsumidor = vc.reduce((s, r) => s + num(r.monto), 0);
  const totalVentasContribuyenteGravado = vt.reduce((s, r) => s + num(r.gravado), 0);
  const totalVentasContribuyenteExento = vt.reduce((s, r) => s + num(r.exento), 0);
  const totalVentasContribuyente = totalVentasContribuyenteGravado + totalVentasContribuyenteExento;
  const totalVentas = totalVentasConsumidor + totalVentasContribuyente;
  const totalCompras = cp.reduce((s, r) => s + num(r.monto), 0);

  const ivaDebito = (totalVentasConsumidor + totalVentasContribuyenteGravado) * IVA_RATE;
  const ivaCredito = cp.reduce((s, r) => s + num(r.ivaCredito), 0);
  const ivaNeto = ivaDebito - ivaCredito;

  // Pago a Cuenta del 1.75%: las ventas CCF que tuvieron retención de Renta
  // NO entran en la base — porque el cliente ya retuvo ISR de manera anticipada
  // (sería doble tributación aplicar el 1.75% sobre lo mismo).
  const ventasCCFConRetencion = vt.filter(r => num(r.metadata?.retencionRenta ?? 0) > 0);
  const ventasConRetencion = ventasCCFConRetencion
    .reduce((s, r) => s + num(r.gravado) + num(r.exento), 0);
  const totalRetenidoRenta = vt
    .reduce((s, r) => s + num(r.metadata?.retencionRenta ?? 0), 0);

  const basePagoACuenta = totalVentas - ventasConRetencion;
  const pagoACuenta = basePagoACuenta * PAGO_CUENTA_RATE;
  const totalDeclarar = Math.max(ivaNeto, 0) + pagoACuenta;

  return {
    totalVentasConsumidor,
    totalVentasContribuyenteGravado,
    totalVentasContribuyenteExento,
    totalVentasContribuyente,
    totalVentas,
    totalCompras,
    ivaDebito,
    ivaCredito,
    ivaNeto,
    ventasConRetencion,
    totalRetenidoRenta,
    basePagoACuenta,
    pagoACuenta,
    totalDeclarar,
    countVc: vc.length,
    countVt: vt.length,
    countVtConRetencion: ventasCCFConRetencion.length,
    countCp: cp.length,
  };
}

export function ivaIncluidoToCredito(montoTotal: number): number {
  return (montoTotal * IVA_RATE) / (1 + IVA_RATE);
}

export function baseSinIva(montoConIva: number): number {
  return montoConIva / (1 + IVA_RATE);
}
