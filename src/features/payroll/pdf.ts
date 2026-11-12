import jsPDF from 'jspdf';
import { dmy, money } from '@/features/accounting/format';
import type { Payroll, PayrollLine, TerminationCalc } from './api';
import { KIND_LABEL } from './api';

/**
 * Boletas de pago (dos por página) y finiquito de liquidación, generados en el
 * navegador desde los datos de la planilla (no se guardan).
 */

interface Company { name: string; nit?: string | null }

function header(doc: jsPDF, c: Company, title: string, sub: string, y: number) {
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  doc.text(c.name, 105, y, { align: 'center' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  if (c.nit) doc.text(`NIT ${c.nit}`, 105, y + 4, { align: 'center' });
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
  doc.text(title, 105, y + 9, { align: 'center' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  doc.text(sub, 105, y + 13, { align: 'center' });
}

function rows(doc: jsPDF, x: number, y: number, w: number, items: Array<[string, number | string]>, bold = false): number {
  doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(8);
  for (const [label, v] of items) {
    doc.text(label, x, y);
    doc.text(typeof v === 'number' ? money(v) : v, x + w, y, { align: 'right' });
    y += 4;
  }
  return y;
}

export function payslipsPdf(c: Company, p: Payroll, lines: PayrollLine[]): jsPDF {
  const doc = new jsPDF({ unit: 'mm', format: 'letter' });
  const period = p.kind === 'aguinaldo' ? `Aguinaldo ${p.period_end.slice(0, 4)}` : `Del ${dmy(p.period_start)} al ${dmy(p.period_end)}`;
  lines.forEach((l, i) => {
    if (i > 0 && i % 2 === 0) doc.addPage();
    const y0 = i % 2 === 0 ? 12 : 145;
    header(doc, c, 'BOLETA DE PAGO', `${period} · Planilla PL-${String(p.payroll_number ?? 0).padStart(5, '0')} · Pago ${dmy(p.payment_date)}`, y0);
    doc.setFontSize(8);
    let y = y0 + 20;
    doc.setFont('helvetica', 'bold'); doc.text(l.employee_name, 15, y);
    doc.setFont('helvetica', 'normal');
    doc.text(`${l.position ?? ''} · ${l.cost_center_name}`, 15, y + 4);
    doc.text(`DUI ${l.dui ?? '—'} · ISSS ${l.isss_number ?? '—'} · NUP ${l.nup ?? '—'}${l.afp_name ? ` (${l.afp_name.toUpperCase()})` : ''}`, 15, y + 8);
    doc.text(`Salario mensual ${money(l.monthly_salary)} · Días pagados ${l.days_paid}`, 200, y, { align: 'right' });
    y += 14;
    doc.setFont('helvetica', 'bold'); doc.text('DEVENGADO', 15, y); doc.text('DESCUENTOS', 112, y);
    const earn: Array<[string, number]> = [];
    if (l.base_salary) earn.push(['Salario', l.base_salary]);
    if (l.overtime_pay) earn.push([`Horas extra (${l.overtime_day_hours} d / ${l.overtime_night_hours} n)`, l.overtime_pay]);
    if (l.holiday_pay) earn.push([`Asuetos trabajados (${l.holiday_days})`, l.holiday_pay]);
    if (l.vacation_pay) earn.push(['Prima de vacaciones', l.vacation_pay]);
    if (l.aguinaldo) earn.push([`Aguinaldo (${l.aguinaldo_days} días)`, l.aguinaldo]);
    if (l.bonuses) earn.push([`Bonificaciones${l.bonuses_note ? ` (${l.bonuses_note})` : ''}`, l.bonuses]);
    const ded: Array<[string, number]> = [['ISSS', l.isss_employee], ['AFP', l.afp_employee], ['Renta', l.isr]];
    if (l.other_deductions) ded.push([`Otros${l.deductions_note ? ` (${l.deductions_note})` : ''}`, l.other_deductions]);
    const ye = rows(doc, 15, y + 5, 85, earn);
    const yd = rows(doc, 112, y + 5, 85, ded);
    y = Math.max(ye, yd) + 2;
    rows(doc, 15, y, 85, [['Total devengado', l.gross]], true);
    rows(doc, 112, y, 85, [['Total descuentos', l.total_deductions]], true);
    y += 8;
    doc.setFillColor(240, 247, 244); doc.rect(112, y - 4, 85, 7, 'F');
    rows(doc, 114, y, 81, [['LÍQUIDO A RECIBIR', l.net]], true);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7);
    doc.text(`Aportes patronales: ISSS ${money(l.isss_employer)} · AFP ${money(l.afp_employer)}${l.insaforp ? ` · INSAFORP ${money(l.insaforp)}` : ''}`, 15, y);
    if (l.payment_method === 'transferencia' && l.bank_account) doc.text(`Transferencia a ${l.bank_name ?? ''} ${l.bank_account}`, 15, y + 4);
    doc.line(40, y + 22, 100, y + 22); doc.text('Recibí conforme', 70, y + 26, { align: 'center' });
    if (i % 2 === 0) { doc.setDrawColor(200); doc.setLineDashPattern([1, 1], 0); doc.line(10, 139, 206, 139); doc.setLineDashPattern([], 0); doc.setDrawColor(0); }
  });
  return doc;
}

export function terminationPdf(c: Company, d: TerminationCalc, number?: number): jsPDF {
  const doc = new jsPDF({ unit: 'mm', format: 'letter' });
  header(doc, c, 'LIQUIDACIÓN Y FINIQUITO', `${KIND_LABEL[d.kind] ?? d.kind}${number ? ` · LQ-${String(number).padStart(5, '0')}` : ''}`, 15);
  let y = 38;
  doc.setFontSize(9);
  const info: Array<[string, string]> = [
    ['Empleado', d.employee_name], ['DUI', d.dui ?? '—'], ['Cargo', d.position], ['Fecha de ingreso', dmy(d.hire_date)],
    ['Fecha de retiro', dmy(d.termination_date)], ['Tiempo de servicio', d.service_text], ['Salario mensual', money(d.monthly_salary)],
  ];
  for (const [k, v] of info) { doc.setFont('helvetica', 'bold'); doc.text(k, 20, y); doc.setFont('helvetica', 'normal'); doc.text(v, 70, y); y += 5; }
  y += 4;
  doc.setFont('helvetica', 'bold'); doc.text('PRESTACIONES', 20, y); y += 6;
  y = rows(doc, 20, y, 175, [
    [`Salario pendiente (${d.pending_days} días, pagado hasta ${dmy(d.paid_through)})`, d.pending_salary],
    [`Vacación proporcional (${d.vacation_days} días)`, d.vacation_proportional],
    ...(d.vacation_pending ? [[`Vacaciones no gozadas (${d.pending_vacation_periods} período/s)`, d.vacation_pending] as [string, number]] : []),
    [`Aguinaldo proporcional (${d.aguinaldo_days} días × ${d.aguinaldo_period_days}/365)`, d.aguinaldo],
    [d.kind === 'renuncia' ? 'Prestación por renuncia voluntaria' : 'Indemnización', d.indemnity],
    ...(d.other_income ? [['Otros ingresos', d.other_income] as [string, number]] : []),
  ]);
  doc.setFontSize(7); doc.text(doc.splitTextToSize(d.indemnity_note, 175), 20, y); y += 8;
  y = rows(doc, 20, y, 175, [['TOTAL PRESTACIONES', d.gross]], true) + 4;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.text('DESCUENTOS', 20, y); y += 6;
  y = rows(doc, 20, y, 175, [['ISSS', d.isss_employee], ['AFP', d.afp_employee], ['Renta', d.isr], ...(d.other_deductions ? [['Otros', d.other_deductions] as [string, number]] : [])]);
  y = rows(doc, 20, y + 2, 175, [['TOTAL DESCUENTOS', d.total_deductions], ['LÍQUIDO A RECIBIR', d.net]], true) + 10;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  const text = `Yo, ${d.employee_name}, declaro haber recibido de ${c.name} la cantidad de ${money(d.net)} dólares de los Estados Unidos de América, ` +
    'en concepto de las prestaciones detalladas, y que no tengo nada más que reclamar por la relación laboral que nos unió.';
  doc.text(doc.splitTextToSize(text, 175), 20, y);
  y += 30;
  doc.line(25, y, 95, y); doc.line(120, y, 190, y);
  doc.text('Empleado', 60, y + 4, { align: 'center' }); doc.text('Empleador', 155, y + 4, { align: 'center' });
  return doc;
}

/**
 * Planilla completa (hoja carta horizontal): una fila por empleado con días,
 * devengado, descuentos de ley, líquido y aportes patronales, más los totales.
 * Es el respaldo firmado de la planilla que se archiva y se presenta al MTPS.
 */
export function payrollSummaryPdf(c: Company, p: Payroll, lines: PayrollLine[]): jsPDF {
  const doc = new jsPDF({ unit: 'mm', format: 'letter', orientation: 'landscape' });
  const W = 279.4;
  const aguinaldo = p.kind === 'aguinaldo';
  const period = aguinaldo ? `Aguinaldo ${p.period_end.slice(0, 4)}` : `Planilla ${p.frequency} del ${dmy(p.period_start)} al ${dmy(p.period_end)}`;
  const number = p.payroll_number ? `PL-${String(p.payroll_number).padStart(5, '0')}` : 'BORRADOR';
  const cols: Array<{ h: string; w: number; v: (l: PayrollLine) => string; t?: number }> = [
    { h: 'Empleado', w: 46, v: l => l.employee_name },
    { h: 'DUI', w: 19, v: l => l.dui ?? '—' },
    { h: aguinaldo ? 'Días agui.' : 'Días', w: 13, v: l => String(aguinaldo ? l.aguinaldo_days : l.days_paid) },
    { h: aguinaldo ? 'Aguinaldo' : 'Salario', w: 18, v: l => money(aguinaldo ? l.aguinaldo : l.base_salary) },
    { h: 'Extras', w: 15, v: l => money(l.overtime_pay + l.holiday_pay) },
    { h: 'Otros ingr.', w: 16, v: l => money(l.vacation_pay + l.bonuses) },
    { h: 'Devengado', w: 19, v: l => money(l.gross) },
    { h: 'ISSS', w: 14, v: l => money(l.isss_employee) },
    { h: 'AFP', w: 14, v: l => money(l.afp_employee) },
    { h: 'Renta', w: 15, v: l => money(l.isr) },
    { h: 'Otros desc.', w: 16, v: l => money(l.other_deductions) },
    { h: 'Líquido', w: 19, v: l => money(l.net) },
    { h: 'ISSS pat.', w: 15, v: l => money(l.isss_employer + l.insaforp) },
    { h: 'AFP pat.', w: 15, v: l => money(l.afp_employer) },
  ];
  const x0 = 12;
  const drawHead = (y: number) => {
    doc.setFillColor(31, 41, 55); doc.rect(x0, y - 4, W - 24, 6, 'F');
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(7);
    let x = x0 + 1;
    cols.forEach((col, i) => { doc.text(col.h, i < 2 ? x : x + col.w - 2, y, { align: i < 2 ? 'left' : 'right' }); x += col.w; });
    doc.setTextColor(0);
    return y + 6;
  };
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text(c.name, x0, 14);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  if (c.nit) doc.text(`NIT ${c.nit}`, x0, 18);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(aguinaldo ? 'PLANILLA DE AGUINALDO' : 'PLANILLA DE SUELDOS', W - 12, 14, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  doc.text(`${period} · ${number} · Pago ${dmy(p.payment_date)}`, W - 12, 18, { align: 'right' });
  let y = drawHead(28);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.2);
  for (const l of lines) {
    if (y > 190) { doc.addPage(); y = drawHead(16); doc.setFont('helvetica', 'normal'); doc.setFontSize(7.2); }
    let x = x0 + 1;
    cols.forEach((col, i) => {
      const txt = i === 0 ? doc.splitTextToSize(col.v(l), col.w - 2)[0] as string : col.v(l);
      doc.text(txt, i < 2 ? x : x + col.w - 2, y, { align: i < 2 ? 'left' : 'right' });
      x += col.w;
    });
    doc.setDrawColor(230); doc.line(x0, y + 1.5, W - 12, y + 1.5); doc.setDrawColor(0);
    y += 5;
  }
  const sum = (f: (l: PayrollLine) => number) => lines.reduce((s, l) => s + f(l), 0);
  const totals = [
    sum(l => (aguinaldo ? l.aguinaldo : l.base_salary)), sum(l => l.overtime_pay + l.holiday_pay), sum(l => l.vacation_pay + l.bonuses),
    p.gross, p.isss_employee, p.afp_employee, p.isr, p.other_deductions, p.net, p.isss_employer + p.insaforp, p.afp_employer,
  ];
  doc.setFont('helvetica', 'bold'); doc.line(x0, y - 2.5, W - 12, y - 2.5);
  doc.text(`TOTAL · ${lines.length} empleado(s)`, x0 + 1, y + 1);
  let x = x0 + 1 + cols.slice(0, 3).reduce((s, col) => s + col.w, 0);
  cols.slice(3).forEach((col, i) => { doc.text(money(totals[i]!), x + col.w - 2, y + 1, { align: 'right' }); x += col.w; });
  y += 9;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  doc.text(`Aportes patronales: ISSS ${money(p.isss_employer)} · AFP ${money(p.afp_employer)}${p.insaforp ? ` · INSAFORP ${money(p.insaforp)}` : ''} · `
    + `Costo total de la planilla ${money(p.gross + p.isss_employer + p.afp_employer + p.insaforp)}`, x0, y);
  if (p.status === 'anulada') { doc.setTextColor(185, 28, 28); doc.setFont('helvetica', 'bold'); doc.text(`ANULADA · ${p.void_reason ?? ''}`, x0, y + 5); doc.setTextColor(0); }
  y = Math.min(y + 24, 200);
  doc.setFont('helvetica', 'normal');
  doc.line(30, y, 100, y); doc.line(180, y, 250, y);
  doc.text('Elaboró', 65, y + 4, { align: 'center' }); doc.text('Autorizó', 215, y + 4, { align: 'center' });
  return doc;
}
