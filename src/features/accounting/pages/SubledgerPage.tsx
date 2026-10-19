import { Fragment, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Badge } from '@/components/ui/Badge';
import { Tabs } from '@/components/ui/Tabs';
import { KpiCard } from '@/components/ui/KpiCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner, Loading } from '@/components/ui/Feedback';
import { usePermissions } from '@/auth/usePermissions';
import { integrationApi, subApi } from '../api';
import { useAccounts } from '../hooks';
import { todayIso } from '../dates';
import { dmy, money, money2, num } from '../format';
import { AccountSelect } from '../components/AccountSelect';
import { EntryModal } from '../components/EntryModals';
import { downloadText } from '../catalogCsv';
import type { PartyBalance, SubDocument, SubKind } from '../types';

const TEXT = {
  cxc: { title: 'Cuentas por cobrar', party: 'Cliente', parties: 'Clientes', pay: 'Cobro', pays: 'Cobros', perm: 'receivables', newPay: '+ Registrar cobro' },
  cxp: { title: 'Cuentas por pagar', party: 'Proveedor', parties: 'Proveedores', pay: 'Pago', pays: 'Pagos', perm: 'payables', newPay: '+ Registrar pago' },
} as const;

const METHOD_LABEL: Record<string, string> = {
  efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque', tarjeta: 'Tarjeta', compensacion: 'Compensación', otro: 'Otro',
};

type Tab = 'saldos' | 'documentos' | 'antiguedad' | 'pagos';

/** Auxiliar de clientes (CxC) o proveedores (CxP). */
export function SubledgerPage({ kind }: { kind: SubKind }) {
  const t = TEXT[kind];
  const { can } = usePermissions();
  const [tab, setTab] = useState<Tab>('saldos');
  const [paying, setPaying] = useState<{ party_key?: string } | null>(null);
  const [manualDoc, setManualDoc] = useState(false);
  const check = useQuery({ queryKey: ['acc', kind, 'check'], queryFn: () => subApi.check(kind) });
  const parties = useQuery({ queryKey: ['acc', kind, 'parties'], queryFn: () => subApi.parties(kind) });
  const totals = useMemo(() => (parties.data?.items ?? []).reduce((s, p) => ({
    balance: s.balance + p.balance, overdue: s.overdue + p.overdue, advances: s.advances + p.advances,
  }), { balance: 0, overdue: 0, advances: 0 }), [parties.data]);
  const manage = can(`${t.perm}:manage`);

  return (
    <div>
      <SectionHeader title={t.title}
        description={kind === 'cxc' ? 'Facturas al crédito de clientes, cobros aplicados y anticipos.' : 'Compras por pagar a proveedores, pagos aplicados y anticipos.'}
        actions={manage && <>
          <Button variant="secondary" onClick={() => setManualDoc(true)}>+ Documento manual</Button>
          <Button onClick={() => setPaying({})}>{t.newPay}</Button>
        </>}
      />
      <div className="kpi-grid">
        <KpiCard label={`Saldo ${t.parties.toLowerCase()}`} value={money(totals.balance)} size="md" />
        <KpiCard label="Vencido" value={money(totals.overdue)} tone={totals.overdue > 0 ? 'danger' : 'default'} size="md" />
        <KpiCard label="Anticipos" value={money(totals.advances)} size="md" />
        <KpiCard label="Cuenta de control (contable)" value={check.data ? money(check.data.ledger) : '—'} size="md"
          hint={check.data && (check.data.difference === 0
            ? <span style={{ color: 'var(--success-text)' }}>Cuadra con el auxiliar</span>
            : <span style={{ color: 'var(--danger-text)' }}>Diferencia {money(check.data.difference)} con el auxiliar</span>)} />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'saldos', label: `Saldos por ${t.party.toLowerCase()}` },
        { value: 'documentos', label: 'Documentos' },
        { value: 'antiguedad', label: 'Antigüedad' },
        { value: 'pagos', label: t.pays },
      ]} />
      {tab === 'saldos' && <Saldos kind={kind} parties={parties.data?.items} loading={parties.isLoading} error={parties.error}
        onPay={manage ? (party_key => setPaying({ party_key })) : undefined} />}
      {tab === 'documentos' && <Documentos kind={kind} />}
      {tab === 'antiguedad' && <Antiguedad kind={kind} />}
      {tab === 'pagos' && <Pagos kind={kind} />}
      {paying && <PaymentModal kind={kind} initialParty={paying.party_key} parties={parties.data?.items ?? []} onClose={() => setPaying(null)} />}
      {manualDoc && <ManualDocModal kind={kind} onClose={() => setManualDoc(false)} />}
    </div>
  );
}

function Saldos({ kind, parties, loading, error, onPay }: {
  kind: SubKind; parties?: PartyBalance[]; loading: boolean; error: unknown; onPay?: (party_key: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (loading) return <Loading />;
  if (!parties?.length) return <><ErrorBanner error={error} /><EmptyState title="Sin saldos pendientes" /></>;
  return (
    <div className="table-wrap"><div className="table-scroll">
      <table className="acc-table">
        <thead><tr><th>{TEXT[kind].party}</th><th className="num">Documentos</th><th className="num">Vencido</th><th className="num">Anticipos</th><th className="num">Saldo</th><th /></tr></thead>
        <tbody>
          {parties.map(p => (
            <Fragment key={p.party_key}>
              <tr className="clickable" onClick={() => setOpen(o => (o === p.party_key ? null : p.party_key))}>
                <td>{open === p.party_key ? '▾' : '▸'} {p.party_name}</td>
                <td className="num">{p.open_docs}</td>
                <td className="num" style={{ color: p.overdue > 0 ? 'var(--danger-text)' : undefined }}>{money(p.overdue, { blankZero: true })}</td>
                <td className="num">{money(p.advances, { blankZero: true })}</td>
                <td className="num"><strong>{money(p.balance)}</strong></td>
                <td style={{ textAlign: 'right' }}>{onPay && <Button size="sm" variant="secondary" onClick={e => { e.stopPropagation(); onPay(p.party_key); }}>{TEXT[kind].pay}</Button>}</td>
              </tr>
              {open === p.party_key && <tr><td colSpan={6} style={{ background: 'var(--surface-2)' }}><DocsTable kind={kind} partyKey={p.party_key} status="open" compact /></td></tr>}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div></div>
  );
}

function DocsTable({ kind, partyKey, status, compact, search }: { kind: SubKind; partyKey?: string; status: string; compact?: boolean; search?: string }) {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const [entry, setEntry] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['acc', kind, 'docs', partyKey, status, search], queryFn: () => subApi.documents(kind, { party_key: partyKey, status, q: search }) });
  const voidDoc = useMutation({
    mutationFn: (d: SubDocument) => {
      const reason = window.prompt('Motivo de la anulación del documento manual');
      if (!reason) throw new Error('Anulación cancelada');
      return subApi.voidDocument(kind, d.id, reason);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['acc'] }),
  });
  if (q.isLoading) return <Loading />;
  const items = q.data?.items ?? [];
  if (!items.length) return <EmptyState title="Sin documentos" />;
  return (
    <>
      <ErrorBanner error={q.error ?? (voidDoc.error instanceof Error && voidDoc.error.message === 'Anulación cancelada' ? null : voidDoc.error)} />
      <table className="acc-table">
        <thead><tr>{!compact && <th>{TEXT[kind].party}</th>}<th>Documento</th><th>Fecha</th><th>Vence</th><th className="num">Monto</th><th className="num">Aplicado</th><th className="num">Saldo</th><th /></tr></thead>
        <tbody>
          {items.map(d => (
            <tr key={d.id}>
              {!compact && <td>{d.party_name}</td>}
              <td>{d.doc_type === '05' ? 'NC ' : ''}{d.doc_number}{d.source_module === 'manual' && <> <Badge>Manual</Badge></>}</td>
              <td className="code">{dmy(d.doc_date)}</td>
              <td className="code" style={{ color: d.balance > 0 && d.days_overdue > 0 ? 'var(--danger-text)' : undefined }}>
                {dmy(d.due_date)}{d.balance > 0 && d.days_overdue > 0 ? ` (${d.days_overdue} d)` : ''}
              </td>
              <td className="num">{money(d.amount)}</td>
              <td className="num">{money(d.applied, { blankZero: true })}</td>
              <td className="num"><strong>{money(d.balance)}</strong></td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                {d.entry_id && <Button size="sm" variant="secondary" onClick={() => setEntry(d.entry_id!)}>Asiento</Button>}
                {d.source_module === 'manual' && d.applied === 0 && can(`${TEXT[kind].perm}:manage`) &&
                  <> <Button size="sm" variant="danger" onClick={() => voidDoc.mutate(d)}>Anular</Button></>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {entry !== null && <EntryModal id={entry} onClose={() => setEntry(null)} />}
    </>
  );
}

function Documentos({ kind }: { kind: SubKind }) {
  const [status, setStatus] = useState('open');
  const [search, setSearch] = useState('');
  return (
    <>
      <div className="toolbar">
        <Select value={status} onChange={e => setStatus(e.target.value)} style={{ width: 200 }}>
          <option value="open">Con saldo</option>
          <option value="all">Todos los vigentes</option>
          <option value="void">Anulados</option>
        </Select>
        <Input placeholder="Buscar documento o tercero…" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 300 }} />
      </div>
      <div className="table-wrap"><div className="table-scroll"><DocsTable kind={kind} status={status} search={search || undefined} /></div></div>
    </>
  );
}

function Antiguedad({ kind }: { kind: SubKind }) {
  const [asOf, setAsOf] = useState(todayIso());
  const q = useQuery({ queryKey: ['acc', kind, 'aging', asOf], queryFn: () => subApi.aging(kind, asOf) });
  const rows = q.data?.items ?? [];
  const sum = (k: 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus' | 'total') => rows.reduce((s, r) => s + r[k], 0);
  const csv = () => downloadText(`antiguedad-${kind}-${asOf}.csv`, ['tercero,corriente,1-30,31-60,61-90,mas_de_90,total',
    ...rows.map(r => [`"${r.party_name.replace(/"/g, '""')}"`, r.current, r.d1_30, r.d31_60, r.d61_90, r.d90_plus, r.total].join(','))].join('\r\n'));
  return (
    <>
      <div className="toolbar no-print">
        <Field label="Saldos al"><Input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} /></Field>
        <Button variant="secondary" onClick={() => window.print()}>Imprimir / PDF</Button>
        <Button variant="secondary" onClick={csv}>Exportar CSV</Button>
      </div>
      <ErrorBanner error={q.error} />
      {q.isLoading ? <Loading /> : !rows.length ? <EmptyState title="Sin saldos a esa fecha" /> : (
        <div className="table-wrap"><div className="table-scroll">
          <table className="acc-table">
            <thead><tr><th>{TEXT[kind].party}</th><th className="num">No vencido</th><th className="num">1–30 días</th><th className="num">31–60</th><th className="num">61–90</th><th className="num">Más de 90</th><th className="num">Total</th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.party_key}>
                  <td>{r.party_name}</td>
                  <td className="num">{money(r.current, { blankZero: true })}</td>
                  <td className="num">{money(r.d1_30, { blankZero: true })}</td>
                  <td className="num">{money(r.d31_60, { blankZero: true })}</td>
                  <td className="num">{money(r.d61_90, { blankZero: true })}</td>
                  <td className="num" style={{ color: r.d90_plus ? 'var(--danger-text)' : undefined }}>{money(r.d90_plus, { blankZero: true })}</td>
                  <td className="num"><strong>{money(r.total)}</strong></td>
                </tr>
              ))}
              <tr className="total"><td>Total</td>
                <td className="num">{money(sum('current'))}</td><td className="num">{money(sum('d1_30'))}</td><td className="num">{money(sum('d31_60'))}</td>
                <td className="num">{money(sum('d61_90'))}</td><td className="num">{money(sum('d90_plus'))}</td><td className="num">{money(sum('total'))}</td></tr>
            </tbody>
          </table>
        </div></div>
      )}
    </>
  );
}

function Pagos({ kind }: { kind: SubKind }) {
  const [open, setOpen] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['acc', kind, 'payments'], queryFn: () => subApi.payments(kind, {}) });
  if (q.isLoading) return <Loading />;
  const items = q.data?.items ?? [];
  if (!items.length) return <EmptyState title={`Sin ${TEXT[kind].pays.toLowerCase()} registrados`} />;
  return (
    <div className="table-wrap"><div className="table-scroll">
      <table className="acc-table">
        <thead><tr><th>N.º</th><th>Fecha</th><th>{TEXT[kind].party}</th><th>Forma</th><th>Cuenta</th><th>Referencia</th><th className="num">Monto</th><th className="num">Anticipo</th><th>Estado</th></tr></thead>
        <tbody>
          {items.map(p => (
            <tr key={p.id} className={`clickable${p.status === 'anulado' ? ' voided' : ''}`} onClick={() => setOpen(p.id)}>
              <td className="code">{kind === 'cxc' ? 'C' : 'P'}-{String(p.number).padStart(5, '0')}</td>
              <td className="code">{dmy(p.payment_date)}</td>
              <td>{p.party_name}</td>
              <td>{METHOD_LABEL[p.method] ?? p.method}</td>
              <td className="muted">{p.fund_code ? `${p.fund_code} ${p.fund_name}` : ''}</td>
              <td className="muted">{p.reference}</td>
              <td className="num">{money(p.amount)}</td>
              <td className="num">{money(p.unapplied, { blankZero: true })}</td>
              <td>{p.status === 'anulado' ? <Badge>Anulado</Badge> : <Badge tone="success">Vigente</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {open !== null && <PaymentDetail kind={kind} id={open} onClose={() => setOpen(null)} />}
    </div></div>
  );
}

function PaymentDetail({ kind, id, onClose }: { kind: SubKind; id: number; onClose: () => void }) {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [voiding, setVoiding] = useState(false);
  const [entry, setEntry] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['acc', kind, 'payment', id], queryFn: () => subApi.payment(kind, id) });
  const voidM = useMutation({
    mutationFn: () => subApi.voidPayment(kind, id, reason),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['acc'] }); onClose(); },
  });
  if (entry !== null) return <EntryModal id={entry} onClose={() => setEntry(null)} />;
  const p = q.data?.payment;
  return (
    <Modal title={p ? `${TEXT[kind].pay} ${kind === 'cxc' ? 'C' : 'P'}-${String(p.number).padStart(5, '0')}` : TEXT[kind].pay} onClose={onClose} size="wide"
      footer={p && <>
        {p.entry_id && <Button variant="secondary" onClick={() => setEntry(p.entry_id!)} style={{ marginRight: 'auto' }}>Ver asiento</Button>}
        {p.status === 'vigente' && can(`${TEXT[kind].perm}:manage`) && <Button variant="danger" onClick={() => setVoiding(true)}>Anular</Button>}
        <Button variant="secondary" onClick={onClose}>Cerrar</Button>
      </>}>
      {!p ? <Loading /> : <>
        <ErrorBanner error={voidM.error} />
        <div className="stat-row">
          <span>{p.party_name}</span><span>Fecha <strong>{dmy(p.payment_date)}</strong></span>
          <span>{METHOD_LABEL[p.method]}</span><span>Monto <strong>{money(p.amount)}</strong></span>
          {p.unapplied > 0 && <span>Anticipo <strong>{money(p.unapplied)}</strong></span>}
          {p.reference && <span>Ref. {p.reference}</span>}
        </div>
        {p.status === 'anulado' && <div className="banner banner-warning">Anulado por {p.voided_by_name}: {p.void_reason}</div>}
        <table className="acc-table">
          <thead><tr><th>Documento</th><th>Fecha</th><th className="num">Monto doc.</th><th className="num">Aplicado</th></tr></thead>
          <tbody>
            {q.data!.allocations.map(a => (
              <tr key={a.document_id}><td>{a.doc_number}</td><td className="code">{dmy(a.doc_date)}</td><td className="num">{money(a.doc_amount)}</td><td className="num">{money(a.amount)}</td></tr>
            ))}
          </tbody>
        </table>
        {voiding && <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <Field label="Motivo"><Input value={reason} onChange={e => setReason(e.target.value)} autoFocus /></Field>
          <Button variant="danger" onClick={() => voidM.mutate()} disabled={reason.trim().length < 3 || voidM.isPending}>Confirmar anulación</Button>
        </div>}
      </>}
    </Modal>
  );
}

function PaymentModal({ kind, initialParty, parties, onClose }: { kind: SubKind; initialParty?: string; parties: PartyBalance[]; onClose: () => void }) {
  const t = TEXT[kind];
  const qc = useQueryClient();
  const contribs = useQuery({ queryKey: ['acc', 'parties-all'], queryFn: integrationApi.parties });
  const funds = useQuery({ queryKey: ['acc', 'funds'], queryFn: subApi.fundAccounts });
  const [partyKey, setPartyKey] = useState(initialParty ?? '');
  const [date, setDate] = useState(todayIso());
  const [method, setMethod] = useState('transferencia');
  const [fund, setFund] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [alloc, setAlloc] = useState<Record<number, string>>({});
  const docs = useQuery({
    queryKey: ['acc', kind, 'docs', partyKey, 'open'],
    queryFn: () => subApi.documents(kind, { party_key: partyKey, status: 'open' }),
    enabled: !!partyKey,
  });
  useEffect(() => { setAlloc({}); }, [partyKey]);
  useEffect(() => { if (!fund && funds.data?.length) setFund(funds.data[0]!.id); }, [funds.data, fund]);

  // Opciones: terceros con saldo + contribuyentes registrados (para anticipos)
  const options = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of parties) m.set(p.party_key, `${p.party_name} — saldo ${money(p.balance)}`);
    for (const c of contribs.data?.items ?? []) {
      const key = `id:${c.party_id}`;
      const want = kind === 'cxc' ? c.tipo !== 'Proveedor' : c.tipo !== 'Cliente';
      if (!m.has(key) && want) m.set(key, c.nombre);
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [parties, contribs.data, kind]);

  const applied = money2(Object.values(alloc).reduce((s, v) => s + num(v), 0));
  const total = method === 'compensacion' ? 0 : num(amount);
  const advance = money2(total - applied);

  function autoApply() {
    let left = num(amount);
    const out: Record<number, string> = {};
    for (const d of docs.data?.items ?? []) {
      if (d.balance <= 0 || left <= 0) continue;
      const a = Math.min(d.balance, left);
      out[d.id] = String(money2(a));
      left = money2(left - a);
    }
    setAlloc(out);
  }

  const save = useMutation({
    mutationFn: () => subApi.createPayment(kind, {
      payment_date: date, party_key: partyKey, method, fund_account_id: method === 'compensacion' ? null : fund,
      amount: total, reference: reference || null,
      allocations: Object.entries(alloc).filter(([, v]) => num(v) !== 0).map(([id, v]) => ({ document_id: Number(id), amount: num(v) })),
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['acc'] }); onClose(); },
  });

  return (
    <Modal title={`Registrar ${t.pay.toLowerCase()}`} onClose={onClose} size="wide"
      footer={<>
        <span style={{ marginRight: 'auto', fontSize: 'var(--text-sm)' }}>
          Aplicado <strong>{money(applied)}</strong>{advance > 0 && <> · Anticipo <strong>{money(advance)}</strong></>}
          {advance < 0 && <span style={{ color: 'var(--danger-text)' }}> · Lo aplicado supera el monto</span>}
        </span>
        <Button variant="secondary" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending || !partyKey || advance < 0 || (method !== 'compensacion' && (!fund || total <= 0))}>Guardar</Button>
      </>}>
      <ErrorBanner error={save.error} />
      <Field label={t.party}>
        <Select value={partyKey} onChange={e => setPartyKey(e.target.value)}>
          <option value="">— Elegir —</option>
          {options.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </Select>
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '160px 180px 1fr 160px', gap: 12 }}>
        <Field label="Fecha"><Input type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
        <Field label="Forma">
          <Select value={method} onChange={e => setMethod(e.target.value)}>
            {Object.entries(METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label={kind === 'cxc' ? 'Entra a (caja / banco)' : 'Sale de (caja / banco)'}>
          <Select value={fund ?? ''} onChange={e => setFund(e.target.value ? Number(e.target.value) : null)} disabled={method === 'compensacion'}>
            <option value="">— Elegir —</option>
            {(funds.data ?? []).map(f => <option key={f.id} value={f.id}>{f.code} {f.name}</option>)}
          </Select>
        </Field>
        <Field label="Monto"><Input inputMode="decimal" value={method === 'compensacion' ? '0' : amount} disabled={method === 'compensacion'}
          onChange={e => setAmount(e.target.value)} style={{ textAlign: 'right' }} /></Field>
      </div>
      <Field label="Referencia (n.º de cheque, transferencia…)"><Input value={reference} onChange={e => setReference(e.target.value)} /></Field>
      {partyKey && (docs.isLoading ? <Loading /> : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: 'var(--text-sm)' }}>Documentos con saldo</strong>
            {method !== 'compensacion' && <Button size="sm" variant="secondary" onClick={autoApply} disabled={!num(amount)}>Aplicar a los más antiguos</Button>}
          </div>
          {!(docs.data?.items ?? []).length ? <div className="muted" style={{ fontSize: 'var(--text-sm)' }}>Sin documentos pendientes: el monto queda como anticipo.</div> : (
            <table className="acc-table lines-editor">
              <thead><tr><th>Documento</th><th>Vence</th><th className="num">Saldo</th><th className="num" style={{ width: 150 }}>Aplicar</th></tr></thead>
              <tbody>
                {docs.data!.items.map(d => (
                  <tr key={d.id}>
                    <td>{d.doc_type === '05' ? 'NC ' : ''}{d.doc_number}</td>
                    <td className="code">{dmy(d.due_date)}</td>
                    <td className="num">{money(d.balance)}</td>
                    <td><Input inputMode="decimal" style={{ textAlign: 'right' }} value={alloc[d.id] ?? ''}
                      onChange={e => setAlloc(a => ({ ...a, [d.id]: e.target.value }))}
                      onDoubleClick={() => setAlloc(a => ({ ...a, [d.id]: String(d.balance) }))} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ))}
    </Modal>
  );
}

function ManualDocModal({ kind, onClose }: { kind: SubKind; onClose: () => void }) {
  const qc = useQueryClient();
  const accounts = useAccounts();
  const contribs = useQuery({ queryKey: ['acc', 'parties-all'], queryFn: integrationApi.parties });
  const [form, setForm] = useState({ party_id: '', doc_number: '', doc_date: todayIso(), due_date: '', amount: '', description: '' });
  const [counter, setCounter] = useState<number | null>(null);
  const save = useMutation({
    mutationFn: () => subApi.createDocument(kind, {
      party_id: Number(form.party_id), doc_number: form.doc_number || null, doc_date: form.doc_date, due_date: form.due_date || null,
      amount: num(form.amount), counter_account_id: counter!, description: form.description || null,
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['acc'] }); onClose(); },
  });
  const set = (k: keyof typeof form, v: string) => setForm(f => ({ ...f, [k]: v }));
  return (
    <Modal title={`Documento manual — ${TEXT[kind].title}`} onClose={onClose} onSave={() => save.mutate()}
      saveDisabled={save.isPending || !form.party_id || !num(form.amount) || !counter}>
      <ErrorBanner error={save.error} />
      <div className="banner banner-info">
        Para saldos iniciales por {TEXT[kind].party.toLowerCase()} o documentos sin DTE. La contrapartida suele ser la cuenta de apertura
        (p.ej. utilidades acumuladas) o el ingreso/gasto correspondiente. Un monto negativo registra una nota de crédito.
      </div>
      <Field label={TEXT[kind].party}>
        <Select value={form.party_id} onChange={e => set('party_id', e.target.value)}>
          <option value="">— Elegir de Contribuyentes —</option>
          {(contribs.data?.items ?? []).map(c => <option key={c.party_id} value={c.party_id}>{c.nombre}{c.nit ? ` · ${c.nit}` : ''}</option>)}
        </Select>
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="N.º de documento"><Input value={form.doc_number} onChange={e => set('doc_number', e.target.value)} /></Field>
        <Field label="Monto"><Input inputMode="decimal" value={form.amount} onChange={e => set('amount', e.target.value)} /></Field>
        <Field label="Fecha"><Input type="date" value={form.doc_date} onChange={e => set('doc_date', e.target.value)} /></Field>
        <Field label="Vence"><Input type="date" value={form.due_date} onChange={e => set('due_date', e.target.value)} /></Field>
      </div>
      <Field label="Contrapartida"><AccountSelect accounts={accounts.data ?? []} value={counter} onChange={setCounter} /></Field>
      <Field label="Descripción"><Input value={form.description} onChange={e => set('description', e.target.value)} /></Field>
    </Modal>
  );
}

