import { api } from '@/lib/api/client';

export interface PayrollSettings {
  isss_employee_rate: number; isss_employer_rate: number; isss_cap: number;
  afp_employee_rate: number; afp_employer_rate: number; afp_cap: number | null;
  insaforp_applies: boolean; insaforp_rate: number; minimum_wage: number; aguinaldo_exempt: number;
  workday_hours: number; overtime_surcharge: number; night_surcharge: number; holiday_surcharge: number; vacation_premium: number;
}
export interface IsrBracket { frequency: 'mensual' | 'quincenal'; tramo: number; lower_limit: number; rate: number; excess_over: number; fixed_fee: number }
export interface CostCenter {
  id: number; name: string; salary_account_id: number | null; isss_account_id: number | null; afp_account_id: number | null; is_active: boolean;
  salary_code: string | null; salary_name: string | null; isss_code: string | null; isss_name: string | null; afp_code: string | null; afp_name: string | null;
  employees: number;
}
export interface Employee {
  id: number; employee_code: string | null; first_name: string; last_name: string; full_name: string; dui: string | null; nit: string | null;
  isss_number: string | null; nup: string | null; afp_name: 'confia' | 'crecer' | null; birth_date: string | null; phone: string | null;
  email: string | null; address: string | null; position: string; cost_center_id: number; cost_center_name: string; hire_date: string;
  monthly_salary: number; pay_frequency: 'mensual' | 'quincenal'; payment_method: 'transferencia' | 'efectivo' | 'cheque';
  bank_name: string | null; bank_account: string | null; applies_isss: boolean; applies_afp: boolean; applies_isr: boolean;
  status: 'activo' | 'retirado'; termination_date: string | null; notes: string | null; paid_through: string | null;
}
export type EmployeeInput = Omit<Employee, 'id' | 'full_name' | 'cost_center_name' | 'status' | 'termination_date' | 'paid_through'>;

export interface Payroll {
  id: number; payroll_number: number | null; kind: 'ordinaria' | 'aguinaldo'; frequency: 'mensual' | 'quincenal';
  period_start: string; period_end: string; payment_date: string; status: 'borrador' | 'emitida' | 'anulada'; notes: string | null;
  employees: number; gross: number; isss_employee: number; afp_employee: number; isr: number; other_deductions: number; net: number;
  isss_employer: number; afp_employer: number; insaforp: number; journal_entry_id: number | null; paid_entry_id: number | null;
  paid_at: string | null; entry_number: number | null; paid_entry_number: number | null; created_by_name: string | null;
  emitted_by_name: string | null; void_reason: string | null;
}
export interface PayrollLine {
  id: number; employee_id: number; employee_name: string; employee_code: string | null; dui: string | null; nit: string | null;
  isss_number: string | null; nup: string | null; afp_name: string | null; position: string | null; cost_center_name: string;
  hire_date: string; monthly_salary: number; payment_method: string | null; bank_name: string | null; bank_account: string | null;
  period_days: number; absence_days: number; overtime_day_hours: number; overtime_night_hours: number; holiday_days: number; vacation: boolean;
  bonuses: number; bonuses_note: string | null; other_deductions: number; deductions_note: string | null;
  days_paid: number; aguinaldo_days: number; base_salary: number; overtime_pay: number; holiday_pay: number; vacation_pay: number;
  aguinaldo: number; gross: number; isss_base: number; isss_employee: number; afp_base: number; afp_employee: number; isr_base: number;
  isr: number; total_deductions: number; net: number; isss_employer: number; afp_employer: number; insaforp: number;
}
export interface TerminationCalc {
  employee_id: number; employee_name: string; dui: string | null; position: string; hire_date: string; monthly_salary: number;
  daily_salary: number; kind: string; termination_date: string; service_days: number; service_years: number; service_text: string;
  paid_through: string; pending_days: number; pending_salary: number; vacation_days: number; vacation_proportional: number;
  pending_vacation_periods: number; vacation_pending: number; vacation: number; aguinaldo_days: number; aguinaldo_period_days: number;
  aguinaldo: number; indemnity_base_salary: number; indemnity: number; indemnity_note: string; other_income: number; gross: number;
  isss_employee: number; afp_employee: number; isr_base: number; isr: number; other_deductions: number; total_deductions: number;
  net: number; isss_employer: number; afp_employer: number; minimum_wage: number;
}
export interface Termination {
  id: number; termination_number: number; employee_id: number; employee_name: string; kind: string; termination_date: string;
  reason: string | null; gross: number; net: number; status: 'registrada' | 'anulada'; detail: TerminationCalc;
  journal_entry_id: number | null; paid_entry_id: number | null; entry_number: number | null; paid_entry_number: number | null;
  void_reason: string | null;
}
export interface TerminationInput {
  employee_id: number; kind: string; termination_date: string; reason?: string | null;
  options: { paid_through?: string | null; include_vacation?: boolean; pending_vacation_periods?: number; include_aguinaldo?: boolean; other_income?: number; other_deductions?: number };
}

export const payrollApi = {
  settings: () => api.get<{ settings: PayrollSettings; isr_brackets: IsrBracket[] }>('/v2/payroll/settings'),
  saveSettings: (b: PayrollSettings) => api.put<{ success: boolean }>('/v2/payroll/settings', b),
  saveIsr: (frequency: string, rows: Array<Omit<IsrBracket, 'frequency' | 'tramo'>>) => api.put<{ success: boolean }>(`/v2/payroll/isr/${frequency}`, { rows }),
  costCenters: () => api.get<{ items: CostCenter[] }>('/v2/payroll/cost-centers').then(r => r.items),
  saveCostCenter: (id: number | null, b: { name: string; salary_account_id: number | null; isss_account_id: number | null; afp_account_id: number | null; is_active: boolean }) =>
    id ? api.put<{ success: boolean }>(`/v2/payroll/cost-centers/${id}`, b) : api.post<{ id: number }>('/v2/payroll/cost-centers', b),
  employees: (status?: string) => api.get<{ items: Employee[] }>(`/v2/payroll/employees${status ? `?status=${status}` : ''}`).then(r => r.items),
  saveEmployee: (id: number | null, b: EmployeeInput) =>
    id ? api.put<{ id: number }>(`/v2/payroll/employees/${id}`, b) : api.post<{ id: number }>('/v2/payroll/employees', b),
  payrolls: () => api.get<{ items: Payroll[] }>('/v2/payroll/payrolls').then(r => r.items),
  createPayroll: (b: { kind: string; frequency: string; period_start: string; period_end: string; payment_date: string; notes?: string | null }) =>
    api.post<{ id: number }>('/v2/payroll/payrolls', b),
  payroll: (id: number) => api.get<{ payroll: Payroll; lines: PayrollLine[] }>(`/v2/payroll/payrolls/${id}`),
  refresh: (id: number) => api.post<{ success: boolean }>(`/v2/payroll/payrolls/${id}/refresh`),
  updateLine: (id: number, b: Partial<Pick<PayrollLine, 'absence_days' | 'overtime_day_hours' | 'overtime_night_hours' | 'holiday_days' | 'vacation' | 'bonuses' | 'bonuses_note' | 'other_deductions' | 'deductions_note'>>) =>
    api.put<{ success: boolean }>(`/v2/payroll/lines/${id}`, b),
  removeLine: (id: number) => api.delete<{ success: boolean }>(`/v2/payroll/lines/${id}`),
  deletePayroll: (id: number) => api.delete<{ success: boolean }>(`/v2/payroll/payrolls/${id}`),
  emit: (id: number) => api.post<{ payroll_number: number }>(`/v2/payroll/payrolls/${id}/emit`),
  pay: (id: number, payment_date: string, fund_account_id: number) => api.post<{ entry_id: number }>(`/v2/payroll/payrolls/${id}/pay`, { payment_date, fund_account_id }),
  voidPayroll: (id: number, reason: string) => api.post<{ success: boolean }>(`/v2/payroll/payrolls/${id}/void`, { reason }),
  previewTermination: (b: TerminationInput) => api.post<TerminationCalc>('/v2/payroll/terminations/preview', b),
  registerTermination: (b: TerminationInput) => api.post<{ id: number }>('/v2/payroll/terminations', b),
  terminations: () => api.get<{ items: Termination[] }>('/v2/payroll/terminations').then(r => r.items),
  payTermination: (id: number, payment_date: string, fund_account_id: number) => api.post<{ entry_id: number }>(`/v2/payroll/terminations/${id}/pay`, { payment_date, fund_account_id }),
  voidTermination: (id: number, reason: string) => api.post<{ success: boolean }>(`/v2/payroll/terminations/${id}/void`, { reason }),
  f910: (year: number) => api.get<{ year: number; items: Array<{ employee_id: number; full_name: string; dui: string | null; nit: string | null; taxable_income: number; aguinaldo_and_other: number; isss: number; afp: number; isr: number }> }>(`/v2/payroll/reports/f910?year=${year}`),
};

export const KIND_LABEL: Record<string, string> = {
  despido_injustificado: 'Despido sin causa justificada', despido_justificado: 'Despido con causa justificada', renuncia: 'Renuncia voluntaria',
};
