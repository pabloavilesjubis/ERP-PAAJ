/** Formato contable: 1,234.56 con negativos entre paréntesis. */
export function money(n: number | string | null | undefined, opts: { blankZero?: boolean } = {}): string {
  const v = typeof n === 'number' ? n : parseFloat(String(n ?? '0'));
  if (!Number.isFinite(v) || (opts.blankZero && Math.abs(v) < 0.005)) return opts.blankZero ? '' : '0.00';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${s})` : s;
}

export const money2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function num(v: string | number | null | undefined): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

/** 'YYYY-MM-DD…' → 'DD/MM/YYYY' sin pasar por Date (evita el corrimiento de zona horaria). */
export function dmy(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

export function entryNo(n: number | string | null | undefined): string {
  return n === null || n === undefined ? '—' : String(n).padStart(6, '0');
}

export const MONTHS_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

export const STATUS_LABEL: Record<string, string> = {
  borrador: 'Borrador', contabilizado: 'Contabilizado', revisado: 'Revisado', anulado: 'Anulado',
};

export const KIND_LABEL: Record<string, string> = {
  ajuste: 'Ajuste', reclasificacion: 'Reclasificación', depreciacion: 'Depreciación', provision: 'Provisión',
  correccion: 'Corrección', cierre: 'Cierre', apertura: 'Apertura', otro: 'Otro',
};

export const MODULE_LABEL: Record<string, string> = {
  manual: 'Partida manual', ventas: 'Ventas', compras: 'Compras', cxc: 'Cuentas por cobrar', cxp: 'Cuentas por pagar',
  bancos: 'Bancos', planilla: 'Planillas', activos: 'Activos fijos', fiscal: 'Impuestos', cierre: 'Cierre anual',
};
