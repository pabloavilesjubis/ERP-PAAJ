import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { cleanEmisor, EMPTY_EMISOR, EmisorFields, fileToBase64 } from '@/features/empresa/EmisorFields';
import { Modal } from '@/components/ui/Modal';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Badge } from '@/components/ui/Badge';
import { KpiCard } from '@/components/ui/KpiCard';
import { Tabs } from '@/components/ui/Tabs';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner, Loading } from '@/components/ui/Feedback';
import { usePermissions } from '@/auth/usePermissions';
import { useAuth } from '@/auth/useAuth';
import { dmy } from '@/features/accounting/format';
import { platformApi, ROLE_LABEL, STATUS_LABEL, type Emisor, type PlatformTenant, type TenantDetail } from './api';

const SLUG_RE = /^[a-z0-9-]{2,32}$/;

const STATUS_TONE: Record<string, 'success' | 'warning' | 'neutral' | 'info'> = { active: 'success', suspended: 'warning', archived: 'neutral', pending_onboarding: 'info' };

/**
 * Consola de plataforma: solo para los super-admin (PLATFORM_ADMIN_EMAILS).
 * Ver, crear, editar y eliminar las empresas que usan el ERP, sus datos
 * fiscales y sus usuarios.
 */
export function PlataformaPage() {
  const { isPlatformAdmin, loading } = usePermissions();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['platform', 'tenants'], queryFn: platformApi.list, enabled: isPlatformAdmin });

  const items = useMemo(() => (q.data ?? []).filter(t => {
    const s = search.trim().toLowerCase();
    return (!status || t.status === status)
      && (!s || [t.slug, t.nombre_legal, t.nombre_comercial ?? '', t.nit ?? ''].some(v => v.toLowerCase().includes(s)));
  }), [q.data, search, status]);

  if (loading) return <Loading />;
  if (!isPlatformAdmin) {
    return <EmptyState title="Acceso restringido" description="La consola de plataforma es solo para los administradores del sistema." />;
  }
  const all = q.data ?? [];
  return (
    <div>
      <SectionHeader title="Empresas en el sistema" description="Consola de plataforma: crea, edita, suspende o elimina las empresas que tienen acceso al ERP."
        actions={<Button onClick={() => setCreating(true)}>+ Nueva empresa</Button>} />
      <div className="kpi-grid">
        <KpiCard label="Empresas" value={all.length} size="md" />
        <KpiCard label="Activas" value={all.filter(t => t.status === 'active').length} size="md" tone="success" />
        <KpiCard label="Usuarios" value={all.reduce((s, t) => s + t.users, 0)} size="md" />
        <KpiCard label="DTEs emitidos este mes" value={all.reduce((s, t) => s + t.dtes_month, 0)} size="md" />
      </div>
      <div className="toolbar">
        <Input placeholder="Buscar por nombre, slug o NIT…" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 320 }} />
        <Select value={status} onChange={e => setStatus(e.target.value)} style={{ width: 180 }}>
          <option value="">Todos los estados</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </div>
      <ErrorBanner error={q.error} />
      {q.isLoading ? <Loading /> : !items.length ? <EmptyState title="Sin empresas con ese filtro" /> : (
        <div className="table-wrap"><div className="table-scroll">
          <table className="acc-table">
            <thead><tr><th>ID</th><th>Empresa</th><th>NIT</th><th>Facturación MH</th><th>Estado</th><th className="num">Usuarios</th><th className="num">DTEs (mes / total)</th><th>Último acceso</th><th>Creada</th><th /></tr></thead>
            <tbody>{items.map(t => <TenantRow key={t.id} t={t} onOpen={() => setOpen(Number(t.id))} />)}</tbody>
          </table>
        </div></div>
      )}
      {creating && <CreateModal onClose={() => setCreating(false)} onCreated={id => { setCreating(false); setOpen(id); }} />}
      {open !== null && <TenantModal id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function TenantRow({ t, onOpen }: { t: PlatformTenant; onOpen: () => void }) {
  return (
    <tr className="clickable" onClick={onOpen}>
      <td className="code">{t.id}</td>
      <td><strong>{t.nombre_comercial || t.nombre_legal}</strong><div className="muted" style={{ fontSize: 'var(--text-xs)' }}>{t.nombre_legal} · <code>{t.slug}</code></div></td>
      <td className="code">{t.nit ?? '—'}</td>
      <td>{t.has_emisor ? <Badge tone={t.mh_env === 'production' ? 'success' : 'info'}>{t.mh_env === 'production' ? 'Producción' : 'Pruebas'}</Badge> : <Badge tone="warning">Sin datos fiscales</Badge>}</td>
      <td><Badge tone={STATUS_TONE[t.status] ?? 'neutral'}>{STATUS_LABEL[t.status] ?? t.status}</Badge></td>
      <td className="num">{t.users}</td>
      <td className="num">{t.dtes_month} / {t.dtes}</td>
      <td className="muted">{t.last_login_at ? new Date(t.last_login_at).toLocaleDateString('es-SV') : 'Nunca'}</td>
      <td className="muted">{dmy(t.created_at)}</td>
      <td style={{ textAlign: 'right' }}><Button size="sm" variant="secondary" onClick={e => { e.stopPropagation(); onOpen(); }}>Administrar</Button></td>
    </tr>
  );
}

// ── Crear ────────────────────────────────────────────────────────────────────
function CreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const qc = useQueryClient();
  const [t, setT] = useState({ slug: '', nombre_legal: '', nombre_comercial: '' });
  // El slug sigue al nombre legal hasta que el usuario lo edita a mano
  const [slugTouched, setSlugTouched] = useState(false);
  const [a, setA] = useState({ email: '', password: '', full_name: '' });
  const [withFiscal, setWithFiscal] = useState(false);
  const [e, setE] = useState<Emisor>(EMPTY_EMISOR);
  const [cert, setCert] = useState<File | null>(null);
  const [corr, setCorr] = useState({ '01': '0', '03': '0', '05': '0', '14': '0' });
  const run = useMutation({
    mutationFn: async () => {
      if (withFiscal && cert) await platformApi.uploadCert(e.mh_nit.replace(/\D/g, ''), await fileToBase64(cert));
      return platformApi.create({
        tenant: { slug: t.slug.trim(), nombre_legal: t.nombre_legal.trim(), nombre_comercial: t.nombre_comercial.trim() || null },
        admin: { email: a.email.trim(), password: a.password, full_name: a.full_name.trim() || null },
        emisor: withFiscal ? cleanEmisor(e) : null,
        correlativos: withFiscal ? Object.entries(corr).map(([tipo_dte, v]) => ({ tipo_dte, ultimo_consumido: parseInt(v, 10) || 0 })) : [],
      });
    },
    onSuccess: r => { void qc.invalidateQueries({ queryKey: ['platform'] }); onCreated(Number(r.tenant_id)); },
  });
  const slugFrom = (name: string) => name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/s\.?\s*a\.?\s*(de)?\s*c\.?\s*v\.?/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  return (
    <Modal title="Nueva empresa" onClose={onClose} size="wide" onSave={() => run.mutate()} saveLabel="Crear empresa"
      saveDisabled={run.isPending || !SLUG_RE.test(t.slug) || !t.nombre_legal || !a.email || a.password.length < 8}>
      <ErrorBanner error={run.error} />
      <strong>Empresa</strong>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.5fr 1fr', gap: 10 }}>
        <Field label="Nombre legal"><Input value={t.nombre_legal} onChange={ev => setT({ ...t, nombre_legal: ev.target.value, slug: slugTouched ? t.slug : slugFrom(ev.target.value) })} placeholder="ACME S.A. DE C.V." /></Field>
        <Field label="Nombre comercial"><Input value={t.nombre_comercial} onChange={ev => setT({ ...t, nombre_comercial: ev.target.value })} /></Field>
        <Field label="Identificador (slug)" error={t.slug && !SLUG_RE.test(t.slug) ? 'De 2 a 32: minúsculas, números y guiones' : undefined}>
          <Input value={t.slug} onChange={ev => { setSlugTouched(true); setT({ ...t, slug: ev.target.value.toLowerCase() }); }} placeholder="acme" />
        </Field>
      </div>
      <strong>Administrador de la empresa (primer usuario)</strong>
      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr', gap: 10 }}>
        <Field label="Email"><Input type="email" value={a.email} onChange={ev => setA({ ...a, email: ev.target.value })} /></Field>
        <Field label="Nombre"><Input value={a.full_name} onChange={ev => setA({ ...a, full_name: ev.target.value })} /></Field>
        <Field label="Contraseña (mín. 8)"><Input type="password" value={a.password} onChange={ev => setA({ ...a, password: ev.target.value })} /></Field>
      </div>
      <label style={{ fontSize: 'var(--text-sm)', display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="checkbox" checked={withFiscal} onChange={ev => setWithFiscal(ev.target.checked)} />
        Agregar ahora los datos fiscales para facturación electrónica (también se pueden agregar después)
      </label>
      {withFiscal && <>
        <EmisorFields e={e} setE={setE} requirePasswords />
        <Field label="Certificado .crt del MH">
          <input type="file" accept=".crt" onChange={ev => setCert(ev.target.files?.[0] ?? null)} />
        </Field>
        <strong>Correlativos iniciales (último número ya emitido en el MH)</strong>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          {(['01', '03', '05', '14'] as const).map(k => (
            <Field key={k} label={{ '01': 'FCF (01)', '03': 'CCF (03)', '05': 'NC (05)', '14': 'FSE (14)' }[k]}>
              <Input type="number" value={corr[k]} onChange={ev => setCorr({ ...corr, [k]: ev.target.value })} />
            </Field>
          ))}
        </div>
      </>}
    </Modal>
  );
}

// ── Administrar una empresa ──────────────────────────────────────────────────
type Tab = 'empresa' | 'fiscal' | 'usuarios' | 'eliminar';

function TenantModal({ id, onClose }: { id: number; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('empresa');
  const q = useQuery({ queryKey: ['platform', 'tenant', id], queryFn: () => platformApi.detail(id) });
  const d = q.data;
  return (
    <Modal title={d ? `${d.tenant.nombre_comercial || d.tenant.nombre_legal} (#${d.tenant.id})` : 'Empresa'} onClose={onClose} size="xwide"
      footer={<Button variant="secondary" onClick={onClose}>Cerrar</Button>}>
      <ErrorBanner error={q.error} />
      {!d ? <Loading /> : <>
        <div className="stat-row">
          <span>Estado <Badge tone={STATUS_TONE[d.tenant.status] ?? 'neutral'}>{STATUS_LABEL[d.tenant.status] ?? d.tenant.status}</Badge></span>
          <span>DTEs <strong>{d.counts.dtes}</strong></span><span>Ventas <strong>{d.counts.ventas}</strong></span>
          <span>Compras <strong>{d.counts.compras}</strong></span><span>Asientos <strong>{d.counts.asientos}</strong></span>
          <span>Empleados <strong>{d.counts.empleados}</strong></span><span>Creada {dmy(d.tenant.created_at)}</span>
        </div>
        <Tabs value={tab} onChange={setTab} tabs={[
          { value: 'empresa', label: 'Empresa' }, { value: 'fiscal', label: 'Datos fiscales (MH)' },
          { value: 'usuarios', label: `Usuarios (${d.users.length})` }, { value: 'eliminar', label: 'Eliminar' },
        ]} />
        {tab === 'empresa' && <EmpresaTab d={d} />}
        {tab === 'fiscal' && <FiscalTab d={d} />}
        {tab === 'usuarios' && <UsuariosTab d={d} />}
        {tab === 'eliminar' && <EliminarTab d={d} onDeleted={onClose} />}
      </>}
    </Modal>
  );
}

function useRefresh(id: number) {
  const qc = useQueryClient();
  return () => { void qc.invalidateQueries({ queryKey: ['platform'] }); void qc.invalidateQueries({ queryKey: ['platform', 'tenant', id] }); };
}

function EmpresaTab({ d }: { d: TenantDetail }) {
  const refresh = useRefresh(d.tenant.id);
  const [f, setF] = useState({ slug: d.tenant.slug, nombre_legal: d.tenant.nombre_legal, nombre_comercial: d.tenant.nombre_comercial ?? '' });
  const save = useMutation({ mutationFn: () => platformApi.update(d.tenant.id, { ...f, nombre_comercial: f.nombre_comercial || null }), onSuccess: refresh });
  const status = useMutation({ mutationFn: (s: string) => platformApi.update(d.tenant.id, { status: s }), onSuccess: refresh });
  const isRoot = d.tenant.id === 1;
  return (
    <>
      <ErrorBanner error={save.error ?? status.error} />
      {save.isSuccess && <div className="banner banner-success">Cambios guardados.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.5fr 1fr', gap: 10 }}>
        <Field label="Nombre legal"><Input value={f.nombre_legal} onChange={e => setF({ ...f, nombre_legal: e.target.value })} /></Field>
        <Field label="Nombre comercial"><Input value={f.nombre_comercial} onChange={e => setF({ ...f, nombre_comercial: e.target.value })} /></Field>
        <Field label="Identificador (slug)"><Input value={f.slug} onChange={e => setF({ ...f, slug: e.target.value.toLowerCase() })} /></Field>
      </div>
      <div className="toolbar"><Button onClick={() => save.mutate()} disabled={save.isPending}>Guardar cambios</Button></div>
      <div className="tax-card">
        <div className="tax-card-title">Acceso al sistema</div>
        <div className="muted" style={{ fontSize: 'var(--text-sm)', marginBottom: 10 }}>
          Suspender bloquea el ingreso de todos sus usuarios de inmediato sin borrar nada. Archivar es para empresas que dejaron de usar el sistema: conserva sus registros fiscales.
        </div>
        {isRoot ? <span className="muted">La empresa #1 (PAAJ) siempre está activa.</span> : (
          <div style={{ display: 'flex', gap: 8 }}>
            {d.tenant.status !== 'active' && <Button onClick={() => status.mutate('active')} disabled={status.isPending}>Activar</Button>}
            {d.tenant.status === 'active' && <Button variant="secondary" onClick={() => status.mutate('suspended')} disabled={status.isPending}>Suspender</Button>}
            {d.tenant.status !== 'archived' && <Button variant="secondary" onClick={() => status.mutate('archived')} disabled={status.isPending}>Archivar</Button>}
          </div>
        )}
      </div>
    </>
  );
}

function FiscalTab({ d }: { d: TenantDetail }) {
  const refresh = useRefresh(d.tenant.id);
  const [e, setE] = useState<Emisor>(() => d.emisor ? { ...EMPTY_EMISOR, ...d.emisor, mh_password: '', firmador_password: '' } : EMPTY_EMISOR);
  const [cert, setCert] = useState<File | null>(null);
  useEffect(() => { if (d.emisor) setE({ ...EMPTY_EMISOR, ...d.emisor, mh_password: '', firmador_password: '' }); }, [d.emisor]);
  const save = useMutation({
    mutationFn: async () => {
      if (cert) await platformApi.uploadCert(e.mh_nit.replace(/\D/g, ''), await fileToBase64(cert));
      return platformApi.saveEmisor(d.tenant.id, cleanEmisor(e));
    },
    onSuccess: () => { setCert(null); refresh(); },
  });
  return (
    <>
      <ErrorBanner error={save.error} />
      {save.isSuccess && <div className="banner banner-success">Datos fiscales guardados.</div>}
      {!d.emisor && <div className="banner banner-warning">Esta empresa aún no tiene datos fiscales: no puede emitir DTEs.</div>}
      <EmisorFields e={e} setE={setE} requirePasswords={!d.emisor} />
      <Field label={`Certificado .crt del MH${d.emisor ? ' (subir solo para reemplazarlo)' : ''}`}>
        <input type="file" accept=".crt" onChange={ev => setCert(ev.target.files?.[0] ?? null)} />
      </Field>
      {d.correlativos.length > 0 && (
        <div className="muted" style={{ fontSize: 'var(--text-sm)' }}>
          Correlativos: {d.correlativos.map(c => `${c.tipo_dte} → ${c.ultimo_consumido}`).join(' · ')}
        </div>
      )}
      <div className="toolbar"><Button onClick={() => save.mutate()} disabled={save.isPending || !e.mh_nit}>Guardar datos fiscales</Button></div>
    </>
  );
}

function UsuariosTab({ d }: { d: TenantDetail }) {
  const refresh = useRefresh(d.tenant.id);
  const me = useAuth().user;
  const [n, setN] = useState({ email: '', full_name: '', role: 'admin', password: '' });
  const add = useMutation({ mutationFn: () => platformApi.addUser(d.tenant.id, n), onSuccess: () => { setN({ email: '', full_name: '', role: 'admin', password: '' }); refresh(); } });
  const upd = useMutation({ mutationFn: (a: { uid: string; b: { role?: string; active?: boolean } }) => platformApi.updateUser(a.uid, a.b), onSuccess: refresh });
  const pw = useMutation({
    mutationFn: (uid: string) => {
      const p = window.prompt('Nueva contraseña (mínimo 8 caracteres)');
      if (!p) throw new Error('cancelado');
      return platformApi.resetPassword(uid, p);
    },
  });
  return (
    <>
      <ErrorBanner error={add.error ?? upd.error ?? (pw.error instanceof Error && pw.error.message === 'cancelado' ? null : pw.error)} />
      {pw.isSuccess && <div className="banner banner-success">Contraseña actualizada.</div>}
      <div className="table-wrap"><table className="acc-table">
        <thead><tr><th>Usuario</th><th>Rol</th><th>Estado</th><th>Último acceso</th><th /></tr></thead>
        <tbody>{d.users.map(u => (
          <tr key={u.id} className={u.active ? '' : 'muted'}>
            <td>{u.full_name ?? '—'}<div className="muted" style={{ fontSize: 'var(--text-xs)' }}>{u.email}</div></td>
            <td>
              <Select value={u.role} onChange={e => upd.mutate({ uid: u.id, b: { role: e.target.value } })} disabled={u.id === me?.id} style={{ width: 190 }}>
                {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </td>
            <td>{u.active ? <Badge tone="success">Activo</Badge> : <Badge>Inactivo</Badge>}</td>
            <td className="muted">{u.last_login_at ? new Date(u.last_login_at).toLocaleString('es-SV') : 'Nunca'}</td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              <Button size="sm" variant="secondary" onClick={() => pw.mutate(u.id)}>Contraseña</Button>{' '}
              {u.id !== me?.id && <Button size="sm" variant={u.active ? 'danger' : 'secondary'} onClick={() => upd.mutate({ uid: u.id, b: { active: !u.active } })}>{u.active ? 'Desactivar' : 'Activar'}</Button>}
            </td>
          </tr>
        ))}</tbody>
      </table></div>
      <strong style={{ fontSize: 'var(--text-sm)' }}>Agregar usuario</strong>
      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1.2fr 1fr 1fr auto', gap: 10, alignItems: 'flex-end' }}>
        <Field label="Email"><Input type="email" value={n.email} onChange={e => setN({ ...n, email: e.target.value })} /></Field>
        <Field label="Nombre"><Input value={n.full_name} onChange={e => setN({ ...n, full_name: e.target.value })} /></Field>
        <Field label="Rol">
          <Select value={n.role} onChange={e => setN({ ...n, role: e.target.value })}>
            {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Contraseña"><Input type="password" value={n.password} onChange={e => setN({ ...n, password: e.target.value })} /></Field>
        <Button onClick={() => add.mutate()} disabled={add.isPending || !n.email || n.password.length < 8}>Agregar</Button>
      </div>
    </>
  );
}

function EliminarTab({ d, onDeleted }: { d: TenantDetail; onDeleted: () => void }) {
  const qc = useQueryClient();
  const [slug, setSlug] = useState('');
  const [password, setPassword] = useState('');
  const run = useMutation({
    mutationFn: () => platformApi.remove(d.tenant.id, slug, password),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['platform'] }); onDeleted(); },
  });
  const archive = useMutation({
    mutationFn: () => platformApi.update(d.tenant.id, { status: 'archived' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['platform'] }),
  });
  const c = d.counts;
  const activity = c.dtes + c.ventas + c.compras + c.asientos;
  if (d.tenant.id === 1) return <div className="banner banner-info">La empresa #1 (PAAJ) no se puede eliminar.</div>;
  return (
    <>
      <ErrorBanner error={run.error ?? archive.error} />
      {activity > 0 ? (
        <div className="banner banner-warning" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
          <div>Esta empresa tiene actividad ({c.dtes} DTEs, {c.ventas} ventas, {c.compras} compras, {c.asientos} asientos). Por ley sus registros fiscales y contables deben conservarse, así que no se elimina: se <strong>archiva</strong> y sus usuarios pierden el acceso.</div>
          {d.tenant.status !== 'archived'
            ? <Button onClick={() => archive.mutate()} disabled={archive.isPending}>Archivar empresa</Button>
            : <span>Ya está archivada.</span>}
        </div>
      ) : (
        <div className="tax-card" style={{ borderColor: 'var(--danger-border)' }}>
          <div className="tax-card-title" style={{ color: 'var(--danger-text)' }}>Eliminar definitivamente</div>
          <div className="muted" style={{ fontSize: 'var(--text-sm)', marginBottom: 10 }}>
            Se borran la empresa, sus usuarios, datos fiscales, catálogo, configuración y borradores. No se puede deshacer.
            Para confirmar escribe <code>{d.tenant.slug}</code> y tu contraseña.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 10, alignItems: 'flex-end' }}>
            <Field label="Identificador de la empresa"><Input value={slug} onChange={e => setSlug(e.target.value)} placeholder={d.tenant.slug} /></Field>
            <Field label="Tu contraseña"><Input type="password" value={password} onChange={e => setPassword(e.target.value)} /></Field>
            <Button variant="danger" onClick={() => run.mutate()} disabled={run.isPending || slug !== d.tenant.slug || !password}>Eliminar empresa</Button>
          </div>
        </div>
      )}
    </>
  );
}
