import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { ErrorBanner } from '@/components/ui/Feedback';
import { usePermissions } from '@/auth/usePermissions';
import { useDataStore } from '@/stores/data.store';

interface Mailbox {
  id: number; label: string | null; host: string; port: number; username: string; folder: string; enabled: boolean;
  last_run_at: string | null; last_status: string | null; last_detail: string | null;
}
interface RunSummary { scanned: number; imported: number; duplicates: number; rejected: number; errors: number; pending: number; status: 'done' | 'partial' | 'error'; detail: string | null }

const PROVEEDORES = [
  { value: 'gmail', label: 'Gmail', host: 'imap.gmail.com' },
  { value: 'outlook', label: 'Outlook / Office 365', host: 'outlook.office365.com' },
  { value: 'titan', label: 'Titan', host: 'imap.titan.email' },
  { value: 'otro', label: 'Otro servidor', host: '' },
] as const;
const proveedorDe = (host: string) => PROVEEDORES.find(p => p.host && p.host === host.trim().toLowerCase())?.value ?? 'otro';

const mesActual = () => new Date().toISOString().slice(0, 7);
const fecha = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-SV', { dateStyle: 'short', timeStyle: 'short' }) : 'nunca');

/** Cuentas de correo de la empresa de donde se leen los DTEs de proveedores (pueden ser varias). */
export function Mailboxes() {
  const { can } = usePermissions();
  const q = useQuery({ queryKey: ['received', 'mailboxes'], queryFn: () => api.get<{ items: Mailbox[] }>('/v2/received-mailboxes').then(r => r.items) });
  const [editing, setEditing] = useState<Mailbox | 'new' | null>(null);
  const items = q.data ?? [];
  return (
    <div className="tax-card">
      <div className="tax-card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Cuentas de correo {items.length === 0 && <Badge>Sin configurar</Badge>}</span>
        {can('accounting:config') && <Button variant="secondary" onClick={() => setEditing('new')}>+ Agregar correo</Button>}
      </div>
      <p className="muted" style={{ fontSize: 'var(--text-sm)', marginTop: 0 }}>
        Se leen en solo lectura (no se marca, mueve ni borra ningún correo). Cada 30 minutos se revisan los últimos 30 días de las cuentas
        activas; con «Revisar meses» puedes traer meses anteriores completos. Solo entran los DTE dirigidos a esta empresa.
      </p>
      <ErrorBanner error={q.error} />
      {items.map(m => <MailboxRow key={m.id} m={m} onEdit={() => setEditing(m)} />)}
      {editing && <MailboxModal m={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function MailboxRow({ m, onEdit }: { m: Mailbox; onEdit: () => void }) {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const [meses, setMeses] = useState(false);
  const [desde, setDesde] = useState(mesActual());
  const [hasta, setHasta] = useState(mesActual());
  const [progreso, setProgreso] = useState<{ total: RunSummary; vueltas: number; corriendo: boolean } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const refreshData = useDataStore(s => s.refresh);

  // Revisa en tandas: el backend corta a los 2 minutos y devuelve "partial"; se repite hasta terminar
  async function revisar(rango: { from: string; to: string } | null) {
    setError(null);
    const total: RunSummary = { scanned: 0, imported: 0, duplicates: 0, rejected: 0, errors: 0, pending: 0, status: 'done', detail: null };
    setProgreso({ total, vueltas: 0, corriendo: true });
    try {
      for (let vuelta = 1; vuelta <= 40; vuelta++) {
        const r = await api.post<RunSummary>(`/v2/received-mailboxes/${m.id}/run`, rango ?? {});
        for (const k of ['scanned', 'imported', 'duplicates', 'rejected', 'errors'] as const) total[k] += r[k];
        Object.assign(total, { pending: r.pending, status: r.status, detail: r.detail });
        setProgreso({ total: { ...total }, vueltas: vuelta, corriendo: r.status === 'partial' });
        if (r.status !== 'partial') break;
      }
    } catch (e) {
      setError(e);
      setProgreso(p => p && { ...p, corriendo: false });
    } finally {
      void qc.invalidateQueries({ queryKey: ['received'] });
      void qc.invalidateQueries({ queryKey: ['acc'] });
      // Las compras registradas viven en el almacén del ERP: se trae lo nuevo
      if (total.imported > 0) void refreshData();
    }
  }
  const borrar = useMutation({
    mutationFn: () => api.request('DELETE', `/v2/received-mailboxes/${m.id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['received', 'mailboxes'] }),
  });
  const corriendo = !!progreso?.corriendo;
  const t = progreso?.total;
  return (
    <div style={{ borderTop: '1px solid var(--border)', padding: 'var(--s-3) 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <strong>{m.label || m.username}</strong>{' '}
          {m.enabled ? <Badge tone="success">Revisión automática</Badge> : <Badge>Pausada</Badge>}
          <div className="muted" style={{ fontSize: 'var(--text-sm)' }}>
            {m.label ? `${m.username} · ` : ''}{m.host} · {m.folder} · última revisión {fecha(m.last_run_at)}
            {m.last_detail ? ` — ${m.last_detail}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {can('accounting:post') && <>
            <Button variant="secondary" onClick={() => void revisar(null)} disabled={corriendo}>Revisar ahora</Button>
            <Button variant="secondary" onClick={() => setMeses(v => !v)} disabled={corriendo}>Revisar meses…</Button>
          </>}
          {can('accounting:config') && <>
            <Button variant="secondary" onClick={onEdit}>Configurar</Button>
            <Button variant="danger" disabled={borrar.isPending}
              onClick={() => { if (confirm(`¿Quitar la cuenta ${m.username}? Los DTE ya registrados se conservan.`)) borrar.mutate(); }}>Quitar</Button>
          </>}
        </div>
      </div>
      {meses && (
        <div className="toolbar" style={{ marginTop: 8, alignItems: 'flex-end' }}>
          <Field label="Desde (mes)"><Input type="month" value={desde} max={mesActual()} onChange={e => setDesde(e.target.value)} /></Field>
          <Field label="Hasta (mes)"><Input type="month" value={hasta} min={desde} max={mesActual()} onChange={e => setHasta(e.target.value)} /></Field>
          <Button disabled={corriendo || !desde || !hasta || hasta < desde} onClick={() => void revisar({ from: desde, to: hasta })}>Revisar estos meses</Button>
          <span className="muted" style={{ fontSize: 'var(--text-xs)', maxWidth: 360 }}>
            Se revisan los correos recibidos en esos meses completos. Lo ya registrado no se duplica, así que puedes repetirlo sin riesgo.
          </span>
        </div>
      )}
      <ErrorBanner error={error ?? borrar.error} />
      {t && (
        <div className={`banner ${t.status === 'error' ? 'banner-danger' : corriendo ? 'banner-info' : 'banner-success'}`} style={{ marginTop: 8 }}>
          {t.status === 'error' && !t.scanned ? t.detail : <>
            {corriendo ? 'Revisando… ' : 'Listo: '}
            {t.scanned} correos revisados · {t.imported} registrados · {t.duplicates} duplicados · {t.rejected} rechazados
            {t.errors ? ` · ${t.errors} con error` : ''}{corriendo && t.pending ? ` · faltan ${t.pending}` : ''}
          </>}
        </div>
      )}
    </div>
  );
}

function MailboxModal({ m, onClose }: { m: Mailbox | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    label: m?.label ?? '', host: m?.host ?? 'imap.gmail.com', port: m?.port ?? 993, username: m?.username ?? '',
    password: '', folder: m?.folder ?? 'INBOX', enabled: m?.enabled ?? true,
  });
  const proveedor = proveedorDe(f.host);
  const body = () => ({ ...f, label: f.label.trim() || null, password: f.password || undefined });
  const save = useMutation({
    mutationFn: () => m ? api.put(`/v2/received-mailboxes/${m.id}`, body()) : api.post('/v2/received-mailboxes', body()),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['received', 'mailboxes'] }); onClose(); },
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; messages?: number; error?: string }>('/v2/received-mailboxes/test', { ...body(), id: m?.id }),
  });
  return (
    <Modal title={m ? `Configurar ${m.username}` : 'Agregar cuenta de correo'} onClose={onClose} size="wide" footer={<>
      <Button variant="secondary" onClick={() => test.mutate()} disabled={test.isPending || !f.username || (!m && !f.password)}>
        {test.isPending ? 'Probando…' : 'Probar conexión'}
      </Button>
      <Button onClick={() => save.mutate()} disabled={save.isPending || !f.username || !f.host || (!m && !f.password)}>Guardar</Button>
    </>}>
      <ErrorBanner error={save.error ?? test.error} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
        <Field label="Proveedor">
          <Select value={proveedor} onChange={e => {
            const p = PROVEEDORES.find(x => x.value === e.target.value)!;
            setF({ ...f, host: p.host || (proveedor === 'otro' ? f.host : ''), port: 993 });
          }}>
            {PROVEEDORES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </Select>
        </Field>
        <Field label="Nombre (opcional)"><Input value={f.label} onChange={e => setF({ ...f, label: e.target.value })} placeholder="Correo de compras" /></Field>
        <Field label="Correo / usuario"><Input value={f.username} onChange={e => setF({ ...f, username: e.target.value.trim() })} placeholder="compras@empresa.com" /></Field>
        <Field label={m ? 'Contraseña (vacío = conservar)' : 'Contraseña'}>
          <Input type="password" autoComplete="new-password" value={f.password} onChange={e => setF({ ...f, password: e.target.value.replace(/\s+/g, '') })} />
        </Field>
        <Field label="Servidor IMAP"><Input value={f.host} onChange={e => setF({ ...f, host: e.target.value.trim() })} placeholder="imap.servidor.com" /></Field>
        <Field label="Puerto"><Input type="number" value={f.port} onChange={e => setF({ ...f, port: Number(e.target.value) })} /></Field>
        <Field label="Carpeta"><Input value={f.folder} onChange={e => setF({ ...f, folder: e.target.value })} /></Field>
      </div>
      {proveedor === 'gmail' && (
        <div className="banner banner-info" style={{ marginTop: 10 }}>
          <span>
            Gmail no acepta la contraseña normal: usa una <strong>contraseña de aplicación</strong> (myaccount.google.com → Seguridad →
            Verificación en 2 pasos → Contraseñas de aplicaciones). Son 16 letras; los espacios se quitan solos.
          </span>
        </div>
      )}
      <label style={{ fontSize: 'var(--text-sm)', display: 'flex', gap: 6, alignItems: 'center', marginTop: 10 }}>
        <input type="checkbox" checked={f.enabled} onChange={e => setF({ ...f, enabled: e.target.checked })} /> Revisar automáticamente cada 30 minutos
      </label>
      {test.data && (test.data.ok
        ? <div className="banner banner-success" style={{ marginTop: 8 }}>Conectado: {test.data.messages} correos en la carpeta {f.folder}.</div>
        : <div className="banner banner-danger" style={{ marginTop: 8 }}>{test.data.error}</div>)}
    </Modal>
  );
}
