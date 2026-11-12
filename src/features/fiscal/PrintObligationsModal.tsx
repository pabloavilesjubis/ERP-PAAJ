import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { ErrorBanner, Loading } from '@/components/ui/Feedback';
import { usePermissions } from '@/auth/usePermissions';
import { useBranding } from '@/branding/BrandingProvider';
import { todayIso } from '@/features/accounting/dates';
import { dmy, money } from '@/features/accounting/format';
import { payrollApi, type Payroll } from '@/features/payroll/api';
import type { EmployerObligations } from './api';
import { buildObligationsReportHTML, flowRows, payrollLabel, printLetter, type PayrollForFlow } from './obligationsReport';

/** Primer día del mes siguiente al de `iso` (AAAA-MM-01). */
const nextMonth = (iso: string, n = 1) => {
  const d = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

/**
 * Imprime las obligaciones del mes como hoja de flujo de caja, con las
 * planillas ya creadas si se quiere (la quincena que se paga junto con las
 * obligaciones): su líquido es una salida más junto a Hacienda, ISSS, AFP y honorarios.
 */
export function PrintObligationsModal({ data, unsaved, onClose }: { data: EmployerObligations; unsaved: boolean; onClose: () => void }) {
  const { can } = usePermissions();
  const branding = useBranding();
  const canPayroll = can('payroll:view');
  const [payrolls, setPayrolls] = useState<Payroll[] | null>(canPayroll ? null : []);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [withLines, setWithLines] = useState(true);
  const [includeFees, setIncludeFees] = useState(true);
  const [includeEmployees, setIncludeEmployees] = useState(data.can_see_employees);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Planillas del mes y del siguiente (la quincena que se paga junto con las obligaciones)
  useEffect(() => {
    if (!canPayroll) return;
    const from = data.period.slice(0, 10);
    const to = nextMonth(from, 2);
    payrollApi.payrolls()
      .then(all => {
        const list = all.filter(p => p.status !== 'anulada' && p.period_end >= from && p.period_end < to)
          .sort((a, b) => a.period_start.localeCompare(b.period_start));
        setPayrolls(list);
        // Las que aún no se pagan entran por defecto
        setSelected(new Set(list.filter(p => !p.paid_entry_id && p.payment_date >= todayIso()).map(p => p.id)));
      })
      .catch(setError);
  }, [canPayroll, data.period]);

  const chosen = useMemo(() => (payrolls ?? []).filter(p => selected.has(p.id)), [payrolls, selected]);
  const total = useMemo(() => flowRows(data, chosen.map(p => ({ payroll: p, lines: null })), includeFees).reduce((s, r) => s + r.toPay, 0),
    [data, chosen, includeFees]);

  const toggle = (id: number) => setSelected(s => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const print = async () => {
    setBusy(true);
    setError(null);
    try {
      const withDetail: PayrollForFlow[] = await Promise.all(chosen.map(async p =>
        ({ payroll: p, lines: withLines ? (await payrollApi.payroll(p.id)).lines : null })));
      printLetter(buildObligationsReportHTML(data, {
        payrolls: withDetail, includeFees, includeEmployees, unsaved,
        businessName: branding.legalName || branding.productName, logoUrl: branding.logoUrl,
      }));
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Imprimir flujo para obligaciones" onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
      <Button onClick={print} disabled={busy || !payrolls}>{busy ? 'Preparando…' : 'Imprimir'}</Button>
    </>}>
      <p className="muted" style={{ fontSize: 'var(--text-sm)', marginTop: 0 }}>Cuánto dinero sale por cada rubro: Hacienda, ISSS, AFP, honorarios y la planilla que elijas.</p>
      <ErrorBanner error={error} />
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Planillas a incluir</div>
      {!canPayroll ? (
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>Incluir planillas requiere permiso de Planillas.</p>
      ) : !payrolls ? <Loading /> : payrolls.length === 0 ? (
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>No hay planillas creadas de este mes ni del siguiente. Se crean en Planillas.</p>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {payrolls.map(p => (
            <label key={p.id} className="tax-card" style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 12px', margin: 0, cursor: 'pointer' }}>
              <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
              <span style={{ flex: 1 }}>
                <strong>{payrollLabel(p)}</strong>
                <span className="muted" style={{ display: 'block', fontSize: 'var(--text-xs)' }}>
                  {p.status === 'borrador' ? 'Borrador' : 'Emitida'}{p.paid_entry_id ? ' · pagada' : ''} · se paga el {dmy(p.payment_date)} · {p.employees} empleado(s)
                </span>
              </span>
              <strong className="num">${money(p.net)}</strong>
            </label>
          ))}
        </div>
      )}
      <div style={{ display: 'grid', gap: 4, margin: 'var(--s-4) 0' }}>
        {chosen.length > 0 && <label><input type="checkbox" checked={withLines} onChange={e => setWithLines(e.target.checked)} /> Líquido de cada empleado en la planilla</label>}
        {data.can_see_employees && data.employees.length > 0 && (
          <label><input type="checkbox" checked={includeEmployees} onChange={e => setIncludeEmployees(e.target.checked)} /> Tabla de ISSS, AFP y renta por empleado</label>
        )}
        {data.fees.manual.length > 0 && (
          <label><input type="checkbox" checked={includeFees} onChange={e => setIncludeFees(e.target.checked)} /> Pago neto de los honorarios estimados</label>
        )}
      </div>
      <div className="banner banner-info" style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
        <span>Total a desembolsar</span><span>${money(total)}</span>
      </div>
      {unsaved && <div className="banner banner-warning">Hay cifras sin guardar: se imprimen tal como están en pantalla y el reporte lo indica.</div>}
    </Modal>
  );
}
