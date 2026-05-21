import type { Config } from '../../config.js';
import { buildNumeroControl } from '../numero-control.js';
import type {
  CondicionOperacion, DteFSE, ItemFSE, PagoEntry, ReceptorFSE, ResumenFSE,
} from '../types.js';
import { buildIdentificacion, emisorFseFromConfig, round2, totalEnLetras } from './common.js';

export interface FseInput {
  consecutivo: number;
  /** Persona excluida del IVA — DUI (tipo '13') o NIT (tipo '36'). */
  sujetoExcluido: ReceptorFSE;
  items: Array<Omit<ItemFSE, 'numItem'>>;
  condicionOperacion?: CondicionOperacion;
  pagos?: PagoEntry[] | null;
  /** Retención de Renta (10% para servicios profesionales, etc.) opcional. */
  reteRenta?: number;
  observaciones?: string;
  fecEmi?: Date;
}

/**
 * Construye un DTE FSE (Sujeto Excluido, tipoDte=14).
 * Lo emite el contribuyente cuando le compra a alguien que NO es contribuyente
 * de IVA (persona natural sin NRC). No hay IVA en la operación.
 *
 * Si aplica retención de Renta (caso típico: servicios profesionales 10%),
 * se descuenta del total a pagar al sujeto excluido.
 */
export function buildFse(cfg: Config, input: FseInput): DteFSE {
  const numeroControl = buildNumeroControl({
    tipoDte: '14',
    establecimiento: cfg.PUNTO_VENTA_ESTABLECIMIENTO,
    puntoVenta: cfg.PUNTO_VENTA_PUNTO,
    consecutivo: input.consecutivo,
  });
  const identificacion = buildIdentificacion({
    cfg, tipoDte: '14', version: 1, numeroControl, fecEmi: input.fecEmi,
  }) as DteFSE['identificacion'];

  const cuerpoDocumento: ItemFSE[] = input.items.map((it, idx) => ({
    ...it,
    numItem: idx + 1,
  }));

  const totalCompra = round2(cuerpoDocumento.reduce((s, it) => s + it.compra, 0));
  const reteRenta = round2(input.reteRenta ?? 0);
  const totalPagar = round2(totalCompra - reteRenta);

  const resumen: ResumenFSE = {
    totalCompra,
    descu: 0,
    totalDescu: 0,
    subTotal: totalCompra,
    ivaRete1: 0,
    reteRenta,
    totalPagar,
    totalLetras: totalEnLetras(totalPagar),
    condicionOperacion: input.condicionOperacion ?? 1,
    pagos: input.pagos ?? null,
    observaciones: input.observaciones ?? null,
  };

  return {
    identificacion,
    emisor: emisorFseFromConfig(cfg),
    sujetoExcluido: input.sujetoExcluido,
    cuerpoDocumento,
    resumen,
    apendice: null,
  };
}
