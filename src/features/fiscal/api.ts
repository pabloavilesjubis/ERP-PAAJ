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
