import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '@/auth/useAuth';
import { api } from '@/lib/api/client';

/**
 * Provee branding del tenant activo. Lee `tenant.brand_config` desde el
 * endpoint /v2/me al login y aplica:
 *   - `--brand-primary`, `--brand-accent` como CSS vars
 *   - logo_url al elemento <Logo />
 *   - nombre_comercial en el header / title
 *
 * Default = PIPELINE ERP. Cuando un tenant carga, sobreescribe los defaults.
 */

export interface Branding {
  /** Nombre visible — viene de tenants.nombre_comercial o defaultea a 'PIPELINE ERP'. */
  productName: string;
  /** Nombre legal del tenant (para footer, tickets). */
  legalName: string | null;
  logoUrl: string | null;
  colorPrimary: string;
  colorAccent: string;
  footerText: string | null;
}

const DEFAULT_BRANDING: Branding = {
  productName: 'PIPELINE ERP',
  legalName: null,
  logoUrl: null,
  colorPrimary: '#10b981',
  colorAccent: '#059669',
  footerText: null,
};

const BrandingCtx = createContext<{
  branding: Branding;
  setBranding: (b: Partial<Branding>) => void;
}>({
  branding: DEFAULT_BRANDING,
  setBranding: () => {},
});

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [branding, setBrandingState] = useState<Branding>(DEFAULT_BRANDING);
  const auth = useAuth();

  // Auto-load del branding del tenant cuando hay sesión válida.
  useEffect(() => {
    if (!auth.tenantId || !auth.accessToken) {
      setBrandingState(DEFAULT_BRANDING);
      return;
    }
    let cancelled = false;
    void api.get<{
      tenant: { nombre_legal: string; nombre_comercial: string | null; brand_config: Record<string, unknown> } | null;
    }>('/v2/me/full').then(res => {
      if (cancelled || !res.tenant) return;
      const bc = res.tenant.brand_config ?? {};
      setBrandingState({
        // `title` (editable en Configuración) gana; sino el nombre comercial del tenant.
        productName: (bc.title as string) || res.tenant.nombre_comercial || res.tenant.nombre_legal || DEFAULT_BRANDING.productName,
        legalName: res.tenant.nombre_legal,
        logoUrl: (bc.logo_url as string) ?? null,
        colorPrimary: (bc.color_primary as string) ?? DEFAULT_BRANDING.colorPrimary,
        colorAccent: (bc.color_accent as string) ?? DEFAULT_BRANDING.colorAccent,
        footerText: (bc.footer_text as string) ?? null,
      });
    }).catch(() => { /* falla silenciosa — quedamos con default */ });
    return () => { cancelled = true; };
  }, [auth.tenantId, auth.accessToken]);

  // Aplica CSS vars al :root cuando cambia el branding.
  useEffect(() => {
    const r = document.documentElement;
    r.style.setProperty('--brand-primary', branding.colorPrimary);
    r.style.setProperty('--brand-accent', branding.colorAccent);
    // El tab del navegador siempre muestra el nombre del producto SaaS, no el
    // branding del tenant (ese va en el sidebar).
    document.title = 'PIPELINE ERP';
  }, [branding.colorPrimary, branding.colorAccent]);

  const value = useMemo(() => ({
    branding,
    setBranding: (partial: Partial<Branding>) =>
      setBrandingState(prev => ({ ...prev, ...partial })),
  }), [branding]);

  return <BrandingCtx.Provider value={value}>{children}</BrandingCtx.Provider>;
}

export function useBranding(): Branding {
  return useContext(BrandingCtx).branding;
}

export function useSetBranding(): (b: Partial<Branding>) => void {
  return useContext(BrandingCtx).setBranding;
}
