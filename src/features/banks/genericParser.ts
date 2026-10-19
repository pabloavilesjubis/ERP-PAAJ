import Papa from 'papaparse';

/**
 * Lector CSV configurable para bancos sin lector propio (Agrícola,
 * Davivienda, Cuscatlán…). Cada cuenta bancaria guarda su mapeo de columnas
 * (por nombre de encabezado) y formato de fecha; el usuario lo ajusta la
 * primera vez viendo una vista previa del archivo.
 */
export interface CsvMapping {
  delimiter?: string;
  skip_rows?: number;
  date_col?: string;
  date_format?: 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD';
  description_col?: string;
  reference_col?: string;
  debit_col?: string;
  credit_col?: string;
  /** Monto con signo (negativo = cargo) cuando el banco usa una sola columna. */
  amount_col?: string;
  balance_col?: string;
}

export interface StatementRow { date: string; reference?: string; code?: string; description?: string; debit: number; credit: number; balance?: number }
export interface ParsedStatement { rows: StatementRow[]; warnings: string[]; accountNumber?: string; opening?: number; closing?: number; totalsOk?: boolean }

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export function parseAmount(s: string | undefined): number {
  if (!s) return 0;
  let t = s.replace(/[$\s]/g, '');
  const neg = /^\(.*\)$/.test(t) || /-$/.test(t) || /^-/.test(t);
  t = t.replace(/[()-]/g, '');
  // 1.234,56 (coma decimal) vs 1,234.56
  if (/,\d{1,2}$/.test(t) && t.includes('.')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/,\d{1,2}$/.test(t) && !t.includes('.')) t = t.replace(',', '.');
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? (neg ? -n : n) : 0;
}

export function parseDate(s: string | undefined, fmt: CsvMapping['date_format'] = 'DD/MM/YYYY'): string | null {
  if (!s) return null;
  const t = s.trim().slice(0, 10);
  if (fmt === 'YYYY-MM-DD') { const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(t); return m ? `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}` : null; }
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(t);
  if (!m) return null;
  const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
  const [d, mo] = fmt === 'MM/DD/YYYY' ? [m[2]!, m[1]!] : [m[1]!, m[2]!];
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** Filas crudas (para la vista previa y para elegir columnas). */
export function previewCsv(text: string, mapping: CsvMapping): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n').slice(mapping.skip_rows ?? 0).join('\n');
  const res = Papa.parse<Record<string, string>>(lines, { header: true, skipEmptyLines: 'greedy', delimiter: mapping.delimiter || undefined });
  return { headers: (res.meta.fields ?? []).filter(Boolean), rows: res.data };
}

/** Adivina el mapeo por nombres de columna comunes. */
export function guessMapping(headers: string[]): CsvMapping {
  const find = (...needles: string[]) => headers.find(h => needles.some(n => norm(h).includes(n)));
  return {
    date_col: find('fecha', 'date'),
    description_col: find('descrip', 'concepto', 'detalle', 'transaccion'),
    reference_col: find('referencia', 'documento', 'ref', 'numero'),
    debit_col: find('debito', 'cargo', 'retiro', 'debit'),
    credit_col: find('credito', 'abono', 'deposito', 'credit'),
    balance_col: find('saldo', 'balance'),
    date_format: 'DD/MM/YYYY',
  };
}

export function parseGeneric(text: string, mapping: CsvMapping): ParsedStatement {
  const { rows } = previewCsv(text, mapping);
  const warnings: string[] = [];
  if (!mapping.date_col) return { rows: [], warnings: ['Elige la columna de fecha'] };
  if (!mapping.amount_col && !mapping.debit_col && !mapping.credit_col) return { rows: [], warnings: ['Elige las columnas de débito/crédito o la de monto'] };
  const out: StatementRow[] = [];
  rows.forEach((r, i) => {
    const date = parseDate(r[mapping.date_col!], mapping.date_format);
    if (!date) { if (Object.values(r).some(v => v?.trim())) warnings.push(`Fila ${i + 1 + (mapping.skip_rows ?? 0)} sin fecha válida: ignorada`); return; }
    let debit = 0, credit = 0;
    if (mapping.amount_col) {
      const a = parseAmount(r[mapping.amount_col]);
      if (a < 0) debit = -a; else credit = a;
    } else {
      debit = Math.abs(parseAmount(mapping.debit_col ? r[mapping.debit_col] : undefined));
      credit = Math.abs(parseAmount(mapping.credit_col ? r[mapping.credit_col] : undefined));
    }
    if (!debit && !credit) return;
    out.push({
      date, debit: Math.round(debit * 100) / 100, credit: Math.round(credit * 100) / 100,
      description: mapping.description_col ? r[mapping.description_col]?.replace(/\s+/g, ' ').trim() : undefined,
      reference: mapping.reference_col ? r[mapping.reference_col]?.trim() : undefined,
      balance: mapping.balance_col && r[mapping.balance_col]?.trim() ? parseAmount(r[mapping.balance_col]) : undefined,
    });
  });
  return { rows: out, warnings };
}
