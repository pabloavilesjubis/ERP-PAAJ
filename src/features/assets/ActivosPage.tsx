import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Badge } from '@/components/ui/Badge';
import { KpiCard } from '@/components/ui/KpiCard';
import { Tabs } from '@/components/ui/Tabs';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner, Loading } from '@/components/ui/Feedback';
import { usePermissions } from '@/auth/usePermissions';
import { useAccounts } from '@/features/accounting/hooks';
import { AccountSelect } from '@/features/accounting/components/AccountSelect';
import { EntryModal } from '@/features/accounting/components/EntryModals';
import { subApi } from '@/features/accounting/api';
import { monthRange, todayIso } from '@/features/accounting/dates';
import { dmy, entryNo, money, num } from '@/features/accounting/format';

interface Category {
  id: number; name: string; tax_class: string; annual_rate: number; max_rate: number;
  asset_account_id: number | null; depreciation_account_id: number | null; expense_account_id: number | null;
  asset_code: string | null; asset_name: string | null; dep_code: string | null; dep_name: string | null; exp_code: string | null; exp_name: string | null;
}
interface Asset {
  id: number; code: string; name: string; category_id: number; category_name: string; acquisition_date: string; in_service_date: string;
  cost: number; salvage_value: number; annual_rate: number; months: number; status: 'activo' | 'baja'; disposal_date: string | null;
  disposal_kind: string | null; accumulated_posted: number; accumulated_to_date: number; monthly_amount: number | null; pending_months: number;
  location: string | null; serial_number: string | null;
}

const CLASS_LABEL: Record<string, string> = {
  edificaciones: 'Edificaciones (máx. 5%)', maquinaria: 'Maquinaria (máx. 20%)', vehiculos: 'Vehículos (máx. 25%)', otros_bienes_muebles: 'Otros bienes muebles (máx. 50%)',
};

/** Activos fijos: altas, depreciación línea recta (Art. 30 LISR), contabilización mensual y bajas o ventas. */
export function ActivosPage() {
  const [tab, setTab] = useState<'activos' | 'categorias'>('activos');
  return (
    <div>
      <SectionHeader title="Activos fijos" description="Depreciación en línea recta con las tasas máximas de la Ley de ISR (Art. 30)." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'activos', label: 'Activos' }, { value: 'categorias', label: 'Categorías y cuentas' }]} />
      {tab === 'activos' ? <Activos /> : <Categorias />}
    </div>
  );
}

function Activos() {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['assets'], queryFn: () => api.get<{ items: Asset[] }>('/v2/assets').then(r => r.items) });
  const [creating, setCreating] = useState(false);
  const [schedule, setSchedule] = useState<Asset | null>(null);
  const [disposing, setDisposing] = useState<Asset | null>(null);
  const now = new Date();
  const lastMonth = monthRange(now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear(), now.getMonth() === 0 ? 12 : now.getMonth()).to;
  const [through, setThrough] = useState(lastMonth);
  const dep = useMutation({
    mutationFn: () => api.post<{ entries: number }>('/v2/assets/depreciate', { through }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['assets'] }); void qc.invalidateQueries({ queryKey: ['acc'] }); },
  });
  const items = q.data ?? [];
  const active = items.filter(a => a.status === 'activo');
  const cost = active.reduce((s, a) => s + num(a.cost), 0);
  const acc = active.reduce((s, a) => s + num(a.accumulated_posted), 0);
  const pending = active.reduce((s, a) => s + a.pending_months, 0);
  return (
    <>
      <div className="kpi-grid">
        <KpiCard label="Activos en uso" value={active.length} size="md" />
        <KpiCard label="Costo" value={money(cost)} size="md" />
        <KpiCard label="Depreciación acumulada" value={money(acc)} size="md" />
        <KpiCard label="Valor en libros" value={money(cost - acc)} size="md" />
      </div>
      <div className="toolbar">
        {can('assets:manage') && <Button onClick={() => setCreating(true)}>+ Activo</Button>}
        {can('assets:manage') && <>
          <Field label="Contabilizar depreciación hasta"><Input type="date" value={through} onChange={e => setThrough(e.target.value)} /></Field>
          <Button variant="secondary" onClick={() => dep.mutate()} disabled={dep.isPending}>Contabilizar depreciación</Button>
        </>}
        {pending > 0 && <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>{pending} cuota(s) pendientes a hoy</span>}
        {dep.data && <span style={{ color: 'var(--success-text)', fontSize: 'var(--text-sm)' }}>{dep.data.entries} asiento(s) de depreciación</span>}
      </div>
      <ErrorBanner error={q.error ?? dep.error} />
      {q.isLoading ? <Loading /> : !items.length ? <EmptyState title="Sin activos fijos" description="Configura las cuentas de cada categoría y da de alta tus activos (nuevos o existentes con su depreciación acumulada)." /> : (
        <div className="table-wrap"><div className="table-scroll">
          <table className="acc-table">
            <thead><tr><th>Código</th><th>Activo</th><th>Categoría</th><th>En uso desde</th><th className="num">Costo</th><th className="num">Cuota mensual</th><th className="num">Dep. acumulada</th><th className="num">Valor en libros</th><th>Estado</th><th /></tr></thead>
            <tbody>{items.map(a => (
              <tr key={a.id} className={a.status === 'baja' ? 'muted' : ''}>
                <td className="code">{a.code}</td><td>{a.name}{a.location ? <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>{a.location}</div> : null}</td>
                <td>{a.category_name} · {Math.round(a.annual_rate * 100)}%</td><td className="code">{dmy(a.in_service_date)}</td>
                <td className="num">{money(a.cost)}</td><td className="num">{money(a.monthly_amount ?? 0, { blankZero: true })}</td>
                <td className="num">{money(a.accumulated_posted)}</td><td className="num">{money(num(a.cost) - num(a.accumulated_posted))}</td>
                <td>{a.status === 'activo' ? <Badge tone="success">Activo</Badge> : <Badge>{a.disposal_kind === 'venta' ? 'Vendido' : 'Baja'} {dmy(a.disposal_date)}</Badge>}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <Button size="sm" variant="secondary" onClick={() => setSchedule(a)}>Tabla</Button>{' '}
                  {a.status === 'activo' && can('assets:manage') && <Button size="sm" variant="danger" onClick={() => setDisposing(a)}>Baja / venta</Button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div></div>
      )}
      {creating && <AssetModal onClose={() => setCreating(false)} />}
      {schedule && <ScheduleModal asset={schedule} onClose={() => setSchedule(null)} />}
      {disposing && <DisposeModal asset={disposing} onClose={() => setDisposing(null)} />}
    </>
  );
}

function AssetModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const accounts = useAccounts();
  const cats = useQuery({ queryKey: ['assets', 'categories'], queryFn: () => api.get<{ items: Category[] }>('/v2/assets/categories').then(r => r.items) });
  const [mode, setMode] = useState<'nuevo' | 'existente' | 'contabilizado'>('nuevo');
  const [f, setF] = useState({ name: '', category_id: 0, acquisition_date: todayIso(), in_service_date: '', cost: '', salvage_value: '', annual_rate: '',
    opening_accumulated: '', opening_date: '', location: '', serial_number: '', supplier: '', invoice_ref: '' });
  const [counter, setCounter] = useState<number | null>(null);
  const cat = cats.data?.find(c => c.id === f.category_id);
  const save = useMutation({
    mutationFn: () => api.post('/v2/assets', {
      name: f.name, category_id: f.category_id, acquisition_date: f.acquisition_date, in_service_date: f.in_service_date || null,
      cost: num(f.cost), salvage_value: num(f.salvage_value), annual_rate: f.annual_rate ? num(f.annual_rate) / 100 : null,
      opening_accumulated: mode === 'existente' ? num(f.opening_accumulated) : 0, opening_date: mode === 'existente' ? f.opening_date || null : null,
      location: f.location || null, serial_number: f.serial_number || null, supplier: f.supplier || null, invoice_ref: f.invoice_ref || null,
      counter_account_id: mode === 'nuevo' ? counter : null,
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['assets'] }); void qc.invalidateQueries({ queryKey: ['acc'] }); onClose(); },
  });
  const set = (k: keyof typeof f, v: string) => setF(x => ({ ...x, [k]: v }));
  return (
    <Modal title="Alta de activo fijo" onClose={onClose} size="wide" onSave={() => save.mutate()} saveLabel="Dar de alta"
      saveDisabled={save.isPending || !f.name || !f.category_id || !num(f.cost) || (mode === 'nuevo' && !counter)}>
      <ErrorBanner error={save.error ?? cats.error} />
      <Tabs value={mode} onChange={setMode} tabs={[
        { value: 'nuevo', label: 'Compra nueva (registra el asiento)' },
        { value: 'contabilizado', label: 'Ya contabilizado en la cuenta del activo' },
        { value: 'existente', label: 'Activo existente (saldos iniciales)' },
      ]} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        <Field label="Nombre / descripción"><Input value={f.name} onChange={e => set('name', e.target.value)} /></Field>
        <Field label="Categoría">
          <Select value={f.category_id || ''} onChange={e => setF(x => ({ ...x, category_id: Number(e.target.value) }))}>
            <option value="">— Elegir —</option>
            {(cats.data ?? []).map(c => <option key={c.id} value={c.id}>{c.name} ({Math.round(c.annual_rate * 100)}%)</option>)}
          </Select>
        </Field>
        <Field label={`Tasa anual % (máx. ${cat ? Math.round(cat.max_rate * 100) : '—'}%)`}><Input inputMode="decimal" placeholder={cat ? String(Math.round(cat.annual_rate * 100)) : ''} value={f.annual_rate} onChange={e => set('annual_rate', e.target.value)} /></Field>
        <Field label="Fecha de adquisición"><Input type="date" value={f.acquisition_date} onChange={e => set('acquisition_date', e.target.value)} /></Field>
        <Field label="En uso desde (si es otra)"><Input type="date" value={f.in_service_date} onChange={e => set('in_service_date', e.target.value)} /></Field>
        <Field label="Costo"><Input inputMode="decimal" value={f.cost} onChange={e => set('cost', e.target.value)} /></Field>
        <Field label="Valor residual"><Input inputMode="decimal" value={f.salvage_value} onChange={e => set('salvage_value', e.target.value)} /></Field>
        <Field label="Ubicación"><Input value={f.location} onChange={e => set('location', e.target.value)} /></Field>
        <Field label="N.º de serie"><Input value={f.serial_number} onChange={e => set('serial_number', e.target.value)} /></Field>
        <Field label="Proveedor"><Input value={f.supplier} onChange={e => set('supplier', e.target.value)} /></Field>
        <Field label="Factura / CCF"><Input value={f.invoice_ref} onChange={e => set('invoice_ref', e.target.value)} /></Field>
        {mode === 'existente' && <>
          <Field label="Depreciación acumulada a la fecha de inicio"><Input inputMode="decimal" value={f.opening_accumulated} onChange={e => set('opening_accumulated', e.target.value)} /></Field>
          <Field label="Mes desde el que se deprecia aquí"><Input type="date" value={f.opening_date} onChange={e => set('opening_date', e.target.value)} /></Field>
        </>}
      </div>
      {mode === 'nuevo' && <Field label="Contrapartida (proveedores, banco, compras por liquidar…)"><AccountSelect accounts={accounts.data ?? []} value={counter} onChange={setCounter} /></Field>}
      <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>
        {mode === 'nuevo' && 'Asiento: Debe cuenta del activo / Haber contrapartida.'}
        {mode === 'contabilizado' && 'Para compras que ya se distribuyeron a la cuenta del activo (Ventas y compras → Distribución): no se registra asiento de adquisición.'}
        {mode === 'existente' && 'Para activos que ya están en tus saldos iniciales: no se registra asiento de adquisición; la depreciación continúa por los meses restantes.'}
      </div>
    </Modal>
  );
}

function ScheduleModal({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const q = useQuery({ queryKey: ['assets', 'schedule', asset.id], queryFn: () => api.get<{ items: Array<{ period: string; amount: number; accumulated: number; book_value: number; entry_id: number | null; entry_number: number | null }> }>(`/v2/assets/${asset.id}/schedule`).then(r => r.items) });
  const [entry, setEntry] = useState<number | null>(null);
  if (entry !== null) return <EntryModal id={entry} onClose={() => setEntry(null)} />;
  return (
    <Modal title={`Tabla de depreciación — ${asset.code} ${asset.name}`} onClose={onClose} size="wide" footer={<Button variant="secondary" onClick={onClose}>Cerrar</Button>}>
      {q.isLoading ? <Loading /> : (
        <div className="table-scroll" style={{ maxHeight: 460 }}>
          <table className="acc-table">
            <thead><tr><th>Mes</th><th className="num">Cuota</th><th className="num">Acumulada</th><th className="num">Valor en libros</th><th>Asiento</th></tr></thead>
            <tbody>{(q.data ?? []).map(s => (
              <tr key={s.period}><td className="code">{s.period.slice(5, 7)}/{s.period.slice(0, 4)}</td><td className="num">{money(s.amount)}</td>
                <td className="num">{money(s.accumulated)}</td><td className="num">{money(s.book_value)}</td>
                <td>{s.entry_id ? <a href="#" onClick={e => { e.preventDefault(); setEntry(s.entry_id!); }}>#{entryNo(s.entry_number)}</a> : <span className="muted">pendiente</span>}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function DisposeModal({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const qc = useQueryClient();
  const funds = useQuery({ queryKey: ['acc', 'funds'], queryFn: subApi.fundAccounts });
  const [kind, setKind] = useState<'venta' | 'baja'>('baja');
  const [date, setDate] = useState(todayIso());
  const [amount, setAmount] = useState('');
  const [proceeds, setProceeds] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const run = useMutation({
    mutationFn: () => api.post(`/v2/assets/${asset.id}/dispose`, { kind, date, amount: num(amount), proceeds_account_id: kind === 'venta' ? proceeds : null, notes }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['assets'] }); void qc.invalidateQueries({ queryKey: ['acc'] }); onClose(); },
  });
  return (
    <Modal title={`Baja o venta — ${asset.name}`} onClose={onClose} onSave={() => run.mutate()} saveLabel="Registrar"
      saveDisabled={run.isPending || (kind === 'venta' && (!num(amount) || !proceeds))}>
      <ErrorBanner error={run.error} />
      <div className="stat-row"><span>Costo <strong>{money(asset.cost)}</strong></span><span>Depreciación contabilizada <strong>{money(asset.accumulated_posted)}</strong></span></div>
      <Tabs value={kind} onChange={setKind} tabs={[{ value: 'baja', label: 'Baja (desecho, robo, daño)' }, { value: 'venta', label: 'Venta' }]} />
      <Field label="Fecha"><Input type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
      {kind === 'venta' && <>
        <Field label="Precio de venta"><Input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /></Field>
        <Field label="Se cobra en">
          <Select value={proceeds ?? ''} onChange={e => setProceeds(Number(e.target.value))}>
            <option value="">— Elegir —</option>
            {(funds.data ?? []).map(f => <option key={f.id} value={f.id}>{f.code} {f.name}</option>)}
          </Select>
        </Field>
      </>}
      <Field label="Notas"><Input value={notes} onChange={e => setNotes(e.target.value)} /></Field>
      <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>La diferencia contra el valor en libros va a «Resultado por venta o baja de activos» (Configuración contable). La depreciación debe estar contabilizada hasta el mes anterior.</div>
    </Modal>
  );
}

function Categorias() {
  const { can } = usePermissions();
  const q = useQuery({ queryKey: ['assets', 'categories'], queryFn: () => api.get<{ items: Category[] }>('/v2/assets/categories').then(r => r.items) });
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  return (
    <>
      {can('assets:manage') && <div className="toolbar"><Button onClick={() => setEditing('new')}>+ Categoría</Button></div>}
      <ErrorBanner error={q.error} />
      <div className="table-wrap"><table className="acc-table">
        <thead><tr><th>Categoría</th><th>Clase fiscal</th><th className="num">Tasa</th><th>Cuenta del activo</th><th>Depreciación acumulada</th><th>Gasto</th><th /></tr></thead>
        <tbody>{(q.data ?? []).map(c => (
          <tr key={c.id}>
            <td>{c.name}</td><td className="muted">{CLASS_LABEL[c.tax_class]}</td><td className="num">{Math.round(c.annual_rate * 100)}%</td>
            <td className="muted">{c.asset_code ? `${c.asset_code} ${c.asset_name}` : <Badge tone="warning">Sin asignar</Badge>}</td>
            <td className="muted">{c.dep_code ? `${c.dep_code} ${c.dep_name}` : <Badge tone="warning">Sin asignar</Badge>}</td>
            <td className="muted">{c.exp_code ? `${c.exp_code} ${c.exp_name}` : <Badge tone="warning">Sin asignar</Badge>}</td>
            <td>{can('assets:manage') && <Button size="sm" variant="secondary" onClick={() => setEditing(c)}>Editar</Button>}</td>
          </tr>
        ))}</tbody>
      </table></div>
      {editing && <CategoryModal cat={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function CategoryModal({ cat, onClose }: { cat: Category | null; onClose: () => void }) {
  const qc = useQueryClient();
  const accounts = useAccounts();
  const [f, setF] = useState({
    name: cat?.name ?? '', tax_class: cat?.tax_class ?? 'otros_bienes_muebles', annual_rate: cat ? String(Math.round(cat.annual_rate * 10000) / 100) : '50',
    asset_account_id: cat?.asset_account_id ?? null, depreciation_account_id: cat?.depreciation_account_id ?? null, expense_account_id: cat?.expense_account_id ?? null,
  });
  const save = useMutation({
    mutationFn: async (): Promise<unknown> => {
      const body = { ...f, annual_rate: num(f.annual_rate) / 100 };
      return cat ? api.put(`/v2/assets/categories/${cat.id}`, body) : api.post('/v2/assets/categories', body);
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['assets'] }); onClose(); },
  });
  const acc = accounts.data ?? [];
  return (
    <Modal title={cat ? `Categoría ${cat.name}` : 'Nueva categoría'} onClose={onClose} onSave={() => save.mutate()} saveDisabled={save.isPending || !f.name}>
      <ErrorBanner error={save.error} />
      <Field label="Nombre"><Input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
        <Field label="Clase (Art. 30 LISR)">
          <Select value={f.tax_class} onChange={e => setF({ ...f, tax_class: e.target.value })}>
            {Object.entries(CLASS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Tasa anual %"><Input inputMode="decimal" value={f.annual_rate} onChange={e => setF({ ...f, annual_rate: e.target.value })} /></Field>
      </div>
      <Field label="Cuenta del activo"><AccountSelect accounts={acc} value={f.asset_account_id} onChange={id => setF({ ...f, asset_account_id: id })} /></Field>
      <Field label="Depreciación acumulada (contraactivo)"><AccountSelect accounts={acc} value={f.depreciation_account_id} onChange={id => setF({ ...f, depreciation_account_id: id })} /></Field>
      <Field label="Gasto por depreciación"><AccountSelect accounts={acc} value={f.expense_account_id} onChange={id => setF({ ...f, expense_account_id: id })} /></Field>
    </Modal>
  );
}
