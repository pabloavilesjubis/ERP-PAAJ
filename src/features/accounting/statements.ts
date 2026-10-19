/**
 * Balanza y estados financieros (NIIF para las PYMES) a partir del catálogo y
 * los movimientos de un período. Funciones puras: las páginas solo dibujan.
 * Portado de ChuchoWash (financialStatements.ts / incomeStatement.ts) y
 * generalizado: la clasificación usa el TIPO de cuenta, no códigos fijos, así
 * sirve para el catálogo de cualquier empresa.
 */
import { money2 } from './format';
import type { Account, AccountMovement } from './types';

export interface Row { account: Account; debitBefore: number; creditBefore: number; debit: number; credit: number }

export const byCode = (a: Account, b: Account) => a.code.localeCompare(b.code, undefined, { numeric: true });

/** Suma los movimientos de cada cuenta hoja en todos sus ancestros. */
export function rollUp(accounts: Account[], moves: AccountMovement[]): Map<number, Row> {
  const byId = new Map(accounts.map(a => [a.id, a]));
  const out = new Map<number, Row>(accounts.map(a => [a.id, { account: a, debitBefore: 0, creditBefore: 0, debit: 0, credit: 0 }]));
  for (const m of moves) {
    let a = byId.get(m.account_id);
    while (a) {
      const r = out.get(a.id)!;
      r.debitBefore += m.debit_before; r.creditBefore += m.credit_before; r.debit += m.debit; r.credit += m.credit;
      a = a.parent_id ? byId.get(a.parent_id) : undefined;
    }
  }
  return out;
}

// ── Balanza de comprobación ──
export interface TrialLine {
  account: Account;
  openingDebit: number; openingCredit: number;
  debit: number; credit: number;
  closingDebit: number; closingCredit: number;
}
export interface TrialBalance {
  lines: TrialLine[];
  totals: Omit<TrialLine, 'account'>;
  balanced: { movements: boolean; opening: boolean; closing: boolean };
}

const split = (net: number) => ({ d: money2(Math.max(net, 0)), c: money2(Math.max(-net, 0)) });

export function trialBalance(rows: Map<number, Row>, opts: { maxLevel?: number; onlyWithBalance?: boolean } = {}): TrialBalance {
  const line = (r: Row): TrialLine => {
    const open = split(r.debitBefore - r.creditBefore);
    const close = split(r.debitBefore - r.creditBefore + r.debit - r.credit);
    return { account: r.account, openingDebit: open.d, openingCredit: open.c, debit: money2(r.debit), credit: money2(r.credit), closingDebit: close.d, closingCredit: close.c };
  };
  const all = [...rows.values()].sort((a, b) => byCode(a.account, b.account));
  const hasAnything = (l: TrialLine) => !!(l.openingDebit || l.openingCredit || l.debit || l.credit || l.closingDebit || l.closingCredit);
  const lines = all.map(line).filter(l => (!opts.maxLevel || l.account.level <= opts.maxLevel) && (!opts.onlyWithBalance || hasAnything(l)));
  // Totales solo con cuentas de movimiento (hojas): nada se cuenta dos veces
  const leaves = all.filter(r => r.account.allows_movements).map(line);
  const sum = (k: keyof Omit<TrialLine, 'account'>) => money2(leaves.reduce((s, l) => s + l[k], 0));
  const totals = {
    openingDebit: sum('openingDebit'), openingCredit: sum('openingCredit'), debit: sum('debit'), credit: sum('credit'),
    closingDebit: sum('closingDebit'), closingCredit: sum('closingCredit'),
  };
  return {
    lines, totals,
    balanced: { movements: totals.debit === totals.credit, opening: totals.openingDebit === totals.openingCredit, closing: totals.closingDebit === totals.closingCredit },
  };
}

// =============================================================================
// Reportes tabulares: una estructura común para pantalla, impresión y Excel
// =============================================================================
export interface ReportRow {
  label: string;
  code?: string;
  values: Array<number | null>;
  kind?: 'section' | 'line' | 'subtotal' | 'total';
  indent?: number;
}
export interface Report { title: string; columns: string[]; rows: ReportRow[]; checks?: Array<{ label: string; ok: boolean }> }

type Side = 'asset' | 'liability' | 'equity' | 'result';
const sideOf = (a: Account): Side => a.account_type === 'Activo' || a.account_type === 'Contraactivo' ? 'asset'
  : a.account_type === 'Pasivo' ? 'liability' : a.account_type === 'Patrimonio' ? 'equity' : 'result';

/** Corriente / no corriente: explícito en la cuenta, o deducido del nombre del grupo ("ACTIVO NO CORRIENTE"). */
function inferTerm(a: Account): { term: 'corriente' | 'no_corriente'; explicit: boolean } | null {
  if (a.balance_term) return { term: a.balance_term, explicit: true };
  // Solo grupos con nombres típicos; nunca una cuenta de movimiento ("Banco X cuenta corriente")
  if (a.allows_movements) return null;
  const n = a.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/(activos?|pasivos?)\s+no\s+(corrientes?|circulantes?)|largo\s+plazo|propiedad(es)?,?\s+planta|activos?\s+fijos?/.test(n)) return { term: 'no_corriente', explicit: false };
  if (/(activos?|pasivos?)\s+(corrientes?|circulantes?)|corto\s+plazo/.test(n)) return { term: 'corriente', explicit: false };
  return null;
}

function ancestors(a: Account, byId: Map<number, Account>): Account[] {
  const out: Account[] = [];
  for (let x: Account | undefined = a; x; x = x.parent_id ? byId.get(x.parent_id) : undefined) out.push(x);
  return out;   // [self, parent, …, raíz]
}

/** Clasificación y cuenta a mostrar en el balance para una cuenta hoja. */
function balancePlacement(a: Account, byId: Map<number, Account>): { term: 'corriente' | 'no_corriente' | null; shown: Account } {
  const chain = ancestors(a, byId);
  for (let i = 0; i < chain.length; i++) {
    const t = inferTerm(chain[i]!);
    if (!t) continue;
    if (t.explicit && chain[i]!.level > 1) return { term: t.term, shown: chain[i]! };
    // Grupo grande ("ACTIVO CORRIENTE"): se muestra su hijo en el camino hacia la hoja
    return { term: t.term, shown: i > 0 ? chain[i - 1]! : chain[i]! };
  }
  // Sin clasificación: el ancestro de nivel 2 (o la hoja)
  const lvl2 = chain.find(x => x.level === 2);
  return { term: null, shown: lvl2 ?? a };
}

const r2 = money2;

/** Estado de situación financiera (NIIF PYMES Secc. 4): corriente / no corriente, comparativo inicio vs fin. */
export function balanceSheetReport(accounts: Account[], rows: Map<number, Row>, labels: { start: string; end: string }): Report {
  const byId = new Map(accounts.map(a => [a.id, a]));
  const leaves = [...rows.values()].filter(r => r.account.allows_movements);
  const amounts = (r: Row, debitSide: boolean) => {
    const start = r.debitBefore - r.creditBefore;
    const end = start + r.debit - r.credit;
    return debitSide ? { start, end } : { start: -start, end: -end };
  };
  type Bucket = Map<number, { account: Account; start: number; end: number }>;
  const buckets: Record<string, Bucket> = {};
  const add = (key: string, acc: Account, v: { start: number; end: number }) => {
    const b = (buckets[key] ??= new Map());
    const cur = b.get(acc.id) ?? { account: acc, start: 0, end: 0 };
    cur.start += v.start; cur.end += v.end;
    b.set(acc.id, cur);
  };
  let resultStart = 0, resultEnd = 0;
  for (const r of leaves) {
    const side = sideOf(r.account);
    if (side === 'result') {
      resultStart += r.creditBefore - r.debitBefore;
      resultEnd += r.creditBefore + r.credit - r.debitBefore - r.debit;
      continue;
    }
    if (side === 'equity') {
      const chain = ancestors(r.account, byId);
      add('equity', chain.find(x => x.level === 2) ?? r.account, amounts(r, false));
      continue;
    }
    const { term, shown } = balancePlacement(r.account, byId);
    add(`${side}:${term ?? 'none'}`, shown, amounts(r, side === 'asset'));
  }
  const out: ReportRow[] = [];
  const sectionRows = (key: string, title: string) => {
    const items = [...(buckets[key]?.values() ?? [])].map(x => ({ ...x, start: r2(x.start), end: r2(x.end) }))
      .filter(x => x.start || x.end).sort((a, b) => byCode(a.account, b.account));
    if (!items.length) return { start: 0, end: 0 };
    out.push({ label: title, values: [null, null], kind: 'section' });
    for (const x of items) out.push({ label: x.account.name, code: x.account.code, values: [x.start, x.end], kind: 'line', indent: 1 });
    const tot = { start: r2(items.reduce((s, x) => s + x.start, 0)), end: r2(items.reduce((s, x) => s + x.end, 0)) };
    out.push({ label: `Total ${title.toLowerCase()}`, values: [tot.start, tot.end], kind: 'subtotal' });
    return tot;
  };
  const sumTot = (...t: Array<{ start: number; end: number }>) => ({ start: r2(t.reduce((s, x) => s + x.start, 0)), end: r2(t.reduce((s, x) => s + x.end, 0)) });

  out.push({ label: 'ACTIVO', values: [null, null], kind: 'section' });
  const assets = sumTot(sectionRows('asset:corriente', 'Activo corriente'), sectionRows('asset:no_corriente', 'Activo no corriente'), sectionRows('asset:none', 'Activo sin clasificar'));
  out.push({ label: 'TOTAL ACTIVO', values: [assets.start, assets.end], kind: 'total' });

  out.push({ label: 'PASIVO', values: [null, null], kind: 'section' });
  const liabilities = sumTot(sectionRows('liability:corriente', 'Pasivo corriente'), sectionRows('liability:no_corriente', 'Pasivo no corriente'), sectionRows('liability:none', 'Pasivo sin clasificar'));
  out.push({ label: 'TOTAL PASIVO', values: [liabilities.start, liabilities.end], kind: 'total' });

  out.push({ label: 'PATRIMONIO', values: [null, null], kind: 'section' });
  const eqItems = [...(buckets.equity?.values() ?? [])].map(x => ({ ...x, start: r2(x.start), end: r2(x.end) }))
    .filter(x => x.start || x.end).sort((a, b) => byCode(a.account, b.account));
  for (const x of eqItems) out.push({ label: x.account.name, code: x.account.code, values: [x.start, x.end], kind: 'line', indent: 1 });
  const res = { start: r2(resultStart), end: r2(resultEnd) };
  if (res.start || res.end) out.push({ label: 'Resultado del ejercicio (no cerrado)', values: [res.start, res.end], kind: 'line', indent: 1 });
  const equity = sumTot(...eqItems, res);
  out.push({ label: 'TOTAL PATRIMONIO', values: [equity.start, equity.end], kind: 'total' });
  const le = sumTot(liabilities, equity);
  out.push({ label: 'TOTAL PASIVO Y PATRIMONIO', values: [le.start, le.end], kind: 'total' });

  return {
    title: 'Estado de situación financiera', columns: [labels.start, labels.end], rows: out,
    checks: [
      { label: `Activo = Pasivo + Patrimonio al ${labels.end}`, ok: assets.end === le.end },
      { label: `Activo = Pasivo + Patrimonio al ${labels.start}`, ok: assets.start === le.start },
    ],
  };
}

// ── Estado de resultados (por función), portado de ChuchoWash: grupos según el tipo de cuenta ──
interface ErGroup { account: Account; kind: 'Ingreso' | 'Costo' | 'Gasto' | 'Resultado'; lines: Array<{ account: Account; amounts: number[] }>; totals: number[] }

export function incomeStatementReport(accounts: Account[], periods: Array<Map<number, Row>>, columns: string[]): Report {
  const byId = new Map(accounts.map(a => [a.id, a]));
  const er = accounts.filter(a => a.affects_result);
  const isAncestor = (anc: Account, a: Account): boolean => {
    for (let p = a.parent_id ? byId.get(a.parent_id) : undefined; p; p = p.parent_id ? byId.get(p.parent_id) : undefined) if (p.id === anc.id) return true;
    return false;
  };
  const candidates = er.filter(a => {
    if (a.allows_movements) return false;
    const parent = a.parent_id ? byId.get(a.parent_id) : undefined;
    return !parent || !parent.affects_result || parent.account_type !== a.account_type;
  });
  const groups = candidates.filter(g => !candidates.some(o => o.id !== g.id && isAncestor(g, o))).sort(byCode);
  // Cuentas de resultados de movimiento sin grupo (catálogos planos) forman su propio grupo
  const orphan = er.filter(a => a.allows_movements && !groups.some(g => isAncestor(g, a)));

  const n = periods.length;
  const zero = () => Array.from({ length: n }, () => 0);
  const lineAmount = (a: Account, kind: ErGroup['kind'], i: number) => {
    const r = periods[i]!.get(a.id);
    const bal = r ? money2(r.credit - r.debit) : 0;
    return kind === 'Costo' || kind === 'Gasto' ? -bal : bal;
  };
  const build = (g: Account, kind: ErGroup['kind'], members: Account[]): ErGroup => {
    const lines = members.map(a => ({ account: a, amounts: periods.map((_, i) => lineAmount(a, kind, i)) }))
      .filter(l => l.amounts.some(v => v !== 0)).sort((x, y) => byCode(x.account, y.account));
    const totals = zero().map((_, i) => money2(lines.reduce((s, l) => s + l.amounts[i]!, 0)));
    return { account: g, kind, lines, totals };
  };
  const all: ErGroup[] = groups.map(g => build(g, g.account_type as ErGroup['kind'], er.filter(a => a.allows_movements && isAncestor(g, a))));
  for (const a of orphan) all.push(build(a, a.account_type as ErGroup['kind'], [a]));
  const of = (k: ErGroup['kind']) => all.filter(g => g.kind === k && g.lines.length);

  const out: ReportRow[] = [];
  const push = (g: ErGroup, showTotal = true) => {
    out.push({ label: g.account.name, code: g.account.code, values: g.totals.map(() => null), kind: 'section' });
    for (const l of g.lines) out.push({ label: l.account.name, code: l.account.code, values: l.amounts, kind: 'line', indent: 1 });
    if (showTotal) out.push({ label: `Total ${g.account.name.toLowerCase()}`, values: g.totals, kind: 'subtotal' });
  };
  const sum = (gs: ErGroup[]) => zero().map((_, i) => money2(gs.reduce((s, g) => s + g.totals[i]!, 0)));
  const sub = (label: string, v: number[]) => out.push({ label, values: v, kind: 'total' });

  const income = of('Ingreso'), costs = of('Costo'), expenses = of('Gasto'), results = of('Resultado');
  // Con un solo grupo de ingresos, su total ES el total de ingresos (no se repite)
  income.forEach(g => push(g, income.length > 1));
  const tIncome = sum(income);
  sub('Total ingresos', tIncome);
  costs.forEach(g => push(g));
  let running = tIncome.map((v, i) => money2(v - sum(costs)[i]!));
  sub('Utilidad bruta', running);
  const [operating, ...others] = expenses;
  if (operating) {
    push(operating);
    running = running.map((v, i) => money2(v - operating.totals[i]!));
    sub('Utilidad de operación', running);
  }
  if (others.length) {
    others.forEach(g => push(g));
    running = running.map((v, i) => money2(v - sum(others)[i]!));
    sub('Utilidad antes de otros resultados', running);
  }
  results.forEach(g => push(g));
  const net = running.map((v, i) => money2(v + sum(results)[i]!));
  sub('Utilidad (pérdida) neta del período', net);
  return { title: 'Estado de resultados', columns, rows: out };
}

/** Estado de cambios en el patrimonio: saldo inicial, aumentos, disminuciones y saldo final por componente. */
export function equityChangesReport(accounts: Account[], rows: Map<number, Row>): Report {
  const byId = new Map(accounts.map(a => [a.id, a]));
  const comp = new Map<number, { account: Account; open: number; inc: number; dec: number }>();
  let resOpen = 0, resPeriod = 0;
  for (const r of rows.values()) {
    if (!r.account.allows_movements) continue;
    const side = sideOf(r.account);
    if (side === 'result') {
      resOpen += r.creditBefore - r.debitBefore;
      resPeriod += r.credit - r.debit;
    } else if (side === 'equity') {
      const shown = ancestors(r.account, byId).find(x => x.level === 2) ?? r.account;
      const c = comp.get(shown.id) ?? { account: shown, open: 0, inc: 0, dec: 0 };
      c.open += r.creditBefore - r.debitBefore; c.inc += r.credit; c.dec += r.debit;
      comp.set(shown.id, c);
    }
  }
  const out: ReportRow[] = [];
  const items = [...comp.values()].sort((a, b) => byCode(a.account, b.account));
  for (const c of items) {
    if (!c.open && !c.inc && !c.dec) continue;
    out.push({ label: c.account.name, code: c.account.code, values: [r2(c.open), r2(c.inc), r2(-c.dec), r2(c.open + c.inc - c.dec)], kind: 'line' });
  }
  if (resOpen || resPeriod) {
    out.push({ label: 'Resultado del ejercicio (no cerrado)', values: [r2(resOpen), resPeriod > 0 ? r2(resPeriod) : 0, resPeriod < 0 ? r2(resPeriod) : 0, r2(resOpen + resPeriod)], kind: 'line' });
  }
  const tot = [0, 1, 2, 3].map(i => r2(out.reduce((s, r) => s + (r.values[i] ?? 0), 0)));
  out.push({ label: 'TOTAL PATRIMONIO', values: tot, kind: 'total' });
  return { title: 'Estado de cambios en el patrimonio', columns: ['Saldo inicial', 'Aumentos', 'Disminuciones', 'Saldo final'], rows: out };
}

/**
 * Estado de flujo de efectivo, método indirecto (NIIF PYMES Secc. 7).
 * Efectivo = cuentas marcadas 'efectivo' o, por defecto, las de caja/bancos.
 * Cada cuenta de balance no-efectivo aporta (haber − debe) del período a su
 * actividad; el resultado del período abre la sección de operación. La suma
 * cuadra por partida doble con la variación del efectivo.
 */
export function cashFlowReport(accounts: Account[], rows: Map<number, Row>, cashIds: Set<number>): Report {
  const byId = new Map(accounts.map(a => [a.id, a]));
  const isCash = (a: Account) => a.cash_flow === 'efectivo' || (!a.cash_flow && cashIds.has(a.id));
  const activityOf = (a: Account): 'operacion' | 'inversion' | 'financiamiento' => {
    if (a.cash_flow && a.cash_flow !== 'efectivo') return a.cash_flow;
    const side = sideOf(a);
    const { term } = balancePlacement(a, byId);
    if (side === 'equity') return 'financiamiento';
    if (side === 'liability') return term === 'no_corriente' ? 'financiamiento' : 'operacion';
    // Depreciación/amortización acumulada (contraactivo): partida que no usa efectivo → operación
    if (a.account_type === 'Contraactivo') return 'operacion';
    return term === 'no_corriente' ? 'inversion' : 'operacion';
  };
  let net = 0, cashOpen = 0, cashDelta = 0;
  const acts: Record<string, Map<number, { account: Account; v: number }>> = { operacion: new Map(), inversion: new Map(), financiamiento: new Map() };
  for (const r of rows.values()) {
    const a = r.account;
    if (!a.allows_movements) continue;
    if (sideOf(a) === 'result') { net += r.credit - r.debit; continue; }
    if (isCash(a)) { cashOpen += r.debitBefore - r.creditBefore; cashDelta += r.debit - r.credit; continue; }
    const v = r.credit - r.debit;
    if (!v) continue;
    const shown = balancePlacement(a, byId).shown;
    const m = acts[activityOf(a)]!;
    const cur = m.get(shown.id) ?? { account: shown, v: 0 };
    cur.v += v;
    m.set(shown.id, cur);
  }
  const out: ReportRow[] = [];
  const section = (key: string, title: string, first?: ReportRow) => {
    out.push({ label: title, values: [null], kind: 'section' });
    if (first) out.push(first);
    const items = [...acts[key]!.values()].filter(x => r2(x.v) !== 0).sort((a, b) => byCode(a.account, b.account));
    for (const x of items) {
      const label = sideOf(x.account) === 'asset' && x.account.account_type !== 'Contraactivo'
        ? `${x.v < 0 ? 'Aumento' : 'Disminución'} en ${x.account.name}`
        : x.account.account_type === 'Contraactivo' ? `${x.account.name} (no usa efectivo)`
        : `${x.v > 0 ? 'Aumento' : 'Disminución'} en ${x.account.name}`;
      out.push({ label, code: x.account.code, values: [r2(x.v)], kind: 'line', indent: 1 });
    }
    const tot = r2(items.reduce((s, x) => s + x.v, 0) + (first?.values[0] ?? 0));
    out.push({ label: `Efectivo neto de actividades de ${title.replace(/^Actividades de /i, '').toLowerCase()}`, values: [tot], kind: 'subtotal' });
    return tot;
  };
  const op = section('operacion', 'Actividades de operación', { label: 'Resultado del período', values: [r2(net)], kind: 'line', indent: 1 });
  const inv = section('inversion', 'Actividades de inversión');
  const fin = section('financiamiento', 'Actividades de financiamiento');
  const delta = r2(op + inv + fin);
  out.push({ label: 'Aumento (disminución) neto del efectivo', values: [delta], kind: 'total' });
  out.push({ label: 'Efectivo al inicio del período', values: [r2(cashOpen)], kind: 'line' });
  out.push({ label: 'Efectivo al final del período', values: [r2(cashOpen + delta)], kind: 'total' });
  return {
    title: 'Estado de flujo de efectivo', columns: ['Monto'], rows: out,
    checks: [{ label: 'La variación calculada coincide con el saldo de caja y bancos', ok: delta === r2(cashDelta) }],
  };
}
