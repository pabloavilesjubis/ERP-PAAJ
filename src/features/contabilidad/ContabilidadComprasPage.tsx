import { useMemo, useState } from 'react';
import { Icon } from '@/components/icons/Icon';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input, Select } from '@/components/ui/Field';
import { KpiCard } from '@/components/ui/KpiCard';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { displayDate, fmt, inDateRange, num } from '@/lib/utils/format';
import { useDataStore } from '@/stores/data.store';

/**
 * Vista contable de Compras: análisis con filtros independientes del selector
 * global (que vive en la barra superior). Permite filtrar por:
 *   - Proveedor (NRC)
 *   - Rango de fechas (desde / hasta)
 *   - Tipo de documento
 *   - Texto libre (descripción)
 */
export function ContabilidadComprasPage() {
  const data = useDataStore(s => s.data);

  const [proveedorNrc, setProveedorNrc] = useState<string>('all');
  const [tipoDoc, setTipoDoc] = useState<string>('all');
  const [desde, setDesde] = useState<string>('');
  const [hasta, setHasta] = useState<string>('');
  const [search, setSearch] = useState<string>('');

  const proveedoresUnicos = useMemo(() => {
    const map = new Map<string, { nrc: string; nombre: string }>();
    for (const c of data.compras) {
      if (c.nrc && !map.has(c.nrc)) map.set(c.nrc, { nrc: c.nrc, nombre: c.proveedor });
    }
    return Array.from(map.values()).sort((a, b) => a.nombre.localeCompare(b.nombre));
  }, [data.compras]);

  const tiposUnicos = useMemo(() => {
    const set = new Set<string>();
    for (const c of data.compras) {
      if (c.metadata?.tipoDocumento) set.add(c.metadata.tipoDocumento);
    }
    return Array.from(set).sort();
  }, [data.compras]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.compras
      .filter(c => proveedorNrc === 'all' || c.nrc === proveedorNrc)
      .filter(c => tipoDoc === 'all' || c.metadata?.tipoDocumento === tipoDoc)
      .filter(c => inDateRange(c.fecha, desde || undefined, hasta || undefined))
      .filter(c => !q
        || c.proveedor.toLowerCase().includes(q)
        || (c.descripcion ?? '').toLowerCase().includes(q)
        || c.nrc.toLowerCase().includes(q)
        || (c.metadata?.numeroDocumento ?? '').toLowerCase().includes(q))
      .sort((a, b) => b.fecha.localeCompare(a.fecha));
  }, [data.compras, proveedorNrc, tipoDoc, desde, hasta, search]);

  const totalMonto = filtered.reduce((s, r) => s + num(r.monto), 0);
  const totalIva = filtered.reduce((s, r) => s + num(r.ivaCredito), 0);
  const baseTotal = totalMonto - totalIva;

  function clearFilters() {
    setProveedorNrc('all');
    setTipoDoc('all');
    setDesde('');
    setHasta('');
    setSearch('');
  }

  return (
    <div>
      <SectionHeader
        title="Análisis de Compras"
        description="Filtra todas tus compras por proveedor, período y tipo de documento."
      />

      <div className="kpi-card" style={{ marginBottom: 'var(--s-5)', padding: 'var(--s-5)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--s-3)', alignItems: 'flex-end' }}>
          <Field label="Proveedor">
            <Select value={proveedorNrc} onChange={e => setProveedorNrc(e.target.value)}>
              <option value="all">Todos los proveedores ({proveedoresUnicos.length})</option>
              {proveedoresUnicos.map(p => (
                <option key={p.nrc} value={p.nrc}>{p.nombre} · {p.nrc}</option>
              ))}
            </Select>
          </Field>
          <Field label="Tipo de documento">
            <Select value={tipoDoc} onChange={e => setTipoDoc(e.target.value)}>
              <option value="all">Todos</option>
              {tiposUnicos.map(t => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
          <Field label="Desde">
            <Input type="date" value={desde} onChange={e => setDesde(e.target.value)} />
          </Field>
          <Field label="Hasta">
            <Input type="date" value={hasta} onChange={e => setHasta(e.target.value)} />
          </Field>
          <Field label="Buscar">
            <Input type="text" placeholder="Descripción / NRC / DTE…" value={search} onChange={e => setSearch(e.target.value)} />
          </Field>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={clearFilters}
            style={{ height: 36 }}
          >
            <Icon name="x" size={13} /> Limpiar
          </button>
        </div>
      </div>

      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 'var(--s-5)' }}>
        <KpiCard label="Registros" size="md" value={String(filtered.length)} hint="filas en la tabla" />
        <KpiCard label="Total compras" size="md" value={fmt(totalMonto)} hint="con IVA" />
        <KpiCard label="Base sin IVA" size="md" value={fmt(baseTotal)} hint="base imponible" />
        <KpiCard label="IVA crédito" tone="success" size="md" value={fmt(totalIva)} hint="acreditable" />
      </div>

      <div className="table-wrap">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Tipo</th>
                <th>Núm. Documento</th>
                <th>Proveedor</th>
                <th>NRC</th>
                <th>Descripción</th>
                <th className="num">Base</th>
                <th className="num">IVA</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={9}><EmptyState title="Sin resultados" description="Ajusta los filtros o limpia para ver todas las compras." /></td></tr>
              )}
              {filtered.map(r => {
                const m = r.metadata ?? {};
                const base = num(r.monto) - num(r.ivaCredito);
                const docCorto = m.numeroDocumento
                  ? (m.claseDocumento === '4' ? m.numeroDocumento.slice(0, 12) + '…' : m.numeroDocumento)
                  : '—';
                return (
                  <tr key={r.id}>
                    <td className="muted">{displayDate(r.fecha)}</td>
                    <td>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--fg-3)' }}>
                        {m.tipoDocumento ?? '—'}
                      </span>
                    </td>
                    <td><code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{docCorto}</code></td>
                    <td style={{ fontWeight: 500 }}>{r.proveedor}</td>
                    <td><code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--fg-3)' }}>{r.nrc}</code></td>
                    <td className="muted">{r.descripcion}</td>
                    <td className="num">{fmt(base)}</td>
                    <td className="num" style={{ color: 'var(--success-text)' }}>{fmt(r.ivaCredito)}</td>
                    <td className="num"><strong>{fmt(r.monto)}</strong></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length > 0 && (
          <div className="table-footer">
            <div className="table-totals">
              <div className="total-item">Base: <strong>{fmt(baseTotal)}</strong></div>
              <div className="total-item">IVA: <strong style={{ color: 'var(--success-text)' }}>{fmt(totalIva)}</strong></div>
              <div className="total-item">Total: <strong>{fmt(totalMonto)}</strong></div>
            </div>
            <div className="caption">{filtered.length} registros</div>
          </div>
        )}
      </div>
    </div>
  );
}
