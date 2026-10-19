import { api } from '@/lib/api/client';
import type {
  Account, AccountMovement, EntryDetail, EntryLine, EntrySummary, JournalEntry, LedgerLine, PeriodRow,
  RoleAssignment, SetupStatus,
} from './types';

const qs = (p: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
};

export interface AccountInput {
  code: string; name: string; account_type: string; nature?: string; parent_id?: number | null;
  balance_term?: string | null; result_section?: string | null; allows_movements: boolean; is_active: boolean;
}

export interface ImportRow {
  code: string; name: string; account_type: string; nature?: string | null; parent_code?: string | null;
  financial_statement?: string | null; allows_movements?: boolean | null; is_active?: boolean | null;
  balance_term?: 'corriente' | 'no_corriente' | null; result_section?: string | null;
}

export interface ManualEntryInput {
  id?: number | null;
  entry_date: string;
  manual_kind: string;
  concept: string;
  notes?: string | null;
  lines: Array<{ account_id: number; debit?: number; credit?: number; description?: string | null; party_id?: number | null; cost_center?: string | null; reference?: string | null }>;
  post?: boolean;
}

export const accApi = {
  setup: () => api.get<SetupStatus>('/v2/acc/setup'),
  accounts: () => api.get<{ items: Account[] }>('/v2/acc/accounts').then(r => r.items.map(a => ({ ...a, id: Number(a.id), parent_id: a.parent_id === null ? null : Number(a.parent_id) }))),
  createAccount: (b: AccountInput) => api.post<{ id: number }>('/v2/acc/accounts', b),
  updateAccount: (id: number, b: AccountInput) => api.put<{ success: boolean }>(`/v2/acc/accounts/${id}`, b),
  deleteAccount: (id: number) => api.delete<{ success: boolean }>(`/v2/acc/accounts/${id}`),
  importAccounts: (rows: ImportRow[]) => api.post<{ inserted: number; updated: number }>('/v2/acc/accounts/import', { rows }),

  roles: () => api.get<{ items: RoleAssignment[] }>('/v2/acc/roles').then(r => r.items.map(x => ({ ...x, account_id: x.account_id === null ? null : Number(x.account_id) }))),
  saveRoles: (assignments: Record<string, number | null>) => api.put<{ success: boolean }>('/v2/acc/roles', { assignments }),

  entries: (p: { from: string; to: string; status?: string; type?: string; module?: string; q?: string; limit?: number; offset?: number }) =>
    api.get<{ items: EntrySummary[]; total: number }>(`/v2/acc/entries${qs(p)}`),
  entry: (id: number) => api.get<{ entry: EntryDetail; lines: EntryLine[] }>(`/v2/acc/entries/${id}`),
  saveManual: (b: ManualEntryInput) => api.post<{ id: number; entry_number: number | null }>('/v2/acc/entries', b),
  postEntry: (id: number) => api.post<{ id: number; entry_number: number }>(`/v2/acc/entries/${id}/post`),
  deleteDraft: (id: number) => api.delete<{ success: boolean }>(`/v2/acc/entries/${id}`),
  review: (id: number, notes?: string) => api.post<{ success: boolean }>(`/v2/acc/entries/${id}/review`, { notes }),
  voidEntry: (id: number, reason: string) => api.post<{ reversal_id: number }>(`/v2/acc/entries/${id}/void`, { reason }),
  importOpening: (entry_date: string, rows: Array<{ code: string; debit?: number; credit?: number; description?: string }>) =>
    api.post<{ id: number }>('/v2/acc/opening/import', { entry_date, rows }),

  movements: (from: string, to: string) =>
    api.get<{ items: AccountMovement[] }>(`/v2/acc/reports/movements${qs({ from, to })}`)
      .then(r => r.items.map(m => ({ ...m, account_id: Number(m.account_id) }))),
  ledger: (account_id: number, from: string, to: string) =>
    api.get<{ opening: number; items: LedgerLine[] }>(`/v2/acc/reports/ledger${qs({ account_id, from, to })}`),
  journal: (from: string, to: string, limit = 500, offset = 0) =>
    api.get<{ items: JournalEntry[] }>(`/v2/acc/reports/journal${qs({ from, to, limit, offset })}`),

  periods: (year: number) => api.get<{ year: number; items: PeriodRow[] }>(`/v2/acc/periods${qs({ year })}`),
  closePeriod: (year: number, month: number, notes?: string) => api.post<{ success: boolean }>('/v2/acc/periods/close', { year, month, notes }),
  reopenPeriod: (year: number, month: number, notes: string) => api.post<{ success: boolean }>('/v2/acc/periods/reopen', { year, month, notes }),
};
