import { useMemo, useState } from 'react';
import { Icon } from '@/components/icons/Icon';
import { Field, Select } from '@/components/ui/Field';
import { KpiCard } from '@/components/ui/KpiCard';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { IVA_RATE, MONTHS } from '@/config/constants';
import { fmt, inPeriod, inYear, num } from '@/lib/utils/format';
import { useDataStore } from '@/stores/data.store';

/**
 * Inteligencia de Negocios — análisis del año seleccionado.
 *
 * Métricas locales (sin IA):
 *   - Ventas vs Compras anual y mensual
 *   - Top 10 proveedores y top 10 clientes por volumen
 *   - Distribución de gastos por sector
 *   - Tendencia mensual del IVA neto
 *   - Margen aproximado (ventas - compras)
 *
 * Sección "Asistente IA" — placeholder para integración futura con Claude API
 * vía Supabase Edge Function (no se puede llamar al LLM directamente desde el
 * cliente sin exponer la API key).
 */
export function InteligenciaNegociosPage() {
  const data = useDataStore(s => s.data);

  const aniosDisponibles = useMemo(() => {
    const set = new Set<number>();
    for (const v of data.ventasConsumidor) {
      const y = parseInt(v.fecha.slice(0, 4), 10);
      if (Number.isFinite(y)) set.add(y);
    }
    for (const v of data.ventasContribuyente) {
      const y = parseInt(v.fecha.slice(0, 4), 10);
      if (Number.isFinite(y)) set.add(y);
    }
    for (const c of data.compras) {
      const y = parseInt(c.fecha.slice(0, 4), 10);
      if (Number.isFinite(y)) set.add(y);
    }
    if (set.size === 0) set.add(new Date().getFullYear());
    return Array.from(set).sort((a, b) => b - a);
  }, [data]);

  const [year, setYear] = useState<number>(aniosDisponibles[0]);

  /* ───── Cálculos por año ───── */
  const yearStats = useMemo(() => {
    const vc = data.ventasConsumidor.filter(v => inYear(v.fecha, year));
    const vt = data.ventasContribuyente.filter(v => inYear(v.fecha, year));
    const cp = data.compras.filter(c => inYear(c.fecha, year));

    const totalVentasFCF = vc.reduce((s, r) => s + num(r.monto), 0);
    const totalVentasCCFGravado = vt.reduce((s, r) => s + num(r.gravado), 0);
    const totalVentasCCFExento = vt.reduce((s, r) => s + num(r.exento), 0);
    const totalVentas = totalVentasFCF + totalVentasCCFGravado + totalVentasCCFExento;

    const totalCompras = cp.reduce((s, r) => s + num(r.monto), 0);
    const totalIvaCredito = cp.reduce((s, r) => s + num(r.ivaCredito), 0);

    // IVA débito: 13% de las ventas gravadas (FE viene con IVA dentro, separamos; CCF base x 13%)
    const ivaDebitoFCF = totalVentasFCF * IVA_RATE / (1 + IVA_RATE);
    const ivaDebitoCCF = totalVentasCCFGravado * IVA_RATE;
    const ivaDebito = ivaDebitoFCF + ivaDebitoCCF;
    const ivaNeto = ivaDebito - totalIvaCredito;

    // Margen aproximado (no es ganancia neta, es contribución bruta)
    const baseVentas = totalVentasFCF / 1.13 + totalVentasCCFGravado + totalVentasCCFExento;
    const baseCompras = totalCompras - totalIvaCredito;
    const margenBruto = baseVentas - baseCompras;

    return {
      vc, vt, cp,
      totalVentasFCF,
      totalVentasCCF: totalVentasCCFGravado + totalVentasCCFExento,
      totalVentas,
      totalCompras,
      totalIvaCredito,
      ivaDebito,
      ivaNeto,
      margenBruto,
      countTransacciones: vc.length + vt.length + cp.length,
    };
  }, [data, year]);

  /* ───── Top proveedores ───── */
  const topProveedores = useMemo(() => {
    const map = new Map<string, { nombre: string; nrc: string; total: number; count: number }>();
    for (const c of data.compras) {
      if (!inYear(c.fecha, year)) continue;
      const key = c.nrc || c.proveedor;
      const cur = map.get(key) ?? { nombre: c.proveedor, nrc: c.nrc, total: 0, count: 0 };
      cur.total += num(c.monto);
      cur.count += 1;
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total).slice(0, 10);
  }, [data.compras, year]);

  /* ───── Top clientes (CCF) ───── */
  const topClientes = useMemo(() => {
    const map = new Map<string, { nombre: string; nrc: string; total: number; count: number }>();
    for (const v of data.ventasContribuyente) {
      if (!inYear(v.fecha, year)) continue;
      const key = v.nrc || v.cliente;
      const cur = map.get(key) ?? { nombre: v.cliente, nrc: v.nrc, total: 0, count: 0 };
      cur.total += num(v.gravado) + num(v.exento);
      cur.count += 1;
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total).slice(0, 10);
  }, [data.ventasContribuyente, year]);

  /* ───── Tendencia mensual (12 meses) ───── */
  const monthlyTrend = useMemo(() => {
    return Array.from({ length: 12 }, (_, mi) => {
      const ventasFCF = data.ventasConsumidor
        .filter(v => inPeriod(v.fecha, mi, year))
        .reduce((s, r) => s + num(r.monto), 0);
      const ventasCCF = data.ventasContribuyente
        .filter(v => inPeriod(v.fecha, mi, year))
        .reduce((s, r) => s + num(r.gravado) + num(r.exento), 0);
      const compras = data.compras
        .filter(c => inPeriod(c.fecha, mi, year))
        .reduce((s, r) => s + num(r.monto), 0);
      const ivaCred = data.compras
        .filter(c => inPeriod(c.fecha, mi, year))
        .reduce((s, r) => s + num(r.ivaCredito), 0);
      const ivaDeb = (ventasFCF * IVA_RATE / (1 + IVA_RATE))
        + (data.ventasContribuyente.filter(v => inPeriod(v.fecha, mi, year)).reduce((s, r) => s + num(r.gravado), 0) * IVA_RATE);
      return {
        label: MONTHS[mi].slice(0, 3),
        ventas: ventasFCF + ventasCCF,
        compras,
        ivaNeto: ivaDeb - ivaCred,
      };
    });
  }, [data, year]);
  const maxMonthly = Math.max(...monthlyTrend.map(d => Math.max(d.ventas, d.compras)), 1);

  /* ───── Distribución de gastos por sector ───── */
  const gastosPorSector = useMemo(() => {
    const sectores = new Map<string, number>();
    const labels: Record<string, string> = { '1': 'Industria', '2': 'Comercio', '3': 'Servicio' };
    for (const c of data.compras) {
      if (!inYear(c.fecha, year)) continue;
      const key = c.metadata?.sector ?? '?';
      const label = labels[key] ?? `Sector ${key}`;
      sectores.set(label, (sectores.get(label) ?? 0) + num(c.monto));
    }
    const total = Array.from(sectores.values()).reduce((s, v) => s + v, 0);
    return Array.from(sectores.entries())
      .map(([label, value]) => ({ label, value, pct: total > 0 ? (value / total) * 100 : 0 }))
      .sort((a, b) => b.value - a.value);
  }, [data.compras, year]);

  return (
    <div>
      <SectionHeader
        title="Inteligencia de Negocios"
        description="Análisis automático de tus ventas, costos y comportamiento de proveedores/clientes."
        actions={
          <Field label="Año">
            <Select value={year} onChange={e => setYear(parseInt(e.target.value, 10))}>
              {aniosDisponibles.map(y => <option key={y} value={y}>{y}</option>)}
            </Select>
          </Field>
        }
      />

      {/* KPIs anuales */}
      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', marginBottom: 'var(--s-5)' }}>
        <KpiCard label="Ventas totales" tone="primary" value={fmt(yearStats.totalVentas)} hint={`FCF ${fmt(yearStats.totalVentasFCF)} + CCF ${fmt(yearStats.totalVentasCCF)}`} />
        <KpiCard label="Compras totales" value={fmt(yearStats.totalCompras)} hint={`${yearStats.cp.length} documentos`} />
        <KpiCard label="Margen bruto" tone={yearStats.margenBruto >= 0 ? 'success' : 'danger'} value={fmt(yearStats.margenBruto)} hint="Base ventas − Base compras" />
        <KpiCard label="IVA neto del año" tone={yearStats.ivaNeto >= 0 ? 'danger' : 'success'} value={fmt(yearStats.ivaNeto)} hint={yearStats.ivaNeto >= 0 ? 'a pagar' : 'crédito a favor'} />
        <KpiCard label="Transacciones" value={String(yearStats.countTransacciones)} hint="movimientos totales" />
      </div>

      {/* Tendencia mensual */}
      <div className="chart-wrap" style={{ marginBottom: 'var(--s-5)' }}>
        <div className="chart-title">Tendencia mensual {year} — ventas vs. compras</div>
        <div className="bar-chart" style={{ height: 180 }}>
          {monthlyTrend.map((d, i) => (
            <div className="bar-group" key={i}>
              <div className="bars" style={{ height: 160 }}>
                <div className="bar" title={`Ventas: ${fmt(d.ventas)}`} style={{ height: `${(d.ventas / maxMonthly) * 150}px`, background: 'var(--brand-primary-500)' }} />
                <div className="bar" title={`Compras: ${fmt(d.compras)}`} style={{ height: `${(d.compras / maxMonthly) * 150}px`, background: 'var(--brand-accent-500)' }} />
              </div>
              <div className="bar-label">{d.label}</div>
            </div>
          ))}
        </div>
        <div className="chart-legend">
          <div className="legend-item"><div className="legend-dot" style={{ background: 'var(--brand-primary-500)' }} />Ventas</div>
          <div className="legend-item"><div className="legend-dot" style={{ background: 'var(--brand-accent-500)' }} />Compras</div>
        </div>
      </div>

      {/* Top proveedores y clientes */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 'var(--s-5)', marginBottom: 'var(--s-5)' }}>
        <RankingCard
          title="Top 10 proveedores"
          rows={topProveedores.map(p => ({ nombre: p.nombre, nrc: p.nrc, total: p.total, count: p.count }))}
          emptyMessage="Sin compras en este año."
          totalRef={yearStats.totalCompras}
          colorBar="var(--brand-accent-500)"
        />
        <RankingCard
          title="Top 10 clientes (CCF)"
          rows={topClientes.map(c => ({ nombre: c.nombre, nrc: c.nrc, total: c.total, count: c.count }))}
          emptyMessage="Sin ventas a contribuyentes en este año."
          totalRef={yearStats.totalVentasCCF}
          colorBar="var(--brand-primary-500)"
        />
      </div>

      {/* Distribución por sector + IVA neto mensual */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 'var(--s-5)', marginBottom: 'var(--s-5)' }}>
        <div className="chart-wrap">
          <div className="chart-title">Compras por sector</div>
          {gastosPorSector.length === 0
            ? <div style={{ color: 'var(--fg-3)', fontSize: 'var(--text-sm)' }}>Sin compras categorizadas en este año.</div>
            : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
                {gastosPorSector.map(s => (
                  <div key={s.label}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)', marginBottom: 4 }}>
                      <span>{s.label}</span>
                      <strong>{fmt(s.value)} <span style={{ color: 'var(--fg-3)', fontWeight: 400 }}>({s.pct.toFixed(1)}%)</span></strong>
                    </div>
                    <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ width: `${s.pct}%`, height: '100%', background: 'var(--brand-primary-500)' }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
        </div>

        <div className="chart-wrap">
          <div className="chart-title">IVA neto mensual</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--s-2)', height: 160 }}>
            {monthlyTrend.map((d, i) => {
              const max = Math.max(...monthlyTrend.map(x => Math.abs(x.ivaNeto)), 1);
              const h = Math.abs(d.ivaNeto) / max * 130;
              return (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <div style={{
                    width: 18,
                    height: `${h}px`,
                    background: d.ivaNeto >= 0 ? 'var(--danger)' : 'var(--success)',
                    borderRadius: '3px 3px 0 0',
                    minHeight: 2,
                  }} title={`${d.label}: ${fmt(d.ivaNeto)}`} />
                  <div style={{ fontSize: 10, color: 'var(--fg-3)' }}>{d.label}</div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 'var(--s-3)', fontSize: 'var(--text-xs)', color: 'var(--fg-3)' }}>
            <span style={{ color: 'var(--danger)' }}>■</span> a pagar &nbsp;&nbsp;
            <span style={{ color: 'var(--success)' }}>■</span> a favor
          </div>
        </div>
      </div>

      {/* Asistente IA — placeholder */}
      <div className="kpi-card" style={{ padding: 'var(--s-6)', background: 'var(--surface-2)' }}>
        <div style={{ display: 'flex', gap: 'var(--s-4)', alignItems: 'flex-start' }}>
          <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--brand-primary-100)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="trending-up" size={20} style={{ color: 'var(--brand-primary-700)' }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, marginBottom: 4 }}>
              Asistente IA (próxima fase)
            </div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-2)', marginBottom: 'var(--s-3)' }}>
              Próximamente podrás hacer preguntas en lenguaje natural sobre tu negocio:
              <ul style={{ marginTop: 8, marginBottom: 0, paddingLeft: 18 }}>
                <li>"¿Cuál fue mi proveedor más caro este año?"</li>
                <li>"¿Qué meses tuve más ganancia?"</li>
                <li>"¿Hay algún cliente que aporta más del 20% de mis ventas?"</li>
                <li>"Resúmeme la salud fiscal del año en 3 puntos"</li>
              </ul>
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-3)', padding: 'var(--s-2) var(--s-3)', background: 'var(--surface-1)', borderRadius: 'var(--r-md)', border: '1px solid var(--border)' }}>
              <strong>Cómo se implementará:</strong> Supabase Edge Function que reciba la pregunta + un resumen agregado de tus datos
              (sin exponer detalle individual), y llame al modelo de IA con tu API key guardada en variables del proyecto.
              Esto evita exponer la key en el navegador y mantiene la información sensible del lado servidor.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Card de ranking reusable ─────────── */
function RankingCard({
  title, rows, emptyMessage, totalRef, colorBar,
}: {
  title: string;
  rows: { nombre: string; nrc: string; total: number; count: number }[];
  emptyMessage: string;
  totalRef: number;
  colorBar: string;
}) {
  return (
    <div className="chart-wrap">
      <div className="chart-title">{title}</div>
      {rows.length === 0
        ? <div style={{ color: 'var(--fg-3)', fontSize: 'var(--text-sm)' }}>{emptyMessage}</div>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
            {rows.map((r, i) => {
              const pct = totalRef > 0 ? (r.total / totalRef) * 100 : 0;
              return (
                <div key={i}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)', marginBottom: 4, gap: 'var(--s-3)' }}>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.nombre}>
                      <strong style={{ color: 'var(--fg-3)', marginRight: 6 }}>{i + 1}.</strong>
                      {r.nombre}
                    </span>
                    <span style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                      <strong>{fmt(r.total)}</strong>
                      <span style={{ color: 'var(--fg-3)', fontSize: 'var(--text-xs)', marginLeft: 6 }}>
                        {pct.toFixed(1)}% · {r.count} doc.
                      </span>
                    </span>
                  </div>
                  <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: colorBar }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
    </div>
  );
}
