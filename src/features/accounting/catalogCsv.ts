import Papa from 'papaparse';
import type { ImportRow } from './api';
import type { Account } from './types';

/**
 * Lectura del catálogo en CSV. Acepta el formato de ChuchoWash y variantes
 * comunes (encabezados con o sin tilde, ; o , como separador, SI/NO).
 * Mínimo: código, nombre y tipo de cuenta; lo demás se deriva.
 */

const HEADERS: Record<keyof ImportRow, string[]> = {
  code: ['codigo', 'código', 'code', 'cuenta', 'codigo_cuenta'],
  name: ['nombre', 'name', 'descripcion', 'descripción', 'nombre_cuenta'],
  account_type: ['tipo_cuenta', 'tipo', 'account_type', 'tipo de cuenta'],
  nature: ['naturaleza', 'nature'],
  parent_code: ['cuenta_padre', 'padre', 'parent', 'parent_code'],
  financial_statement: ['estado_financiero', 'estado', 'financial_statement'],
  allows_movements: ['permite_movimientos', 'movimiento', 'allows_movements', 'nivel_uso'],
  is_active: ['activa', 'activo', 'is_active'],
  balance_term: ['clasificacion', 'clasificación', 'corriente', 'balance_term'],
  result_section: ['seccion_resultado', 'sección_resultado', 'result_section'],
};

const norm = (h: string) => h.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '_');

function yesNo(v: string | undefined): boolean | null {
  if (v === undefined) return null;
  const t = norm(v);
  if (!t) return null;
  if (['si', 's', 'yes', 'true', '1', 'x', 'movimiento', 'detalle'].includes(t)) return true;
  if (['no', 'n', 'false', '0', 'mayor', 'agrupadora', 'grupo'].includes(t)) return false;
  return null;
}

function term(v: string | undefined): 'corriente' | 'no_corriente' | null {
  if (!v) return null;
  const t = norm(v);
  if (t === 'corriente') return 'corriente';
  if (t === 'no_corriente' || t === 'nocorriente') return 'no_corriente';
  return null;
}

export interface ParsedCatalog { rows: ImportRow[]; errors: string[] }

export function parseCatalogCsv(text: string): ParsedCatalog {
  const res = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy', transformHeader: norm });
  const fields = (res.meta.fields ?? []).map(norm);
  const col = (k: keyof ImportRow) => HEADERS[k].map(norm).find(h => fields.includes(h));
  const errors: string[] = [];
  const cCode = col('code'), cName = col('name'), cType = col('account_type');
  if (!cCode || !cName || !cType) {
    errors.push('El archivo debe tener columnas de código, nombre y tipo de cuenta (codigo, nombre, tipo_cuenta).');
    return { rows: [], errors };
  }
  const get = (r: Record<string, string>, k: keyof ImportRow) => { const c = col(k); return c ? (r[c] ?? '').trim() : undefined; };
  const rows: ImportRow[] = [];
  res.data.forEach((r, i) => {
    const code = get(r, 'code') ?? '';
    const name = get(r, 'name') ?? '';
    if (!code && !name) return;
    if (!code || !name) { errors.push(`Fila ${i + 2}: falta código o nombre`); return; }
    if (!/^[0-9]+([.-][0-9]+)*$/.test(code)) { errors.push(`Fila ${i + 2}: código inválido «${code}»`); return; }
    rows.push({
      code, name,
      account_type: get(r, 'account_type') ?? '',
      nature: get(r, 'nature') || null,
      parent_code: get(r, 'parent_code') || null,
      financial_statement: get(r, 'financial_statement') || null,
      allows_movements: yesNo(get(r, 'allows_movements')),
      is_active: yesNo(get(r, 'is_active')),
      balance_term: term(get(r, 'balance_term')),
      result_section: get(r, 'result_section') || null,
    });
  });
  return { rows, errors };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function catalogToCsv(accounts: Account[]): string {
  const byId = new Map(accounts.map(a => [a.id, a]));
  const header = ['codigo', 'nombre', 'tipo_cuenta', 'naturaleza', 'cuenta_padre', 'estado_financiero', 'permite_movimientos', 'activa', 'clasificacion', 'seccion_resultado'];
  const lines = accounts.map(a => [
    a.code, a.name, a.account_type, a.nature, a.parent_id ? byId.get(a.parent_id)?.code ?? '' : '',
    a.financial_statement, a.allows_movements ? 'SI' : 'NO', a.is_active ? 'SI' : 'NO', a.balance_term ?? '', a.result_section ?? '',
  ].map(csvCell).join(','));
  return [header.join(','), ...lines].join('\r\n');
}

export const CATALOG_TEMPLATE = [
  'codigo,nombre,tipo_cuenta,naturaleza,cuenta_padre,estado_financiero,permite_movimientos,activa,clasificacion',
  '1,ACTIVO,Activo,Deudora,,Balance,NO,SI,',
  '1.1,ACTIVO CORRIENTE,Activo,Deudora,1,Balance,NO,SI,corriente',
  '1.1.01,Caja general,Activo,Deudora,1.1,Balance,SI,SI,',
  '1.1.02,Bancos,Activo,Deudora,1.1,Balance,SI,SI,',
  '2,PASIVO,Pasivo,Acreedora,,Balance,NO,SI,',
  '2.1,PASIVO CORRIENTE,Pasivo,Acreedora,2,Balance,NO,SI,corriente',
  '2.1.01,Proveedores,Pasivo,Acreedora,2.1,Balance,SI,SI,',
  '3,PATRIMONIO,Patrimonio,Acreedora,,Balance,NO,SI,',
  '3.1,Capital social,Patrimonio,Acreedora,3,Balance,SI,SI,',
  '4,COSTOS Y GASTOS,Gasto,Deudora,,ER,NO,SI,',
  '4.1,Gastos de administración,Gasto,Deudora,4,ER,SI,SI,',
  '5,INGRESOS,Ingreso,Acreedora,,ER,NO,SI,',
  '5.1,Ventas,Ingreso,Acreedora,5,ER,SI,SI,',
].join('\r\n');

export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob(['﻿' + text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
