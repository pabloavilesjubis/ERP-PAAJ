import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { v2, type AdminTenant } from '@/lib/api/client';
import { usePlatformAdmin } from '@/admin/usePlatformAdmin';

type Form = Record<string, string>;

const EMPTY: Form = {
  slug: '', nombre_legal: '', nombre_comercial: '',
  admin_email: '', admin_password: '', admin_full_name: '',
  mh_env: 'production', mh_nit: '', mh_password: '', firmador_password: '',
  emisor_nrc: '', emisor_nombre: '', emisor_cod_actividad: '', emisor_desc_actividad: '',
  emisor_tipo_establecimiento: '', emisor_departamento: '', emisor_municipio: '',
  emisor_complemento: '', emisor_telefono: '', emisor_email: '',
  punto_venta_establecimiento: '', punto_venta_punto: '',
  emisor_cod_estable_mh: '', emisor_cod_punto_venta_mh: '',
  corr_01: '0', corr_03: '0', corr_05: '0', corr_14: '0',
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res((r.result as string).split(',')[1] ?? '');
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

export function AdminTenantsPage() {
  const isAdmin = usePlatformAdmin();
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);
  const [cert, setCert] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const certRef = useRef<HTMLInputElement>(null);

  const f = (k: keyof Form) => ({
    value: form[k] ?? '',
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm(p => ({ ...p, [k]: e.target.value })),
  });

  async function load() {
    setLoading(true);
    try {
      const res = await v2.admin.listTenants();
      setTenants(res.items);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'No se pudo cargar la lista.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (isAdmin) void load(); }, [isAdmin]);

  async function setStatus(t: AdminTenant, status: string) {
    try {
      await v2.admin.setStatus(Number(t.id), status);
      void load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'No se pudo cambiar el estado.');
    }
  }

  async function create() {
    setSaving(true); setErr(null); setMsg(null);
    try {
      if (cert && form.mh_nit) {
        const b64 = await fileToBase64(cert);
        await v2.admin.uploadCert(form.mh_nit, b64);
      }
      const res = await v2.admin.createTenant({
        tenant: { slug: form.slug.trim(), nombre_legal: form.nombre_legal.trim(), nombre_comercial: form.nombre_comercial.trim() || null },
        admin: { email: form.admin_email.trim(), password: form.admin_password, full_name: form.admin_full_name.trim() || null },
        emisor: {
          mh_env: form.mh_env, mh_nit: form.mh_nit.trim(), mh_password: form.mh_password, firmador_password: form.firmador_password,
          emisor_nrc: form.emisor_nrc.trim(), emisor_nombre: form.emisor_nombre.trim(),
          emisor_cod_actividad: form.emisor_cod_actividad.trim(), emisor_desc_actividad: form.emisor_desc_actividad.trim(),
          emisor_tipo_establecimiento: form.emisor_tipo_establecimiento.trim(), emisor_departamento: form.emisor_departamento.trim(),
          emisor_municipio: form.emisor_municipio.trim(), emisor_complemento: form.emisor_complemento.trim(),
          emisor_telefono: form.emisor_telefono.trim() || null, emisor_email: form.emisor_email.trim(),
          punto_venta_establecimiento: form.punto_venta_establecimiento.trim(), punto_venta_punto: form.punto_venta_punto.trim(),
          emisor_cod_estable_mh: form.emisor_cod_estable_mh.trim() || null, emisor_cod_punto_venta_mh: form.emisor_cod_punto_venta_mh.trim() || null,
        },
        correlativos: [
          { tipo_dte: '01', ultimo_consumido: parseInt(form.corr_01, 10) || 0 },
          { tipo_dte: '03', ultimo_consumido: parseInt(form.corr_03, 10) || 0 },
          { tipo_dte: '05', ultimo_consumido: parseInt(form.corr_05, 10) || 0 },
          { tipo_dte: '14', ultimo_consumido: parseInt(form.corr_14, 10) || 0 },
        ],
      });
      setMsg(`✓ Tenant "${res.slug}" creado. Login admin: ${res.admin_email}`);
      setForm(EMPTY); setCert(null); if (certRef.current) certRef.current.value = '';
      setShowForm(false);
      void load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'No se pudo crear el tenant.');
    } finally {
      setSaving(false);
    }
  }

  if (!isAdmin) {
    return <EmptyState title="Acceso restringido" description="Esta sección es solo para super-admins de plataforma." />;
  }

  const card = { background: 'var(--surface-1)', border: '1px solid var(--border-1, #e5e7eb)', borderRadius: 12, padding: 20 } as const;
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 } as const;

  return (
    <div>
      <SectionHeader
        title="Tenants"
        description="Crear y controlar las empresas del SaaS."
        actions={<Button onClick={() => setShowForm(s => !s)}>{showForm ? 'Cerrar' : '+ Nuevo tenant'}</Button>}
      />

      {err && <div style={{ color: 'var(--danger-text)', marginBottom: 12 }}>{err}</div>}
      {msg && <div style={{ color: 'var(--brand-primary, #10b981)', marginBottom: 12 }}>{msg}</div>}

      {showForm && (
        <div style={{ ...card, marginBottom: 20, display: 'flex', flexDirection: 'column', gap: 18 }}>
          <strong>Empresa</strong>
          <div style={grid}>
            <Field label="Slug (URL, ej: acme)"><Input {...f('slug')} placeholder="acme" /></Field>
            <Field label="Nombre legal"><Input {...f('nombre_legal')} placeholder="ACME S.A. DE C.V." /></Field>
            <Field label="Nombre comercial"><Input {...f('nombre_comercial')} placeholder="ACME" /></Field>
          </div>

          <strong>Usuario admin de la empresa (login)</strong>
          <div style={grid}>
            <Field label="Email"><Input {...f('admin_email')} type="email" placeholder="admin@acme.com" /></Field>
            <Field label="Contraseña (mín 8)"><Input {...f('admin_password')} type="password" /></Field>
            <Field label="Nombre completo"><Input {...f('admin_full_name')} /></Field>
          </div>

          <strong>Datos fiscales del emisor (MH)</strong>
          <div style={grid}>
            <Field label="Ambiente MH">
              <Select {...f('mh_env')}>
                <option value="production">production</option>
                <option value="sandbox">sandbox</option>
              </Select>
            </Field>
            <Field label="NIT (14 dígitos)"><Input {...f('mh_nit')} placeholder="06140000000000" /></Field>
            <Field label="Clave API del MH"><Input {...f('mh_password')} type="password" /></Field>
            <Field label="Clave del firmador (.crt)"><Input {...f('firmador_password')} type="password" /></Field>
            <Field label="NRC"><Input {...f('emisor_nrc')} /></Field>
            <Field label="Nombre del emisor"><Input {...f('emisor_nombre')} /></Field>
            <Field label="Cód. actividad (CAT-019)"><Input {...f('emisor_cod_actividad')} /></Field>
            <Field label="Desc. actividad"><Input {...f('emisor_desc_actividad')} /></Field>
            <Field label="Tipo establecimiento (2 díg, ej 02)"><Input {...f('emisor_tipo_establecimiento')} placeholder="02" /></Field>
            <Field label="Departamento (2 díg, ej 06)"><Input {...f('emisor_departamento')} placeholder="06" /></Field>
            <Field label="Municipio (2 díg, ej 14)"><Input {...f('emisor_municipio')} placeholder="14" /></Field>
            <Field label="Complemento (dirección)"><Input {...f('emisor_complemento')} /></Field>
            <Field label="Teléfono"><Input {...f('emisor_telefono')} /></Field>
            <Field label="Email del emisor"><Input {...f('emisor_email')} type="email" /></Field>
            <Field label="Punto venta - establecimiento (4)"><Input {...f('punto_venta_establecimiento')} placeholder="M001" /></Field>
            <Field label="Punto venta - punto (4)"><Input {...f('punto_venta_punto')} placeholder="P001" /></Field>
            <Field label="Cód. estable MH (4, opc)"><Input {...f('emisor_cod_estable_mh')} placeholder="M001" /></Field>
            <Field label="Cód. punto venta MH (4, opc)"><Input {...f('emisor_cod_punto_venta_mh')} placeholder="P001" /></Field>
          </div>

          <div>
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, display: 'block', marginBottom: 6 }}>Certificado .crt del MH</span>
            <input ref={certRef} type="file" accept=".crt" onChange={e => setCert(e.target.files?.[0] ?? null)} />
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-4)', marginTop: 4 }}>Se sube al firmador por NIT. Sin el cert la empresa no puede emitir.</div>
          </div>

          <strong>Correlativos iniciales (último consecutivo ya emitido en MH)</strong>
          <div style={grid}>
            <Field label="FCF (01)"><Input {...f('corr_01')} type="number" /></Field>
            <Field label="CCF (03)"><Input {...f('corr_03')} type="number" /></Field>
            <Field label="NC (05)"><Input {...f('corr_05')} type="number" /></Field>
            <Field label="FSE (14)"><Input {...f('corr_14')} type="number" /></Field>
          </div>

          <div>
            <Button onClick={create} disabled={saving}>{saving ? 'Creando…' : 'Crear tenant'}</Button>
          </div>
        </div>
      )}

      <div style={card}>
        <table>
          <thead>
            <tr>
              <th>ID</th><th>Slug</th><th>Nombre</th><th>Estado</th>
              <th className="num">Users</th><th>Emisor</th><th style={{ width: 200 }} />
            </tr>
          </thead>
          <tbody>
            {tenants.length === 0 && (
              <tr><td colSpan={7}>{loading ? 'Cargando…' : 'Sin tenants.'}</td></tr>
            )}
            {tenants.map(t => (
              <tr key={t.id}>
                <td className="muted">{t.id}</td>
                <td><code style={{ fontFamily: 'var(--font-mono)' }}>{t.slug}</code></td>
                <td>{t.nombre_comercial || t.nombre_legal}</td>
                <td>
                  <span style={{ color: t.status === 'active' ? 'var(--brand-primary, #10b981)' : 'var(--danger-text)' }}>
                    {t.status}
                  </span>
                </td>
                <td className="num">{t.users}</td>
                <td>{t.has_emisor ? '✓' : <span style={{ color: 'var(--danger-text)' }}>falta</span>}</td>
                <td>
                  {Number(t.id) !== 1 && (
                    t.status === 'active'
                      ? <Button variant="secondary" onClick={() => setStatus(t, 'suspended')}>Suspender</Button>
                      : <Button variant="secondary" onClick={() => setStatus(t, 'active')}>Activar</Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
