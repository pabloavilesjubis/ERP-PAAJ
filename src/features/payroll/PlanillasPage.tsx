import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Badge } from '@/components/ui/Badge';
import { RouteTabs } from '@/components/ui/Tabs';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner, Loading } from '@/components/ui/Feedback';
import { usePermissions } from '@/auth/usePermissions';
import { useBranding } from '@/branding/BrandingProvider';
import { useAccounts } from '@/features/accounting/hooks';
import { AccountSelect } from '@/features/accounting/components/AccountSelect';
import { EntryModal } from '@/features/accounting/components/EntryModals';
import { subApi } from '@/features/accounting/api';
import { downloadText } from '@/features/accounting/catalogCsv';
import { monthRange, todayIso } from '@/features/accounting/dates';
import { dmy, entryNo, money, num } from '@/features/accounting/format';
import { KIND_LABEL, payrollApi, type Employee, type EmployeeInput, type PayrollLine, type PayrollSettings, type TerminationCalc, type TerminationInput } from './api';
import { payslipsPdf, terminationPdf } from './pdf';

export type PayrollTab = 'empleados' | 'planillas' | 'liquidaciones' | 'reportes' | 'configuracion';

const STATUS_TONE = { borrador: 'warning', emitida: 'success', anulada: 'neutral' } as const;

/** Planillas: empleados, planillas con prestaciones de ley, boletas, liquidaciones y reportes. */
export function PlanillasPage({ tab }: { tab: PayrollTab }) {
  const { id } = useParams();
  return (
    <div>
      <SectionHeader title="Planillas" description="Cálculo de ley de El Salvador: ISSS, AFP, renta, horas extra, vacaciones, aguinaldo y liquidaciones." />
      <RouteTabs tabs={[
        { to: '/planillas/empleados', label: 'Empleados' },
        { to: '/planillas/planillas', label: 'Planillas' },
        { to: '/planillas/liquidaciones', label: 'Despido / renuncia' },
        { to: '/planillas/reportes', label: 'Reportes' },
        { to: '/planillas/configuracion', label: 'Configuración' },
      ]} />
      {tab === 'empleados' && <Empleados />}
      {tab === 'planillas' && (id ? <PayrollDetail id={Number(id)} /> : <Planillas />)}
      {tab === 'liquidaciones' && <Liquidaciones />}
      {tab === 'reportes' && <Reportes />}
      {tab === 'configuracion' && <Configuracion />}
    </div>
  );
}

function useCompany() {
  const b = useBranding();
  return { name: b.productName };
}

// ── Empleados ────────────────────────────────────────────────────────────────
function Empleados() {
  const { can } = usePermissions();
  const [status, setStatus] = useState('activo');
  const [editing, setEditing] = useState<Employee | 'new' | null>(null);
  const q = useQuery({ queryKey: ['payroll', 'employees', status], queryFn: () => payrollApi.employees(status || undefined) });
  const items = q.data ?? [];
  return (
    <>
      <div className="toolbar">
        <Select value={status} onChange={e => setStatus(e.target.value)} style={{ width: 180 }}>
          <option value="activo">Activos</option><option value="retirado">Retirados</option><option value="">Todos</option>
        </Select>
        {can('payroll:manage') && <Button onClick={() => setEditing('new')}>+ Empleado</Button>}
        <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>
          {items.length} empleado(s) · planilla mensual {money(items.filter(e => e.status === 'activo').reduce((s, e) => s + num(e.monthly_salary), 0))}
        </span>
      </div>
      <ErrorBanner error={q.error} />
      {q.isLoading ? <Loading /> : !items.length ? <EmptyState title="Sin empleados" description="Agrega a los empleados con su salario, fecha de ingreso y centro de costo." /> : (
        <div className="table-wrap"><div className="table-scroll">
          <table className="acc-table">
            <thead><tr><th>Empleado</th><th>DUI</th><th>Cargo</th><th>Centro de costo</th><th>Ingreso</th><th>Pago</th><th className="num">Salario</th><th>Estado</th><th /></tr></thead>
            <tbody>{items.map(e => (
              <tr key={e.id} className={e.status === 'retirado' ? 'muted' : ''}>
                <td>{e.full_name}</td><td className="code">{e.dui}</td><td>{e.position}</td><td>{e.cost_center_name}</td>
                <td className="code">{dmy(e.hire_date)}</td><td>{e.pay_frequency}</td><td className="num">{money(e.monthly_salary)}</td>
                <td>{e.status === 'activo' ? <Badge tone="success">Activo</Badge> : <Badge>Retirado {dmy(e.termination_date)}</Badge>}</td>
                <td style={{ textAlign: 'right' }}>{can('payroll:manage') && <Button size="sm" variant="secondary" onClick={() => setEditing(e)}>Editar</Button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div></div>
      )}
      {editing && <EmployeeModal employee={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function EmployeeModal({ employee, onClose }: { employee: Employee | null; onClose: () => void }) {
  const qc = useQueryClient();
  const ccs = useQuery({ queryKey: ['payroll', 'cc'], queryFn: payrollApi.costCenters });
  const [f, setF] = useState<EmployeeInput>(() => ({
    employee_code: employee?.employee_code ?? null, first_name: employee?.first_name ?? '', last_name: employee?.last_name ?? '',
    dui: employee?.dui ?? null, nit: employee?.nit ?? null, isss_number: employee?.isss_number ?? null, nup: employee?.nup ?? null,
    afp_name: employee?.afp_name ?? null, birth_date: employee?.birth_date ?? null, phone: employee?.phone ?? null, email: employee?.email ?? null,
    address: employee?.address ?? null, position: employee?.position ?? '', cost_center_id: employee?.cost_center_id ?? 0,
    hire_date: employee?.hire_date ?? todayIso(), monthly_salary: employee ? num(employee.monthly_salary) : 0,
    pay_frequency: employee?.pay_frequency ?? 'mensual', payment_method: employee?.payment_method ?? 'transferencia',
    bank_name: employee?.bank_name ?? null, bank_account: employee?.bank_account ?? null,
    applies_isss: employee?.applies_isss ?? true, applies_afp: employee?.applies_afp ?? true, applies_isr: employee?.applies_isr ?? true,
    notes: employee?.notes ?? null,
  }));
  useEffect(() => { if (!f.cost_center_id && ccs.data?.length) setF(x => ({ ...x, cost_center_id: ccs.data![0]!.id })); }, [ccs.data, f.cost_center_id]);
  const save = useMutation({
    mutationFn: () => payrollApi.saveEmployee(employee?.id ?? null, f),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['payroll'] }); onClose(); },
  });
  const t = (k: keyof EmployeeInput) => ({ value: (f[k] as string | null) ?? '', onChange: (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value || null })) });
  return (
    <Modal title={employee ? `Editar ${employee.full_name}` : 'Nuevo empleado'} onClose={onClose} onSave={() => save.mutate()} saveDisabled={save.isPending} size="wide">
      <ErrorBanner error={save.error} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <Field label="Nombres"><Input {...t('first_name')} /></Field>
        <Field label="Apellidos"><Input {...t('last_name')} /></Field>
        <Field label="Código"><Input {...t('employee_code')} /></Field>
        <Field label="DUI (00000000-0)"><Input {...t('dui')} /></Field>
        <Field label="NIT"><Input {...t('nit')} /></Field>
        <Field label="Fecha de nacimiento"><Input type="date" {...t('birth_date')} /></Field>
        <Field label="N.º afiliación ISSS"><Input {...t('isss_number')} /></Field>
        <Field label="NUP (AFP)"><Input {...t('nup')} /></Field>
        <Field label="AFP">
          <Select value={f.afp_name ?? ''} onChange={e => setF(x => ({ ...x, afp_name: (e.target.value || null) as EmployeeInput['afp_name'] }))}>
            <option value="">—</option><option value="confia">Confía</option><option value="crecer">Crecer</option>
          </Select>
        </Field>
        <Field label="Cargo"><Input {...t('position')} /></Field>
        <Field label="Centro de costo">
          <Select value={f.cost_center_id} onChange={e => setF(x => ({ ...x, cost_center_id: Number(e.target.value) }))}>
            {(ccs.data ?? []).filter(c => c.is_active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Fecha de ingreso"><Input type="date" value={f.hire_date} onChange={e => setF(x => ({ ...x, hire_date: e.target.value }))} /></Field>
        <Field label="Salario mensual"><Input inputMode="decimal" value={f.monthly_salary || ''} onChange={e => setF(x => ({ ...x, monthly_salary: num(e.target.value) }))} /></Field>
        <Field label="Frecuencia de pago">
          <Select value={f.pay_frequency} onChange={e => setF(x => ({ ...x, pay_frequency: e.target.value as EmployeeInput['pay_frequency'] }))}>
            <option value="mensual">Mensual</option><option value="quincenal">Quincenal</option>
          </Select>
        </Field>
        <Field label="Forma de pago">
          <Select value={f.payment_method} onChange={e => setF(x => ({ ...x, payment_method: e.target.value as EmployeeInput['payment_method'] }))}>
            <option value="transferencia">Transferencia</option><option value="efectivo">Efectivo</option><option value="cheque">Cheque</option>
          </Select>
        </Field>
        <Field label="Banco"><Input {...t('bank_name')} /></Field>
        <Field label="Cuenta bancaria"><Input {...t('bank_account')} /></Field>
        <Field label="Teléfono"><Input {...t('phone')} /></Field>
      </div>
      <div style={{ display: 'flex', gap: 18, fontSize: 'var(--text-sm)' }}>
        {(['applies_isss', 'applies_afp', 'applies_isr'] as const).map(k => (
          <label key={k} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={f[k]} onChange={e => setF(x => ({ ...x, [k]: e.target.checked }))} />
            {k === 'applies_isss' ? 'Cotiza ISSS' : k === 'applies_afp' ? 'Cotiza AFP (no pensionado)' : 'Retención de renta'}
          </label>
        ))}
      </div>
    </Modal>
  );
}

// ── Planillas ────────────────────────────────────────────────────────────────
function Planillas() {
  const { can } = usePermissions();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['payroll', 'payrolls'], queryFn: payrollApi.payrolls });
  const [creating, setCreating] = useState(false);
  return (
    <>
      {can('payroll:manage') && <div className="toolbar"><Button onClick={() => setCreating(true)}>+ Nueva planilla</Button></div>}
      <ErrorBanner error={q.error} />
      {q.isLoading ? <Loading /> : !(q.data ?? []).length ? <EmptyState title="Sin planillas" /> : (
        <div className="table-wrap"><div className="table-scroll">
          <table className="acc-table">
            <thead><tr><th>N.º</th><th>Tipo</th><th>Período</th><th>Pago</th><th className="num">Empleados</th><th className="num">Devengado</th><th className="num">Líquido</th><th>Estado</th></tr></thead>
            <tbody>{q.data!.map(p => (
              <tr key={p.id} className="clickable" onClick={() => navigate(`/planillas/planillas/${p.id}`)}>
                <td className="code">{p.payroll_number ? `PL-${String(p.payroll_number).padStart(5, '0')}` : '—'}</td>
                <td>{p.kind === 'aguinaldo' ? 'Aguinaldo' : `Ordinaria ${p.frequency}`}</td>
                <td className="code">{dmy(p.period_start)} – {dmy(p.period_end)}</td>
                <td className="code">{dmy(p.payment_date)}</td>
                <td className="num">{p.employees}</td><td className="num">{money(p.gross)}</td><td className="num">{money(p.net)}</td>
                <td><Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>{p.paid_entry_id ? <> <Badge tone="info">Pagada</Badge></> : null}</td>
              </tr>
            ))}</tbody>
          </table>
        </div></div>
      )}
      {creating && <CreatePayrollModal onClose={() => setCreating(false)} onCreated={id => navigate(`/planillas/planillas/${id}`)} />}
    </>
  );
}

function CreatePayrollModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const qc = useQueryClient();
  const now = new Date();
  const m = monthRange(now.getFullYear(), now.getMonth() + 1);
  const [f, setF] = useState({ kind: 'ordinaria', frequency: 'mensual', period_start: m.from, period_end: m.to, payment_date: m.to, notes: '' });
  const save = useMutation({
    mutationFn: () => payrollApi.createPayroll(f),
    onSuccess: r => { void qc.invalidateQueries({ queryKey: ['payroll'] }); onCreated(r.id); },
  });
  const set = (k: keyof typeof f, v: string) => setF(x => ({ ...x, [k]: v }));
  return (
    <Modal title="Nueva planilla" onClose={onClose} onSave={() => save.mutate()} saveDisabled={save.isPending} saveLabel="Crear borrador">
      <ErrorBanner error={save.error} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Tipo">
          <Select value={f.kind} onChange={e => { const k = e.target.value; setF(x => ({ ...x, kind: k, ...(k === 'aguinaldo' ? { period_start: `${now.getFullYear()}-12-01`, period_end: `${now.getFullYear()}-12-12`, payment_date: `${now.getFullYear()}-12-12`, frequency: 'mensual' } : {}) })); }}>
            <option value="ordinaria">Ordinaria</option><option value="aguinaldo">Aguinaldo</option>
          </Select>
        </Field>
        <Field label="Frecuencia">
          <Select value={f.frequency} disabled={f.kind === 'aguinaldo'} onChange={e => set('frequency', e.target.value)}>
            <option value="mensual">Mensual</option><option value="quincenal">Quincenal</option>
          </Select>
        </Field>
        <Field label="Desde"><Input type="date" value={f.period_start} onChange={e => set('period_start', e.target.value)} /></Field>
        <Field label={f.kind === 'aguinaldo' ? 'Hasta (fecha de cálculo, 12 de diciembre)' : 'Hasta'}><Input type="date" value={f.period_end} onChange={e => set('period_end', e.target.value)} /></Field>
        <Field label="Fecha de pago"><Input type="date" value={f.payment_date} onChange={e => set('payment_date', e.target.value)} /></Field>
      </div>
      <Field label="Notas"><Input value={f.notes} onChange={e => set('notes', e.target.value)} /></Field>
    </Modal>
  );
}

function PayrollDetail({ id }: { id: number }) {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const company = useCompany();
  const q = useQuery({ queryKey: ['payroll', 'payroll', id], queryFn: () => payrollApi.payroll(id) });
  const [entry, setEntry] = useState<number | null>(null);
  const [paying, setPaying] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['payroll'] });
  const sync = useMutation({ mutationFn: () => payrollApi.refresh(id), onSuccess: refresh });
  const emit = useMutation({ mutationFn: () => payrollApi.emit(id), onSuccess: () => { refresh(); void qc.invalidateQueries({ queryKey: ['acc'] }); } });
  const del = useMutation({ mutationFn: () => payrollApi.deletePayroll(id), onSuccess: () => { refresh(); navigate('/planillas/planillas'); } });
  const updLine = useMutation({ mutationFn: (a: { id: number; patch: Parameters<typeof payrollApi.updateLine>[1] }) => payrollApi.updateLine(a.id, a.patch), onSuccess: refresh });
  const rmLine = useMutation({ mutationFn: (lineId: number) => payrollApi.removeLine(lineId), onSuccess: refresh });

  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorBanner error={q.error} />;
  const { payroll: p, lines } = q.data;
  const draft = p.status === 'borrador' && can('payroll:manage');
  const ord = p.kind === 'ordinaria';

  const isssAfpCsv = () => {
    const cell = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const out = ['dui,nombre,numero_isss,nup,afp,dias,base_isss,isss_laboral,isss_patronal,base_afp,afp_laboral,afp_patronal,insaforp'];
    for (const l of lines) out.push([l.dui, l.employee_name, l.isss_number, l.nup, l.afp_name, l.days_paid, l.isss_base, l.isss_employee, l.isss_employer, l.afp_base, l.afp_employee, l.afp_employer, l.insaforp].map(cell).join(','));
    downloadText(`isss-afp-${p.period_start}-${p.period_end}.csv`, out.join('\r\n'));
  };

  return (
    <>
      <div className="toolbar">
        <Button variant="secondary" onClick={() => navigate('/planillas/planillas')}>‹ Planillas</Button>
        <strong>{p.kind === 'aguinaldo' ? `Aguinaldo ${p.period_end.slice(0, 4)}` : `Planilla ${p.frequency} ${dmy(p.period_start)} – ${dmy(p.period_end)}`}</strong>
        <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>
        {p.payroll_number && <span className="muted">PL-{String(p.payroll_number).padStart(5, '0')}</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {draft && <Button variant="secondary" onClick={() => sync.mutate()} disabled={sync.isPending}>Actualizar empleados</Button>}
          {draft && <Button variant="danger" onClick={() => del.mutate()}>Eliminar borrador</Button>}
          {draft && <Button onClick={() => emit.mutate()} disabled={emit.isPending}>Emitir y contabilizar</Button>}
          {p.status === 'emitida' && <Button variant="secondary" onClick={() => payslipsPdf(company, p, lines).save(`boletas-PL-${p.payroll_number}.pdf`)}>Boletas PDF</Button>}
          <Button variant="secondary" onClick={isssAfpCsv}>Resumen ISSS/AFP</Button>
          {p.status === 'emitida' && !p.paid_entry_id && can('payroll:manage') && <Button onClick={() => setPaying(true)}>Registrar pago</Button>}
          {p.status === 'emitida' && can('payroll:manage') && <Button variant="danger" onClick={() => setVoiding(true)}>Anular</Button>}
        </span>
      </div>
      <ErrorBanner error={sync.error ?? emit.error ?? del.error ?? updLine.error ?? rmLine.error} />
      <div className="stat-row" style={{ marginBottom: 12 }}>
        <span>Devengado <strong>{money(p.gross)}</strong></span><span>ISSS <strong>{money(p.isss_employee)}</strong></span>
        <span>AFP <strong>{money(p.afp_employee)}</strong></span><span>Renta <strong>{money(p.isr)}</strong></span>
        <span>Otros <strong>{money(p.other_deductions)}</strong></span><span>Líquido <strong>{money(p.net)}</strong></span>
        <span>Aportes patronales <strong>{money(p.isss_employer + p.afp_employer + p.insaforp)}</strong></span>
        {p.journal_entry_id && <a href="#" onClick={e => { e.preventDefault(); setEntry(p.journal_entry_id!); }}>Asiento #{entryNo(p.entry_number)}</a>}
        {p.paid_entry_id && <a href="#" onClick={e => { e.preventDefault(); setEntry(p.paid_entry_id!); }}>Pago #{entryNo(p.paid_entry_number)}</a>}
      </div>
      {p.status === 'anulada' && <div className="banner banner-warning">Anulada: {p.void_reason}</div>}
      <div className="table-wrap"><div className="table-scroll">
        <table className="acc-table lines-editor">
          <thead><tr>
            <th>Empleado</th>{ord && <><th className="num">Días</th><th className="num">Faltas</th><th className="num">HE día</th><th className="num">HE noche</th><th className="num">Asuetos</th><th>Vac.</th></>}
            <th className="num">Bonos</th><th className="num">Devengado</th><th className="num">ISSS</th><th className="num">AFP</th><th className="num">Renta</th><th className="num">Otros desc.</th><th className="num">Líquido</th>{draft && <th />}
          </tr></thead>
          <tbody>{lines.map(l => <LineRow key={l.id} line={l} ord={ord} draft={draft}
            onChange={patch => updLine.mutate({ id: l.id, patch })} onRemove={() => rmLine.mutate(l.id)} />)}</tbody>
        </table>
      </div></div>
      {entry !== null && <EntryModal id={entry} onClose={() => setEntry(null)} />}
      {paying && <PayModal title="Pago de planilla" amount={p.net} onClose={() => setPaying(false)} onPay={(d, f) => payrollApi.pay(id, d, f)} />}
      {voiding && <VoidModal title="Anular planilla" onClose={() => setVoiding(false)} onVoid={r => payrollApi.voidPayroll(id, r)} />}
    </>
  );
}

function NumCell({ value, onCommit, disabled }: { value: number; onCommit: (v: number) => void; disabled: boolean }) {
  const [v, setV] = useState(String(value || ''));
  useEffect(() => setV(String(value || '')), [value]);
  if (disabled) return <td className="num">{value || ''}</td>;
  return <td style={{ width: 70 }}><Input inputMode="decimal" style={{ textAlign: 'right', padding: '4px 6px' }} value={v}
    onChange={e => setV(e.target.value)} onBlur={() => { if (num(v) !== num(value)) onCommit(num(v)); }} /></td>;
}

function LineRow({ line: l, ord, draft, onChange, onRemove }: { line: PayrollLine; ord: boolean; draft: boolean; onChange: (p: Parameters<typeof payrollApi.updateLine>[1]) => void; onRemove: () => void }) {
  return (
    <tr>
      <td><div>{l.employee_name}</div><div className="muted" style={{ fontSize: 'var(--text-xs)' }}>{l.position} · {l.cost_center_name} · {money(l.monthly_salary)}</div></td>
      {ord && <>
        <td className="num">{l.period_days}</td>
        <NumCell value={l.absence_days} disabled={!draft} onCommit={v => onChange({ absence_days: v })} />
        <NumCell value={l.overtime_day_hours} disabled={!draft} onCommit={v => onChange({ overtime_day_hours: v })} />
        <NumCell value={l.overtime_night_hours} disabled={!draft} onCommit={v => onChange({ overtime_night_hours: v })} />
        <NumCell value={l.holiday_days} disabled={!draft} onCommit={v => onChange({ holiday_days: v })} />
        <td><input type="checkbox" checked={l.vacation} disabled={!draft} onChange={e => onChange({ vacation: e.target.checked })} title="Prima de vacaciones (30% de 15 días)" /></td>
      </>}
      <NumCell value={l.bonuses} disabled={!draft} onCommit={v => onChange({ bonuses: v })} />
      <td className="num">{money(l.gross)}</td>
      <td className="num">{money(l.isss_employee)}</td>
      <td className="num">{money(l.afp_employee)}</td>
      <td className="num">{money(l.isr)}</td>
      <NumCell value={l.other_deductions} disabled={!draft} onCommit={v => onChange({ other_deductions: v })} />
      <td className="num"><strong>{money(l.net)}</strong></td>
      {draft && <td><button type="button" className="btn-icon" title="Quitar de esta planilla" onClick={onRemove}>×</button></td>}
    </tr>
  );
}

function PayModal({ title, amount, onClose, onPay }: { title: string; amount: number; onClose: () => void; onPay: (date: string, fund: number) => Promise<unknown> }) {
  const qc = useQueryClient();
  const funds = useQuery({ queryKey: ['acc', 'funds'], queryFn: subApi.fundAccounts });
  const [date, setDate] = useState(todayIso());
  const [fund, setFund] = useState<number | null>(null);
  useEffect(() => { if (!fund && funds.data?.length) setFund(funds.data[0]!.id); }, [funds.data, fund]);
  const run = useMutation({ mutationFn: () => onPay(date, fund!), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['payroll'] }); void qc.invalidateQueries({ queryKey: ['acc'] }); onClose(); } });
  return (
    <Modal title={title} onClose={onClose} onSave={() => run.mutate()} saveDisabled={!fund || run.isPending} saveLabel={`Registrar pago de ${money(amount)}`}>
      <ErrorBanner error={run.error} />
      <Field label="Fecha"><Input type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
      <Field label="Sale de (caja / banco)">
        <Select value={fund ?? ''} onChange={e => setFund(Number(e.target.value))}>
          {(funds.data ?? []).map(f => <option key={f.id} value={f.id}>{f.code} {f.name}</option>)}
        </Select>
      </Field>
      <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>Debe sueldos por pagar / Haber banco. Luego concílialo con el estado de cuenta en Bancos.</div>
    </Modal>
  );
}

function VoidModal({ title, onClose, onVoid }: { title: string; onClose: () => void; onVoid: (reason: string) => Promise<unknown> }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const run = useMutation({ mutationFn: () => onVoid(reason), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['payroll'] }); void qc.invalidateQueries({ queryKey: ['acc'] }); onClose(); } });
  return (
    <Modal title={title} onClose={onClose} onSave={() => run.mutate()} saveDisabled={reason.trim().length < 3 || run.isPending} saveLabel="Anular">
      <ErrorBanner error={run.error} />
      <div className="banner banner-warning">Se revierten el asiento y, si existe, el pago.</div>
      <Field label="Motivo"><Input value={reason} onChange={e => setReason(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}

// ── Liquidaciones ────────────────────────────────────────────────────────────
function Liquidaciones() {
  const { can } = usePermissions();
  const company = useCompany();
  const list = useQuery({ queryKey: ['payroll', 'terminations'], queryFn: payrollApi.terminations });
  const [calc, setCalc] = useState(false);
  const [paying, setPaying] = useState<number | null>(null);
  const [voiding, setVoiding] = useState<number | null>(null);
  const [entry, setEntry] = useState<number | null>(null);
  return (
    <>
      {can('payroll:terminate') && <div className="toolbar"><Button onClick={() => setCalc(true)}>Calcular liquidación</Button></div>}
      <ErrorBanner error={list.error} />
      {list.isLoading ? <Loading /> : !(list.data ?? []).length ? <EmptyState title="Sin liquidaciones registradas" /> : (
        <div className="table-wrap"><table className="acc-table">
          <thead><tr><th>N.º</th><th>Empleado</th><th>Tipo</th><th>Retiro</th><th className="num">Prestaciones</th><th className="num">Líquido</th><th>Estado</th><th /></tr></thead>
          <tbody>{list.data!.map(t => (
            <tr key={t.id} className={t.status === 'anulada' ? 'voided' : ''}>
              <td className="code">LQ-{String(t.termination_number).padStart(5, '0')}</td><td>{t.employee_name}</td><td>{KIND_LABEL[t.kind]}</td>
              <td className="code">{dmy(t.termination_date)}</td><td className="num">{money(t.gross)}</td><td className="num">{money(t.net)}</td>
              <td>{t.status === 'anulada' ? <Badge>Anulada</Badge> : t.paid_entry_id ? <Badge tone="info">Pagada</Badge> : <Badge tone="success">Registrada</Badge>}</td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <Button size="sm" variant="secondary" onClick={() => terminationPdf(company, t.detail, t.termination_number).save(`liquidacion-LQ-${t.termination_number}.pdf`)}>Finiquito</Button>{' '}
                {t.journal_entry_id && <><Button size="sm" variant="secondary" onClick={() => setEntry(t.journal_entry_id!)}>Asiento</Button>{' '}</>}
                {t.status === 'registrada' && !t.paid_entry_id && can('payroll:terminate') && <><Button size="sm" onClick={() => setPaying(t.id)}>Pagar</Button>{' '}</>}
                {t.status === 'registrada' && can('payroll:terminate') && <Button size="sm" variant="danger" onClick={() => setVoiding(t.id)}>Anular</Button>}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {calc && <TerminationModal onClose={() => setCalc(false)} />}
      {paying !== null && <PayModal title="Pago de liquidación" amount={list.data!.find(t => t.id === paying)!.net} onClose={() => setPaying(null)} onPay={(d, f) => payrollApi.payTermination(paying, d, f)} />}
      {voiding !== null && <VoidModal title="Anular liquidación" onClose={() => setVoiding(null)} onVoid={r => payrollApi.voidTermination(voiding, r)} />}
      {entry !== null && <EntryModal id={entry} onClose={() => setEntry(null)} />}
    </>
  );
}

function TerminationModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const company = useCompany();
  const employees = useQuery({ queryKey: ['payroll', 'employees', 'activo'], queryFn: () => payrollApi.employees('activo') });
  const [input, setInput] = useState<TerminationInput>({ employee_id: 0, kind: 'despido_injustificado', termination_date: todayIso(), reason: '', options: { include_vacation: true, include_aguinaldo: true } });
  const [calc, setCalc] = useState<TerminationCalc | null>(null);
  const preview = useMutation({ mutationFn: () => payrollApi.previewTermination(input), onSuccess: setCalc });
  const register = useMutation({ mutationFn: () => payrollApi.registerTermination(input), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['payroll'] }); void qc.invalidateQueries({ queryKey: ['acc'] }); onClose(); } });
  const opt = (k: keyof TerminationInput['options'], v: unknown) => { setCalc(null); setInput(x => ({ ...x, options: { ...x.options, [k]: v } })); };
  const set = (patch: Partial<TerminationInput>) => { setCalc(null); setInput(x => ({ ...x, ...patch })); };
  return (
    <Modal title="Liquidación por despido o renuncia" onClose={onClose} size="wide" footer={<>
      <Button variant="secondary" onClick={onClose}>Cancelar</Button>
      <Button variant="secondary" onClick={() => preview.mutate()} disabled={!input.employee_id || preview.isPending}>Calcular</Button>
      {calc && <Button variant="secondary" onClick={() => terminationPdf(company, calc).save('liquidacion-borrador.pdf')}>Vista previa PDF</Button>}
      <Button onClick={() => register.mutate()} disabled={!calc || register.isPending}>Registrar y contabilizar</Button>
    </>}>
      <ErrorBanner error={preview.error ?? register.error} />
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.5fr 1fr', gap: 12 }}>
        <Field label="Empleado">
          <Select value={input.employee_id || ''} onChange={e => set({ employee_id: Number(e.target.value) })}>
            <option value="">— Elegir —</option>
            {(employees.data ?? []).map(e => <option key={e.id} value={e.id}>{e.full_name} · {money(e.monthly_salary)}</option>)}
          </Select>
        </Field>
        <Field label="Tipo de retiro">
          <Select value={input.kind} onChange={e => set({ kind: e.target.value })}>
            {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Fecha de retiro"><Input type="date" value={input.termination_date} onChange={e => set({ termination_date: e.target.value })} /></Field>
        <Field label="Vacaciones no gozadas (períodos completos)"><Input type="number" min={0} value={input.options.pending_vacation_periods ?? 0} onChange={e => opt('pending_vacation_periods', Number(e.target.value))} /></Field>
        <Field label="Otros ingresos"><Input inputMode="decimal" value={input.options.other_income ?? ''} onChange={e => opt('other_income', num(e.target.value))} /></Field>
        <Field label="Otros descuentos"><Input inputMode="decimal" value={input.options.other_deductions ?? ''} onChange={e => opt('other_deductions', num(e.target.value))} /></Field>
      </div>
      <Field label={input.kind === 'despido_justificado' ? 'Causa del despido (obligatoria)' : 'Observaciones'}>
        <Input value={input.reason ?? ''} onChange={e => setInput(x => ({ ...x, reason: e.target.value }))} />
      </Field>
      {calc && (
        <div className="table-wrap" style={{ padding: 12 }}>
          <div className="stat-row" style={{ marginBottom: 8 }}><span>Servicio <strong>{calc.service_text}</strong></span><span>Salario diario <strong>{money(calc.daily_salary)}</strong></span><span>Pagado hasta <strong>{dmy(calc.paid_through)}</strong></span></div>
          <table className="acc-table"><tbody>
            <tr><td>Salario pendiente ({calc.pending_days} días)</td><td className="num">{money(calc.pending_salary)}</td></tr>
            <tr><td>Vacaciones ({calc.vacation_days} días proporcionales{calc.pending_vacation_periods ? ` + ${calc.pending_vacation_periods} período/s` : ''})</td><td className="num">{money(calc.vacation)}</td></tr>
            <tr><td>Aguinaldo proporcional</td><td className="num">{money(calc.aguinaldo)}</td></tr>
            <tr><td>{calc.kind === 'renuncia' ? 'Prestación por renuncia' : 'Indemnización'}<div className="muted" style={{ fontSize: 'var(--text-xs)' }}>{calc.indemnity_note}</div></td><td className="num">{money(calc.indemnity)}</td></tr>
            <tr className="subtotal"><td>Total prestaciones</td><td className="num">{money(calc.gross)}</td></tr>
            <tr><td>ISSS / AFP / Renta / Otros</td><td className="num">({money(calc.total_deductions)})</td></tr>
            <tr className="total"><td>Líquido a recibir</td><td className="num">{money(calc.net)}</td></tr>
          </tbody></table>
        </div>
      )}
    </Modal>
  );
}

// ── Reportes ─────────────────────────────────────────────────────────────────
function Reportes() {
  const [year, setYear] = useState(new Date().getFullYear() - (new Date().getMonth() < 2 ? 1 : 0));
  const q = useQuery({ queryKey: ['payroll', 'f910', year], queryFn: () => payrollApi.f910(year) });
  const items = q.data?.items ?? [];
  const csv = () => downloadText(`f910-${year}.csv`, ['dui,nit,nombre,ingresos_gravados,aguinaldo_y_otros,isss,afp,renta_retenida',
    ...items.map(r => [r.dui ?? '', r.nit ?? '', `"${r.full_name}"`, r.taxable_income, r.aguinaldo_and_other, r.isss, r.afp, r.isr].join(','))].join('\r\n'));
  const sum = (k: 'taxable_income' | 'aguinaldo_and_other' | 'isss' | 'afp' | 'isr') => items.reduce((s, r) => s + num(r[k]), 0);
  return (
    <>
      <div className="toolbar">
        <Field label="Año"><Input type="number" value={year} onChange={e => setYear(Number(e.target.value))} style={{ width: 110 }} /></Field>
        <Button variant="secondary" onClick={csv} disabled={!items.length}>Exportar CSV</Button>
        <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>Base para el informe anual de retenciones (F-910) y las constancias de retención de cada empleado.</span>
      </div>
      <ErrorBanner error={q.error} />
      {q.isLoading ? <Loading /> : !items.length ? <EmptyState title={`Sin planillas emitidas en ${year}`} /> : (
        <div className="table-wrap"><table className="acc-table">
          <thead><tr><th>Empleado</th><th>DUI</th><th className="num">Ingresos gravados</th><th className="num">Aguinaldo/indemn.</th><th className="num">ISSS</th><th className="num">AFP</th><th className="num">Renta retenida</th></tr></thead>
          <tbody>
            {items.map(r => <tr key={r.employee_id}><td>{r.full_name}</td><td className="code">{r.dui}</td><td className="num">{money(r.taxable_income)}</td><td className="num">{money(r.aguinaldo_and_other)}</td><td className="num">{money(r.isss)}</td><td className="num">{money(r.afp)}</td><td className="num">{money(r.isr)}</td></tr>)}
            <tr className="total"><td colSpan={2}>Total</td><td className="num">{money(sum('taxable_income'))}</td><td className="num">{money(sum('aguinaldo_and_other'))}</td><td className="num">{money(sum('isss'))}</td><td className="num">{money(sum('afp'))}</td><td className="num">{money(sum('isr'))}</td></tr>
          </tbody>
        </table></div>
      )}
    </>
  );
}

// ── Configuración ────────────────────────────────────────────────────────────
const SETTING_FIELDS: Array<[keyof PayrollSettings, string, 'pct' | 'money' | 'num']> = [
  ['isss_employee_rate', 'ISSS trabajador', 'pct'], ['isss_employer_rate', 'ISSS patrono', 'pct'], ['isss_cap', 'Tope de cotización ISSS (mensual)', 'money'],
  ['afp_employee_rate', 'AFP trabajador', 'pct'], ['afp_employer_rate', 'AFP patrono', 'pct'], ['afp_cap', 'Tope AFP (vacío = sin tope)', 'money'],
  ['insaforp_rate', 'INSAFORP', 'pct'], ['minimum_wage', 'Salario mínimo mensual', 'money'], ['aguinaldo_exempt', 'Aguinaldo exento de renta', 'money'],
  ['workday_hours', 'Horas de la jornada', 'num'], ['overtime_surcharge', 'Recargo horas extra', 'pct'], ['night_surcharge', 'Recargo nocturno', 'pct'],
  ['holiday_surcharge', 'Recargo asueto trabajado', 'pct'], ['vacation_premium', 'Prima de vacaciones', 'pct'],
];

function Configuracion() {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['payroll', 'settings'], queryFn: payrollApi.settings });
  const [s, setS] = useState<PayrollSettings | null>(null);
  useEffect(() => { if (q.data) setS(q.data.settings); }, [q.data]);
  const save = useMutation({ mutationFn: () => payrollApi.saveSettings(s!), onSuccess: () => void qc.invalidateQueries({ queryKey: ['payroll'] }) });
  const editable = can('payroll:manage');
  if (!s) return <Loading />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
      <div className="tax-card">
        <div className="tax-card-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Parámetros de ley</span>{editable && <Button onClick={() => save.mutate()} disabled={save.isPending}>Guardar</Button>}
        </div>
        <ErrorBanner error={save.error} />
        {save.isSuccess && <div className="banner banner-success" style={{ marginBottom: 12 }}>Parámetros guardados. Se aplican a las planillas en borrador al recalcular.</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          {SETTING_FIELDS.map(([k, label, kind]) => (
            <Field key={k} label={kind === 'pct' ? `${label} (%)` : label}>
              <Input inputMode="decimal" disabled={!editable}
                value={s[k] === null ? '' : kind === 'pct' ? String(Math.round(Number(s[k]) * 10000) / 100) : String(s[k])}
                onChange={e => setS({ ...s, [k]: e.target.value === '' && k === 'afp_cap' ? null : kind === 'pct' ? num(e.target.value) / 100 : num(e.target.value) })} />
            </Field>
          ))}
          <label style={{ fontSize: 'var(--text-sm)', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" disabled={!editable} checked={s.insaforp_applies} onChange={e => setS({ ...s, insaforp_applies: e.target.checked })} />
            Aplica INSAFORP (10 o más empleados)
          </label>
        </div>
      </div>
      <IsrTables brackets={q.data!.isr_brackets} editable={editable} />
      <CostCenters />
    </div>
  );
}

function IsrTables({ brackets, editable }: { brackets: Array<{ frequency: string; lower_limit: number; rate: number; excess_over: number; fixed_fee: number }>; editable: boolean }) {
  const qc = useQueryClient();
  const [freq, setFreq] = useState<'mensual' | 'quincenal'>('mensual');
  const current = useMemo(() => brackets.filter(b => b.frequency === freq).map(b => ({ lower_limit: num(b.lower_limit), rate: num(b.rate), excess_over: num(b.excess_over), fixed_fee: num(b.fixed_fee) })), [brackets, freq]);
  const [rows, setRows] = useState(current);
  useEffect(() => setRows(current), [current]);
  const save = useMutation({ mutationFn: () => payrollApi.saveIsr(freq, rows), onSuccess: () => void qc.invalidateQueries({ queryKey: ['payroll', 'settings'] }) });
  const upd = (i: number, k: keyof typeof rows[number], v: number) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div className="tax-card">
      <div className="tax-card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Tabla de retención de renta</span>
        <span style={{ display: 'flex', gap: 8 }}>
          <Select value={freq} onChange={e => setFreq(e.target.value as 'mensual' | 'quincenal')} style={{ width: 150 }}><option value="mensual">Mensual</option><option value="quincenal">Quincenal</option></Select>
          {editable && <Button onClick={() => save.mutate()} disabled={save.isPending}>Guardar tabla</Button>}
        </span>
      </div>
      <ErrorBanner error={save.error} />
      <table className="acc-table lines-editor">
        <thead><tr><th>Tramo</th><th className="num">Desde</th><th className="num">% sobre el exceso</th><th className="num">Exceso de</th><th className="num">Cuota fija</th></tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i}><td>{i + 1}</td>
            {(['lower_limit', 'rate', 'excess_over', 'fixed_fee'] as const).map(k => (
              <td key={k}><Input disabled={!editable} inputMode="decimal" style={{ textAlign: 'right' }} value={k === 'rate' ? Math.round(r[k] * 10000) / 100 : r[k]}
                onChange={e => upd(i, k, k === 'rate' ? num(e.target.value) / 100 : num(e.target.value))} /></td>
            ))}
          </tr>
        ))}</tbody>
      </table>
      <div className="muted" style={{ fontSize: 'var(--text-xs)', marginTop: 6 }}>Retención = cuota fija + (base − exceso) × %. Precargada con la reforma del 30/04/2025.</div>
    </div>
  );
}

function CostCenters() {
  const { can } = usePermissions();
  const q = useQuery({ queryKey: ['payroll', 'cc'], queryFn: payrollApi.costCenters });
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const canAccounts = can('accounting:view');
  return (
    <div className="tax-card">
      <div className="tax-card-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>Centros de costo</span>
        {can('payroll:manage') && canAccounts && <Button onClick={() => setEditing('new')}>+ Centro de costo</Button>}
      </div>
      <div className="muted" style={{ fontSize: 'var(--text-xs)', marginBottom: 8 }}>
        Cada centro puede llevar sus sueldos y aportes a cuentas propias (p.ej. costo de producción vs gasto de ventas). Si no define cuentas, usa las de Configuración contable.
      </div>
      <table className="acc-table">
        <thead><tr><th>Nombre</th><th>Sueldos</th><th>ISSS patronal</th><th>AFP patronal</th><th className="num">Empleados</th><th /></tr></thead>
        <tbody>{(q.data ?? []).map(c => (
          <tr key={c.id} className={c.is_active ? '' : 'muted'}>
            <td>{c.name}</td>
            <td className="muted">{c.salary_code ? `${c.salary_code} ${c.salary_name}` : 'General'}</td>
            <td className="muted">{c.isss_code ? `${c.isss_code} ${c.isss_name}` : 'General'}</td>
            <td className="muted">{c.afp_code ? `${c.afp_code} ${c.afp_name}` : 'General'}</td>
            <td className="num">{c.employees}</td>
            <td>{can('payroll:manage') && canAccounts && <Button size="sm" variant="secondary" onClick={() => setEditing(c.id)}>Editar</Button>}</td>
          </tr>
        ))}</tbody>
      </table>
      {editing !== null && <CostCenterModal cc={editing === 'new' ? null : q.data!.find(c => c.id === editing)!} onClose={() => setEditing(null)} />}
    </div>
  );
}

function CostCenterModal({ cc, onClose }: { cc: { id: number; name: string; salary_account_id: number | null; isss_account_id: number | null; afp_account_id: number | null; is_active: boolean } | null; onClose: () => void }) {
  const qc = useQueryClient();
  const accounts = useAccounts();
  const [f, setF] = useState({ name: cc?.name ?? '', salary_account_id: cc?.salary_account_id ?? null, isss_account_id: cc?.isss_account_id ?? null, afp_account_id: cc?.afp_account_id ?? null, is_active: cc?.is_active ?? true });
  const save = useMutation({ mutationFn: async (): Promise<unknown> => payrollApi.saveCostCenter(cc?.id ?? null, f), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['payroll'] }); onClose(); } });
  const acc = accounts.data ?? [];
  return (
    <Modal title={cc ? `Centro de costo ${cc.name}` : 'Nuevo centro de costo'} onClose={onClose} onSave={() => save.mutate()} saveDisabled={!f.name.trim() || save.isPending}>
      <ErrorBanner error={save.error} />
      <Field label="Nombre"><Input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Cuenta de sueldos"><AccountSelect accounts={acc} value={f.salary_account_id} onChange={id => setF({ ...f, salary_account_id: id })} placeholder="General (Configuración contable)" /></Field>
      <Field label="Cuenta ISSS patronal"><AccountSelect accounts={acc} value={f.isss_account_id} onChange={id => setF({ ...f, isss_account_id: id })} placeholder="General" /></Field>
      <Field label="Cuenta AFP patronal"><AccountSelect accounts={acc} value={f.afp_account_id} onChange={id => setF({ ...f, afp_account_id: id })} placeholder="General" /></Field>
      <label style={{ fontSize: 'var(--text-sm)', display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="checkbox" checked={f.is_active} onChange={e => setF({ ...f, is_active: e.target.checked })} /> Activo
      </label>
    </Modal>
  );
}
