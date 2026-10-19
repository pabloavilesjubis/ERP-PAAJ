import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner, Loading } from '@/components/ui/Feedback';
import { usePermissions } from '@/auth/usePermissions';
import { dmy, money } from '@/features/accounting/format';

interface Received {
  id: number; source: 'upload' | 'email'; status: 'registrado' | 'duplicado' | 'rechazado'; detail: string | null;
  generation_code: string; control_number: string | null; document_type: string; issue_date: string | null;
  issuer_name: string | null; issuer_nrc: string | null; taxable_amount: number; iva_amount: number; total_amount: number;
  compra_id: number | null; file_name: string | null; mail_from: string | null; created_at: string;
}
interface UploadResult { file: string; status: string; detail: string | null; code?: string; warnings?: string[] }
interface Mailbox { host: string; port: number; username: string; folder: string; enabled: boolean; last_run_at: string | null; last_status: string | null; last_detail: string | null }

const TONE = { registrado: 'success', duplicado: 'neutral', rechazado: 'warning', error: 'warning' } as const;
const TYPE: Record<string, string> = { '03': 'CCF', '05': 'NC', '06': 'ND', '14': 'FSE', '01': 'FCF', '11': 'FEX' };

/** DTEs de proveedores: se suben o llegan al buzón, y cada uno válido entra al libro de compras. */
export function RecibidosPage() {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<UploadResult[] | null>(null);
  const [showRaw, setShowRaw] = useState<number | null>(null);
  const list = useQuery({
    queryKey: ['received', status, search],
    queryFn: () => api.get<{ items: Received[] }>(`/v2/received?${new URLSearchParams({ ...(status ? { status } : {}), ...(search ? { q: search } : {}) })}`).then(r => r.items),
  });
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const payload = await Promise.all(files.map(async f => ({ name: f.name, content: await f.text() })));
      return api.post<{ results: UploadResult[] }>('/v2/received/upload', { files: payload });
    },
    onSuccess: r => { setResults(r.results); void qc.invalidateQueries({ queryKey: ['received'] }); void qc.invalidateQueries({ queryKey: ['acc'] }); },
  });
  return (
    <div>
      <SectionHeader title="DTEs recibidos" description="Facturas electrónicas de proveedores: se registran en el libro de compras sin duplicados y se contabilizan solas." />
      <MailboxCard />
      {can('accounting:post') && (
        <div className="toolbar" style={{ marginTop: 'var(--s-5)' }}>
          <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
            {upload.isPending ? 'Procesando…' : 'Subir JSON de DTEs'}
            <input type="file" accept=".json,application/json" multiple hidden onChange={e => {
              // Copia antes de limpiar el input: la FileList es "viva" y se vacía con value = ''
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (files.length) upload.mutate(files);
            }} />
          </label>
          <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>Puedes elegir varios archivos a la vez.</span>
        </div>
      )}
      <ErrorBanner error={upload.error} />
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
                <td><Badge tone={TONE[d.status]}>{d.status}</Badge>{d.status !== 'registrado' && <div className="muted" style={{ fontSize: 'var(--text-xs)', maxWidth: 260, whiteSpace: 'normal' }}>{d.detail}</div>}</td>
                <td className="muted">{d.source === 'email' ? (d.mail_from ?? 'correo') : (d.file_name ?? 'subido')}</td>
              </tr>
            ))}</tbody>
          </table>
        </div></div>
      )}
      {showRaw !== null && <RawModal id={showRaw} onClose={() => setShowRaw(null)} />}
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

function MailboxCard() {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['received', 'mailbox'], queryFn: () => api.get<{ mailbox: Mailbox | null }>('/v2/received-mailbox') });
  const [f, setF] = useState({ host: '', port: 993, username: '', password: '', folder: 'INBOX', enabled: true });
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (q.data?.mailbox) setF(x => ({ ...x, ...q.data!.mailbox!, password: '' })); }, [q.data]);
  const save = useMutation({ mutationFn: () => api.put('/v2/received-mailbox', f), onSuccess: () => { setEditing(false); void qc.invalidateQueries({ queryKey: ['received'] }); } });
  const test = useMutation({ mutationFn: () => api.post<{ ok: boolean; messages?: number; error?: string }>('/v2/received-mailbox/test', f) });
  const run = useMutation({
    mutationFn: () => api.post<{ scanned: number; imported: number; duplicates: number; rejected: number; errors: number; status: string; detail: string | null }>('/v2/received-mailbox/run', {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['received'] }); void qc.invalidateQueries({ queryKey: ['acc'] }); },
  });
  const m = q.data?.mailbox;
  return (
    <div className="tax-card">
      <div className="tax-card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Buzón de correo {m ? (m.enabled ? <Badge tone="success">Revisión automática cada 30 min</Badge> : <Badge>Pausado</Badge>) : <Badge>Sin configurar</Badge>}</span>
        <span style={{ display: 'flex', gap: 8 }}>
          {m && can('accounting:post') && <Button variant="secondary" onClick={() => run.mutate()} disabled={run.isPending}>{run.isPending ? 'Revisando…' : 'Revisar ahora'}</Button>}
          {can('accounting:config') && <Button variant="secondary" onClick={() => setEditing(e => !e)}>{m ? 'Configurar' : 'Conectar buzón'}</Button>}
        </span>
      </div>
      {m && <div className="muted" style={{ fontSize: 'var(--text-sm)' }}>{m.username} · {m.host} · última revisión {m.last_run_at ? new Date(m.last_run_at).toLocaleString('es-SV') : 'nunca'}{m.last_detail ? ` — ${m.last_detail}` : ''}</div>}
      <ErrorBanner error={run.error} />
      {run.data && <div className={`banner ${run.data.status === 'error' ? 'banner-danger' : 'banner-success'}`} style={{ marginTop: 8 }}>
        {run.data.status === 'error' ? run.data.detail : `${run.data.scanned} correos revisados: ${run.data.imported} registrados, ${run.data.duplicates} duplicados, ${run.data.rejected} rechazados${run.data.errors ? `, ${run.data.errors} con error` : ''}.`}
      </div>}
      {editing && (
        <div style={{ marginTop: 12 }}>
          <div className="banner banner-info" style={{ marginBottom: 10 }}>IMAP sobre SSL (puerto 993). El buzón se lee en solo lectura: no se marca, mueve ni borra ningún correo. La contraseña se guarda cifrada.</div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 100px 2fr 1.5fr 1fr', gap: 10 }}>
            <Field label="Servidor IMAP"><Input value={f.host} onChange={e => setF({ ...f, host: e.target.value })} placeholder="imap.titan.email" /></Field>
            <Field label="Puerto"><Input type="number" value={f.port} onChange={e => setF({ ...f, port: Number(e.target.value) })} /></Field>
            <Field label="Usuario"><Input value={f.username} onChange={e => setF({ ...f, username: e.target.value })} placeholder="compras@empresa.com" /></Field>
            <Field label={m ? 'Contraseña (vacío = conservar)' : 'Contraseña'}><Input type="password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} /></Field>
            <Field label="Carpeta"><Input value={f.folder} onChange={e => setF({ ...f, folder: e.target.value })} /></Field>
          </div>
          <div className="toolbar" style={{ marginTop: 10 }}>
            <label style={{ fontSize: 'var(--text-sm)', display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={f.enabled} onChange={e => setF({ ...f, enabled: e.target.checked })} /> Revisar automáticamente
            </label>
            <Button variant="secondary" onClick={() => test.mutate()} disabled={!f.password || test.isPending}>Probar conexión</Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>Guardar</Button>
            {test.data && (test.data.ok ? <span style={{ color: 'var(--success-text)' }}>Conectado: {test.data.messages} correos en la carpeta</span> : <span style={{ color: 'var(--danger-text)' }}>{test.data.error}</span>)}
          </div>
          <ErrorBanner error={save.error ?? test.error} />
        </div>
      )}
    </div>
  );
}
