import { api } from '@/lib/api/client';
import type { CsvMapping, StatementRow } from './genericParser';

export interface BankAccount {
  id: number; bank_name: string; account_number: string; account_type: 'corriente' | 'ahorro' | 'otra'; currency: string;
  ledger_account_id: number; statement_format: 'bac' | 'generic'; csv_mapping: CsvMapping; is_active: boolean;
  ledger_code: string; ledger_name: string; last_statement_date: string | null; statement_balance: number | null;
  ledger_balance: number; pending: number;
}
export interface BankMovement {
  id: number; movement_date: string; reference: string | null; bank_code: string | null; description: string | null;
  debit: number; credit: number; balance: number | null; status: 'pendiente' | 'conciliado' | 'ignorado'; ignore_reason: string | null;
  link_kind: string | null; created_payment: boolean | null; created_entry: number | null; link_label: string | null; link_entry_id: number | null;
}
export interface Candidate { kind: 'payment' | 'journal_line' | 'document'; target_id: number; target_date: string; label: string; party_name: string | null; amount: number; days: number }
export interface Reconciliation {
  as_of: string; account: { bank_name: string; account_number: string };
  bank_balance: number | null; bank_balance_date: string | null; book_balance: number;
  in_bank_only: Array<{ id: number; movement_date: string; reference: string | null; description: string | null; debit: number; credit: number }>;
  in_books_only: Array<{ id: number; entry_date: string; entry_number: number; concept: string; description: string | null; debit: number; credit: number }>;
  adjusted_bank: number | null; adjusted_books: number; difference: number | null;
}
export interface Availability {
  accounts: BankAccount[]; banks: number; reserve: number; reserve_notes: string | null;
  payables: number; payables_due_7: number; receivables: number; receivables_due_7: number; available: number;
  taxes?: number;
}
export interface AccountInput {
  bank_name: string; account_number: string; account_type: string; ledger_account_id: number;
  statement_format: 'bac' | 'generic'; csv_mapping: CsvMapping; is_active: boolean;
}

export const bankApi = {
  accounts: () => api.get<{ items: BankAccount[] }>('/v2/banks/accounts').then(r => r.items),
  create: (b: AccountInput) => api.post<{ id: number }>('/v2/banks/accounts', b),
  update: (id: number, b: AccountInput) => api.put<{ id: number }>(`/v2/banks/accounts/${id}`, b),
  importStatement: (id: number, b: { file_name?: string; file_account?: string | null; opening_balance?: number | null; closing_balance?: number | null; totals_ok?: boolean | null; rows: StatementRow[] }) =>
    api.post<{ import_id: number; rows: number; new: number; duplicates: number; auto_reconciled: number }>(`/v2/banks/accounts/${id}/import`, b),
  autoReconcile: (id: number) => api.post<{ reconciled: number }>(`/v2/banks/accounts/${id}/auto-reconcile`),
  movements: (account_id: number, p: { status?: string; from?: string; to?: string; q?: string }) => {
    const s = new URLSearchParams({ account_id: String(account_id) });
    for (const [k, v] of Object.entries(p)) if (v) s.set(k, v);
    return api.get<{ items: BankMovement[] }>(`/v2/banks/movements?${s}`).then(r => r.items);
  },
  candidates: (id: number) => api.get<{ items: Candidate[] }>(`/v2/banks/movements/${id}/candidates`).then(r => r.items),
  reconcile: (id: number, b: { kind: string; target_id?: number | null; counter_account_id?: number | null; description?: string | null }) =>
    api.post<{ link_id: number }>(`/v2/banks/movements/${id}/reconcile`, b),
  unreconcile: (id: number) => api.post<{ success: boolean }>(`/v2/banks/movements/${id}/unreconcile`),
  ignore: (id: number, reason: string) => api.post<{ success: boolean }>(`/v2/banks/movements/${id}/ignore`, { reason }),
  reconciliation: (id: number, as_of: string) => api.get<Reconciliation>(`/v2/banks/accounts/${id}/reconciliation?as_of=${as_of}`),
  availability: () => api.get<Availability>('/v2/banks/availability'),
  setReserve: (amount: number, notes: string | null) => api.put<{ success: boolean }>('/v2/banks/reserve', { amount, notes }),
};

export const BANKS_SV = ['Banco Agrícola', 'BAC Credomatic', 'Banco Davivienda', 'Banco Cuscatlán', 'Banco Promerica', 'Banco Hipotecario',
  'Banco Industrial', 'Banco Atlántida', 'Banco Azul', 'Banco de Fomento Agropecuario', 'Banco Abank', 'Otro'];
