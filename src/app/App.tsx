import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { useAuthStore } from '@/stores/auth.store';
import { useDataStore } from '@/stores/data.store';
import { useAuth } from '@/auth/useAuth';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { VentasConsumidorPage } from '@/features/ventas-consumidor/VentasConsumidorPage';
import { VentasContribuyentePage } from '@/features/ventas-contribuyente/VentasContribuyentePage';
import { ComprasPage } from '@/features/compras/ComprasPage';
import { ContribuyentesPage } from '@/features/contribuyentes/ContribuyentesPage';
import { CsvPage } from '@/features/csv/CsvPage';
import { ContabilidadComprasPage } from '@/features/contabilidad/ContabilidadComprasPage';
import { ContabilidadVentasPage } from '@/features/contabilidad/ContabilidadVentasPage';
import { InteligenciaNegociosPage } from '@/features/contabilidad/InteligenciaNegociosPage';
import { FacturacionPage } from '@/features/facturacion/FacturacionPage';
import { ConfiguracionPage } from '@/features/configuracion/ConfiguracionPage';
import { OnboardingWizard } from '@/features/onboarding/OnboardingWizard';

/**
 * App routes. La autenticación la maneja exclusivamente `<AuthGate>` (en
 * main.tsx), que envuelve a este componente. Cuando App se renderiza, el
 * usuario YA está autenticado (o estamos en modo legacy local). NO hay un
 * segundo gate de login aquí — y la ruta `/login` solo redirige por
 * compatibilidad con URLs legacy.
 */
export function App() {
  const { userId, init: initAuth } = useAuthStore();
  const { loaded, init: initData } = useDataStore();
  const saasAuth = useAuth();

  useEffect(() => { initAuth(); }, [initAuth]);
  useEffect(() => {
    // En modo SaaS, el trigger es el JWT (saasAuth.user).
    // En modo legacy, el trigger es userId del auth.store.
    if (saasAuth.user || userId) initData();
  }, [saasAuth.user, userId, initData]);

  if (!loaded) return <FullscreenLoader text="Cargando datos…" />;

  return (
    <Routes>
      {/* Compat: /login legacy → home. AuthGate ya mostró SignInPage si no hay sesión. */}
      <Route path="/login" element={<Navigate to="/" replace />} />
      {/* Onboarding va FUERA del AppShell (sin sidebar — pantalla completa) */}
      <Route path="/onboarding" element={<OnboardingWizard />} />
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="facturacion" element={<FacturacionPage />} />
        <Route path="consumidor" element={<VentasConsumidorPage />} />
        <Route path="contribuyente" element={<VentasContribuyentePage />} />
        <Route path="compras" element={<ComprasPage />} />
        <Route path="contabilidad/compras" element={<ContabilidadComprasPage />} />
        <Route path="contabilidad/ventas" element={<ContabilidadVentasPage />} />
        <Route path="contabilidad/inteligencia" element={<InteligenciaNegociosPage />} />
        <Route path="contribuyentes" element={<ContribuyentesPage />} />
        <Route path="csv" element={<CsvPage />} />
        <Route path="configuracion" element={<ConfiguracionPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function FullscreenLoader({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--fg-3)', fontSize: 'var(--text-sm)' }}>
      {text}
    </div>
  );
}
