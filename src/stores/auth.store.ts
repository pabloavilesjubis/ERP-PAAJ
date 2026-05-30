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
  // Mensajes neutros — la auth de verdad la maneja `@/auth/useAuth` (SignInPage
  // contra /v2/auth/login). Estos stubs solo sirven para que código viejo
  // que importe useAuthStore.signIn/signUp compile, pero nunca debería verse
  // un usuario llegar acá en SaaS.
  async signIn() { return { error: 'Credenciales inválidas' }; },
  async signUp() { return { error: 'Registro deshabilitado' }; },
  async signOut() { set({ userId: null, email: null }); },
}));
