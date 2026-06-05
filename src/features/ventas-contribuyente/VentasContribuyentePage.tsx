import { useRef, useState } from 'react';
import { Icon } from '@/components/icons/Icon';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input, Select } from '@/components/ui/Field';
import { KpiCard } from '@/components/ui/KpiCard';
import { Modal } from '@/components/ui/Modal';
import { RowActions } from '@/components/ui/RowActions';
import { DteCells } from '@/components/dte/DteCell';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { SyncDtesButton } from '@/components/dte/SyncDtesButton';
import { IVA_RATE, MONTHS } from '@/config/constants';
import { displayDate, fmt, matchesPeriod, newId, num } from '@/lib/utils/format';
import { parseDteJson } from '@/lib/utils/dte-json-parser';
import { ensureContribuyente } from '@/lib/utils/contribuyentes';
import { describeDuplicate, findDuplicate } from '@/lib/utils/duplicates';
import {
  buildAnexoVentasContribuyente, makeReporteFromAnexoVentasContribuyente,
} from '@/lib/utils/anexo-ventas-contribuyente';
import { downloadReporte } from '@/lib/utils/anexo-consumidor-final';
import { useDataStore } from '@/stores/data.store';
import { usePeriodStore } from '@/stores/period.store';
import type {
  ClaseDocumento, ReporteGenerado, VentaContribuyente, VentaContribuyenteMetadata,
} from '@/types/domain';

type Tab = 'movimientos' | 'reportes';

interface FormState {
  fecha: string;
  cliente: string;
  nrc: string;
  descripcion: string;
  gravado: string;
  exento: string;
  notas: string;
  claseDocumento: ClaseDocumento;
  tipoDocumento: string;
  numeroDocumento: string;
  numeroControl: string;
  selloRecibido: string;
  nit: string;
  aplicaRetencion: boolean;
  retencionRenta: string;        // monto en USD
}

const emptyForm: FormState = {
  fecha: '',
  cliente: '',
  nrc: '',
  descripcion: '',
  gravado: '',
  exento: '0.00',
  notas: '',
  claseDocumento: '4',
  tipoDocumento: '03',
  numeroDocumento: '',
  numeroControl: '',
  selloRecibido: '',
  nit: '',
  aplicaRetencion: false,
  retencionRenta: '',
};

const RETENCION_RENTA_PCT = 0.10;     // 10% típico para servicios profesionales / sujetos retención

const CLASE_DOCUMENTO_OPTIONS: { value: ClaseDocumento; label: string }[] = [
  { value: '1', label: '1 — Impreso por imprenta o tiquete' },
  { value: '2', label: '2 — Formulario único' },
  { value: '3', label: '3 — Otros' },
  { value: '4', label: '4 — Documento Tributario Electrónico (DTE)' },
];

const TIPO_DOCUMENTO_OPTIONS = [
  { value: '03', label: '03 — Comprobante de Crédito Fiscal (CCF)' },
  { value: '11', label: '11 — Factura de Exportación' },
  { value: '05', label: '05 — Nota de Crédito' },
  { value: '06', label: '06 — Nota de Débito' },
  { value: '04', label: '04 — Nota de Remisión' },
  { value: '07', label: '07 — Comprobante de Retención' },
  { value: '14', label: '14 — Sujeto Excluido (FSE)' },
];

export function VentasContribuyentePage() {
  const data = useDataStore(s => s.data);
  const setCollection = useDataStore(s => s.set);
  const patch = useDataStore(s => s.patch);
  const { mode, month, year } = usePeriodStore();
  const [tab, setTab] = useState<Tab>('movimientos');

  return (
    <div>
      <SectionHeader
        title="Ventas al contribuyente (CCF)"
        description={`Comprobantes de Crédito Fiscal — ${mode === 'annual' ? `Año ${year}` : `${MONTHS[month]} ${year}`}`}
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

      {tab === 'movimientos' && <MovimientosTab data={data} setCollection={setCollection} patch={patch} mode={mode} month={month} year={year} />}
      {tab === 'reportes' && <ReportesTab data={data} setCollection={setCollection} month={month} year={year} />}
    </div>
  );
}

interface TabProps {
  data: ReturnType<typeof useDataStore.getState>['data'];
  setCollection: ReturnType<typeof useDataStore.getState>['set'];
  patch: ReturnType<typeof useDataStore.getState>['patch'];
  mode: 'monthly' | 'annual';
  month: number;
  year: number;
}

function MovimientosTab({ data, setCollection, patch, mode, month, year }: TabProps) {
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [jsonImporting, setJsonImporting] = useState(false);
  const [jsonWarnings, setJsonWarnings] = useState<string[]>([]);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const jsonRef = useRef<HTMLInputElement>(null);

  const rows = data.ventasContribuyente.filter(r => matchesPeriod(r.fecha, mode, month, year));
  const totalGravado = rows.reduce((s, r) => s + num(r.gravado), 0);
  const totalExento = rows.reduce((s, r) => s + num(r.exento), 0);
  const totalIva = totalGravado * IVA_RATE;
  const totalRetenido = rows.reduce((s, r) => s + num(r.metadata?.retencionRenta ?? 0), 0);
  const countRetenidas = rows.filter(r => num(r.metadata?.retencionRenta ?? 0) > 0).length;

  // Clientes disponibles para autocomplete (incluye "Ambos")
  const clientesOptions = data.contribuyentes.filter(
    c => c.tipo === 'Cliente' || c.tipo === 'Ambos',
  );

  // Preview de qué pasará en Contribuyentes al guardar.
  const previewEnsure = ensureContribuyente(data.contribuyentes, {
    nombre: form.cliente,
    nrc: form.nrc,
    nit: form.nit || undefined,
    role: 'Cliente',
  });

  function resetModalState() {
    setJsonWarnings([]);
    setJsonError(null);
    setSaveError(null);
  }

  function openNew() {
    setForm({ ...emptyForm, fecha: `${year}-${String(month + 1).padStart(2, '0')}-01` });
    setEditId(null);
    resetModalState();
    setShowModal(true);
  }

  function openEdit(r: VentaContribuyente) {
    const m = r.metadata ?? {};
    const retencion = num(m.retencionRenta ?? 0);
    setForm({
      fecha: r.fecha,
      cliente: r.cliente,
      nrc: r.nrc,
      descripcion: r.descripcion,
      gravado: r.gravado,
      exento: r.exento,
      notas: r.notas ?? '',
      claseDocumento: m.claseDocumento ?? '4',
      tipoDocumento: m.tipoDocumento ?? '03',
      numeroDocumento: m.numeroDocumento ?? '',
      numeroControl: m.numeroControl ?? '',
      selloRecibido: m.selloRecibido ?? '',
      nit: m.nit ?? '',
      aplicaRetencion: retencion > 0,
      retencionRenta: retencion > 0 ? retencion.toFixed(2) : '',
    });
    setEditId(r.id);
    resetModalState();
    setShowModal(true);
  }

  async function handleJsonFile(file: File) {
    setJsonImporting(true);
    setJsonError(null);
    setJsonWarnings([]);
    try {
      const text = await file.text();
      const result = parseDteJson(text, 'venta');
      if (!result.ok) {
        setJsonError(result.error);
        return;
      }
      const d = result.data;

      // Bloquea duplicados antes de prefilear el form.
      const dup = findDuplicate(data.ventasContribuyente, {
        numeroControl: d.numeroControl,
        codigoGeneracion: d.codigoGeneracion,
        selloRecibido: d.selloRecibido,
      }, editId ?? undefined);
      if (dup) {
        setJsonError(`Documento duplicado — ${describeDuplicate(dup)} El JSON NO se cargó.`);
        return;
      }

      const retencionFromJson = num(d.reteRenta);
      setForm(prev => ({
        ...prev,
        fecha: d.fecha || prev.fecha,
        cliente: d.contraparteNombre || prev.cliente,
        nrc: d.contraparteNrc || prev.nrc,
        nit: d.contraparteNit || prev.nit,
        descripcion: d.descripcion || prev.descripcion,
        gravado: d.totalGravada || prev.gravado,
        exento: d.totalExenta || prev.exento,
        claseDocumento: '4',
        tipoDocumento: d.tipoDte || prev.tipoDocumento,
        numeroDocumento: d.codigoGeneracion || prev.numeroDocumento,
        numeroControl: d.numeroControl || prev.numeroControl,
        selloRecibido: d.selloRecibido || prev.selloRecibido,
        aplicaRetencion: retencionFromJson > 0 || prev.aplicaRetencion,
        retencionRenta: retencionFromJson > 0 ? retencionFromJson.toFixed(2) : prev.retencionRenta,
      }));
      setJsonWarnings(d.warnings);
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : 'Error leyendo el archivo');
    } finally {
      setJsonImporting(false);
    }
  }

  async function save() {
    // Re-entry guard: previene duplicados por doble-click.
    if (isSaving) return;
    if (!form.fecha || !form.gravado || !form.cliente) return;
    setSaveError(null);

    // Bloquea duplicados antes de guardar (DTE + cód generación + sello).
    const dup = findDuplicate(data.ventasContribuyente, {
      numeroControl: form.numeroControl,
      numeroDocumento: form.numeroDocumento,
      selloRecibido: form.selloRecibido,
    }, editId ?? undefined);
    if (dup) {
      setSaveError(`No se puede guardar — ${describeDuplicate(dup)}`);
      return;
    }

    setIsSaving(true);

    // Retención: si la marcó pero no llenó monto, calculamos 10% del gravado.
    const retencionAuto = form.aplicaRetencion
      ? (form.retencionRenta || (num(form.gravado) * RETENCION_RENTA_PCT).toFixed(2))
      : '';

    const metadata: VentaContribuyenteMetadata = {
      source: 'manual',
      claseDocumento: form.claseDocumento,
      tipoDocumento: form.tipoDocumento,
      numeroDocumento: form.numeroDocumento || undefined,
      numeroControl: form.numeroControl || undefined,
      selloRecibido: form.selloRecibido || undefined,
      nit: form.nit || undefined,
      retencionRenta: retencionAuto || undefined,
    };

    const payload: VentaContribuyente = {
      id: editId ?? newId(),
      fecha: form.fecha,
      cliente: form.cliente,
      nrc: form.nrc,
      descripcion: form.descripcion,
      gravado: form.gravado,
      exento: form.exento || '0.00',
      notas: form.notas,
      metadata,
    };

    // Asegura que el cliente exista en Contribuyentes (lo crea o lo asciende
    // de Proveedor → Ambos automáticamente). Match por NRC.
    const ensured = ensureContribuyente(data.contribuyentes, {
      nombre: form.cliente,
      nrc: form.nrc,
      nit: form.nit || undefined,
      role: 'Cliente',
    });

    try {
      // Save atómico: contribuyentes + ventas en un solo upsert al backend.
      await patch(prev => ({
        ...prev,
        contribuyentes: ensured.list,
        ventasContribuyente: editId
          ? prev.ventasContribuyente.map(r => r.id === editId ? payload : r)
          : [...prev.ventasContribuyente, payload],
      }));
      setShowModal(false);
    } finally {
      setIsSaving(false);
    }
  }

  async function del(id: string) {
    await setCollection('ventasContribuyente', data.ventasContribuyente.filter(r => r.id !== id));
  }

  const isDTE = form.claseDocumento === '4';
  const formValid = !!(form.fecha && form.gravado && form.cliente);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--s-5)' }}>
        <Button onClick={openNew} leading={<Icon name="plus" size={15} />}>Agregar CCF</Button>
      </div>

      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginBottom: 'var(--s-5)' }}>
        <KpiCard label="Ventas gravadas" tone="primary" size="md" value={fmt(totalGravado)} hint={`${rows.length} CCF emitidos`} />
        <KpiCard label="Ventas exentas" size="md" value={fmt(totalExento)} hint="Sin IVA aplicable" />
        <KpiCard label="IVA débito (13%)" tone="danger" size="md" value={fmt(totalIva)} hint="Sobre ventas gravadas" />
        <KpiCard label="Total (gravado + exento)" size="md" value={fmt(totalGravado + totalExento)} hint="Ventas totales CCF" />
        {totalRetenido > 0 && (
          <KpiCard
            label="Retención de Renta"
            tone="warning"
            size="md"
            value={fmt(totalRetenido)}
            hint={`${countRetenidas} CCF con retención (excluidas del 1.75%)`}
          />
        )}
      </div>

      <div className="table-wrap">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Fecha</th><th>Cliente</th><th>NRC</th><th>Descripción</th>
                <th className="num">Gravado</th><th className="num">Exento</th>
                <th className="num">IVA débito</th><th className="num">Retención</th>
                <th>Nº Control</th>
                <th>Cód. Generación</th>
                <th>Sello recepción</th>
                <th style={{ width: 80 }} />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={12}><EmptyState title="Sin CCF registrados" description="Agrega comprobantes de crédito fiscal." /></td></tr>
              )}
              {rows.map(r => {
                const retencion = num(r.metadata?.retencionRenta ?? 0);
                return (
                  <tr key={r.id}>
                    <td className="muted">{displayDate(r.fecha)}</td>
                    <td style={{ fontWeight: 500 }}>{r.cliente}</td>
                    <td><code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--fg-3)' }}>{r.nrc}</code></td>
                    <td>{r.descripcion}</td>
                    <td className="num">{fmt(r.gravado)}</td>
                    <td className="num muted">{fmt(r.exento)}</td>
                    <td className="num" style={{ color: 'var(--danger-text)' }}>{fmt(num(r.gravado) * IVA_RATE)}</td>
                    <td className="num">
                      {retencion > 0
                        ? <span style={{ color: 'var(--warning-text)' }} title="Excluida del Pago a Cuenta 1.75%">{fmt(retencion)}</span>
                        : <span style={{ color: 'var(--fg-4)' }}>—</span>}
                    </td>
                    <DteCells meta={r.metadata} fecha={r.fecha} />
                    <td><RowActions onEdit={() => openEdit(r)} onDelete={() => del(r.id)} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows.length > 0 && (
          <div className="table-footer">
            <div className="table-totals">
              <div className="total-item">Gravado: <strong>{fmt(totalGravado)}</strong></div>
              <div className="total-item">Exento: <strong>{fmt(totalExento)}</strong></div>
              <div className="total-item">IVA débito: <strong style={{ color: 'var(--danger-text)' }}>{fmt(totalIva)}</strong></div>
            </div>
            <div className="caption">{rows.length} registros</div>
          </div>
        )}
      </div>

      {showModal && (
        <Modal
          title={editId ? 'Editar CCF' : 'Nuevo CCF'}
          onClose={() => setShowModal(false)}
          onSave={save}
          saveDisabled={!formValid || isSaving}
          saveLabel={isSaving ? 'Guardando…' : 'Guardar'}
        >
          {/* Importar JSON DTE */}
          <div style={{ background: 'var(--brand-primary-50)', border: '1px solid var(--brand-primary-200)', borderRadius: 'var(--r-md)', padding: 'var(--s-3) var(--s-4)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 240px' }}>
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--brand-primary-800)', marginBottom: 2 }}>
                  ¿Tienes el JSON del DTE de venta?
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--brand-primary-700)' }}>
                  Cárgalo y se prellena el formulario con los datos del cliente y los montos exactos.
                </div>
              </div>
              <input
                ref={jsonRef}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={async e => {
                  const f = e.target.files?.[0];
                  if (f) await handleJsonFile(f);
                  e.target.value = '';
                }}
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => jsonRef.current?.click()}
                disabled={jsonImporting}
                leading={<Icon name="upload" size={14} />}
              >
                {jsonImporting ? 'Leyendo…' : 'Importar JSON DTE'}
              </Button>
            </div>
            {jsonError && (
              <div style={{ marginTop: 'var(--s-2)', fontSize: 'var(--text-xs)', color: 'var(--danger-text)' }}>
                <Icon name="alert" size={12} /> {jsonError}
              </div>
            )}
            {jsonWarnings.length > 0 && (
              <div style={{ marginTop: 'var(--s-2)', fontSize: 'var(--text-xs)', color: 'var(--warning-text)' }}>
                {jsonWarnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
              </div>
            )}
          </div>

          <div className="two-col">
            <Field label="Fecha *">
              <Input type="date" value={form.fecha} onChange={e => setForm(p => ({ ...p, fecha: e.target.value }))} />
            </Field>
            <Field label="Clase de Documento *">
              <Select value={form.claseDocumento} onChange={e => setForm(p => ({ ...p, claseDocumento: e.target.value as ClaseDocumento }))}>
                {CLASE_DOCUMENTO_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </Field>
          </div>

          <div className="two-col">
            <Field label="Tipo de Documento *">
              <Select value={form.tipoDocumento} onChange={e => setForm(p => ({ ...p, tipoDocumento: e.target.value }))}>
                {TIPO_DOCUMENTO_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </Field>
            <Field label={isDTE ? 'Código de Generación' : 'Núm. Documento'}>
              <Input
                type="text"
                placeholder={isDTE ? 'B886C935A1904C00AA01DF747177DE10' : 'Correlativo'}
                value={form.numeroDocumento}
                onChange={e => setForm(p => ({ ...p, numeroDocumento: e.target.value }))}
              />
            </Field>
          </div>

          {isDTE && (
            <div className="two-col">
              <Field label="Núm. de Control DTE (opcional)">
                <Input
                  type="text"
                  placeholder="DTE-03-M001P001-00…"
                  value={form.numeroControl}
                  onChange={e => setForm(p => ({ ...p, numeroControl: e.target.value }))}
                />
              </Field>
              <Field label="Sello de Recepción (opcional)">
                <Input
                  type="text"
                  placeholder="2026XXXXX…"
                  value={form.selloRecibido}
                  onChange={e => setForm(p => ({ ...p, selloRecibido: e.target.value }))}
                />
              </Field>
            </div>
          )}

          <div className="two-col">
            <Field label="Cliente *">
              <Input
                type="text"
                list="clientes-datalist"
                placeholder={clientesOptions.length ? 'Empieza a escribir o elige uno…' : 'Razón social'}
                value={form.cliente}
                onChange={e => {
                  const value = e.target.value;
                  const match = clientesOptions.find(c => c.nombre === value);
                  setForm(p => ({
                    ...p,
                    cliente: value,
                    nrc: match ? match.nrc : p.nrc,
                    nit: match ? (match.nit ?? '') : p.nit,
                  }));
                }}
              />
              <datalist id="clientes-datalist">
                {clientesOptions.map(c => (
                  <option key={c.id} value={c.nombre} label={`NRC ${c.nrc}${c.giro ? ' · ' + c.giro : ''}`} />
                ))}
              </datalist>
              {previewEnsure.action === 'unchanged' && previewEnsure.contribuyente && (
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--success-text)', marginTop: 2 }}>
                  ✓ Cliente en Contribuyentes — NRC autocompletado
                </span>
              )}
              {previewEnsure.action === 'created' && (
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--info-text)', marginTop: 2 }}>
                  ➕ Se agregará a Contribuyentes como nuevo Cliente al guardar
                </span>
              )}
              {previewEnsure.action === 'upgraded-to-ambos' && (
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--warning-text)', marginTop: 2 }}>
                  ↑ Existe como Proveedor — al guardar se ascenderá a "Ambos"
                </span>
              )}
            </Field>
            <Field label="NRC del cliente">
              <Input type="text" placeholder="123456-7" value={form.nrc} onChange={e => setForm(p => ({ ...p, nrc: e.target.value }))} />
            </Field>
          </div>

          <div className="two-col">
            <Field label="NIT del cliente (opcional)">
              <Input type="text" placeholder="0614-…" value={form.nit} onChange={e => setForm(p => ({ ...p, nit: e.target.value }))} />
            </Field>
            <div />
          </div>

          <Field label="Descripción">
            <Input type="text" placeholder="Descripción de la venta" value={form.descripcion} onChange={e => setForm(p => ({ ...p, descripcion: e.target.value }))} />
          </Field>

          <div className="two-col">
            <Field label="Monto gravado *">
              <Input type="number" step="0.01" placeholder="0.00" value={form.gravado} onChange={e => setForm(p => ({ ...p, gravado: e.target.value }))} />
            </Field>
            <Field label="Monto exento">
              <Input type="number" step="0.01" placeholder="0.00" value={form.exento} onChange={e => setForm(p => ({ ...p, exento: e.target.value }))} />
            </Field>
          </div>

          {/* Retención de Renta (10%) */}
          <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-md)', padding: 'var(--s-4)', border: '1px solid var(--border)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', cursor: 'pointer', fontSize: 'var(--text-sm)', fontWeight: 500 }}>
              <input
                type="checkbox"
                checked={form.aplicaRetencion}
                onChange={e => {
                  const checked = e.target.checked;
                  setForm(p => ({
                    ...p,
                    aplicaRetencion: checked,
                    retencionRenta: checked
                      ? (p.retencionRenta || (num(p.gravado) * RETENCION_RENTA_PCT).toFixed(2))
                      : '',
                  }));
                }}
              />
              Aplica retención de Renta (cliente es Sujeto de Retención)
            </label>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-3)', marginTop: 4, marginLeft: 24 }}>
              Si está marcada, esta venta NO entra en la base del Pago a Cuenta del 1.75% — porque ya tributó ISR vía la retención.
            </div>
            {form.aplicaRetencion && (
              <div className="two-col" style={{ marginTop: 'var(--s-3)' }}>
                <Field label="Monto retenido (Renta 10%)">
                  <Input
                    type="number"
                    step="0.01"
                    placeholder={(num(form.gravado) * RETENCION_RENTA_PCT).toFixed(2)}
                    value={form.retencionRenta}
                    onChange={e => setForm(p => ({ ...p, retencionRenta: e.target.value }))}
                  />
                </Field>
                <div style={{ alignSelf: 'center', fontSize: 'var(--text-xs)', color: 'var(--fg-3)' }}>
                  {form.gravado && (
                    <>
                      Sugerido (10% × gravado): <strong>{fmt(num(form.gravado) * RETENCION_RENTA_PCT)}</strong>
                      <br />
                      Neto a recibir: <strong>{fmt(num(form.gravado) * (1 + IVA_RATE) + num(form.exento) - num(form.retencionRenta || (num(form.gravado) * RETENCION_RENTA_PCT)))}</strong>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          <Field label="Notas (opcional)">
            <Input type="text" placeholder="Observaciones internas" value={form.notas} onChange={e => setForm(p => ({ ...p, notas: e.target.value }))} />
          </Field>

          {form.gravado && (
            <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-md)', padding: 'var(--s-3) var(--s-4)', display: 'flex', gap: 'var(--s-5)', flexWrap: 'wrap' }}>
              <div className="total-item">IVA débito: <strong style={{ color: 'var(--danger-text)' }}>{fmt(num(form.gravado) * IVA_RATE)}</strong></div>
              <div className="total-item">Total: <strong>{fmt(num(form.gravado) + num(form.exento))}</strong></div>
              <div className="total-item">Total c/IVA: <strong>{fmt(num(form.gravado) * (1 + IVA_RATE) + num(form.exento))}</strong></div>
            </div>
          )}

          {saveError && (
            <div className="banner banner-danger" style={{ fontSize: 'var(--text-sm)' }}>
              <Icon name="alert" size={16} />
              <div>{saveError}</div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

/* ═══════════════════════════ REPORTES GENERADOS ═══════════════════════════ */

interface ReportesProps {
  data: ReturnType<typeof useDataStore.getState>['data'];
  setCollection: ReturnType<typeof useDataStore.getState>['set'];
  month: number;
  year: number;
}

const TIPO_INGRESO_CCF_OPTIONS = [
  { value: '02', label: '02 — Bienes (default, comercio / restaurante / retail)' },
  { value: '01', label: '01 — Servicios' },
  { value: '03', label: '03 — Mixto' },
  { value: '04', label: '04 — Otros' },
];

function ReportesTab({ data, setCollection, month, year }: ReportesProps) {
  const [generating, setGenerating] = useState(false);
  const [lastBuild, setLastBuild] = useState<{ rowCount: number; excludedNoMetadata: number; total: number } | null>(null);
  const [tipoIngreso, setTipoIngreso] = useState<string>('02');

  const reportes = data.reportesGenerados
    .filter(r => r.tipo === 'anexo_ventas_contribuyente')
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));

  const reportesPeriodoActual = reportes.filter(r => r.periodoYear === year && r.periodoMonth === month + 1);

  // Preview de cuántos CCF se exportarán en el mes seleccionado.
  const eligiblesPreview = data.ventasContribuyente.filter(v =>
    matchesPeriod(v.fecha, 'monthly', month, year)
    && !!v.metadata?.claseDocumento
    && !!v.metadata?.tipoDocumento
    && !!v.metadata?.numeroDocumento,
  );
  const totalSinMetadata = data.ventasContribuyente.filter(v =>
    matchesPeriod(v.fecha, 'monthly', month, year)
    && (!v.metadata?.claseDocumento || !v.metadata?.tipoDocumento || !v.metadata?.numeroDocumento),
  ).length;

  async function generarAnexo() {
    setGenerating(true);
    try {
      const built = buildAnexoVentasContribuyente({ month, year, ventas: data.ventasContribuyente, tipoIngreso });
      if (built.rowCount === 0) {
        setLastBuild({ rowCount: 0, excludedNoMetadata: built.excludedNoMetadata, total: 0 });
        return;
      }
      const reporte = makeReporteFromAnexoVentasContribuyente(built, month, year);
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
              Anexo de Ventas a Contribuyentes · {MONTHS[month]} {year}
            </div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-3)' }}>
              Genera el archivo CSV (formato F-955 del MH) para el mes seleccionado.
              Los anexos son siempre mensuales — cambia el período desde el selector superior.
            </div>
            <div style={{ marginTop: 'var(--s-3)', fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}>
              <strong>{eligiblesPreview.length}</strong> CCF listos para exportar
              {totalSinMetadata > 0 && (
                <span style={{ color: 'var(--warning-text)' }}>
                  {' '}· <strong>{totalSinMetadata}</strong> sin Clase/Tipo/Núm. Doc. (se omitirán)
                </span>
              )}
            </div>

            <div style={{ marginTop: 'var(--s-4)' }}>
              <label className="field-label">Tipo de Ingreso (campo 19 del F-955)</label>
              <select
                className="field-input"
                value={tipoIngreso}
                onChange={e => setTipoIngreso(e.target.value)}
                style={{ marginTop: 4, maxWidth: 480 }}
              >
                {TIPO_INGRESO_CCF_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-3)', marginTop: 4 }}>
                Si el portal te dice "Tipo de ingreso no válido", prueba cambiando este valor según el giro registrado de tu empresa.
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
            No hay CCF con datos fiscales completos para {MONTHS[month]} {year}.
            {lastBuild.excludedNoMetadata > 0 && (
              <> {lastBuild.excludedNoMetadata} CCF del período fueron omitidos por faltarles Clase, Tipo o Número de Documento.</>
            )}
          </div>
        </div>
      )}
      {lastBuild && lastBuild.rowCount > 0 && (
        <div className="banner banner-success" style={{ marginBottom: 'var(--s-5)' }}>
          <Icon name="check" size={16} />
          <div>
            Reporte generado: <strong>{lastBuild.rowCount}</strong> CCF · Total <strong>{fmt(lastBuild.total)}</strong>.
            {lastBuild.excludedNoMetadata > 0 && <> Se omitieron {lastBuild.excludedNoMetadata} CCF sin metadata.</>}
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
                  <EmptyState title="Sin reportes generados aún" description="Cuando generes tu primer Anexo de Ventas a Contribuyentes, aparecerá aquí." />
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
