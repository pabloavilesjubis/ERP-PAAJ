export type ContribuyenteTipo = 'Cliente' | 'Proveedor' | 'Ambos';

export interface Contribuyente {
  id: string;
  nombre: string;
  nit: string;
  /** DUI — alternativo al NIT cuando es persona natural reportada por DUI (F-14). */
  dui?: string;
  nrc: string;
  giro?: string;
  telefono?: string;
  email?: string;
  /** Dirección — texto libre / complemento (calle, colonia, número). */
  direccion?: string;
  /** CAT-012 — código de departamento (2 dígitos). Para emisión DTE. */
  departamento?: string;
  /** CAT-013 — código de municipio (2 dígitos), único dentro del departamento. */
  municipio?: string;
  /** CAT-019 — código de actividad económica (CIIU rev. 4). */
  codActividad?: string;
  tipo: ContribuyenteTipo;
}

export interface VentaConsumidorMetadata {
  orden?: string;
  numeroControl?: string;
  codigoGeneracion?: string;
  selloRecibido?: string;
  hora?: string;
  autorizadoPor?: string;
  cliente?: string;
  tipoDocumento?: string;
  numeroDocumento?: string;
  subtotal?: string;
  iva?: string;
  source?: 'pos' | 'manual';
}

export interface VentaConsumidor {
  id: string;
  fecha: string;
  descripcion: string;
  monto: string;
  notas?: string;
  metadata?: VentaConsumidorMetadata;
}

export interface VentaContribuyenteMetadata {
  claseDocumento?: ClaseDocumento;
  tipoDocumento?: string;        // '03' = CCF (típico), '11' = exportación
  numeroDocumento?: string;      // Cód. Generación (DTE) o correlativo
  numeroControl?: string;        // DTE-03-... opcional
  selloRecibido?: string;
  nit?: string;                  // del cliente
  /**
   * Monto retenido en concepto de Renta (ISR) por el cliente cuando es Sujeto
   * de Retención. Típicamente 10% del gravado para servicios profesionales o
   * contratos con grandes contribuyentes. Si > 0, esta venta NO entra en la
   * base del Pago a Cuenta del 1.75% — porque ya pagó ISR vía la retención.
   */
  retencionRenta?: string;
  source?: 'manual' | 'imported';
  pdfPath?: string;              // si más adelante se adjunta PDF
  pdfFilename?: string;
}

export interface VentaContribuyente {
  id: string;
  fecha: string;
  cliente: string;
  nrc: string;
  descripcion: string;
  gravado: string;
  exento: string;
  notas?: string;
  metadata?: VentaContribuyenteMetadata;
}

/** Clase de documento según F-930 del MH:
 *   1 = Impreso por imprenta o tiquete
 *   2 = Formulario único
 *   3 = Otros
 *   4 = Documento Tributario Electrónico (DTE)
 */
export type ClaseDocumento = '1' | '2' | '3' | '4';

/** Tipo de documento (códigos del MH): 03=CCF, 14=Sujeto Excluido, etc. */
export interface CompraMetadata {
  claseDocumento?: ClaseDocumento;
  tipoDocumento?: string;        // '03', '14', '05', etc.
  numeroDocumento?: string;      // Cód. Generación (DTE) o correlativo (impreso)
  numeroControl?: string;        // DTE-03-... opcional
  selloRecibido?: string;        // opcional para DTE
  // Campos de clasificación contable (defaults configurables):
  tipoOperacion?: string;        // '1' = Local
  clasificacion?: string;        // '1'=Costo, '2'=Gasto
  sector?: string;               // '1'=Industria, '2'=Comercio, '3'=Servicio
  tipoCostoGasto?: string;       // libre
  numeroAnexo?: string;          // libre
  /** NIT del proveedor — necesario para el F-14 (ISR usa NIT, no NRC). */
  nit?: string;
  /** DUI del proveedor (alternativo al NIT para personas naturales). */
  dui?: string;
  /** Para F-14: tipo de persona del proveedor — afecta el código MH y el subtipo. */
  tipoPersona?: 'natural' | 'juridica';
  /**
   * Código de retención del MH (campo 2 del F-14). Default 9300 para natural,
   * 9450 para jurídica. Otros códigos posibles: 9438, 9642, 9705 (servicios
   * marítimos, etc.).
   */
  retencionCodigoMH?: string;
  /**
   * Monto retenido en concepto de Renta (ISR) cuando NOSOTROS somos Sujeto de
   * Retención y le retuvimos 10% al proveedor (servicios profesionales,
   * contratos, etc.). Esto va al F-14 mensual.
   */
  retencionRenta?: string;
  /**
   * Tipo de operación del F-14 (campo 6): "01" empleados · "11" servicios
   * profesionales · "36" servicios del exterior · "60" empleados sin ISR.
   * Default "11" para CCF de servicios.
   */
  retencionConcepto?: string;
  /**
   * Código de ingreso del F-14 (campo 22). Validado por el portal contra la
   * clase de contribuyente. Valores típicos:
   *   "2" → Natural común (empleados, servicios profesionales)
   *   "4" → Jurídica (servicios del exterior)
   *   "5" → Casos especiales / honorarios eventuales
   *   "1" → Eventual
   */
  retencionCodigoIngreso?: string;
  /**
   * AFP retenida al empleado (campo 12 del F-14). Aplica solo cuando el
   * tipo de operación (retencionConcepto) es "01" o "60" (planilla).
   * Default sugerido: 7.25% × salario base.
   */
  afpRetenido?: string;
  /**
   * ISSS retenido al empleado (campo 13 del F-14). Aplica solo cuando
   * retencionConcepto es "01" o "60". Default sugerido: 3% × salario,
   * con tope de $30 (sobre techo cotizable de $1000).
   */
  isssRetenido?: string;
  source?: 'manual' | 'imported';
  // Archivo PDF adjunto (Supabase Storage):
  pdfPath?: string;              // path relativo dentro del bucket "compras-pdfs"
  pdfFilename?: string;          // nombre original del archivo para mostrar
}

export interface Compra {
  id: string;
  fecha: string;
  proveedor: string;
  nrc: string;
  descripcion: string;
  monto: string;
  ivaCredito: string;
  notas?: string;
  metadata?: CompraMetadata;
}

/* ──────────────────────── Productos / catálogo POS ──────────────────────── */

export type ProductoTipo = 'bien' | 'servicio';

export interface Producto {
  id: string;
  codigo?: string;             // SKU interno opcional
  nombre: string;
  descripcion?: string;
  tipo: ProductoTipo;
  /** Precio unitario por defecto, SIN IVA. El cálculo final depende del DTE
   *  (FCF lo presenta con IVA incluido; CCF separa el IVA). */
  precioUnitario: string;
  /** Unidad de medida según CAT-014 del MH (ej. 59 = "Unidad"). */
  uniMedida: number;
  /** Código de actividad económica del MH (ej. 47711). Si está vacío usa
   *  el del emisor — útil cuando un mismo emisor vende productos de actividades
   *  distintas. */
  codActividad?: string;
  activo: boolean;
}

export type ReporteTipo =
  | 'anexo_consumidor_final'
  | 'anexo_compras'
  | 'anexo_ventas_contribuyente'
  | 'f14_retenciones';

export interface ReporteGenerado {
  id: string;
  tipo: ReporteTipo;
  periodoYear: number;
  periodoMonth: number;          // 1-12
  filename: string;
  csvContent: string;
  rowCount: number;
  totalAmount: string;
  generatedAt: string;           // ISO timestamp
}

export interface AppData {
  ventasConsumidor: VentaConsumidor[];
  ventasContribuyente: VentaContribuyente[];
  compras: Compra[];
  contribuyentes: Contribuyente[];
  productos: Producto[];
  reportesGenerados: ReporteGenerado[];
}

export type AppCollection = keyof AppData;
