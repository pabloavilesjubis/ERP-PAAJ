import type { Config } from '../../config.js';
import { AMBIENTE } from '../../config.js';
import type { Ambiente, EmisorComun, EmisorFse, EmisorNc, IdentificacionComun, TipoDte } from '../types.js';
import { newCodigoGeneracion } from '../numero-control.js';

/**
 * Emisor para FCF y CCF (incluye `nombreComercial`, `tipoEstablecimiento`,
 * `codEstableMH/codEstable/codPuntoVentaMH/codPuntoVenta`). Estos schemas
 * aceptan todos los campos de venta-en-tienda.
 */
export function emisorFromConfig(cfg: Config): EmisorComun {
  return {
    nit: cfg.MH_NIT,
    nrc: cfg.EMISOR_NRC,
    nombre: cfg.EMISOR_NOMBRE,
    codActividad: cfg.EMISOR_COD_ACTIVIDAD,
    descActividad: cfg.EMISOR_DESC_ACTIVIDAD,
    nombreComercial: cfg.EMISOR_NOMBRE_COMERCIAL ?? null,
    tipoEstablecimiento: cfg.EMISOR_TIPO_ESTABLECIMIENTO,
    direccion: {
      departamento: cfg.EMISOR_DEPARTAMENTO,
      municipio: cfg.EMISOR_MUNICIPIO,
      complemento: cfg.EMISOR_COMPLEMENTO,
    },
    telefono: cfg.EMISOR_TELEFONO ?? null,
    correo: cfg.EMISOR_EMAIL,
    codEstableMH: cfg.EMISOR_COD_ESTABLE_MH ?? null,
    codEstable: cfg.PUNTO_VENTA_ESTABLECIMIENTO,
    codPuntoVentaMH: cfg.EMISOR_COD_PUNTO_VENTA_MH ?? null,
    codPuntoVenta: cfg.PUNTO_VENTA_PUNTO,
  };
}

/**
 * Emisor para NC (Nota de Crédito). El schema NC NO permite los campos
 * `codEstableMH/codEstable/codPuntoVentaMH/codPuntoVenta` (validation con
 * `additionalProperties: false`). Sí permite `nombreComercial` y
 * `tipoEstablecimiento`.
 */
export function emisorNcFromConfig(cfg: Config): EmisorNc {
  return {
    nit: cfg.MH_NIT,
    nrc: cfg.EMISOR_NRC,
    nombre: cfg.EMISOR_NOMBRE,
    codActividad: cfg.EMISOR_COD_ACTIVIDAD,
    descActividad: cfg.EMISOR_DESC_ACTIVIDAD,
    nombreComercial: cfg.EMISOR_NOMBRE_COMERCIAL ?? null,
    tipoEstablecimiento: cfg.EMISOR_TIPO_ESTABLECIMIENTO,
    direccion: {
      departamento: cfg.EMISOR_DEPARTAMENTO,
      municipio: cfg.EMISOR_MUNICIPIO,
      complemento: cfg.EMISOR_COMPLEMENTO,
    },
    telefono: cfg.EMISOR_TELEFONO ?? null,
    correo: cfg.EMISOR_EMAIL,
  };
}

/**
 * Emisor para FSE (Sujeto Excluido). El schema FSE NO permite los campos
 * `nombreComercial` ni `tipoEstablecimiento`. Sí permite (y requiere) los
 * códigos de establecimiento y punto de venta.
 */
export function emisorFseFromConfig(cfg: Config): EmisorFse {
  return {
    nit: cfg.MH_NIT,
    nrc: cfg.EMISOR_NRC,
    nombre: cfg.EMISOR_NOMBRE,
    codActividad: cfg.EMISOR_COD_ACTIVIDAD,
    descActividad: cfg.EMISOR_DESC_ACTIVIDAD,
    direccion: {
      departamento: cfg.EMISOR_DEPARTAMENTO,
      municipio: cfg.EMISOR_MUNICIPIO,
      complemento: cfg.EMISOR_COMPLEMENTO,
    },
    telefono: cfg.EMISOR_TELEFONO ?? null,
    correo: cfg.EMISOR_EMAIL,
    codEstableMH: cfg.EMISOR_COD_ESTABLE_MH ?? null,
    codEstable: cfg.PUNTO_VENTA_ESTABLECIMIENTO,
    codPuntoVentaMH: cfg.EMISOR_COD_PUNTO_VENTA_MH ?? null,
    codPuntoVenta: cfg.PUNTO_VENTA_PUNTO,
  };
}

// Los types EmisorNc / EmisorFse están exportados desde ../types.ts

export interface IdentBuildArgs {
  cfg: Config;
  tipoDte: TipoDte;
  version: number;
  numeroControl: string;
  fecEmi?: Date;
}

export function buildIdentificacion(args: IdentBuildArgs): IdentificacionComun {
  const fec = args.fecEmi ?? new Date();
  // ISO local = UTC con offset 0; el MH valida fecha local de El Salvador
  // (UTC-6). Normalizamos a "now" del servidor — al deployar en SV o con TZ
  // correcta esto coincide. Si despliegas en UTC, configura TZ=America/El_Salvador
  // en el contenedor.
  const fecEmi = `${fec.getFullYear()}-${pad2(fec.getMonth() + 1)}-${pad2(fec.getDate())}`;
  const horEmi = `${pad2(fec.getHours())}:${pad2(fec.getMinutes())}:${pad2(fec.getSeconds())}`;
  return {
    version: args.version,
    ambiente: AMBIENTE[args.cfg.MH_ENV] satisfies Ambiente,
    tipoDte: args.tipoDte,
    numeroControl: args.numeroControl,
    codigoGeneracion: newCodigoGeneracion(),
    tipoModelo: 1,
    tipoOperacion: 1,
    tipoContingencia: null,
    motivoContin: null,
    fecEmi,
    horEmi,
    tipoMoneda: 'USD',
  };
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Convierte un monto a su representación en letras según convención del MH.
 * NOTA: implementación placeholder — para producción reemplaza por
 * `numero-a-letras` (npm) o un helper interno equivalente. El MH valida que
 * `totalLetras` no sea vacío; el contenido específico no se valida estrictamente
 * en sandbox pero conviene cumplir la convención.
 */
export function totalEnLetras(monto: number): string {
  const fixed = monto.toFixed(2);
  const [enteros, decimales] = fixed.split('.');
  return `${enteros} 00/${decimales} DÓLARES`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
