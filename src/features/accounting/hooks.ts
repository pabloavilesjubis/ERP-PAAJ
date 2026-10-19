import { useQuery } from '@tanstack/react-query';
import { accApi } from './api';
import type { Account } from './types';

export const accKeys = {
  accounts: ['acc', 'accounts'] as const,
  roles: ['acc', 'roles'] as const,
  setup: ['acc', 'setup'] as const,
  entries: (p: unknown) => ['acc', 'entries', p] as const,
  entry: (id: number) => ['acc', 'entry', id] as const,
  periods: (y: number) => ['acc', 'periods', y] as const,
};

export function useAccounts() {
  return useQuery({ queryKey: accKeys.accounts, queryFn: accApi.accounts, staleTime: 60_000 });
}

export function accountLabel(a: Pick<Account, 'code' | 'name'>): string {
  return `${a.code} — ${a.name}`;
}

export const byCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code, undefined, { numeric: true });
