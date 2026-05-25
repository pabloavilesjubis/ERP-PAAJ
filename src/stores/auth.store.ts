import { create } from 'zustand';

/**
 * Stub legacy. PIPELINE ERP SaaS usa `@/auth/useAuth` (JWT local + bcrypt en
 * el backend). Este store quedó solo para que código viejo de PAAJ (LoginPage,
 * AppShell.email) siga compilando. En modo SaaS los campos quedan vacíos —
 * el AppShell prefiere la sesión SaaS si existe.
 *
 * NO usar este store en código nuevo. Importá desde `@/auth/useAuth`.
 */

interface AuthState {
  userId: string | null;
  email: string | null;
  loading: boolean;
  init: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signUp: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  userId: null,
  email: null,
  loading: false,
  async init() {
    set({ userId: 'local-user', email: 'local@offline', loading: false });
  },
  async signIn() { return { error: 'Auth SaaS — usá /v2/auth/login' }; },
  async signUp() { return { error: 'Auth SaaS — usá /v2/auth/signup' }; },
  async signOut() { set({ userId: null, email: null }); },
}));
