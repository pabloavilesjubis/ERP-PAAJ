import type { AppData } from '@/types/domain';

/**
 * DataAdapter abstrae la capa de persistencia.
 * Hoy: localStorage (offline-first).
 * Mañana: Supabase (multi-usuario, multi-empresa) — sin tocar la UI.
 */
export interface DataAdapter {
  load(): Promise<AppData>;
  save(data: AppData): Promise<void>;
  readonly kind: 'local' | 'supabase';
}
