export function fmt(value: string | number | null | undefined): string {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function num(value: string | number | null | undefined): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Genera un UUID v4. Necesario porque las columnas `id` en Supabase son `uuid`
 * y Postgres rechaza cualquier string que no respete ese formato (8-4-4-4-12 hex).
 */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback para entornos sin crypto.randomUUID (raro hoy en día).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function toMonthKey(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Compara si una fecha ISO `YYYY-MM-DD` cae en el mes/año dados.
 *
 * IMPORTANTE: NO usamos `new Date(dateStr)` porque interpreta la cadena como
 * UTC medianoche y, en zonas horarias negativas (ej. El Salvador UTC-6),
 * desplaza el día 1 del mes al mes anterior. La comparación por string
 * es timezone-agnóstica.
 */
export function inPeriod(dateStr: string, month: number, year: number): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return false;
  return parseInt(m[1], 10) === year && parseInt(m[2], 10) === month + 1;
}

/** ¿Cae la fecha ISO en este año, sin importar el mes? */
export function inYear(dateStr: string, year: number): boolean {
  const m = /^(\d{4})/.exec(dateStr);
  if (!m) return false;
  return parseInt(m[1], 10) === year;
}

/** Filtro unificado que respeta el modo del period store. */
export function matchesPeriod(
  dateStr: string,
  mode: 'monthly' | 'annual',
  month: number,
  year: number,
): boolean {
  return mode === 'annual' ? inYear(dateStr, year) : inPeriod(dateStr, month, year);
}

/** ¿Cae la fecha ISO entre `desde` y `hasta` (ambos inclusivos, ISO)? */
export function inDateRange(dateStr: string, desde?: string, hasta?: string): boolean {
  if (!dateStr) return false;
  const d = dateStr.slice(0, 10);
  if (desde && d < desde) return false;
  if (hasta && d > hasta) return false;
  return true;
}

/**
 * Convierte fecha ISO `YYYY-MM-DD` a formato salvadoreño `DD/MM/AAAA`.
 * Devuelve la cadena original si no parsea.
 */
export function displayDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** Combina día/mes/año (strings o números) en `YYYY-MM-DD`. */
export function joinDate(dia: string | number, mes: string | number, anio: string | number): string {
  const dd = String(dia).padStart(2, '0');
  const mm = String(mes).padStart(2, '0');
  const yyyy = String(anio).padStart(4, '0');
  return `${yyyy}-${mm}-${dd}`;
}
