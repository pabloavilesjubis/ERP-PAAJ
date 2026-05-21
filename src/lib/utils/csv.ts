import Papa from 'papaparse';
import { num, newId } from './format';
import type {
  Compra, Contribuyente, ContribuyenteTipo,
  VentaConsumidor, VentaContribuyente,
} from '@/types/domain';

export interface CsvTemplate<T> {
  key: string;
  label: string;
  description: string;
  filename: (period: { month: number; year: number }) => string;
  headers: string[];
  toRow: (record: T) => Record<string, string | number>;
  fromRow: (row: Record<string, string>) => T | null;
  sample: T[];
}

const pad = (n: number) => String(n).padStart(2, '0');

export const ventasConsumidorTemplate: CsvTemplate<VentaConsumidor> = {
  key: 'ventas_consumidor',
  label: 'Ventas al consumidor (FE)',
  description: 'Facturas Electrónicas a consumidor final con IVA incluido.',
  filename: ({ month, year }) => `ventas_consumidor_${year}-${pad(month + 1)}.csv`,
  headers: ['fecha', 'descripcion', 'monto', 'notas'],
  toRow: r => ({ fecha: r.fecha, descripcion: r.descripcion, monto: num(r.monto), notas: r.notas ?? '' }),
  fromRow: row => {
    if (!row.fecha || !row.monto) return null;
    return {
      id: newId(),
      fecha: row.fecha,
      descripcion: row.descripcion ?? '',
      monto: String(num(row.monto)),
      notas: row.notas ?? '',
    };
  },
  sample: [
    { id: '1', fecha: '2026-04-03', descripcion: 'Venta mostrador', monto: '1250.00', notas: '' },
  ],
};

export const ventasContribuyenteTemplate: CsvTemplate<VentaContribuyente> = {
  key: 'ventas_contribuyente',
  label: 'Ventas al contribuyente (CCF)',
  description: 'Comprobantes de Crédito Fiscal con monto gravado y exento separados.',
  filename: ({ month, year }) => `ventas_contribuyente_${year}-${pad(month + 1)}.csv`,
  headers: ['fecha', 'cliente', 'nrc', 'descripcion', 'gravado', 'exento', 'notas'],
  toRow: r => ({
    fecha: r.fecha, cliente: r.cliente, nrc: r.nrc, descripcion: r.descripcion,
    gravado: num(r.gravado), exento: num(r.exento), notas: r.notas ?? '',
  }),
  fromRow: row => {
    if (!row.fecha || !row.gravado) return null;
    return {
      id: newId(),
      fecha: row.fecha,
      cliente: row.cliente ?? '',
      nrc: row.nrc ?? '',
      descripcion: row.descripcion ?? '',
      gravado: String(num(row.gravado)),
      exento: String(num(row.exento ?? '0')),
      notas: row.notas ?? '',
    };
  },
  sample: [
    { id: '1', fecha: '2026-04-05', cliente: 'Constructora ABC', nrc: '123456-7', descripcion: 'Materiales', gravado: '5800', exento: '0', notas: '' },
  ],
};

export const comprasTemplate: CsvTemplate<Compra> = {
  key: 'compras',
  label: 'Compras y costos',
  description: 'Crédito fiscal de compras. Si dejas IVA crédito vacío se calcula automáticamente.',
  filename: ({ month, year }) => `compras_${year}-${pad(month + 1)}.csv`,
  headers: ['fecha', 'proveedor', 'nrc', 'descripcion', 'monto', 'iva_credito', 'notas'],
  toRow: r => ({
    fecha: r.fecha, proveedor: r.proveedor, nrc: r.nrc, descripcion: r.descripcion,
    monto: num(r.monto), iva_credito: num(r.ivaCredito), notas: r.notas ?? '',
  }),
  fromRow: row => {
    if (!row.fecha || !row.monto) return null;
    const monto = num(row.monto);
    const iva = row.iva_credito ? num(row.iva_credito) : (monto * 0.13) / 1.13;
    return {
      id: newId(),
      fecha: row.fecha,
      proveedor: row.proveedor ?? '',
      nrc: row.nrc ?? '',
      descripcion: row.descripcion ?? '',
      monto: String(monto),
      ivaCredito: String(iva.toFixed(2)),
      notas: row.notas ?? '',
    };
  },
  sample: [
    { id: '1', fecha: '2026-04-02', proveedor: 'Distribuidora', nrc: '987654-3', descripcion: 'Inventario', monto: '3200', ivaCredito: '416', notas: '' },
  ],
};

export const contribuyentesTemplate: CsvTemplate<Contribuyente> = {
  key: 'contribuyentes',
  label: 'Contribuyentes',
  description: 'Catálogo de clientes y proveedores. NIT y DUI son alternativos — usa NIT para jurídicas y DUI para personas naturales (necesario para F-14).',
  filename: () => `contribuyentes.csv`,
  headers: ['nombre', 'nit', 'dui', 'nrc', 'tipo', 'giro', 'telefono', 'email', 'direccion'],
  toRow: r => ({
    nombre: r.nombre, nit: r.nit, dui: r.dui ?? '', nrc: r.nrc, tipo: r.tipo,
    giro: r.giro ?? '', telefono: r.telefono ?? '', email: r.email ?? '', direccion: r.direccion ?? '',
  }),
  fromRow: row => {
    if (!row.nombre || !row.nrc) return null;
    const tipo = (row.tipo ?? 'Cliente') as ContribuyenteTipo;
    return {
      id: newId(),
      nombre: row.nombre,
      nit: row.nit ?? '',
      dui: row.dui || undefined,
      nrc: row.nrc,
      giro: row.giro ?? '',
      telefono: row.telefono ?? '',
      email: row.email ?? '',
      direccion: row.direccion ?? '',
      tipo: ['Cliente', 'Proveedor', 'Ambos'].includes(tipo) ? tipo : 'Cliente',
    };
  },
  sample: [
    { id: '1', nombre: 'Constructora ABC', nit: '0614-010190-001-2', dui: '', nrc: '123456-7', tipo: 'Cliente', giro: 'Construcción', telefono: '2234-5678', email: 'a@b.com', direccion: 'San Salvador' },
    { id: '2', nombre: 'Juan Pérez (consultor)', nit: '', dui: '01234567-8', nrc: '', tipo: 'Proveedor', giro: 'Servicios profesionales', telefono: '', email: '', direccion: '' },
  ],
};

export const csvTemplates = {
  ventas_consumidor: ventasConsumidorTemplate,
  ventas_contribuyente: ventasContribuyenteTemplate,
  compras: comprasTemplate,
  contribuyentes: contribuyentesTemplate,
} as const;

export type CsvTemplateKey = keyof typeof csvTemplates;

export function exportCsv<T>(template: CsvTemplate<T>, records: T[], period: { month: number; year: number }): void {
  const csv = Papa.unparse({
    fields: template.headers,
    data: records.map(r => template.headers.map(h => template.toRow(r)[h] ?? '')),
  });
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = template.filename(period);
  a.click();
  URL.revokeObjectURL(url);
}

export function exportSampleCsv<T>(template: CsvTemplate<T>): void {
  const csv = Papa.unparse({
    fields: template.headers,
    data: template.sample.map(r => template.headers.map(h => template.toRow(r)[h] ?? '')),
  });
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `modelo_${template.key}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export interface ImportResult<T> {
  ok: T[];
  errors: { row: number; reason: string }[];
}

export function parseCsv<T>(file: File, template: CsvTemplate<T>): Promise<ImportResult<T>> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: h => h.trim().toLowerCase(),
      complete: results => {
        const ok: T[] = [];
        const errors: { row: number; reason: string }[] = [];
        results.data.forEach((row, i) => {
          try {
            const parsed = template.fromRow(row);
            if (parsed) ok.push(parsed);
            else errors.push({ row: i + 2, reason: 'Faltan campos requeridos' });
          } catch (e) {
            errors.push({ row: i + 2, reason: e instanceof Error ? e.message : 'Error de parseo' });
          }
        });
        resolve({ ok, errors });
      },
      error: reject,
    });
  });
}
