import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env, isSupabaseConfigured } from '@/config/env';

/**
 * Cliente Supabase sin tipos generados (untyped por defecto).
 * Para activar el tipado fuerte de las tablas:
 *   1) Instala la CLI: npm i -D supabase
 *   2) npx supabase gen types typescript --project-id <id> > src/types/supabase.ts
 *   3) Importa Database aquí y pásalo como genérico a createClient<Database>().
 */

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  if (!_client) {
    _client = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }
  return _client;
}

export function requireSupabase(): SupabaseClient {
  const c = getSupabase();
  if (!c) {
    throw new Error(
      'Supabase no está configurado. Define VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY y VITE_DATA_ADAPTER=supabase.',
    );
  }
  return c;
}
