import type { Config } from '../../config.js';
import { ValidationError } from '../../errors.js';
import { buildNumeroControl } from '../numero-control.js';
import type {
  CondicionOperacion, DocumentoRelacionado, DteNC, ItemNC,
  ReceptorCCF, ResumenNC, TributoLine,
} from '../types.js';
import { buildIdentificacion, emisorNcFromConfig, round2, totalEnLetras } from './common.js';

const IVA_RATE = 0.13;

export interface NcInput {
  consecutivo: number;
  receptor: ReceptorCCF;
  items: Array<Omit<ItemNC, 'numItem'>>;
  condicionOperacion?: CondicionOperacion;
  ivaPerci1?: number;
  ivaRete1?: number;
  reteRenta?: number;
  fecEmi?: Date;
  /** OBLIGATORIO — apunta al CCF original. Al menos un elemento. */
  documentoRelacionado: DocumentoRelacionado[];
}

/**
 * Construye una Nota de Crédito (tipoDte=05).
 * Aplica sólo a CCF previos (no a FCF). Mismo formato que CCF, pero con
 * `documentoRelacionado` obligatorio apuntando al CCF que ajusta.
 *
 * Convención típica: ventas/montos POSITIVOS — la NC representa el monto a
 * acreditar al receptor. El MH valida que la suma no exceda lo del CCF original.
 */
export function buildNc(cfg: Config, input: NcInput): DteNC {
  if (!input.documentoRelacionado.length) {
    throw new ValidationError('NC requiere al menos un documentoRelacionado (CCF original)');
  }

  const numeroControl = buildNumeroControl({
    tipoDte: '05',
    establecimiento: cfg.PUNTO_VENTA_ESTABLECIMIENTO,
    puntoVenta: cfg.PUNTO_VENTA_PUNTO,
    consecutivo: input.consecutivo,
  });
  const identificacion = buildIdentificacion({
    cfg, tipoDte: '05', version: 3, numeroControl, fecEmi: input.fecEmi,
  }) as DteNC['identificacion'];

  // ItemNC = ItemCCF sin `psv` ni `noGravado` (el schema NC los rechaza con
  // additionalProperties:false). Aunque vengan en input los descartamos
  // explícitamente — nunca hagas spread crudo de input externo.
  const cuerpoDocumento: ItemNC[] = input.items.map((it, idx) => ({
    numItem: idx + 1,
    tipoItem: it.tipoItem,
    numeroDocumento: it.numeroDocumento,
    cantidad: it.cantidad,
    codigo: it.codigo,
    codTributo: it.codTributo,
    uniMedida: it.uniMedida,
    descripcion: it.descripcion,
    precioUni: it.precioUni,
    montoDescu: it.montoDescu,
    ventaNoSuj: it.ventaNoSuj,
    ventaExenta: it.ventaExenta,
    ventaGravada: it.ventaGravada,
    tributos: it.tributos,
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

  // ResumenNC NO incluye porcentajeDescuento/saldoFavor/pagos/totalNoGravado/
  // totalPagar/numPagoElectronico (a diferencia de ResumenCCF). Schema rechaza.
  const resumen: ResumenNC = {
    totalNoSuj,
    totalExenta,
    totalGravada,
    subTotalVentas,
    descuNoSuj: 0,
    descuExenta: 0,
    descuGravada: 0,
    totalDescu: 0,
    tributos,
    subTotal: subTotalVentas,
    ivaPerci1,
    ivaRete1,
    reteRenta,
    montoTotalOperacion,
    totalLetras: totalEnLetras(montoTotalOperacion),
    condicionOperacion: input.condicionOperacion ?? 1,
  };

  return {
    identificacion,
    documentoRelacionado: input.documentoRelacionado,
    emisor: emisorNcFromConfig(cfg),
    receptor: input.receptor,
    ventaTercero: null,
    cuerpoDocumento,
    resumen,
    extension: null,
    apendice: null,
  };
}
