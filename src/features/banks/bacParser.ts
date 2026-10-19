// =============================================================================
// Estado de cuenta del Banco de América Central (BAC) — portado tal cual de
// ChuchoWash (shared/banks/bacParser.ts), que a su vez sigue a Airbox.
//
//   SECCIÓN 1 — Encabezado de cuenta:
//     Número de Clientes, Nombre, Producto, Moneda, Saldo Inicial, Saldo en
//     Libros, Retenidos y Diferidos, Saldo Disponible, Fecha, STBGAV, STBUNC, Mensaje1..6
//   SECCIÓN 2 — Detalle de Estado Bancario:
//     Fecha de Transacción, Referencia de Transacción, Código de Transacción,
//     Descripción de Transacción, Débito de Transacción, Crédito de Transacción,
//     Balance de Transacción
//   SECCIÓN 3 — Resumen de Estado Bancario (la última fila es "Total, ...")
//
// Dates come as DD/MM/YYYY and are normalized to ISO. BAC exports in
// Windows-1252: decode with decodeBankFile() before parsing.
// =============================================================================

export interface ParsedBankMovement {
  transactionDate: string
  bankReference?: string
  bankCodeRaw?: string
  description?: string
  debit: number
  credit: number
  balanceCsv?: number
}

export interface ParsedBankStatement {
  bankCode: 'BAC'
  accountNumberFromFile: string
  holderName?: string
  currency: string
  saldoInicial?: number
  saldoDisponible?: number
  fechaCorte?: string
  movements: ParsedBankMovement[]
  totales?: { parsedDebits: number; parsedCredits: number; reportedDebits: number; reportedCredits: number; ok: boolean }
  warnings: string[]
}

const BANK_CODE = 'BAC' as const

/** BAC exports Windows-1252: UTF-8 first, Windows-1252 when that leaves replacement characters */
export function decodeBankFile(bytes: ArrayBuffer): string {
  const utf8 = new TextDecoder('utf-8').decode(bytes)
  return utf8.includes('\uFFFD') ? new TextDecoder('windows-1252').decode(bytes) : utf8
}

/** 0-1: how sure the text is a BAC statement */
export function detectBAC(text: string): number {
  if (headerHas(text, 'Número de Clientes', 'Producto')) return 1
  if (headerHas(text, 'Fecha de Transacción', 'Débito de Transacción')) return 0.9
  return 0
}

// ── CSV parsing primitivos ──────────────────────────────────────────────────
// Esto NO usa papaparse: BAC mete secciones (no es CSV "limpio") y los
// campos están separados por ", " con espacios variables. Hacemos un split
// por coma respetando comillas y luego trim() de cada celda.

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      // Comilla escapada "" dentro de campo entrecomillado.
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; continue; }
      inQuotes = !inQuotes;
      continue;
    }
    if (c === ',' && !inQuotes) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

function parseNumber(s: string | undefined): number {
  if (!s) return 0;
  // BAC usa punto como separador decimal y a veces comas como miles.
  const cleaned = s.replace(/[, ]/g, '').replace(/[^\d.\-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parseOptionalNumber(s: string | undefined): number | undefined {
  if (!s || !s.trim()) return undefined;
  const n = parseNumber(s);
  return Number.isFinite(n) ? n : undefined;
}

/** DD/MM/YYYY → YYYY-MM-DD. Si no parsea, devuelve undefined. */
function ddmmyyyyToIso(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return undefined;
  const dd = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  const yyyy = m[3];
  return `${yyyy}-${mm}-${dd}`;
}

/** Trim + colapso de espacios internos. La descripción del banco viene
 *  con espacios al final tipo "TEF UNI DE: ANRA S.A DE C.V   ". */
function tidyText(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 0 ? t : undefined;
}

// ── Normalización tolerante a acentos / case / espacios ─────────────────────
//
// El CSV puede llegar con encoding Latin-1/Windows-1252 (acentos rotos),
// con variantes del título ("Detalle de Estado" vs "Detalle del Estado"),
// o sin líneas en blanco entre secciones. Toda la detección pasa por
// `norm()` para minimizar fragilidad.

function norm(s: string): string {
  return s
    .normalize('NFD')                  // descompone acentos
    .replace(/[\u0300-\u036f]/g, '')   // los quita
    .replace(/\uFFFD/g, '')            // quita replacement char (encoding malo)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isDetailTitle(line: string): boolean {
  const n = norm(line);
  return n.includes('detalle') && n.includes('estado') && n.includes('bancari');
}

function isSummaryTitle(line: string): boolean {
  const n = norm(line);
  return n.includes('resumen') && n.includes('estado') && n.includes('bancari');
}

function isAccountHeader(line: string): boolean {
  const n = norm(line);
  // El header de la sección de cuenta siempre menciona "producto" y "saldo".
  return n.includes('producto') && n.includes('saldo');
}

function isDetailHeader(line: string): boolean {
  const n = norm(line);
  return n.includes('fecha') && n.includes('transaccion')
    && (n.includes('debito') || n.includes('credito'));
}

function isSummaryHeader(line: string): boolean {
  const n = norm(line);
  return n.includes('codigo') && n.includes('totales')
    && (n.includes('debito') || n.includes('credito'));
}

// ── Tokenizar el archivo en secciones ──────────────────────────────────────
//
// Estrategia robusta: ignoramos las líneas en blanco como separador y
// detectamos las 3 secciones por el contenido de sus títulos o headers,
// recorriendo el archivo línea por línea. Cualquier variación de blanks
// no rompe el parser.

interface RawSection {
  /** Header de columnas (CSV line) */
  header: string;
  /** Filas posteriores (sin header) */
  rows: string[];
}

function splitSections(fileText: string): RawSection[] {
  // Normalizar EOLs y eliminar BOM si existe.
  const text = fileText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const allLines = text.split('\n')
    .map(l => l.replace(/^\uFEFF/, ''))
    .filter(l => l.trim() !== '');

  const sections: RawSection[] = [];

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];

    // ── Caso A: línea de TÍTULO ("Detalle de Estado Bancario") seguida por
    //    su header de columnas y luego sus filas hasta el próximo título.
    if (isDetailTitle(line) || isSummaryTitle(line)) {
      const header = allLines[i + 1] ?? '';
      const rows: string[] = [];
      let j = i + 2;
      while (j < allLines.length) {
        if (isDetailTitle(allLines[j]) || isSummaryTitle(allLines[j])) break;
        rows.push(allLines[j]);
        j++;
      }
      sections.push({ header, rows });
      i = j - 1;
      continue;
    }

    // ── Caso B: HEADER de columnas directo (sin línea de título). Pasa con
    //    la sección 1 (encabezado de cuenta) y también con archivos que el
    //    banco exportó sin el título intermedio.
    if (isAccountHeader(line)) {
      const rows: string[] = [];
      // Para la sección de cuenta esperamos UNA sola fila de datos. Pero
      // somos tolerantes: tomamos todas las filas hasta el próximo
      // título o header reconocido.
      let j = i + 1;
      while (j < allLines.length) {
        if (
          isDetailTitle(allLines[j]) || isSummaryTitle(allLines[j])
          || isDetailHeader(allLines[j]) || isSummaryHeader(allLines[j])
        ) break;
        rows.push(allLines[j]);
        j++;
      }
      sections.push({ header: line, rows });
      i = j - 1;
      continue;
    }

    if (isDetailHeader(line)) {
      const rows: string[] = [];
      let j = i + 1;
      while (j < allLines.length) {
        if (isDetailTitle(allLines[j]) || isSummaryTitle(allLines[j]) || isSummaryHeader(allLines[j])) break;
        rows.push(allLines[j]);
        j++;
      }
      sections.push({ header: line, rows });
      i = j - 1;
      continue;
    }

    if (isSummaryHeader(line)) {
      const rows: string[] = [];
      let j = i + 1;
      while (j < allLines.length) {
        if (isDetailTitle(allLines[j]) || isSummaryTitle(allLines[j]) || isDetailHeader(allLines[j])) break;
        rows.push(allLines[j]);
        j++;
      }
      sections.push({ header: line, rows });
      i = j - 1;
      continue;
    }
  }

  return sections;
}

// ── Detección de cada sección por palabras clave del header ─────────────────

function headerHas(header: string, ...needles: string[]): boolean {
  const n = norm(header);
  return needles.every(needle => n.includes(norm(needle)));
}

function findColIndex(headerCells: string[], ...needles: string[]): number {
  return headerCells.findIndex(c => {
    const n = norm(c);
    return needles.every(needle => n.includes(norm(needle)));
  });
}

export function parseBAC(fileText: string): ParsedBankStatement {
  const warnings: string[] = [];
  const sections = splitSections(fileText);

  // Encontrar las 3 secciones por sus heuristics de header.
  let accountSec: RawSection | undefined;
  let detailSec:  RawSection | undefined;
  let summarySec: RawSection | undefined;

  for (const s of sections) {
    if (headerHas(s.header, 'Número de Clientes', 'Producto')) accountSec = s;
    else if (headerHas(s.header, 'Fecha de Transacción', 'Débito de Transacción')) detailSec = s;
    else if (headerHas(s.header, 'Cantidad Débitos Totales', 'Montos Créditos Totales')) summarySec = s;
    else if (headerHas(s.header, 'Producto', 'Saldo Disponible')) accountSec = accountSec ?? s;
  }

  if (!accountSec) {
    throw new Error(
      'No se encontró encabezado de cuenta en el archivo BAC. ' +
      `Secciones detectadas: ${sections.length}. ` +
      `Headers vistos: ${sections.map(s => `"${s.header.slice(0, 80)}"`).join(' | ') || '(ninguno)'}`
    );
  }
  if (!detailSec) {
    throw new Error(
      'No se encontró el bloque de Detalle de Estado Bancario. ' +
      `Secciones detectadas: ${sections.length}. ` +
      `Headers vistos: ${sections.map(s => `"${s.header.slice(0, 80)}"`).join(' | ') || '(ninguno)'}. ` +
      'Si el archivo viene de BAC pero el formato cambió, mándamelo y ajusto el parser.'
    );
  }

  // ── Sección 1: encabezado de cuenta ─────────────────────────────────────
  const accHeader = splitCsvLine(accountSec.header);
  const accRow    = splitCsvLine(accountSec.rows[0] ?? '');
  const get = (...needles: string[]): string | undefined => {
    const i = findColIndex(accHeader, ...needles);
    return i >= 0 ? accRow[i] : undefined;
  };

  const accountNumberFromFile = (get('Producto') ?? '').trim();
  const holderName            = tidyText(get('Nombre'));
  const currency              = (get('Moneda') ?? 'USD').trim() || 'USD';
  const saldoInicial          = parseOptionalNumber(get('Saldo', 'Inicial'));
  const saldoDisponible       = parseOptionalNumber(get('Saldo', 'Disponible'));
  const fechaCorte            = ddmmyyyyToIso(get('Fecha'));

  if (!accountNumberFromFile) {
    warnings.push('No se pudo leer el número de cuenta (columna Producto) del encabezado.');
  }

  // ── Sección 2: movimientos ──────────────────────────────────────────────
  const detHeader = splitCsvLine(detailSec.header);
  const cFecha   = findColIndex(detHeader, 'Fecha', 'Transacción');
  const cRef     = findColIndex(detHeader, 'Referencia');
  const cCodigo  = findColIndex(detHeader, 'Código');
  const cDesc    = findColIndex(detHeader, 'Descripción');
  const cDebito  = findColIndex(detHeader, 'Débito');
  const cCredito = findColIndex(detHeader, 'Crédito');
  const cBalance = findColIndex(detHeader, 'Balance');

  if (cFecha < 0 || cDebito < 0 || cCredito < 0) {
    throw new Error('Columnas requeridas faltantes en Detalle de Estado Bancario.');
  }

  const movements: ParsedBankMovement[] = [];
  for (const row of detailSec.rows) {
    if (!row.trim()) continue;
    const cells = splitCsvLine(row);
    const fechaIso = ddmmyyyyToIso(cells[cFecha]);
    if (!fechaIso) {
      warnings.push(`Fila ignorada por fecha inválida: ${row.slice(0, 60)}…`);
      continue;
    }
    movements.push({
      transactionDate: fechaIso,
      bankReference:   cRef >= 0 ? (tidyText(cells[cRef])) : undefined,
      bankCodeRaw:     cCodigo >= 0 ? tidyText(cells[cCodigo]) : undefined,
      description:     cDesc >= 0 ? tidyText(cells[cDesc]) : undefined,
      debit:           cDebito >= 0  ? parseNumber(cells[cDebito])  : 0,
      credit:          cCredito >= 0 ? parseNumber(cells[cCredito]) : 0,
      balanceCsv:      cBalance >= 0 ? parseOptionalNumber(cells[cBalance]) : undefined,
    });
  }

  // ── Sección 3: validación de totales (opcional) ─────────────────────────
  let totales: ParsedBankStatement['totales'];
  if (summarySec) {
    const sumHeader = splitCsvLine(summarySec.header);
    const cMontoDeb = findColIndex(sumHeader, 'Montos Débitos');
    const cMontoCre = findColIndex(sumHeader, 'Montos Créditos');
    const cCodTot   = findColIndex(sumHeader, 'Código');

    // La fila "Total" del banco trae los totales globales.
    const totalRow = summarySec.rows.find(r => {
      const cells = splitCsvLine(r);
      return (cells[cCodTot] ?? '').trim().toLowerCase() === 'total';
    });
    if (totalRow) {
      const cells = splitCsvLine(totalRow);
      const reportedDebits  = cMontoDeb >= 0 ? parseNumber(cells[cMontoDeb]) : 0;
      const reportedCredits = cMontoCre >= 0 ? parseNumber(cells[cMontoCre]) : 0;
      const parsedDebits  = movements.reduce((s, m) => s + m.debit, 0);
      const parsedCredits = movements.reduce((s, m) => s + m.credit, 0);
      const ok =
        Math.abs(parsedDebits  - reportedDebits)  < 0.01 &&
        Math.abs(parsedCredits - reportedCredits) < 0.01;
      totales = {
        parsedDebits:  Number(parsedDebits.toFixed(2)),
        parsedCredits: Number(parsedCredits.toFixed(2)),
        reportedDebits,
        reportedCredits,
        ok,
      };
      if (!ok) {
        warnings.push(
          `Totales no cuadran. Débitos: parsed=${parsedDebits.toFixed(2)} vs ` +
          `reportado=${reportedDebits.toFixed(2)}. Créditos: parsed=${parsedCredits.toFixed(2)} ` +
          `vs reportado=${reportedCredits.toFixed(2)}.`
        );
      }
    }
  }

  return {
    bankCode: BANK_CODE,
    accountNumberFromFile,
    holderName,
    currency,
    saldoInicial,
    saldoDisponible,
    fechaCorte,
    movements,
    totales,
    warnings,
  };
}
