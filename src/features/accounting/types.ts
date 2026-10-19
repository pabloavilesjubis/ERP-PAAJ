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
  cash_flow?: 'efectivo' | 'operacion' | 'inversion' | 'financiamiento' | null;
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

// ── F2: integración y auxiliares ──
export interface IntegrationSettings {
  auto_post: boolean;
  posting_start_date: string | null;
  sales_cash_role: 'cash' | 'bank' | 'receivables';
  purchases_cash_mode: 'payables' | 'cash';
  default_credit_days: number;
  updated_by?: string | null;
  updated_at?: string;
}

export type PostingStatus = 'pendiente' | 'contabilizado' | 'error' | 'omitido';

export interface IntegrationDoc {
  module: 'ventas' | 'compras';
  id: number;
  doc_date: string;
  subtype: string;
  doc_ref: string;
  party_name: string;
  total: number;
  status: PostingStatus;
  message: string | null;
  entry_id: number | null;
  entry_number: number | null;
}

export type SubKind = 'cxc' | 'cxp';

export interface PartyBalance {
  party_key: string;
  party_name: string;
  party_id: number | null;
  open_docs: number;
  balance: number;
  overdue: number;
  advances: number;
}

export interface SubDocument {
  id: number;
  source_module: 'ventas' | 'compras' | 'manual';
  source_id: string;
  party_key: string;
  party_id: number | null;
  party_name: string;
  party_nit: string | null;
  doc_type: string | null;
  doc_number: string | null;
  doc_date: string;
  due_date: string;
  amount: number;
  applied: number;
  balance: number;
  description: string | null;
  status: 'vigente' | 'anulado';
  entry_id: number | null;
  days_overdue: number;
}

export interface AgingRow {
  party_key: string; party_name: string;
  current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number; total: number;
}

export interface Payment {
  id: number;
  number: number;
  payment_date: string;
  party_key: string;
  party_name: string;
  method: string;
  amount: number;
  unapplied: number;
  reference: string | null;
  status: 'vigente' | 'anulado';
  entry_id: number | null;
  fund_code: string | null;
  fund_name: string | null;
  created_by_name: string | null;
  void_reason: string | null;
}

export interface FundAccount { id: number; code: string; name: string }

export interface PartyRow {
  party_id: number; nombre: string; nit: string | null; nrc: string | null; tipo: string;
  expense_account_id: number | null; income_account_id: number | null; credit_days: number | null;
}
