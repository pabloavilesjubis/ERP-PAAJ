import { z } from 'zod';

/**
 * Contrato BEON → PAAJ. Payload SIMPLIFICADO de venta — PAAJ se encarga de
 * armar el JSON oficial del MH, firmar, transmitir y generar PDF/ticket/JSON.
 *
 * Los campos opcionales que BEON puede omitir se rellenan desde la configuración
 * del emisor (PAAJ ya conoce su propio NIT/NRC, dirección, etc.).
 *
 * Para CCF/NC el bloque `cliente` es obligatorio. Para FCF puede omitirse
 * (consumidor anónimo).
 */

export const BeonDireccion = z.object({
  departamento: z.string().length(2).optional().nullable(),
  municipio: z.string().length(2).optional().nullable(),
  complemento: z.string().optional().nullable(),
}).partial();

export const BeonCliente = z.object({
  erp_customer_id: z.string().optional().nullable(),
  beon_customer_id: z.string().optional().nullable(),
  tipo_documento: z.string().optional().nullable(),    // '13'=DUI, '36'=NIT, '37'=otro
  num_documento: z.string().optional().nullable(),
  nit: z.string().optional().nullable(),               // alias para CCF (mismo que num_documento con tipo 36)
  nrc: z.string().optional().nullable(),
  nombre: z.string().min(1),
  nombre_comercial: z.string().optional().nullable(),
  cod_actividad: z.string().optional().nullable(),
  desc_actividad: z.string().optional().nullable(),
  direccion: BeonDireccion.optional().nullable(),
  telefono: z.string().optional().nullable(),
  correo: z.string().email().optional().nullable(),
});

export const BeonItem = z.object({
  descripcion: z.string().min(1),
  cantidad: z.number().positive(),
  precio_unitario: z.number().nonnegative(),
  descuento: z.number().nonnegative().optional().default(0),
  tipo_item: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional().default(2),
  unidad_medida: z.number().int().positive().optional().default(59),  // 59 = otra unidad CAT-014
  codigo: z.string().optional().nullable(),
  no_gravado: z.number().nonnegative().optional().default(0),
  exento: z.number().nonnegative().optional().default(0),
});

export const BeonPago = z.object({
  codigo: z.string().min(1),                            // CAT-017 (01=billetes y monedas, 02=tarjeta débito, etc.)
  monto: z.number().nonnegative(),
  referencia: z.string().optional().nullable(),
  plazo: z.string().optional().nullable(),
  periodo: z.number().int().optional().nullable(),
});

export const BeonDocumentoRelacionado = z.object({
  tipo_documento: z.string().min(2),
  tipo_generacion: z.union([z.literal(1), z.literal(2)]).default(2),
  numero_documento: z.string().min(1),                  // codigoGeneracion del DTE original
  fecha_emision: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const BeonEmitirRequest = z.object({
  beon_sale_id: z.string().min(1).optional().nullable(),
  tenant_id: z.string().optional().nullable(),
  tipo_dte: z.enum(['01', '03', '05', '14']),
  // OPCIONAL. dte-service reserva atómicamente desde su storage de correlativos
  // (SoT único). Si el caller lo manda, se usa pero VALIDA contra el último
  // consumido — si es ≤ ultimo_consumido se rechaza para prevenir colisiones.
  // Lo normal es no mandarlo y dejar que dte-service reserve.
  consecutivo: z.number().int().positive().optional(),
  fecha_emision: z.string().optional(),                 // ISO8601 — si no, ahora
  condicion_operacion: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().default(1),
  cliente: BeonCliente.optional().nullable(),
  items: z.array(BeonItem).min(1),
  pagos: z.array(BeonPago).optional().nullable(),
  documento_relacionado: z.array(BeonDocumentoRelacionado).optional().nullable(),
  iva_perci1: z.number().nonnegative().optional(),
  iva_rete1: z.number().nonnegative().optional(),
  rete_renta: z.number().nonnegative().optional(),
  notas: z.string().optional().nullable(),
  /** Nombre del vendedor/cajero que originó la venta — para reportes ERP. */
  vendedor_nombre: z.string().min(1).optional().nullable(),
});

export type BeonEmitirRequest = z.infer<typeof BeonEmitirRequest>;
export type BeonItemT = z.infer<typeof BeonItem>;
export type BeonClienteT = z.infer<typeof BeonCliente>;

export const BeonAnularRequest = z.object({
  beon_sale_id: z.string().optional().nullable(),
  erp_invoice_id: z.string().optional().nullable(),
  tipo_anulacion: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  motivo: z.string().min(5),
  // `responsable` y `solicita` son opcionales en el contrato BEON. Si no
  // vienen, /dte/anular usa el emisor configurado como default (MH_NIT +
  // EMISOR_NOMBRE con tipo_documento='36'). Esto cubre el caso típico PAAJ:
  // contribuyente único que opera y solicita sus propias anulaciones.
  responsable: z.object({
    nombre: z.string().min(1),
    tipo_documento: z.string().min(1),
    num_documento: z.string().min(1),
  }).optional().nullable(),
  solicita: z.object({
    nombre: z.string().min(1),
    tipo_documento: z.string().min(1),
    num_documento: z.string().min(1),
  }).optional().nullable(),
  codigo_generacion_reemplazo: z.string().optional().nullable(),
}).refine(v => !!(v.beon_sale_id || v.erp_invoice_id), {
  message: 'Debe proporcionar beon_sale_id o erp_invoice_id',
});

export type BeonAnularRequest = z.infer<typeof BeonAnularRequest>;

export const BeonReenviarCorreoRequest = z.object({
  beon_sale_id: z.string().optional().nullable(),
  erp_invoice_id: z.string().optional().nullable(),
  destinatario: z.string().email().optional().nullable(),  // si se omite, usa el receptor del DTE
}).refine(v => !!(v.beon_sale_id || v.erp_invoice_id), {
  message: 'Debe proporcionar beon_sale_id o erp_invoice_id',
});

export type BeonReenviarCorreoRequest = z.infer<typeof BeonReenviarCorreoRequest>;

export const BeonClienteSyncRequest = BeonCliente.extend({
  // Acepta `nit` como alias top-level; el mapper resuelve.
});

export interface CanonicalResponse {
  success: boolean;
  erp_invoice_id: string;
  beon_sale_id: string | null;
  tipo_dte: '01' | '03' | '05' | '14';
  estado: 'EMITIDO' | 'RECHAZADO' | 'ANULADO';
  codigo_generacion: string;
  numero_control: string;
  sello_recibido: string | null;
  fh_procesamiento: string | null;
  pdf_url: string | null;
  json_url: string | null;
  ticket_url: string | null;
  qr_url: string;
}
