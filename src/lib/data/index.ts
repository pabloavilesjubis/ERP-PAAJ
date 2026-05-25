import { env } from '@/config/env';
import type { DataAdapter } from './adapter';
import { LocalAdapter } from './local-adapter';
import { ApiAdapter } from './api-adapter';

let _adapter: DataAdapter | null = null;

export function getAdapter(): DataAdapter {
  if (_adapter) return _adapter;
  _adapter = env.adapter === 'api' ? new ApiAdapter() : new LocalAdapter();
  return _adapter;
}

export function resetAdapter(): void {
  _adapter = null;
}
