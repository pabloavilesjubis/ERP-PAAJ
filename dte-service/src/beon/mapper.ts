import type { Config } from '../config.js';
import { ValidationError } from '../errors.js';
import type { CcfInput } from '../dte/builders/ccf.js';
import type { FcfInput } from '../dte/builders/fcf.js';
import type { NcInput } from '../dte/builders/nc.js';
import { round2 } from '../dte/builders/common.js';
import type {
  CondicionOperacion, DocumentoRelacionado, ItemFCF, ItemCCF, PagoEntry,
  ReceptorCCF, ReceptorFCF,
} from '../dte/types.js';
import type { BeonClienteT, BeonEmitirRequest, BeonItemT } from './types.js';

const IVA_RATE = 0.13;

/** Resuelve `num_documento` y `tipo_documento` aceptando `nit` como alias. */
function resolveDocumento(cli: BeonClienteT): { tipoDocumento: string | null; numDocumento: string | null } {
  if (cli.nit) return { tipoDocumento: '36', numDocumento: cli.nit };
  return {
    tipoDocumento: cli.tipo_documento ?? null,
    numDocumento: cli.num_documento ?? null,
  };
}

function buildReceptorFcf(cli: BeonClienteT | null | undefined, cfg: Config): ReceptorFCF | null {
  if (!cli) return null;
  const { tipoDocumento, numDocumento } = resolveDocumento(cli);
  return {
    tipoDocumento,
    numDocumento,
    nrc: cli.nrc ?? null,
    nombre: cli.nombre,
    codActividad: cli.cod_actividad ?? null,
    descActividad: cli.desc_actividad ?? null,
    direccion: cli.direccion
      ? {
        departamento: cli.direccion.departamento ?? cfg.EMISOR_DEPARTAMENTO,
        municipio: cli.direccion.municipio ?? cfg.EMISOR_MUNICIPIO,
        complemento: cli.direccion.complemento ?? '',
      }
      : null,
    telefono: cli.telefono ?? null,
    correo: cli.correo ?? null,
  };
}

function buildReceptorCcf(cli: BeonClienteT | null | undefined, cfg: Config): ReceptorCCF {
  if (!cli) throw new ValidationError('CCF/NC requieren bloque cliente');
  const { numDocumento } = resolveDocumento(cli);
  if (!numDocumento) throw new ValidationError('cliente.nit (o num_documento) requerido para CCF/NC');
  if (!cli.nrc) throw new ValidationError('cliente.nrc requerido para CCF/NC');
  if (!cli.cod_actividad || !cli.desc_actividad) {
    throw new ValidationError('cliente.cod_actividad y cliente.desc_actividad requeridos para CCF/NC');
  }
  if (!cli.correo) throw new ValidationError('cliente.correo requerido para CCF/NC');
  return {
    nit: numDocumento,
    nrc: cli.nrc,
    nombre: cli.nombre,
    codActividad: cli.cod_actividad,
    descActividad: cli.desc_actividad,
    nombreComercial: cli.nombre_comercial ?? null,
    direccion: {
      departamento: cli.direccion?.departamento ?? cfg.EMISOR_DEPARTAMENTO,
      municipio: cli.direccion?.municipio ?? cfg.EMISOR_MUNICIPIO,
      complemento: cli.direccion?.complemento ?? '',
    },
    telefono: cli.telefono ?? null,
    correo: cli.correo,
  };
}

function buildPagos(pagos: BeonEmitirRequest['pagos']): PagoEntry[] | null {
  if (!pagos || pagos.length === 0) return null;
  return pagos.map(p => ({
    codigo: p.codigo,
    montoPago: round2(p.monto),
    referencia: p.referencia ?? null,
    plazo: p.plazo ?? null,
    periodo: p.periodo ?? null,
  }));
}

/** Items para FCF: precioUni/ventaGravada CON IVA incluido. */
function mapItemsFcf(items: BeonItemT[]): Array<Omit<ItemFCF, 'numItem' | 'ivaItem'>> {
  return items.map(it => {
    const precioConIva = round2(it.precio_unitario);
    const ventaGravada = round2(precioConIva * it.cantidad - (it.descuento ?? 0));
    return {
      tipoItem: it.tipo_item ?? 2,
      numeroDocumento: null,
      cantidad: it.cantidad,
      codigo: it.codigo ?? null,
      codTributo: null,
      uniMedida: it.unidad_medida ?? 59,
      descripcion: it.descripcion,
      precioUni: precioConIva,
      montoDescu: round2(it.descuento ?? 0),
      ventaNoSuj: 0,
      ventaExenta: round2(it.exento ?? 0),
      ventaGravada,
      tributos: null,
      psv: 0,
      noGravado: round2(it.no_gravado ?? 0),
    };
  });
}

/** Items para CCF: precioUni/ventaGravada SIN IVA. */
function mapItemsCcf(items: BeonItemT[]): Array<Omit<ItemCCF, 'numItem'>> {
  return items.map(it => {
    const precioSinIva = round2(it.precio_unitario);
    const ventaGravada = round2(precioSinIva * it.cantidad - (it.descuento ?? 0));
    return {
      tipoItem: it.tipo_item ?? 2,
      numeroDocumento: null,
      cantidad: it.cantidad,
      codigo: it.codigo ?? null,
      codTributo: null,
      uniMedida: it.unidad_medida ?? 59,
      descripcion: it.descripcion,
      precioUni: precioSinIva,
      montoDescu: round2(it.descuento ?? 0),
      ventaNoSuj: 0,
      ventaExenta: round2(it.exento ?? 0),
      ventaGravada,
      tributos: ['20'],
      psv: 0,
      noGravado: round2(it.no_gravado ?? 0),
    };
  });
}

/** Items para NC: mismo formato CCF pero sin psv/noGravado (el builder los descarta). */
function mapItemsNc(items: BeonItemT[]): NcInput['items'] {
  return items.map(it => {
    const precioSinIva = round2(it.precio_unitario);
    const ventaGravada = round2(precioSinIva * it.cantidad - (it.descuento ?? 0));
    return {
      tipoItem: it.tipo_item ?? 2,
      numeroDocumento: null,
      cantidad: it.cantidad,
      codigo: it.codigo ?? null,
      codTributo: null,
      uniMedida: it.unidad_medida ?? 59,
      descripcion: it.descripcion,
      precioUni: precioSinIva,
      montoDescu: round2(it.descuento ?? 0),
      ventaNoSuj: 0,
      ventaExenta: round2(it.exento ?? 0),
      ventaGravada,
      tributos: ['20'],
    };
  });
}

export function parseFecha(iso: string | undefined): Date | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`fecha_emision inválida: ${iso}`);
  return d;
}

export function mapToFcfInput(req: BeonEmitirRequest, cfg: Config, consecutivo: number): FcfInput {
  return {
    consecutivo,
    receptor: buildReceptorFcf(req.cliente, cfg),
    items: mapItemsFcf(req.items),
    condicionOperacion: (req.condicion_operacion ?? 1) as CondicionOperacion,
    pagos: buildPagos(req.pagos),
    fecEmi: parseFecha(req.fecha_emision),
  };
}

export function mapToCcfInput(req: BeonEmitirRequest, cfg: Config, consecutivo: number): CcfInput {
  return {
    consecutivo,
    receptor: buildReceptorCcf(req.cliente, cfg),
    items: mapItemsCcf(req.items),
    condicionOperacion: (req.condicion_operacion ?? 1) as CondicionOperacion,
    pagos: buildPagos(req.pagos),
    ivaPerci1: req.iva_perci1,
    ivaRete1: req.iva_rete1,
    reteRenta: req.rete_renta,
    fecEmi: parseFecha(req.fecha_emision),
  };
}

export function mapToNcInput(req: BeonEmitirRequest, cfg: Config, consecutivo: number): NcInput {
  if (!req.documento_relacionado || req.documento_relacionado.length === 0) {
    throw new ValidationError('NC requiere documento_relacionado (CCF original)');
  }
  const documentoRelacionado: DocumentoRelacionado[] = req.documento_relacionado.map(d => ({
    tipoDocumento: d.tipo_documento,
    tipoGeneracion: d.tipo_generacion,
    numeroDocumento: d.numero_documento,
    fechaEmision: d.fecha_emision,
  }));
  return {
    consecutivo,
    receptor: buildReceptorCcf(req.cliente, cfg),
    items: mapItemsNc(req.items),
    condicionOperacion: (req.condicion_operacion ?? 1) as CondicionOperacion,
    ivaPerci1: req.iva_perci1,
    ivaRete1: req.iva_rete1,
    reteRenta: req.rete_renta,
    fecEmi: parseFecha(req.fecha_emision),
    documentoRelacionado,
  };
}

/** Calcula el monto IVA del DTE — útil para construir el evento de anulación. */
export function montoIvaFromDte(dte: { resumen: Record<string, unknown> }): number {
  const r = dte.resumen as Record<string, number | unknown>;
  if (typeof r.totalIva === 'number') return r.totalIva;                 // FCF
  const tributos = r.tributos as Array<{ codigo: string; valor: number }> | undefined;
  const iva = tributos?.find(t => t.codigo === '20')?.valor ?? 0;
  return iva;
}
