import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Icon } from '@/components/icons/Icon';
import { MONTHS } from '@/config/constants';
import { usePeriodStore } from '@/stores/period.store';
import { useAuthStore } from '@/stores/auth.store';
import { useDataStore } from '@/stores/data.store';
import { isSupabaseConfigured } from '@/config/env';
import { useBranding } from '@/branding/BrandingProvider';
import { useAuth, signOut as saasSignOut } from '@/auth/useAuth';

/**
 * Devuelve sesión + signOut del auth local. Si no hay sesión SaaS, devuelve
 * `{ user: null, signOutSaas: null }` para que el AppShell caiga al legacy
 * auth.store (modo single-tenant PAAJ).
 */
function useSaasAuth() {
  const { user } = useAuth();
  return {
    user,
    signOutSaas: user ? () => saasSignOut() : null,
  };
}

/**
 * Logo + nombre del producto. Si el tenant cargó un logo_url propio, lo
 * muestra; sino cae al texto PIPELINE ERP (o al productName del tenant).
 */
function ProductLogo() {
  const branding = useBranding();
  if (branding.logoUrl) {
    return <img src={branding.logoUrl} alt={branding.productName} style={{ maxHeight: 32, maxWidth: 160 }} />;
  }
  return (
    <div style={{
      fontWeight: 700, fontSize: 18, letterSpacing: -0.3,
      color: 'var(--brand-primary, #065f46)',
    }}>
      {branding.productName}
    </div>
  );
}

const NAV = [
  { to: '/', icon: 'home', label: 'Resumen fiscal', section: 'Declaración mensual', end: true },
  { to: '/facturacion', icon: 'plus', label: 'Facturación (POS)', section: 'Operación diaria' },
  { to: '/consumidor', icon: 'receipt', label: 'Ventas consumidor', section: 'Declaración mensual' },
  { to: '/contribuyente', icon: 'file-text', label: 'Ventas contribuyente', section: 'Declaración mensual' },
  { to: '/compras', icon: 'credit-card', label: 'Compras', section: 'Declaración mensual' },
  { to: '/contabilidad/compras', icon: 'shopping-bag', label: 'Compras', section: 'Contabilidad' },
  { to: '/contabilidad/ventas', icon: 'trending-up', label: 'Ventas', section: 'Contabilidad' },
  { to: '/contabilidad/inteligencia', icon: 'building', label: 'Inteligencia de Negocios', section: 'Contabilidad' },
  { to: '/contribuyentes', icon: 'users', label: 'Contribuyentes', section: 'Catálogos' },
  { to: '/csv', icon: 'download', label: 'CSV / Plantillas', section: 'Datos' },
  { to: '/configuracion', icon: 'edit', label: 'Configuración', section: 'Ajustes' },
] as const;

const TITLES: Record<string, string> = {
  '/': 'Resumen fiscal',
  '/facturacion': 'Facturación — Punto de venta',
  '/consumidor': 'Ventas al consumidor',
  '/contribuyente': 'Ventas al contribuyente',
  '/compras': 'Compras y costos',
  '/contabilidad/compras': 'Contabilidad — Compras',
  '/contabilidad/ventas': 'Contabilidad — Ventas',
  '/contabilidad/inteligencia': 'Inteligencia de Negocios',
  '/contribuyentes': 'Contribuyentes',
  '/csv': 'Importar / Exportar CSV',
  '/configuracion': 'Configuración',
};

export function AppShell() {
  const location = useLocation();
  const { mode, month, year, setMode, setMonth, setYear } = usePeriodStore();
  const legacyAuth = useAuthStore();
  const dataError = useDataStore(s => s.error);
  const saving = useDataStore(s => s.saving);
  // Soporta ambos modos: legacy (auth.store con email/signOut) y SaaS
  // (Supabase via useAuth). El SaaS toma precedencia si hay sesión.
  const { user, signOutSaas } = useSaasAuth();
  const email = user?.email ?? legacyAuth.email;
  const signOut = signOutSaas ?? legacyAuth.signOut;

  const sections = Array.from(new Set(NAV.map(n => n.section)));

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <ProductLogo />
        </div>
        {sections.map(section => (
          <div className="sidebar-section" key={section}>
            <div className="sidebar-section-label">{section}</div>
            {NAV.filter(n => n.section === section).map(n => (
              <NavLink
                key={n.to}
                to={n.to}
                end={'end' in n ? n.end : false}
                className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
              >
                <Icon name={n.icon as never} size={18} className="nav-icon" />
                {n.label}
              </NavLink>
            ))}
          </div>
        ))}

        <div style={{ marginTop: 'auto', padding: 'var(--s-4)', borderTop: '1px solid var(--border)', fontSize: 'var(--text-xs)', color: 'var(--fg-3)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <Icon name={isSupabaseConfigured ? 'cloud' : 'database'} size={14} />
            {isSupabaseConfigured ? 'Conectado a Supabase' : 'Modo local (offline)'}
          </div>
          {email && <div style={{ wordBreak: 'break-all' }}>{email}</div>}
        </div>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <div className="topbar-title">{TITLES[location.pathname] ?? 'ERP'}</div>
          <div className="month-selector">
            <Icon name="calendar" size={16} style={{ color: 'var(--fg-3)' }} />
            <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', overflow: 'hidden' }}>
              <button
                type="button"
                onClick={() => setMode('monthly')}
                style={{
                  padding: '6px 10px', fontSize: 'var(--text-xs)', fontWeight: 500,
                  background: mode === 'monthly' ? 'var(--brand-primary-700)' : 'var(--surface-1)',
                  color: mode === 'monthly' ? '#fff' : 'var(--fg-2)',
                  border: 'none', cursor: 'pointer',
                }}
              >
                Mes
              </button>
              <button
                type="button"
                onClick={() => setMode('annual')}
                style={{
                  padding: '6px 10px', fontSize: 'var(--text-xs)', fontWeight: 500,
                  background: mode === 'annual' ? 'var(--brand-primary-700)' : 'var(--surface-1)',
                  color: mode === 'annual' ? '#fff' : 'var(--fg-2)',
                  border: 'none', borderLeft: '1px solid var(--border)', cursor: 'pointer',
                }}
              >
                Año
              </button>
            </div>
            {mode === 'monthly' && (
              <select className="month-select" value={month} onChange={e => setMonth(+e.target.value)}>
                {MONTHS.map((m, i) => <option key={i} value={i}>{m}</option>)}
              </select>
            )}
            <select className="month-select" value={year} onChange={e => setYear(+e.target.value)}>
              {[2023, 2024, 2025, 2026, 2027, 2028].map(y => <option key={y}>{y}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 'var(--s-3)', alignItems: 'center' }}>
            <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--brand-primary-100)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--brand-primary-700)', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
              {(email ?? 'U').charAt(0).toUpperCase()}
            </div>
            {isSupabaseConfigured && (
              <button className="btn-icon" onClick={signOut} aria-label="Cerrar sesión">
                <Icon name="log-out" size={16} />
              </button>
            )}
          </div>
        </header>

        <main className="content">
          {dataError && (
            <div className="banner banner-danger" style={{ marginBottom: 'var(--s-5)' }}>
              <Icon name="alert" size={16} />
              <div>
                <strong>Error:</strong> {dataError}
                <div style={{ fontSize: 'var(--text-xs)', marginTop: 4, opacity: 0.85 }}>
                  Abre la consola del navegador (F12) para ver el detalle. Los cambios pueden no estar persistiendo en la nube.
                </div>
              </div>
            </div>
          )}
          {saving && (
            <div style={{
              position: 'fixed', bottom: 16, right: 16,
              background: 'var(--surface-1)', border: '1px solid var(--border)',
              padding: '6px 12px', borderRadius: 'var(--r-pill)',
              fontSize: 'var(--text-xs)', color: 'var(--fg-3)', boxShadow: 'var(--shadow-1)',
              zIndex: 50,
            }}>Guardando…</div>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
