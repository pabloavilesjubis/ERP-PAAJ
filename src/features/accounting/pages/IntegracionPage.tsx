import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Badge } from '@/components/ui/Badge';
import { Tabs } from '@/components/ui/Tabs';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner, Loading } from '@/components/ui/Feedback';
import { usePermissions } from '@/auth/usePermissions';
import { integrationApi, type DistributionLine } from '../api';
import { useAccounts } from '../hooks';
import { dmy, entryNo, money, money2, num } from '../format';
import { AccountSelect } from '../components/AccountSelect';
import { EntryModal } from '../components/EntryModals';
import { SetupBanner } from '../components/SetupBanner';
import type { IntegrationDoc, IntegrationSettings, PostingStatus } from '../types';

const STATUS: Record<PostingStatus, { label: string; tone: 'success' | 'warning' | 'info' | 'neutral' }> = {
  contabilizado: { label: 'Contabilizado', tone: 'success' },
  error: { label: 'Error', tone: 'warning' },
  pendiente: { label: 'Pendiente', tone: 'info' },
  omitido: { label: 'Omitido', tone: 'neutral' },
};

const SKIP_LABEL: Record<string, string> = {
  anulado: 'Documento anulado', antes_del_inicio: 'Anterior a la fecha de inicio', monto_cero: 'Monto cero',
};

/**
 * Contabilización automática de ventas y compras: configuración, estado de
 * cada documento, errores para corregir y distribución contable de compras.
 */
export function IntegracionPage() {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const [module, setModule] = useState<'ventas' | 'compras'>('ventas');
  const [status, setStatus] = useState<string>('error');
  const [search, setSearch] = useState('');
  const [entry, setEntry] = useState<number | null>(null);
  const [dist, setDist] = useState<number | null>(null);
  const summary = useQuery({ queryKey: ['acc', 'integration', 'summary'], queryFn: integrationApi.summary });
  const docs = useQuery({
    queryKey: ['acc', 'integration', 'docs', module, status, search],
    queryFn: () => integrationApi.documents({ module, status: status || undefined, q: search || undefined, limit: 300 }),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['acc'] });
  const postPending = useMutation({ mutationFn: () => integrationApi.postPending(), onSuccess: refresh });
  const retry = useMutation({ mutationFn: (d: IntegrationDoc) => integrationApi.retry(d.module, d.id), onSuccess: refresh });

  const count = (m: string, s: string) => summary.data?.items.find(i => i.module === m && i.status === s)?.n ?? 0;

  return (
    <div>
      <SetupBanner />
      <SectionHeader title="Contabilización de ventas y compras"
        description="Cada venta y compra genera su asiento automáticamente. Lo que no se pudo contabilizar queda aquí con el motivo." />
      <SettingsCard />

      <div className="kpi-grid" style={{ marginTop: 'var(--s-6)' }}>
        {(['ventas', 'compras'] as const).map(m => (
          <div key={m} className="kpi-card">
            <div className="kpi-label">{m === 'ventas' ? 'Ventas' : 'Compras'}</div>
            <div className="stat-row" style={{ marginTop: 6 }}>
              <span>Contabilizadas <strong>{count(m, 'contabilizado')}</strong></span>
              <span style={{ color: count(m, 'error') ? 'var(--danger-text)' : undefined }}>Con error <strong>{count(m, 'error')}</strong></span>
              <span>Pendientes <strong>{count(m, 'pendiente')}</strong></span>
            </div>
          </div>
        ))}
      </div>

      {can('accounting:post') && (
        <div className="toolbar">
          <Button onClick={() => postPending.mutate()} disabled={postPending.isPending}>
            {postPending.isPending ? 'Contabilizando…' : 'Contabilizar pendientes y reintentar errores'}
          </Button>
          {postPending.data && <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>
            {Object.entries(postPending.data.result).map(([m, r]) => `${m}: ${Object.entries(r).map(([k, n]) => `${n} ${k}`).join(', ') || 'nada pendiente'}`).join(' · ')}
          </span>}
        </div>
      )}
      <ErrorBanner error={postPending.error ?? retry.error} />

      <Tabs value={module} onChange={setModule} tabs={[{ value: 'ventas', label: 'Ventas' }, { value: 'compras', label: 'Compras' }]} />
      <div className="toolbar">
        <Select value={status} onChange={e => setStatus(e.target.value)} style={{ width: 200 }}>
          <option value="">Todos</option>
          <option value="error">Con error</option>
          <option value="pendiente">Pendientes</option>
          <option value="contabilizado">Contabilizados</option>
          <option value="omitido">Omitidos</option>
        </Select>
        <Input placeholder="Buscar documento o tercero…" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 300 }} />
      </div>
      <ErrorBanner error={docs.error} />
      {docs.isLoading ? <Loading /> : (docs.data?.items ?? []).length === 0 ? <EmptyState title="Nada que mostrar con este filtro" /> : (
        <div className="table-wrap"><div className="table-scroll">
          <table className="acc-table">
            <thead><tr><th>Fecha</th><th>Documento</th><th>Tercero</th><th className="num">Total</th><th>Estado</th><th>Detalle</th><th /></tr></thead>
            <tbody>
              {docs.data!.items.map(d => (
                <tr key={`${d.module}-${d.id}`}>
                  <td className="code">{dmy(d.doc_date)}</td>
                  <td>{d.doc_ref}</td>
                  <td>{d.party_name}</td>
                  <td className="num">{money(d.total)}</td>
                  <td><Badge tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Badge></td>
                  <td className="muted" style={{ maxWidth: 380, whiteSpace: 'normal' }}>
                    {d.status === 'omitido' ? SKIP_LABEL[d.message ?? ''] ?? d.message : d.message}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {d.entry_id && <><Button size="sm" variant="secondary" onClick={() => setEntry(d.entry_id!)}>#{entryNo(d.entry_number)}</Button>{' '}</>}
                    {d.module === 'compras' && can('accounting:post') && <><Button size="sm" variant="secondary" onClick={() => setDist(d.id)}>Distribución</Button>{' '}</>}
                    {(d.status === 'error' || d.status === 'pendiente') && can('accounting:post') &&
                      <Button size="sm" onClick={() => retry.mutate(d)} disabled={retry.isPending}>Contabilizar</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="table-footer"><span className="total-item">{docs.data!.total} documento(s)</span></div>
        </div>
      )}
      {entry !== null && <EntryModal id={entry} onClose={() => setEntry(null)} />}
      {dist !== null && <DistributionModal compraId={dist} onClose={() => setDist(null)} />}
    </div>
  );
}

function SettingsCard() {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['acc', 'integration', 'settings'], queryFn: integrationApi.settings });
  const [form, setForm] = useState<IntegrationSettings | null>(null);
  useEffect(() => { if (q.data) setForm({ ...q.data, posting_start_date: q.data.posting_start_date?.slice(0, 10) ?? null }); }, [q.data]);
  const save = useMutation({
    mutationFn: () => integrationApi.saveSettings(form!),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['acc'] }),
  });
  if (!form) return <Loading />;
  const editable = can('accounting:config');
  const set = <K extends keyof IntegrationSettings>(k: K, v: IntegrationSettings[K]) => setForm(f => ({ ...f!, [k]: v }));
  return (
    <div className="tax-card">
      <div className="tax-card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Configuración {form.auto_post ? <Badge tone="success">Activa</Badge> : <Badge tone="neutral">Apagada</Badge>}</span>
        {editable && <Button onClick={() => save.mutate()} disabled={save.isPending}>Guardar</Button>}
      </div>
      <ErrorBanner error={save.error} />
      {save.isSuccess && <div className="banner banner-success" style={{ marginBottom: 12 }}>Configuración guardada.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
        <Field label="Contabilización automática">
          <Select value={form.auto_post ? '1' : '0'} onChange={e => set('auto_post', e.target.value === '1')} disabled={!editable}>
            <option value="0">Apagada</option>
            <option value="1">Activa</option>
          </Select>
        </Field>
        <Field label="Contabilizar documentos desde">
          <Input type="date" value={form.posting_start_date ?? ''} onChange={e => set('posting_start_date', e.target.value || null)} disabled={!editable} />
        </Field>
        <Field label="Ventas de contado al debe de">
          <Select value={form.sales_cash_role} onChange={e => set('sales_cash_role', e.target.value as IntegrationSettings['sales_cash_role'])} disabled={!editable}>
            <option value="cash">Caja general</option>
            <option value="bank">Banco predeterminado</option>
            <option value="receivables">Clientes (CxC, se liquida con el depósito)</option>
          </Select>
        </Field>
        <Field label="Compras de contado">
          <Select value={form.purchases_cash_mode} onChange={e => set('purchases_cash_mode', e.target.value as IntegrationSettings['purchases_cash_mode'])} disabled={!editable}>
            <option value="payables">A CxP (se pagan contra el banco)</option>
            <option value="cash">Pagadas de caja</option>
          </Select>
        </Field>
        <Field label="Días de crédito por defecto">
          <Input type="number" min={0} max={365} value={form.default_credit_days} onChange={e => set('default_credit_days', Number(e.target.value))} disabled={!editable} />
        </Field>
      </div>
      <div className="muted" style={{ fontSize: 'var(--text-xs)', marginTop: 10 }}>
        Los documentos anteriores a la fecha de inicio no se contabilizan (registra sus saldos con la partida de apertura y los documentos manuales de CxC/CxP).
        Las ventas al crédito y todas las compras (salvo "pagadas de caja") quedan en los auxiliares de CxC/CxP.
      </div>
    </div>
  );
}

interface DLine { key: number; account_id: number | null; amount: string; cost_center: string }
let k = 1;

function DistributionModal({ compraId, onClose }: { compraId: number; onClose: () => void }) {
  const qc = useQueryClient();
  const accounts = useAccounts();
  const q = useQuery({ queryKey: ['acc', 'distribution', compraId], queryFn: () => integrationApi.distribution(compraId) });
  const [lines, setLines] = useState<DLine[]>([]);
  const [remember, setRemember] = useState(false);
  useEffect(() => {
    if (!q.data) return;
    setLines(q.data.lines.length
      ? q.data.lines.map(l => ({ key: k++, account_id: Number(l.account_id), amount: String(l.amount), cost_center: l.cost_center ?? '' }))
      : [{ key: k++, account_id: null, amount: '', cost_center: '' }]);
  }, [q.data]);
  const base = q.data ? money2(num(q.data.compra.gravado) + num(q.data.compra.exento) + num(q.data.compra.otros)) : 0;
  const sum = money2(lines.reduce((s, l) => s + num(l.amount), 0));
  const save = useMutation({
    mutationFn: () => integrationApi.saveDistribution(compraId,
      lines.filter(l => l.account_id && num(l.amount) > 0).map<DistributionLine>(l => ({ account_id: l.account_id!, amount: num(l.amount), cost_center: l.cost_center || null })),
      remember),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['acc'] }); onClose(); },
  });
  const upd = (key: number, p: Partial<DLine>) => setLines(ls => ls.map(l => (l.key === key ? { ...l, ...p } : l)));

  return (
    <Modal title="Distribución contable de la compra" onClose={onClose} size="wide"
      footer={<>
        <span style={{ marginRight: 'auto', fontSize: 'var(--text-sm)', color: sum === base ? 'var(--success-text)' : 'var(--danger-text)' }}>
          Distribuido {money(sum)} de {money(base)}
        </span>
        <Button variant="secondary" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending || sum !== base}>Guardar y recontabilizar</Button>
      </>}
    >
      {!q.data ? <Loading /> : <>
        <ErrorBanner error={save.error} />
        <div className="stat-row">
          <span>{q.data.compra.proveedor_nombre}</span>
          <span>Fecha <strong>{dmy(q.data.compra.fecha)}</strong></span>
          <span>Base (sin IVA) <strong>{money(base)}</strong></span>
          <span>IVA <strong>{money(q.data.compra.iva)}</strong></span>
        </div>
        {q.data.posting?.message && q.data.posting.status === 'error' && <div className="banner banner-warning">{q.data.posting.message}</div>}
        <div className="table-wrap" style={{ overflow: 'visible' }}>
          <table className="acc-table lines-editor">
            <thead><tr><th style={{ width: '55%' }}>Cuenta de costo / gasto / activo</th><th>Centro de costo</th><th className="num" style={{ width: 140 }}>Monto</th><th style={{ width: 40 }} /></tr></thead>
            <tbody>
              {lines.map(l => (
                <tr key={l.key}>
                  <td><AccountSelect accounts={accounts.data ?? []} value={l.account_id} onChange={id => upd(l.key, { account_id: id })} /></td>
                  <td><Input value={l.cost_center} onChange={e => upd(l.key, { cost_center: e.target.value })} /></td>
                  <td><Input inputMode="decimal" style={{ textAlign: 'right' }} value={l.amount} onChange={e => upd(l.key, { amount: e.target.value })} /></td>
                  <td><button type="button" className="btn-icon" onClick={() => setLines(ls => ls.length > 1 ? ls.filter(x => x.key !== l.key) : ls)}>×</button></td>
                </tr>
              ))}
              <tr className="total"><td colSpan={2}>
                <Button size="sm" variant="secondary" onClick={() => setLines(ls => [...ls, { key: k++, account_id: null, amount: String(money2(base - sum) > 0 ? money2(base - sum) : ''), cost_center: '' }])}>+ Línea</Button>
              </td><td className="num">{money(sum)}</td><td /></tr>
            </tbody>
          </table>
        </div>
        {q.data.party_id && (
          <label style={{ fontSize: 'var(--text-sm)', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
            Usar la cuenta principal como predeterminada para las próximas compras de este proveedor
          </label>
        )}
      </>}
    </Modal>
  );
}
