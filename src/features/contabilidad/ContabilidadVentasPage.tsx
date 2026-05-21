import { useMemo, useState } from 'react';
import { Icon } from '@/components/icons/Icon';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input, Select } from '@/components/ui/Field';
import { KpiCard } from '@/components/ui/KpiCard';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { IVA_RATE } from '@/config/constants';
import { displayDate, fmt, inDateRange, num } from '@/lib/utils/format';
import { useDataStore } from '@/stores/data.store';

type Tab = 'ccf' | 'fcf';

export function ContabilidadVentasPage() {
  const data = useDataStore(s => s.data);
  const [tab, setTab] = useState<Tab>('ccf');

  const totalCCF = data.ventasContribuyente.reduce((s, r) => s + num(r.gravado) + num(r.exento), 0);
  const totalFCF = data.ventasConsumidor.reduce((s, r) => s + num(r.monto), 0);

  return (
    <div>
      <SectionHeader
        title="Análisis de Ventas"
        description="Filtra todas tus ventas por cliente, período y tipo. Las pestañas separan ventas a contribuyentes (CCF) de ventas a consumidor final (FCF)."
      />

      <div className="tabs">
        <div className={`tab${tab === 'ccf' ? ' active' : ''}`} onClick={() => setTab('ccf')}>
          Ventas CCF (a contribuyentes)
          <span style={{ marginLeft: 8, fontSize: 'var(--text-xs)', color: 'var(--fg-4)' }}>
            {fmt(totalCCF)}
          </span>
        </div>
        <div className={`tab${tab === 'fcf' ? ' active' : ''}`} onClick={() => setTab('fcf')}>
          Ventas FCF (consumidor final)
          <span style={{ marginLeft: 8, fontSize: 'var(--text-xs)', color: 'var(--fg-4)' }}>
            {fmt(totalFCF)}
          </span>
        </div>
      </div>

      {tab === 'ccf' && <CcfTab />}
      {tab === 'fcf' && <FcfTab />}
    </div>
  );
}

/* ─────────── CCF (Ventas a contribuyente) ─────────── */
function CcfTab() {
  const data = useDataStore(s => s.data);
  const [clienteNrc, setClienteNrc] = useState<string>('all');
  const [desde, setDesde] = useState<string>('');
  const [hasta, setHasta] = useState<string>('');
  const [search, setSearch] = useState<string>('');

  const clientesUnicos = useMemo(() => {
    const map = new Map<string, { nrc: string; nombre: string }>();
    for (const v of data.ventasContribuyente) {
      if (v.nrc && !map.has(v.nrc)) map.set(v.nrc, { nrc: v.nrc, nombre: v.cliente });
    }
    return Array.from(map.values()).sort((a, b) => a.nombre.localeCompare(b.nombre));
  }, [data.ventasContribuyente]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.ventasContribuyente
      .filter(v => clienteNrc === 'all' || v.nrc === clienteNrc)
      .filter(v => inDateRange(v.fecha, desde || undefined, hasta || undefined))
      .filter(v => !q
        || v.cliente.toLowerCase().includes(q)
        || (v.descripcion ?? '').toLowerCase().includes(q)
        || v.nrc.toLowerCase().includes(q)
        || (v.metadata?.numeroDocumento ?? '').toLowerCase().includes(q))
      .sort((a, b) => b.fecha.localeCompare(a.fecha));
  }, [data.ventasContribuyente, clienteNrc, desde, hasta, search]);

  const totalGravado = filtered.reduce((s, r) => s + num(r.gravado), 0);
  const totalExento = filtered.reduce((s, r) => s + num(r.exento), 0);
  const totalIva = totalGravado * IVA_RATE;

  return (
    <div>
      <FilterCard>
        <Field label="Cliente">
          <Select value={clienteNrc} onChange={e => setClienteNrc(e.target.value)}>
            <option value="all">Todos los clientes ({clientesUnicos.length})</option>
            {clientesUnicos.map(c => (
              <option key={c.nrc} value={c.nrc}>{c.nombre} · {c.nrc}</option>
            ))}
          </Select>
        </Field>
        <Field label="Desde"><Input type="date" value={desde} onChange={e => setDesde(e.target.value)} /></Field>
        <Field label="Hasta"><Input type="date" value={hasta} onChange={e => setHasta(e.target.value)} /></Field>
        <Field label="Buscar">
          <Input type="text" placeholder="Cliente / NRC / DTE / desc." value={search} onChange={e => setSearch(e.target.value)} />
        </Field>
        <ClearButton onClick={() => { setClienteNrc('all'); setDesde(''); setHasta(''); setSearch(''); }} />
      </FilterCard>

      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 'var(--s-5)' }}>
        <KpiCard label="Registros" size="md" value={String(filtered.length)} hint="CCF emitidos" />
        <KpiCard label="Ventas gravadas" tone="primary" size="md" value={fmt(totalGravado)} hint="base sin IVA" />
        <KpiCard label="Ventas exentas" size="md" value={fmt(totalExento)} hint="sin IVA aplicable" />
        <KpiCard label="IVA débito" tone="danger" size="md" value={fmt(totalIva)} hint="13% sobre gravadas" />
      </div>

      <div className="table-wrap">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Fecha</th><th>Tipo</th><th>Núm. Documento</th>
                <th>Cliente</th><th>NRC</th><th>Descripción</th>
                <th className="num">Gravado</th><th className="num">Exento</th><th className="num">IVA débito</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={9}><EmptyState title="Sin resultados" description="Ajusta los filtros." /></td></tr>
              )}
              {filtered.map(r => {
                const m = r.metadata ?? {};
                const docCorto = m.numeroDocumento
                  ? (m.claseDocumento === '4' ? m.numeroDocumento.slice(0, 12) + '…' : m.numeroDocumento)
                  : '—';
                return (
                  <tr key={r.id}>
                    <td className="muted">{displayDate(r.fecha)}</td>
                    <td><span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--fg-3)' }}>{m.tipoDocumento ?? '03'}</span></td>
                    <td><code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{docCorto}</code></td>
                    <td style={{ fontWeight: 500 }}>{r.cliente}</td>
                    <td><code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--fg-3)' }}>{r.nrc}</code></td>
                    <td className="muted">{r.descripcion}</td>
                    <td className="num">{fmt(r.gravado)}</td>
                    <td className="num muted">{fmt(r.exento)}</td>
                    <td className="num" style={{ color: 'var(--danger-text)' }}>{fmt(num(r.gravado) * IVA_RATE)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length > 0 && (
          <div className="table-footer">
            <div className="table-totals">
              <div className="total-item">Gravado: <strong>{fmt(totalGravado)}</strong></div>
              <div className="total-item">Exento: <strong>{fmt(totalExento)}</strong></div>
              <div className="total-item">IVA débito: <strong style={{ color: 'var(--danger-text)' }}>{fmt(totalIva)}</strong></div>
            </div>
            <div className="caption">{filtered.length} registros</div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────── FCF (Factura a Consumidor Final / FE) ─────────── */
function FcfTab() {
  const data = useDataStore(s => s.data);
  const [vendedor, setVendedor] = useState<string>('all');
  const [desde, setDesde] = useState<string>('');
  const [hasta, setHasta] = useState<string>('');
  const [search, setSearch] = useState<string>('');

  const vendedoresUnicos = useMemo(() => {
    const set = new Set<string>();
    for (const v of data.ventasConsumidor) {
      const vd = v.metadata?.autorizadoPor;
      if (vd) set.add(vd);
    }
    return Array.from(set).sort();
  }, [data.ventasConsumidor]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.ventasConsumidor
      .filter(v => vendedor === 'all' || v.metadata?.autorizadoPor === vendedor)
      .filter(v => inDateRange(v.fecha, desde || undefined, hasta || undefined))
      .filter(v => !q
        || (v.descripcion ?? '').toLowerCase().includes(q)
        || (v.metadata?.cliente ?? '').toLowerCase().includes(q)
        || (v.metadata?.numeroControl ?? '').toLowerCase().includes(q))
      .sort((a, b) => b.fecha.localeCompare(a.fecha));
  }, [data.ventasConsumidor, vendedor, desde, hasta, search]);

  const totalMonto = filtered.reduce((s, r) => s + num(r.monto), 0);
  const totalIva = totalMonto * IVA_RATE / (1 + IVA_RATE);
  const baseTotal = totalMonto - totalIva;

  return (
    <div>
      <FilterCard>
        <Field label="Vendedor">
          <Select value={vendedor} onChange={e => setVendedor(e.target.value)}>
            <option value="all">Todos los vendedores ({vendedoresUnicos.length})</option>
            {vendedoresUnicos.map(v => <option key={v} value={v}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Desde"><Input type="date" value={desde} onChange={e => setDesde(e.target.value)} /></Field>
        <Field label="Hasta"><Input type="date" value={hasta} onChange={e => setHasta(e.target.value)} /></Field>
        <Field label="Buscar">
          <Input type="text" placeholder="Cliente / DTE / descripción…" value={search} onChange={e => setSearch(e.target.value)} />
        </Field>
        <ClearButton onClick={() => { setVendedor('all'); setDesde(''); setHasta(''); setSearch(''); }} />
      </FilterCard>

      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 'var(--s-5)' }}>
        <KpiCard label="Registros" size="md" value={String(filtered.length)} hint="FE emitidas" />
        <KpiCard label="Total ventas" tone="primary" size="md" value={fmt(totalMonto)} hint="con IVA" />
        <KpiCard label="Base sin IVA" size="md" value={fmt(baseTotal)} hint="base imponible" />
        <KpiCard label="IVA débito" tone="danger" size="md" value={fmt(totalIva)} hint="contenido en ventas" />
      </div>

      <div className="table-wrap">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Fecha</th><th>Hora</th><th>DTE</th>
                <th>Vendedor</th><th>Cliente</th><th>Descripción</th>
                <th className="num">Subtotal</th><th className="num">IVA</th><th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={9}><EmptyState title="Sin resultados" description="Ajusta los filtros." /></td></tr>
              )}
              {filtered.map(r => {
                const m = r.metadata ?? {};
                const total = num(r.monto);
                const subtotal = m.subtotal != null ? num(m.subtotal) : total / 1.13;
                const iva = m.iva != null ? num(m.iva) : total - subtotal;
                return (
                  <tr key={r.id}>
                    <td className="muted">{displayDate(r.fecha)}</td>
                    <td className="muted">{m.hora ?? ''}</td>
                    <td>
                      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--fg-3)' }}>
                        {m.numeroControl ? m.numeroControl.replace(/^DTE-\d+-[^-]+-/, '#') : '—'}
                      </code>
                    </td>
                    <td>{m.autorizadoPor ?? ''}</td>
                    <td>{m.cliente || <span style={{ color: 'var(--fg-4)' }}>Consumidor final</span>}</td>
                    <td className="muted">{r.descripcion}</td>
                    <td className="num">{fmt(subtotal)}</td>
                    <td className="num" style={{ color: 'var(--danger-text)' }}>{fmt(iva)}</td>
                    <td className="num"><strong>{fmt(total)}</strong></td>
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
              <div className="total-item">IVA: <strong style={{ color: 'var(--danger-text)' }}>{fmt(totalIva)}</strong></div>
              <div className="total-item">Total: <strong>{fmt(totalMonto)}</strong></div>
            </div>
            <div className="caption">{filtered.length} registros</div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────── helpers UI compartidos ─────────── */
function FilterCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="kpi-card" style={{ marginBottom: 'var(--s-5)', padding: 'var(--s-5)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--s-3)', alignItems: 'flex-end' }}>
        {children}
      </div>
    </div>
  );
}

function ClearButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="btn btn-secondary btn-sm" onClick={onClick} style={{ height: 36 }}>
      <Icon name="x" size={13} /> Limpiar
    </button>
  );
}
