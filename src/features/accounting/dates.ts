/** Fechas ISO (YYYY-MM-DD) en hora local de El Salvador, sin Date en UTC. */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function monthRange(year: number, month: number): { from: string; to: string } {
  const last = new Date(year, month, 0).getDate();
  const mm = String(month).padStart(2, '0');
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, '0')}` };
}
export function currentMonth(): { from: string; to: string } {
  const d = new Date();
  return monthRange(d.getFullYear(), d.getMonth() + 1);
}
export function previousMonth(): { from: string; to: string } {
  const d = new Date();
  const m = d.getMonth() === 0 ? 12 : d.getMonth();
  const y = d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear();
  return monthRange(y, m);
}
export function yearRange(year: number): { from: string; to: string } {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}
export function dayBefore(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y!, m! - 1, d! - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
