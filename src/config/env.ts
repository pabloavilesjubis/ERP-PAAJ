export const env = {
  /**
   * Adapter de data. PIPELINE ERP SaaS usa 'api' (backend multi-tenant via
   * /v2/*). 'local' = legacy single-tenant con localStorage como SoT.
   */
  adapter: (import.meta.env.VITE_DATA_ADAPTER ?? 'local') as 'local' | 'api',
  /** URL base del backend (dte-service). */
  dteServiceUrl: import.meta.env.VITE_DTE_SERVICE_URL ?? 'http://localhost:3000',
  /** Nombre del producto. Si el tenant cargó branding, lo sobrescribe en runtime. */
  productName: import.meta.env.VITE_PRODUCT_NAME ?? 'PIPELINE ERP',
  /* Legacy — mantenidos por compat con el adapter de Supabase del modo PAAJ. */
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL ?? '',
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? '',
} as const;

export const isSupabaseConfigured =
  !!env.supabaseUrl && !!env.supabaseAnonKey;
