import { useRef, useState } from 'react';
import { Icon } from '@/components/icons/Icon';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input } from '@/components/ui/Field';
import { KpiCard } from '@/components/ui/KpiCard';
import { Modal } from '@/components/ui/Modal';
import { RowActions } from '@/components/ui/RowActions';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { SyncDtesButton } from '@/components/dte/SyncDtesButton';
import { DteCell } from '@/components/dte/DteCell';
import { IVA_RATE, MONTHS } from '@/config/constants';
import { displayDate, fmt, inPeriod, matchesPeriod, newId, num } from '@/lib/utils/format';
import { dedupePosImports, parsePosCsv } from '@/lib/utils/csv-pos-importer';
import {
  buildAnexoConsumidorFinal, downloadReporte, makeReporteFromAnexo,
} from '@/lib/utils/anexo-consumidor-final';
import { useDataStore } from '@/stores/data.store';
import { usePeriodStore } from '@/stores/period.store';
import type { ReporteGenerado, VentaConsumidor } from '@/types/domain';

const empty: Omit<VentaConsumidor, 'id'> = { fecha: '', descripcion: '', monto: '', notas: '' };

interface ImportSummary {
  imported: number;
  duplicates: number;
  skippedCCF: number;
  skippedOther: number;
  skippedEmpty: number;
  errors: number;
  detectedTipos: string[];
  diagnostics: {
    delimiter: string;
    totalRows: number;
    headers: string[];
    columnMap: Record<string, number | string>;
    sampleFirstRow: Record<string, string>;
  };
}

type Tab = 'movimientos' | 'reportes';

export function VentasConsumidorPage() {
  const data = useDataStore(s => s.data);
  const setCollection = useDataStore(s => s.set);
  const { mode, month, year } = usePeriodStore();
  const [tab, setTab] = useState<Tab>('movimientos');

  return (
    <div>
      <SectionHeader
        title="Ventas al consumidor"
        description={`Facturas Electrónicas (FE) — ${mode === 'annual' ? `Año ${year}` : `${MONTHS[month]} ${year}`}`}
        actions={<SyncDtesButton />}
      />

      <div className="tabs">
        <div className={`tab${tab === 'movimientos' ? ' active' : ''}`} onClick={() => setTab('movimientos')}>
          Movimientos
        </div>
        <div className={`tab${tab === 'reportes' ? ' active' : ''}`} onClick={() => setTab('reportes')}>
          Reportes generados
        </div>
      </div>

      {tab === 'movimientos' && <MovimientosTab data={data} setCollection={setCollection} mode={mode} month={month} year={year} />}
      {tab === 'reportes' && <ReportesTab data={data} setCollection={setCollection} mode={mode} month={month} year={year} />}
    </div>
  );
}

/* ═══════════════════════════ MOVIMIENTOS ═══════════════════════════ */

interface MovimientosProps {
  data: ReturnType<typeof useDataStore.getState>['data'];
  setCollection: ReturnType<typeof useDataStore.getState>['set'];
  mode: 'monthly' | 'annual';
  month: number;
  year: number;
}

function MovimientosTab({ data, setCollection, mode, month, year }: MovimientosProps) {
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...empty });
  const [importing, setImporting] = useState(false);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const rows = data.ventasConsumidor.filter(r => matchesPeriod(r.fecha, mode, month, year));
  const totalMonto = rows.reduce((s, r) => s + num(r.monto), 0);
  const totalIva = totalMonto * IVA_RATE;
  const hasPosData = rows.some(r => r.metadata?.source === 'pos');

  function openNew() {
    setForm({ ...empty, fecha: `${year}-${String(month + 1).padStart(2, '0')}-01` });
    setEditId(null); setShowModal(true);
  }
  function openEdit(r: VentaConsumidor) {
    setForm({ fecha: r.fecha, descripcion: r.descripcion, monto: r.monto, notas: r.notas ?? '' });
    setEditId(r.id); setShowModal(true);
  }

  async function save() {
    // Re-entry guard: previene duplicados por doble-click.
    if (isSaving) return;
    if (!form.fecha || !form.monto) return;
    setIsSaving(true);
    try {
      const next = editId
        ? data.ventasConsumidor.map(r => r.id === editId ? { ...r, ...form } : r)
        : [...data.ventasConsumidor, { id: newId(), ...form }];
      await setCollection('ventasConsumidor', next);
      setShowModal(false);
    } finally {
      setIsSaving(false);
    }
  }
  async function del(id: string) {
    await setCollection('ventasConsumidor', data.ventasConsumidor.filter(r => r.id !== id));
  }

  async function handlePosFile(file: File) {
    setImporting(true);
    setImportSummary(null);
    try {
      const result = await parsePosCsv(file);
      const { newOnes, duplicates } = dedupePosImports(data.ventasConsumidor, result.ok);
      if (newOnes.length) {
        await setCollection('ventasConsumidor', [...data.ventasConsumidor, ...newOnes]);
      }
      setImportSummary({
        imported: newOnes.length,
        duplicates,
        skippedCCF: result.skippedCCF,
        skippedOther: result.skippedOther,
        skippedEmpty: result.skippedEmpty,
        errors: result.errors.length,
        detectedTipos: result.detectedTipos,
        diagnostics: result.diagnostics,
      });
    } catch {
      setImportSummary({
        imported: 0, duplicates: 0, skippedCCF: 0, skippedOther: 0, skippedEmpty: 0,
        errors: 1, detectedTipos: [],
        diagnostics: { delimiter: '?', totalRows: 0, headers: [], columnMap: {}, sampleFirstRow: {} },
      });
    } finally {
      setImporting(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--s-2)', marginBottom: 'var(--s-5)' }}>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={async e => {
            const f = e.target.files?.[0];
            if (f) await handlePosFile(f);
            e.target.value = '';
          }}
        />
        <Button
          variant="secondary"
          onClick={() => fileRef.current?.click()}
          disabled={importing}
          leading={<Icon name="upload" size={15} />}
        >
          {importing ? 'Importando…' : 'Importar reporte POS'}
        </Button>
        <Button onClick={openNew} leading={<Icon name="plus" size={15} />}>Agregar venta</Button>
      </div>

      {importSummary && (
        <div
          className={`banner ${importSummary.imported === 0 ? 'banner-warning' : 'banner-success'}`}
          style={{ marginBottom: 'var(--s-5)' }}
        >
          <Icon name={importSummary.imported === 0 ? 'alert' : 'check'} size={16} />
          <div>
            <strong>{importSummary.imported}</strong> factura(s) importadas
            {importSummary.duplicates > 0 && <> · {importSummary.duplicates} duplicadas (omitidas)</>}
            {importSummary.skippedCCF > 0 && <> · {importSummary.skippedCCF} CCF (van en la otra pantalla)</>}
            {importSummary.skippedOther > 0 && <> · {importSummary.skippedOther} otros DTE (notas de crédito, etc.)</>}
            {importSummary.skippedEmpty > 0 && <> · {importSummary.skippedEmpty} en cero / vacías</>}
            {importSummary.errors > 0 && <> · {importSummary.errors} con error</>}
            {importSummary.detectedTipos.length > 0 && (
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-3)', marginTop: 4 }}>
                Tipos detectados en el archivo: {importSummary.detectedTipos.map(t => `"${t}"`).join(', ')}
              </div>
            )}
            {importSummary.imported === 0 && (
              <details style={{ marginTop: 'var(--s-2)', fontSize: 'var(--text-xs)' }}>
                <summary style={{ cursor: 'pointer', color: 'var(--fg-2)' }}>
                  Diagnóstico del parser (click para expandir)
                </summary>
                <div style={{ marginTop: 6, padding: 'var(--s-2)', background: 'var(--surface-2)', borderRadius: 'var(--r-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.5 }}>
                  <div>Separador detectado: <strong>{JSON.stringify(importSummary.diagnostics.delimiter)}</strong></div>
                  <div>Filas totales en archivo: <strong>{importSummary.diagnostics.totalRows}</strong></div>
                  <div style={{ marginTop: 6 }}><strong>Headers detectados ({importSummary.diagnostics.headers.length}):</strong></div>
                  <ol style={{ margin: '2px 0 0 22px', padding: 0 }}>
                    {importSummary.diagnostics.headers.map((h, i) => (<li key={i}>"{h}"</li>))}
                  </ol>
                  <div style={{ marginTop: 6 }}><strong>Mapeo automático de campos:</strong></div>
                  {Object.keys(importSummary.diagnostics.columnMap).length === 0
                    ? <div style={{ marginLeft: 18 }}>(ningún campo reconocido)</div>
                    : (
                      <ul style={{ margin: '2px 0 0 18px', padding: 0 }}>
                        {Object.entries(importSummary.diagnostics.columnMap).map(([k, v]) => (
                          <li key={k}><strong>{k}</strong> → col {String(v)}</li>
                        ))}
                      </ul>
                    )}
                  <div style={{ marginTop: 6 }}><strong>Valores de la primera fila:</strong></div>
                  <ul style={{ margin: '2px 0 0 18px', padding: 0 }}>
                    {Object.entries(importSummary.diagnostics.sampleFirstRow).map(([k, v]) => (
                      <li key={k}><strong>{k}:</strong> {v ? `"${v}"` : '(vacío)'}</li>
                    ))}
                  </ul>
                </div>
              </details>
            )}
          </div>
        </div>
      )}

      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginBottom: 'var(--s-5)' }}>
        <KpiCard label="Total ventas" tone="primary" size="md" value={fmt(totalMonto)} hint={`${rows.length} registros`} />
        <KpiCard label="IVA débito (13%)" tone="danger" size="md" value={fmt(totalIva)} hint="A reportar al MH" />
        <KpiCard label="Subtotal (sin IVA)" size="md" value={fmt(totalMonto / 1.13)} hint="Base imponible" />
      </div>

      <div className="table-wrap">
        <div className="table-scroll">
          {hasPosData ? <PosLikeTable rows={rows} onEdit={openEdit} onDelete={del} />
                      : <SimpleTable rows={rows} onEdit={openEdit} onDelete={del} />}
        </div>
        {rows.length > 0 && (
          <div className="table-footer">
            <div className="table-totals">
              <div className="total-item">Total: <strong>{fmt(totalMonto)}</strong></div>
              <div className="total-item">IVA débito: <strong style={{ color: 'var(--danger-text)' }}>{fmt(totalIva)}</strong></div>
              <div className="total-item">Base: <strong>{fmt(totalMonto / 1.13)}</strong></div>
            </div>
            <div className="caption">{rows.length} registros</div>
          </div>
        )}
      </div>

      {showModal && (
        <Modal
          title={editId ? 'Editar venta' : 'Nueva venta al consumidor'}
          onClose={() => setShowModal(false)}
          onSave={save}
          saveDisabled={isSaving}
          saveLabel={isSaving ? 'Guardando…' : 'Guardar'}
        >
          <div className="two-col">
            <Field label="Fecha"><Input type="date" value={form.fecha} onChange={e => setForm(p => ({ ...p, fecha: e.target.value }))} /></Field>
            <Field label="Monto total (con IVA)"><Input type="number" step="0.01" placeholder="0.00" value={form.monto} onChange={e => setForm(p => ({ ...p, monto: e.target.value }))} /></Field>
          </div>
          <Field label="Descripción"><Input type="text" placeholder="Descripción de la venta" value={form.descripcion} onChange={e => setForm(p => ({ ...p, descripcion: e.target.value }))} /></Field>
          <Field label="Notas adicionales"><Input type="text" placeholder="Opcional" value={form.notas ?? ''} onChange={e => setForm(p => ({ ...p, notas: e.target.value }))} /></Field>
          {form.monto && (
            <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-md)', padding: 'var(--s-3) var(--s-4)', display: 'flex', gap: 'var(--s-5)' }}>
              <div className="total-item">Subtotal: <strong>{fmt(num(form.monto) / 1.13)}</strong></div>
              <div className="total-item">IVA (13%): <strong style={{ color: 'var(--danger-text)' }}>{fmt(num(form.monto) * IVA_RATE)}</strong></div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

/* ═══════════════════════════ REPORTES GENERADOS ═══════════════════════════ */

const TIPO_INGRESO_FCF_OPTIONS = [
  { value: '3', label: '3 — Actividades comerciales (default)' },
  { value: '1', label: '1 — Industrias manufactureras' },
  { value: '2', label: '2 — Industrias agropecuarias' },
  { value: '4', label: '4 — Servicios profesionales / técnicos' },
  { value: '5', label: '5 — Otros' },
];

function ReportesTab({ data, setCollection, month, year }: MovimientosProps) {
  // Los anexos son siempre mensuales — la pestaña ignora el modo anual.
  const [generating, setGenerating] = useState(false);
  const [lastBuild, setLastBuild] = useState<{ rowCount: number; excludedNoMetadata: number; total: number } | null>(null);
  const [tipoIngreso, setTipoIngreso] = useState<string>('3');

  const reportes = data.reportesGenerados
    .filter(r => r.tipo === 'anexo_consumidor_final')
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));

  const reportesPeriodoActual = reportes.filter(r => r.periodoYear === year && r.periodoMonth === month + 1);

  // Para previsualizar cuántas facturas exportables hay en el período actual
  const eligiblesPreview = data.ventasConsumidor.filter(v =>
    inPeriod(v.fecha, month, year) && v.metadata?.numeroControl && v.metadata?.codigoGeneracion,
  );
  const totalSinMetadata = data.ventasConsumidor.filter(v =>
    inPeriod(v.fecha, month, year) && (!v.metadata?.numeroControl || !v.metadata?.codigoGeneracion),
  ).length;

  async function generarAnexo() {
    setGenerating(true);
    try {
      const built = buildAnexoConsumidorFinal({ month, year, ventas: data.ventasConsumidor, tipoIngreso });
      if (built.rowCount === 0) {
        setLastBuild({ rowCount: 0, excludedNoMetadata: built.excludedNoMetadata, total: 0 });
        return;
      }
      const reporte = makeReporteFromAnexo(built, month, year);
      const next = [...data.reportesGenerados, reporte];
      await setCollection('reportesGenerados', next);
      downloadReporte(reporte);
      setLastBuild({ rowCount: built.rowCount, excludedNoMetadata: built.excludedNoMetadata, total: built.totalAmount });
    } finally {
      setGenerating(false);
    }
  }

  async function eliminarReporte(id: string) {
    if (!confirm('¿Eliminar este reporte? El archivo CSV ya descargado en tu computadora no se afecta.')) return;
    await setCollection('reportesGenerados', data.reportesGenerados.filter(r => r.id !== id));
  }

  return (
    <div>
      <div className="kpi-card" style={{ marginBottom: 'var(--s-5)', padding: 'var(--s-6)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s-4)', flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 360px' }}>
            <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, marginBottom: 4 }}>
              Anexo Consumidor Final · {MONTHS[month]} {year}
            </div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-3)' }}>
              Genera el archivo CSV con el formato exacto del Ministerio de Hacienda (F-955) para el mes seleccionado.
              Cambia el mes/año desde el selector superior antes de generar.
            </div>
            <div style={{ marginTop: 'var(--s-3)', fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}>
              <strong>{eligiblesPreview.length}</strong> factura(s) listas para exportar
              {totalSinMetadata > 0 && (
                <span style={{ color: 'var(--warning-text)' }}>
                  {' '}· <strong>{totalSinMetadata}</strong> sin DTE/sello (se omitirán)
                </span>
              )}
            </div>

            <div style={{ marginTop: 'var(--s-4)' }}>
              <label className="field-label">Tipo de Ingreso (columna V del F-955)</label>
              <select
                className="field-input"
                value={tipoIngreso}
                onChange={e => setTipoIngreso(e.target.value)}
                style={{ marginTop: 4, maxWidth: 480 }}
              >
                {TIPO_INGRESO_FCF_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-3)', marginTop: 4 }}>
                Debe coincidir con el giro registrado de tu empresa en el MH. Para comercio típico es <strong>3 — Actividades comerciales</strong>.
              </div>
            </div>
          </div>
          <Button
            onClick={generarAnexo}
            disabled={generating || eligiblesPreview.length === 0}
            leading={<Icon name="download" size={15} />}
          >
            {generating ? 'Generando…' : 'Generar y descargar'}
          </Button>
        </div>
      </div>

      {lastBuild && lastBuild.rowCount === 0 && (
        <div className="banner banner-warning" style={{ marginBottom: 'var(--s-5)' }}>
          <Icon name="alert" size={16} />
          <div>
            No hay facturas con datos DTE para {MONTHS[month]} {year}.
            {lastBuild.excludedNoMetadata > 0 && (
              <> {lastBuild.excludedNoMetadata} factura(s) del período fueron omitidas porque les falta el Número de Control o el Código de Generación.</>
            )}
          </div>
        </div>
      )}
      {lastBuild && lastBuild.rowCount > 0 && (
        <div className="banner banner-success" style={{ marginBottom: 'var(--s-5)' }}>
          <Icon name="check" size={16} />
          <div>
            Reporte generado: <strong>{lastBuild.rowCount}</strong> facturas · Total <strong>{fmt(lastBuild.total)}</strong>.
            {lastBuild.excludedNoMetadata > 0 && <> Se omitieron {lastBuild.excludedNoMetadata} facturas sin DTE.</>}
          </div>
        </div>
      )}

      <div style={{ marginBottom: 'var(--s-3)', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div className="section-title" style={{ fontSize: 'var(--text-md)' }}>
          Historial de reportes
          <span style={{ color: 'var(--fg-3)', fontWeight: 400, marginLeft: 8, fontSize: 'var(--text-sm)' }}>
            ({reportesPeriodoActual.length} en {MONTHS[month]} {year} · {reportes.length} en total)
          </span>
        </div>
      </div>

      <div className="table-wrap">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Archivo</th>
                <th>Período</th>
                <th>Generado</th>
                <th className="num">Filas</th>
                <th className="num">Total</th>
                <th style={{ width: 180 }} />
              </tr>
            </thead>
            <tbody>
              {reportes.length === 0 && (
                <tr><td colSpan={6}>
                  <EmptyState title="Sin reportes generados aún" description="Cuando generes tu primer Anexo Consumidor Final, aparecerá aquí." />
                </td></tr>
              )}
              {reportes.map(r => (
                <ReporteRow key={r.id} reporte={r} onDelete={() => eliminarReporte(r.id)} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ReporteRow({ reporte, onDelete }: { reporte: ReporteGenerado; onDelete: () => void }) {
  const generated = new Date(reporte.generatedAt);
  const periodoLabel = `${MONTHS[reporte.periodoMonth - 1]} ${reporte.periodoYear}`;
  return (
    <tr>
      <td>
        <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{reporte.filename}</code>
      </td>
      <td>{periodoLabel}</td>
      <td className="muted" style={{ fontSize: 'var(--text-xs)' }}>
        {generated.toLocaleDateString('es-SV')} {generated.toLocaleTimeString('es-SV', { hour: '2-digit', minute: '2-digit' })}
      </td>
      <td className="num">{reporte.rowCount}</td>
      <td className="num"><strong>{fmt(reporte.totalAmount)}</strong></td>
      <td>
        <div style={{ display: 'flex', gap: 'var(--s-2)', justifyContent: 'flex-end' }}>
          <Button size="sm" variant="secondary" onClick={() => downloadReporte(reporte)} leading={<Icon name="download" size={13} />}>
            Descargar
          </Button>
          <button className="btn-icon" style={{ color: 'var(--danger-text)' }} onClick={onDelete} aria-label="Eliminar">
            <Icon name="trash" size={14} />
          </button>
        </div>
      </td>
    </tr>
  );
}

/* ═══════════════════════════ TABLAS DE MOVIMIENTOS ═══════════════════════════ */

function SimpleTable({
  rows, onEdit, onDelete,
}: { rows: VentaConsumidor[]; onEdit: (r: VentaConsumidor) => void; onDelete: (id: string) => void }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Fecha</th><th>Descripción</th>
          <th className="num">Monto total</th><th className="num">IVA (13%)</th>
          <th className="num">Subtotal</th><th style={{ width: 80 }} />
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr><td colSpan={6}><EmptyState title="Sin ventas registradas" description="Agrega tu primera venta o importa un reporte POS." /></td></tr>
        )}
        {rows.map(r => (
          <tr key={r.id}>
            <td className="muted">{displayDate(r.fecha)}</td>
            <td>{r.descripcion}</td>
            <td className="num">{fmt(r.monto)}</td>
            <td className="num" style={{ color: 'var(--danger-text)' }}>{fmt(num(r.monto) * IVA_RATE)}</td>
            <td className="num">{fmt(num(r.monto) / 1.13)}</td>
            <td><RowActions onEdit={() => onEdit(r)} onDelete={() => onDelete(r.id)} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PosLikeTable({
  rows, onEdit, onDelete,
}: { rows: VentaConsumidor[]; onEdit: (r: VentaConsumidor) => void; onDelete: (id: string) => void }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Orden</th>
          <th>DTE</th>
          <th>Fecha</th>
          <th>Hora</th>
          <th>Vendedor</th>
          <th>Cliente</th>
          <th className="num">Subtotal</th>
          <th className="num">IVA</th>
          <th className="num">Total</th>
          <th style={{ width: 80 }} />
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr><td colSpan={10}><EmptyState title="Sin ventas registradas" description="Importa un reporte POS para empezar." /></td></tr>
        )}
        {rows.map(r => {
          const m = r.metadata ?? {};
          const total = num(r.monto);
          const subtotal = m.subtotal != null ? num(m.subtotal) : total / 1.13;
          const iva = m.iva != null ? num(m.iva) : total * IVA_RATE / (1 + IVA_RATE);
          return (
            <tr key={r.id}>
              <td className="muted">{m.orden ?? '—'}</td>
              <td><DteCell meta={m} fecha={r.fecha} /></td>
              <td className="muted">{displayDate(r.fecha)}</td>
              <td className="muted">{m.hora ?? ''}</td>
              <td>{m.autorizadoPor ?? ''}</td>
              <td>{m.cliente || <span style={{ color: 'var(--fg-4)' }}>Consumidor final</span>}</td>
              <td className="num">{fmt(subtotal)}</td>
              <td className="num" style={{ color: 'var(--danger-text)' }}>{fmt(iva)}</td>
              <td className="num"><strong>{fmt(total)}</strong></td>
              <td><RowActions onEdit={() => onEdit(r)} onDelete={() => onDelete(r.id)} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
