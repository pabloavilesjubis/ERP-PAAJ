import { useMemo } from 'react';
import { KpiCard } from '@/components/ui/KpiCard';
import { MONTHS } from '@/config/constants';
import { useDataStore } from '@/stores/data.store';
import { usePeriodStore } from '@/stores/period.store';
import { computeTaxSummary } from '@/lib/utils/tax';
import { fmt, num, inPeriod } from '@/lib/utils/format';

export function DashboardPage() {
  const data = useDataStore(s => s.data);
  const { mode, month, year } = usePeriodStore();

  const summary = useMemo(
    () => computeTaxSummary({ ...data, month, year, mode }),
    [data, month, year, mode],
  );

  // En modo "Mes": chart de los últimos 6 meses.
  // En modo "Año": chart de los 12 meses del año seleccionado.
  const monthsData = useMemo(() => {
    if (mode === 'annual') {
      return Array.from({ length: 12 }, (_, mi) => {
        const vc = data.ventasConsumidor.filter(r => inPeriod(r.fecha, mi, year)).reduce((s, r) => s + num(r.monto), 0);
        const vt = data.ventasContribuyente.filter(r => inPeriod(r.fecha, mi, year)).reduce((s, r) => s + num(r.gravado) + num(r.exento), 0);
        const { cp, fin } = splitCompras(data.compras.filter(r => inPeriod(r.fecha, mi, year)));
        return { label: MONTHS[mi].slice(0, 3), total: vc + vt, cp, fin };
      });
    }
    return Array.from({ length: 6 }, (_, i) => {
      const offset = month - 5 + i;
      const mi = ((offset % 12) + 12) % 12;
      const yi = year + Math.floor(offset / 12);
      const vc = data.ventasConsumidor.filter(r => inPeriod(r.fecha, mi, yi)).reduce((s, r) => s + num(r.monto), 0);
      const vt = data.ventasContribuyente.filter(r => inPeriod(r.fecha, mi, yi)).reduce((s, r) => s + num(r.gravado) + num(r.exento), 0);
      const { cp, fin } = splitCompras(data.compras.filter(r => inPeriod(r.fecha, mi, yi)));
      return { label: MONTHS[mi].slice(0, 3), total: vc + vt, cp, fin };
    });
  }, [data, month, year, mode]);
  const maxVal = Math.max(...monthsData.map(d => Math.max(d.total, d.cp + d.fin)), 1);
  const finMes = useMemo(() => splitCompras(data.compras.filter(r => mode === 'annual'
    ? (r.fecha ?? '').startsWith(String(year)) : inPeriod(r.fecha, month, year))), [data, month, year, mode]);

  return (
    <div>
      <div className="kpi-grid">
        <KpiCard
          label="Ventas totales" tone="primary"
          value={fmt(summary.totalVentas)}
          hint={`Consumidor ${fmt(summary.totalVentasConsumidor)} + Contribuyente ${fmt(summary.totalVentasContribuyente)}`}
        />
        <KpiCard
          label="Total compras"
          value={fmt(summary.totalCompras)}
          hint={finMes.fin > 0
            ? <>Compras {fmt(finMes.cp)}<br />Gasto financiero {fmt(finMes.fin)}</>
            : `${summary.countCp} registros este mes`}
        />
        <KpiCard
          label="IVA débito (ventas)" tone="danger"
          value={fmt(summary.ivaDebito)}
          hint="13% sobre ventas gravadas"
        />
        <KpiCard
          label="IVA crédito (compras)" tone="success"
          value={fmt(summary.ivaCredito)}
          hint="Acreditable este mes"
        />
        <div className="kpi-card" style={{ border: '1px solid var(--brand-primary-200)', background: 'var(--brand-primary-50)' }}>
          <div className="kpi-label" style={{ color: 'var(--brand-primary-700)' }}>IVA a pagar</div>
          <div className="kpi-value" style={{ color: summary.ivaNeto > 0 ? 'var(--danger)' : 'var(--success-text)' }}>
            {fmt(Math.max(summary.ivaNeto, 0))}
          </div>
          <div className="kpi-sub">Débito − Crédito</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-5)', marginBottom: 'var(--s-5)' }}>
        <div className="tax-card">
          <div className="tax-card-title">Desglose de impuestos — {mode === 'annual' ? `Año ${year}` : `${MONTHS[month]} ${year}`}</div>
          <TaxRow label="Ventas al consumidor (gravadas)" sub={`Factura Electrónica · ${summary.countVc} registros`} value={fmt(summary.totalVentasConsumidor)} />
          <TaxRow label="Ventas al contribuyente (gravadas)" sub={`CCF · ${summary.countVt} registros`} value={fmt(summary.totalVentasContribuyenteGravado)} />
          <TaxRow label="IVA débito (13%)" sub="Ventas gravadas × 0.13" value={fmt(summary.ivaDebito)} variant="debit" />
          <TaxRow label="IVA crédito fiscal" sub="De compras registradas" value={`− ${fmt(summary.ivaCredito)}`} variant="credit" />
          {summary.ventasConRetencion > 0 && (
            <>
              <TaxRow
                label="Ventas con retención de Renta"
                sub={`${summary.countVtConRetencion} CCF · excluidas del 1.75%`}
                value={`− ${fmt(summary.ventasConRetencion)}`}
                variant="credit"
              />
              <TaxRow
                label="Retención de Renta acumulada"
                sub="ISR ya pagado vía retención por clientes"
                value={fmt(summary.totalRetenidoRenta)}
              />
            </>
          )}
          <TaxRow
            label="Pago a cuenta (1.75%)"
            sub={summary.ventasConRetencion > 0
              ? `Sobre base ${fmt(summary.basePagoACuenta)} (ventas − ventas retenidas)`
              : 'Anticipo impuesto sobre renta'}
            value={fmt(summary.pagoACuenta)}
            variant="debit"
          />
          <div className="tax-total-row">
            <div className="tax-total-label">Total a declarar (IVA + Pago a cuenta)</div>
            <div className="tax-total-value">{fmt(summary.totalDeclarar)}</div>
          </div>
        </div>

        <div className="chart-wrap">
          <div className="chart-title">Ventas vs. Compras — {mode === 'annual' ? `12 meses ${year}` : 'últimos 6 meses'}</div>
          <div className="bar-chart">
            {monthsData.map((d, i) => (
              <div className="bar-group" key={i}>
                <div className="bars">
                  <div className="bar" title={`Ventas: ${fmt(d.total)}`} style={{ height: `${(d.total / maxVal) * 110}px`, background: 'var(--brand-primary-500)' }} />
                  {/* Compras apiladas: gasto financiero arriba, en otro color */}
                  <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }} title={`Compras: ${fmt(d.cp)} · Gasto financiero: ${fmt(d.fin)}`}>
                    {d.fin > 0 && <div className="bar" style={{ height: `${(d.fin / maxVal) * 110}px`, background: 'var(--info)', borderRadius: d.cp > 0 ? '3px 3px 0 0' : undefined }} />}
                    {(d.cp > 0 || d.fin === 0) && <div className="bar" style={{ height: `${(d.cp / maxVal) * 110}px`, background: 'var(--brand-accent-500)', borderRadius: d.fin > 0 ? 0 : undefined }} />}
                  </div>
                </div>
                <div className="bar-label">{d.label}</div>
              </div>
            ))}
          </div>
          <div className="chart-legend">
            <div className="legend-item"><div className="legend-dot" style={{ background: 'var(--brand-primary-500)' }} />Ventas</div>
            <div className="legend-item"><div className="legend-dot" style={{ background: 'var(--brand-accent-500)' }} />Compras</div>
            {monthsData.some(d => d.fin > 0) && <div className="legend-item"><div className="legend-dot" style={{ background: 'var(--info)' }} />Gasto financiero</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function TaxRow({ label, sub, value, variant }: { label: string; sub?: string; value: string; variant?: 'credit' | 'debit' }) {
  return (
    <div className="tax-row">
      <div>
        <div className="tax-row-label">{label}</div>
        {sub && <div className="tax-row-sub">{sub}</div>}
      </div>
      <div className={`tax-row-value${variant ? ' ' + variant : ''}`}>{value}</div>
    </div>
  );
}

/** Compras del período separadas en compras normales y gasto financiero (intereses de bancos). */
function splitCompras(rows: Array<{ monto: string | number; metadata?: { categoria?: string; anulado?: boolean } }>): { cp: number; fin: number } {
  let cp = 0;
  let fin = 0;
  for (const r of rows) {
    if (r.metadata?.categoria === 'gasto_financiero') { if (!r.metadata?.anulado) fin += num(r.monto); }
    else cp += num(r.monto);
  }
  return { cp, fin };
}
