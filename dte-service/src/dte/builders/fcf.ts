import type { Config } from '../../config.js';
import { buildNumeroControl } from '../numero-control.js';
import type {
  CondicionOperacion, DteFCF, ItemFCF, PagoEntry, ReceptorFCF, ResumenFCF,
} from '../types.js';
import { buildIdentificacion, emisorFromConfig, round2, totalEnLetras } from './common.js';

const IVA_RATE = 0.13;

export interface FcfInput {
  consecutivo: number;
  receptor?: ReceptorFCF | null;
  items: Array<Omit<ItemFCF, 'numItem' | 'ivaItem'>>;
  condicionOperacion?: CondicionOperacion;
  pagos?: PagoEntry[] | null;
  fecEmi?: Date;
}

/**
 * Construye un DTE FCF (Factura Consumidor Final, tipoDte=01).
 * Reglas:
 * - `precioUni` y `ventaGravada` van CON IVA incluido.
 * - `totalIva` en resumen es el monto IVA implícito (informativo).
 * - El receptor es opcional (consumidor anónimo).
 */
export function buildFcf(cfg: Config, input: FcfInput): DteFCF {
  const numeroControl = buildNumeroControl({
    tipoDte: '01',
    establecimiento: cfg.PUNTO_VENTA_ESTABLECIMIENTO,
    puntoVenta: cfg.PUNTO_VENTA_PUNTO,
    consecutivo: input.consecutivo,
  });
  const identificacion = buildIdentificacion({
    cfg, tipoDte: '01', version: 1, numeroControl, fecEmi: input.fecEmi,
  }) as DteFCF['identificacion'];

  const cuerpoDocumento: ItemFCF[] = input.items.map((it, idx) => ({
    ...it,
    numItem: idx + 1,
    ivaItem: round2((it.ventaGravada * IVA_RATE) / (1 + IVA_RATE)),
  }));

  const totalGravada = round2(cuerpoDocumento.reduce((s, it) => s + it.ventaGravada, 0));
  const totalExenta = round2(cuerpoDocumento.reduce((s, it) => s + it.ventaExenta, 0));
  const totalNoSuj = round2(cuerpoDocumento.reduce((s, it) => s + it.ventaNoSuj, 0));
  const subTotal = round2(totalGravada + totalExenta + totalNoSuj);
  const totalIva = round2((totalGravada * IVA_RATE) / (1 + IVA_RATE));

  const resumen: ResumenFCF = {
    totalNoSuj,
    totalExenta,
    totalGravada,
    subTotalVentas: subTotal,
    descuNoSuj: 0,
    descuExenta: 0,
    descuGravada: 0,
    porcentajeDescuento: 0,
    totalDescu: 0,
    tributos: null,
    subTotal,
    ivaRete1: 0,
    reteRenta: 0,
    montoTotalOperacion: subTotal,
    totalNoGravado: 0,
    totalPagar: subTotal,
    totalLetras: totalEnLetras(subTotal),
    totalIva,
    saldoFavor: 0,
    condicionOperacion: input.condicionOperacion ?? 1,
    pagos: input.pagos ?? null,
    numPagoElectronico: null,
  };

  return {
    identificacion,
    documentoRelacionado: null,
    emisor: emisorFromConfig(cfg),
    receptor: input.receptor ?? null,
    otrosDocumentos: null,
    ventaTercero: null,
    cuerpoDocumento,
    resumen,
    extension: null,
    apendice: null,
  };
}
