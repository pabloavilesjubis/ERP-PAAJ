import { describe, expect, it } from 'vitest';
import type { Payroll } from '@/features/payroll/api';
import type { EmployerObligations } from './api';
import { buildObligationsReportHTML, flowRows } from './obligationsReport';

const data = {
  period: '2026-10-01', mode: 'estimado', emitted_payrolls: 0, can_see_employees: true,
  settings: { isss_employee_rate: 0.03, isss_employer_rate: 0.075, isss_cap: 1000, afp_employee_rate: 0.0725, afp_employer_rate: 0.0875,
    afp_cap: null, insaforp_applies: false, insaforp_rate: 0.01, fee_withholding_rate: 0.1, fee_nonresident_rate: 0.2, pago_a_cuenta_rate: 0.0175 },
  inputs: {}, saved: false, saved_at: null, saved_by: null, employees: [],
  employee_totals: { count: 0, gross: 0, fixed: 0, variable: 0, isss_employee: 0, isss_employer: 0, insaforp: 0, afp_employee: 0, afp_employer: 0, isr: 0 },
  fees: { purchases: [], manual: [{ name: 'Contador', kind: 'domiciliado', amount: 300, rate: 0.1, withheld: 30 }], withheld: 30 },
  sales_net: 1000, fiscal_configured: true, payments: [],
  payees: [
    { key: 'f07', payee: 'Hacienda', concept: 'IVA (F-07)', amount: 100, paid: 40, due: '2026-11-13' },
    { key: 'f14', payee: 'Hacienda', concept: 'F-14', amount: 50, paid: 0, due: '2026-11-13' },
    { key: 'isss', payee: 'ISSS', concept: 'Planilla ISSS', amount: 80, paid: 0, due: '2026-11-13' },
  ],
  total: 230, total_pending: 190, due: '2026-11-13',
} as EmployerObligations;

const quincena = {
  id: 1, payroll_number: null, kind: 'ordinaria', frequency: 'quincenal', period_start: '2026-11-01', period_end: '2026-11-15',
  payment_date: '2026-11-15', status: 'borrador', employees: 3, gross: 1150, isss_employee: 34.5, afp_employee: 83.38, isr: 10,
  other_deductions: 0, net: 1022.12, isss_employer: 86.25, afp_employer: 100.63, insaforp: 0, paid_entry_id: null,
} as Payroll;

describe('flujo para obligaciones', () => {
  it('lista cada salida: el líquido de la planilla, lo que falta pagar y el neto de los honorarios', () => {
    const rows = flowRows(data, [{ payroll: quincena, lines: null }], true);
    expect(rows.map(r => r.toPay)).toEqual([1022.12, 60, 50, 80, 270]);
    expect(rows.reduce((s, r) => s + r.toPay, 0)).toBeCloseTo(1482.12, 2);
  });
  it('deja fuera la planilla y los honorarios si no se eligen', () => {
    expect(flowRows(data, [], false).reduce((s, r) => s + r.toPay, 0)).toBe(190);
  });
  it('una planilla ya pagada no suma a lo que falta desembolsar', () => {
    const rows = flowRows(data, [{ payroll: { ...quincena, status: 'emitida', paid_entry_id: 9 }, lines: null }], false);
    expect(rows[0]!.toPay).toBe(0);
    expect(rows[0]!.paid).toBe(1022.12);
  });
  it('imprime el total y marca la planilla en borrador y las cifras sin guardar', () => {
    const html = buildObligationsReportHTML(data, { payrolls: [{ payroll: quincena, lines: null }], includeFees: true, includeEmployees: true, unsaved: true, businessName: 'Empresa <Demo>' });
    expect(html).toContain('$1,482.12');
    expect(html).toContain('BORRADOR');
    expect(html).toContain('CIFRAS SIN GUARDAR');
    expect(html).toContain('size: letter');
    expect(html).toContain('Empresa &lt;Demo&gt;');
    expect(html).toContain('octubre 2026');
  });
});
