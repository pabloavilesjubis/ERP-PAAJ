export type AccountType = 'Activo' | 'Contraactivo' | 'Pasivo' | 'Patrimonio' | 'Ingreso' | 'Costo' | 'Gasto' | 'Resultado';

export interface Account {
  id: number;
  code: string;
  name: string;
  account_type: AccountType;
  nature: 'Deudora' | 'Acreedora' | 'Mixta';
  parent_id: number | null;
  level: number;
  financial_statement: 'Balance' | 'ER';
  affects_result: boolean;
  result_section: string | null;
  balance_term: 'corriente' | 'no_corriente' | null;
  allows_movements: boolean;
  is_active: boolean;
  has_movements?: boolean;
}

export interface AccountMovement {
  account_id: number;
  debit_before: number;
  credit_before: number;
  debit: number;
  credit: number;
}

export type EntryStatus = 'borrador' | 'contabilizado' | 'revisado' | 'anulado';

export interface EntrySummary {
  id: number;
  entry_number: number | null;
  entry_date: string;
  entry_type: 'automatico' | 'manual' | 'reversion';
  manual_kind: string | null;
  concept: string;
  source_module: string | null;
  source_id: string | null;
  source_ref: string | null;
  event_type: string | null;
  status: EntryStatus;
  total_debit: string;
  total_credit: string;
  created_by_name: string | null;
  reviewed_by_name: string | null;
  reversal_of: number | null;
  reversed_by: number | null;
}

export interface EntryDetail extends EntrySummary {
  notes: string | null;
  created_at: string;
  posted_at: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  voided_at: string | null;
  voided_by_name: string | null;
  void_reason: string | null;
  reversed_by_number: number | null;
  reversal_of_number: number | null;
}

export interface EntryLine {
  id?: number;
  line_no?: number;
  account_id: number;
  account_code?: string;
  account_name?: string;
  description: string | null;
  debit: string | number;
  credit: string | number;
  party_id?: number | null;
  party_name?: string | null;
  cost_center?: string | null;
  reference?: string | null;
}

export interface RoleAssignment {
  role_key: string;
  label: string;
  group_name: string;
  description: string | null;
  account_id: number | null;
  account_code: string | null;
  account_name: string | null;
}

export interface PeriodRow {
  month: number;
  status: 'abierto' | 'cerrado';
  closed_at: string | null;
  closed_by: string | null;
  reopened_at: string | null;
  reopened_by: string | null;
  notes: string | null;
  entries: number;
  drafts: number;
}

export interface LedgerLine {
  entry_id: number;
  entry_number: number;
  entry_date: string;
  entry_type: string;
  status: EntryStatus;
  concept: string;
  source_ref: string | null;
  account_code: string;
  account_name: string;
  description: string | null;
  party_name: string | null;
  debit: number;
  credit: number;
}

export interface JournalEntry {
  id: number;
  entry_number: number;
  entry_date: string;
  entry_type: string;
  manual_kind: string | null;
  concept: string;
  source_ref: string | null;
  status: EntryStatus;
  total_debit: number;
  total_credit: number;
  lines: Array<{ line_no: number; account_code: string; account_name: string; description: string | null; debit: number; credit: number; party_name: string | null }>;
}

export interface SetupStatus {
  accounts: number;
  movement_accounts: number;
  roles: number;
  entries: number;
  missing_roles: Array<{ role_key: string; label: string }>;
}
