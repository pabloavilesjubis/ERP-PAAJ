import { createWriteStream } from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import type { DteRecord } from './storage.js';

/**
 * Genera representaciones imprimibles del DTE para entregar al receptor:
 *   - PDF A4 (1 página): la "representación gráfica" estilizada
 *   - Ticket 80mm (PDF estrecho): para POS térmico
 *
 * El JSON canónico del MH no se genera aquí — se vuelca tal cual desde la
 * respuesta de MH (storage.json_path apunta a un archivo escrito directamente).
 *
 * El PDF NO incluye la firma JWS — solo los datos legibles + QR de consulta
 * pública. El JWS se sirve aparte como JSON con el documento firmado.
 */

interface PdfBuildArgs {
  rec: DteRecord;
  outDir: string;
}

export async function buildDteFiles(args: PdfBuildArgs): Promise<{ pdfPath: string; jsonPath: string; ticketPath: string }> {
  const { rec, outDir } = args;
  const safeId = rec.erp_invoice_id.replace(/[^a-zA-Z0-9._-]/g, '_');
  const pdfPath = path.join(outDir, `${safeId}.pdf`);
  const jsonPath = path.join(outDir, `${safeId}.json`);
  const ticketPath = path.join(outDir, `${safeId}-ticket.pdf`);

  // JSON oficial — el firmado se sube embebido junto al DTE en sí
  const json = {
    documento: rec.documento_jws,
    dte: rec.dte_json,
    mh: rec.mh_raw,
    selloRecibido: rec.sello_recibido,
    codigoGeneracion: rec.codigo_generacion,
    numeroControl: rec.numero_control,
  };
  await writeFileAsync(jsonPath, JSON.stringify(json, null, 2));

  const qrUrl = buildQrUrl(rec);
  const qrDataUrl = await QRCode.toDataURL(qrUrl, { width: 300, margin: 0 });

  await renderA4(pdfPath, rec, qrDataUrl);
  await renderTicket80(ticketPath, rec, qrDataUrl);

  return { pdfPath, jsonPath, ticketPath };
}

export function buildQrUrl(rec: DteRecord): string {
  return `https://admin.factura.gob.sv/consultaPublica?ambiente=${rec.ambiente}&codGen=${rec.codigo_generacion}&fechaEmi=${rec.fec_emi}`;
}

const TIPO_DTE_LABEL: Record<string, string> = {
  '01': 'FACTURA DE CONSUMIDOR FINAL',
  '03': 'COMPROBANTE DE CRÉDITO FISCAL',
  '05': 'NOTA DE CRÉDITO',
  '14': 'FACTURA DE SUJETO EXCLUIDO',
};

interface MinimalDte {
  emisor?: Record<string, unknown>;
  receptor?: Record<string, unknown> | null;
  sujetoExcluido?: Record<string, unknown> | null;
  cuerpoDocumento?: Array<Record<string, unknown>>;
  resumen?: Record<string, unknown>;
}

async function renderA4(target: string, rec: DteRecord, qrDataUrl: string): Promise<void> {
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  const stream = createWriteStream(target);
  doc.pipe(stream);

  const dte = rec.dte_json as unknown as MinimalDte;
  const emisor = (dte.emisor ?? {}) as Record<string, string | undefined>;
  const receptor = (dte.receptor ?? dte.sujetoExcluido ?? null) as Record<string, unknown> | null;
  const items = dte.cuerpoDocumento ?? [];
  const resumen = (dte.resumen ?? {}) as Record<string, number | string | undefined>;

  // Encabezado
  doc.fontSize(14).font('Helvetica-Bold').text(TIPO_DTE_LABEL[rec.tipo_dte] ?? 'DOCUMENTO TRIBUTARIO ELECTRÓNICO', { align: 'center' });
  doc.fontSize(9).font('Helvetica').text(rec.ambiente === '01' ? 'Ambiente: PRODUCCIÓN' : 'Ambiente: PRUEBA', { align: 'center' });
  doc.moveDown(0.5);

  // Bloque identificación
  doc.fontSize(8).font('Helvetica-Bold').text('CÓDIGO DE GENERACIÓN:', { continued: true })
    .font('Helvetica').text(` ${rec.codigo_generacion}`);
  doc.font('Helvetica-Bold').text('NÚMERO DE CONTROL:', { continued: true })
    .font('Helvetica').text(` ${rec.numero_control}`);
  doc.font('Helvetica-Bold').text('SELLO RECIBIDO:', { continued: true })
    .font('Helvetica').text(` ${rec.sello_recibido ?? '(pendiente)'}`);
  doc.font('Helvetica-Bold').text('FECHA Y HORA:', { continued: true })
    .font('Helvetica').text(` ${rec.fec_emi} ${rec.hor_emi}`);
  doc.moveDown(0.5);

  // Emisor / Receptor en dos columnas
  const colWidth = (doc.page.width - 72) / 2;
  const yStart = doc.y;
  doc.fontSize(8).font('Helvetica-Bold').text('EMISOR', 36, yStart);
  doc.font('Helvetica').text(`${emisor.nombre ?? ''}`, 36, doc.y, { width: colWidth - 6 });
  doc.text(`NIT: ${emisor.nit ?? ''}`);
  doc.text(`NRC: ${emisor.nrc ?? ''}`);
  doc.text(`Actividad: ${emisor.descActividad ?? ''}`);

  doc.font('Helvetica-Bold').text('RECEPTOR', 36 + colWidth, yStart);
  if (receptor) {
    doc.font('Helvetica').text(`${String(receptor.nombre ?? '')}`, 36 + colWidth, doc.y, { width: colWidth - 6 });
    if (receptor.nit) doc.text(`NIT: ${receptor.nit}`);
    if (receptor.numDocumento) doc.text(`Doc: ${receptor.numDocumento}`);
    if (receptor.nrc) doc.text(`NRC: ${receptor.nrc}`);
    if (receptor.correo) doc.text(`${receptor.correo}`);
  } else {
    doc.font('Helvetica-Oblique').text('Consumidor anónimo', 36 + colWidth, doc.y);
  }
  doc.x = 36;
  doc.moveDown(1);

  // Tabla de items
  const tableTop = doc.y;
  const cols = { num: 36, desc: 70, cant: 340, pu: 390, total: 460 };
  doc.fontSize(8).font('Helvetica-Bold');
  doc.text('#', cols.num, tableTop);
  doc.text('Descripción', cols.desc, tableTop);
  doc.text('Cant.', cols.cant, tableTop, { width: 40, align: 'right' });
  doc.text('P. Unit.', cols.pu, tableTop, { width: 60, align: 'right' });
  doc.text('Total', cols.total, tableTop, { width: 80, align: 'right' });
  doc.moveTo(36, tableTop + 12).lineTo(doc.page.width - 36, tableTop + 12).stroke();

  let rowY = tableTop + 16;
  doc.font('Helvetica');
  for (const it of items) {
    const cantidad = Number(it.cantidad ?? 0);
    const precioUni = Number(it.precioUni ?? 0);
    const ventaGravada = Number(it.ventaGravada ?? 0);
    const numItem = Number(it.numItem ?? 0);
    const descripcion = String(it.descripcion ?? '');
    doc.text(String(numItem), cols.num, rowY);
    doc.text(descripcion.slice(0, 60), cols.desc, rowY, { width: 260 });
    doc.text(cantidad.toFixed(2), cols.cant, rowY, { width: 40, align: 'right' });
    doc.text(precioUni.toFixed(2), cols.pu, rowY, { width: 60, align: 'right' });
    doc.text(ventaGravada.toFixed(2), cols.total, rowY, { width: 80, align: 'right' });
    rowY = doc.y + 2;
    if (rowY > doc.page.height - 200) {
      doc.addPage();
      rowY = doc.y;
    }
  }

  // Totales
  doc.moveTo(36, rowY + 4).lineTo(doc.page.width - 36, rowY + 4).stroke();
  let ty = rowY + 10;
  const printTotal = (label: string, value: unknown): void => {
    const v = Number(value ?? 0);
    doc.font('Helvetica').text(label, 340, ty, { width: 100, align: 'right' });
    doc.font('Helvetica-Bold').text(`$ ${v.toFixed(2)}`, 460, ty, { width: 80, align: 'right' });
    ty += 12;
  };
  printTotal('Subtotal:', resumen.subTotal ?? resumen.subTotalVentas);
  if (resumen.totalIva) printTotal('IVA 13%:', resumen.totalIva);
  if (Array.isArray(resumen.tributos)) {
    for (const t of resumen.tributos as Array<{ descripcion: string; valor: number }>) {
      printTotal(`${t.descripcion}:`, t.valor);
    }
  }
  if (Number(resumen.ivaRete1) > 0) printTotal('Retención IVA 1%:', resumen.ivaRete1);
  if (Number(resumen.reteRenta) > 0) printTotal('Retención Renta:', resumen.reteRenta);
  printTotal('TOTAL:', resumen.montoTotalOperacion ?? resumen.totalPagar ?? resumen.subTotal);

  doc.font('Helvetica-Oblique').fontSize(8).text(
    `Son: ${String(resumen.totalLetras ?? '')}`,
    36, ty + 6, { width: doc.page.width - 72 },
  );

  // QR + pie
  ty += 30;
  doc.image(qrBufferFromDataUrl(qrDataUrl), 36, ty, { width: 90, height: 90 });
  doc.fontSize(7).font('Helvetica').text(
    'Para verificar este documento, escanee el QR\no visite admin.factura.gob.sv/consultaPublica',
    140, ty + 10, { width: 240 },
  );

  if (rec.estado === 'ANULADO') {
    doc.save();
    doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc.fontSize(72).fillColor('red').opacity(0.3)
      .text('ANULADO', 0, doc.page.height / 2 - 36, { align: 'center', width: doc.page.width });
    doc.restore();
  }

  doc.end();
  await streamFinished(stream);
}

async function renderTicket80(target: string, rec: DteRecord, qrDataUrl: string): Promise<void> {
  // 80mm = ~226pt. Altura dinámica difícil con pdfkit — usamos página fija
  // de 600pt de alto y truncamos si excede; suficiente para 95% de tickets.
  const doc = new PDFDocument({ size: [226, 600], margin: 8 });
  const stream = createWriteStream(target);
  doc.pipe(stream);

  const dte = rec.dte_json as unknown as MinimalDte;
  const emisor = (dte.emisor ?? {}) as Record<string, string | undefined>;
  const items = dte.cuerpoDocumento ?? [];
  const resumen = (dte.resumen ?? {}) as Record<string, number | string | undefined>;

  const center = (s: string, size = 8, bold = false): void => {
    doc.fontSize(size).font(bold ? 'Helvetica-Bold' : 'Helvetica').text(s, { align: 'center' });
  };

  center(emisor.nombre ?? '', 9, true);
  if (emisor.nombreComercial) center(String(emisor.nombreComercial), 8);
  center(`NIT ${emisor.nit ?? ''}  NRC ${emisor.nrc ?? ''}`, 7);
  doc.moveDown(0.3);
  center(TIPO_DTE_LABEL[rec.tipo_dte] ?? '', 8, true);
  center(rec.ambiente === '01' ? 'PRODUCCIÓN' : 'PRUEBA', 7);
  doc.moveDown(0.3);
  doc.fontSize(7).font('Helvetica');
  doc.text(`No. Control: ${rec.numero_control}`);
  doc.text(`Cód. Gen: ${rec.codigo_generacion}`);
  doc.text(`Sello: ${(rec.sello_recibido ?? '').slice(0, 20)}...`);
  doc.text(`${rec.fec_emi} ${rec.hor_emi}`);
  doc.moveDown(0.3);

  doc.text('-'.repeat(40));
  for (const it of items) {
    doc.text(`${it.cantidad}x ${String(it.descripcion ?? '').slice(0, 28)}`);
    const total = Number(it.ventaGravada ?? 0);
    doc.text(`   $ ${total.toFixed(2)}`, { align: 'right' });
  }
  doc.text('-'.repeat(40));

  const line = (label: string, value: unknown): void => {
    const v = Number(value ?? 0);
    doc.text(`${label}   $ ${v.toFixed(2)}`, { align: 'right' });
  };
  line('Subtotal:', resumen.subTotal ?? resumen.subTotalVentas);
  if (resumen.totalIva) line('IVA 13%:', resumen.totalIva);
  line('TOTAL:', resumen.montoTotalOperacion ?? resumen.totalPagar ?? resumen.subTotal);

  doc.moveDown(0.4);
  doc.image(qrBufferFromDataUrl(qrDataUrl), 63, doc.y, { width: 100, height: 100 });
  doc.moveDown(7);
  center('Verifique en admin.factura.gob.sv', 6);

  if (rec.estado === 'ANULADO') {
    center('*** ANULADO ***', 10, true);
  }

  doc.end();
  await streamFinished(stream);
}

function streamFinished(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve());
    stream.on('error', reject);
  });
}

async function writeFileAsync(target: string, data: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(target, data, 'utf-8');
}

function qrBufferFromDataUrl(dataUrl: string): Buffer {
  const idx = dataUrl.indexOf(',');
  const b64 = idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
  return Buffer.from(b64, 'base64');
}
