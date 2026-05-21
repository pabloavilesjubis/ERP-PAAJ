import type { Config } from '../../config.js';
import { AMBIENTE } from '../../config.js';
import { newCodigoGeneracion } from '../numero-control.js';
import type { Ambiente, AnulacionEvento, TipoAnulacion, TipoDte } from '../types.js';

export interface AnulacionInput {
  /** Datos del DTE a anular. */
  tipoDte: TipoDte;
  codigoGeneracion: string;
  selloRecibido: string;
  numeroControl: string;
  fecEmi: string;                  // YYYY-MM-DD del DTE original
  montoIva: number;

  /** Receptor del DTE original (necesario para que el MH pueda identificarlo). */
  tipoDocumentoReceptor: string;   // '13'=DUI, '36'=NIT, '37'=otro
  numDocumentoReceptor: string;
  nombreReceptor: string;
  telefonoReceptor?: string;
  correoReceptor?: string;

  /** Motivo. */
  tipoAnulacion: TipoAnulacion;    // 1=error en info, 2=rescisión, 3=otro
  motivoAnulacion: string;

  /** Responsable que ejecuta la anulación (típicamente el contador o gerente). */
  nombreResponsable: string;
  tipDocResponsable: string;       // '36'=NIT, '13'=DUI
  numDocResponsable: string;

  /** Persona que solicita la anulación (puede ser el cliente). */
  nombreSolicita: string;
  tipDocSolicita: string;
  numDocSolicita: string;

  /** Si la anulación es para reemplazar el DTE — codigoGeneracion del DTE nuevo. */
  codigoGeneracionReemplazo?: string;
}

/**
 * Construye un evento de Anulación (versión 2 del schema).
 * El evento es un JSON aparte que se firma igual que un DTE y se envía a
 * `/fesv/anulardte`. La ventana legal de anulación depende del tipo:
 *   - CCF/NC/ND: 24h desde emisión
 *   - FCF/FEX:   3 meses
 */
export function buildAnulacion(cfg: Config, input: AnulacionInput): AnulacionEvento {
  const now = new Date();
  return {
    identificacion: {
      version: 2,
      ambiente: AMBIENTE[cfg.MH_ENV] satisfies Ambiente,
      codigoGeneracion: newCodigoGeneracion(),
      fecAnula: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
      horAnula: `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`,
    },
    emisor: {
      nit: cfg.MH_NIT,
      nombre: cfg.EMISOR_NOMBRE,
      tipoEstablecimiento: cfg.EMISOR_TIPO_ESTABLECIMIENTO,
      nomEstablecimiento: cfg.EMISOR_NOMBRE_COMERCIAL ?? null,
      codEstableMH: null,
      codEstable: cfg.PUNTO_VENTA_ESTABLECIMIENTO,
      codPuntoVentaMH: null,
      codPuntoVenta: cfg.PUNTO_VENTA_PUNTO,
      telefono: cfg.EMISOR_TELEFONO ?? null,
      correo: cfg.EMISOR_EMAIL,
    },
    documento: {
      tipoDte: input.tipoDte,
      codigoGeneracion: input.codigoGeneracion,
      selloRecibido: input.selloRecibido,
      numeroControl: input.numeroControl,
      fecEmi: input.fecEmi,
      montoIva: input.montoIva,
      codigoGeneracionR: input.codigoGeneracionReemplazo ?? null,
      tipoDocumento: input.tipoDocumentoReceptor,
      numDocumento: input.numDocumentoReceptor,
      nombre: input.nombreReceptor,
      telefono: input.telefonoReceptor ?? null,
      correo: input.correoReceptor ?? null,
    },
    motivo: {
      tipoAnulacion: input.tipoAnulacion,
      motivoAnulacion: input.motivoAnulacion,
      nombreResponsable: input.nombreResponsable,
      tipDocResponsable: input.tipDocResponsable,
      numDocResponsable: input.numDocResponsable,
      nombreSolicita: input.nombreSolicita,
      tipDocSolicita: input.tipDocSolicita,
      numDocSolicita: input.numDocSolicita,
    },
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
