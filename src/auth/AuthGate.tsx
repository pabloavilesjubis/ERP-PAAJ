import type { ReactNode } from 'react';
import { isAuthEnabled, useAuth } from './useAuth';
import { SignInPage } from './SignInPage';
import { OnboardingWizard } from '@/features/onboarding/OnboardingWizard';

/**
 * Gate de autenticación.
 *
 * - PRODUCCIÓN (`import.meta.env.PROD`): SIEMPRE activo. No hay fallback a
 *   localStorage. Sin token → SignInPage. Con token pero sin tenant → wizard.
 * - DESARROLLO sin `VITE_DATA_ADAPTER=api`: bypass total para mantener el
 *   workflow legacy single-tenant.
 *
 * El estado se lee desde `useAuth` (JWT en localStorage 'pipeline-auth').
 * `useAuth` es síncrono — no hay loading async — por lo que la gate decide
 * en el primer render sin parpadeo.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();

  if (!isAuthEnabled()) return <>{children}</>;

  if (!auth.user) return <SignInPage />;
  if (auth.tenantId === null) return <OnboardingWizard />;
  return <>{children}</>;
}
