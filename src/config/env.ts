export const env = {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL ?? '',
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? '',
  adapter: (import.meta.env.VITE_DATA_ADAPTER ?? 'local') as 'local' | 'supabase',
  /** URL base del microservicio dte-service (Node/TS) que firma y envía DTEs. */
  dteServiceUrl: import.meta.env.VITE_DTE_SERVICE_URL ?? 'http://localhost:3000',
} as const;

export const isSupabaseConfigured =
  env.adapter === 'supabase' && !!env.supabaseUrl && !!env.supabaseAnonKey;
