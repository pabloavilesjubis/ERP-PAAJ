import { Fragment, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { RouteTabs } from '@/components/ui/Tabs';
import { KpiCard } from '@/components/ui/KpiCard';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner, Loading } from '@/components/ui/Feedback';
import { usePermissions } from '@/auth/usePermissions';
import { subApi } from '@/features/accounting/api';
import { EntryModal } from '@/features/accounting/components/EntryModals';
import { todayIso } from '@/features/accounting/dates';
import { dmy, money, MONTHS_ES, num } from '@/features/accounting/format';
import { fiscalApi, type FiscalMonth, type FiscalSettings } from './api';
import { ObligacionesPage } from './ObligacionesPage';

const monthName = (iso: string) => `${MONTHS_ES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

export type FiscalTab = 'iva' | 'obligaciones';

/** Posición fiscal: IVA y pago a cuenta por mes, y las obligaciones patronales (ISSS, AFP, renta). */
export function PosicionFiscalPage({ tab = 'iva' }: { tab?: FiscalTab }) {
  return (
    <div>
      <SectionHeader title="Posición fiscal" description="IVA (F-07), pago a cuenta y retenciones (F-14) de cada mes, y las obligaciones patronales: ISSS, AFP y renta." />
      <RouteTabs tabs={[
        { to: '/fiscal', label: 'IVA y pago a cuenta', end: true },
        { to: '/fiscal/obligaciones', label: 'Obligaciones patronales' },
      ]} />
      {tab === 'iva' ? <IvaPagoCuenta /> : <ObligacionesPage />}
    </div>
  );
}

const shiftMonth = (ym: string, n: number) => {
  const d = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 15);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/**
 * IVA (F-07) con remanente encadenado y pago a cuenta + retenciones (F-14),
 * mes a mes, con su liquidación y pagos contabilizados.
 */
function IvaPagoCuenta() {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const [to, setTo] = useState(todayIso());
  const [from, setFrom] = useState(shiftMonth(todayIso().slice(0, 7), -5));
  const [open, setOpen] = useState<string | null>(null);
  const settings = useQuery({ queryKey: ['fiscal', 'settings'], queryFn: fiscalApi.settings });
  const months = useQuery({ queryKey: ['fiscal', 'months', to], queryFn: () => fiscalApi.months(to), enabled: !!settings.data?.settings });
  const [paying, setPaying] = useState<{ m: FiscalMonth; form: 'F07' | 'F14' } | null>(null);
  const [entry, setEntry] = useState<number | null>(null);
  const [voiding, setVoiding] = useState<number | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['fiscal'] }); void qc.invalidateQueries({ queryKey: ['acc'] }); };
  const liquidate = useMutation({ mutationFn: (p: string) => fiscalApi.liquidate(p), onSuccess: refresh });
  const undo = useMutation({
    mutationFn: (p: string) => { const r = window.prompt('Motivo para deshacer la liquidación'); if (!r) throw new Error('cancelado'); return fiscalApi.undoLiquidation(p, r); },
    onSuccess: refresh,
  });
  const manage = can('fiscal:manage');
  const visible = (months.data?.items ?? []).filter(m => m.period.slice(0, 7) >= from);
  const sum = (k: keyof FiscalMonth) => visible.reduce((t, m) => t + (Number(m[k]) || 0), 0);

  return (
    <div>
      <SettingsCard current={settings.data?.settings ?? null} editable={manage} />
      {!settings.data?.settings ? (settings.isLoading ? <Loading /> : null) : <>
        <div className="toolbar" style={{ marginTop: 'var(--s-5)' }}>
          <Field label="Desde"><Input type="month" value={from} max={to.slice(0, 7)} onChange={e => e.target.value && setFrom(e.target.value)} /></Field>
          <Field label="Hasta"><Input type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>
        </div>
        <ErrorBanner error={months.error ?? liquidate.error ?? (undo.error instanceof Error && undo.error.message === 'cancelado' ? null : undo.error)} />
        {months.isLoading ? <Loading /> : !visible.length ? <EmptyState title="Sin meses en el rango" /> : (<>
          <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginBottom: 'var(--s-5)' }}>
            <KpiCard size="md" label="Ventas netas" value={money(sum('ventas_netas'))} hint="sin IVA" />
            <KpiCard size="md" label="IVA débito fiscal" value={money(sum('debito'))} />
            <KpiCard size="md" label="Crédito fiscal" value={money(sum('credito'))} hint={`percepción ${money(sum('percepcion'))}`} />
            <KpiCard size="md" label="IVA a pagar (F-07)" value={money(sum('f07'))} />
            <KpiCard size="md" label="Pago a cuenta + retenciones (F-14)" value={money(sum('f14'))} />
            <KpiCard size="md" tone={sum('pendiente') > 0.004 ? 'danger' : 'success'} label="Pendiente de pago" value={money(sum('pendiente'))} hint="F-07 + F-14" />
          </div>
          <div className="table-wrap"><div className="table-scroll">
            <table className="acc-table">
              <thead><tr>
                <th /><th>Mes</th><th className="num">Débito</th><th className="num">Crédito</th><th className="num">Percep./ret.</th><th className="num">Remanente ant.</th>
                <th className="num">IVA a pagar</th><th className="num">F-07</th><th className="num">Pago a cuenta</th><th className="num">Renta ret.</th><th className="num">F-14</th><th>Estado</th><th />
              </tr></thead>
              <tbody>{visible.map(m => {
                const ret = m.isr_planilla + m.isr_compras;
                return (
                  <Fragment key={m.period}>
                  <tr style={{ cursor: 'pointer' }} onClick={() => setOpen(open === m.period ? null : m.period)}>
                    <td className="muted" aria-label={open === m.period ? 'Ocultar detalle' : 'Ver detalle'}>{open === m.period ? '▾' : '▸'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{monthName(m.period)}<div className="muted" style={{ fontSize: 'var(--text-xs)' }}>{m.ventas_docs} ventas · {m.compras_docs} compras</div></td>
                    <td className="num">{money(m.debito)}</td>
                    <td className="num">{money(m.credito)}</td>
                    <td className="num">{money(m.percepcion + m.ret_iva_clientes, { blankZero: true })}</td>
                    <td className="num">{money(m.remanente_anterior, { blankZero: true })}</td>
                    <td className="num">{m.iva_a_pagar ? money(m.iva_a_pagar) : <span className="muted">Remanente {money(m.remanente_siguiente)}</span>}</td>
                    <td className="num"><strong>{money(m.f07)}</strong></td>
                    <td className="num">{money(m.pago_a_cuenta)}</td>
                    <td className="num">{money(ret, { blankZero: true })}</td>
                    <td className="num"><strong>{money(m.f14)}</strong></td>
                    <td>
                      {m.liquidation_entry_id ? <Badge tone="info">IVA liquidado</Badge> : null}{' '}
                      {m.pendiente <= 0.004 ? <Badge tone="success">Pagado</Badge> : <Badge tone="warning">Pendiente {money(m.pendiente)}</Badge>}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                      {m.liquidation_entry_id
                        ? <><Button size="sm" variant="secondary" onClick={() => setEntry(m.liquidation_entry_id!)}>Asiento</Button>{' '}
                            {manage && <Button size="sm" variant="secondary" onClick={() => undo.mutate(m.period)}>Deshacer</Button>}</>
                        : manage && <Button size="sm" variant="secondary" onClick={() => liquidate.mutate(m.period)} disabled={liquidate.isPending}>Liquidar IVA</Button>}{' '}
                      {manage && m.f07 - m.pagado_f07 > 0.004 && <Button size="sm" onClick={() => setPaying({ m, form: 'F07' })}>Pagar F-07</Button>}{' '}
                      {manage && m.f14 - m.pagado_f14 > 0.004 && <Button size="sm" onClick={() => setPaying({ m, form: 'F14' })}>Pagar F-14</Button>}
                    </td>
                  </tr>
                  {open === m.period && <tr><td /><td colSpan={12}><MonthDetail m={m} /></td></tr>}
                  </Fragment>
                );
              })}</tbody>
            </table>
          </div></div>
          <p className="muted" style={{ fontSize: 'var(--text-xs)', marginTop: 'var(--s-3)' }}>
            IVA del mes = débito − crédito − percepciones − retenciones de clientes − remanente anterior; si sale negativo pasa como remanente al mes siguiente.
            Las retenciones de IVA que hicimos se pagan en el F-07. F-14 = pago a cuenta + renta retenida en planillas, liquidaciones y compras.
          </p>
        </>)}
        {(months.data?.payments ?? []).length > 0 && <>
          <div className="section-title" style={{ margin: 'var(--s-6) 0 var(--s-3)' }}>Pagos registrados</div>
          <div className="table-wrap"><table className="acc-table">
            <thead><tr><th>Formulario</th><th>Período</th><th>Fecha</th><th>Referencia</th><th className="num">Monto</th><th>Estado</th><th /></tr></thead>
            <tbody>{months.data!.payments.map(p => (
              <tr key={p.id} className={p.status === 'anulado' ? 'voided' : ''}>
                <td>{p.form === 'F07' ? 'F-07 IVA' : 'F-14 Pago a cuenta'}</td><td>{monthName(p.period)}</td><td className="code">{dmy(p.payment_date)}</td>
                <td className="muted">{p.reference}</td><td className="num">{money(p.amount)}</td>
                <td>{p.status === 'anulado' ? <Badge>Anulado</Badge> : <Badge tone="success">Vigente</Badge>}</td>
                <td style={{ textAlign: 'right' }}>
                  {p.entry_id && <Button size="sm" variant="secondary" onClick={() => setEntry(p.entry_id!)}>Asiento</Button>}{' '}
                  {manage && p.status === 'vigente' && <Button size="sm" variant="danger" onClick={() => setVoiding(p.id)}>Anular</Button>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        </>}
      </>}
      {paying && <PayModal month={paying.m} form={paying.form} onClose={() => setPaying(null)} />}
      {voiding !== null && <VoidPayment id={voiding} onClose={() => setVoiding(null)} />}
      {entry !== null && <EntryModal id={entry} onClose={() => setEntry(null)} />}
    </div>
  );
}

function SettingsCard({ current, editable }: { current: FiscalSettings | null; editable: boolean }) {
  const qc = useQueryClient();
  const [f, setF] = useState<FiscalSettings>({ opening_period: todayIso().slice(0, 8) + '01', opening_remanente: 0, pago_a_cuenta_rate: 0.0175 });
  useEffect(() => { if (current) setF({ ...current, opening_period: current.opening_period.slice(0, 10) }); }, [current]);
  const save = useMutation({ mutationFn: () => fiscalApi.saveSettings(f), onSuccess: () => void qc.invalidateQueries({ queryKey: ['fiscal'] }) });
  return (
    <div className="tax-card">
      <div className="tax-card-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>Punto de partida</span>{editable && <Button onClick={() => save.mutate()} disabled={save.isPending}>Guardar</Button>}
      </div>
      <ErrorBanner error={save.error} />
      {!current && <div className="banner banner-info" style={{ marginBottom: 12 }}>Indica desde qué mes calcular y el remanente de crédito fiscal con el que empiezas (del último F-07 presentado).</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Field label="Mes inicial"><Input type="date" disabled={!editable} value={f.opening_period} onChange={e => setF({ ...f, opening_period: e.target.value })} /></Field>
        <Field label="Remanente inicial de IVA"><Input inputMode="decimal" disabled={!editable} value={f.opening_remanente} onChange={e => setF({ ...f, opening_remanente: num(e.target.value) })} /></Field>
        <Field label="Tasa de pago a cuenta (%)"><Input inputMode="decimal" disabled={!editable} value={Math.round(f.pago_a_cuenta_rate * 10000) / 100} onChange={e => setF({ ...f, pago_a_cuenta_rate: num(e.target.value) / 100 })} /></Field>
      </div>
    </div>
  );
}

function PayModal({ month: m, form, onClose }: { month: FiscalMonth; form: 'F07' | 'F14'; onClose: () => void }) {
  const qc = useQueryClient();
  const funds = useQuery({ queryKey: ['acc', 'funds'], queryFn: subApi.fundAccounts });
  const [main, setMain] = useState(String(form === 'F07' ? m.iva_a_pagar : m.pago_a_cuenta));
  const [wh, setWh] = useState(String(form === 'F07' ? m.ret_iva_hechas : m.isr_planilla + m.isr_compras));
  const [date, setDate] = useState(todayIso());
  const [fund, setFund] = useState<number | null>(null);
  const [ref, setRef] = useState('');
  useEffect(() => { if (!fund && funds.data?.length) setFund(funds.data[0]!.id); }, [funds.data, fund]);
  const run = useMutation({
    mutationFn: () => fiscalApi.pay({ form, period: m.period, payment_date: date, main: num(main), withholdings: num(wh), fund_account_id: fund!, reference: ref || null }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['fiscal'] }); void qc.invalidateQueries({ queryKey: ['acc'] }); onClose(); },
  });
  return (
    <Modal title={`Pago ${form === 'F07' ? 'F-07 (IVA)' : 'F-14 (pago a cuenta y retenciones)'} — ${monthName(m.period)}`} onClose={onClose}
      onSave={() => run.mutate()} saveDisabled={!fund || run.isPending || num(main) + num(wh) <= 0} saveLabel={`Registrar ${money(num(main) + num(wh))}`}>
      <ErrorBanner error={run.error} />
      {form === 'F07' && !m.liquidation_entry_id && num(main) > 0 && <div className="banner banner-warning">Liquida primero el IVA del mes para que «IVA por pagar» tenga su saldo.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label={form === 'F07' ? 'IVA del mes' : 'Pago a cuenta'}><Input inputMode="decimal" value={main} onChange={e => setMain(e.target.value)} /></Field>
        <Field label={form === 'F07' ? 'Retenciones de IVA hechas' : 'Renta retenida (planilla y compras)'}><Input inputMode="decimal" value={wh} onChange={e => setWh(e.target.value)} /></Field>
        <Field label="Fecha de pago"><Input type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
        <Field label="Pagado desde">
          <Select value={fund ?? ''} onChange={e => setFund(Number(e.target.value))}>
            {(funds.data ?? []).map(f => <option key={f.id} value={f.id}>{f.code} {f.name}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="N.º de mandamiento / referencia"><Input value={ref} onChange={e => setRef(e.target.value)} /></Field>
    </Modal>
  );
}

function VoidPayment({ id, onClose }: { id: number; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const run = useMutation({ mutationFn: () => fiscalApi.voidPayment(id, reason), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['fiscal'] }); void qc.invalidateQueries({ queryKey: ['acc'] }); onClose(); } });
  return (
    <Modal title="Anular pago de impuestos" onClose={onClose} onSave={() => run.mutate()} saveDisabled={reason.trim().length < 3 || run.isPending} saveLabel="Anular">
      <ErrorBanner error={run.error} />
      <Field label="Motivo"><Input value={reason} onChange={e => setReason(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}

function MonthDetail({ m }: { m: FiscalMonth }) {
  const row = (label: string, value: number, strong = false) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontWeight: strong ? 700 : 400 }}><span>{label}</span><span className="num">{money(value)}</span></div>
  );
  const head = (t: string) => <div className="muted" style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>{t}</div>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 24, padding: '8px 0', fontSize: 'var(--text-sm)' }}>
      <div>
        {head('Ventas')}
        {row('Ventas netas (sin IVA)', m.ventas_netas)}
        {row('Base del pago a cuenta', m.base_pago_cuenta)}
        {row('Retenciones de IVA de clientes', m.ret_iva_clientes)}
        {row('Renta que nos retuvieron', m.ret_renta_clientes)}
        {row('Débito fiscal', m.debito, true)}
        <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>{m.ventas_docs} documento(s)</div>
      </div>
      <div>
        {head('Compras (libro de compras)')}
        {row('Percepción IVA 1 % (a favor)', m.percepcion)}
        {row('Retenciones de IVA que hicimos', m.ret_iva_hechas)}
        {row('Renta retenida en compras', m.isr_compras)}
        {row('Crédito fiscal', m.credito, true)}
        <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>{m.compras_docs} documento(s)</div>
      </div>
      <div>
        {head('Liquidación')}
        {row('Remanente del mes anterior', m.remanente_anterior)}
        {row('Impuesto del mes (neto)', m.iva_neto)}
        {row('F-07 a pagar', m.f07, true)}
        {row('Remanente para el mes siguiente', m.remanente_siguiente)}
        {row('Pago a cuenta', m.pago_a_cuenta)}
        {row('Renta retenida en planilla', m.isr_planilla)}
        {row('Renta retenida en compras', m.isr_compras)}
        {row('F-14 a pagar', m.f14, true)}
        {row('Pagado F-07 / F-14', m.pagado_f07 + m.pagado_f14)}
      </div>
    </div>
  );
}
