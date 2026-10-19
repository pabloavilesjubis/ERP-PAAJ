import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner, Loading } from '@/components/ui/Feedback';
import { usePermissions } from '@/auth/usePermissions';
import { useAccounts } from '@/features/accounting/hooks';
import { AccountSelect } from '@/features/accounting/components/AccountSelect';
import { EntryModal } from '@/features/accounting/components/EntryModals';
import { todayIso } from '@/features/accounting/dates';
import { dmy, money, num } from '@/features/accounting/format';
import { checkDuca, summarize } from './checks';
import type { DucaData } from './types';

interface ImportRow {
  id: number; duca_number: string; acceptance_date: string; exporter_name: string | null; exporter_country: string | null;
  invoice_number: string | null; fob: number; freight: number; insurance: number; customs_value: number; dai: number; iva: number;
  other_taxes: number; read_by_ai: boolean; destination_code: string; destination_name: string; posting_status: string | null; entry_id: number | null;
}

/** Importaciones: la DUCA entra al libro de compras (tipo 12, Tesorería) y su asiento lleva lo pagado en aduana. */
export function ImportacionesPage() {
  const { can } = usePermissions();
  const [creating, setCreating] = useState(false);
  const [entry, setEntry] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['imports'], queryFn: () => api.get<{ items: ImportRow[] }>('/v2/imports').then(r => r.items) });
  return (
    <div>
      <SectionHeader title="Importaciones" description="DUCA: valor en aduana = FOB + flete + seguro; DAI sobre el valor en aduana; IVA 13% de (valor en aduana + DAI) = crédito fiscal."
        actions={can('accounting:post') && <Button onClick={() => setCreating(true)}>+ Registrar DUCA</Button>} />
      <ErrorBanner error={q.error} />
      {q.isLoading ? <Loading /> : !(q.data ?? []).length ? <EmptyState title="Sin importaciones registradas" /> : (
        <div className="table-wrap"><div className="table-scroll">
          <table className="acc-table">
            <thead><tr><th>DUCA</th><th>Fecha</th><th>Proveedor exterior</th><th className="num">Valor en aduana</th><th className="num">DAI</th><th className="num">IVA</th><th className="num">Otros</th><th>Destino</th><th>Contabilidad</th></tr></thead>
            <tbody>{q.data!.map(i => (
              <tr key={i.id}>
                <td className="code">{i.duca_number}{i.read_by_ai && <> <Badge tone="info">IA</Badge></>}</td>
                <td className="code">{dmy(i.acceptance_date)}</td>
                <td>{i.exporter_name}{i.exporter_country ? <span className="muted"> · {i.exporter_country}</span> : null}</td>
                <td className="num">{money(i.customs_value)}</td><td className="num">{money(i.dai)}</td><td className="num">{money(i.iva)}</td><td className="num">{money(i.other_taxes, { blankZero: true })}</td>
                <td className="muted">{i.destination_code} {i.destination_name}</td>
                <td>{i.entry_id ? <Button size="sm" variant="secondary" onClick={() => setEntry(i.entry_id!)}>Asiento</Button> : <Badge>{i.posting_status ?? 'pendiente'}</Badge>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div></div>
      )}
      {creating && <DucaModal onClose={() => setCreating(false)} />}
      {entry !== null && <EntryModal id={entry} onClose={() => setEntry(null)} />}
    </div>
  );
}

const EMPTY: DucaData = {
  duca_number: '', reference_number: null, acceptance_date: todayIso(), importer_nit: null, importer_name: null, exporter_name: null,
  exporter_country: null, declarant_name: null, regime: null, customs_office: null, incoterm: null, exchange_rate: null, invoice_number: null,
  fob: 0, freight: 0, insurance: 0, other_costs: 0, customs_value: 0, taxes: [], total_taxes: 0, lines: [], documents: [], notes: null,
};

function DucaModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const accounts = useAccounts();
  const ai = useQuery({ queryKey: ['imports', 'ai'], queryFn: () => api.get<{ enabled: boolean }>('/v2/imports/ai-status') });
  const [d, setD] = useState<DucaData>(EMPTY);
  const [manual, setManual] = useState({ dai: '', iva: '', other: '' });
  const [fromAi, setFromAi] = useState(false);
  const [dest, setDest] = useState<number | null>(null);
  const read = useMutation({
    mutationFn: async (file: File) => {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return api.post<{ data: DucaData; model: string }>('/v2/imports/read', { pdf_base64: btoa(bin) });
    },
    onSuccess: r => { setD(r.data); setFromAi(true); },
  });
  // Con la lectura de IA los tributos vienen de la liquidación; a mano se digitan
  const s = useMemo(() => fromAi ? summarize(d) : null, [d, fromAi]);
  const checks = useMemo(() => fromAi ? checkDuca(d) : [], [d, fromAi]);
  const dai = s ? s.dai : num(manual.dai);
  const iva = s ? s.iva : num(manual.iva);
  const other = s ? s.other_taxes : num(manual.other);
  const cif = Math.round((d.fob + d.freight + d.insurance + d.other_costs) * 100) / 100;
  const ivaExpected = Math.round((d.customs_value + dai) * 0.13 * 100) / 100;
  const save = useMutation({
    mutationFn: () => api.post('/v2/imports', {
      duca_number: d.duca_number.replace(/\D/g, ''), acceptance_date: d.acceptance_date, exporter_name: d.exporter_name, exporter_country: d.exporter_country,
      invoice_number: d.invoice_number, fob: d.fob, freight: d.freight, insurance: d.insurance, other_costs: d.other_costs,
      customs_value: d.customs_value, dai, iva, other_taxes: other, destination_account_id: dest, read_by_ai: fromAi, data: fromAi ? d : undefined,
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['imports'] }); void qc.invalidateQueries({ queryKey: ['acc'] }); onClose(); },
  });
  const n = (k: 'fob' | 'freight' | 'insurance' | 'other_costs' | 'customs_value') => ({
    value: d[k] || '', inputMode: 'decimal' as const, onChange: (e: { target: { value: string } }) => setD({ ...d, [k]: num(e.target.value) }),
  });
  return (
    <Modal title="Registrar DUCA" onClose={onClose} size="wide" footer={<>
      <Button variant="secondary" onClick={onClose}>Cancelar</Button>
      <Button onClick={() => save.mutate()} disabled={save.isPending || !dest || !d.duca_number || !d.customs_value || checks.some(c => c.level === 'error')}>Registrar en el libro de compras</Button>
    </>}>
      <ErrorBanner error={read.error ?? save.error} />
      {ai.data?.enabled && (
        <div className="toolbar">
          <label className="btn btn-secondary" style={{ cursor: 'pointer' }}>
            {read.isPending ? 'Leyendo la DUCA… (puede tardar un par de minutos)' : 'Leer PDF de la DUCA con IA'}
            <input type="file" accept="application/pdf" hidden onChange={e => { const f = e.target.files?.[0]; if (f) read.mutate(f); e.target.value = ''; }} />
          </label>
          <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>La IA solo lee: revisa las validaciones y confirma tú.</span>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        <Field label="N.º de DUCA"><Input value={d.duca_number} onChange={e => setD({ ...d, duca_number: e.target.value })} /></Field>
        <Field label="Fecha de aceptación"><Input type="date" value={d.acceptance_date} onChange={e => setD({ ...d, acceptance_date: e.target.value })} /></Field>
        <Field label="Factura comercial"><Input value={d.invoice_number ?? ''} onChange={e => setD({ ...d, invoice_number: e.target.value || null })} /></Field>
        <Field label="Proveedor del exterior"><Input value={d.exporter_name ?? ''} onChange={e => setD({ ...d, exporter_name: e.target.value || null })} /></Field>
        <Field label="País"><Input value={d.exporter_country ?? ''} onChange={e => setD({ ...d, exporter_country: e.target.value || null })} /></Field>
        <span />
        <Field label="FOB (25)"><Input {...n('fob')} /></Field>
        <Field label="Flete (26)"><Input {...n('freight')} /></Field>
        <Field label="Seguro (27)"><Input {...n('insurance')} /></Field>
        <Field label="Otros gastos (28)"><Input {...n('other_costs')} /></Field>
        <Field label="Valor en aduana (29)"><Input {...n('customs_value')} /></Field>
        <span />
        {s ? <>
          <Field label="DAI"><Input value={money(s.dai)} disabled /></Field>
          <Field label="IVA (crédito fiscal)"><Input value={money(s.iva)} disabled /></Field>
          <Field label="Otros tributos (VTS, ITS…)"><Input value={money(s.other_taxes)} disabled /></Field>
        </> : <>
          <Field label="DAI"><Input inputMode="decimal" value={manual.dai} onChange={e => setManual({ ...manual, dai: e.target.value })} /></Field>
          <Field label={`IVA (13% de valor en aduana + DAI = ${money(ivaExpected)})`}><Input inputMode="decimal" value={manual.iva} onChange={e => setManual({ ...manual, iva: e.target.value })} /></Field>
          <Field label="Otros tributos (VTS, ITS…: costo)"><Input inputMode="decimal" value={manual.other} onChange={e => setManual({ ...manual, other: e.target.value })} /></Field>
        </>}
      </div>
      {!fromAi && d.customs_value > 0 && Math.abs(cif - d.customs_value) > 0.05 && <div className="banner banner-warning">El valor en aduana no es FOB + flete + seguro + otros ({money(cif)}).</div>}
      {checks.length > 0 && (
        <div className="table-wrap" style={{ padding: 10 }}>
          {checks.map((c, i) => <div key={i} style={{ fontSize: 'var(--text-sm)', color: c.level === 'error' ? 'var(--danger-text)' : c.level === 'warning' ? 'var(--warning-text)' : 'var(--success-text)' }}>
            {c.level === 'ok' ? '✓' : c.level === 'warning' ? '⚠' : '✗'} {c.message}</div>)}
          {fromAi && <div className="muted" style={{ fontSize: 'var(--text-xs)', marginTop: 6 }}>{d.lines.length} línea(s) de mercancía leídas.</div>}
        </div>
      )}
      <Field label="Cuenta destino de DAI y tributos (inventario en tránsito, activo o costo de importación)">
        <AccountSelect accounts={accounts.data ?? []} value={dest} onChange={setDest} />
      </Field>
      <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>
        Se registra en el libro de compras como documento tipo 12 de la Dirección General de Tesorería (columna L = valor en aduana + DAI).
        Asiento: Debe destino (DAI + otros tributos) y IVA crédito fiscal / Haber Tesorería (CxP, se paga contra el banco).
        La factura del proveedor del exterior (FOB, flete) regístrala en Cuentas por pagar → Documento manual.
      </div>
    </Modal>
  );
}
