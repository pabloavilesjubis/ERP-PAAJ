/**
 * Flujo para obligaciones: hoja carta con las obligaciones patronales y
 * fiscales de un mes como salidas de dinero, rubro por rubro (Hacienda, ISSS,
 * cada AFP, honorarios y, si el usuario las incluye, los salarios líquidos de
 * las planillas ya creadas), lo ya pagado y lo que falta desembolsar. Imprime
 * lo que está en pantalla, guardado o no. Portado de ChuchoWash.
 */
import { dmy } from '@/features/accounting/format';
import type { Payroll, PayrollLine } from '@/features/payroll/api';
import type { EmployerObligations } from './api';

const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n: number | null | undefined) =>
  n == null ? '—' : `${n < 0 ? '-' : ''}$${Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const monthName = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const pct = (r: number, d = 2) => `${(r * 100).toFixed(d)} %`;
export const PART_LABEL: Record<string, string> = {
  anticipo: 'Anticipo (pago a cuenta)', isr_employees: 'Renta de empleados', isr_fees: 'Renta de honorarios',
  laboral: 'Laboral', patronal: 'Patronal', insaforp: 'INSAFORP', iva: 'IVA del mes', ret_iva: 'Retenciones de IVA',
};
export const AFP_LABEL: Record<string, string> = { confia: 'Confía', crecer: 'Crecer' };
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Una planilla que se paga en el mismo flujo, con sus líneas si se quiere el detalle */
export interface PayrollForFlow { payroll: Payroll; lines: PayrollLine[] | null }

export const payrollLabel = (p: Payroll) =>
  `${p.kind === 'aguinaldo' ? 'Aguinaldo' : `Planilla ${p.frequency}`} ${dmy(p.period_start)} – ${dmy(p.period_end)}${p.payroll_number ? ` · PL-${String(p.payroll_number).padStart(5, '0')}` : ''}`;

export interface FlowRow { item: string; payee: string; amount: number | null; paid: number; toPay: number; date: string | null; note?: string }

/** Todas las salidas de dinero del reporte, en el orden en que se listan */
export function flowRows(d: EmployerObligations, payrolls: PayrollForFlow[], includeFees: boolean): FlowRow[] {
  const rows: FlowRow[] = payrolls.map(({ payroll: p }) => {
    const paid = p.paid_entry_id ? Number(p.net) : 0;
    return {
      item: `Salarios líquidos · ${payrollLabel(p)}`, payee: `${p.employees} empleado(s)`, amount: Number(p.net), paid,
      toPay: r2(Number(p.net) - paid), date: p.payment_date, note: p.status === 'borrador' ? 'planilla en borrador' : undefined,
    };
  });
  for (const o of d.payees) {
    const paid = o.paid ?? 0;
    rows.push({ item: o.concept, payee: o.payee, amount: o.amount, paid, toPay: o.amount == null ? 0 : r2(Math.max(o.amount - paid, 0)), date: o.due,
      note: o.amount == null ? o.detail : undefined });
  }
  if (includeFees) {
    for (const f of d.fees.manual) {
      const net = r2(f.amount - f.withheld);
      rows.push({ item: 'Honorarios (neto, sin la retención)', payee: f.name || 'Honorario estimado', amount: net, paid: 0, toPay: net, date: null });
    }
  }
  return rows;
}

export function buildObligationsReportHTML(d: EmployerObligations, opts: {
  payrolls: PayrollForFlow[];
  includeFees: boolean;
  includeEmployees: boolean;
  unsaved: boolean;
  businessName?: string;
  logoUrl?: string | null;
  printedAt?: Date;
}): string {
  const rows = flowRows(d, opts.payrolls, opts.includeFees);
  const total = rows.reduce((s, r) => s + r.toPay, 0);
  const paid = rows.reduce((s, r) => s + r.paid, 0);
  const tot = d.employee_totals;
  const showEmployees = opts.includeEmployees && d.can_see_employees && d.employees.length > 0;
  const printed = opts.printedAt ?? new Date();
  const name = opts.businessName ?? 'Empresa';

  const payrollBlocks = opts.payrolls.map(({ payroll: p, lines }) => `
    <h2>${esc(payrollLabel(p))} <span class="tag">${p.status === 'borrador' ? 'BORRADOR' : 'EMITIDA'}${p.paid_entry_id ? ' · PAGADA' : ''}</span></h2>
    <table class="kv">
      <tr><td>Fecha de pago</td><td class="num">${dmy(p.payment_date)}</td><td>Devengado</td><td class="num">${money(p.gross)}</td></tr>
      <tr><td>ISSS laboral</td><td class="num">${money(p.isss_employee)}</td><td>AFP laboral</td><td class="num">${money(p.afp_employee)}</td></tr>
      <tr><td>Renta retenida</td><td class="num">${money(p.isr)}</td><td>Otros descuentos</td><td class="num">${money(p.other_deductions)}</td></tr>
      <tr class="strong"><td>Líquido a pagar a empleados</td><td class="num">${money(p.net)}</td>
        <td>Aportes patronales (ISSS + AFP${Number(p.insaforp) ? ' + INSAFORP' : ''})</td><td class="num">${money(Number(p.isss_employer) + Number(p.afp_employer) + Number(p.insaforp))}</td></tr>
    </table>
    <p class="hint">Las retenciones y los aportes de esta planilla se pagan al ISSS, las AFP y Hacienda con las obligaciones del mes de su período.</p>
    ${lines?.length ? `<table>
      <thead><tr><th>Empleado</th><th>Forma de pago</th><th class="num">Devengado</th><th class="num">Descuentos</th><th class="num">Líquido</th></tr></thead>
      <tbody>${lines.map(l => `<tr><td>${esc(l.employee_name)}</td><td>${esc([l.payment_method, l.bank_name, l.bank_account].filter(Boolean).join(' · ') || '—')}</td>
        <td class="num">${money(l.gross)}</td><td class="num">${money(Number(l.gross) - Number(l.net))}</td><td class="num"><b>${money(l.net)}</b></td></tr>`).join('')}</tbody>
    </table>` : ''}`).join('');

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/>
<title>Flujo para obligaciones ${esc(d.period.slice(0, 7))}</title>
<style>
  @page { size: letter; margin: 13mm 13mm 15mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a1a1a; font-size: 10.5px; margin: 0; }
  .top { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid #1f2937; padding-bottom: 8px; gap: 12px; }
  .top img { max-width: 170px; max-height: 48px; object-fit: contain; }
  .top .brand { font-size: 15px; font-weight: 700; }
  .top .who { text-align: right; font-size: 10px; color: #444; line-height: 1.4; }
  h1 { font-size: 20px; margin: 12px 0 0; color: #111827; }
  h1::first-letter, .sub::first-letter { text-transform: uppercase; }
  .sub { color: #555; font-size: 11px; }
  .badge { display: inline-block; margin: 6px 6px 0 0; font-size: 9.5px; font-weight: 700; letter-spacing: .05em; padding: 2px 8px; border-radius: 99px; background: #e5e7eb; color: #1f2937; }
  .badge.warn { background: #FDF0D5; color: #8A5A00; }
  .total { margin-top: 12px; display: flex; justify-content: space-between; align-items: center; background: #1f2937; color: #fff; border-radius: 10px; padding: 10px 14px; }
  .total b { font-size: 22px; }
  .total span { font-size: 11px; color: #d1d5db; }
  h2 { font-size: 12.5px; margin: 16px 0 6px; color: #111827; border-bottom: 1px solid #d1d5db; padding-bottom: 3px; }
  .tag { font-size: 9px; font-weight: 700; letter-spacing: .06em; color: #4b5563; margin-left: 4px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: .05em; color: #666; border-bottom: 1px solid #ccc; padding: 3px 4px; }
  td { padding: 3px 4px; border-bottom: 1px solid #eee; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  tfoot td { border-top: 1.5px solid #1a1a1a; border-bottom: 0; font-weight: 700; }
  .kv td { border: 0; padding: 2px 4px; }
  .kv .strong td { font-weight: 700; border-top: 1px solid #ccc; }
  .muted { color: #777; font-size: 9.5px; }
  .hint { color: #777; font-size: 9.5px; margin: 4px 0 6px; }
  .signs { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 36px; }
  .signs div { border-top: 1px solid #1a1a1a; padding-top: 4px; text-align: center; font-size: 10px; color: #444; }
  .foot { margin-top: 14px; font-size: 9px; color: #888; }
  .nobreak { break-inside: avoid; }
</style></head><body>
  <div class="top">
    ${opts.logoUrl ? `<img src="${esc(opts.logoUrl)}" alt="${esc(name)}"/>` : `<div class="brand">${esc(name)}</div>`}
    <div class="who"><b>${esc(name)}</b><br/>Obligaciones patronales y fiscales</div>
  </div>
  <h1>Flujo para obligaciones de ${esc(monthName(d.period))}</h1>
  <div class="sub">Dinero que sale para pagar al fisco, ISSS, AFP${opts.payrolls.length ? ', la planilla' : ''}${opts.includeFees && d.fees.manual.length ? ' y honorarios' : ''}.</div>
  <span class="badge${d.mode === 'estimado' ? ' warn' : ''}">${d.mode === 'estimado' ? 'ESTIMADO' : `CON ${d.emitted_payrolls} PLANILLA(S) EMITIDA(S)`}</span>
  ${opts.unsaved ? '<span class="badge warn">CIFRAS SIN GUARDAR</span>' : ''}
  ${!d.fiscal_configured ? '<span class="badge warn">IVA SIN PUNTO DE PARTIDA</span>' : ''}

  <div class="total"><span>Total a desembolsar${paid ? ` (ya pagado ${money(paid)})` : ''}</span><b>${money(total)}</b></div>

  <h2>Egresos por rubro</h2>
  <table>
    <thead><tr><th>Rubro</th><th>Pagar a</th><th class="num">Monto</th><th class="num">Ya pagado</th><th class="num">A desembolsar</th><th>Fecha</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td>${esc(r.item)}${r.note ? `<br/><span class="muted">${esc(r.note)}</span>` : ''}</td><td>${esc(r.payee)}</td>
      <td class="num">${money(r.amount)}</td><td class="num">${r.paid ? money(r.paid) : '—'}</td><td class="num"><b>${money(r.toPay)}</b></td>
      <td>${r.date ? `${dmy(r.date)}${r.payee === 'Hacienda' || r.payee === 'ISSS' || r.payee.startsWith('AFP') ? ' (aprox.)' : ''}` : '—'}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="4">Total a desembolsar</td><td class="num">${money(total)}</td><td></td></tr></tfoot>
  </table>

  <h2>Detalle de las obligaciones</h2>
  <table>
    <tbody>${d.payees.map(o => `<tr><td><b>${esc(o.payee)}</b> · ${esc(o.concept)}</td>
      <td class="muted">${o.parts ? Object.entries(o.parts).filter(([, v]) => v).map(([k, v]) => `${esc(PART_LABEL[k] ?? k)} ${money(v)}`).join(' · ') : esc(o.detail ?? '')}</td>
      <td class="num">${money(o.amount)}</td></tr>`).join('')}</tbody>
  </table>
  <p class="hint">Ventas netas del mes ${money(d.sales_net)} · anticipo ${pct(d.settings.pago_a_cuenta_rate)} ·
    ISSS ${pct(d.settings.isss_employee_rate)} + ${pct(d.settings.isss_employer_rate)} (tope ${money(d.settings.isss_cap)}) ·
    AFP ${pct(d.settings.afp_employee_rate)} + ${pct(d.settings.afp_employer_rate)}.</p>

  ${showEmployees ? `<div class="nobreak"><h2>Empleados del mes · renta fija y variable</h2>
  <table>
    <thead><tr><th>Empleado</th><th>AFP</th><th class="num">Fijo</th><th class="num">Variable</th><th class="num">Bruto</th>
      <th class="num">ISSS lab.</th><th class="num">ISSS pat.</th><th class="num">AFP lab.</th><th class="num">AFP pat.</th><th class="num">Renta</th></tr></thead>
    <tbody>${d.employees.map(e => `<tr><td>${esc(e.name)}</td><td>${esc(e.afp_name ? AFP_LABEL[e.afp_name] : '—')}</td>
      <td class="num">${money(e.fixed)}</td><td class="num">${money(e.variable + e.aguinaldo)}</td><td class="num">${money(e.gross)}</td>
      <td class="num">${money(e.isss_employee)}</td><td class="num">${money(e.isss_employer)}</td><td class="num">${money(e.afp_employee)}</td>
      <td class="num">${money(e.afp_employer)}</td><td class="num">${money(e.isr)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="2">${tot.count} empleado(s)</td><td class="num">${money(tot.fixed)}</td><td class="num">${money(tot.variable)}</td>
      <td class="num">${money(tot.gross)}</td><td class="num">${money(tot.isss_employee)}</td><td class="num">${money(tot.isss_employer)}</td>
      <td class="num">${money(tot.afp_employee)}</td><td class="num">${money(tot.afp_employer)}</td><td class="num">${money(tot.isr)}</td></tr></tfoot>
  </table></div>` : ''}

  ${d.fees.purchases.length || d.fees.manual.length ? `<div class="nobreak"><h2>Honorarios y servicios · retención de renta</h2>
  <table>
    <thead><tr><th>Persona / proveedor</th><th>Origen</th><th class="num">Monto</th><th class="num">Retención</th><th class="num">Neto a pagar</th></tr></thead>
    <tbody>
      ${d.fees.purchases.map(f => `<tr><td>${esc(f.supplier)}</td><td class="muted">Libro de compras · ${dmy(f.issue_date)}</td>
        <td class="num">${money(f.amount)}</td><td class="num">${money(f.withheld)}</td><td class="num muted">ya registrado</td></tr>`).join('')}
      ${d.fees.manual.map(f => `<tr><td>${esc(f.name || 'Honorario estimado')}</td><td class="muted">Estimado · ${f.kind === 'no_domiciliado' ? 'no domiciliado' : 'domiciliado'} ${pct(f.rate, 0)}</td>
        <td class="num">${money(f.amount)}</td><td class="num">${money(f.withheld)}</td><td class="num">${money(f.amount - f.withheld)}</td></tr>`).join('')}
    </tbody>
  </table></div>` : ''}

  ${payrollBlocks}

  <div class="signs"><div>Elaboró</div><div>Autorizó</div></div>
  <p class="foot">Estimación de apoyo para el flujo de caja: tasas y tabla de renta de Planillas → Configuración; los vencimientos son el 10.º día hábil
    del mes siguiente sin descontar asuetos. Impreso el ${esc(printed.toLocaleString('es-SV'))}.</p>
</body></html>`;
}

/** Imprime una hoja carta desde un iframe oculto (diálogo de impresión del navegador). */
export function printLetter(html: string) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:816px;height:1056px;border:0;';
  frame.addEventListener('load', () => {
    const win = frame.contentWindow;
    const img = frame.contentDocument?.images[0];
    const go = () => {
      win?.focus();
      win?.print();
      setTimeout(() => frame.remove(), 60_000);
    };
    // Espera el logo, pero nunca para siempre
    if (img && !img.complete) {
      const t = setTimeout(go, 4000);
      img.addEventListener('load', () => { clearTimeout(t); go(); }, { once: true });
      img.addEventListener('error', () => { clearTimeout(t); go(); }, { once: true });
    } else go();
  }, { once: true });
  frame.srcdoc = html;
  document.body.appendChild(frame);
}
