import { api } from '@/lib/api/client';
import type {
  Account, AccountMovement, AgingRow, EntryDetail, EntryLine, EntrySummary, FundAccount, IntegrationDoc, IntegrationSettings,
  JournalEntry, LedgerLine, PartyBalance, PartyRow, Payment, PeriodRow, RoleAssignment, SetupStatus, SubDocument, SubKind,
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
  cash_flow?: string | null;
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

export interface PaymentInput {
  payment_date: string;
  party_key: string;
  method: string;
  fund_account_id: number | null;
  amount: number;
  allocations: Array<{ document_id: number; amount: number }>;
  reference?: string | null;
  notes?: string | null;
}

export interface ManualDocInput {
  party_id: number; doc_type?: string | null; doc_number?: string | null; doc_date: string; due_date?: string | null;
  amount: number; counter_account_id: number; description?: string | null;
}

export interface DistributionLine { account_id: number; amount: number; cost_center?: string | null; description?: string | null }

export const integrationApi = {
  settings: () => api.get<IntegrationSettings>('/v2/acc/integration/settings'),
  saveSettings: (b: IntegrationSettings) => api.put<{ success: boolean }>('/v2/acc/integration/settings', b),
  summary: () => api.get<{ items: Array<{ module: string; status: string; n: number; total: number }> }>('/v2/acc/integration/summary'),
  documents: (p: { module: string; status?: string; from?: string; to?: string; q?: string; limit?: number; offset?: number }) =>
    api.get<{ items: IntegrationDoc[]; total: number }>(`/v2/acc/integration/documents${qs(p)}`),
  postPending: (module?: string) => api.post<{ result: Record<string, Record<string, number>> }>('/v2/acc/integration/post-pending', { module }),
  retry: (module: string, id: number) => api.post<{ result: string }>('/v2/acc/integration/retry', { module, id }),
  distribution: (compraId: number) => api.get<{
    compra: { id: number; fecha: string; proveedor_nombre: string; gravado: number; exento: number; iva: number; descripcion: string | null; otros: string | null };
    lines: Array<DistributionLine & { code: string; name: string }>;
    posting: { status: string; message: string | null; entry_id: number | null; entry_number: number | null } | null;
    party_id: number | null;
  }>(`/v2/acc/compras/${compraId}/distribution`),
  saveDistribution: (compraId: number, lines: DistributionLine[], remember_for_supplier: boolean) =>
    api.put<{ result: string }>(`/v2/acc/compras/${compraId}/distribution`, { lines, remember_for_supplier }),
  parties: () => api.get<{ items: PartyRow[] }>('/v2/acc/party-accounts'),
  saveParty: (id: number, b: { expense_account_id: number | null; income_account_id: number | null; credit_days: number | null }) =>
    api.put<{ success: boolean }>(`/v2/acc/party-accounts/${id}`, b),
};

export const subApi = {
  fundAccounts: () => api.get<{ items: FundAccount[] }>('/v2/acc/fund-accounts').then(r => r.items),
  parties: (kind: SubKind, as_of?: string, all = false) =>
    api.get<{ as_of: string; items: PartyBalance[] }>(`/v2/acc/${kind}/parties${qs({ as_of, all: all ? 1 : undefined })}`),
  documents: (kind: SubKind, p: { party_key?: string; status?: string; from?: string; to?: string; q?: string }) =>
    api.get<{ items: SubDocument[] }>(`/v2/acc/${kind}/documents${qs(p)}`),
  createDocument: (kind: SubKind, b: ManualDocInput) => api.post<{ id: number }>(`/v2/acc/${kind}/documents`, b),
  voidDocument: (kind: SubKind, id: number, reason: string) => api.post<{ success: boolean }>(`/v2/acc/${kind}/documents/${id}/void`, { reason }),
  aging: (kind: SubKind, as_of?: string) => api.get<{ as_of: string; items: AgingRow[] }>(`/v2/acc/${kind}/aging${qs({ as_of })}`),
  payments: (kind: SubKind, p: { party_key?: string; from?: string; to?: string }) =>
    api.get<{ items: Payment[] }>(`/v2/acc/${kind}/payments${qs(p)}`),
  payment: (kind: SubKind, id: number) => api.get<{
    payment: Payment & { notes: string | null; voided_by_name: string | null };
    allocations: Array<{ document_id: number; amount: number; doc_type: string | null; doc_number: string | null; doc_date: string; doc_amount: number }>;
  }>(`/v2/acc/${kind}/payments/${id}`),
  createPayment: (kind: SubKind, b: PaymentInput) => api.post<{ id: number }>(`/v2/acc/${kind}/payments`, b),
  voidPayment: (kind: SubKind, id: number, reason: string) => api.post<{ success: boolean }>(`/v2/acc/${kind}/payments/${id}/void`, { reason }),
  check: (kind: SubKind, as_of?: string) =>
    api.get<{ as_of: string; ledger: number; subledger: number; advances: number; difference: number }>(`/v2/acc/${kind}/check${qs({ as_of })}`),
};

export interface FiscalYear {
  year: number; status: 'abierto' | 'cerrado'; result: number | null;
  closing_entry_id: number | null; transfer_entry_id: number | null; closing_entry_number: number | null; transfer_entry_number: number | null;
  closed_at: string | null; closed_by: string | null; reopened_at: string | null; reopened_by: string | null; notes: string | null;
}
export interface Signatories {
  legal_rep_name: string | null; legal_rep_title: string | null; accountant_name: string | null; accountant_license: string | null;
  auditor_name: string | null; auditor_license: string | null;
}

export const closingApi = {
  years: () => api.get<{ items: FiscalYear[] }>('/v2/acc/fiscal-years').then(r => r.items),
  preview: (year: number) => api.get<{ year: number; result: number; accounts: number; issues: string[] }>(`/v2/acc/fiscal-years/${year}/preview`),
  close: (year: number, transfer: boolean) => api.post<{ result: number }>(`/v2/acc/fiscal-years/${year}/close`, { transfer }),
  reopen: (year: number, reason: string) => api.post<{ success: boolean }>(`/v2/acc/fiscal-years/${year}/reopen`, { reason }),
  company: () => api.get<{ nombre_legal: string; nit: string | null; nrc: string | null; signatories: Signatories }>('/v2/acc/company'),
  saveSignatories: (b: Signatories) => api.put<{ success: boolean }>('/v2/acc/signatories', b),
};
