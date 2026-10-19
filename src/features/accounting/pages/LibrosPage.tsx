import { Fragment, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { RouteTabs } from '@/components/ui/Tabs';
import { ErrorBanner, Loading } from '@/components/ui/Feedback';
import { useBranding } from '@/branding/BrandingProvider';
import { accApi } from '../api';
import { useAccounts } from '../hooks';
import { currentMonth } from '../dates';
import { dmy, entryNo, money } from '../format';
import { downloadText } from '../catalogCsv';
import { DateRange, type Range } from '../components/DateRange';
import { AccountSelect } from '../components/AccountSelect';
import { EntryModal } from '../components/EntryModals';
import { rollUp, trialBalance } from '../statements';

export type Book = 'diario' | 'mayor' | 'balanza';

/** Libros contables: diario, mayor y balanza de comprobación. */
export function LibrosPage({ book }: { book: Book }) {
  const [range, setRange] = useState<Range>(currentMonth());
  return (
    <div>
      <SectionHeader title="Libros contables" description="Diario, mayor y balanza de comprobación del rango seleccionado." />
      <div className="no-print">
        <RouteTabs tabs={[
          { to: '/contabilidad/libros/diario', label: 'Libro diario' },
          { to: '/contabilidad/libros/mayor', label: 'Libro mayor' },
          { to: '/contabilidad/libros/balanza', label: 'Balanza de comprobación' },
        ]} />
        <div className="toolbar"><DateRange value={range} onChange={setRange} /></div>
      </div>
      {book === 'diario' && <Diario range={range} />}
      {book === 'mayor' && <Mayor range={range} />}
      {book === 'balanza' && <Balanza range={range} />}
    </div>
  );
}

function PrintHeader({ title, range }: { title: string; range: Range }) {
  const branding = useBranding();
  return (
    <div style={{ textAlign: 'center', marginBottom: 'var(--s-4)' }}>
      <div style={{ fontWeight: 700, fontSize: 'var(--text-lg)' }}>{branding.productName}</div>
      <div style={{ fontWeight: 600 }}>{title}</div>
      <div className="muted" style={{ fontSize: 'var(--text-sm)' }}>Del {dmy(range.from)} al {dmy(range.to)} · Cifras en dólares de los Estados Unidos de América</div>
    </div>
  );
}

function Diario({ range }: { range: Range }) {
  const q = useQuery({ queryKey: ['acc', 'journal', range], queryFn: () => accApi.journal(range.from, range.to, 5000) });
  const [open, setOpen] = useState<number | null>(null);
  const items = q.data?.items ?? [];
  const td = items.reduce((s, e) => s + e.total_debit, 0);
  if (q.isLoading) return <Loading />;
  return (
    <>
      <ErrorBanner error={q.error} />
      <div className="toolbar no-print">
        <Button variant="secondary" onClick={() => window.print()}>Imprimir / PDF</Button>
        <Button variant="secondary" onClick={() => downloadText(`libro-diario-${range.from}-${range.to}.csv`, journalCsv(items))}>Exportar CSV</Button>
      </div>
      {items.length === 0 ? <EmptyState title="Sin asientos contabilizados en el rango" /> : (
        <div className="table-wrap"><div className="table-scroll">
          <PrintHeader title="Libro diario" range={range} />
          <table className="acc-table">
            <thead><tr><th>Fecha</th><th>Partida</th><th>Cuenta</th><th>Concepto / descripción</th><th className="num">Debe</th><th className="num">Haber</th></tr></thead>
            <tbody>
              {items.map(e => (
                <Fragment key={e.id}>
                  <tr className="subtotal clickable" onClick={() => setOpen(Number(e.id))}>
                    <td className="code">{dmy(e.entry_date)}</td>
                    <td className="code">#{entryNo(e.entry_number)}</td>
                    <td colSpan={2}>{e.concept}{e.status === 'anulado' ? ' (anulado)' : ''}{e.source_ref ? ` · ${e.source_ref}` : ''}</td>
                    <td /><td />
                  </tr>
                  {e.lines.map(l => (
                    <tr key={`${e.id}-${l.line_no}`}>
                      <td /><td />
                      <td style={{ paddingLeft: l.credit ? 32 : 10 }}><span className="combo-code">{l.account_code}</span> {l.account_name}</td>
                      <td className="muted">{l.description}{l.party_name ? ` · ${l.party_name}` : ''}</td>
                      <td className="num">{money(l.debit, { blankZero: true })}</td>
                      <td className="num">{money(l.credit, { blankZero: true })}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
              <tr className="total"><td colSpan={4}>Totales ({items.length} partidas)</td><td className="num">{money(td)}</td><td className="num">{money(td)}</td></tr>
            </tbody>
          </table>
        </div></div>
      )}
      {open !== null && <EntryModal id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function journalCsv(items: Array<{ entry_number: number; entry_date: string; concept: string; lines: Array<{ account_code: string; account_name: string; description: string | null; debit: number; credit: number }> }>): string {
  const cell = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const out = ['fecha,partida,concepto,cuenta,nombre_cuenta,descripcion,debe,haber'];
  for (const e of items) for (const l of e.lines) {
    out.push([dmy(e.entry_date), e.entry_number, e.concept, l.account_code, l.account_name, l.description ?? '', l.debit.toFixed(2), l.credit.toFixed(2)].map(cell).join(','));
  }
  return out.join('\r\n');
}

function Mayor({ range }: { range: Range }) {
  const accounts = useAccounts();
  const [params, setParams] = useSearchParams();
  const accountId = params.get('account') ? Number(params.get('account')) : null;
  const account = accounts.data?.find(a => a.id === accountId) ?? null;
  const [open, setOpen] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ['acc', 'ledger', accountId, range],
    queryFn: () => accApi.ledger(accountId!, range.from, range.to),
    enabled: accountId !== null,
  });
  // Saldo según la naturaleza: deudora suma debe, acreedora suma haber
  const sign = account && (account.nature === 'Acreedora') ? -1 : 1;
  const rows = useMemo(() => {
    let bal = (q.data?.opening ?? 0) * sign;
    return (q.data?.items ?? []).map(l => { bal += (l.debit - l.credit) * sign; return { ...l, balance: bal }; });
  }, [q.data, sign]);

  return (
    <>
      <div className="toolbar no-print" style={{ maxWidth: 560 }}>
        <Field label="Cuenta (de movimiento o de mayor)">
          <AccountSelect accounts={accounts.data ?? []} movementOnly={false} value={accountId}
            onChange={id => setParams(id ? { account: String(id) } : {})} />
        </Field>
      </div>
      {!accountId ? <EmptyState title="Elige una cuenta" description="El mayor de una cuenta de mayor incluye todas sus subcuentas." /> : q.isLoading ? <Loading /> : (
        <>
          <ErrorBanner error={q.error} />
          <div className="toolbar no-print"><Button variant="secondary" onClick={() => window.print()}>Imprimir / PDF</Button></div>
          <div className="table-wrap"><div className="table-scroll">
            <PrintHeader title={`Libro mayor — ${account?.code ?? ''} ${account?.name ?? ''}`} range={range} />
            <table className="acc-table">
              <thead><tr><th>Fecha</th><th>Partida</th><th>Concepto</th>{!account?.allows_movements && <th>Subcuenta</th>}<th className="num">Debe</th><th className="num">Haber</th><th className="num">Saldo</th></tr></thead>
              <tbody>
                <tr className="subtotal"><td colSpan={account?.allows_movements ? 5 : 6}>Saldo inicial al {dmy(range.from)}</td><td className="num">{money((q.data?.opening ?? 0) * sign)}</td></tr>
                {rows.map(l => (
                  <tr key={`${l.entry_id}-${l.account_code}-${l.debit}-${l.credit}`} className="clickable" onClick={() => setOpen(Number(l.entry_id))}>
                    <td className="code">{dmy(l.entry_date)}</td>
                    <td className="code">#{entryNo(l.entry_number)}</td>
                    <td>{l.description || l.concept}{l.party_name ? <span className="muted"> · {l.party_name}</span> : null}</td>
                    {!account?.allows_movements && <td className="muted">{l.account_code} {l.account_name}</td>}
                    <td className="num">{money(l.debit, { blankZero: true })}</td>
                    <td className="num">{money(l.credit, { blankZero: true })}</td>
                    <td className="num">{money(l.balance)}</td>
                  </tr>
                ))}
                <tr className="total">
                  <td colSpan={account?.allows_movements ? 3 : 4}>Movimientos del período</td>
                  <td className="num">{money(rows.reduce((s, l) => s + l.debit, 0))}</td>
                  <td className="num">{money(rows.reduce((s, l) => s + l.credit, 0))}</td>
                  <td className="num">{money(rows.length ? rows[rows.length - 1]!.balance : (q.data?.opening ?? 0) * sign)}</td>
                </tr>
              </tbody>
            </table>
          </div></div>
        </>
      )}
      {open !== null && <EntryModal id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function Balanza({ range }: { range: Range }) {
  const accounts = useAccounts();
  const moves = useQuery({ queryKey: ['acc', 'movements', range], queryFn: () => accApi.movements(range.from, range.to) });
  const maxLevelAll = Math.max(1, ...(accounts.data ?? []).map(a => a.level));
  const [maxLevel, setMaxLevel] = useState<number>(0);
  const [onlyWithBalance, setOnlyWithBalance] = useState(true);
  const tb = useMemo(() => accounts.data && moves.data
    ? trialBalance(rollUp(accounts.data, moves.data), { maxLevel: maxLevel || undefined, onlyWithBalance })
    : null, [accounts.data, moves.data, maxLevel, onlyWithBalance]);

  if (accounts.isLoading || moves.isLoading) return <Loading />;
  if (!tb) return <ErrorBanner error={moves.error ?? accounts.error} />;
  const ok = tb.balanced.movements && tb.balanced.closing && tb.balanced.opening;
  return (
    <>
      <div className="toolbar no-print">
        <Select value={maxLevel} onChange={e => setMaxLevel(Number(e.target.value))} style={{ width: 200 }}>
          <option value={0}>Todos los niveles</option>
          {Array.from({ length: maxLevelAll }, (_, i) => i + 1).map(n => <option key={n} value={n}>Hasta nivel {n}</option>)}
        </Select>
        <label style={{ fontSize: 'var(--text-sm)', display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={onlyWithBalance} onChange={e => setOnlyWithBalance(e.target.checked)} /> Solo cuentas con saldo o movimiento
        </label>
        <Button variant="secondary" onClick={() => window.print()}>Imprimir / PDF</Button>
        <Button variant="secondary" onClick={() => downloadText(`balanza-${range.from}-${range.to}.csv`, balanzaCsv(tb))}>Exportar CSV</Button>
        <span className={`badge ${ok ? 'badge-success' : 'badge-warning'}`}><span className="badge-dot" />{ok ? 'Cuadrada' : 'Descuadrada'}</span>
      </div>
      <div className="table-wrap"><div className="table-scroll">
        <PrintHeader title="Balanza de comprobación" range={range} />
        <table className="acc-table">
          <thead>
            <tr><th rowSpan={2}>Código</th><th rowSpan={2}>Cuenta</th><th colSpan={2} style={{ textAlign: 'center' }}>Saldo inicial</th><th colSpan={2} style={{ textAlign: 'center' }}>Movimientos</th><th colSpan={2} style={{ textAlign: 'center' }}>Saldo final</th></tr>
            <tr><th className="num">Deudor</th><th className="num">Acreedor</th><th className="num">Debe</th><th className="num">Haber</th><th className="num">Deudor</th><th className="num">Acreedor</th></tr>
          </thead>
          <tbody>
            {tb.lines.map(l => (
              <tr key={l.account.id} className={l.account.allows_movements ? '' : 'major'}>
                <td className="code" style={{ paddingLeft: 10 + (l.account.level - 1) * 12 }}>{l.account.code}</td>
                <td>{l.account.name}</td>
                <td className="num">{money(l.openingDebit, { blankZero: true })}</td>
                <td className="num">{money(l.openingCredit, { blankZero: true })}</td>
                <td className="num">{money(l.debit, { blankZero: true })}</td>
                <td className="num">{money(l.credit, { blankZero: true })}</td>
                <td className="num">{money(l.closingDebit, { blankZero: true })}</td>
                <td className="num">{money(l.closingCredit, { blankZero: true })}</td>
              </tr>
            ))}
            <tr className="total">
              <td colSpan={2}>Totales (cuentas de movimiento)</td>
              <td className="num">{money(tb.totals.openingDebit)}</td><td className="num">{money(tb.totals.openingCredit)}</td>
              <td className="num">{money(tb.totals.debit)}</td><td className="num">{money(tb.totals.credit)}</td>
              <td className="num">{money(tb.totals.closingDebit)}</td><td className="num">{money(tb.totals.closingCredit)}</td>
            </tr>
          </tbody>
        </table>
      </div></div>
    </>
  );
}

function balanzaCsv(tb: ReturnType<typeof trialBalance>): string {
  const cell = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const out = ['codigo,cuenta,nivel,saldo_inicial_deudor,saldo_inicial_acreedor,debe,haber,saldo_final_deudor,saldo_final_acreedor'];
  for (const l of tb.lines) {
    out.push([l.account.code, l.account.name, l.account.level, l.openingDebit, l.openingCredit, l.debit, l.credit, l.closingDebit, l.closingCredit].map(cell).join(','));
  }
  return out.join('\r\n');
}
