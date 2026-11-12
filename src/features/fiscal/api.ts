import { api } from '@/lib/api/client';

export interface FiscalMonth {
  period: string; ventas_docs: number; compras_docs: number;
  debito: number; credito: number; percepcion: number; ret_iva_clientes: number; ret_iva_hechas: number;
  ventas_netas: number; base_pago_cuenta: number; pago_a_cuenta: number; isr_planilla: number; isr_compras: number; ret_renta_clientes: number;
  remanente_anterior: number; iva_neto: number; iva_a_pagar: number; remanente_siguiente: number;
  f07: number; f14: number; pagado_f07: number; pagado_f14: number; pendiente: number; liquidation_entry_id: number | null;
}
export interface FiscalPayment {
  id: number; form: 'F07' | 'F14'; period: string; payment_date: string; amount: number;
  breakdown: { main: number; withholdings: number }; reference: string | null; status: 'vigente' | 'anulado'; entry_id: number | null; void_reason: string | null;
}
export interface FiscalSettings { opening_period: string; opening_remanente: number; pago_a_cuenta_rate: number }

export const fiscalApi = {
  settings: () => api.get<{ settings: (FiscalSettings & { updated_by: string | null }) | null }>('/v2/fiscal/settings'),
  saveSettings: (b: FiscalSettings) => api.put<{ success: boolean }>('/v2/fiscal/settings', b),
  months: (to: string) => api.get<{ items: FiscalMonth[]; payments: FiscalPayment[] }>(`/v2/fiscal/months?to=${to}`),
  liquidate: (period: string) => api.post<{ entry_id: number }>('/v2/fiscal/liquidate', { period }),
  undoLiquidation: (period: string, reason: string) => api.post<{ success: boolean }>('/v2/fiscal/liquidate/undo', { period, reason }),
  pay: (b: { form: string; period: string; payment_date: string; main: number; withholdings: number; fund_account_id: number; reference?: string | null }) =>
    api.post<{ id: number }>('/v2/fiscal/payments', b),
  voidPayment: (id: number, reason: string) => api.post<{ success: boolean }>(`/v2/fiscal/payments/${id}/void`, { reason }),
};

// ── Obligaciones patronales (021) ────────────────────────────────────────────
export type ObligationMode = 'real' | 'estimado';
export type FeeKind = 'domiciliado' | 'no_domiciliado';
export type ObligationPayeeKey = 'isss' | 'afp_confia' | 'afp_crecer' | 'afp_sin';

/** Lo que el usuario escribe para un mes: modo, renta variable por empleado y honorarios estimados. */
export interface ObligationInputs {
  mode?: ObligationMode;
  variable?: Record<string, { amount: number; note?: string }>;
  fees?: Array<{ name: string; kind: FeeKind; amount: number; note?: string }>;
}

export interface ObligationEmployee {
  employee_id: number; name: string; afp_name: 'confia' | 'crecer' | null; monthly_salary: number;
  /** Salario del mes (renta fija) */
  fixed: number;
  /** Horas extra, comisiones, bonos (renta variable) */
  variable: number;
  variable_note?: string | null;
  aguinaldo: number; gross: number; isss_employee: number; isss_employer: number; insaforp: number;
  afp_employee: number; afp_employer: number; isr: number; source: string;
}

export interface ObligationPayee {
  key: string; payee: string; concept: string;
  /** null: F-07 sin punto de partida de la posición fiscal */
  amount: number | null;
  paid?: number; due: string; detail?: string; parts?: Record<string, number> | null;
}

export interface ObligationPayment {
  id: number; payee_key: ObligationPayeeKey; payment_date: string; amount: number; reference: string | null;
  status: 'vigente' | 'anulado'; entry_id: number | null; created_by_name: string | null;
}

export interface EmployerObligations {
  period: string; mode: ObligationMode; emitted_payrolls: number; can_see_employees: boolean;
  settings: {
    isss_employee_rate: number; isss_employer_rate: number; isss_cap: number;
    afp_employee_rate: number; afp_employer_rate: number; afp_cap: number | null;
    insaforp_applies: boolean; insaforp_rate: number;
    fee_withholding_rate: number; fee_nonresident_rate: number; pago_a_cuenta_rate: number;
  };
  inputs: ObligationInputs; saved: boolean; saved_at: string | null; saved_by: string | null;
  employees: ObligationEmployee[];
  employee_totals: {
    count: number; gross: number; fixed: number; variable: number; isss_employee: number; isss_employer: number;
    insaforp: number; afp_employee: number; afp_employer: number; isr: number;
  };
  fees: {
    purchases: Array<{ id: number; supplier: string; document_type: string; document_number: string; issue_date: string; amount: number; withheld: number }>;
    manual: Array<{ name: string; kind: FeeKind; amount: number; rate: number; withheld: number; note?: string }>;
    withheld: number;
  };
  sales_net: number; fiscal_configured: boolean; payees: ObligationPayee[];
  total: number; total_pending: number; payments: ObligationPayment[]; due: string;
}

export const obligationsApi = {
  get: (month: string) => api.get<EmployerObligations>(`/v2/fiscal/obligations?month=${month.slice(0, 7)}`),
  preview: (month: string, inputs: ObligationInputs) => api.post<EmployerObligations>('/v2/fiscal/obligations/preview', { month: month.slice(0, 7), inputs }),
  save: (month: string, inputs: ObligationInputs) => api.put<{ success: boolean }>('/v2/fiscal/obligations', { month: month.slice(0, 7), inputs }),
  pay: (b: { payee_key: ObligationPayeeKey; period: string; payment_date: string; amount: number; fund_account_id: number; reference?: string | null }) =>
    api.post<{ id: number }>('/v2/fiscal/obligations/payments', { ...b, period: b.period.slice(0, 7) }),
  voidPayment: (id: number, reason: string) => api.post<{ success: boolean }>(`/v2/fiscal/obligations/payments/${id}/void`, { reason }),
};
