import type { Config } from '../../config.js';
import { buildNumeroControl } from '../numero-control.js';
import type {
  CondicionOperacion, DteCCF, ItemCCF, PagoEntry, ReceptorCCF, ResumenCCF, TributoLine,
} from '../types.js';
import { buildIdentificacion, emisorFromConfig, round2, totalEnLetras } from './common.js';

const IVA_RATE = 0.13;

export interface CcfInput {
  consecutivo: number;
  receptor: ReceptorCCF;
  items: Array<Omit<ItemCCF, 'numItem'>>;
  condicionOperacion?: CondicionOperacion;
  pagos?: PagoEntry[] | null;
  ivaPerci1?: number;     // percepción IVA opcional
  ivaRete1?: number;      // retención IVA 1% opcional
  reteRenta?: number;     // retención de Renta opcional
  fecEmi?: Date;
}

/**
 * Construye un DTE CCF (Comprobante de Crédito Fiscal, tipoDte=03).
 * Reglas:
 * - `precioUni` y `ventaGravada` van SIN IVA.
 * - El IVA 13% va listado en `resumen.tributos` (código '20').
 * - `montoTotalOperacion` = subTotal + IVA + percepción − retenciones.
 */
export function buildCcf(cfg: Config, input: CcfInput): DteCCF {
  const numeroControl = buildNumeroControl({
    tipoDte: '03',
    establecimiento: cfg.PUNTO_VENTA_ESTABLECIMIENTO,
    puntoVenta: cfg.PUNTO_VENTA_PUNTO,
    consecutivo: input.consecutivo,
  });
  const identificacion = buildIdentificacion({
    cfg, tipoDte: '03', version: 3, numeroControl, fecEmi: input.fecEmi,
  }) as DteCCF['identificacion'];

  const cuerpoDocumento: ItemCCF[] = input.items.map((it, idx) => ({
    ...it,
    numItem: idx + 1,
  }));

  const totalGravada = round2(cuerpoDocumento.reduce((s, it) => s + it.ventaGravada, 0));
  const totalExenta = round2(cuerpoDocumento.reduce((s, it) => s + it.ventaExenta, 0));
  const totalNoSuj = round2(cuerpoDocumento.reduce((s, it) => s + it.ventaNoSuj, 0));
  const subTotalVentas = round2(totalGravada + totalExenta + totalNoSuj);
  const ivaTotal = round2(totalGravada * IVA_RATE);

  const tributos: TributoLine[] = [
    { codigo: '20', descripcion: 'Impuesto al Valor Agregado 13%', valor: ivaTotal },
  ];

  const ivaPerci1 = round2(input.ivaPerci1 ?? 0);
  const ivaRete1 = round2(input.ivaRete1 ?? 0);
  const reteRenta = round2(input.reteRenta ?? 0);
  const montoTotalOperacion = round2(subTotalVentas + ivaTotal + ivaPerci1 - ivaRete1 - reteRenta);

  const resumen: ResumenCCF = {
    totalNoSuj,
    totalExenta,
    totalGravada,
    subTotalVentas,
    descuNoSuj: 0,
    descuExenta: 0,
    descuGravada: 0,
    porcentajeDescuento: 0,
    totalDescu: 0,
    tributos,
    subTotal: subTotalVentas,
    ivaPerci1,
    ivaRete1,
    reteRenta,
    montoTotalOperacion,
    totalLetras: totalEnLetras(montoTotalOperacion),
    totalNoGravado: 0,
    totalPagar: montoTotalOperacion,
    saldoFavor: 0,
    condicionOperacion: input.condicionOperacion ?? 1,
    pagos: input.pagos ?? null,
    numPagoElectronico: null,
  };

  return {
    identificacion,
    documentoRelacionado: null,
    emisor: emisorFromConfig(cfg),
    receptor: input.receptor,
    otrosDocumentos: null,
    ventaTercero: null,
    cuerpoDocumento,
    resumen,
    extension: null,
    apendice: null,
  };
}
