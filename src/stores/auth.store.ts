import { create } from 'zustand';
import { getSupabase } from '@/lib/supabase/client';
import { isSupabaseConfigured } from '@/config/env';

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
  loading: true,

  async init() {
    if (!isSupabaseConfigured) {
      set({ userId: 'local-user', email: 'local@offline', loading: false });
      return;
    }
    const supabase = getSupabase()!;
    const { data: { session } } = await supabase.auth.getSession();
    set({
      userId: session?.user?.id ?? null,
      email: session?.user?.email ?? null,
      loading: false,
    });
    supabase.auth.onAuthStateChange((_event, s) => {
      set({ userId: s?.user?.id ?? null, email: s?.user?.email ?? null });
    });
  },

  async signIn(email, password) {
    if (!isSupabaseConfigured) return { error: 'Supabase no configurado' };
    const supabase = getSupabase()!;
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  },

  async signUp(email, password) {
    if (!isSupabaseConfigured) return { error: 'Supabase no configurado' };
    const supabase = getSupabase()!;
    const { error } = await supabase.auth.signUp({ email, password });
    return { error: error?.message ?? null };
  },

  async signOut() {
    if (!isSupabaseConfigured) return;
    const supabase = getSupabase()!;
    await supabase.auth.signOut();
    set({ userId: null, email: null });
  },
}));
