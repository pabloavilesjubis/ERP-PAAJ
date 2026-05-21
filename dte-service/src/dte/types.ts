/**
 * Tipos del esquema público DTE 1.0 del MH El Salvador.
 * Cobertura: FCF (01), CCF (03), NC (05), FSE (14), evento Anulación (v2).
 *
 * NOTAS:
 * - Estos tipos reflejan la guía pública. Cuando obtengas los JSON Schemas
 *   oficiales (ZIP en factura.gob.sv), agrega validación zod equivalente.
 * - `tipoModelo` y `tipoOperacion` se serializan como números (no strings).
 * - Campos opcionales nullables siguen la convención del MH: `null` cuando
 *   no aplica, no `undefined` ni omisión.
 */

export type Ambiente = '00' | '01';
export type TipoDte = '01' | '03' | '05' | '14';
export type TipoModelo = 1 | 2;          // 1=normal, 2=batch
export type TipoOperacion = 1 | 2;       // 1=normal, 2=contingencia
export type CondicionOperacion = 1 | 2 | 3;  // 1=contado, 2=crédito, 3=otro

export interface Direccion {
  departamento: string;       // CAT-012 (2 chars)
  municipio: string;          // CAT-013 (2 chars)
  complemento: string;
}

export interface IdentificacionComun {
  version: number;
  ambiente: Ambiente;
  tipoDte: TipoDte;
  numeroControl: string;
  codigoGeneracion: string;       // UUID upper
  tipoModelo: TipoModelo;
  tipoOperacion: TipoOperacion;
  tipoContingencia: number | null;
  motivoContin: string | null;
  fecEmi: string;                  // YYYY-MM-DD
  horEmi: string;                  // HH:MM:SS
  tipoMoneda: 'USD';
}

/** Emisor "completo" — usado por FCF y CCF. NC y FSE tienen subsets más
 *  estrictos: `EmisorNc` (sin codEstable*) y `EmisorFse` (sin nombreComercial
 *  ni tipoEstablecimiento). Ver `dte/builders/common.ts`.
 */
export interface EmisorComun {
  nit: string;
  nrc: string;
  nombre: string;
  codActividad: string;
  descActividad: string;
  nombreComercial: string | null;
  tipoEstablecimiento: string;     // CAT-009
  direccion: Direccion;
  telefono: string | null;
  correo: string;
  codEstableMH: string | null;
  codEstable: string | null;
  codPuntoVentaMH: string | null;
  codPuntoVenta: string | null;
}

export interface ReceptorFCF {
  // FCF — receptor opcional (consumidor final puede ser anónimo)
  tipoDocumento: string | null;
  numDocumento: string | null;
  nrc: string | null;
  nombre: string | null;
  codActividad: string | null;
  descActividad: string | null;
  direccion: Direccion | null;
  telefono: string | null;
  correo: string | null;
}

export interface ReceptorCCF {
  // CCF — receptor obligatorio, contribuyente registrado
  nit: string;
  nrc: string;
  nombre: string;
  codActividad: string;
  descActividad: string;
  nombreComercial: string | null;
  direccion: Direccion;
  telefono: string | null;
  correo: string;
}

export interface ReceptorFSE {
  // FSE — sujeto excluido (DUI o NIT)
  tipoDocumento: string;            // '13'=DUI, '36'=NIT
  numDocumento: string;
  nombre: string;
  codActividad: string | null;
  descActividad: string | null;
  direccion: Direccion;
  telefono: string | null;
  correo: string | null;
}

export interface PagoEntry {
  codigo: string;                   // CAT-017
  montoPago: number;
  referencia: string | null;
  plazo: string | null;
  periodo: number | null;
}

export interface DocumentoRelacionado {
  tipoDocumento: string;            // '03' para CCF, '01' para FCF
  tipoGeneracion: 1 | 2;            // 1=físico, 2=electrónico
  numeroDocumento: string;          // codigoGeneracion del DTE original (electrónico)
  fechaEmision: string;             // YYYY-MM-DD
}

/* ────────────── Items por tipo de DTE ────────────── */

export interface ItemFCF {
  numItem: number;
  tipoItem: 1 | 2 | 3 | 4;          // 1=bienes,2=servicios,3=ambos,4=tributos
  numeroDocumento: string | null;
  cantidad: number;
  codigo: string | null;
  codTributo: string | null;
  uniMedida: number;                // CAT-014
  descripcion: string;
  precioUni: number;                // INCLUYE IVA en FCF
  montoDescu: number;
  ventaNoSuj: number;
  ventaExenta: number;
  ventaGravada: number;             // INCLUYE IVA en FCF
  tributos: string[] | null;
  psv: number;
  noGravado: number;
  ivaItem?: number;                 // monto IVA implícito
}

export interface ItemCCF {
  numItem: number;
  tipoItem: 1 | 2 | 3 | 4;
  numeroDocumento: string | null;
  cantidad: number;
  codigo: string | null;
  codTributo: string | null;
  uniMedida: number;
  descripcion: string;
  precioUni: number;                // SIN IVA
  montoDescu: number;
  ventaNoSuj: number;
  ventaExenta: number;
  ventaGravada: number;             // SIN IVA
  tributos: string[] | null;
  psv: number;
  noGravado: number;
}

export interface ItemFSE {
  numItem: number;
  tipoItem: 1 | 2 | 3;
  cantidad: number;
  codigo: string | null;
  uniMedida: number;
  descripcion: string;
  precioUni: number;
  montoDescu: number;
  compra: number;                   // monto comprado al sujeto excluido
}

/* ────────────── Resúmenes ────────────── */

export interface TributoLine {
  codigo: string;                   // CAT-015 (ej. '20' = IVA 13%)
  descripcion: string;
  valor: number;
}

export interface ResumenFCF {
  totalNoSuj: number;
  totalExenta: number;
  totalGravada: number;
  subTotalVentas: number;
  descuNoSuj: number;
  descuExenta: number;
  descuGravada: number;
  porcentajeDescuento: number;
  totalDescu: number;
  tributos: TributoLine[] | null;
  subTotal: number;
  ivaRete1: number;
  reteRenta: number;
  montoTotalOperacion: number;
  totalNoGravado: number;
  totalPagar: number;
  totalLetras: string;
  totalIva: number;
  saldoFavor: number;
  condicionOperacion: CondicionOperacion;
  pagos: PagoEntry[] | null;
  numPagoElectronico: string | null;
}

export interface ResumenCCF {
  totalNoSuj: number;
  totalExenta: number;
  totalGravada: number;
  subTotalVentas: number;
  descuNoSuj: number;
  descuExenta: number;
  descuGravada: number;
  porcentajeDescuento: number;
  totalDescu: number;
  tributos: TributoLine[];          // OBLIGATORIO en CCF (al menos IVA 13%)
  subTotal: number;
  ivaPerci1: number;
  ivaRete1: number;
  reteRenta: number;
  montoTotalOperacion: number;
  totalLetras: string;
  totalNoGravado: number;           // requerido por schema
  totalPagar: number;               // requerido por schema
  saldoFavor: number;
  condicionOperacion: CondicionOperacion;
  pagos: PagoEntry[] | null;
  numPagoElectronico: string | null; // requerido por schema (puede ser null)
}

/**
 * Resumen para Nota de Crédito. El schema NC NO permite estos campos del
 * resumen CCF: `porcentajeDescuento`, `saldoFavor`, `pagos`, `totalNoGravado`,
 * `totalPagar`, `numPagoElectronico`. Estructura mínima: subtotales + IVA +
 * retenciones + total operación.
 */
export interface ResumenNC {
  totalNoSuj: number;
  totalExenta: number;
  totalGravada: number;
  subTotalVentas: number;
  descuNoSuj: number;
  descuExenta: number;
  descuGravada: number;
  totalDescu: number;
  tributos: TributoLine[];
  subTotal: number;
  ivaPerci1: number;
  ivaRete1: number;
  reteRenta: number;
  montoTotalOperacion: number;
  totalLetras: string;
  condicionOperacion: CondicionOperacion;
}

/**
 * Item para Nota de Crédito. El schema NC NO permite `psv` ni `noGravado`
 * en cuerpoDocumento (a diferencia del CCF que sí los acepta).
 */
export type ItemNC = Omit<ItemCCF, 'psv' | 'noGravado'>;

export interface ResumenFSE {
  totalCompra: number;
  descu: number;
  totalDescu: number;
  subTotal: number;
  ivaRete1: number;
  reteRenta: number;
  totalPagar: number;
  totalLetras: string;
  condicionOperacion: CondicionOperacion;
  pagos: PagoEntry[] | null;
  observaciones: string | null;
}

/* ────────────── DTEs completos ────────────── */

export interface DteFCF {
  identificacion: IdentificacionComun & { tipoDte: '01' };
  documentoRelacionado: DocumentoRelacionado[] | null;
  emisor: EmisorComun;
  receptor: ReceptorFCF | null;
  otrosDocumentos: null;
  ventaTercero: null;
  cuerpoDocumento: ItemFCF[];
  resumen: ResumenFCF;
  extension: null;
  apendice: null;
}

export interface DteCCF {
  identificacion: IdentificacionComun & { tipoDte: '03' };
  documentoRelacionado: DocumentoRelacionado[] | null;
  emisor: EmisorComun;
  receptor: ReceptorCCF;
  otrosDocumentos: null;
  ventaTercero: null;
  cuerpoDocumento: ItemCCF[];
  resumen: ResumenCCF;
  extension: null;
  apendice: null;
}

export interface DteNC {
  identificacion: IdentificacionComun & { tipoDte: '05' };
  documentoRelacionado: DocumentoRelacionado[];   // OBLIGATORIO — apunta al CCF original
  emisor: EmisorNc;
  receptor: ReceptorCCF;
  ventaTercero: null;
  cuerpoDocumento: ItemNC[];
  resumen: ResumenNC;
  extension: null;
  apendice: null;
}

export interface DteFSE {
  identificacion: IdentificacionComun & { tipoDte: '14' };
  emisor: EmisorFse;
  sujetoExcluido: ReceptorFSE;
  cuerpoDocumento: ItemFSE[];
  resumen: ResumenFSE;
  apendice: null;
}

export type DteAny = DteFCF | DteCCF | DteNC | DteFSE;

// Re-export de subsets de Emisor — tipos derivados que viven en builders/common
// pero que son parte del shape público de DteNC/DteFSE.
export type EmisorNc = Omit<EmisorComun, 'codEstableMH' | 'codEstable' | 'codPuntoVentaMH' | 'codPuntoVenta'>;
export type EmisorFse = Omit<EmisorComun, 'nombreComercial' | 'tipoEstablecimiento'>;

/* ────────────── Evento de Anulación ────────────── */

export type TipoAnulacion = 1 | 2 | 3;   // 1=error, 2=rescisión, 3=otro

export interface AnulacionEvento {
  identificacion: {
    version: 2;
    ambiente: Ambiente;
    codigoGeneracion: string;        // del evento (NUEVO UUID)
    fecAnula: string;
    horAnula: string;
  };
  emisor: {
    nit: string;
    nombre: string;
    tipoEstablecimiento: string;
    nomEstablecimiento: string | null;
    codEstableMH: string | null;
    codEstable: string | null;
    codPuntoVentaMH: string | null;
    codPuntoVenta: string | null;
    telefono: string | null;
    correo: string;
  };
  documento: {
    tipoDte: TipoDte;
    codigoGeneracion: string;        // del DTE a anular
    selloRecibido: string;
    numeroControl: string;
    fecEmi: string;
    montoIva: number;
    codigoGeneracionR: string | null;  // DTE de reemplazo (opcional)
    tipoDocumento: string;
    numDocumento: string;
    nombre: string;
    telefono: string | null;
    correo: string | null;
  };
  motivo: {
    tipoAnulacion: TipoAnulacion;
    motivoAnulacion: string;
    nombreResponsable: string;
    tipDocResponsable: string;
    numDocResponsable: string;
    nombreSolicita: string;
    tipDocSolicita: string;
    numDocSolicita: string;
  };
}
