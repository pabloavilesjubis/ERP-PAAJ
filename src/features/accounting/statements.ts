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
