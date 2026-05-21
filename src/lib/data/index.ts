import { isSupabaseConfigured } from '@/config/env';
import type { DataAdapter } from './adapter';
import { LocalAdapter } from './local-adapter';
import { SupabaseAdapter } from './supabase-adapter';

let _adapter: DataAdapter | null = null;

export function getAdapter(): DataAdapter {
  if (_adapter) return _adapter;
  _adapter = isSupabaseConfigured ? new SupabaseAdapter() : new LocalAdapter();
  return _adapter;
}
