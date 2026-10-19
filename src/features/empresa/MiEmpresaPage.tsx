import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Badge } from '@/components/ui/Badge';
import { Tabs } from '@/components/ui/Tabs';
import { ErrorBanner, Loading } from '@/components/ui/Feedback';
import { usePermissions } from '@/auth/usePermissions';
import type { Emisor } from '@/features/admin/api';
import { cleanEmisor, EMPTY_EMISOR, EmisorFields, fileToBase64 } from './EmisorFields';

interface Company {
  tenant: { id: number; slug: string; nombre_legal: string; nombre_comercial: string | null; status: string };
  emisor: (Emisor & { has_mh_password: boolean; has_firmador_password: boolean; updated_at: string }) | null;
  cert: { present: boolean };
  correlativos: Array<{ tipo_dte: string; seeded: boolean; ultimo_consumido: number }>;
  checklist: { general: boolean; fiscal: boolean; credentials: boolean; cert: boolean; correlativos: boolean };
}

type Tab = 'general' | 'fiscal' | 'facturacion';

const TIPOS = [
  { tipo: '01', label: 'Factura consumidor final (01)' }, { tipo: '03', label: 'Comprobante de crédito fiscal (03)' },
  { tipo: '05', label: 'Nota de crédito (05)' }, { tipo: '14', label: 'Factura de sujeto excluido (14)' },
] as const;

const useCompany = () => useQuery({ queryKey: ['company'], queryFn: () => api.get<Company>('/v2/company') });

/**
 * Mi empresa: el administrador de cada empresa carga sus datos generales, los
 * datos fiscales del emisor y lo necesario para facturar electrónicamente
 * (credenciales del MH, certificado de firma y correlativos).
 */
export function MiEmpresaPage() {
  const q = useCompany();
  const [tab, setTab] = useState<Tab>('general');
  const c = q.data;
  return (
    <div>
      <SectionHeader title="Mi empresa" description="Datos generales, datos fiscales y configuración de la facturación electrónica de tu empresa." />
      <ErrorBanner error={q.error} />
      {q.isLoading || !c ? (q.isLoading ? <Loading /> : null) : <>
        <Checklist c={c} onGo={setTab} />
        <Tabs value={tab} onChange={setTab} tabs={[
          { value: 'general', label: 'Empresa' }, { value: 'fiscal', label: 'Datos fiscales' }, { value: 'facturacion', label: 'Facturación electrónica' },
        ]} />
        <div style={{ marginTop: 'var(--s-5)' }}>
          {tab === 'general' && <GeneralTab c={c} />}
          {tab === 'fiscal' && <FiscalTab c={c} />}
          {tab === 'facturacion' && <FacturacionTab c={c} />}
        </div>
      </>}
    </div>
  );
}

function Checklist({ c, onGo }: { c: Company; onGo: (t: Tab) => void }) {
  const items: Array<{ ok: boolean; label: string; tab: Tab }> = [
    { ok: c.checklist.general, label: 'Nombre de la empresa', tab: 'general' },
    { ok: c.checklist.fiscal, label: 'Datos fiscales (NIT, NRC, actividad, dirección)', tab: 'fiscal' },
    { ok: c.checklist.credentials, label: 'Clave API del MH y clave del certificado', tab: 'fiscal' },
    { ok: c.checklist.cert, label: 'Certificado de firma (.crt)', tab: 'facturacion' },
    { ok: c.checklist.correlativos, label: 'Correlativos de DTE', tab: 'facturacion' },
  ];
  const done = items.filter(i => i.ok).length;
  return (
    <div className="tax-card" style={{ marginBottom: 'var(--s-5)' }}>
      <div className="tax-card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--s-3)' }}>
        <span>Estado de la configuración</span>
        {done === items.length ? <Badge tone="success">Lista para facturar</Badge> : <Badge tone="warning">{done} de {items.length} pasos</Badge>}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', fontSize: 'var(--text-sm)' }}>
        {items.map(i => (
          <button key={i.label} type="button" onClick={() => onGo(i.tab)}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit',
              color: i.ok ? 'var(--success-text)' : 'var(--fg-2)' }}>
            {i.ok ? '✓' : '○'} {i.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function GeneralTab({ c }: { c: Company }) {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const [g, setG] = useState({ nombre_legal: c.tenant.nombre_legal, nombre_comercial: c.tenant.nombre_comercial ?? '' });
  const save = useMutation({
    mutationFn: () => api.put('/v2/company', { nombre_legal: g.nombre_legal.trim(), nombre_comercial: g.nombre_comercial.trim() || null }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['company'] }),
  });
  const readOnly = !can('company:manage');
  return (
    <div style={{ maxWidth: 720 }}>
      <ErrorBanner error={save.error} />
      {save.isSuccess && <div className="banner banner-success">Datos guardados.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="Nombre legal"><Input value={g.nombre_legal} disabled={readOnly} onChange={e => setG({ ...g, nombre_legal: e.target.value })} /></Field>
        <Field label="Nombre comercial"><Input value={g.nombre_comercial} disabled={readOnly} onChange={e => setG({ ...g, nombre_comercial: e.target.value })} /></Field>
        <Field label="Identificador en el sistema"><Input value={c.tenant.slug} disabled /></Field>
      </div>
      <div className="toolbar" style={{ marginTop: 10 }}>
        {!readOnly && <Button onClick={() => save.mutate()} disabled={save.isPending || g.nombre_legal.trim().length < 2}>Guardar</Button>}
        <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>El logo y el título del menú se cambian en <Link to="/configuracion">Configuración</Link>.</span>
      </div>
    </div>
  );
}

function FiscalTab({ c }: { c: Company }) {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const fromServer = () => c.emisor
    ? { ...EMPTY_EMISOR, ...c.emisor, mh_password: '', firmador_password: '' }
    : { ...EMPTY_EMISOR, emisor_nombre: c.tenant.nombre_legal };
  const [e, setE] = useState<Emisor>(fromServer);
  useEffect(() => { setE(fromServer()); }, [c.emisor]);
  const save = useMutation({
    mutationFn: () => api.put<{ result: 'created' | 'updated' }>('/v2/company/emisor', cleanEmisor(e)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['company'] }),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string }>('/v2/company/test-mh',
      { mh_env: e.mh_env, mh_nit: e.mh_nit.replace(/\D/g, ''), mh_password: e.mh_password || undefined }),
  });
  if (!can('company:manage')) return <ReadOnlyFiscal c={c} />;
  const first = !c.emisor;
  return (
    <>
      <ErrorBanner error={save.error ?? test.error} />
      {save.isSuccess && <div className="banner banner-success">Datos fiscales guardados.</div>}
      {first && <div className="banner banner-info" style={{ marginBottom: 10 }}>
        Estos datos salen en cada DTE que emitas. La clave API se genera en el portal de facturación electrónica del MH y la clave del
        certificado es la que definiste al descargarlo. Se guardan cifradas y nunca se muestran.
      </div>}
      <EmisorFields e={e} setE={setE} requirePasswords={first} />
      <div className="toolbar" style={{ marginTop: 10 }}>
        <Button onClick={() => save.mutate()} disabled={save.isPending || !e.mh_nit}>Guardar datos fiscales</Button>
        <Button variant="secondary" onClick={() => test.mutate()} disabled={test.isPending || (!e.mh_password && !c.emisor?.has_mh_password)}>
          {test.isPending ? 'Probando…' : 'Probar conexión con el MH'}
        </Button>
        {test.data && (test.data.ok
          ? <span style={{ color: 'var(--success-text)' }}>✓ El MH aceptó el NIT y la clave API</span>
          : <span style={{ color: 'var(--danger-text)' }}>{test.data.error}</span>)}
      </div>
    </>
  );
}

function ReadOnlyFiscal({ c }: { c: Company }) {
  if (!c.emisor) return <div className="banner banner-warning">La empresa aún no tiene datos fiscales. Los carga el administrador.</div>;
  const e = c.emisor;
  const rows: Array<[string, string | null]> = [
    ['Nombre', e.emisor_nombre], ['NIT', e.mh_nit], ['NRC', e.emisor_nrc], ['Actividad', `${e.emisor_cod_actividad} · ${e.emisor_desc_actividad}`],
    ['Dirección', `${e.emisor_complemento} (depto. ${e.emisor_departamento}, municipio ${e.emisor_municipio})`],
    ['Teléfono', e.emisor_telefono], ['Email', e.emisor_email], ['Ambiente MH', e.mh_env === 'production' ? 'Producción' : 'Pruebas'],
    ['Establecimiento / punto de venta', `${e.punto_venta_establecimiento} / ${e.punto_venta_punto}`],
  ];
  return (
    <div className="table-wrap" style={{ maxWidth: 720 }}>
      <table className="acc-table"><tbody>{rows.map(([k, v]) => <tr key={k}><td className="muted" style={{ width: 240 }}>{k}</td><td>{v || '—'}</td></tr>)}</tbody></table>
    </div>
  );
}

function FacturacionTab({ c }: { c: Company }) {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const manage = can('company:manage');
  const [corr, setCorr] = useState<Record<string, string>>(() =>
    Object.fromEntries(TIPOS.map(t => [t.tipo, String(c.correlativos.find(x => x.tipo_dte === t.tipo)?.ultimo_consumido ?? 0)])));
  const cert = useMutation({
    mutationFn: async (file: File) => api.post('/v2/company/cert', { cert_base64: await fileToBase64(file) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['company'] }),
  });
  const seed = useMutation({
    mutationFn: () => api.post('/v2/company/correlativos', {
      items: TIPOS.map(t => ({ tipo_dte: t.tipo, ultimo_consumido: Math.max(0, parseInt(corr[t.tipo] ?? '0', 10) || 0) })),
    }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['company'] }),
  });
  return (
    <div style={{ display: 'grid', gap: 'var(--s-5)', maxWidth: 820 }}>
      <div className="tax-card">
        <div className="tax-card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Certificado de firma electrónica</span>
          {c.cert.present ? <Badge tone="success">Cargado</Badge> : <Badge tone="warning">Pendiente</Badge>}
        </div>
        <p className="muted" style={{ fontSize: 'var(--text-sm)', marginTop: 0 }}>
          Es el archivo <code>.crt</code> que descargas del portal del MH para tu NIT. Con él se firma cada DTE.
        </p>
        <ErrorBanner error={cert.error} />
        {cert.isSuccess && <div className="banner banner-success">Certificado guardado.</div>}
        {!c.emisor ? <div className="banner banner-info">Guarda primero los datos fiscales: el certificado se asocia al NIT.</div> : manage && (
          <label className="btn btn-secondary" style={{ cursor: 'pointer' }}>
            {cert.isPending ? 'Subiendo…' : c.cert.present ? 'Reemplazar certificado' : 'Subir certificado .crt'}
            <input type="file" accept=".crt" hidden onChange={ev => { const f = ev.target.files?.[0]; ev.target.value = ''; if (f) cert.mutate(f); }} />
          </label>
        )}
      </div>

      <div className="tax-card">
        <div className="tax-card-title">Correlativos de DTE</div>
        <p className="muted" style={{ fontSize: 'var(--text-sm)', marginTop: 0 }}>
          Indica el último número de control ya emitido de cada tipo (0 si empiezas de cero). El sistema continúa desde el siguiente;
          nunca retrocede para no repetir números.
        </p>
        <ErrorBanner error={seed.error} />
        {seed.isSuccess && <div className="banner banner-success">Correlativos guardados.</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
          {TIPOS.map(t => {
            const cur = c.correlativos.find(x => x.tipo_dte === t.tipo);
            return (
              <Field key={t.tipo} label={t.label}>
                <Input type="number" min={0} value={corr[t.tipo]} disabled={!manage} onChange={ev => setCorr({ ...corr, [t.tipo]: ev.target.value })} />
                <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>{cur?.seeded ? `Actual: ${cur.ultimo_consumido}` : 'Sin configurar'}</span>
              </Field>
            );
          })}
        </div>
        {manage && <div className="toolbar" style={{ marginTop: 10 }}><Button onClick={() => seed.mutate()} disabled={seed.isPending}>Guardar correlativos</Button></div>}
      </div>
    </div>
  );
}
