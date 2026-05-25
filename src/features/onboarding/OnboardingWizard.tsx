import { useState } from 'react';
import { api } from '@/lib/api/client';
import { useBranding } from '@/branding/BrandingProvider';
import { refreshSession } from '@/auth/useAuth';

/**
 * Wizard de onboarding — 4 pasos secuenciales:
 *   1. Empresa: nombre legal, comercial, NRC, actividad económica
 *   2. Ubicación: departamento/municipio/dirección
 *   3. MH: NIT, password Hacienda, password cert privado, upload .crt,
 *      códigos establecimiento/punto de venta
 *   4. Correlativos: último consecutivo histórico por tipo (FCF/CCF/NC/FSE)
 *      → puede ser 0 si nunca emitió.
 *
 * Al final llama `POST /v2/onboarding/complete` que crea el tenant + emisor
 * + correlativos sembrados en una transacción y marca el user con tenant_id.
 *
 * El endpoint del backend `/v2/onboarding/complete` queda como próximo paso
 * (turno 5 backend). Por ahora este wizard recolecta y valida los datos.
 */

type Step = 1 | 2 | 3 | 4;

interface FormData {
  // step 1
  nombre_legal: string;
  nombre_comercial: string;
  emisor_nrc: string;
  emisor_cod_actividad: string;
  emisor_desc_actividad: string;
  emisor_tipo_establecimiento: string;
  // step 2
  emisor_departamento: string;
  emisor_municipio: string;
  emisor_complemento: string;
  emisor_telefono: string;
  emisor_email: string;
  // step 3
  mh_nit: string;
  mh_password: string;
  firmador_password: string;
  cert_file: File | null;
  punto_venta_establecimiento: string;
  punto_venta_punto: string;
  emisor_cod_estable_mh: string;
  emisor_cod_punto_venta_mh: string;
  mh_env: 'sandbox' | 'production';
  // step 4
  ultimo_fcf: number;
  ultimo_ccf: number;
  ultimo_nc: number;
  ultimo_fse: number;
}

const emptyForm: FormData = {
  nombre_legal: '', nombre_comercial: '', emisor_nrc: '',
  emisor_cod_actividad: '', emisor_desc_actividad: '',
  emisor_tipo_establecimiento: '02',
  emisor_departamento: '', emisor_municipio: '',
  emisor_complemento: '', emisor_telefono: '', emisor_email: '',
  mh_nit: '', mh_password: '', firmador_password: '', cert_file: null,
  punto_venta_establecimiento: '', punto_venta_punto: '',
  emisor_cod_estable_mh: '', emisor_cod_punto_venta_mh: '',
  mh_env: 'sandbox',
  ultimo_fcf: 0, ultimo_ccf: 0, ultimo_nc: 0, ultimo_fse: 0,
};

export function OnboardingWizard() {
  const branding = useBranding();
  const [step, setStep] = useState<Step>(1);
  const [form, setForm] = useState<FormData>(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  function update<K extends keyof FormData>(k: K, v: FormData[K]) {
    setForm(f => ({ ...f, [k]: v }));
  }

  async function submit() {
    setSubmitting(true); setError(null);
    try {
      // 1) Subir el cert al backend (multipart) — el endpoint copia al
      //    filesystem del firmador como /uploads/<NIT>.crt
      if (form.cert_file) {
        const fd = new FormData();
        fd.append('cert', form.cert_file);
        fd.append('mh_nit', form.mh_nit);
        // (Endpoint POST /v2/onboarding/cert — pendiente turno 5 backend)
      }
      // 2) Completar onboarding (todo en una tx)
      await api.post('/v2/onboarding/complete', {
        tenant: {
          nombre_legal: form.nombre_legal,
          nombre_comercial: form.nombre_comercial || null,
          slug: slugify(form.nombre_comercial || form.nombre_legal),
        },
        emisor: {
          mh_env: form.mh_env,
          mh_nit: form.mh_nit,
          mh_password: form.mh_password,
          firmador_password: form.firmador_password,
          emisor_nrc: form.emisor_nrc,
          emisor_nombre: form.nombre_legal,
          emisor_cod_actividad: form.emisor_cod_actividad,
          emisor_desc_actividad: form.emisor_desc_actividad,
          emisor_tipo_establecimiento: form.emisor_tipo_establecimiento,
          emisor_departamento: form.emisor_departamento,
          emisor_municipio: form.emisor_municipio,
          emisor_complemento: form.emisor_complemento,
          emisor_telefono: form.emisor_telefono || null,
          emisor_email: form.emisor_email,
          punto_venta_establecimiento: form.punto_venta_establecimiento.toUpperCase(),
          punto_venta_punto: form.punto_venta_punto.toUpperCase(),
          emisor_cod_estable_mh: form.emisor_cod_estable_mh.toUpperCase() || null,
          emisor_cod_punto_venta_mh: form.emisor_cod_punto_venta_mh.toUpperCase() || null,
        },
        correlativos: [
          { tipo_dte: '01', ultimo_consumido: form.ultimo_fcf },
          { tipo_dte: '03', ultimo_consumido: form.ultimo_ccf },
          { tipo_dte: '05', ultimo_consumido: form.ultimo_nc },
          { tipo_dte: '14', ultimo_consumido: form.ultimo_fse },
        ],
      });
      // Pedir JWT nuevo con tenant_id seteado. Sin esto, el frontend
      // seguiría viendo "Onboarding pendiente" hasta logout/login.
      await refreshSession();
      setSuccess(true);
      setTimeout(() => { window.location.href = '/'; }, 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error inesperado');
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <Centered>
        <h1 style={{ color: '#065f46' }}>✓ Onboarding completado</h1>
        <p>Redirigiendo al dashboard…</p>
      </Centered>
    );
  }

  return (
    <Centered>
      <div style={cardStyle}>
        <h1 style={{ margin: 0, fontSize: 24, color: 'var(--brand-primary, #065f46)' }}>
          {branding.productName} — Onboarding
        </h1>
        <p style={{ marginTop: 4, color: '#6b7280', fontSize: 14 }}>Paso {step} de 4</p>

        <StepIndicator current={step} total={4} />

        {step === 1 && <Step1Empresa form={form} update={update} />}
        {step === 2 && <Step2Ubicacion form={form} update={update} />}
        {step === 3 && <Step3MH form={form} update={update} />}
        {step === 4 && <Step4Correlativos form={form} update={update} />}

        {error && <div style={errorStyle}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
          <button
            onClick={() => setStep(s => (s > 1 ? (s - 1) as Step : s))}
            disabled={step === 1 || submitting}
            style={secondaryButtonStyle}
          >
            Atrás
          </button>
          {step < 4 ? (
            <button onClick={() => setStep(s => (s + 1) as Step)} style={primaryButtonStyle}>Siguiente</button>
          ) : (
            <button onClick={submit} disabled={submitting} style={primaryButtonStyle}>
              {submitting ? 'Procesando…' : 'Completar onboarding'}
            </button>
          )}
        </div>
      </div>
    </Centered>
  );
}

// ── Steps ────────────────────────────────────────────────────────────────────

interface StepProps {
  form: FormData;
  update: <K extends keyof FormData>(k: K, v: FormData[K]) => void;
}

function Step1Empresa({ form, update }: StepProps) {
  return (
    <FormGrid>
      <Field label="Nombre legal (razón social)" required>
        <input style={inputStyle} value={form.nombre_legal} onChange={e => update('nombre_legal', e.target.value)} />
      </Field>
      <Field label="Nombre comercial">
        <input style={inputStyle} value={form.nombre_comercial} onChange={e => update('nombre_comercial', e.target.value)} placeholder="Ej. BEON Nutrition" />
      </Field>
      <Field label="NRC" required>
        <input style={inputStyle} value={form.emisor_nrc} onChange={e => update('emisor_nrc', e.target.value)} />
      </Field>
      <Field label="Código actividad (CAT-019)" required>
        <input style={inputStyle} value={form.emisor_cod_actividad} onChange={e => update('emisor_cod_actividad', e.target.value)} placeholder="47711" />
      </Field>
      <Field label="Descripción actividad" required colSpan={2}>
        <input style={inputStyle} value={form.emisor_desc_actividad} onChange={e => update('emisor_desc_actividad', e.target.value)} />
      </Field>
      <Field label="Tipo establecimiento (CAT-009)" required>
        <select style={inputStyle} value={form.emisor_tipo_establecimiento} onChange={e => update('emisor_tipo_establecimiento', e.target.value)}>
          <option value="02">Casa Matriz</option>
          <option value="04">Sucursal</option>
          <option value="07">Oficina</option>
        </select>
      </Field>
    </FormGrid>
  );
}

function Step2Ubicacion({ form, update }: StepProps) {
  return (
    <FormGrid>
      <Field label="Departamento (CAT-012)" required>
        <input style={inputStyle} value={form.emisor_departamento} onChange={e => update('emisor_departamento', e.target.value)} placeholder="06 = San Salvador" />
      </Field>
      <Field label="Municipio (CAT-013)" required>
        <input style={inputStyle} value={form.emisor_municipio} onChange={e => update('emisor_municipio', e.target.value)} placeholder="14" />
      </Field>
      <Field label="Dirección completa" required colSpan={2}>
        <input style={inputStyle} value={form.emisor_complemento} onChange={e => update('emisor_complemento', e.target.value)} placeholder="Av. La Capilla 318" />
      </Field>
      <Field label="Teléfono">
        <input style={inputStyle} value={form.emisor_telefono} onChange={e => update('emisor_telefono', e.target.value)} />
      </Field>
      <Field label="Email" required>
        <input style={inputStyle} type="email" value={form.emisor_email} onChange={e => update('emisor_email', e.target.value)} />
      </Field>
    </FormGrid>
  );
}

function Step3MH({ form, update }: StepProps) {
  return (
    <FormGrid>
      <Field label="Ambiente MH" required>
        <select style={inputStyle} value={form.mh_env} onChange={e => update('mh_env', e.target.value as 'sandbox' | 'production')}>
          <option value="sandbox">Sandbox (pruebas)</option>
          <option value="production">Producción</option>
        </select>
      </Field>
      <Field label="NIT (14 dígitos, sin guiones)" required>
        <input style={inputStyle} value={form.mh_nit} onChange={e => update('mh_nit', e.target.value.replace(/\D/g, '').slice(0, 14))} maxLength={14} />
      </Field>
      <Field label="Password Hacienda (clave API MH)" required>
        <input style={inputStyle} type="password" value={form.mh_password} onChange={e => update('mh_password', e.target.value)} />
      </Field>
      <Field label="Password del certificado (privada)" required>
        <input style={inputStyle} type="password" value={form.firmador_password} onChange={e => update('firmador_password', e.target.value)} />
      </Field>
      <Field label="Certificado .crt (MH)" required colSpan={2}>
        <input type="file" accept=".crt" onChange={e => update('cert_file', e.target.files?.[0] ?? null)} />
      </Field>
      <Field label="Cód. Establecimiento MH (asignado por portal)" required>
        <input style={inputStyle} value={form.emisor_cod_estable_mh} onChange={e => update('emisor_cod_estable_mh', e.target.value.toUpperCase().slice(0, 4))} placeholder="M001" maxLength={4} />
      </Field>
      <Field label="Cód. Punto Venta MH" required>
        <input style={inputStyle} value={form.emisor_cod_punto_venta_mh} onChange={e => update('emisor_cod_punto_venta_mh', e.target.value.toUpperCase().slice(0, 4))} placeholder="P000" maxLength={4} />
      </Field>
      <Field label="Tu cód. Establecimiento (uso interno)" required>
        <input style={inputStyle} value={form.punto_venta_establecimiento} onChange={e => update('punto_venta_establecimiento', e.target.value.toUpperCase().slice(0, 4))} placeholder="M001" maxLength={4} />
      </Field>
      <Field label="Tu cód. Punto Venta (uso interno)" required>
        <input style={inputStyle} value={form.punto_venta_punto} onChange={e => update('punto_venta_punto', e.target.value.toUpperCase().slice(0, 4))} placeholder="P000" maxLength={4} />
      </Field>
    </FormGrid>
  );
}

function Step4Correlativos({ form, update }: StepProps) {
  return (
    <div>
      <p style={{ color: '#6b7280', marginTop: 0, fontSize: 14 }}>
        Si ya emitiste DTEs antes, ingresá el último consecutivo de cada tipo.
        Si nunca emitiste, dejá en 0 — el primero usará 1.
      </p>
      <FormGrid>
        <Field label="Último FCF (Factura Consumidor) emitido">
          <input style={inputStyle} type="number" min={0} value={form.ultimo_fcf} onChange={e => update('ultimo_fcf', parseInt(e.target.value) || 0)} />
        </Field>
        <Field label="Último CCF (Crédito Fiscal) emitido">
          <input style={inputStyle} type="number" min={0} value={form.ultimo_ccf} onChange={e => update('ultimo_ccf', parseInt(e.target.value) || 0)} />
        </Field>
        <Field label="Última NC emitida">
          <input style={inputStyle} type="number" min={0} value={form.ultimo_nc} onChange={e => update('ultimo_nc', parseInt(e.target.value) || 0)} />
        </Field>
        <Field label="Último FSE emitido">
          <input style={inputStyle} type="number" min={0} value={form.ultimo_fse} onChange={e => update('ultimo_fse', parseInt(e.target.value) || 0)} />
        </Field>
      </FormGrid>
    </div>
  );
}

// ── UI bits ──────────────────────────────────────────────────────────────────

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div style={{ display: 'flex', gap: 6, margin: '20px 0' }}>
      {Array.from({ length: total }, (_, i) => i + 1).map(n => (
        <div key={n} style={{
          flex: 1, height: 4, borderRadius: 2,
          background: n <= current ? 'var(--brand-primary, #10b981)' : '#e5e7eb',
        }} />
      ))}
    </div>
  );
}

function Field({ label, required, colSpan, children }: {
  label: string; required?: boolean; colSpan?: number; children: React.ReactNode;
}) {
  return (
    <label style={{
      display: 'flex', flexDirection: 'column', gap: 4,
      gridColumn: colSpan ? `span ${colSpan}` : undefined,
    }}>
      <span style={{ fontSize: 12, color: '#374151', fontWeight: 500 }}>
        {label}{required && <span style={{ color: '#dc2626' }}> *</span>}
      </span>
      {children}
    </label>
  );
}

function FormGrid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 16 }}>{children}</div>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100vh', background: '#f9fafb', display: 'flex',
      alignItems: 'flex-start', justifyContent: 'center', padding: '40px 20px',
    }}>{children}</div>
  );
}

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'empresa';
}

const cardStyle: React.CSSProperties = {
  background: 'white', borderRadius: 12, padding: 32, width: '100%', maxWidth: 720,
  boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
};
const inputStyle: React.CSSProperties = {
  padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6,
  fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box',
};
const primaryButtonStyle: React.CSSProperties = {
  padding: '10px 24px', background: 'var(--brand-primary, #10b981)', color: 'white',
  border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer',
};
const secondaryButtonStyle: React.CSSProperties = {
  padding: '10px 24px', background: 'white', color: '#374151',
  border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer',
};
const errorStyle: React.CSSProperties = {
  marginTop: 16, padding: 12, background: '#fef2f2', border: '1px solid #fecaca',
  color: '#991b1b', borderRadius: 6, fontSize: 13,
};
