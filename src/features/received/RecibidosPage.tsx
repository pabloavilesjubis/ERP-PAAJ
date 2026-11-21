import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner, Loading } from '@/components/ui/Feedback';
import { usePermissions } from '@/auth/usePermissions';
import { dmy, money } from '@/features/accounting/format';
import { useDataStore } from '@/stores/data.store';
import { Mailboxes } from './Mailboxes';

interface Received {
  id: number; source: 'upload' | 'email'; status: 'registrado' | 'duplicado' | 'rechazado'; detail: string | null;
  generation_code: string; control_number: string | null; document_type: string; issue_date: string | null;
  issuer_name: string | null; issuer_nrc: string | null; taxable_amount: number; iva_amount: number; total_amount: number;
  compra_id: number | null; file_name: string | null; mail_from: string | null; created_at: string;
}
interface UploadResult { file: string; status: string; detail: string | null; code?: string; warnings?: string[] }

const TONE = { registrado: 'success', duplicado: 'neutral', rechazado: 'warning', error: 'warning' } as const;
const TYPE: Record<string, string> = { '03': 'CCF', '05': 'NC', '06': 'ND', '14': 'FSE', '01': 'FCF', '11': 'FEX', EC: 'Estado de cuenta' };

interface StatementLine { fecha: string; descripcion: string; monto: number }
interface StatementPreview {
  statement: { bankName: string; account: string; cutDate: string; number: string; interestTotal: number; lines: StatementLine[]; otherLines: StatementLine[] };
  belongs: boolean;
  result: { status: string; detail: string | null; compra_id: number | null } | null;
}

const toBase64 = async (f: File) => {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/** DTEs de proveedores: se suben o llegan al buzón, y cada uno válido entra al libro de compras. */
export function RecibidosPage() {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<UploadResult[] | null>(null);
  const [showRaw, setShowRaw] = useState<number | null>(null);
  const [statement, setStatement] = useState<{ file: File; preview: StatementPreview } | null>(null);
  const previewStatement = useMutation({
    mutationFn: async (file: File) => ({ file, preview: await api.post<StatementPreview>('/v2/received/statement',
      { name: file.name, content_base64: await toBase64(file), preview: true }) }),
    onSuccess: setStatement,
  });
  const refreshData = useDataStore(s => s.refresh);
  const list = useQuery({
    queryKey: ['received', status, search],
    queryFn: () => api.get<{ items: Received[] }>(`/v2/received?${new URLSearchParams({ ...(status ? { status } : {}), ...(search ? { q: search } : {}) })}`).then(r => r.items),
  });
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      // JSON como texto; los PDF (con el sello cuando el JSON no lo trae) en base64
      const payload = await Promise.all(files.map(async f => /\.pdf$/i.test(f.name)
        ? { name: f.name, content_base64: await toBase64(f) }
        : { name: f.name, content: await f.text() }));
      return api.post<{ results: UploadResult[] }>('/v2/received/upload', { files: payload });
    },
    onSuccess: r => {
      setResults(r.results);
      void qc.invalidateQueries({ queryKey: ['received'] });
      void qc.invalidateQueries({ queryKey: ['acc'] });
      if (r.results.some(x => x.status === 'registrado')) void refreshData();   // las compras nuevas al almacén del ERP
    },
  });
  return (
    <div>
      <SectionHeader title="DTEs recibidos" description="Facturas electrónicas de proveedores: se registran en el libro de compras sin duplicados y se contabilizan solas." />
      <Mailboxes />
      {can('accounting:post') && (
        <div className="toolbar" style={{ marginTop: 'var(--s-5)' }}>
          <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
            {upload.isPending ? 'Procesando…' : 'Subir JSON de DTEs'}
            <input type="file" accept=".json,application/json,.pdf,application/pdf" multiple hidden onChange={e => {
              // Copia antes de limpiar el input: la FileList es "viva" y se vacía con value = ''
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (files.length) upload.mutate(files);
            }} />
          </label>
          <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>Puedes elegir varios a la vez; incluye el PDF si el JSON no trae el sello del MH.</span>
          <label className="btn btn-secondary" style={{ cursor: 'pointer', marginLeft: 'auto' }}>
            {previewStatement.isPending ? 'Leyendo PDF…' : 'Subir estado de cuenta (PDF)'}
            <input type="file" accept=".pdf,application/pdf" hidden onChange={e => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) previewStatement.mutate(file);
            }} />
          </label>
        </div>
      )}
      <ErrorBanner error={upload.error ?? previewStatement.error} />
      {results && (
        <div className="table-wrap" style={{ marginBottom: 'var(--s-5)' }}>
          <table className="acc-table"><tbody>{results.map((r, i) => (
            <tr key={i}><td>{r.file}</td><td><Badge tone={TONE[r.status as keyof typeof TONE] ?? 'neutral'}>{r.status}</Badge></td>
              <td className="muted">{r.detail}{r.warnings?.length ? ` · ${r.warnings.join(' · ')}` : ''}</td></tr>
          ))}</tbody></table>
        </div>
      )}
      <div className="toolbar">
        <Select value={status} onChange={e => setStatus(e.target.value)} style={{ width: 180 }}>
          <option value="">Todos</option><option value="registrado">Registrados</option><option value="duplicado">Duplicados</option><option value="rechazado">Rechazados</option>
        </Select>
        <Input placeholder="Proveedor, número de control o código…" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 320 }} />
      </div>
      <ErrorBanner error={list.error} />
      {list.isLoading ? <Loading /> : !(list.data ?? []).length ? <EmptyState title="Aún no hay DTEs recibidos" /> : (
        <div className="table-wrap"><div className="table-scroll">
          <table className="acc-table">
            <thead><tr><th>Fecha</th><th>Tipo</th><th>Proveedor</th><th>Número de control</th><th className="num">Gravado</th><th className="num">IVA</th><th className="num">Total</th><th>Estado</th><th>Origen</th></tr></thead>
            <tbody>{list.data!.map(d => (
              <tr key={d.id} className="clickable" onClick={() => setShowRaw(d.id)}>
                <td className="code">{dmy(d.issue_date)}</td><td>{TYPE[d.document_type] ?? d.document_type}</td>
                <td>{d.issuer_name}<div className="muted" style={{ fontSize: 'var(--text-xs)' }}>NRC {d.issuer_nrc}</div></td>
                <td className="code" style={{ fontSize: 'var(--text-xs)' }}>{d.control_number}</td>
                <td className="num">{money(d.taxable_amount)}</td><td className="num">{money(d.iva_amount)}</td><td className="num">{money(d.total_amount)}</td>
                <td><Badge tone={TONE[d.status]}>{d.status}</Badge>{(d.status !== 'registrado' || /gasto financiero/.test(d.detail ?? '')) && <div className="muted" style={{ fontSize: 'var(--text-xs)', maxWidth: 260, whiteSpace: 'normal' }}>{d.detail}</div>}</td>
                <td className="muted">{d.source === 'email' ? (d.mail_from ?? 'correo') : (d.file_name ?? 'subido')}</td>
              </tr>
            ))}</tbody>
          </table>
        </div></div>
      )}
      {showRaw !== null && <RawModal id={showRaw} onClose={() => setShowRaw(null)} />}
      {statement && <StatementModal file={statement.file} preview={statement.preview} onClose={() => setStatement(null)}
        onDone={() => { void qc.invalidateQueries({ queryKey: ['received'] }); void qc.invalidateQueries({ queryKey: ['acc'] }); void refreshData(); }} />}
    </div>
  );
}

function RawModal({ id, onClose }: { id: number; onClose: () => void }) {
  const q = useQuery({ queryKey: ['received', 'raw', id], queryFn: () => api.get<{ raw: unknown; generation_code: string }>(`/v2/received/${id}`) });
  return (
    <Modal title={`DTE ${q.data?.generation_code ?? ''}`} onClose={onClose} size="wide" footer={<Button variant="secondary" onClick={onClose}>Cerrar</Button>}>
      {q.isLoading ? <Loading /> : <pre style={{ fontSize: 11, maxHeight: 500, overflow: 'auto', background: 'var(--surface-2)', padding: 12, borderRadius: 8 }}>{JSON.stringify(q.data?.raw, null, 2)}</pre>}
    </Modal>
  );
}

/** Vista previa del estado de cuenta: intereses que se registrarán como gasto financiero. */
function StatementModal({ file, preview, onClose, onDone }: { file: File; preview: StatementPreview; onClose: () => void; onDone: () => void }) {
  const st = preview.statement;
  const save = useMutation({
    mutationFn: async () => api.post<StatementPreview>('/v2/received/statement', { name: file.name, content_base64: await toBase64(file) }),
    onSuccess: () => onDone(),
  });
  const result = save.data?.result;
  return (
    <Modal title={`Estado de cuenta · ${st.bankName}`} onClose={onClose} size="wide" footer={<>
      <Button variant="secondary" onClick={onClose}>{result ? 'Cerrar' : 'Cancelar'}</Button>
      {!result && <Button onClick={() => save.mutate()} disabled={save.isPending || !preview.belongs || st.interestTotal <= 0}>
        {save.isPending ? 'Registrando…' : `Registrar intereses $${money(st.interestTotal)}`}</Button>}
    </>}>
      <ErrorBanner error={save.error} />
      {result && <div className={`banner banner-${result.status === 'registrado' ? 'success' : 'warning'}`}>{result.detail}</div>}
      {!preview.belongs && <div className="banner banner-warning">El titular del estado de cuenta no coincide con el nombre o DUI de Mi empresa: no se puede registrar.</div>}
      <div className="stat-row" style={{ marginBottom: 12 }}>
        <span>{st.account}</span><span>Corte <strong>{dmy(st.cutDate)}</strong></span>
        <span>Intereses del mes <strong>${money(st.interestTotal)}</strong></span>
      </div>
      {st.lines.length === 0 ? <EmptyState title="Sin intereses en este corte" description="No hay movimientos de intereses en el detalle de transacciones." /> : (
        <div className="table-wrap"><table className="acc-table">
          <thead><tr><th>Fecha</th><th>Intereses cobrados</th><th className="num">Monto</th></tr></thead>
          <tbody>{st.lines.map((l, i) => <tr key={i}><td className="code">{dmy(l.fecha)}</td><td>{l.descripcion}</td><td className="num">{money(l.monto)}</td></tr>)}
            <tr className="total"><td colSpan={2}>Total gasto financiero</td><td className="num">{money(st.interestTotal)}</td></tr></tbody>
        </table></div>
      )}
      {st.otherLines.length > 0 && (
        <p className="muted" style={{ fontSize: 'var(--text-xs)', marginTop: 8 }}>
          No se suman como intereses: {st.otherLines.map(l => `${l.descripcion} $${money(l.monto)}`).join(' · ')}.
        </p>
      )}
      <p className="muted" style={{ fontSize: 'var(--text-xs)', marginTop: 8 }}>
        Se registra en Compras como gasto financiero sin IVA (no entra al anexo del F-07), con este PDF adjunto. El buzón de correo
        también lee estos PDF automáticamente cuando llegan sin DTE.
      </p>
    </Modal>
  );
}
