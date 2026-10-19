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
import { PlataformaPage } from '@/features/admin/PlataformaPage';
import { OnboardingWizard } from '@/features/onboarding/OnboardingWizard';
import { UsuariosPage } from '@/features/usuarios/UsuariosPage';
import { MiEmpresaPage } from '@/features/empresa/MiEmpresaPage';
import { CatalogoPage } from '@/features/accounting/pages/CatalogoPage';
import { AsientosPage } from '@/features/accounting/pages/AsientosPage';
import { LibrosPage } from '@/features/accounting/pages/LibrosPage';
import { PeriodosPage } from '@/features/accounting/pages/PeriodosPage';
import { ConfigContablePage } from '@/features/accounting/pages/ConfigContablePage';
import { IntegracionPage } from '@/features/accounting/pages/IntegracionPage';
import { SubledgerPage } from '@/features/accounting/pages/SubledgerPage';
import { EstadosPage } from '@/features/accounting/pages/EstadosPage';
import { BancosPage } from '@/features/banks/BancosPage';
import { PlanillasPage } from '@/features/payroll/PlanillasPage';
import { PosicionFiscalPage } from '@/features/fiscal/PosicionFiscalPage';
import { RecibidosPage } from '@/features/received/RecibidosPage';
import { ImportacionesPage } from '@/features/imports/ImportacionesPage';
import { ActivosPage } from '@/features/assets/ActivosPage';

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
        <Route path="contabilidad/catalogo" element={<CatalogoPage />} />
        <Route path="contabilidad/asientos" element={<AsientosPage />} />
        <Route path="contabilidad/libros" element={<Navigate to="/contabilidad/libros/diario" replace />} />
        <Route path="contabilidad/libros/diario" element={<LibrosPage book="diario" />} />
        <Route path="contabilidad/libros/mayor" element={<LibrosPage book="mayor" />} />
        <Route path="contabilidad/libros/balanza" element={<LibrosPage book="balanza" />} />
        <Route path="contabilidad/periodos" element={<PeriodosPage />} />
        <Route path="contabilidad/configuracion" element={<ConfigContablePage />} />
        <Route path="contabilidad/integracion" element={<IntegracionPage />} />
        <Route path="contabilidad/estados" element={<Navigate to="/contabilidad/estados/situacion" replace />} />
        <Route path="contabilidad/estados/situacion" element={<EstadosPage statement="situacion" />} />
        <Route path="contabilidad/estados/resultados" element={<EstadosPage statement="resultados" />} />
        <Route path="contabilidad/estados/patrimonio" element={<EstadosPage statement="patrimonio" />} />
        <Route path="contabilidad/estados/flujo" element={<EstadosPage statement="flujo" />} />
        <Route path="bancos" element={<Navigate to="/bancos/disponibilidad" replace />} />
        <Route path="bancos/disponibilidad" element={<BancosPage tab="disponibilidad" />} />
        <Route path="bancos/movimientos" element={<BancosPage tab="movimientos" />} />
        <Route path="bancos/conciliacion" element={<BancosPage tab="conciliacion" />} />
        <Route path="bancos/cuentas" element={<BancosPage tab="cuentas" />} />
        <Route path="planillas" element={<Navigate to="/planillas/planillas" replace />} />
        <Route path="planillas/empleados" element={<PlanillasPage tab="empleados" />} />
        <Route path="planillas/planillas" element={<PlanillasPage tab="planillas" />} />
        <Route path="planillas/planillas/:id" element={<PlanillasPage tab="planillas" />} />
        <Route path="planillas/liquidaciones" element={<PlanillasPage tab="liquidaciones" />} />
        <Route path="planillas/reportes" element={<PlanillasPage tab="reportes" />} />
        <Route path="planillas/configuracion" element={<PlanillasPage tab="configuracion" />} />
        <Route path="fiscal" element={<PosicionFiscalPage />} />
        <Route path="dtes-recibidos" element={<RecibidosPage />} />
        <Route path="importaciones" element={<ImportacionesPage />} />
        <Route path="activos" element={<ActivosPage />} />
        <Route path="cxc" element={<SubledgerPage key="cxc" kind="cxc" />} />
        <Route path="cxp" element={<SubledgerPage key="cxp" kind="cxp" />} />
        <Route path="contribuyentes" element={<ContribuyentesPage />} />
        <Route path="csv" element={<CsvPage />} />
        <Route path="mi-empresa" element={<MiEmpresaPage />} />
        <Route path="configuracion" element={<ConfiguracionPage />} />
        <Route path="usuarios" element={<UsuariosPage />} />
        <Route path="admin/tenants" element={<PlataformaPage />} />
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
