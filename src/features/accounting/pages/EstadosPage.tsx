import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Field';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { RouteTabs } from '@/components/ui/Tabs';
import { ErrorBanner, Loading } from '@/components/ui/Feedback';
import { downloadXlsx, type XlsxCell } from '@/lib/utils/xlsx';
import { api } from '@/lib/api/client';
import { accApi, subApi } from '../api';
import { useAccounts } from '../hooks';
import { dayBefore, yearRange } from '../dates';
import { dmy, money } from '../format';
import { DateRange, type Range } from '../components/DateRange';
import { balanceSheetReport, cashFlowReport, equityChangesReport, incomeStatementReport, rollUp, type Report } from '../statements';

export type Statement = 'situacion' | 'resultados' | 'patrimonio' | 'flujo';

interface Company {
  nombre_legal: string; nombre_comercial: string | null; nit: string | null; nrc: string | null;
  signatories: { legal_rep_name: string | null; legal_rep_title: string | null; accountant_name: string | null; accountant_license: string | null; auditor_name: string | null; auditor_license: string | null };
}

const shift = (iso: string, years: number) => `${Number(iso.slice(0, 4)) + years}${iso.slice(4)}`;

/** Estados financieros NIIF para las PYMES a partir del catálogo de la empresa. */
export function EstadosPage({ statement }: { statement: Statement }) {
  const [range, setRange] = useState<Range>(yearRange(new Date().getFullYear()));
  const [compare, setCompare] = useState<'none' | 'prev_year'>('prev_year');
  const accounts = useAccounts();
  const company = useQuery({ queryKey: ['acc', 'company'], queryFn: () => api.get<Company>('/v2/acc/company') });
  const funds = useQuery({ queryKey: ['acc', 'funds'], queryFn: subApi.fundAccounts });
  // Balance: incluye cierres. Resultados/flujo/patrimonio: sin partidas de cierre ni traslados.
  const withClosing = useQuery({ queryKey: ['acc', 'movements', range, 'all'], queryFn: () => accApi.movements(range.from, range.to) });
  const noClosing = useQuery({
    queryKey: ['acc', 'movements', range, 'noclose'],
    queryFn: () => api.get<{ items: Array<{ account_id: number; debit_before: number; credit_before: number; debit: number; credit: number }> }>(
      `/v2/acc/reports/movements?from=${range.from}&to=${range.to}&exclude_closing=1`).then(r => r.items),
  });
  const prevRange = { from: shift(range.from, -1), to: shift(range.to, -1) };
  const prev = useQuery({
    queryKey: ['acc', 'movements', prevRange, 'noclose'],
    enabled: compare === 'prev_year' && statement === 'resultados',
    queryFn: () => api.get<{ items: Array<{ account_id: number; debit_before: number; credit_before: number; debit: number; credit: number }> }>(
      `/v2/acc/reports/movements?from=${prevRange.from}&to=${prevRange.to}&exclude_closing=1`).then(r => r.items),
  });

  const report: Report | null = useMemo(() => {
    const acc = accounts.data;
    if (!acc) return null;
    if (statement === 'situacion') {
      if (!withClosing.data) return null;
      return balanceSheetReport(acc, rollUp(acc, withClosing.data), { start: `Al ${dmy(dayBefore(range.from))}`, end: `Al ${dmy(range.to)}` });
    }
    if (!noClosing.data) return null;
    const rows = rollUp(acc, noClosing.data);
    if (statement === 'resultados') {
      const periods = [rows];
      const cols = [`${dmy(range.from)} – ${dmy(range.to)}`];
      if (compare === 'prev_year' && prev.data) { periods.push(rollUp(acc, prev.data)); cols.push(`${dmy(prevRange.from)} – ${dmy(prevRange.to)}`); }
      return incomeStatementReport(acc, periods, cols);
    }
    if (statement === 'patrimonio') return equityChangesReport(acc, rows);
    return cashFlowReport(acc, rows, new Set((funds.data ?? []).map(f => f.id)));
  }, [accounts.data, withClosing.data, noClosing.data, prev.data, funds.data, statement, compare, range]);  // eslint-disable-line react-hooks/exhaustive-deps

  const loading = accounts.isLoading || (statement === 'situacion' ? withClosing.isLoading : noClosing.isLoading);
  const c = company.data;
  const periodText = statement === 'situacion' ? `Al ${dmy(range.to)}` : `Del ${dmy(range.from)} al ${dmy(range.to)}`;

  async function exportXlsx() {
    if (!report) return;
    const head: XlsxCell[][] = [
      [{ value: c?.nombre_legal ?? '', bold: true }],
      [{ value: [c?.nit ? `NIT ${c.nit}` : '', c?.nrc ? `NRC ${c.nrc}` : ''].filter(Boolean).join(' · ') }],
      [{ value: report.title, bold: true }],
      [{ value: `${periodText} · Cifras en dólares de los Estados Unidos de América` }],
      [],
      [{ value: 'Código', bold: true }, { value: 'Concepto', bold: true }, ...report.columns.map(col => ({ value: col, bold: true }))],
    ];
    const body: XlsxCell[][] = report.rows.map(r => [
      { value: r.code ?? '' },
      { value: r.label, bold: r.kind !== 'line', indent: r.indent },
      ...r.values.map(v => ({ value: v, bold: r.kind === 'total' || r.kind === 'subtotal' })),
    ]);
    await downloadXlsx(`${report.title} ${range.from} ${range.to}`, [{ name: report.title, rows: [...head, ...body], widths: [12, 52, ...report.columns.map(() => 18)] }]);
  }

  return (
    <div>
      <SectionHeader title="Estados financieros" description="NIIF para las PYMES, generados desde los asientos contabilizados." />
      <div className="no-print">
        <RouteTabs tabs={[
          { to: '/contabilidad/estados/situacion', label: 'Situación financiera' },
          { to: '/contabilidad/estados/resultados', label: 'Resultados' },
          { to: '/contabilidad/estados/patrimonio', label: 'Cambios en el patrimonio' },
          { to: '/contabilidad/estados/flujo', label: 'Flujo de efectivo' },
        ]} />
        <div className="toolbar">
          <DateRange value={range} onChange={setRange} />
        </div>
        <div className="toolbar">
          {statement === 'resultados' && (
            <Select value={compare} onChange={e => setCompare(e.target.value as 'none' | 'prev_year')} style={{ width: 240 }}>
              <option value="prev_year">Comparar con el año anterior</option>
              <option value="none">Sin comparativo</option>
            </Select>
          )}
          <Button variant="secondary" onClick={() => window.print()}>Imprimir / PDF</Button>
          <Button variant="secondary" onClick={() => void exportXlsx()} disabled={!report}>Exportar Excel</Button>
          {report?.checks?.map(ch => (
            <span key={ch.label} className={`badge ${ch.ok ? 'badge-success' : 'badge-warning'}`}><span className="badge-dot" />{ch.ok ? 'Cuadra' : 'No cuadra'}: {ch.label}</span>
          ))}
        </div>
      </div>
      <ErrorBanner error={accounts.error ?? withClosing.error ?? noClosing.error} />
      {loading || !report ? <Loading /> : (
        <div className="table-wrap" style={{ padding: 'var(--s-6)' }}>
          <div style={{ textAlign: 'center', marginBottom: 'var(--s-5)' }}>
            <div style={{ fontWeight: 700, fontSize: 'var(--text-lg)' }}>{c?.nombre_legal ?? ''}</div>
            {(c?.nit || c?.nrc) && <div className="muted" style={{ fontSize: 'var(--text-sm)' }}>{[c.nit ? `NIT ${c.nit}` : '', c.nrc ? `NRC ${c.nrc}` : ''].filter(Boolean).join(' · ')}</div>}
            <div style={{ fontWeight: 600, marginTop: 4 }}>{report.title}</div>
            <div className="muted" style={{ fontSize: 'var(--text-sm)' }}>{periodText} · Cifras en dólares de los Estados Unidos de América</div>
          </div>
          <table className="acc-table">
            <thead><tr><th style={{ width: 110 }}>Código</th><th>Concepto</th>{report.columns.map(col => <th key={col} className="num">{col}</th>)}</tr></thead>
            <tbody>
              {report.rows.map((r, i) => (
                <tr key={i} className={r.kind === 'total' ? 'total' : r.kind === 'subtotal' ? 'subtotal' : r.kind === 'section' ? 'major' : ''}>
                  <td className="code">{r.code ?? ''}</td>
                  <td style={{ paddingLeft: 10 + (r.indent ?? 0) * 18 }}>{r.label}</td>
                  {r.values.map((v, j) => <td key={j} className="num">{v === null ? '' : money(v)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          {c && <Signatures company={c} />}
        </div>
      )}
    </div>
  );
}

function Signatures({ company }: { company: Company }) {
  const s = company.signatories;
  const people = [
    s.legal_rep_name && { name: s.legal_rep_name, role: s.legal_rep_title || 'Representante legal' },
    s.accountant_name && { name: s.accountant_name, role: `Contador${s.accountant_license ? ` · ${s.accountant_license}` : ''}` },
    s.auditor_name && { name: s.auditor_name, role: `Auditor externo${s.auditor_license ? ` · ${s.auditor_license}` : ''}` },
  ].filter(Boolean) as Array<{ name: string; role: string }>;
  if (!people.length) {
    return <div className="muted no-print" style={{ fontSize: 'var(--text-xs)', marginTop: 'var(--s-6)' }}>
      Agrega los firmantes (representante legal, contador, auditor) en Contabilidad → Configuración contable.
    </div>;
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${people.length}, 1fr)`, gap: 32, marginTop: 72, textAlign: 'center' }}>
      {people.map(p => (
        <div key={p.role}>
          <div style={{ borderTop: '1px solid var(--fg-2)', paddingTop: 6, fontWeight: 600, fontSize: 'var(--text-sm)' }}>{p.name}</div>
          <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>{p.role}</div>
        </div>
      ))}
    </div>
  );
}
