import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Badge } from '@/components/ui/Badge';
import { KpiCard } from '@/components/ui/KpiCard';
import { RouteTabs } from '@/components/ui/Tabs';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner, Loading } from '@/components/ui/Feedback';
import { usePermissions } from '@/auth/usePermissions';
import { useAccounts } from '@/features/accounting/hooks';
import { AccountSelect } from '@/features/accounting/components/AccountSelect';
import { EntryModal } from '@/features/accounting/components/EntryModals';
import { todayIso } from '@/features/accounting/dates';
import { dmy, money } from '@/features/accounting/format';
import { bankApi, BANKS_SV, type AccountInput, type BankAccount, type BankMovement } from './api';
import { decodeBankFile, detectBAC, parseBAC } from './bacParser';
import { guessMapping, parseGeneric, previewCsv, type CsvMapping, type ParsedStatement } from './genericParser';

export type BankTab = 'disponibilidad' | 'movimientos' | 'conciliacion' | 'cuentas';

/** Bancos: disponibilidad, estados de cuenta, conciliación y cuentas bancarias de la empresa. */
export function BancosPage({ tab }: { tab: BankTab }) {
  const accounts = useQuery({ queryKey: ['banks', 'accounts'], queryFn: bankApi.accounts });
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    if (selected === null && accounts.data?.length) setSelected(accounts.data.find(a => a.is_active)?.id ?? accounts.data[0]!.id);
  }, [accounts.data, selected]);
  const account = accounts.data?.find(a => a.id === selected) ?? null;

  return (
    <div>
      <SectionHeader title="Bancos" description="Estados de cuenta de cada banco, conciliación contra la contabilidad y disponibilidad real." />
      <RouteTabs tabs={[
        { to: '/bancos/disponibilidad', label: 'Disponibilidad' },
        { to: '/bancos/movimientos', label: 'Movimientos' },
        { to: '/bancos/conciliacion', label: 'Conciliación bancaria' },
        { to: '/bancos/cuentas', label: 'Cuentas bancarias' },
      ]} />
      <ErrorBanner error={accounts.error} />
      {(tab === 'movimientos' || tab === 'conciliacion') && (accounts.data?.length ?? 0) > 0 && (
        <div className="toolbar">
          <Select value={selected ?? ''} onChange={e => setSelected(Number(e.target.value))} style={{ maxWidth: 420 }}>
            {accounts.data!.map(a => <option key={a.id} value={a.id}>{a.bank_name} · {a.account_number}{a.is_active ? '' : ' (inactiva)'}</option>)}
          </Select>
        </div>
      )}
      {accounts.isLoading ? <Loading /> : !accounts.data?.length && tab !== 'cuentas'
        ? <EmptyState title="Aún no hay cuentas bancarias" description="Agrégalas en la pestaña Cuentas bancarias y lígalas a su cuenta del catálogo." />
        : <>
            {tab === 'disponibilidad' && <Disponibilidad />}
            {tab === 'movimientos' && account && <Movimientos account={account} />}
            {tab === 'conciliacion' && account && <ConciliacionReport account={account} />}
            {tab === 'cuentas' && <Cuentas accounts={accounts.data ?? []} />}
          </>}
    </div>
  );
}

function Disponibilidad() {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['banks', 'availability'], queryFn: bankApi.availability });
  const [editing, setEditing] = useState(false);
  const [reserve, setReserve] = useState('');
  const [notes, setNotes] = useState('');
  const save = useMutation({
    mutationFn: () => bankApi.setReserve(Number(reserve) || 0, notes || null),
    onSuccess: () => { setEditing(false); void qc.invalidateQueries({ queryKey: ['banks'] }); },
  });
  if (q.isLoading) return <Loading />;
  const d = q.data!;
  return (
    <>
      <ErrorBanner error={q.error} />
      <div className="kpi-grid">
        <KpiCard label="Saldo en bancos" value={money(d.banks)} hint="Según el último estado de cuenta" />
        <KpiCard label="Reserva" value={money(d.reserve)} hint={d.reserve_notes ?? 'Fondos comprometidos'} />
        {d.taxes !== undefined && <KpiCard label="Impuestos por pagar" value={money(d.taxes)} hint="F-07 y F-14 pendientes" />}
        <KpiCard label="Proveedores por pagar" value={money(d.payables)} hint={`${money(d.payables_due_7)} vencen en 7 días`} />
        <KpiCard label="Disponible real" value={money(d.available)} tone={d.available < 0 ? 'danger' : 'success'} />
      </div>
      <div className="toolbar">
        <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>Por cobrar a clientes: <strong>{money(d.receivables)}</strong> ({money(d.receivables_due_7)} en 7 días)</span>
        {can('banks:manage') && <Button size="sm" variant="secondary" onClick={() => { setReserve(String(d.reserve)); setNotes(d.reserve_notes ?? ''); setEditing(true); }}>Ajustar reserva</Button>}
      </div>
      <div className="table-wrap"><table className="acc-table">
        <thead><tr><th>Banco</th><th>Cuenta</th><th>Último estado</th><th className="num">Saldo banco</th><th className="num">Saldo en libros</th><th className="num">Pendientes</th></tr></thead>
        <tbody>
          {d.accounts.map(a => (
            <tr key={a.id}>
              <td>{a.bank_name}</td><td className="code">{a.account_number}</td>
              <td className="code">{dmy(a.last_statement_date)}</td>
              <td className="num">{a.statement_balance === null ? '—' : money(a.statement_balance)}</td>
              <td className="num">{money(a.ledger_balance)}</td>
              <td className="num">{a.pending || ''}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {editing && (
        <Modal title="Reserva de fondos" onClose={() => setEditing(false)} onSave={() => save.mutate()} saveDisabled={save.isPending}>
          <ErrorBanner error={save.error} />
          <Field label="Monto reservado"><Input inputMode="decimal" value={reserve} onChange={e => setReserve(e.target.value)} /></Field>
          <Field label="Para qué (planilla, préstamo…)"><Input value={notes} onChange={e => setNotes(e.target.value)} /></Field>
        </Modal>
      )}
    </>
  );
}

function Movimientos({ account }: { account: BankAccount }) {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const [status, setStatus] = useState('pendiente');
  const [search, setSearch] = useState('');
  const [importing, setImporting] = useState(false);
  const [reconciling, setReconciling] = useState<BankMovement | null>(null);
  const [entry, setEntry] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['banks', 'movements', account.id, status, search], queryFn: () => bankApi.movements(account.id, { status, q: search }) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['banks'] });
  const auto = useMutation({ mutationFn: () => bankApi.autoReconcile(account.id), onSuccess: refresh });
  const undo = useMutation({ mutationFn: (m: BankMovement) => bankApi.unreconcile(m.id), onSuccess: () => { refresh(); void qc.invalidateQueries({ queryKey: ['acc'] }); } });
  const ignore = useMutation({
    mutationFn: (m: BankMovement) => {
      const reason = window.prompt('¿Por qué se ignora este movimiento?');
      if (!reason) throw new Error('cancelado');
      return bankApi.ignore(m.id, reason);
    },
    onSuccess: refresh,
  });
  const manage = can('banks:manage');
  const items = q.data ?? [];
  return (
    <>
      <div className="toolbar">
        <Select value={status} onChange={e => setStatus(e.target.value)} style={{ width: 180 }}>
          <option value="pendiente">Pendientes</option>
          <option value="conciliado">Conciliados</option>
          <option value="ignorado">Ignorados</option>
          <option value="">Todos</option>
        </Select>
        <Input placeholder="Buscar descripción o referencia…" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 300 }} />
        {manage && <Button onClick={() => setImporting(true)}>Subir estado de cuenta</Button>}
        {manage && <Button variant="secondary" onClick={() => auto.mutate()} disabled={auto.isPending}>Conciliar automáticamente</Button>}
        {auto.data && <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>{auto.data.reconciled} conciliado(s)</span>}
      </div>
      <ErrorBanner error={q.error ?? auto.error ?? undo.error ?? (ignore.error instanceof Error && ignore.error.message === 'cancelado' ? null : ignore.error)} />
      {q.isLoading ? <Loading /> : !items.length ? <EmptyState title="Sin movimientos con este filtro" /> : (
        <div className="table-wrap"><div className="table-scroll">
          <table className="acc-table">
            <thead><tr><th>Fecha</th><th>Descripción</th><th>Referencia</th><th className="num">Cargo</th><th className="num">Abono</th><th className="num">Saldo</th><th>Conciliado con</th><th /></tr></thead>
            <tbody>
              {items.map(m => (
                <tr key={m.id}>
                  <td className="code">{dmy(m.movement_date)}</td>
                  <td>{m.description}</td>
                  <td className="muted">{m.reference}</td>
                  <td className="num">{money(m.debit, { blankZero: true })}</td>
                  <td className="num">{money(m.credit, { blankZero: true })}</td>
                  <td className="num muted">{m.balance === null ? '' : money(m.balance)}</td>
                  <td style={{ maxWidth: 280 }}>
                    {m.status === 'conciliado' && <a href="#" onClick={e => { e.preventDefault(); if (m.link_entry_id) setEntry(m.link_entry_id); }}>{m.link_label}</a>}
                    {m.status === 'ignorado' && <span className="muted">Ignorado: {m.ignore_reason}</span>}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {manage && m.status === 'pendiente' && <>
                      <Button size="sm" onClick={() => setReconciling(m)}>Conciliar</Button>{' '}
                      <Button size="sm" variant="secondary" onClick={() => ignore.mutate(m)}>Ignorar</Button>
                    </>}
                    {manage && m.status !== 'pendiente' && <Button size="sm" variant="secondary" onClick={() => undo.mutate(m)} disabled={undo.isPending}>Deshacer</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></div>
      )}
      {importing && <ImportModal account={account} onClose={() => setImporting(false)} />}
      {reconciling && <ReconcileModal movement={reconciling} onClose={() => setReconciling(null)} />}
      {entry !== null && <EntryModal id={entry} onClose={() => setEntry(null)} />}
    </>
  );
}

function ImportModal({ account, onClose }: { account: BankAccount; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [mapping, setMapping] = useState<CsvMapping>(account.csv_mapping ?? {});
  const [format, setFormat] = useState<'bac' | 'generic'>(account.statement_format);
  const [saveMapping, setSaveMapping] = useState(true);

  const parsed: (ParsedStatement & { error?: string }) | null = useMemo(() => {
    if (text === null) return null;
    try {
      if (format === 'bac') {
        const s = parseBAC(text);
        return {
          rows: s.movements.map(m => ({ date: m.transactionDate, reference: m.bankReference, code: m.bankCodeRaw, description: m.description, debit: m.debit, credit: m.credit, balance: m.balanceCsv })),
          warnings: s.warnings, accountNumber: s.accountNumberFromFile, opening: s.saldoInicial, closing: s.saldoDisponible, totalsOk: s.totales?.ok,
        };
      }
      return parseGeneric(text, mapping);
    } catch (e) {
      return { rows: [], warnings: [], error: e instanceof Error ? e.message : 'No se pudo leer el archivo' };
    }
  }, [text, format, mapping]);
  const preview = useMemo(() => (text !== null && format === 'generic' ? previewCsv(text, mapping) : null), [text, format, mapping]);

  const run = useMutation({
    mutationFn: async () => {
      if (format === 'generic' && saveMapping) {
        await bankApi.update(account.id, { bank_name: account.bank_name, account_number: account.account_number, account_type: account.account_type,
          ledger_account_id: account.ledger_account_id, statement_format: 'generic', csv_mapping: mapping, is_active: account.is_active });
      }
      return bankApi.importStatement(account.id, {
        file_name: fileName, file_account: parsed?.accountNumber ?? null, opening_balance: parsed?.opening ?? null,
        closing_balance: parsed?.closing ?? null, totals_ok: parsed?.totalsOk ?? null, rows: parsed!.rows,
      });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['banks'] }),
  });

  async function onFile(f: File | undefined) {
    if (!f) return;
    const t = decodeBankFile(await f.arrayBuffer());
    setFileName(f.name);
    setText(t);
    run.reset();
    if (detectBAC(t) > 0.5) setFormat('bac');
    else {
      setFormat('generic');
      if (!mapping.date_col) setMapping(m => ({ ...m, ...guessMapping(previewCsv(t, m).headers) }));
    }
  }

  const cols = preview?.headers ?? [];
  const colSelect = (k: keyof CsvMapping, label: string) => (
    <Field label={label}>
      <Select value={(mapping[k] as string) ?? ''} onChange={e => setMapping(m => ({ ...m, [k]: e.target.value || undefined }))}>
        <option value="">—</option>
        {cols.map(c => <option key={c} value={c}>{c}</option>)}
      </Select>
    </Field>
  );
  const td = parsed?.rows.reduce((s, r) => s + r.debit, 0) ?? 0;
  const tc = parsed?.rows.reduce((s, r) => s + r.credit, 0) ?? 0;

  return (
    <Modal title={`Subir estado de cuenta — ${account.bank_name} ${account.account_number}`} onClose={onClose} size="xwide"
      footer={run.isSuccess ? <Button onClick={onClose}>Listo</Button> : <>
        <Button variant="secondary" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => run.mutate()} disabled={run.isPending || !parsed?.rows.length || !!parsed.error}>
          {run.isPending ? 'Importando…' : `Importar ${parsed?.rows.length ?? 0} movimientos`}
        </Button>
      </>}>
      <div className="banner banner-info">
        BAC: sube el CSV tal como lo exporta la banca en línea. Otros bancos: sube el CSV y elige qué columna es cada dato
        (se recuerda para la próxima). Los movimientos repetidos se ignoran. Importar no contabiliza nada: luego concilias.
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
        <input type="file" accept=".csv,.txt,text/csv" onChange={e => void onFile(e.target.files?.[0])} />
        <Field label="Formato">
          <Select value={format} onChange={e => setFormat(e.target.value as 'bac' | 'generic')}>
            <option value="bac">BAC (estado de cuenta)</option>
            <option value="generic">CSV genérico (configurable)</option>
          </Select>
        </Field>
      </div>
      {format === 'generic' && text !== null && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          <Field label="Separador">
            <Select value={mapping.delimiter ?? ''} onChange={e => setMapping(m => ({ ...m, delimiter: e.target.value || undefined }))}>
              <option value="">Automático</option><option value=",">Coma</option><option value=";">Punto y coma</option><option value={'\t'}>Tabulador</option>
            </Select>
          </Field>
          <Field label="Filas a saltar (encabezado del banco)"><Input type="number" min={0} value={mapping.skip_rows ?? 0} onChange={e => setMapping(m => ({ ...m, skip_rows: Number(e.target.value) || 0 }))} /></Field>
          <Field label="Formato de fecha">
            <Select value={mapping.date_format ?? 'DD/MM/YYYY'} onChange={e => setMapping(m => ({ ...m, date_format: e.target.value as CsvMapping['date_format'] }))}>
              <option>DD/MM/YYYY</option><option>MM/DD/YYYY</option><option>YYYY-MM-DD</option>
            </Select>
          </Field>
          {colSelect('date_col', 'Columna fecha')}
          {colSelect('description_col', 'Descripción')}
          {colSelect('reference_col', 'Referencia')}
          {colSelect('debit_col', 'Cargo / débito')}
          {colSelect('credit_col', 'Abono / crédito')}
          {colSelect('amount_col', 'Monto con signo (si es una sola columna)')}
          {colSelect('balance_col', 'Saldo')}
          <label style={{ fontSize: 'var(--text-sm)', display: 'flex', gap: 6, alignItems: 'center', gridColumn: 'span 2' }}>
            <input type="checkbox" checked={saveMapping} onChange={e => setSaveMapping(e.target.checked)} /> Recordar estas columnas para esta cuenta
          </label>
        </div>
      )}
      {parsed?.error && <div className="banner banner-danger">{parsed.error}</div>}
      <ErrorBanner error={run.error} />
      {run.isSuccess && <div className="banner banner-success">
        {run.data.new} movimientos nuevos{run.data.duplicates ? `, ${run.data.duplicates} ya existían` : ''}. {run.data.auto_reconciled} conciliados automáticamente.
      </div>}
      {parsed && parsed.rows.length > 0 && !run.isSuccess && <>
        <div className="stat-row">
          <span>{parsed.rows.length} movimientos</span><span>Cargos <strong>{money(td)}</strong></span><span>Abonos <strong>{money(tc)}</strong></span>
          {parsed.accountNumber && <span>Cuenta del archivo <strong>{parsed.accountNumber}</strong></span>}
          {parsed.totalsOk !== undefined && <span>{parsed.totalsOk ? '✓ Totales del banco cuadran' : '⚠ Totales del banco no cuadran'}</span>}
        </div>
        {parsed.warnings.length > 0 && <div className="banner banner-warning">{parsed.warnings.slice(0, 3).join(' · ')}{parsed.warnings.length > 3 ? ` (+${parsed.warnings.length - 3})` : ''}</div>}
        <div className="table-wrap"><div className="table-scroll" style={{ maxHeight: 320 }}>
          <table className="acc-table">
            <thead><tr><th>Fecha</th><th>Descripción</th><th>Referencia</th><th className="num">Cargo</th><th className="num">Abono</th><th className="num">Saldo</th></tr></thead>
            <tbody>{parsed.rows.slice(0, 200).map((r, i) => (
              <tr key={i}><td className="code">{dmy(r.date)}</td><td>{r.description}</td><td className="muted">{r.reference}</td>
                <td className="num">{money(r.debit, { blankZero: true })}</td><td className="num">{money(r.credit, { blankZero: true })}</td>
                <td className="num muted">{r.balance === undefined ? '' : money(r.balance)}</td></tr>
            ))}</tbody>
          </table>
        </div></div>
      </>}
    </Modal>
  );
}

function ReconcileModal({ movement, onClose }: { movement: BankMovement; onClose: () => void }) {
  const qc = useQueryClient();
  const accounts = useAccounts();
  const cands = useQuery({ queryKey: ['banks', 'candidates', movement.id], queryFn: () => bankApi.candidates(movement.id) });
  const [counter, setCounter] = useState<number | null>(null);
  const [desc, setDesc] = useState(movement.description ?? '');
  const run = useMutation({
    mutationFn: (b: { kind: string; target_id?: number; counter_account_id?: number | null; description?: string }) => bankApi.reconcile(movement.id, b),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['banks'] }); void qc.invalidateQueries({ queryKey: ['acc'] }); onClose(); },
  });
  const amount = movement.credit || movement.debit;
  const isIn = movement.credit > 0;
  const KIND: Record<string, string> = { payment: 'Cobro/pago registrado', journal_line: 'Asiento', document: isIn ? 'Cobrar documento' : 'Pagar documento' };
  return (
    <Modal title="Conciliar movimiento" onClose={onClose} size="wide" footer={<Button variant="secondary" onClick={onClose}>Cerrar</Button>}>
      <ErrorBanner error={run.error ?? cands.error} />
      <div className="stat-row">
        <span>{dmy(movement.movement_date)}</span><span>{movement.description}</span>
        <span>{isIn ? 'Abono' : 'Cargo'} <strong>{money(amount)}</strong></span>
      </div>
      <strong style={{ fontSize: 'var(--text-sm)' }}>Coincidencias (mismo monto, ±10 días)</strong>
      {cands.isLoading ? <Loading /> : !(cands.data ?? []).length ? <div className="muted" style={{ fontSize: 'var(--text-sm)' }}>No hay cobros, pagos, asientos ni documentos con ese monto.</div> : (
        <table className="acc-table">
          <thead><tr><th>Tipo</th><th>Detalle</th><th>Tercero</th><th>Fecha</th><th className="num">Días</th><th /></tr></thead>
          <tbody>{cands.data!.map(c => (
            <tr key={`${c.kind}-${c.target_id}`}>
              <td>{KIND[c.kind]}</td><td>{c.label}</td><td className="muted">{c.party_name}</td><td className="code">{dmy(c.target_date)}</td>
              <td className="num">{c.days}</td>
              <td><Button size="sm" onClick={() => run.mutate({ kind: c.kind, target_id: c.target_id })} disabled={run.isPending}>Elegir</Button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <strong style={{ fontSize: 'var(--text-sm)' }}>O registrar un asiento nuevo</strong>
        <div className="muted" style={{ fontSize: 'var(--text-xs)', marginBottom: 8 }}>
          Para comisiones, intereses, impuestos debitados, traslados entre cuentas propias… Banco {isIn ? 'al debe' : 'al haber'} contra la cuenta que elijas.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 10, alignItems: 'flex-end' }}>
          <Field label="Contrapartida"><AccountSelect accounts={accounts.data ?? []} value={counter} onChange={setCounter} /></Field>
          <Field label="Concepto"><Input value={desc} onChange={e => setDesc(e.target.value)} /></Field>
          <Button onClick={() => run.mutate({ kind: 'entry', counter_account_id: counter, description: desc })} disabled={!counter || run.isPending}>Registrar</Button>
        </div>
      </div>
    </Modal>
  );
}

function ConciliacionReport({ account }: { account: BankAccount }) {
  const [asOf, setAsOf] = useState(todayIso());
  const q = useQuery({ queryKey: ['banks', 'reconciliation', account.id, asOf], queryFn: () => bankApi.reconciliation(account.id, asOf) });
  const r = q.data;
  return (
    <>
      <div className="toolbar no-print">
        <Field label="Al"><Input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} /></Field>
        <Button variant="secondary" onClick={() => window.print()}>Imprimir / PDF</Button>
      </div>
      <ErrorBanner error={q.error} />
      {!r ? <Loading /> : (
        <div className="table-wrap" style={{ padding: 'var(--s-6)' }}>
          <div style={{ textAlign: 'center', marginBottom: 16 }}>
            <div style={{ fontWeight: 600 }}>Conciliación bancaria — {r.account.bank_name} {r.account.account_number}</div>
            <div className="muted" style={{ fontSize: 'var(--text-sm)' }}>Al {dmy(r.as_of)}</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
            <table className="acc-table"><tbody>
              <tr className="subtotal"><td>Saldo según estado de cuenta{r.bank_balance_date ? ` (${dmy(r.bank_balance_date)})` : ''}</td><td className="num">{r.bank_balance === null ? 'sin estado' : money(r.bank_balance)}</td></tr>
              {r.in_books_only.map(l => (
                <tr key={l.id}><td style={{ paddingLeft: 24 }}>{l.debit ? '+ Depósito en tránsito' : '− Cheque/pago en tránsito'} · #{l.entry_number} {l.description ?? l.concept}</td>
                  <td className="num">{money(l.debit - l.credit)}</td></tr>
              ))}
              <tr className="total"><td>Saldo bancario ajustado</td><td className="num">{r.adjusted_bank === null ? '—' : money(r.adjusted_bank)}</td></tr>
            </tbody></table>
            <table className="acc-table"><tbody>
              <tr className="subtotal"><td>Saldo según libros</td><td className="num">{money(r.book_balance)}</td></tr>
              {r.in_bank_only.map(m => (
                <tr key={m.id}><td style={{ paddingLeft: 24 }}>{m.credit ? '+ Abono no registrado' : '− Cargo no registrado'} · {dmy(m.movement_date)} {m.description}</td>
                  <td className="num">{money(m.credit - m.debit)}</td></tr>
              ))}
              <tr className="total"><td>Saldo en libros ajustado</td><td className="num">{money(r.adjusted_books)}</td></tr>
            </tbody></table>
          </div>
          <div style={{ marginTop: 16 }}>
            {r.difference === null ? <div className="banner banner-info">Sube un estado de cuenta para conciliar.</div>
              : r.difference === 0 ? <div className="banner banner-success">Conciliación cuadrada.</div>
              : <div className="banner banner-warning">Diferencia de {money(r.difference)}: puede ser el saldo inicial no registrado en libros o movimientos sin estado de cuenta.</div>}
          </div>
        </div>
      )}
    </>
  );
}

function Cuentas({ accounts }: { accounts: BankAccount[] }) {
  const { can } = usePermissions();
  const [editing, setEditing] = useState<BankAccount | 'new' | null>(null);
  return (
    <>
      {can('banks:manage') && <div className="toolbar"><Button onClick={() => setEditing('new')}>+ Cuenta bancaria</Button></div>}
      {!accounts.length ? <EmptyState title="Sin cuentas bancarias" description="Cada cuenta se liga a una cuenta de movimiento de tu catálogo (p.ej. 1.1.01.03 Banco Agrícola)." /> : (
        <div className="table-wrap"><table className="acc-table">
          <thead><tr><th>Banco</th><th>Número</th><th>Tipo</th><th>Cuenta contable</th><th>Formato del estado</th><th>Estado</th><th /></tr></thead>
          <tbody>{accounts.map(a => (
            <tr key={a.id}>
              <td>{a.bank_name}</td><td className="code">{a.account_number}</td><td>{a.account_type}</td>
              <td><span className="combo-code">{a.ledger_code}</span> {a.ledger_name}</td>
              <td>{a.statement_format === 'bac' ? 'BAC' : 'CSV genérico'}</td>
              <td>{a.is_active ? <Badge tone="success">Activa</Badge> : <Badge>Inactiva</Badge>}</td>
              <td style={{ textAlign: 'right' }}>{can('banks:manage') && <Button size="sm" variant="secondary" onClick={() => setEditing(a)}>Editar</Button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {editing && <AccountModal account={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function AccountModal({ account, onClose }: { account: BankAccount | null; onClose: () => void }) {
  const qc = useQueryClient();
  const accounts = useAccounts();
  const [form, setForm] = useState<AccountInput>({
    bank_name: account?.bank_name ?? 'Banco Agrícola', account_number: account?.account_number ?? '', account_type: account?.account_type ?? 'corriente',
    ledger_account_id: account?.ledger_account_id ?? 0, statement_format: account?.statement_format ?? 'generic',
    csv_mapping: account?.csv_mapping ?? {}, is_active: account?.is_active ?? true,
  });
  const save = useMutation({
    mutationFn: () => account ? bankApi.update(account.id, form) : bankApi.create(form),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['banks'] }); void qc.invalidateQueries({ queryKey: ['acc', 'funds'] }); onClose(); },
  });
  const assets = (accounts.data ?? []).filter(a => a.account_type === 'Activo');
  return (
    <Modal title={account ? 'Editar cuenta bancaria' : 'Nueva cuenta bancaria'} onClose={onClose} onSave={() => save.mutate()}
      saveDisabled={save.isPending || !form.account_number.trim() || !form.ledger_account_id}>
      <ErrorBanner error={save.error} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Banco">
          <Select value={BANKS_SV.includes(form.bank_name) ? form.bank_name : 'Otro'} onChange={e => setForm(f => ({ ...f, bank_name: e.target.value, statement_format: e.target.value === 'BAC Credomatic' ? 'bac' : f.statement_format }))}>
            {BANKS_SV.map(b => <option key={b}>{b}</option>)}
          </Select>
        </Field>
        {!BANKS_SV.slice(0, -1).includes(form.bank_name) && <Field label="Nombre del banco"><Input value={form.bank_name === 'Otro' ? '' : form.bank_name} onChange={e => setForm(f => ({ ...f, bank_name: e.target.value }))} /></Field>}
        <Field label="Número de cuenta"><Input value={form.account_number} onChange={e => setForm(f => ({ ...f, account_number: e.target.value }))} /></Field>
        <Field label="Tipo">
          <Select value={form.account_type} onChange={e => setForm(f => ({ ...f, account_type: e.target.value }))}>
            <option value="corriente">Corriente</option><option value="ahorro">Ahorro</option><option value="otra">Otra</option>
          </Select>
        </Field>
        <Field label="Formato del estado de cuenta">
          <Select value={form.statement_format} onChange={e => setForm(f => ({ ...f, statement_format: e.target.value as 'bac' | 'generic' }))}>
            <option value="bac">BAC</option><option value="generic">CSV genérico (columnas configurables)</option>
          </Select>
        </Field>
      </div>
      <Field label="Cuenta contable (activo de movimiento)">
        <AccountSelect accounts={assets} value={form.ledger_account_id || null} onChange={id => setForm(f => ({ ...f, ledger_account_id: id ?? 0 }))} />
      </Field>
      <label style={{ fontSize: 'var(--text-sm)', display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="checkbox" checked={form.is_active} onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} /> Activa
      </label>
    </Modal>
  );
}
