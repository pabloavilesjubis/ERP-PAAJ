import { env } from '@/config/env';
import type { DataAdapter } from './adapter';
import { LocalAdapter } from './local-adapter';
import { ApiAdapter } from './api-adapter';

let _adapter: DataAdapter | null = null;

/**
 * Resolución del adapter:
 *   - PROD: SIEMPRE ApiAdapter. Si VITE_DTE_SERVICE_URL no está bien
 *     configurado, los requests fallarán visiblemente (red) en vez de caer
 *     a localStorage en silencio y mostrar data vacía.
 *   - DEV: respeta VITE_DATA_ADAPTER para flow legacy local.
 */
export function getAdapter(): DataAdapter {
  if (_adapter) return _adapter;
  const useApi = import.meta.env.PROD || env.adapter === 'api';
  _adapter = useApi ? new ApiAdapter() : new LocalAdapter();
  return _adapter;
}

export function resetAdapter(): void {
  _adapter = null;
}
