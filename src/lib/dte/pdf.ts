import jsPDF from 'jspdf';
import QRCode from 'qrcode';
import { findDepartamento, findMunicipio } from '@/lib/catalogos/mh';

/**
 * Generadores de representación gráfica del DTE:
 *   - downloadDtePdf:    PDF Letter formal, para envío al cliente / archivo
 *   - downloadDteTicket: ticket 80mm para impresora térmica de POS
 *
 * El DTE legalmente es el JSON firmado + sello. El PDF/ticket es sólo la
 * representación visual con QR de consulta pública del MH para verificación.
 */

/* ───────────────────────── Tipos ───────────────────────── */

export interface PdfData {
  tipo: 'fcf' | 'ccf' | 'nc' | 'fse';
  codigoGeneracion: string;
  numeroControl: string;
  selloRecibido: string | null;
  fecha: string;                          // YYYY-MM-DD
  horaEmision?: string;
  ambiente: '00' | '01';                  // 00=test, 01=prod
  anulado: boolean;
  emisor: {
    nombre: string;
    nombreComercial?: string | null;
    nit: string;
    nrc: string;
    actividad: string;
    codActividad?: string;
    direccion: string;
    telefono?: string;
    correo: string;
    departamento?: string;
    municipio?: string;
  };
  receptor: {
    nombre: string;
    nit?: string | null;
    nrc?: string | null;
    dui?: string | null;
    direccion?: string | null;
    actividad?: string | null;
  } | null;
  items: Array<{
    descripcion: string;
    cantidad: number;
    precioUni: number;
    total: number;
  }>;
  totales: {
    subtotal: number;
    iva: number;
    total: number;
    descuento?: number;
    retencionRenta?: number;
  };
  /** Número leído de letras del total — útil para la representación gráfica. */
  totalEnLetras?: string;
}

/**
 * Modo de salida del PDF/ticket:
 *  - 'download' (default): descarga el archivo
 *  - 'print': abre en nueva pestaña con autoPrint → diálogo de impresión inmediato
 */
export interface PdfOutputOpts {
  mode?: 'download' | 'print';
}

/* ───────────────────────── Paleta ───────────────────────── */

const PALETTE = {
  brand:       [31, 78, 121] as const,    // Teal oscuro principal
  brandLight:  [232, 238, 243] as const,  // Fondo de sección
  accent:      [91, 155, 213] as const,
  bgLight:     [249, 251, 252] as const,
  border:      [200, 210, 220] as const,
  textDark:    [44, 62, 80] as const,
  textMuted:   [120, 130, 140] as const,
  success:     [40, 167, 69] as const,
  danger:      [220, 53, 69] as const,
  warning:     [240, 173, 78] as const,
  white:       [255, 255, 255] as const,
};

const TIPO_LABEL: Record<PdfData['tipo'], string> = {
  fcf: 'Factura de Consumidor Final',
  ccf: 'Comprobante de Crédito Fiscal',
  nc:  'Nota de Crédito',
  fse: 'Comprobante de Sujeto Excluido',
};

const TIPO_VERSION: Record<PdfData['tipo'], string> = {
  fcf: 'v1', ccf: 'v3', nc: 'v3', fse: 'v1',
};

/* ───────────────────────── Extracción desde JWS ───────────────────────── */

export function extractPdfData(args: {
  tipo: 'fcf' | 'ccf' | 'nc' | 'fse';
  codigoGeneracion: string;
  numeroControl: string;
  selloRecibido: string | null;
  fecha: string;
  cliente: string;
  total: number;
  documentoJws?: string;
  anulado: boolean;
  ambiente?: '00' | '01';
}): PdfData {
  let parsed: Record<string, unknown> | null = null;
  if (args.documentoJws) {
    const parts = args.documentoJws.split('.');
    if (parts.length === 3 && parts[1]) {
      try {
        // CRÍTICO: el JWS payload es JSON UTF-8 base64url-encoded. atob() da
        // un byte-string donde cada char es 1 byte. Si lo parseamos directo,
        // los chars multi-byte (á, é, í, ó, ú, ñ, ¿) salen rotos en el PDF.
        // Pasamos por TextDecoder('utf-8') para reconstruir el string real.
        const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const decoded = new TextDecoder('utf-8').decode(bytes);
        parsed = JSON.parse(decoded);
      } catch { /* fallback al shape mínimo */ }
    }
  }

  const emisor = (parsed?.emisor as Record<string, unknown> | undefined) ?? {};
  const ident = (parsed?.identificacion as Record<string, unknown> | undefined) ?? {};
  const receptorRaw = (parsed?.receptor as Record<string, unknown> | undefined)
    ?? (parsed?.sujetoExcluido as Record<string, unknown> | undefined);
  const cuerpo = (parsed?.cuerpoDocumento as Array<Record<string, unknown>>) ?? [];
  const resumen = (parsed?.resumen as Record<string, unknown>) ?? {};
  const direccionObj = (emisor.direccion as Record<string, unknown> | undefined) ?? {};

  const emisorData = {
    nombre: String(emisor.nombre ?? 'Emisor'),
    nombreComercial: emisor.nombreComercial as string | null | undefined,
    nit: String(emisor.nit ?? ''),
    nrc: String(emisor.nrc ?? ''),
    actividad: String(emisor.descActividad ?? ''),
    codActividad: emisor.codActividad as string | undefined,
    direccion: String(direccionObj.complemento ?? ''),
    telefono: emisor.telefono as string | undefined,
    correo: String(emisor.correo ?? ''),
    departamento: direccionObj.departamento as string | undefined,
    municipio: direccionObj.municipio as string | undefined,
  };

  let receptor: PdfData['receptor'] = null;
  if (receptorRaw) {
    const dir = (receptorRaw.direccion as Record<string, unknown> | undefined);
    receptor = {
      nombre: String(receptorRaw.nombre ?? args.cliente),
      nit: receptorRaw.nit as string | null | undefined,
      nrc: receptorRaw.nrc as string | null | undefined,
      dui: receptorRaw.numDocumento as string | null | undefined,
      direccion: dir ? String(dir.complemento ?? '') : null,
      actividad: receptorRaw.descActividad as string | null | undefined,
    };
  } else if (args.cliente && args.cliente !== 'Consumidor anónimo') {
    receptor = { nombre: args.cliente };
  }

  const items = cuerpo.length > 0
    ? cuerpo.map(it => ({
      descripcion: String(it.descripcion ?? ''),
      cantidad: Number(it.cantidad ?? 1),
      precioUni: Number(it.precioUni ?? 0),
      total: Number(it.ventaGravada ?? it.compra ?? 0),
    }))
    : [{ descripcion: 'Sin detalle disponible', cantidad: 1, precioUni: args.total, total: args.total }];

  const ivaFromResumen = Number(resumen.totalIva ?? 0);
  const tributos = (resumen.tributos as Array<Record<string, unknown>>) ?? [];
  const ivaFromTributos = tributos
    .filter(t => t.codigo === '20')
    .reduce((s, t) => s + Number(t.valor ?? 0), 0);
  const ivaCalc = ivaFromResumen || ivaFromTributos
    || (args.tipo === 'fcf' ? +(args.total * 0.13 / 1.13).toFixed(2) : 0);

  return {
    tipo: args.tipo,
    codigoGeneracion: args.codigoGeneracion,
    numeroControl: args.numeroControl,
    selloRecibido: args.selloRecibido,
    fecha: args.fecha,
    horaEmision: ident.horEmi as string | undefined,
    ambiente: args.ambiente ?? (String(ident.ambiente ?? '01') as '00' | '01'),
    anulado: args.anulado,
    emisor: emisorData,
    receptor,
    items,
    totales: {
      subtotal: Number(resumen.subTotal ?? (args.total - ivaCalc)),
      iva: ivaCalc,
      total: Number(resumen.totalPagar ?? resumen.montoTotalOperacion ?? args.total),
      descuento: Number(resumen.totalDescu ?? 0) || undefined,
      retencionRenta: Number(resumen.reteRenta ?? 0) || undefined,
    },
    totalEnLetras: resumen.totalLetras as string | undefined,
  };
}

/* ───────────────────────── PDF Carta (formal) ───────────────────────── */

export async function downloadDtePdf(data: PdfData, opts?: PdfOutputOpts): Promise<void> {
  const doc = new jsPDF({ unit: 'mm', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 12;

  const fill = (rgb: readonly [number, number, number]) => doc.setFillColor(rgb[0], rgb[1], rgb[2]);
  const stroke = (rgb: readonly [number, number, number]) => doc.setDrawColor(rgb[0], rgb[1], rgb[2]);
  const text = (rgb: readonly [number, number, number]) => doc.setTextColor(rgb[0], rgb[1], rgb[2]);

  /* ── Watermark ANULADO (primero, queda detrás) ── */
  if (data.anulado) {
    text(PALETTE.danger);
    doc.setFontSize(110);
    doc.setFont('helvetica', 'bold');
    // Fake opacity con un color muy claro
    text([245, 200, 200]);
    doc.text('ANULADO', W / 2, H / 2 + 10, { align: 'center', angle: 30 });
  }

  /* ── HEADER MINIMALISTA, CENTRADO EN LA MARCA DEL EMISOR ──
   * Nada de bloques de color saturados ni cubos "DTE". El documento se siente
   * como una factura real del comercio, no como un template gubernamental. */

  // Badge AMBIENTE PRUEBAS sólo cuando aplica (esquina superior derecha)
  if (data.ambiente === '00') {
    fill(PALETTE.warning);
    doc.roundedRect(W - M - 50, M, 50, 8, 1.5, 1.5, 'F');
    text(PALETTE.white);
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'bold');
    doc.text('AMBIENTE PRUEBAS', W - M - 25, M + 5.3, { align: 'center' });
  }

  // Nombre comercial GRANDE centrado (la marca del emisor)
  text(PALETTE.brand);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(24);
  const brandName = (data.emisor.nombreComercial && data.emisor.nombreComercial.trim())
    || data.emisor.nombre;
  doc.text(brandName, W / 2, 22, { align: 'center' });

  // Razón social pequeña debajo (si es distinta del nombre comercial)
  if (data.emisor.nombreComercial && data.emisor.nombreComercial.trim()
      && data.emisor.nombreComercial !== data.emisor.nombre) {
    text(PALETTE.textMuted);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.text(data.emisor.nombre, W / 2, 28, { align: 'center' });
  }

  // Línea separadora delgada en color brand
  stroke(PALETTE.accent);
  doc.setLineWidth(0.4);
  doc.line(M, 33, W - M, 33);
  doc.setLineWidth(0.2);

  // Tipo de documento centrado
  text(PALETTE.textDark);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(TIPO_LABEL[data.tipo].toUpperCase(), W / 2, 40, { align: 'center' });

  text(PALETTE.textMuted);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text('Documento Tributario Electrónico', W / 2, 45, { align: 'center' });

  text(PALETTE.textDark);
  let y = 53;

  /* ── EMISOR + RECEPTOR en dos columnas ── */
  const colW = (W - 2 * M - 4) / 2;
  const boxH = 40;

  drawBoxedSection(doc, M, y, colW, boxH, 'EMISOR');
  text(PALETTE.textDark);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.text(truncate(data.emisor.nombre, 50), M + 3, y + 12);
  if (data.emisor.nombreComercial && data.emisor.nombreComercial !== data.emisor.nombre) {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'italic');
    text(PALETTE.textMuted);
    doc.text(truncate(data.emisor.nombreComercial, 50), M + 3, y + 16);
  }
  text(PALETTE.textDark);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  let ey = y + 21;
  doc.text(`NIT: ${data.emisor.nit}    NRC: ${data.emisor.nrc}`, M + 3, ey); ey += 3.5;
  const actividadStr = `${data.emisor.codActividad ? data.emisor.codActividad + ' · ' : ''}${data.emisor.actividad}`;
  doc.text(truncate(actividadStr, 60), M + 3, ey); ey += 3.5;
  const ubic = [
    findMunicipio(data.emisor.departamento ?? '', data.emisor.municipio ?? '')?.nombre,
    findDepartamento(data.emisor.departamento ?? '')?.nombre,
  ].filter(Boolean).join(', ');
  doc.text(truncate(data.emisor.direccion, 60), M + 3, ey); ey += 3.5;
  if (ubic) { doc.text(ubic, M + 3, ey); ey += 3.5; }
  if (data.emisor.telefono) {
    doc.text(`Tel: ${data.emisor.telefono}    ${data.emisor.correo}`, M + 3, ey);
  } else {
    doc.text(data.emisor.correo, M + 3, ey);
  }

  const rx = M + colW + 4;
  drawBoxedSection(doc, rx, y, colW, boxH, 'RECEPTOR');
  text(PALETTE.textDark);
  if (data.receptor) {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.text(truncate(data.receptor.nombre, 50), rx + 3, y + 12);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    let ry = y + 17;
    const ids = [
      data.receptor.nit && `NIT: ${data.receptor.nit}`,
      data.receptor.nrc && `NRC: ${data.receptor.nrc}`,
      data.receptor.dui && `DUI: ${data.receptor.dui}`,
    ].filter(Boolean).join('    ');
    if (ids) { doc.text(ids, rx + 3, ry); ry += 3.5; }
    if (data.receptor.actividad) { doc.text(truncate(data.receptor.actividad, 60), rx + 3, ry); ry += 3.5; }
    if (data.receptor.direccion) doc.text(truncate(data.receptor.direccion, 60), rx + 3, ry);
  } else {
    text(PALETTE.textMuted);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'italic');
    doc.text('Consumidor anónimo', rx + 3, y + 14);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.text('Sin datos de identificación', rx + 3, y + 19);
  }

  y += boxH + 5;

  /* ── DATOS DEL DOCUMENTO ──
   * 2 columnas para metadata corta (fecha, núm. control, tipo) y una fila
   * full-width para el sello (es largo). Sin "Estado" — el watermark
   * "ANULADO" ya señala el estado cuando aplica. */
  text(PALETTE.textDark);
  fill(PALETTE.bgLight);
  stroke(PALETTE.border);
  doc.roundedRect(M, y, W - 2 * M, 26, 2, 2, 'FD');

  const halfW = (W - 2 * M) / 2;

  // Labels
  doc.setFontSize(6.5);
  doc.setFont('helvetica', 'bold');
  text(PALETTE.textMuted);
  doc.text('FECHA Y HORA DE EMISIÓN', M + 3, y + 4);
  doc.text('CÓDIGO DE GENERACIÓN', M + 3, y + 11);

  doc.text('NÚMERO DE CONTROL', M + halfW + 3, y + 4);
  doc.text('TIPO DE DOCUMENTO', M + halfW + 3, y + 11);

  doc.text('SELLO DE RECEPCIÓN — MINISTERIO DE HACIENDA', M + 3, y + 18);

  // Values
  text(PALETTE.textDark);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  const fechaHora = `${displayDate(data.fecha)}${data.horaEmision ? '  ' + data.horaEmision : ''}`;
  doc.text(fechaHora, M + 3, y + 7.5);

  doc.setFont('courier', 'normal');
  doc.setFontSize(7.5);
  doc.text(data.codigoGeneracion, M + 3, y + 14.5);

  doc.text(data.numeroControl, M + halfW + 3, y + 7.5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(`${TIPO_LABEL[data.tipo]} · ${data.tipo.toUpperCase()} ${TIPO_VERSION[data.tipo]}`, M + halfW + 3, y + 14.5);

  // Sello full-width, mono pequeño
  doc.setFont('courier', 'normal');
  doc.setFontSize(7);
  doc.text(data.selloRecibido ?? '— sin sello —', M + 3, y + 22);

  text(PALETTE.textDark);
  y += 32;

  /* ── DETALLE ── */
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('DETALLE', M, y);
  y += 4;

  const tableTop = y;

  fill(PALETTE.brand);
  doc.rect(M, y, W - 2 * M, 8, 'F');
  text(PALETTE.white);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text('#', M + 3, y + 5.5);
  doc.text('DESCRIPCIÓN', M + 12, y + 5.5);
  doc.text('CANT.', W - M - 62, y + 5.5);
  doc.text('PRECIO UNIT.', W - M - 30, y + 5.5, { align: 'right' });
  doc.text('TOTAL', W - M - 3, y + 5.5, { align: 'right' });
  y += 8;

  text(PALETTE.textDark);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);

  data.items.forEach((item, idx) => {
    if (y > H - 80) {
      doc.addPage();
      y = M;
    }
    if (idx % 2 === 1) {
      fill(PALETTE.bgLight);
      doc.rect(M, y, W - 2 * M, 6.5, 'F');
    }
    doc.text(String(idx + 1), M + 3, y + 4.5);
    doc.text(truncate(item.descripcion, 65), M + 12, y + 4.5);
    doc.text(formatQty(item.cantidad), W - M - 62, y + 4.5);
    doc.text(`$${item.precioUni.toFixed(2)}`, W - M - 30, y + 4.5, { align: 'right' });
    doc.setFont('helvetica', 'bold');
    doc.text(`$${item.total.toFixed(2)}`, W - M - 3, y + 4.5, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    y += 6.5;
  });

  stroke(PALETTE.border);
  doc.rect(M, tableTop, W - 2 * M, y - tableTop, 'S');
  y += 6;

  /* ── TOTALES ── */
  const tx = W - M - 82;
  const tw = 82;

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  text(PALETTE.textDark);

  if (data.tipo === 'fcf') {
    drawTotalRow(doc, tx, y, tw, 'Subtotal (sin IVA)', `$${data.totales.subtotal.toFixed(2)}`);
    y += 5;
    drawTotalRow(doc, tx, y, tw, 'IVA 13% (implícito)', `$${data.totales.iva.toFixed(2)}`);
    y += 5;
  } else if (data.tipo === 'ccf' || data.tipo === 'nc') {
    drawTotalRow(doc, tx, y, tw, 'Subtotal', `$${data.totales.subtotal.toFixed(2)}`);
    y += 5;
    drawTotalRow(doc, tx, y, tw, 'IVA 13%', `$${data.totales.iva.toFixed(2)}`);
    y += 5;
  }
  if (data.totales.descuento && data.totales.descuento > 0) {
    drawTotalRow(doc, tx, y, tw, 'Descuento', `-$${data.totales.descuento.toFixed(2)}`, PALETTE.danger);
    y += 5;
  }
  if (data.totales.retencionRenta && data.totales.retencionRenta > 0) {
    drawTotalRow(doc, tx, y, tw, 'Retención Renta', `-$${data.totales.retencionRenta.toFixed(2)}`, PALETTE.danger);
    y += 5;
  }
  y += 2;

  fill(PALETTE.brand);
  doc.roundedRect(tx, y, tw, 12, 2, 2, 'F');
  text(PALETTE.white);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('TOTAL', tx + 5, y + 8);
  doc.setFontSize(14);
  doc.text(`$${data.totales.total.toFixed(2)}`, tx + tw - 4, y + 8, { align: 'right' });
  y += 14;

  if (data.totalEnLetras) {
    text(PALETTE.textMuted);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'italic');
    doc.text(`Son: ${data.totalEnLetras}`, tx + tw - 1, y, { align: 'right', maxWidth: tw });
    y += 4;
  }

  y += 4;

  /* ── QR + VERIFICACIÓN ── */
  const qrUrl = buildConsultaUrl(data);
  const qrDataUrl = await QRCode.toDataURL(qrUrl, { width: 300, margin: 0 });

  fill(PALETTE.brandLight);
  stroke(PALETTE.border);
  doc.roundedRect(M, y, W - 2 * M, 36, 2, 2, 'FD');

  doc.addImage(qrDataUrl, 'PNG', M + 4, y + 4, 28, 28);

  text(PALETTE.brand);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('VERIFICACIÓN OFICIAL — MINISTERIO DE HACIENDA', M + 36, y + 9);

  text(PALETTE.textDark);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.text('Escanea el QR o ingresa a:', M + 36, y + 15);
  doc.setFont('helvetica', 'bold');
  text([0, 80, 180]);
  doc.text('admin.factura.gob.sv/consultaPublica', M + 36, y + 20);

  text(PALETTE.textMuted);
  doc.setFontSize(6.5);
  doc.setFont('helvetica', 'normal');
  doc.text(truncate(qrUrl, 110), M + 36, y + 25);
  doc.text('El cliente puede confirmar autenticidad y vigencia directamente con el MH.', M + 36, y + 30);

  y += 40;

  /* ── FOOTER ── */
  stroke(PALETTE.border);
  doc.line(M, H - 16, W - M, H - 16);

  text(PALETTE.textMuted);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'italic');
  doc.text(
    'Esta es una representación gráfica del Documento Tributario Electrónico (DTE).',
    W / 2, H - 11, { align: 'center' },
  );
  doc.setFont('helvetica', 'normal');
  doc.text(
    `Generado: ${new Date().toLocaleString('es-SV')} · Conserve este documento.`,
    W / 2, H - 7, { align: 'center' },
  );

  const filename = `${data.tipo.toUpperCase()}_${data.numeroControl}.pdf`;
  outputDoc(doc, filename, opts);
}

/* ───────────────────────── Ticket 80mm (térmico) ───────────────────────── */

export async function downloadDteTicket(data: PdfData, opts?: PdfOutputOpts): Promise<void> {
  const W = 80;  // 80mm = ancho estándar térmico
  // Altura larga; la térmica corta cuando termina el contenido. 200mm cabe
  // sobradamente para tickets típicos (hasta ~30 líneas de items).
  const doc = new jsPDF({ unit: 'mm', format: [W, 200], orientation: 'portrait' });
  const M = 3;
  let y = 5;

  const fill = (rgb: readonly [number, number, number]) => doc.setFillColor(rgb[0], rgb[1], rgb[2]);
  const text = (rgb: readonly [number, number, number]) => doc.setTextColor(rgb[0], rgb[1], rgb[2]);

  /* Header — nombre COMERCIAL grande arriba (lo que predomina), razón social
     pequeña debajo. Si no hay nombre comercial, sólo razón social. */
  text(PALETTE.textDark);
  doc.setFont('helvetica', 'bold');

  const hasComercial = !!(data.emisor.nombreComercial
    && data.emisor.nombreComercial.trim()
    && data.emisor.nombreComercial !== data.emisor.nombre);

  if (hasComercial) {
    doc.setFontSize(14);
    const comLines = doc.splitTextToSize(data.emisor.nombreComercial!.toUpperCase(), W - 2 * M);
    for (const line of comLines) {
      doc.text(line, W / 2, y, { align: 'center' });
      y += 5.5;
    }
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    text(PALETTE.textMuted);
    const rsLines = doc.splitTextToSize(data.emisor.nombre, W - 2 * M);
    for (const line of rsLines) {
      doc.text(line, W / 2, y, { align: 'center' });
      y += 3;
    }
    text(PALETTE.textDark);
  } else {
    doc.setFontSize(11);
    const nameLines = doc.splitTextToSize(data.emisor.nombre.toUpperCase(), W - 2 * M);
    for (const line of nameLines) {
      doc.text(line, W / 2, y, { align: 'center' });
      y += 4.5;
    }
  }

  y += 1;
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.text(`NIT ${data.emisor.nit}   NRC ${data.emisor.nrc}`, W / 2, y, { align: 'center' }); y += 3;

  const dirLines = doc.splitTextToSize(data.emisor.direccion, W - 2 * M);
  for (const line of dirLines.slice(0, 2)) {
    doc.text(line, W / 2, y, { align: 'center' });
    y += 3;
  }
  if (data.emisor.telefono) {
    doc.text(`Tel ${data.emisor.telefono}`, W / 2, y, { align: 'center' });
    y += 3;
  }

  y += 1;
  drawDashed(doc, M, y, W - M); y += 3;

  /* Tipo DTE + ambiente */
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  text(PALETTE.brand);
  doc.text(TIPO_LABEL[data.tipo].toUpperCase(), W / 2, y, { align: 'center' });
  y += 4;

  if (data.ambiente === '00') {
    text(PALETTE.warning);
    doc.setFontSize(7);
    doc.text('AMBIENTE PRUEBAS — SIN VALOR FISCAL', W / 2, y, { align: 'center' });
    y += 3.5;
  }

  text(PALETTE.textDark);
  doc.setFont('courier', 'normal');
  doc.setFontSize(7);
  doc.text(data.numeroControl, W / 2, y, { align: 'center' });
  y += 3;
  const fechaHora = `${displayDate(data.fecha)}${data.horaEmision ? '  ' + data.horaEmision : ''}`;
  doc.setFont('helvetica', 'normal');
  doc.text(fechaHora, W / 2, y, { align: 'center' });
  y += 4;

  /* Cliente */
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  if (data.receptor) {
    text(PALETTE.textMuted);
    doc.text('Cliente:', M, y);
    text(PALETTE.textDark);
    doc.setFont('helvetica', 'bold');
    doc.text(truncate(data.receptor.nombre, 28), M + 11, y);
    y += 3.5;
    doc.setFont('helvetica', 'normal');
    const ids = [
      data.receptor.nit && `NIT ${data.receptor.nit}`,
      data.receptor.dui && `DUI ${data.receptor.dui}`,
    ].filter(Boolean).join('  ');
    if (ids) {
      text(PALETTE.textMuted);
      doc.text(ids, M, y);
      y += 3.5;
    }
  } else {
    text(PALETTE.textMuted);
    doc.setFont('helvetica', 'italic');
    doc.text('Consumidor anónimo', W / 2, y, { align: 'center' });
    y += 3.5;
  }

  drawDashed(doc, M, y, W - M); y += 3;

  /* Items */
  text(PALETTE.textDark);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);

  for (const item of data.items) {
    const descLines = doc.splitTextToSize(item.descripcion, W - 2 * M - 18);
    doc.setFont('helvetica', 'bold');
    doc.text(descLines[0] ?? '', M, y);
    doc.setFont('helvetica', 'normal');
    doc.text(`$${item.total.toFixed(2)}`, W - M, y, { align: 'right' });
    y += 3;
    for (const line of descLines.slice(1)) {
      doc.text(line, M, y); y += 3;
    }
    // qty x precio
    text(PALETTE.textMuted);
    doc.setFontSize(6.5);
    doc.text(`${formatQty(item.cantidad)} x $${item.precioUni.toFixed(2)}`, M, y);
    text(PALETTE.textDark);
    doc.setFontSize(7.5);
    y += 3;
  }

  drawDashed(doc, M, y, W - M); y += 3;

  /* Totales */
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  if (data.tipo === 'fcf') {
    drawTicketLine(doc, M, y, W - M, 'Subtotal sin IVA', `$${data.totales.subtotal.toFixed(2)}`);
    y += 3.5;
    drawTicketLine(doc, M, y, W - M, 'IVA 13% implícito', `$${data.totales.iva.toFixed(2)}`);
    y += 3.5;
  } else if (data.tipo === 'ccf' || data.tipo === 'nc') {
    drawTicketLine(doc, M, y, W - M, 'Subtotal', `$${data.totales.subtotal.toFixed(2)}`);
    y += 3.5;
    drawTicketLine(doc, M, y, W - M, 'IVA 13%', `$${data.totales.iva.toFixed(2)}`);
    y += 3.5;
  }
  if (data.totales.descuento && data.totales.descuento > 0) {
    text(PALETTE.danger);
    drawTicketLine(doc, M, y, W - M, 'Descuento', `-$${data.totales.descuento.toFixed(2)}`);
    text(PALETTE.textDark);
    y += 3.5;
  }
  if (data.totales.retencionRenta && data.totales.retencionRenta > 0) {
    text(PALETTE.danger);
    drawTicketLine(doc, M, y, W - M, 'Retención Renta', `-$${data.totales.retencionRenta.toFixed(2)}`);
    text(PALETTE.textDark);
    y += 3.5;
  }
  y += 1;

  /* TOTAL — destacado */
  fill(PALETTE.brand);
  doc.rect(M, y, W - 2 * M, 7, 'F');
  text(PALETTE.white);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('TOTAL', M + 2, y + 5);
  doc.text(`$${data.totales.total.toFixed(2)}`, W - M - 2, y + 5, { align: 'right' });
  y += 9;

  text(PALETTE.textDark);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6);
  doc.text('Sello recibido (MH):', M, y); y += 2.5;
  doc.setFont('courier', 'normal');
  doc.setFontSize(5.5);
  const selloLines = doc.splitTextToSize(data.selloRecibido ?? '— sin sello —', W - 2 * M);
  for (const line of selloLines) {
    doc.text(line, M, y);
    y += 2.5;
  }
  y += 2;

  /* QR */
  const qrUrl = buildConsultaUrl(data);
  const qrDataUrl = await QRCode.toDataURL(qrUrl, { width: 200, margin: 0 });
  const qrSize = 28;
  doc.addImage(qrDataUrl, 'PNG', (W - qrSize) / 2, y, qrSize, qrSize);
  y += qrSize + 2;

  doc.setFont('helvetica', 'italic');
  doc.setFontSize(6.5);
  text(PALETTE.textMuted);
  doc.text('Verifique escaneando el QR', W / 2, y, { align: 'center' }); y += 3;
  doc.text('o en admin.factura.gob.sv', W / 2, y, { align: 'center' }); y += 4;

  /* Anulado watermark */
  if (data.anulado) {
    text([245, 200, 200]);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(28);
    doc.text('ANULADO', W / 2, 100, { align: 'center', angle: 30 });
    text(PALETTE.textDark);
  }

  /* Footer */
  text(PALETTE.textDark);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.text('¡Gracias por su preferencia!', W / 2, y, { align: 'center' }); y += 3;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6);
  text(PALETTE.textMuted);
  doc.text('Representación gráfica del DTE', W / 2, y, { align: 'center' }); y += 2.5;
  doc.text(`Generado ${new Date().toLocaleString('es-SV')}`, W / 2, y, { align: 'center' });

  const filename = `TICKET_${data.tipo.toUpperCase()}_${data.numeroControl}.pdf`;
  outputDoc(doc, filename, opts);
}

/** Salida: descarga, o abre con autoPrint en otra pestaña. */
function outputDoc(doc: jsPDF, filename: string, opts?: PdfOutputOpts): void {
  if (opts?.mode === 'print') {
    doc.autoPrint();
    const blobUrl = doc.output('bloburl') as unknown as string;
    window.open(blobUrl, '_blank');
  } else {
    doc.save(filename);
  }
}

/* ───────────────────────── Helpers ───────────────────────── */

function drawBoxedSection(
  doc: jsPDF, x: number, y: number, w: number, h: number, title: string,
) {
  doc.setFillColor(PALETTE.bgLight[0], PALETTE.bgLight[1], PALETTE.bgLight[2]);
  doc.setDrawColor(PALETTE.border[0], PALETTE.border[1], PALETTE.border[2]);
  doc.roundedRect(x, y, w, h, 2, 2, 'FD');
  doc.setFillColor(PALETTE.brand[0], PALETTE.brand[1], PALETTE.brand[2]);
  doc.rect(x, y, w, 6, 'F');
  doc.setTextColor(PALETTE.white[0], PALETTE.white[1], PALETTE.white[2]);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text(title, x + 3, y + 4.3);
}

function drawTotalRow(
  doc: jsPDF, x: number, y: number, w: number, label: string, value: string,
  valueColor?: readonly [number, number, number],
) {
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(PALETTE.textDark[0], PALETTE.textDark[1], PALETTE.textDark[2]);
  doc.text(label, x + 4, y);
  if (valueColor) doc.setTextColor(valueColor[0], valueColor[1], valueColor[2]);
  doc.text(value, x + w - 4, y, { align: 'right' });
  doc.setTextColor(PALETTE.textDark[0], PALETTE.textDark[1], PALETTE.textDark[2]);
}

function drawTicketLine(
  doc: jsPDF, x1: number, y: number, x2: number, label: string, value: string,
) {
  doc.text(label, x1, y);
  doc.text(value, x2, y, { align: 'right' });
}

function drawDashed(doc: jsPDF, x1: number, y: number, x2: number): void {
  // jsPDF v2 expone setLineDashPattern; v1 expone setLineDash. Tipos no
  // siempre lo declaran. Cast a unknown para evitar la dependencia de versión.
  const d = doc as unknown as { setLineDashPattern?: (p: number[], phase: number) => void; setLineDash?: (p: number[]) => void };
  doc.setDrawColor(PALETTE.border[0], PALETTE.border[1], PALETTE.border[2]);
  d.setLineDashPattern?.([1, 1], 0);
  d.setLineDash?.([1, 1]);
  doc.line(x1, y, x2, y);
  d.setLineDashPattern?.([], 0);
  d.setLineDash?.([]);
}

function buildConsultaUrl(d: PdfData): string {
  return `https://admin.factura.gob.sv/consultaPublica?ambiente=${d.ambiente}&codGen=${d.codigoGeneracion}&fechaEmi=${d.fecha}`;
}

function displayDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function formatQty(n: number): string {
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}
