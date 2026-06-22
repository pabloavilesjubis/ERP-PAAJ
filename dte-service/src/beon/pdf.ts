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
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const stream = createWriteStream(target);
  doc.pipe(stream);

  const dte = rec.dte_json as unknown as MinimalDte;
  const emisor = (dte.emisor ?? {}) as Record<string, unknown>;
  const receptor = (dte.receptor ?? dte.sujetoExcluido ?? null) as Record<string, unknown> | null;
  const items = dte.cuerpoDocumento ?? [];
  const resumen = (dte.resumen ?? {}) as Record<string, unknown>;
  const S = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
  const N = (v: unknown): number => Number(v ?? 0);
  const money = (v: unknown): string => `$ ${N(v).toFixed(2)}`;

  // Paleta SaaS-grade
  const BRAND = '#0f766e';      // teal-700
  const BRAND_SOFT = '#d1fae5'; // emerald-100
  const DARK = '#0f172a';       // slate-900
  const BORDER = '#d8dee9';
  const LABEL = '#64748b';      // slate-500
  const TEXT = '#1e293b';       // slate-800
  const ZEBRA = '#f8fafc';      // slate-50

  const M = 40;
  const W = doc.page.width;
  const R = W - M;          // right edge
  const CW = R - M;         // content width

  // ── Header con marca + tipo de DTE ──────────────────────────────────────
  doc.rect(M, M, CW, 58).fill(BRAND);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(15)
    .text(S(emisor.nombreComercial) || S(emisor.nombre), M + 14, M + 11, { width: CW * 0.58, lineBreak: false });
  doc.font('Helvetica').fontSize(8).fillColor(BRAND_SOFT)
    .text(S(emisor.nombre), M + 14, M + 33, { width: CW * 0.58, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#ffffff')
    .text(TIPO_DTE_LABEL[rec.tipo_dte] ?? 'DOCUMENTO TRIBUTARIO ELECTRÓNICO', M, M + 13, { width: CW - 14, align: 'right' });
  doc.font('Helvetica').fontSize(7.5).fillColor(BRAND_SOFT)
    .text(`Documento Tributario Electrónico · Ambiente ${rec.ambiente === '01' ? 'PRODUCCIÓN' : 'PRUEBA'}`, M, M + 33, { width: CW - 14, align: 'right' });

  let y = M + 58 + 12;

  // ── Caja de identificación fiscal + QR ──────────────────────────────────
  const idH = 80;
  const qrSize = 66;
  doc.lineWidth(0.8).strokeColor(BORDER).rect(M, y, CW, idH).stroke();
  doc.image(qrBufferFromDataUrl(qrDataUrl), R - qrSize - 10, y + 7, { width: qrSize, height: qrSize });
  doc.font('Helvetica').fontSize(5.5).fillColor(LABEL)
    .text('Escanee para verificar', R - qrSize - 10, y + qrSize + 9, { width: qrSize, align: 'center' });
  const idRows: Array<[string, string]> = [
    ['Código de generación', rec.codigo_generacion],
    ['Número de control', rec.numero_control],
    ['Sello de recepción', rec.sello_recibido ?? '(pendiente)'],
    ['Fecha y hora de emisión', `${rec.fec_emi}   ${rec.hor_emi}`],
  ];
  let iy = y + 9;
  for (const [lab, val] of idRows) {
    doc.font('Helvetica').fontSize(6).fillColor(LABEL).text(lab.toUpperCase(), M + 12, iy, { width: 150 });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(TEXT).text(val, M + 12, iy + 7, { width: CW - qrSize - 40 });
    iy += 17;
  }
  y += idH + 12;

  // ── Cajas Emisor / Receptor ─────────────────────────────────────────────
  const gap = 12;
  const boxW = (CW - gap) / 2;
  const valW = boxW - 86;
  const dir = (emisor.direccion ?? {}) as Record<string, unknown>;
  const emisorRows: Array<[string, string]> = [
    ['Nombre', S(emisor.nombre)],
    ['NIT', S(emisor.nit)],
    ['NRC', S(emisor.nrc)],
    ['Actividad', S(emisor.descActividad)],
    ['Dirección', S(dir.complemento)],
    ['Tel · Correo', `${S(emisor.telefono)}  ${S(emisor.correo)}`.trim()],
  ];
  const rRows: Array<[string, string]> = receptor
    ? [
        ['Nombre', S(receptor.nombre)],
        ['NIT', S(receptor.nit)],
        ['Documento', S(receptor.numDocumento)],
        ['NRC', S(receptor.nrc)],
        ['Correo', S(receptor.correo)],
      ]
    : [['Cliente', 'CONSUMIDOR FINAL']];

  // Altura dinámica: cada valor puede ocupar varias líneas. Ambas cajas igualan
  // al alto del contenido más largo para mantener la simetría.
  const rowHeight = (val: string): number => {
    doc.font('Helvetica-Bold').fontSize(7.5);
    return Math.max(13.5, doc.heightOfString(val || ' ', { width: valW }) + 3);
  };
  const measure = (rows: Array<[string, string]>): number =>
    23 + rows.filter(([, v]) => v).reduce((h, [, v]) => h + rowHeight(v), 0) + 7;
  const boxH = Math.max(96, measure(emisorRows), measure(rRows));

  const partyBox = (title: string, x: number, rows: Array<[string, string]>): void => {
    doc.lineWidth(0.8).strokeColor(BORDER).rect(x, y, boxW, boxH).stroke();
    doc.rect(x, y, boxW, 17).fill('#f1f5f9');
    doc.font('Helvetica-Bold').fontSize(8).fillColor(BRAND).text(title, x + 10, y + 5);
    let ry = y + 23;
    for (const [lab, val] of rows) {
      if (!val) continue;
      const h = rowHeight(val);
      doc.font('Helvetica').fontSize(6).fillColor(LABEL).text(lab.toUpperCase(), x + 10, ry + 1, { width: 64 });
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(TEXT).text(val, x + 76, ry, { width: valW });
      ry += h;
    }
  };
  partyBox('EMISOR', M, emisorRows);
  partyBox('RECEPTOR', M + boxW + gap, rRows);
  y += boxH + 16;

  // ── Tabla de ítems ──────────────────────────────────────────────────────
  const cTotalX = R - 78, cTotalW = 72;
  const cPuX = cTotalX - 70, cPuW = 64;
  const cCantX = cPuX - 52, cCantW = 46;
  const cNumX = M + 8, cNumW = 20;
  const cDescX = M + 32, cDescW = cCantX - cDescX - 6;
  const tableTop = y;

  doc.rect(M, y, CW, 18).fill(DARK);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.5);
  doc.text('#', cNumX, y + 5.5, { width: cNumW });
  doc.text('DESCRIPCIÓN', cDescX, y + 5.5, { width: cDescW });
  doc.text('CANT.', cCantX, y + 5.5, { width: cCantW, align: 'right' });
  doc.text('P. UNIT.', cPuX, y + 5.5, { width: cPuW, align: 'right' });
  doc.text('TOTAL', cTotalX, y + 5.5, { width: cTotalW, align: 'right' });
  y += 18;

  let zebra = false;
  for (const it of items) {
    const desc = S(it.descripcion);
    doc.font('Helvetica').fontSize(8);
    const rowH = Math.max(16, doc.heightOfString(desc || ' ', { width: cDescW }) + 8);
    if (y + rowH > doc.page.height - 230) { doc.addPage(); y = M; zebra = false; }
    if (zebra) doc.rect(M, y, CW, rowH).fill(ZEBRA);
    const total = N(it.ventaGravada) + N(it.ventaExenta) + N(it.ventaNoSuj);
    doc.font('Helvetica').fontSize(8).fillColor(TEXT);
    doc.text(S(it.numItem), cNumX, y + 4, { width: cNumW });
    doc.text(desc, cDescX, y + 4, { width: cDescW });
    doc.text(N(it.cantidad).toFixed(2), cCantX, y + 4, { width: cCantW, align: 'right' });
    doc.text(money(it.precioUni), cPuX, y + 4, { width: cPuW, align: 'right' });
    doc.font('Helvetica-Bold').text(money(total), cTotalX, y + 4, { width: cTotalW, align: 'right' });
    doc.lineWidth(0.5).strokeColor(BORDER).moveTo(M, y + rowH).lineTo(R, y + rowH).stroke();
    y += rowH;
    zebra = !zebra;
  }
  // Marco exterior de la tabla
  doc.lineWidth(0.8).strokeColor(BORDER).rect(M, tableTop, CW, y - tableTop).stroke();
  y += 14;

  // ── Totales (caja) + "Son letras" ───────────────────────────────────────
  const tw = 218;
  const tx = R - tw;
  const totalLines: Array<{ label: string; value: number; strong?: boolean }> = [];
  const push = (label: string, v: unknown): void => { if (v !== undefined && v !== null) totalLines.push({ label, value: N(v) }); };
  push('Subtotal', resumen.subTotal ?? resumen.subTotalVentas);
  if (N(resumen.totalNoSuj) > 0) push('No sujeto', resumen.totalNoSuj);
  if (N(resumen.totalExenta) > 0) push('Exento', resumen.totalExenta);
  if (Array.isArray(resumen.tributos) && resumen.tributos.length > 0) {
    for (const t of resumen.tributos as Array<{ descripcion?: string; valor?: number }>) {
      push(t.descripcion ?? 'Tributo', t.valor);
    }
  } else if (N(resumen.totalIva) > 0) {
    push('IVA 13%', resumen.totalIva);
  }
  if (N(resumen.ivaRete1) > 0) push('Retención IVA 1%', -N(resumen.ivaRete1));
  if (N(resumen.reteRenta) > 0) push('Retención Renta', -N(resumen.reteRenta));
  totalLines.push({ label: 'TOTAL A PAGAR', value: N(resumen.montoTotalOperacion ?? resumen.totalPagar ?? resumen.subTotal), strong: true });

  const rowHt = 15;
  const totH = totalLines.length * rowHt + 6;
  doc.lineWidth(0.8).strokeColor(BORDER).rect(tx, y, tw, totH).stroke();
  let ly = y + 4;
  for (const ln of totalLines) {
    if (ln.strong) {
      doc.rect(tx, ly - 2, tw, rowHt + 2).fill(BRAND);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9.5);
      doc.text(ln.label, tx + 10, ly + 1, { width: tw - 100 });
      doc.text(money(ln.value), tx + tw - 92, ly + 1, { width: 82, align: 'right' });
    } else {
      doc.font('Helvetica').fontSize(8).fillColor(LABEL).text(ln.label, tx + 10, ly + 1, { width: tw - 100 });
      doc.font('Helvetica-Bold').fillColor(TEXT).text(money(ln.value), tx + tw - 92, ly + 1, { width: 82, align: 'right' });
    }
    ly += rowHt;
  }

  // "Son: letras" a la izquierda de la caja de totales
  doc.font('Helvetica').fontSize(6.5).fillColor(LABEL).text('VALOR EN LETRAS', M, y + 2, { width: tx - M - 16 });
  doc.font('Helvetica-Bold').fontSize(8).fillColor(TEXT)
    .text(S(resumen.totalLetras), M, y + 11, { width: tx - M - 16 });

  y = Math.max(y + totH, ly) + 16;

  // ── Pie ─────────────────────────────────────────────────────────────────
  doc.lineWidth(0.6).strokeColor(BORDER).moveTo(M, y).lineTo(R, y).stroke();
  doc.font('Helvetica').fontSize(6.5).fillColor(LABEL).text(
    'Representación gráfica del Documento Tributario Electrónico. Verifique su validez escaneando el código QR o en admin.factura.gob.sv/consultapublica',
    M, y + 6, { width: CW, align: 'center' },
  );

  if (rec.estado === 'ANULADO') {
    doc.save();
    doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc.fontSize(80).fillColor('red').opacity(0.25)
      .text('ANULADO', 0, doc.page.height / 2 - 40, { align: 'center', width: doc.page.width });
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
