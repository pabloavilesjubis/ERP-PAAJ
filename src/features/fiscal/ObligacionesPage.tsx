import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { KpiCard } from '@/components/ui/KpiCard';
import { ErrorBanner, Loading } from '@/components/ui/Feedback';
import { usePermissions } from '@/auth/usePermissions';
import { subApi } from '@/features/accounting/api';
import { EntryModal } from '@/features/accounting/components/EntryModals';
import { todayIso } from '@/features/accounting/dates';
import { dmy, money, num } from '@/features/accounting/format';
import {
  fiscalApi, obligationsApi,
  type EmployerObligations, type FeeKind, type ObligationInputs, type ObligationMode, type ObligationPayee, type ObligationPayeeKey,
} from './api';
import { AFP_LABEL, PART_LABEL, monthName } from './obligationsReport';
import { PrintObligationsModal } from './PrintObligationsModal';

const m$ = (n: number | null | undefined) => (n == null ? '—' : `$${money(n)}`);
const pct = (r: number) => `${(r * 100).toLocaleString('es-SV', { maximumFractionDigits: 2 })} %`;
const prevMonth = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y!, m! - 2, 15);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const amountOf = (v: string) => {
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
};
const PAYEE_KEYS: ObligationPayeeKey[] = ['isss', 'afp_confia', 'afp_crecer', 'afp_sin'];
const PAYEE_NAME: Record<string, string> = { isss: 'ISSS', afp_confia: 'AFP Confía', afp_crecer: 'AFP Crecer', afp_sin: 'AFP (sin asignar)' };

/**
 * Obligaciones patronales: ISSS, AFP y renta del mes (de las planillas
 * emitidas, o estimadas con el salario de los empleados + la renta variable
 * que se escribe aquí), renta retenida a honorarios y la consolidación de lo
 * que hay que pagar: Hacienda (F-07, F-14), ISSS y cada AFP, con sus pagos.
 */
export function ObligacionesPage() {
  const { can } = usePermissions();
  const manage = can('fiscal:manage');
  const qc = useQueryClient();
  const current = todayIso().slice(0, 7);
  const [month, setMonth] = useState(prevMonth(current));
  const [data, setData] = useState<EmployerObligations | null>(null);
  const [inputs, setInputs] = useState<ObligationInputs | null>(null);
  // Lo que el usuario escribe, como texto para que "12." no salte
  const [variableText, setVariableText] = useState<Record<string, string>>({});
  const [feeText, setFeeText] = useState<Record<number, string>>({});
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [printing, setPrinting] = useState(false);
  const [paying, setPaying] = useState<ObligationPayee | null>(null);
  const [entry, setEntry] = useState<number | null>(null);
  const [voiding, setVoiding] = useState<number | null>(null);
  const seq = useRef(0);

  const load = async (m: string, draft?: ObligationInputs) => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const r = draft ? await obligationsApi.preview(m, draft) : await obligationsApi.get(m);
      if (id !== seq.current) return;
      setData(r);
      setError(null);
      if (!draft) {
        setInputs(r.inputs ?? {});
        setVariableText(Object.fromEntries(Object.entries(r.inputs?.variable ?? {}).map(([k, v]) => [k, String(v.amount || '')])));
        setFeeText(Object.fromEntries((r.inputs?.fees ?? []).map((f, i) => [i, String(f.amount || '')])));
        setDirty(false);
      }
    } catch (e) {
      if (id === seq.current) setError(e);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  };

  useEffect(() => { void load(month); }, [month]);

  // Recalcula un momento después de que el usuario deja de escribir
  useEffect(() => {
    if (!dirty || !inputs) return;
    const t = setTimeout(() => void load(month, inputs), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs]);

  const edit = (fn: (i: ObligationInputs) => ObligationInputs) => {
    setInputs(i => fn(i ?? {}));
    setDirty(true);
  };
  const setMode = (mode: ObligationMode) => edit(i => ({ ...i, mode }));
  const setVariable = (id: number, text: string) => {
    setVariableText(v => ({ ...v, [id]: text }));
    edit(i => ({ ...i, variable: { ...(i.variable ?? {}), [id]: { ...(i.variable?.[id] ?? {}), amount: amountOf(text) } } }));
  };
  const fees = inputs?.fees ?? [];
  const setFee = (k: number, patch: Partial<{ name: string; kind: FeeKind; amount: number; note: string }>) =>
    edit(i => ({ ...i, fees: (i.fees ?? []).map((f, j) => (j === k ? { ...f, ...patch } : f)) }));
  const addFee = () => edit(i => ({ ...i, fees: [...(i.fees ?? []), { name: '', kind: 'domiciliado', amount: 0 }] }));
  const removeFee = (k: number) => {
    setFeeText(t => Object.fromEntries(Object.entries(t).filter(([j]) => Number(j) !== k).map(([j, v]) => [Number(j) > k ? Number(j) - 1 : j, v])));
    edit(i => ({ ...i, fees: (i.fees ?? []).filter((_, j) => j !== k) }));
  };

  const save = async () => {
    if (!inputs) return;
    setSaving(true);
    try {
      await obligationsApi.save(month, inputs);
      await load(month);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };
  const afterPayment = () => {
    void qc.invalidateQueries({ queryKey: ['fiscal'] });
    void qc.invalidateQueries({ queryKey: ['acc'] });
    void load(month, dirty && inputs ? inputs : undefined);
  };

  const d = data;
  const estimating = d?.mode === 'estimado';
  const tot = d?.employee_totals;
  const hacienda = (d?.payees ?? []).filter(p => p.payee === 'Hacienda').reduce((s, p) => s + (p.amount ?? 0), 0);
  const afp = (d?.payees ?? []).filter(p => p.key.startsWith('afp_')).reduce((s, p) => s + (p.amount ?? 0), 0);
  const isss = d?.payees.find(p => p.key === 'isss')?.amount ?? 0;
  // La retención calculada de un honorario manual vuelve en el mismo orden, sin las filas vacías
  const manualWithheld = (k: number) => {
    const visible = fees.slice(0, k + 1).filter(f => f.amount > 0).length;
    return (fees[k]?.amount ?? 0) > 0 ? d?.fees.manual[visible - 1]?.withheld ?? 0 : 0;
  };

  return (
    <div>
      <div className="toolbar">
        <Field label="Mes"><Input type="month" value={month} max={current} onChange={e => e.target.value && setMonth(e.target.value)} style={{ width: 170 }} /></Field>
        <div style={{ display: 'flex', gap: 4, alignSelf: 'flex-end' }} role="group" aria-label="Origen de los datos de empleados">
          {([['real', 'Planilla emitida'], ['estimado', 'Estimado']] as const).map(([m, label]) => (
            <Button key={m} size="sm" variant={d?.mode === m ? 'primary' : 'secondary'} onClick={() => setMode(m)}
              disabled={m === 'real' && !d?.emitted_payrolls} aria-pressed={d?.mode === m}
              title={m === 'real' && !d?.emitted_payrolls ? 'No hay planillas emitidas este mes' : undefined}>{label}</Button>
          ))}
        </div>
        {loading && <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>Calculando…</span>}
        <span style={{ flex: 1 }} />
        {d && (
          <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
            {dirty ? 'Cambios sin guardar' : d.saved ? `Guardado por ${d.saved_by ?? '—'} · ${d.saved_at ? new Date(d.saved_at).toLocaleString('es-SV') : ''}` : 'Sin estimación guardada'}
          </span>
        )}
        <Button variant="secondary" onClick={() => setPrinting(true)} disabled={!d || loading}>Imprimir flujo</Button>
        {manage && <Button onClick={save} disabled={saving || !dirty}>{saving ? 'Guardando…' : 'Guardar estimación'}</Button>}
      </div>

      <ErrorBanner error={error} />

      {!d || !tot ? <Loading /> : (
        <>
          <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginBottom: 'var(--s-5)' }}>
            <KpiCard size="md" tone="primary" label={`Total a pagar · ${monthName(d.period)}`} value={m$(d.total)} hint={`pendiente ${m$(d.total_pending)}`} />
            <KpiCard size="md" label="Hacienda (F-07 + F-14)" value={m$(hacienda)} hint={d.fiscal_configured ? 'IVA, anticipo y retenciones' : 'sin IVA: falta el punto de partida'} />
            <KpiCard size="md" label="ISSS" value={m$(isss)} hint={tot.insaforp ? 'incluye INSAFORP' : 'laboral + patronal'} />
            <KpiCard size="md" label="AFP" value={m$(afp)} hint="laboral + patronal" />
            <KpiCard size="md" label="Vence (aprox.)" value={dmy(d.due)} hint="10.º día hábil del mes siguiente" />
          </div>

          {/* Consolidación */}
          <div className="section-title" style={{ marginBottom: 4 }}>Consolidación de {monthName(d.period)}</div>
          <p className="muted" style={{ fontSize: 'var(--text-xs)', margin: '0 0 var(--s-3)' }}>
            {estimating ? 'Estimado con el salario de los empleados activos y lo que escribas abajo.' : `Con ${d.emitted_payrolls} planilla(s) emitida(s) del mes y las liquidaciones.`}
            {' '}Los pagos de Hacienda se registran también en «IVA y pago a cuenta»; los del ISSS y las AFP, aquí. Cada pago genera su partida contra el banco.
          </p>
          <div className="table-wrap"><div className="table-scroll">
            <table className="acc-table">
              <thead><tr><th>Pagar a</th><th>Concepto</th><th>Detalle</th><th className="num">Monto</th><th className="num">Pagado</th><th className="num">Pendiente</th><th>Vence</th><th /></tr></thead>
              <tbody>{d.payees.map(p => {
                const pending = p.amount == null ? null : Math.max(p.amount - (p.paid ?? 0), 0);
                const canPay = manage && pending != null && pending > 0.004 && (p.key === 'f07' || p.key === 'f14' || PAYEE_KEYS.includes(p.key as ObligationPayeeKey));
                return (
                  <tr key={p.key}>
                    <td><strong>{p.payee}</strong></td>
                    <td>{p.concept}</td>
                    <td className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                      {p.parts ? Object.entries(p.parts).filter(([, v]) => v).map(([k, v]) => `${PART_LABEL[k] ?? k} ${m$(v)}`).join(' · ') || '—' : p.detail}
                    </td>
                    <td className="num"><strong>{m$(p.amount)}</strong></td>
                    <td className="num">{p.paid ? m$(p.paid) : '—'}</td>
                    <td className="num">{pending == null ? '—' : pending > 0.004 ? <strong>{m$(pending)}</strong> : <Badge tone="success">Pagado</Badge>}</td>
                    <td className="code">{dmy(p.due)}</td>
                    <td style={{ textAlign: 'right' }}>{canPay && <Button size="sm" onClick={() => setPaying(p)}>Pagar</Button>}</td>
                  </tr>
                );
              })}
                <tr className="total"><td colSpan={3}>Total del mes</td><td className="num">{m$(d.total)}</td><td /><td className="num">{m$(d.total_pending)}</td><td colSpan={2} /></tr>
              </tbody>
            </table>
          </div></div>

          {d.payments.length > 0 && <>
            <div className="section-title" style={{ margin: 'var(--s-5) 0 var(--s-3)' }}>Pagos al ISSS y AFP del mes</div>
            <div className="table-wrap"><table className="acc-table">
              <thead><tr><th>Pagado a</th><th>Fecha</th><th>Referencia</th><th className="num">Monto</th><th>Estado</th><th /></tr></thead>
              <tbody>{d.payments.map(p => (
                <tr key={p.id} className={p.status === 'anulado' ? 'voided' : ''}>
                  <td>{PAYEE_NAME[p.payee_key]}</td><td className="code">{dmy(p.payment_date)}</td><td className="muted">{p.reference}</td>
                  <td className="num">{m$(p.amount)}</td>
                  <td>{p.status === 'anulado' ? <Badge>Anulado</Badge> : <Badge tone="success">Vigente</Badge>}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {p.entry_id && <Button size="sm" variant="secondary" onClick={() => setEntry(p.entry_id)}>Asiento</Button>}{' '}
                    {manage && p.status === 'vigente' && <Button size="sm" variant="danger" onClick={() => setVoiding(p.id)}>Anular</Button>}
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          </>}

          {/* Empleados */}
          <div className="section-title" style={{ margin: 'var(--s-6) 0 4px' }}>Empleados · renta fija y variable</div>
          <p className="muted" style={{ fontSize: 'var(--text-xs)', margin: '0 0 var(--s-3)' }}>
            ISSS {pct(d.settings.isss_employee_rate)} laboral + {pct(d.settings.isss_employer_rate)} patronal (tope {m$(d.settings.isss_cap)}) ·
            AFP {pct(d.settings.afp_employee_rate)} + {pct(d.settings.afp_employer_rate)}{d.settings.afp_cap ? ` (tope ${m$(d.settings.afp_cap)})` : ''}
            {d.settings.insaforp_applies ? ` · INSAFORP ${pct(d.settings.insaforp_rate)}` : ''} · renta con la tabla de retención de Planillas.
            {estimating && ' Escribe la renta variable del mes (horas extra, comisiones, bonos) de cada empleado.'}
          </p>
          {!d.can_see_employees ? (
            <div className="banner banner-info">{tot.count} empleado(s) · bruto {m$(tot.gross)} · renta retenida {m$(tot.isr)}. El detalle por empleado requiere permiso de Planillas.</div>
          ) : d.employees.length === 0 ? (
            <div className="banner banner-info">No hay empleados {estimating ? 'activos este mes' : 'en las planillas emitidas del mes'}. Se registran en Planillas → Empleados.</div>
          ) : (
            <div className="table-wrap"><div className="table-scroll">
              <table className="acc-table">
                <thead><tr><th>Empleado</th><th className="num">Salario fijo</th><th className="num">Variable</th><th className="num">Bruto</th>
                  <th className="num">ISSS lab.</th><th className="num">ISSS pat.</th><th className="num">AFP lab.</th><th className="num">AFP pat.</th><th className="num">Renta</th></tr></thead>
                <tbody>{d.employees.map(e => (
                  <tr key={e.employee_id}>
                    <td>{e.name}<div className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                      AFP {e.afp_name ? AFP_LABEL[e.afp_name] : 'sin asignar'} · salario {m$(e.monthly_salary)}{!estimating && e.source !== 'planilla' ? ` · ${e.source}` : ''}
                    </div></td>
                    <td className="num">{m$(e.fixed)}</td>
                    <td className="num">
                      {estimating
                        ? <Input inputMode="decimal" placeholder="0.00" aria-label={`Renta variable de ${e.name}`} style={{ width: 110, textAlign: 'right' }}
                            value={variableText[e.employee_id] ?? ''} onChange={ev => setVariable(e.employee_id, ev.target.value)} />
                        : m$(e.variable + e.aguinaldo)}
                    </td>
                    <td className="num"><strong>{m$(e.gross)}</strong></td>
                    <td className="num">{m$(e.isss_employee)}</td><td className="num">{m$(e.isss_employer)}</td>
                    <td className="num">{m$(e.afp_employee)}</td><td className="num">{m$(e.afp_employer)}</td>
                    <td className="num"><strong>{m$(e.isr)}</strong></td>
                  </tr>
                ))}
                  <tr className="total">
                    <td>{tot.count} empleado(s)</td><td className="num">{m$(tot.fixed)}</td><td className="num">{m$(tot.variable)}</td><td className="num">{m$(tot.gross)}</td>
                    <td className="num">{m$(tot.isss_employee)}</td><td className="num">{m$(tot.isss_employer)}</td>
                    <td className="num">{m$(tot.afp_employee)}</td><td className="num">{m$(tot.afp_employer)}</td><td className="num">{m$(tot.isr)}</td>
                  </tr>
                </tbody>
              </table>
            </div></div>
          )}

          {/* Honorarios */}
          <div className="section-title" style={{ margin: 'var(--s-6) 0 4px', display: 'flex', justifyContent: 'space-between' }}>
            <span>Honorarios y servicios · retención de renta</span><span>{m$(d.fees.withheld)}</span>
          </div>
          <p className="muted" style={{ fontSize: 'var(--text-xs)', margin: '0 0 var(--s-3)' }}>
            {pct(d.settings.fee_withholding_rate)} a personas naturales domiciliadas (Art. 156 LISR) y {pct(d.settings.fee_nonresident_rate)} a no domiciliadas (Art. 158).
            Las del libro de compras ya están registradas; agrega aquí las que todavía no tienen documento.
          </p>
          {d.fees.purchases.length > 0 && (
            <div className="table-wrap" style={{ marginBottom: 'var(--s-3)' }}><table className="acc-table">
              <tbody>{d.fees.purchases.map(f => (
                <tr key={f.id}>
                  <td className="code">{dmy(f.issue_date)}</td><td>{f.supplier}</td>
                  <td className="muted">Libro de compras{f.document_type ? ` · DTE ${f.document_type}` : ''}</td>
                  <td className="num">{m$(f.amount)}</td><td className="num"><strong>{m$(f.withheld)}</strong></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          <div style={{ display: 'grid', gap: 8 }}>
            {fees.map((f, k) => (
              <div key={k} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <Input placeholder="Nombre (ej. contador, diseñador)" value={f.name} onChange={e => setFee(k, { name: e.target.value })} aria-label="Nombre" style={{ flex: 1, minWidth: 200 }} />
                <Select value={f.kind} onChange={e => setFee(k, { kind: e.target.value as FeeKind })} aria-label="Tipo" style={{ width: 220 }}>
                  <option value="domiciliado">Domiciliado ({pct(d.settings.fee_withholding_rate)})</option>
                  <option value="no_domiciliado">No domiciliado ({pct(d.settings.fee_nonresident_rate)})</option>
                </Select>
                <Input inputMode="decimal" placeholder="Monto" aria-label="Monto" style={{ width: 130, textAlign: 'right' }}
                  value={feeText[k] ?? ''} onChange={e => { const v = e.target.value; setFeeText(t => ({ ...t, [k]: v })); setFee(k, { amount: amountOf(v) }); }} />
                <span className="num" style={{ width: 110, textAlign: 'right', fontWeight: 600 }}>{m$(manualWithheld(k))}</span>
                <Button size="sm" variant="danger" onClick={() => removeFee(k)} aria-label="Quitar">Quitar</Button>
              </div>
            ))}
            <div><Button size="sm" variant="secondary" onClick={addFee}>+ Honorario estimado</Button></div>
          </div>

          <p className="muted" style={{ fontSize: 'var(--text-xs)', marginTop: 'var(--s-5)' }}>
            Estimación de apoyo: las tasas y la tabla de renta vienen de Planillas → Configuración. El vencimiento no descuenta asuetos.
            {!manage && ' Puedes probar cifras, pero guardar la estimación y registrar pagos requiere permiso de gestión fiscal.'}
          </p>

          {printing && <PrintObligationsModal data={d} unsaved={dirty} onClose={() => setPrinting(false)} />}
          {paying && <PayObligationModal data={d} payee={paying} onClose={() => setPaying(null)} onPaid={afterPayment} />}
        </>
      )}
      {voiding !== null && <VoidObligationPayment id={voiding} onClose={() => setVoiding(null)} onDone={afterPayment} />}
      {entry !== null && <EntryModal id={entry} onClose={() => setEntry(null)} />}
    </div>
  );
}

/** Pago de una obligación: Hacienda va a fiscal_payments (F-07 / F-14); ISSS y AFP a obligation_payments. */
function PayObligationModal({ data, payee: p, onClose, onPaid }: { data: EmployerObligations; payee: ObligationPayee; onClose: () => void; onPaid: () => void }) {
  const funds = useQuery({ queryKey: ['acc', 'funds'], queryFn: subApi.fundAccounts });
  const pending = Math.max((p.amount ?? 0) - (p.paid ?? 0), 0);
  const hacienda = p.key === 'f07' || p.key === 'f14';
  // Parte de retenciones del formulario (F-07: retenciones de IVA hechas; F-14: renta de empleados y honorarios)
  const wh0 = p.key === 'f07' ? num(p.parts?.ret_iva) : p.key === 'f14' ? num(p.parts?.isr_employees) + num(p.parts?.isr_fees) : 0;
  const whPending = Math.min(wh0, pending);
  const [main, setMain] = useState(String(Math.round((pending - whPending) * 100) / 100));
  const [wh, setWh] = useState(String(Math.round(whPending * 100) / 100));
  const [amount, setAmount] = useState(String(Math.round(pending * 100) / 100));
  const [date, setDate] = useState(todayIso());
  const [fund, setFund] = useState<number | null>(null);
  const [ref, setRef] = useState('');
  useEffect(() => { if (!fund && funds.data?.length) setFund(funds.data[0]!.id); }, [funds.data, fund]);
  const total = hacienda ? num(main) + num(wh) : num(amount);
  const run = useMutation({
    mutationFn: () => hacienda
      ? fiscalApi.pay({ form: p.key === 'f07' ? 'F07' : 'F14', period: data.period, payment_date: date, main: num(main), withholdings: num(wh), fund_account_id: fund!, reference: ref || null })
      : obligationsApi.pay({ payee_key: p.key as ObligationPayeeKey, period: data.period, payment_date: date, amount: num(amount), fund_account_id: fund!, reference: ref || null }),
    onSuccess: () => { onPaid(); onClose(); },
  });
  return (
    <Modal title={`Pago ${p.payee} · ${p.concept} — ${monthName(data.period)}`} onClose={onClose}
      onSave={() => run.mutate()} saveDisabled={!fund || run.isPending || total <= 0} saveLabel={`Registrar ${m$(total)}`}>
      <ErrorBanner error={run.error} />
      {p.key === 'f07' && <div className="banner banner-info">Liquida el IVA del mes en «IVA y pago a cuenta» antes de pagar, para que «IVA por pagar» tenga su saldo.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {hacienda ? <>
          <Field label={p.key === 'f07' ? 'IVA del mes' : 'Pago a cuenta (anticipo)'}><Input inputMode="decimal" value={main} onChange={e => setMain(e.target.value)} /></Field>
          <Field label={p.key === 'f07' ? 'Retenciones de IVA hechas' : 'Renta retenida (empleados y honorarios)'}><Input inputMode="decimal" value={wh} onChange={e => setWh(e.target.value)} /></Field>
        </> : <Field label="Monto pagado (laboral + patronal)"><Input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /></Field>}
        <Field label="Fecha de pago"><Input type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
        <Field label="Pagado desde">
          <Select value={fund ?? ''} onChange={e => setFund(Number(e.target.value))}>
            {(funds.data ?? []).map(f => <option key={f.id} value={f.id}>{f.code} {f.name}</option>)}
          </Select>
        </Field>
      </div>
      <Field label={hacienda ? 'N.º de mandamiento / referencia' : 'NPE / referencia de la planilla'}><Input value={ref} onChange={e => setRef(e.target.value)} /></Field>
    </Modal>
  );
}

function VoidObligationPayment({ id, onClose, onDone }: { id: number; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const run = useMutation({ mutationFn: () => obligationsApi.voidPayment(id, reason), onSuccess: () => { onDone(); onClose(); } });
  return (
    <Modal title="Anular pago" onClose={onClose} onSave={() => run.mutate()} saveDisabled={reason.trim().length < 3 || run.isPending} saveLabel="Anular">
      <ErrorBanner error={run.error} />
      <Field label="Motivo"><Input value={reason} onChange={e => setReason(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}
