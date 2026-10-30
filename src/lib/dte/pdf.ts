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
    nombreComercial?: string | null;
    nit?: string | null;
    nrc?: string | null;
    dui?: string | null;
    /** Tipo de documento del MH (13 DUI, 36 NIT, 37 otro…) cuando viene numDocumento. */
    tipoDocumento?: string | null;
    direccion?: string | null;
    actividad?: string | null;
    correo?: string | null;
    telefono?: string | null;
  } | null;
  items: Array<{
    descripcion: string;
    cantidad: number;
    precioUni: number;
    total: number;
    /** Código de unidad de medida CAT-014 (59 = unidad). */
    uniMedida?: number;
    descuento?: number;
  }>;
  totales: {
    subtotal: number;
    iva: number;
    total: number;
    descuento?: number;
    retencionRenta?: number;
    /** IVA retenido 1% por el cliente (gran contribuyente). */
    retencionIva?: number;
  };
  /** 1 contado, 2 crédito, 3 otro (CAT-016). */
  condicionOperacion?: number;
  /** 1 previo, 2 diferido. */
  tipoModelo?: number;
  /** 1 transmisión normal, 2 contingencia. */
  tipoOperacion?: number;
  observaciones?: string | null;
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
      nombreComercial: receptorRaw.nombreComercial as string | null | undefined,
      nit: receptorRaw.nit as string | null | undefined,
      nrc: receptorRaw.nrc as string | null | undefined,
      dui: receptorRaw.numDocumento as string | null | undefined,
      tipoDocumento: receptorRaw.tipoDocumento as string | null | undefined,
      direccion: dir ? [dir.complemento, findMunicipio(String(dir.departamento ?? ''), String(dir.municipio ?? ''))?.nombre,
        findDepartamento(String(dir.departamento ?? ''))?.nombre].filter(Boolean).join(', ') : null,
      actividad: receptorRaw.descActividad as string | null | undefined,
      correo: receptorRaw.correo as string | null | undefined,
      telefono: receptorRaw.telefono as string | null | undefined,
    };
  } else if (args.cliente && args.cliente !== 'Consumidor anónimo') {
    receptor = { nombre: args.cliente };
  }

  const items = cuerpo.length > 0
    ? cuerpo.map(it => ({
      descripcion: String(it.descripcion ?? ''),
      cantidad: Number(it.cantidad ?? 1),
      precioUni: Number(it.precioUni ?? 0),
      total: Number(it.ventaGravada ?? it.compra ?? 0) + Number(it.ventaExenta ?? 0) + Number(it.ventaNoSuj ?? 0),
      uniMedida: it.uniMedida !== undefined ? Number(it.uniMedida) : undefined,
      descuento: Number(it.montoDescu ?? 0) || undefined,
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
      retencionIva: Number(resumen.ivaRete1 ?? 0) || undefined,
    },
    totalEnLetras: resumen.totalLetras as string | undefined,
    condicionOperacion: resumen.condicionOperacion !== undefined ? Number(resumen.condicionOperacion) : undefined,
    tipoModelo: ident.tipoModelo !== undefined ? Number(ident.tipoModelo) : undefined,
    tipoOperacion: ident.tipoOperacion !== undefined ? Number(ident.tipoOperacion) : undefined,
    observaciones: (resumen.observaciones as string | null | undefined) ?? null,
  };
}

/* ───────────────────────── PDF Carta (formal) ───────────────────────── */

export async function downloadDtePdf(data: PdfData, opts?: PdfOutputOpts): Promise<void> {
  const doc = await buildDtePdf(data);
  outputDoc(doc, `${data.tipo.toUpperCase()}_${data.numeroControl}.pdf`, opts);
}

/* Formato carta "corporativo": tipografía sobria, reglas finas en lugar de
 * cajas de color, números alineados y toda la identificación del DTE que exige
 * la representación gráfica (control, código, sello, modelo, transmisión, QR). */
const INK = {
  text:   [33, 37, 41] as const,
  muted:  [108, 117, 125] as const,
  faint:  [150, 157, 164] as const,
  rule:   [206, 212, 218] as const,
  hair:   [229, 232, 235] as const,
  band:   [246, 247, 249] as const,
  accent: [22, 43, 72] as const,      // azul marino, solo en el título y el total
  danger: [176, 42, 55] as const,
  warn:   [161, 98, 7] as const,
};

const UNIDADES: Record<number, string> = { 59: 'Unidad', 99: 'Otra', 1: 'Metro', 23: 'Litro', 36: 'Kilogramo', 34: 'Libra', 57: 'Ciento', 58: 'Docena' };
const CONDICION: Record<number, string> = { 1: 'Contado', 2: 'A crédito', 3: 'Otro' };
const DOC_RECEPTOR: Record<string, string> = { '13': 'DUI', '36': 'NIT', '37': 'Otro documento', '03': 'Pasaporte', '02': 'Carné de residente' };

/** Logo del emisor para el PDF (lo fija BrandingProvider con el de Configuración). */
let pdfLogo: string | null = null;
export function setDtePdfLogo(dataUrl: string | null): void {
  pdfLogo = dataUrl && /^data:image\/(png|jpe?g)/i.test(dataUrl) ? dataUrl : null;
}

const fmtNit = (v?: string | null) => {
  const d = (v ?? '').replace(/\D/g, '');
  return d.length === 14 ? `${d.slice(0, 4)}-${d.slice(4, 10)}-${d.slice(10, 13)}-${d.slice(13)}` : (v ?? '');
};
const fmtDui = (v?: string | null) => {
  const d = (v ?? '').replace(/\D/g, '');
  return d.length === 9 ? `${d.slice(0, 8)}-${d.slice(8)}` : (v ?? '');
};
const fmtNrc = (v?: string | null) => {
  const d = (v ?? '').replace(/\D/g, '');
  return d.length > 1 ? `${d.slice(0, -1)}-${d.slice(-1)}` : (v ?? '');
};
const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** Arma el PDF carta del DTE (sin descargarlo). */
export async function buildDtePdf(data: PdfData): Promise<jsPDF> {
  const doc = new jsPDF({ unit: 'mm', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 16;
  const CW = W - 2 * M;
  const color = (c: readonly [number, number, number]) => doc.setTextColor(c[0], c[1], c[2]);
  const draw = (c: readonly [number, number, number], w = 0.2) => { doc.setDrawColor(c[0], c[1], c[2]); doc.setLineWidth(w); };
  const fill = (c: readonly [number, number, number]) => doc.setFillColor(c[0], c[1], c[2]);
  const font = (style: 'normal' | 'bold' | 'italic', size: number, family = 'helvetica') => { doc.setFont(family, style); doc.setFontSize(size); };
  const label = (t: string, x: number, y: number, opts?: { align?: 'left' | 'right' }) => {
    font('bold', 6); color(INK.muted);
    doc.text(t.toUpperCase(), x, y, opts?.align === 'right' ? opts : { charSpace: 0.25 });
  };
  const esFse = data.tipo === 'fse';

  /* ── Encabezado: emisor a la izquierda, documento a la derecha ── */
  let y = M;
  const leftW = CW * 0.56;
  let lx = M;
  if (pdfLogo) {
    try {
      const props = doc.getImageProperties(pdfLogo);
      const h = 14;
      const w = Math.min(46, (props.width / props.height) * h);
      doc.addImage(pdfLogo, M, y, w, (props.height / props.width) * w);
      lx = M;
      y += Math.min(h, (props.height / props.width) * w) + 3;
    } catch { /* logo ilegible: solo texto */ }
  }
  const comercial = data.emisor.nombreComercial?.trim();
  font('bold', 12.5); color(INK.text);
  const nombreLines = doc.splitTextToSize(comercial || data.emisor.nombre, leftW) as string[];
  doc.text(nombreLines, lx, y + 4.5);
  y += 4.5 + (nombreLines.length - 1) * 5;
  if (comercial && comercial !== data.emisor.nombre) { font('normal', 8); color(INK.muted); doc.text(data.emisor.nombre, lx, y + 4); y += 4; }
  font('normal', 7.6); color(INK.text);
  const ubic = [findMunicipio(data.emisor.departamento ?? '', data.emisor.municipio ?? '')?.nombre, findDepartamento(data.emisor.departamento ?? '')?.nombre]
    .filter(Boolean).join(', ');
  const emisorLines = [
    `NIT ${fmtNit(data.emisor.nit)}   ·   NRC ${fmtNrc(data.emisor.nrc)}`,
    `${data.emisor.codActividad ? data.emisor.codActividad + ' · ' : ''}${data.emisor.actividad}`,
    [data.emisor.direccion, ubic].filter(Boolean).join(', '),
    [data.emisor.telefono && `Tel. ${data.emisor.telefono}`, data.emisor.correo].filter(Boolean).join('   ·   '),
  ].filter(Boolean);
  y += 5;
  for (const l of emisorLines) {
    const wrapped = doc.splitTextToSize(l, leftW) as string[];
    doc.text(wrapped, lx, y);
    y += 3.6 * wrapped.length;
  }

  // Bloque del documento (derecha)
  const rx = W - M;
  let ry = M + 4.5;
  font('bold', 12); color(INK.accent);
  for (const l of doc.splitTextToSize(TIPO_LABEL[data.tipo].toUpperCase(), CW * 0.42) as string[]) { doc.text(l, rx, ry, { align: 'right' }); ry += 5; }
  font('normal', 7); color(INK.muted);
  doc.text(`Documento Tributario Electrónico · ${data.tipo.toUpperCase()} ${TIPO_VERSION[data.tipo]}`, rx, ry, { align: 'right' });
  ry += 5;
  const badge = (txt: string, c: readonly [number, number, number]) => {
    font('bold', 6.8);
    const w = doc.getTextWidth(txt) + 5;
    draw(c, 0.35); color(c);
    doc.rect(rx - w, ry - 3.4, w, 5, 'S');
    doc.text(txt, rx - w / 2, ry, { align: 'center' });
    ry += 6.5;
  };
  if (data.anulado) badge('DOCUMENTO ANULADO', INK.danger);
  if (data.ambiente === '00') badge('AMBIENTE DE PRUEBAS · SIN VALIDEZ TRIBUTARIA', INK.warn);

  y = Math.max(y, ry) + 2;
  draw(INK.accent, 0.6); doc.line(M, y, W - M, y);
  y += 6;

  /* ── Identificación del DTE + QR ── */
  const qrSize = 27;
  const qrUrl = buildConsultaUrl(data);
  const qr = await QRCode.toDataURL(qrUrl, { width: 320, margin: 0, errorCorrectionLevel: 'M' });
  const gridW = CW - qrSize - 8;
  const field = (lbl: string, value: string, x: number, yy: number, w: number, mono = false) => {
    label(lbl, x, yy);
    font('normal', mono ? 7.4 : 8, mono ? 'courier' : 'helvetica'); color(INK.text);
    doc.text(doc.splitTextToSize(value || '—', w - 2) as string[], x, yy + 3.8);
  };
  const c1 = 54, c2 = 62, c3 = gridW - c1 - c2;
  const x2 = M + c1, x3 = M + c1 + c2;
  field('Número de control', data.numeroControl, M, y, c1, true);
  field('Código de generación', data.codigoGeneracion, x2, y, c2, true);
  field('Fecha de emisión', `${displayDate(data.fecha)}${data.horaEmision ? ' · ' + data.horaEmision : ''}`, x3, y, c3);
  field('Sello de recepción', data.selloRecibido ?? 'Pendiente', M, y + 10, c1 + c2, true);
  field('Modelo de facturación', data.tipoModelo === 2 ? 'Diferido' : 'Previo', x3, y + 10, c3);
  field('Tipo de transmisión', data.tipoOperacion === 2 ? 'Contingencia' : 'Normal', M, y + 20, c1);
  field('Condición de la operación', CONDICION[data.condicionOperacion ?? 1] ?? 'Contado', x2, y + 20, c2);
  field('Moneda', 'USD', x3, y + 20, c3);
  doc.addImage(qr, 'PNG', W - M - qrSize, y - 2.5, qrSize, qrSize);
  font('normal', 5.6); color(INK.faint);
  doc.text('Verificar en el Ministerio de Hacienda', W - M - qrSize / 2, y + qrSize + 0.8, { align: 'center' });
  y += 30;

  /* ── Receptor / sujeto excluido ── */
  draw(INK.rule); doc.line(M, y, W - M, y);
  y += 5;
  label(esFse ? 'Sujeto excluido (proveedor)' : data.tipo === 'fcf' ? 'Cliente' : 'Receptor', M, y);
  y += 4.5;
  if (data.receptor) {
    const r = data.receptor;
    font('bold', 9.5); color(INK.text);
    doc.text(r.nombre, M, y);
    if (r.nombreComercial && r.nombreComercial !== r.nombre) { font('normal', 7.6); color(INK.muted); doc.text(r.nombreComercial, M + doc.getTextWidth(r.nombre) * (9.5 / 7.6) + 3, y); }
    y += 5;
    const docLabel = r.tipoDocumento ? (DOC_RECEPTOR[r.tipoDocumento] ?? 'Documento') : (r.dui ? 'DUI' : 'Documento');
    const docValue = r.tipoDocumento === '36' ? fmtNit(r.dui) : (!r.tipoDocumento || r.tipoDocumento === '13') ? fmtDui(r.dui) : (r.dui ?? '');
    const cells: Array<[string, string]> = [
      ...(r.nit ? [['NIT', fmtNit(r.nit)] as [string, string]] : []),
      ...(r.nrc ? [['NRC', fmtNrc(r.nrc)] as [string, string]] : []),
      ...(!r.nit && r.dui ? [[docLabel, docValue] as [string, string]] : []),
      ...(r.actividad ? [['Actividad económica', r.actividad] as [string, string]] : []),
      ...(r.direccion ? [['Dirección', r.direccion] as [string, string]] : []),
      ...(r.correo ? [['Correo electrónico', r.correo] as [string, string]] : []),
      ...(r.telefono ? [['Teléfono', r.telefono] as [string, string]] : []),
    ];
    // Grilla de 4 columnas; actividad y dirección ocupan dos
    const colW = CW / 4;
    let cx = 0;
    let rowH = 0;
    for (const [k, v] of cells) {
      const span = k === 'Dirección' || k === 'Actividad económica' ? 2 : 1;
      if (cx + span > 4) { y += rowH; cx = 0; rowH = 0; }
      label(k, M + cx * colW, y);
      font('normal', 7.8); color(INK.text);
      const lines = doc.splitTextToSize(v, colW * span - 3) as string[];
      doc.text(lines, M + cx * colW, y + 3.7);
      rowH = Math.max(rowH, 5.5 + lines.length * 3.4);
      cx += span;
    }
    y += rowH;
  } else {
    font('normal', 8.5); color(INK.muted);
    doc.text('Consumidor final', M, y);
    y += 6;
  }
  y += 3;

  /* ── Detalle ── */
  const cols = { n: M + 2, cant: M + 16, uni: M + 30, desc: M + 50, precio: W - M - 34, total: W - M - 2 };
  const descW = cols.precio - cols.desc - 22;
  const drawHead = () => {
    fill(INK.band); draw(INK.rule);
    doc.rect(M, y, CW, 7, 'F');
    doc.line(M, y, W - M, y); doc.line(M, y + 7, W - M, y + 7);
    const hy = y + 4.6;
    label('N.º', cols.n, hy); label('Cant.', cols.cant + 9, hy, { align: 'right' }); label('Unidad', cols.uni, hy); label('Descripción', cols.desc, hy);
    label('Precio unitario', cols.precio, hy, { align: 'right' });
    label(data.tipo === 'ccf' || data.tipo === 'nc' ? 'Ventas gravadas' : esFse ? 'Compra' : 'Total', cols.total, hy, { align: 'right' });
    y += 7;
  };
  const FOOTER_TOP = H - 24;
  const continuation = () => {
    font('bold', 8.5); color(INK.accent);
    doc.text(TIPO_LABEL[data.tipo].toUpperCase(), M, y + 3);
    font('normal', 7.5); color(INK.muted);
    doc.text(`${data.numeroControl}   ·   continuación`, W - M, y + 3, { align: 'right' });
    y += 7;
  };
  drawHead();
  font('normal', 8); color(INK.text);
  data.items.forEach((it, i) => {
    font('normal', 8);
    const lines = doc.splitTextToSize(it.descripcion, descW) as string[];
    const lineH = 8 * 1.15 * 0.3528;   // pt → mm
    const rowH = 6.4 + (lines.length - 1) * lineH;
    if (y + rowH > FOOTER_TOP - 6) { doc.addPage(); y = M; continuation(); drawHead(); }
    font('normal', 8); color(INK.text);
    const ty = y + 4.3;
    doc.text(String(i + 1), cols.n, ty);
    doc.text(formatQty(it.cantidad), cols.cant + 9, ty, { align: 'right' });
    color(INK.muted); doc.text(UNIDADES[it.uniMedida ?? 59] ?? String(it.uniMedida), cols.uni, ty); color(INK.text);
    doc.text(lines, cols.desc, ty);
    doc.text(money(it.precioUni), cols.precio, ty, { align: 'right' });
    font('bold', 8); doc.text(money(it.total), cols.total, ty, { align: 'right' });
    y += rowH;
    draw(INK.hair); doc.line(M, y, W - M, y);
  });
  draw(INK.rule); doc.line(M, y, W - M, y);
  y += 5;

  /* ── Totales (derecha) y valor en letras (izquierda) ── */
  const t = data.totales;
  const rows: Array<[string, number, boolean?]> = [];
  if (data.tipo === 'fcf') {
    rows.push(['Sumas', t.subtotal + t.iva]);
    rows.push(['IVA incluido (13%)', t.iva, true]);
  } else if (data.tipo === 'ccf' || data.tipo === 'nc') {
    rows.push(['Sumas', t.subtotal], ['IVA 13%', t.iva]);
  } else {
    rows.push(['Total de compras', t.subtotal]);
  }
  if (t.descuento) rows.push(['Descuentos', -t.descuento]);
  if (t.retencionIva) rows.push(['IVA retenido (1%)', -t.retencionIva]);
  if (t.retencionRenta) rows.push(['Renta retenida', -t.retencionRenta]);

  const blockH = rows.length * 5.2 + 12;
  if (y + blockH > FOOTER_TOP - 4) { doc.addPage(); y = M; continuation(); }
  const tw = 78, tx = W - M - tw;
  let ty = y;
  for (const [k, v, informativo] of rows) {
    font('normal', 8); color(informativo ? INK.muted : INK.text);
    doc.text(k, tx, ty + 3.5);
    doc.text(v < 0 ? `(${money(-v)})` : money(v), W - M - 2, ty + 3.5, { align: 'right' });
    ty += 5.2;
  }
  draw(INK.accent, 0.5); doc.line(tx, ty + 0.5, W - M, ty + 0.5);
  font('bold', 9); color(INK.accent);
  doc.text('TOTAL A PAGAR', tx, ty + 6.2);
  font('bold', 12);
  doc.text(money(t.total), W - M - 2, ty + 6.4, { align: 'right' });
  ty += 9;
  draw(INK.accent, 0.5); doc.line(tx, ty, W - M, ty);

  // Izquierda: valor en letras, observaciones
  const lw = CW - tw - 10;
  let ly = y;
  if (data.totalEnLetras) {
    label('Valor en letras', M, ly + 2);
    font('normal', 8); color(INK.text);
    const ll = doc.splitTextToSize(data.totalEnLetras, lw) as string[];
    doc.text(ll, M, ly + 6);
    ly += 7 + ll.length * 3.6;
  }
  if (data.observaciones) {
    label('Observaciones', M, ly + 2);
    font('normal', 7.8); color(INK.text);
    doc.text(doc.splitTextToSize(data.observaciones, lw) as string[], M, ly + 6);
  }

  /* ── Marca de agua de anulación ── */
  if (data.anulado) {
    for (let p = 1; p <= doc.getNumberOfPages(); p++) {
      doc.setPage(p);
      doc.saveGraphicsState();
      doc.setGState(new (doc as unknown as { GState: new (o: { opacity: number }) => unknown }).GState({ opacity: 0.1 }) as never);
      font('bold', 84); color(INK.danger);
      doc.text('ANULADO', W / 2, H / 2 + 20, { align: 'center', angle: 32 });
      doc.restoreGraphicsState();
    }
  }

  /* ── Pie en todas las páginas ── */
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    draw(INK.rule); doc.line(M, H - 18, W - M, H - 18);
    font('normal', 6.6); color(INK.muted);
    doc.text('Representación gráfica de un Documento Tributario Electrónico. Verifique su validez escaneando el código QR', M, H - 13.5);
    doc.text(`o en admin.factura.gob.sv/consultaPublica con el código de generación ${data.codigoGeneracion}.`, M, H - 10.5);
    doc.text(`Página ${p} de ${pages}`, W - M, H - 13.5, { align: 'right' });
    doc.text(data.numeroControl, W - M, H - 10.5, { align: 'right' });
  }
  return doc;
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
