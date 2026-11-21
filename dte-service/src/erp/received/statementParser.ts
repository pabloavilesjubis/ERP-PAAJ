/**
 * Estados de cuenta bancarios en PDF (tarjetas de crédito, préstamos sin DTE):
 * extrae el texto y encuentra los intereses cobrados en el corte, para
 * registrarlos como gasto financiero. Solo lee; nunca ejecuta nada del PDF.
 */

export interface StatementLine { fecha: string; descripcion: string; monto: number }

export interface ParsedStatement {
  bankKey: string;
  bankName: string;
  bankNit: string | null;
  /** Tarjeta o cuenta enmascarada (****4861) */
  account: string;
  cutDate: string;
  /** Identificador único del estado de cuenta (banco + cuenta + corte) */
  number: string;
  interestTotal: number;
  lines: StatementLine[];
  otherLines: StatementLine[];
}

const BANKS: Array<{ key: string; re: RegExp; name: string; nit: string | null }> = [
  { key: 'CUSCATLAN', re: /CUSCATL[AÁ]N/i, name: 'BANCO CUSCATLAN DE EL SALVADOR, S.A.', nit: '06140806720015' },
  { key: 'PROMERICA', re: /PROMERICA/i, name: 'BANCO PROMERICA, S.A.', nit: '05110402951018' },
  { key: 'AGRICOLA', re: /BANCO\s+AGR[IÍ]COLA/i, name: 'BANCO AGRICOLA, S.A.', nit: null },
  { key: 'DAVIVIENDA', re: /DAVIVIENDA/i, name: 'BANCO DAVIVIENDA SALVADOREÑO, S.A.', nit: null },
  { key: 'BAC', re: /\bBAC\b|CREDOMATIC/i, name: 'BANCO DE AMERICA CENTRAL, S.A.', nit: null },
  { key: 'HIPOTECARIO', re: /BANCO\s+HIPOTECARIO/i, name: 'BANCO HIPOTECARIO DE EL SALVADOR, S.A.', nit: null },
  { key: 'ATLANTIDA', re: /ATL[AÁ]NTIDA/i, name: 'BANCO ATLANTIDA EL SALVADOR, S.A.', nit: null },
  { key: 'AZUL', re: /BANCO\s+AZUL/i, name: 'BANCO AZUL DE EL SALVADOR, S.A.', nit: null },
  { key: 'INDUSTRIAL', re: /BANCO\s+INDUSTRIAL/i, name: 'BANCO INDUSTRIAL EL SALVADOR, S.A.', nit: null },
];

const iso = (d: string) => { const [dd, mm, yy] = d.split('/'); return `${yy}-${mm}-${dd}`; };
const amount = (v: string) => Number(v.replace(/[$,\s]/g, ''));

/** Texto del PDF, una línea por renglón visual (los fragmentos se ordenan por posición). */
export async function extractPdfText(bytes: Uint8Array, passwords: string[] = []): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let doc;
  // Los bancos suelen proteger el estado de cuenta con el DUI o el NIT del titular: se prueban esos
  for (const password of [undefined, ...new Set(passwords.filter(Boolean))]) {
    try {
      doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), password, isEvalSupported: false, useSystemFonts: false,
        disableFontFace: true, verbosity: 0 }).promise;
      break;
    } catch (e) {
      if ((e as { name?: string }).name !== 'PasswordException') throw new Error('No se pudo leer el PDF');
    }
  }
  if (!doc) throw new Error('El PDF tiene una contraseña distinta del DUI o NIT de Mi empresa: ábrelo, guárdalo sin contraseña y súbelo');
  const out: string[] = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, 20); p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const items = (content.items as Array<{ str?: string; transform?: number[] }>)
        .filter(i => typeof i.str === 'string' && i.str.trim() && i.transform)
        .map(i => ({ s: i.str!.trim(), x: i.transform![4]!, y: i.transform![5]! }))
        .sort((a, b) => b.y - a.y || a.x - b.x);
      const rows: Array<{ y: number; parts: Array<{ s: string; x: number }> }> = [];
      for (const it of items) {
        const row = rows.find(r => Math.abs(r.y - it.y) <= 2.5);
        if (row) row.parts.push(it); else rows.push({ y: it.y, parts: [it] });
      }
      for (const r of rows) out.push(r.parts.sort((a, b) => a.x - b.x).map(x => x.s).join(' ').replace(/\s+/g, ' '));
    }
  } finally {
    await doc.destroy();
  }
  return out.join('\n');
}

/** Estado de cuenta → intereses del corte, o null si el texto no es un estado de cuenta. */
export function parseStatement(text: string): ParsedStatement | null {
  if (!/ESTADO\s+DE\s+CUENTA/i.test(text) || !/FECHA\s+DE\s+CORTE/i.test(text)) return null;
  const cut = /FECHA\s+DE\s+CORTE\D{0,30}(\d{2}\/\d{2}\/\d{4})/i.exec(text);
  if (!cut) return null;
  const bank = BANKS.find(b => b.re.test(text)) ?? { key: 'BANCO', name: 'Banco', nit: null };
  const card = /\b(\d{4,6})\*{2,}(\d{4})\b/.exec(text);
  const acct = /(?:No\.?|N[uú]mero)\s+de\s+(?:Cuenta|Pr[eé]stamo|Tarjeta)\D{0,10}(\d{6,})/i.exec(text);
  const last4 = card ? card[2]! : acct ? acct[1]!.slice(-4) : '0000';
  const account = card ? `Tarjeta ****${last4}` : `Cuenta ****${last4}`;

  const lines: StatementLine[] = [];
  const otherLines: StatementLine[] = [];
  const rowRe = /^(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+(-?)\s*\$?\s*(-?[\d,]+\.\d{2})$/;
  for (const raw of text.split('\n')) {
    const m = rowRe.exec(raw.trim());
    if (!m) continue;
    const descripcion = m[2]!.trim();
    if (descripcion.includes('$')) continue;          // tablas con varias cifras (aplicación de pagos)
    const monto = (m[3] === '-' ? -1 : 1) * amount(m[4]!);
    if (!Number.isFinite(monto)) continue;
    const line = { fecha: iso(m[1]!), descripcion, monto };
    if (/INTER[EÉ]S/i.test(descripcion) && !/TASA/i.test(descripcion)) lines.push(line);
    else if (/RECARGO|COMISI[OÓ]N|MEMBRES|SEGURO|SEG\.|MORA/i.test(descripcion)) otherLines.push(line);
  }
  const interestTotal = Math.round(lines.reduce((s, l) => s + l.monto, 0) * 100) / 100;
  const cutDate = iso(cut[1]!);
  return {
    bankKey: bank.key, bankName: bank.name, bankNit: bank.nit, account, cutDate,
    number: `EC-${bank.key}-${last4}-${cutDate.replace(/-/g, '')}`,
    interestTotal, lines, otherLines,
  };
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const STOP = new Set(['SA', 'DE', 'CV', 'LA', 'EL', 'LOS', 'LAS', 'Y', 'DEL']);

/**
 * ¿El estado de cuenta es de la empresa? Todas las palabras del nombre del
 * titular (nombre fiscal o legal) aparecen en el texto, o aparece su DUI.
 */
export function statementBelongsTo(text: string, names: Array<string | null | undefined>, dui: string | null | undefined): boolean {
  const t = norm(text).replace(/[^A-Z0-9]+/g, ' ');
  const words = new Set(t.split(' '));
  for (const n of names) {
    const tokens = norm(n ?? '').replace(/[^A-Z0-9]+/g, ' ').split(' ').filter(w => w.length > 1 && !STOP.has(w));
    if (tokens.length >= 2 && tokens.every(w => words.has(w))) return true;
  }
  const d = (dui ?? '').replace(/\D/g, '');
  if (d.length === 9 && (text.includes(`${d.slice(0, 8)}-${d[8]}`) || new RegExp(`(^|\\D)${d}(\\D|$)`).test(text))) return true;
  return false;
}

/** Contraseñas habituales de los estados de cuenta: DUI y NIT con y sin guion. */
export function statementPasswords(dui: string | null | undefined, nit: string | null | undefined): string[] {
  const out: string[] = [];
  const d = (dui ?? '').replace(/\D/g, '');
  if (d.length === 9) out.push(d, `${d.slice(0, 8)}-${d[8]}`, d.slice(0, 8));
  const n = (nit ?? '').replace(/\D/g, '');
  if (n.length === 14) out.push(n, `${n.slice(0, 4)}-${n.slice(4, 10)}-${n.slice(10, 13)}-${n[13]}`);
  else if (n.length === 9 && n !== d) out.push(n, `${n.slice(0, 8)}-${n[8]}`);
  return out;
}

/** Sello de recepción del MH impreso en el PDF: año + 32 hexadecimales + 4 caracteres (40). */
export function stampInPdfText(text: string): string | null {
  const m = /\b(20\d{2}[0-9A-F]{32}[0-9A-Z]{4})\b/.exec(text.toUpperCase());
  return m ? m[1]! : null;
}

/**
 * Busca el sello de un DTE en los PDF que lo acompañan: el PDF que menciona su
 * código de generación o número de control; con un solo JSON y un solo PDF, ese.
 */
export function makeStampLookup(loadTexts: () => Promise<string[]>, allowSingle: boolean): (code: string, control: string | null) => Promise<string | null> {
  let texts: Promise<string[]> | null = null;
  const norm = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return async (code, control) => {
    texts ??= loadTexts().catch(() => []);
    const all = await texts;
    const mine = all.find(t => norm(t).includes(norm(code)) || (control && norm(t).includes(norm(control)))) ?? (allowSingle && all.length === 1 ? all[0] : undefined);
    return mine ? stampInPdfText(mine) : null;
  };
}
