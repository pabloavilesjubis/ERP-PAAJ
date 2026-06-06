import { useRef, useState, type ChangeEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { v2 } from '@/lib/api/client';
import { useBranding, useSetBranding } from '@/branding/BrandingProvider';

// El logo se guarda como data URL dentro de brand_config (JSONB), así que lo
// mantenemos chico para no inflar cada respuesta de /v2/me/full.
const MAX_LOGO_BYTES = 250_000;

/**
 * Configuración del tenant: branding del espacio (lo que se ve arriba del
 * menú lateral). El tenant puede escribir un título y/o subir un logo.
 */
export function ConfiguracionPage() {
  const branding = useBranding();
  const setBranding = useSetBranding();

  const [title, setTitle] = useState(branding.productName);
  const [logoUrl, setLogoUrl] = useState<string | null>(branding.logoUrl);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function onPickLogo(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr(null);
    if (!file.type.startsWith('image/')) {
      setErr('El archivo debe ser una imagen (PNG, JPG o SVG).');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setErr(`El logo pesa ${Math.round(file.size / 1024)} KB. Máximo 250 KB — subí una versión más liviana.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogoUrl(reader.result as string);
    reader.readAsDataURL(file);
  }

  function clearLogo() {
    setLogoUrl(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function save() {
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await v2.updateBrand({ title: title.trim() || null, logo_url: logoUrl || null });
      const bc = res.brand_config ?? {};
      setBranding({
        productName: (bc.title as string) || branding.legalName || 'PIPELINE ERP',
        logoUrl: (bc.logo_url as string) ?? null,
      });
      setMsg('✓ Branding guardado. Ya se aplicó al menú lateral.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'No se pudo guardar el branding.');
    } finally {
      setSaving(false);
    }
  }

  const labelStyle = { fontSize: 'var(--text-sm)', fontWeight: 500, marginBottom: 6, display: 'block' } as const;

  return (
    <div>
      <SectionHeader
        title="Configuración"
        description="Personalizá el branding de tu espacio: el título y el logo que aparecen arriba del menú lateral."
      />

      <div
        style={{
          maxWidth: 560,
          background: 'var(--surface-1)',
          border: '1px solid var(--border-1, #e5e7eb)',
          borderRadius: 12,
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 22,
        }}
      >
        <Field label="Título del sidebar">
          <Input
            type="text"
            placeholder="Ej: BEON NUTRITION WELLNESS"
            value={title}
            onChange={e => setTitle(e.target.value)}
          />
        </Field>

        <div>
          <span style={labelStyle}>Logo</span>
          {logoUrl ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
              <img
                src={logoUrl}
                alt="logo"
                style={{ maxHeight: 48, maxWidth: 200, background: 'var(--surface-2)', borderRadius: 6, padding: 4 }}
              />
              <Button variant="secondary" type="button" onClick={clearLogo}>Quitar logo</Button>
            </div>
          ) : (
            <div style={{ color: 'var(--fg-4)', fontSize: 'var(--text-sm)', marginBottom: 10 }}>
              Sin logo — se muestra el título de texto.
            </div>
          )}
          <input ref={fileRef} type="file" accept="image/*" onChange={onPickLogo} />
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-4)', marginTop: 6 }}>
            PNG / JPG / SVG, máximo 250 KB. Si cargás un logo, reemplaza al título de texto en el menú.
          </div>
        </div>

        {err && <div style={{ color: 'var(--danger-text)', fontSize: 'var(--text-sm)' }}>{err}</div>}
        {msg && <div style={{ color: 'var(--brand-primary, #10b981)', fontSize: 'var(--text-sm)' }}>{msg}</div>}

        <div>
          <Button onClick={save} disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar branding'}
          </Button>
        </div>
      </div>
    </div>
  );
}
