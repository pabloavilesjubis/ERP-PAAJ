/**
 * Estimación del impuesto sobre la renta anual (F-11) de una persona natural
 * con actividad propia: ingresos del año menos costos, gastos y gastos
 * financieros deducibles; impuesto con la tabla progresiva; menos lo pagado por
 * anticipado (retenciones de renta que le hicieron los clientes y pago a cuenta
 * del 1.75 % del F-14). Es una estimación de apoyo, no la declaración.
 */
import { IVA_RATE, PAGO_CUENTA_RATE } from '@/config/constants';
import type { Compra, VentaConsumidor, VentaContribuyente } from '@/types/domain';
import { num } from './format';

export interface Tramo { desde: number; tasa: number; sobreExceso: number; cuotaFija: number }

/** Tabla mensual de retención vigente (reforma 2025); la anual es esta × 12. */
export const TABLA_MENSUAL_DEFAULT: Tramo[] = [
  { desde: 0.01, tasa: 0, sobreExceso: 0, cuotaFija: 0 },
  { desde: 550.01, tasa: 0.10, sobreExceso: 550, cuotaFija: 17.67 },
  { desde: 895.25, tasa: 0.20, sobreExceso: 895.24, cuotaFija: 60 },
  { desde: 2038.11, tasa: 0.30, sobreExceso: 2038.10, cuotaFija: 288.57 },
];

export const anualDeMensual = (t: Tramo[]): Tramo[] =>
  t.map(x => ({ desde: round2(x.desde * 12), tasa: x.tasa, sobreExceso: round2(x.sobreExceso * 12), cuotaFija: round2(x.cuotaFija * 12) }));

const round2 = (n: number) => Math.round(n * 100) / 100;

export function impuestoTabla(renta: number, tabla: Tramo[]): { impuesto: number; tramo: Tramo | null } {
  if (renta <= 0) return { impuesto: 0, tramo: null };
  const tramo = [...tabla].sort((a, b) => b.desde - a.desde).find(t => renta >= t.desde) ?? null;
  if (!tramo) return { impuesto: 0, tramo: null };
  return { impuesto: Math.max(round2(tramo.cuotaFija + (renta - tramo.sobreExceso) * tramo.tasa), 0), tramo };
}

export interface RentaAnual {
  ingresos: number;
  costosGastos: number;
  gastosFinancieros: number;
  gastosFinancierosNoDeducibles: number;
  rentaNeta: number;
  impuesto: number;
  tramo: Tramo | null;
  retenciones: number;
  ventasConRetencion: number;
  pagoACuenta: number;
  anticipos: number;
  aPagar: number;
  documentos: { ventas: number; compras: number; financieros: number };
}

const anulado = (m: { anulado?: boolean } | undefined) => !!m?.anulado;

export function estimarRentaAnual(args: {
  ventasConsumidor: VentaConsumidor[];
  ventasContribuyente: VentaContribuyente[];
  compras: Compra[];
  year: number;
  tablaAnual: Tramo[];
  pagoACuentaRate?: number;
}): RentaAnual {
  const y = String(args.year);
  const inYear = (f: string | undefined) => (f ?? '').startsWith(y);
  const vc = args.ventasConsumidor.filter(r => inYear(r.fecha) && !anulado(r.metadata as { anulado?: boolean }));
  const vt = args.ventasContribuyente.filter(r => inYear(r.fecha) && !anulado(r.metadata as { anulado?: boolean }));
  const cp = args.compras.filter(r => inYear(r.fecha) && !anulado(r.metadata));

  // Ingresos sin IVA: la factura de consumidor final lo trae incluido
  const ingresosVc = vc.reduce((s, r) => s + num(r.monto) / (1 + IVA_RATE), 0);
  const ingresosVt = vt.reduce((s, r) => s + num(r.gravado) + num(r.exento), 0);
  const ingresos = round2(ingresosVc + ingresosVt);

  // Costos y gastos sin el IVA acreditable (el IVA de una factura 01 es costo); de los
  // gastos financieros solo los intereses van aparte, el resto del documento es gasto normal
  let costosGastos = 0;
  let gastosFinancieros = 0;
  let noDeducibles = 0;
  let financieros = 0;
  for (const c of cp) {
    const base = num(c.monto) - num(c.ivaCredito);
    if (c.metadata?.categoria === 'gasto_financiero') {
      financieros++;
      const intereses = Math.min(num(c.metadata.intereses ?? c.monto), base);
      if (c.metadata.deducibleRenta === false) noDeducibles += intereses;
      else gastosFinancieros += intereses;
      costosGastos += base - intereses;
    } else {
      costosGastos += base;
    }
  }
  costosGastos = round2(costosGastos);
  gastosFinancieros = round2(gastosFinancieros);

  const rentaNeta = round2(ingresos - costosGastos - gastosFinancieros);
  const { impuesto, tramo } = impuestoTabla(rentaNeta, args.tablaAnual);

  // Anticipos: renta que le retuvieron los clientes (p. ej. 10 % por servicios) y el pago a
  // cuenta mensual del F-14 sobre las ventas que no tuvieron retención
  const conRetencion = vt.filter(r => num(r.metadata?.retencionRenta ?? 0) > 0);
  const retenciones = round2(vt.reduce((s, r) => s + num(r.metadata?.retencionRenta ?? 0), 0));
  const ventasConRetencion = round2(conRetencion.reduce((s, r) => s + num(r.gravado) + num(r.exento), 0));
  const pagoACuenta = round2(Math.max(ingresos - ventasConRetencion, 0) * (args.pagoACuentaRate ?? PAGO_CUENTA_RATE));
  const anticipos = round2(retenciones + pagoACuenta);

  return {
    ingresos, costosGastos, gastosFinancieros, gastosFinancierosNoDeducibles: round2(noDeducibles), rentaNeta, impuesto, tramo,
    retenciones, ventasConRetencion, pagoACuenta, anticipos, aPagar: round2(impuesto - anticipos),
    documentos: { ventas: vc.length + vt.length, compras: cp.length, financieros },
  };
}
