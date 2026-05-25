import type { ReactNode } from 'react';
import { isAuthEnabled, useAuth } from './useAuth';
import { SignInPage } from './SignInPage';
import { OnboardingWizard } from '@/features/onboarding/OnboardingWizard';

/**
 * Gate de autenticación:
 *   - Modo SaaS (VITE_DATA_ADAPTER=api): exige login + tenant_id.
 *   - Modo legacy (VITE_DATA_ADAPTER=local): bypass total, sin login.
 */

export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();

  if (!isAuthEnabled()) return <>{children}</>;

  if (!auth.user) return <SignInPage />;
  if (auth.tenantId === null) return <OnboardingWizard />;
  return <>{children}</>;
}
