import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { useAuthStore } from '@/stores/auth.store';
import { useDataStore } from '@/stores/data.store';
import { isSupabaseConfigured } from '@/config/env';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { VentasConsumidorPage } from '@/features/ventas-consumidor/VentasConsumidorPage';
import { VentasContribuyentePage } from '@/features/ventas-contribuyente/VentasContribuyentePage';
import { ComprasPage } from '@/features/compras/ComprasPage';
import { ContribuyentesPage } from '@/features/contribuyentes/ContribuyentesPage';
import { CsvPage } from '@/features/csv/CsvPage';
import { LoginPage } from '@/features/auth/LoginPage';
import { ContabilidadComprasPage } from '@/features/contabilidad/ContabilidadComprasPage';
import { ContabilidadVentasPage } from '@/features/contabilidad/ContabilidadVentasPage';
import { InteligenciaNegociosPage } from '@/features/contabilidad/InteligenciaNegociosPage';
import { FacturacionPage } from '@/features/facturacion/FacturacionPage';
import { OnboardingWizard } from '@/features/onboarding/OnboardingWizard';

export function App() {
  const { userId, loading, init: initAuth } = useAuthStore();
  const { loaded, init: initData } = useDataStore();

  useEffect(() => { initAuth(); }, [initAuth]);
  useEffect(() => {
    if (userId) initData();
  }, [userId, initData]);

  if (loading) return <FullscreenLoader text="Inicializando…" />;

  if (isSupabaseConfigured && !userId) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  if (!loaded) return <FullscreenLoader text="Cargando datos…" />;

  return (
    <Routes>
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
