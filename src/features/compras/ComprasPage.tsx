import { useRef, useState } from 'react';
import { Icon } from '@/components/icons/Icon';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input, Select } from '@/components/ui/Field';
import { KpiCard } from '@/components/ui/KpiCard';
import { Modal } from '@/components/ui/Modal';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { isSupabaseConfigured } from '@/config/env';
import { MONTHS } from '@/config/constants';
import { displayDate, fmt, inPeriod, matchesPeriod, newId, num } from '@/lib/utils/format';
import { ivaIncluidoToCredito } from '@/lib/utils/tax';
import {
  buildAnexoCompras, makeReporteFromAnexoCompras,
} from '@/lib/utils/anexo-compras';
import { buildF14Retenciones, makeReporteFromF14 } from '@/lib/utils/f14-retenciones';
import { downloadReporte } from '@/lib/utils/anexo-consumidor-final';
import { parseDteJson } from '@/lib/utils/dte-json-parser';
import { ensureContribuyente } from '@/lib/utils/contribuyentes';
import { describeDuplicate, findDuplicate } from '@/lib/utils/duplicates';
import { deleteCompraPdf, openCompraPdf, uploadCompraPdf } from '@/lib/supabase/storage';
import { useDataStore } from '@/stores/data.store';
import { usePeriodStore } from '@/stores/period.store';
import type {
  ClaseDocumento, Compra, CompraMetadata, ReporteGenerado,
} from '@/types/domain';

type Tab = 'movimientos' | 'reportes';

interface FormState {
  fecha: string;
  proveedor: string;
  nrc: string;
  nit: string;
  dui: string;
  descripcion: string;
  monto: string;
  ivaCredito: string;
  notas: string;
  claseDocumento: ClaseDocumento;
  tipoDocumento: string;
  numeroDocumento: string;
  numeroControl: string;
  selloRecibido: string;
  tipoOperacion: string;     // F-930 col Q (17) — 1 = local
  clasificacion: string;     // F-930 col R (18) — 2 = gasto
  sector: string;            // F-930 col S (19) — 2 = comercio
  tipoCostoGasto: string;    // F-930 col T (20) — 2 = gasto
  numeroAnexo: string;       // F-930 col U (21) — 3 = anexo 3
  aplicaRetencion: boolean;
  tipoPersona: 'natural' | 'juridica';
  retencionCodigoMH: string;
  retencionRenta: string;        // monto retenido por nosotros al proveedor
  retencionConcepto: string;      // tipo operación F-14 (campo 6)
  retencionCodigoIngreso: string; // código de ingreso F-14 (campo 22)
  afpRetenido: string;            // F-14 campo 12 (solo empleados op 01/60)
  isssRetenido: string;           // F-14 campo 13 (solo empleados op 01/60)
}

const emptyForm: FormState = {
  fecha: '',
  proveedor: '',
  nrc: '',
  nit: '',
  dui: '',
  descripcion: '',
  monto: '',
  ivaCredito: '',
  notas: '',
  claseDocumento: '4',
  tipoDocumento: '03',
  numeroDocumento: '',
  numeroControl: '',
  selloRecibido: '',
  tipoOperacion: '1',
  clasificacion: '2',
  sector: '2',
  tipoCostoGasto: '2',
  numeroAnexo: '3',
  aplicaRetencion: false,
  tipoPersona: 'natural',
  retencionCodigoMH: '9300',
  retencionRenta: '',
  retencionConcepto: '11',
  retencionCodigoIngreso: '2',
  afpRetenido: '',
  isssRetenido: '',
};

const RETENCION_RENTA_PCT = 0.10;     // 10% típico para servicios profesionales

const RETENCION_CONCEPTO_OPTIONS = [
  { value: '11', label: '11 — Servicios profesionales' },
  { value: '01', label: '01 — Empleados (con ISR)' },
  { value: '60', label: '60 — Empleados (sin ISR)' },
  { value: '36', label: '36 — Servicios del exterior' },
  { value: '12', label: '12 — Honorarios' },
  { value: '17', label: '17 — Arrendamientos' },
];

const TIPO_PERSONA_OPTIONS = [
  { value: 'natural' as const, label: 'Persona natural' },
  { value: 'juridica' as const, label: 'Persona jurídica' },
];

/** Códigos MH válidos por tipo de persona (campo 2 del F-14).
 *  El portal valida que el código MH sea coherente con la clase de contribuyente. */
const RETENCION_CODIGO_MH_NATURAL = [
  { value: '9300', label: '9300 — Persona natural (general)' },
];
const RETENCION_CODIGO_MH_JURIDICA = [
  { value: '9450', label: '9450 — Persona jurídica (general)' },
  { value: '9438', label: '9438 — Servicios marítimos' },
  { value: '9642', label: '9642 — Servicios extranjeros específicos' },
  { value: '9705', label: '9705 — Otros servicios marítimos' },
];

/** Código de ingreso (campo 22 F-14). Validado por el portal contra clase de persona. */
const RETENCION_CODIGO_INGRESO_NATURAL = [
  { value: '2', label: '2 — Permanente (regular)' },
  { value: '5', label: '5 — Eventual / honorarios especiales' },
  { value: '1', label: '1 — Eventual general' },
];
const RETENCION_CODIGO_INGRESO_JURIDICA = [
  { value: '4', label: '4 — Jurídica / servicios del exterior' },
];

const CLASE_DOCUMENTO_OPTIONS: { value: ClaseDocumento; label: string }[] = [
  { value: '1', label: '1 — Impreso por imprenta o tiquete' },
  { value: '2', label: '2 — Formulario único' },
  { value: '3', label: '3 — Otros' },
  { value: '4', label: '4 — Documento Tributario Electrónico (DTE)' },
];

const TIPO_DOCUMENTO_OPTIONS = [
  { value: '03', label: '03 — Comprobante de Crédito Fiscal (CCF)' },
  { value: '14', label: '14 — Sujeto Excluido (FSE)' },
  { value: '05', label: '05 — Nota de Crédito' },
  { value: '06', label: '06 — Nota de Débito' },
  { value: '04', label: '04 — Nota de Remisión' },
  { value: '07', label: '07 — Comprobante de Retención' },
  { value: '11', label: '11 — Factura de Exportación' },
];

const CLASIFICACION_OPTIONS = [
  { value: '1', label: '1 — Costo' },
  { value: '2', label: '2 — Gasto' },
];

const SECTOR_OPTIONS = [
  { value: '1', label: '1 — Industria' },
  { value: '2', label: '2 — Comercio' },
  { value: '3', label: '3 — Servicio' },
];

const TIPO_OPERACION_OPTIONS = [
  { value: '1', label: '1 — Operación local (Renta)' },
  { value: '2', label: '2 — Importación' },
  { value: '3', label: '3 — Internación' },
];

const TIPO_COSTO_GASTO_OPTIONS = [
  { value: '1', label: '1 — Costo' },
  { value: '2', label: '2 — Gasto' },
  { value: '3', label: '3 — Activo fijo / inversión' },
];

const ANEXO_OPTIONS = [
  { value: '3', label: '3 — Anexo 3 (compras locales típicas)' },
  { value: '4', label: '4 — Anexo 4 (importaciones)' },
  { value: '5', label: '5 — Anexo 5 (otros)' },
];

export function ComprasPage() {
  const data = useDataStore(s => s.data);
  const setCollection = useDataStore(s => s.set);
  const patch = useDataStore(s => s.patch);
  const { mode, month, year } = usePeriodStore();
  const [tab, setTab] = useState<Tab>('movimientos');

  return (
    <div>
      <SectionHeader
        title="Compras y costos"
        description={`Crédito fiscal de compras — ${mode === 'annual' ? `Año ${year}` : `${MONTHS[month]} ${year}`}`}
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
      {tab === 'reportes' && <ReportesTab data={data} setCollection={setCollection} patch={patch} mode={mode} month={month} year={year} />}
    </div>
  );
}

/* ═══════════════════════════ MOVIMIENTOS ═══════════════════════════ */

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
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [existingPdf, setExistingPdf] = useState<{ path: string; filename: string } | null>(null);
  const [uploadingPdf, setUploadingPdf] = useState(false);
  const [jsonImporting, setJsonImporting] = useState(false);
  const [jsonWarnings, setJsonWarnings] = useState<string[]>([]);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const jsonRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);

  const rows = data.compras.filter(r => matchesPeriod(r.fecha, mode, month, year));
  const totalMonto = rows.reduce((s, r) => s + num(r.monto), 0);
  const totalIva = rows.reduce((s, r) => s + num(r.ivaCredito), 0);
  const totalRetenido = rows.reduce((s, r) => s + num(r.metadata?.retencionRenta ?? 0), 0);
  const countConRetencion = rows.filter(r => num(r.metadata?.retencionRenta ?? 0) > 0).length;

  function resetModalState() {
    setPdfFile(null);
    setExistingPdf(null);
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

  function openEdit(r: Compra) {
    const m = r.metadata ?? {};
    // Prefer NIT/DUI de la metadata; si falta, intenta heredarlo del contribuyente.
    const linkedContrib = r.nrc ? data.contribuyentes.find(c => c.nrc === r.nrc) : undefined;
    const retencion = num(m.retencionRenta ?? 0);
    const tipoPersona = m.tipoPersona ?? 'natural';
    setForm({
      fecha: r.fecha,
      proveedor: r.proveedor,
      nrc: r.nrc,
      nit: m.nit ?? linkedContrib?.nit ?? '',
      dui: m.dui ?? linkedContrib?.dui ?? '',
      descripcion: r.descripcion,
      monto: r.monto,
      ivaCredito: r.ivaCredito,
      notas: r.notas ?? '',
      claseDocumento: m.claseDocumento ?? '4',
      tipoDocumento: m.tipoDocumento ?? '03',
      numeroDocumento: m.numeroDocumento ?? '',
      numeroControl: m.numeroControl ?? '',
      selloRecibido: m.selloRecibido ?? '',
      tipoOperacion: m.tipoOperacion ?? '1',
      clasificacion: m.clasificacion ?? '2',
      sector: m.sector ?? '2',
      tipoCostoGasto: m.tipoCostoGasto ?? '2',
      numeroAnexo: m.numeroAnexo ?? '3',
      aplicaRetencion: retencion > 0,
      tipoPersona,
      retencionCodigoMH: m.retencionCodigoMH ?? (tipoPersona === 'juridica' ? '9450' : '9300'),
      retencionRenta: retencion > 0 ? retencion.toFixed(2) : '',
      retencionConcepto: m.retencionConcepto ?? '11',
      retencionCodigoIngreso: m.retencionCodigoIngreso ?? (tipoPersona === 'juridica' ? '4' : '2'),
      afpRetenido: m.afpRetenido ?? '',
      isssRetenido: m.isssRetenido ?? '',
    });
    setEditId(r.id);
    resetModalState();
    if (m.pdfPath) {
      setExistingPdf({ path: m.pdfPath, filename: m.pdfFilename ?? 'documento.pdf' });
    }
    setShowModal(true);
  }

  async function handleJsonFile(file: File) {
    setJsonImporting(true);
    setJsonError(null);
    setJsonWarnings([]);
    try {
      const text = await file.text();
      const result = parseDteJson(text, 'compra');
      if (!result.ok) {
        setJsonError(result.error);
        return;
      }
      const d = result.data;

      // Bloquea duplicados antes de prefilear el form.
      const dup = findDuplicate(data.compras, {
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
        proveedor: d.contraparteNombre || prev.proveedor,
        nrc: d.contraparteNrc || prev.nrc,
        nit: d.contraparteNit || prev.nit,
        descripcion: d.descripcion || prev.descripcion,
        monto: d.montoTotal || prev.monto,
        ivaCredito: d.totalIva || prev.ivaCredito,
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
    if (!form.fecha || !form.monto || !form.proveedor || !form.numeroDocumento) return;
    setSaveError(null);

    // Bloquea duplicados antes de guardar (NRC + DTE + sello).
    const dup = findDuplicate(data.compras, {
      numeroControl: form.numeroControl,
      numeroDocumento: form.numeroDocumento,
      selloRecibido: form.selloRecibido,
    }, editId ?? undefined);
    if (dup) {
      setSaveError(`No se puede guardar — ${describeDuplicate(dup)}`);
      return;
    }

    // Validación F-14: si aplica retención, exige NIT (jurídica) o NIT/DUI (natural).
    // Sin esto, el portal del MH rechaza el archivo con "Debe completar NIT o DUI".
    if (form.aplicaRetencion) {
      const nitClean = form.nit.replace(/-/g, '').trim();
      const duiClean = form.dui.replace(/-/g, '').trim();
      if (form.tipoPersona === 'juridica' && !nitClean) {
        setSaveError('Para retención a persona jurídica se requiere NIT del proveedor (campo arriba).');
        return;
      }
      if (form.tipoPersona === 'natural' && !nitClean && !duiClean) {
        setSaveError('Para retención a persona natural se requiere NIT o DUI del proveedor.');
        return;
      }
    }

    setIsSaving(true);

    const ivaAuto = form.ivaCredito !== ''
      ? form.ivaCredito
      : ivaIncluidoToCredito(num(form.monto)).toFixed(2);

    const compraId = editId ?? newId();

    // Si hay PDF nuevo seleccionado, subirlo a Storage primero
    let pdfPath = existingPdf?.path;
    let pdfFilename = existingPdf?.filename;
    if (pdfFile && isSupabaseConfigured) {
      try {
        setUploadingPdf(true);
        pdfPath = await uploadCompraPdf(compraId, pdfFile);
        pdfFilename = pdfFile.name;
      } catch (e) {
        alert(`No se pudo subir el PDF: ${e instanceof Error ? e.message : 'error'}`);
        setUploadingPdf(false);
        setIsSaving(false);
        return;
      } finally {
        setUploadingPdf(false);
      }
    }

    // Retención: si la marcaron pero no llenaron monto, calculamos 10% sobre la base.
    const baseGravada = num(form.monto) - num(form.ivaCredito || ivaIncluidoToCredito(num(form.monto)).toFixed(2));
    const retencionAuto = form.aplicaRetencion
      ? (form.retencionRenta || (baseGravada * RETENCION_RENTA_PCT).toFixed(2))
      : '';

    const metadata: CompraMetadata = {
      source: 'manual',
      claseDocumento: form.claseDocumento,
      tipoDocumento: form.tipoDocumento,
      numeroDocumento: form.numeroDocumento,
      numeroControl: form.numeroControl || undefined,
      selloRecibido: form.selloRecibido || undefined,
      nit: form.nit || undefined,
      dui: form.dui || undefined,
      tipoOperacion: form.tipoOperacion,
      clasificacion: form.clasificacion,
      sector: form.sector,
      tipoCostoGasto: form.tipoCostoGasto,
      numeroAnexo: form.numeroAnexo,
      retencionRenta: retencionAuto || undefined,
      retencionConcepto: form.aplicaRetencion ? form.retencionConcepto : undefined,
      tipoPersona: form.aplicaRetencion ? form.tipoPersona : undefined,
      // Auto-corrige códigos inconsistentes con tipoPersona antes de guardar.
      // Esto evita el error del MH "Código no válido para clase de contribuyente"
      // en compras donde el usuario olvidó alinear los códigos manualmente.
      retencionCodigoMH: form.aplicaRetencion
        ? (form.tipoPersona === 'juridica'
          ? (RETENCION_CODIGO_MH_JURIDICA.some(o => o.value === form.retencionCodigoMH) ? form.retencionCodigoMH : '9450')
          : '9300')
        : undefined,
      retencionCodigoIngreso: form.aplicaRetencion
        ? (form.tipoPersona === 'juridica'
          ? '4'
          : (RETENCION_CODIGO_INGRESO_NATURAL.some(o => o.value === form.retencionCodigoIngreso) ? form.retencionCodigoIngreso : '2'))
        : undefined,
      // AFP/ISSS solo para empleados (op 01/60). En cualquier otra operación
      // los descartamos para que la metadata quede limpia.
      afpRetenido: (form.aplicaRetencion && (form.retencionConcepto === '01' || form.retencionConcepto === '60'))
        ? (form.afpRetenido || undefined)
        : undefined,
      isssRetenido: (form.aplicaRetencion && (form.retencionConcepto === '01' || form.retencionConcepto === '60'))
        ? (form.isssRetenido || undefined)
        : undefined,
      pdfPath,
      pdfFilename,
    };

    const payload: Compra = {
      id: compraId,
      fecha: form.fecha,
      proveedor: form.proveedor,
      nrc: form.nrc,
      descripcion: form.descripcion,
      monto: form.monto,
      ivaCredito: ivaAuto,
      notas: form.notas,
      metadata,
    };

    // Asegura que el proveedor exista en Contribuyentes (lo crea o lo asciende
    // de Cliente → Ambos automáticamente). Match por NRC. También propaga
    // NIT/DUI capturados aquí al contribuyente, si éste los tenía vacíos.
    const ensured = ensureContribuyente(data.contribuyentes, {
      nombre: form.proveedor,
      nrc: form.nrc,
      nit: form.nit || undefined,
      dui: form.dui || undefined,
      role: 'Proveedor',
    });

    try {
      // Save atómico: contribuyentes + compras en un solo upsert al backend.
      await patch(prev => ({
        ...prev,
        contribuyentes: ensured.list,
        compras: editId
          ? prev.compras.map(r => r.id === editId ? payload : r)
          : [...prev.compras, payload],
      }));
      setShowModal(false);
    } finally {
      setIsSaving(false);
    }
  }

  async function del(id: string) {
    // Si la compra tiene PDF adjunto, lo eliminamos de Storage. Lo hacemos
    // best-effort: si falla por permisos o red, el row se borra igual.
    const target = data.compras.find(r => r.id === id);
    const pdfPath = target?.metadata?.pdfPath;
    if (pdfPath && isSupabaseConfigured) {
      try { await deleteCompraPdf(pdfPath); }
      catch (e) { console.warn('[ERP] delete PDF (orphan ok):', e); }
    }
    await setCollection('compras', data.compras.filter(r => r.id !== id));
  }

  const isDTE = form.claseDocumento === '4';
  const baseGravada = num(form.monto) - num(form.ivaCredito || ivaIncluidoToCredito(num(form.monto)).toFixed(2));
  const formValid = !!(form.fecha && form.monto && form.proveedor && form.numeroDocumento);

  // Proveedores disponibles (incluye "Ambos") para el autocomplete del modal.
  const proveedoresOptions = data.contribuyentes.filter(
    c => c.tipo === 'Proveedor' || c.tipo === 'Ambos',
  );
  // Preview de qué pasará en Contribuyentes al guardar (crear / ascender / nada).
  const previewEnsure = ensureContribuyente(data.contribuyentes, {
    nombre: form.proveedor,
    nrc: form.nrc,
    nit: form.nit || undefined,
    dui: form.dui || undefined,
    role: 'Proveedor',
  });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--s-5)' }}>
        <Button onClick={openNew} leading={<Icon name="plus" size={15} />}>Agregar compra</Button>
      </div>

      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginBottom: 'var(--s-5)' }}>
        <KpiCard label="Total compras" size="md" value={fmt(totalMonto)} hint={`${rows.length} registros`} />
        <KpiCard label="IVA crédito fiscal" tone="success" size="md" value={fmt(totalIva)} hint="Acreditable contra débito" />
        <KpiCard label="Subtotal (sin IVA)" size="md" value={fmt(totalMonto - totalIva)} hint="Costo neto" />
        {totalRetenido > 0 && (
          <KpiCard
            label="Retención hecha (F-14)"
            tone="warning"
            size="md"
            value={fmt(totalRetenido)}
            hint={`${countConRetencion} compras con retención`}
          />
        )}
      </div>

      <div className="table-wrap">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Clase / Tipo</th>
                <th>Núm. Documento</th>
                <th>Proveedor</th>
                <th>NRC</th>
                <th className="num">Base gravada</th>
                <th className="num">IVA crédito</th>
                <th className="num">Total</th>
                <th className="num">Retención</th>
                <th style={{ width: 80 }} />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={10}><EmptyState title="Sin compras registradas" description="Agrega tus compras y costos del mes." /></td></tr>
              )}
              {rows.map(r => {
                const m = r.metadata ?? {};
                const base = num(r.monto) - num(r.ivaCredito);
                const retencion = num(m.retencionRenta ?? 0);
                const docCorto = m.numeroDocumento
                  ? (m.claseDocumento === '4' ? m.numeroDocumento.slice(0, 8) + '…' : m.numeroDocumento)
                  : '—';
                return (
                  <tr key={r.id}>
                    <td className="muted">{displayDate(r.fecha)}</td>
                    <td>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--fg-3)' }}>
                        {m.claseDocumento ?? '—'}/{m.tipoDocumento ?? '—'}
                      </span>
                    </td>
                    <td><code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{docCorto}</code></td>
                    <td style={{ fontWeight: 500 }}>{r.proveedor}</td>
                    <td><code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--fg-3)' }}>{r.nrc}</code></td>
                    <td className="num">{fmt(base)}</td>
                    <td className="num" style={{ color: 'var(--success-text)' }}>{fmt(r.ivaCredito)}</td>
                    <td className="num"><strong>{fmt(r.monto)}</strong></td>
                    <td className="num">
                      {retencion > 0
                        ? <span style={{ color: 'var(--warning-text)' }} title="Retención de Renta — entrará al F-14">{fmt(retencion)}</span>
                        : <span style={{ color: 'var(--fg-4)' }}>—</span>}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 'var(--s-1)', justifyContent: 'flex-end', alignItems: 'center' }}>
                        {m.pdfPath && (
                          <button
                            className="btn-icon"
                            style={{ color: 'var(--brand-primary-700)' }}
                            onClick={() => openCompraPdf(m.pdfPath!)}
                            aria-label="Ver PDF"
                            title={m.pdfFilename ?? 'Ver PDF adjunto'}
                          >
                            <Icon name="file-text" size={14} />
                          </button>
                        )}
                        <button className="btn-icon" onClick={() => openEdit(r)} aria-label="Editar"><Icon name="edit" size={14}/></button>
                        <button className="btn-icon" style={{ color: 'var(--danger-text)' }} onClick={() => del(r.id)} aria-label="Eliminar"><Icon name="trash" size={14}/></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows.length > 0 && (
          <div className="table-footer">
            <div className="table-totals">
              <div className="total-item">Total: <strong>{fmt(totalMonto)}</strong></div>
              <div className="total-item">IVA crédito: <strong style={{ color: 'var(--success-text)' }}>{fmt(totalIva)}</strong></div>
              <div className="total-item">Base: <strong>{fmt(totalMonto - totalIva)}</strong></div>
            </div>
            <div className="caption">{rows.length} registros</div>
          </div>
        )}
      </div>

      {showModal && (
        <Modal
          title={editId ? 'Editar compra' : 'Nueva compra'}
          onClose={() => setShowModal(false)}
          onSave={save}
          saveDisabled={!formValid || uploadingPdf || isSaving}
          saveLabel={uploadingPdf ? 'Subiendo PDF…' : isSaving ? 'Guardando…' : 'Guardar'}
        >
          {/* Importar JSON DTE — botón en la parte superior */}
          <div style={{ background: 'var(--brand-primary-50)', border: '1px solid var(--brand-primary-200)', borderRadius: 'var(--r-md)', padding: 'var(--s-3) var(--s-4)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 240px' }}>
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--brand-primary-800)', marginBottom: 2 }}>
                  ¿Tienes el JSON del DTE?
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--brand-primary-700)' }}>
                  Cárgalo y se prellena el formulario con los datos exactos del proveedor.
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
            <Field label={isDTE ? 'Código de Generación *' : 'Núm. Documento *'}>
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
            <Field label="Proveedor *">
              <Input
                type="text"
                list="proveedores-datalist"
                placeholder={proveedoresOptions.length ? 'Empieza a escribir o elige uno…' : 'EUROPA MOTORS, S.A. DE C.V.'}
                value={form.proveedor}
                onChange={e => {
                  const value = e.target.value;
                  // Si lo que escribieron coincide exactamente con un contribuyente,
                  // auto-rellena NRC, NIT y DUI. Si no, deja los campos como estén.
                  const match = proveedoresOptions.find(c => c.nombre === value);
                  setForm(p => ({
                    ...p,
                    proveedor: value,
                    nrc: match ? match.nrc : p.nrc,
                    nit: match ? (match.nit ?? '') : p.nit,
                    dui: match ? (match.dui ?? '') : p.dui,
                  }));
                }}
              />
              <datalist id="proveedores-datalist">
                {proveedoresOptions.map(c => (
                  <option key={c.id} value={c.nombre} label={`NRC ${c.nrc}${c.giro ? ' · ' + c.giro : ''}`} />
                ))}
              </datalist>
              {previewEnsure.action === 'unchanged' && previewEnsure.contribuyente && (
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--success-text)', marginTop: 2 }}>
                  ✓ Proveedor en Contribuyentes — NRC autocompletado
                </span>
              )}
              {previewEnsure.action === 'created' && (
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--info-text)', marginTop: 2 }}>
                  ➕ Se agregará a Contribuyentes como nuevo Proveedor al guardar
                </span>
              )}
              {previewEnsure.action === 'upgraded-to-ambos' && (
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--warning-text)', marginTop: 2 }}>
                  ↑ Existe como Cliente — al guardar se ascenderá a "Ambos"
                </span>
              )}
            </Field>
            <Field label="NRC del proveedor">
              <Input
                type="text"
                placeholder="123456-7"
                value={form.nrc}
                onChange={e => setForm(p => ({ ...p, nrc: e.target.value }))}
              />
            </Field>
          </div>

          <div className="two-col">
            <Field label="NIT del proveedor (opcional)">
              <Input
                type="text"
                placeholder="0614-…"
                value={form.nit}
                onChange={e => setForm(p => ({ ...p, nit: e.target.value }))}
              />
            </Field>
            <div />
          </div>

          <Field label="Descripción">
            <Input
              type="text"
              placeholder="Qué se compró"
              value={form.descripcion}
              onChange={e => setForm(p => ({ ...p, descripcion: e.target.value }))}
            />
          </Field>

          <div className="two-col">
            <Field label="Monto total (con IVA) *">
              <Input
                type="number"
                step="0.01"
                placeholder="0.00"
                value={form.monto}
                onChange={e => setForm(p => ({ ...p, monto: e.target.value, ivaCredito: '' }))}
              />
            </Field>
            <Field label="IVA Crédito Fiscal (auto)">
              <Input
                type="number"
                step="0.01"
                placeholder={form.monto ? fmt(ivaIncluidoToCredito(num(form.monto))) : '0.00'}
                value={form.ivaCredito}
                onChange={e => setForm(p => ({ ...p, ivaCredito: e.target.value }))}
              />
            </Field>
          </div>

          {/* F-930 — Clasificación contable (columnas Q a U del Anexo de Compras) */}
          <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-md)', padding: 'var(--s-4)', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, marginBottom: 'var(--s-2)' }}>
              Clasificación contable F-930 (Anexo de Compras · cols. Q–U)
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-3)', marginBottom: 'var(--s-3)' }}>
              Defaults típicos para una compra local de gasto comercial: <code>1 ; 2 ; 2 ; 2 ; 3</code>.
            </div>
            <div className="two-col">
              <Field label="Q · Tipo de operación (Renta)">
                <Select value={form.tipoOperacion} onChange={e => setForm(p => ({ ...p, tipoOperacion: e.target.value }))}>
                  {TIPO_OPERACION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </Field>
              <Field label="R · Clasificación">
                <Select value={form.clasificacion} onChange={e => setForm(p => ({ ...p, clasificacion: e.target.value }))}>
                  {CLASIFICACION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </Field>
            </div>
            <div className="two-col">
              <Field label="S · Sector">
                <Select value={form.sector} onChange={e => setForm(p => ({ ...p, sector: e.target.value }))}>
                  {SECTOR_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </Field>
              <Field label="T · Tipo de costo / gasto">
                <Select value={form.tipoCostoGasto} onChange={e => setForm(p => ({ ...p, tipoCostoGasto: e.target.value }))}>
                  {TIPO_COSTO_GASTO_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </Field>
            </div>
            <div className="two-col">
              <Field label="U · Anexo">
                <Select value={form.numeroAnexo} onChange={e => setForm(p => ({ ...p, numeroAnexo: e.target.value }))}>
                  {ANEXO_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </Field>
              <div />
            </div>
          </div>

          {/* Retención de Renta (10%) — F-14 */}
          <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-md)', padding: 'var(--s-4)', border: '1px solid var(--border)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', cursor: 'pointer', fontSize: 'var(--text-sm)', fontWeight: 500 }}>
              <input
                type="checkbox"
                checked={form.aplicaRetencion}
                onChange={e => {
                  const checked = e.target.checked;
                  setForm(p => {
                    const baseG = num(p.monto) - num(p.ivaCredito || ivaIncluidoToCredito(num(p.monto)).toFixed(2));
                    return {
                      ...p,
                      aplicaRetencion: checked,
                      retencionRenta: checked
                        ? (p.retencionRenta || (baseG * RETENCION_RENTA_PCT).toFixed(2))
                        : '',
                    };
                  });
                }}
              />
              Aplica retención de Renta — somos Sujeto de Retención
            </label>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-3)', marginTop: 4, marginLeft: 24 }}>
              Si está marcada, esta compra entrará en el reporte F-14 mensual con el monto retenido al proveedor.
            </div>
            {form.aplicaRetencion && (
              <>
                {(() => {
                  // Opciones filtradas según tipo de persona — garantiza coherencia
                  // que el portal del MH valida ("Código no válido para clase de
                  // contribuyente").
                  const codigosMHValidos = form.tipoPersona === 'juridica'
                    ? RETENCION_CODIGO_MH_JURIDICA
                    : RETENCION_CODIGO_MH_NATURAL;
                  const codigosIngresoValidos = form.tipoPersona === 'juridica'
                    ? RETENCION_CODIGO_INGRESO_JURIDICA
                    : RETENCION_CODIGO_INGRESO_NATURAL;
                  return (
                    <>
                      <div className="two-col" style={{ marginTop: 'var(--s-3)' }}>
                        <Field label="Tipo de persona">
                          <Select
                            value={form.tipoPersona}
                            onChange={e => {
                              const next = e.target.value as 'natural' | 'juridica';
                              setForm(p => {
                                // Forzar valores válidos para el nuevo tipo:
                                const nuevoCodMH = next === 'juridica' ? '9450' : '9300';
                                const nuevoCodIngreso = next === 'juridica' ? '4' : '2';
                                return {
                                  ...p,
                                  tipoPersona: next,
                                  retencionCodigoMH: nuevoCodMH,
                                  retencionCodigoIngreso: nuevoCodIngreso,
                                };
                              });
                            }}
                          >
                            {TIPO_PERSONA_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </Select>
                        </Field>
                        <Field label="Código de retención MH (campo 2 del F-14)">
                          <Select
                            value={form.retencionCodigoMH}
                            onChange={e => setForm(p => ({ ...p, retencionCodigoMH: e.target.value }))}
                          >
                            {codigosMHValidos.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </Select>
                        </Field>
                      </div>

                      <div className="two-col">
                        <Field label="Tipo de operación (campo 6 del F-14)">
                          <Select
                            value={form.retencionConcepto}
                            onChange={e => setForm(p => ({ ...p, retencionConcepto: e.target.value }))}
                          >
                            {RETENCION_CONCEPTO_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </Select>
                        </Field>
                        <Field label="Código de ingreso (campo 22 del F-14) *">
                          <Select
                            value={form.retencionCodigoIngreso}
                            onChange={e => setForm(p => ({ ...p, retencionCodigoIngreso: e.target.value }))}
                          >
                            {codigosIngresoValidos.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </Select>
                        </Field>
                      </div>
                    </>
                  );
                })()}

                <Field label="Monto retenido (Renta)">
                  <Input
                    type="number"
                    step="0.01"
                    placeholder={(baseGravada * RETENCION_RENTA_PCT).toFixed(2)}
                    value={form.retencionRenta}
                    onChange={e => setForm(p => ({ ...p, retencionRenta: e.target.value }))}
                  />
                </Field>

                {/* AFP / ISSS — solo aplica a empleados (op 01 con ISR · op 60 sin ISR).
                    Estos van a las columnas 12 y 13 del F-14. Defaults legales:
                    AFP = 7.25% × salario · ISSS = 3% × salario con tope de $30. */}
                {(form.retencionConcepto === '01' || form.retencionConcepto === '60') && (() => {
                  const afpSugerido = (baseGravada * 0.0725).toFixed(2);
                  const isssSugerido = Math.min(baseGravada * 0.03, 30).toFixed(2);
                  return (
                    <>
                      <div style={{ marginTop: 'var(--s-2)', fontSize: 'var(--text-xs)', color: 'var(--fg-3)' }}>
                        Estás reportando una <strong>retención de planilla</strong>. Captura AFP e ISSS retenidos al empleado:
                      </div>
                      <div className="two-col">
                        <Field label={`AFP retenida (sugerido 7.25% = ${afpSugerido})`}>
                          <Input
                            type="number"
                            step="0.01"
                            placeholder={afpSugerido}
                            value={form.afpRetenido}
                            onChange={e => setForm(p => ({ ...p, afpRetenido: e.target.value }))}
                          />
                        </Field>
                        <Field label={`ISSS retenido (sugerido 3% cap $30 = ${isssSugerido})`}>
                          <Input
                            type="number"
                            step="0.01"
                            placeholder={isssSugerido}
                            value={form.isssRetenido}
                            onChange={e => setForm(p => ({ ...p, isssRetenido: e.target.value }))}
                          />
                        </Field>
                      </div>
                    </>
                  );
                })()}

                {form.tipoPersona === 'natural' && (
                  <Field label="DUI del proveedor (alternativo al NIT, formato 12345678-9)">
                    <Input
                      type="text"
                      placeholder="057899133"
                      value={form.dui}
                      onChange={e => setForm(p => ({ ...p, dui: e.target.value }))}
                    />
                  </Field>
                )}
              </>
            )}
          </div>

          <Field label="Notas (opcional)">
            <Input
              type="text"
              placeholder="Observaciones internas"
              value={form.notas}
              onChange={e => setForm(p => ({ ...p, notas: e.target.value }))}
            />
          </Field>

          {/* Adjuntar PDF de respaldo */}
          {isSupabaseConfigured && (
            <Field label="Adjuntar PDF de respaldo (opcional)">
              <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  ref={pdfRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  hidden
                  onChange={e => {
                    const f = e.target.files?.[0];
                    if (f) setPdfFile(f);
                    e.target.value = '';
                  }}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => pdfRef.current?.click()}
                  leading={<Icon name="upload" size={13} />}
                >
                  {pdfFile ? 'Cambiar PDF' : (existingPdf ? 'Reemplazar PDF' : 'Elegir PDF')}
                </Button>
                {pdfFile && (
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--success-text)' }}>
                    <Icon name="check" size={13} /> {pdfFile.name} ({(pdfFile.size / 1024).toFixed(0)} KB)
                  </span>
                )}
                {!pdfFile && existingPdf && (
                  <>
                    <span style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}>
                      <Icon name="file-text" size={13} /> {existingPdf.filename}
                    </span>
                    <Button size="sm" variant="secondary" onClick={() => openCompraPdf(existingPdf.path)}>
                      Ver actual
                    </Button>
                  </>
                )}
              </div>
            </Field>
          )}

          {form.monto && (
            <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-md)', padding: 'var(--s-3) var(--s-4)', display: 'flex', gap: 'var(--s-5)', flexWrap: 'wrap' }}>
              <div className="total-item">Base sin IVA: <strong>{fmt(baseGravada)}</strong></div>
              <div className="total-item">IVA crédito: <strong style={{ color: 'var(--success-text)' }}>{fmt(form.ivaCredito || ivaIncluidoToCredito(num(form.monto)))}</strong></div>
              <div className="total-item">Total: <strong>{fmt(form.monto)}</strong></div>
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

function ReportesTab({ data, setCollection, month, year }: TabProps) {
  const [generating, setGenerating] = useState(false);
  const [generatingF14, setGeneratingF14] = useState(false);
  const [lastBuild, setLastBuild] = useState<{ rowCount: number; excludedNoMetadata: number; total: number } | null>(null);
  const [lastF14, setLastF14] = useState<{ rowCount: number; total: number; missing: { id: string; proveedor: string; fecha: string; retenido: number; motivo: string }[] } | null>(null);

  // Historial: muestra tanto Anexo de Compras como F-14
  const reportes = data.reportesGenerados
    .filter(r => r.tipo === 'anexo_compras' || r.tipo === 'f14_retenciones')
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));

  const reportesPeriodoActual = reportes.filter(r => r.periodoYear === year && r.periodoMonth === month + 1);

  // Preview Anexo de Compras
  const eligiblesPreview = data.compras.filter(c =>
    inPeriod(c.fecha, month, year)
    && !!c.metadata?.claseDocumento
    && !!c.metadata?.tipoDocumento
    && !!c.metadata?.numeroDocumento,
  );
  const totalSinMetadata = data.compras.filter(c =>
    inPeriod(c.fecha, month, year)
    && (!c.metadata?.claseDocumento || !c.metadata?.tipoDocumento || !c.metadata?.numeroDocumento),
  ).length;

  // Preview F-14: compras con retención > 0 en el mes — separamos las que tienen
  // identidad (NIT o DUI, ya sea en la compra O en el contribuyente vinculado)
  // de las que no, para advertir antes de generar.
  const contribByNrc = new Map(data.contribuyentes.filter(c => c.nrc).map(c => [c.nrc, c]));
  const hasIdentity = (c: typeof data.compras[number]) => {
    const m = c.metadata ?? {};
    const linked = c.nrc ? contribByNrc.get(c.nrc) : undefined;
    const nit = ((m.nit && m.nit.trim()) ? m.nit : (linked?.nit ?? '')).replace(/-/g, '').trim();
    const dui = ((m.dui && m.dui.trim()) ? m.dui : (linked?.dui ?? '')).replace(/-/g, '').trim();
    return !!(nit || dui);
  };
  const compraseConRetencion = data.compras.filter(c =>
    inPeriod(c.fecha, month, year) && num(c.metadata?.retencionRenta ?? 0) > 0,
  );
  const eligiblesF14 = compraseConRetencion.filter(hasIdentity);
  const sinIdentidadF14 = compraseConRetencion.filter(c => !hasIdentity(c));
  const totalRetenidoMes = eligiblesF14.reduce((s, c) => s + num(c.metadata?.retencionRenta ?? 0), 0);

  async function generarAnexo() {
    setGenerating(true);
    try {
      const built = buildAnexoCompras({ month, year, compras: data.compras });
      if (built.rowCount === 0) {
        setLastBuild({ rowCount: 0, excludedNoMetadata: built.excludedNoMetadata, total: 0 });
        return;
      }
      const reporte = makeReporteFromAnexoCompras(built, month, year);
      const next = [...data.reportesGenerados, reporte];
      await setCollection('reportesGenerados', next);
      downloadReporte(reporte);
      setLastBuild({ rowCount: built.rowCount, excludedNoMetadata: built.excludedNoMetadata, total: built.totalAmount });
    } finally {
      setGenerating(false);
    }
  }

  async function generarF14() {
    setGeneratingF14(true);
    try {
      const built = buildF14Retenciones({
        month, year,
        compras: data.compras,
        contribuyentes: data.contribuyentes,
      });
      if (built.rowCount === 0) {
        setLastF14({ rowCount: 0, total: 0, missing: built.missingIdentity });
        return;
      }
      const reporte = makeReporteFromF14(built, month, year);
      const next = [...data.reportesGenerados, reporte];
      await setCollection('reportesGenerados', next);
      downloadReporte(reporte);
      setLastF14({ rowCount: built.rowCount, total: built.totalRetenido, missing: built.missingIdentity });
    } finally {
      setGeneratingF14(false);
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
              Anexo de Compras · {MONTHS[month]} {year}
            </div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-3)' }}>
              Genera el archivo CSV (formato F-930 / Libro de Compras del MH) para el mes seleccionado.
              Cambia el período desde el selector superior antes de generar.
            </div>
            <div style={{ marginTop: 'var(--s-3)', fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}>
              <strong>{eligiblesPreview.length}</strong> compra(s) listas para exportar
              {totalSinMetadata > 0 && (
                <span style={{ color: 'var(--warning-text)' }}>
                  {' '}· <strong>{totalSinMetadata}</strong> sin Clase/Tipo/Núm. Doc. (se omitirán)
                </span>
              )}
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
            No hay compras con datos fiscales completos para {MONTHS[month]} {year}.
            {lastBuild.excludedNoMetadata > 0 && (
              <> {lastBuild.excludedNoMetadata} compra(s) del período fueron omitidas porque les falta Clase de Documento, Tipo o Número.</>
            )}
          </div>
        </div>
      )}
      {lastBuild && lastBuild.rowCount > 0 && (
        <div className="banner banner-success" style={{ marginBottom: 'var(--s-5)' }}>
          <Icon name="check" size={16} />
          <div>
            Reporte generado: <strong>{lastBuild.rowCount}</strong> compras · Base total <strong>{fmt(lastBuild.total)}</strong>.
            {lastBuild.excludedNoMetadata > 0 && <> Se omitieron {lastBuild.excludedNoMetadata} compras sin metadata.</>}
          </div>
        </div>
      )}

      {/* F-14 — Anexo de Retenciones de Renta */}
      <div className="kpi-card" style={{ marginBottom: 'var(--s-5)', padding: 'var(--s-6)', borderTop: '3px solid var(--brand-accent-500)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s-4)', flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 360px' }}>
            <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, marginBottom: 4 }}>
              F-14 — Retenciones de Renta · {MONTHS[month]} {year}
            </div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-3)' }}>
              CSV con las compras del mes donde retuviste 10% (u otro %) en concepto de Renta a tus proveedores.
              Solo incluye las que marcaste como "Aplica retención".
            </div>
            <div style={{ marginTop: 'var(--s-3)', fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}>
              <strong>{eligiblesF14.length}</strong> compra(s) con retención válida
              {totalRetenidoMes > 0 && (
                <> · Total retenido <strong style={{ color: 'var(--warning-text)' }}>{fmt(totalRetenidoMes)}</strong></>
              )}
              {sinIdentidadF14.length > 0 && (
                <span style={{ color: 'var(--danger-text)' }}>
                  {' '}· <strong>{sinIdentidadF14.length}</strong> sin NIT/DUI (no se exportarán)
                </span>
              )}
            </div>
          </div>
          <Button
            variant="secondary"
            onClick={generarF14}
            disabled={generatingF14 || eligiblesF14.length === 0}
            leading={<Icon name="download" size={15} />}
          >
            {generatingF14 ? 'Generando…' : 'Generar F-14'}
          </Button>
        </div>

        {/* Advertencia: compras sin NIT/DUI */}
        {sinIdentidadF14.length > 0 && (
          <div style={{
            marginTop: 'var(--s-4)', padding: 'var(--s-3) var(--s-4)',
            background: 'var(--danger-bg)', border: '1px solid var(--danger-border)',
            borderRadius: 'var(--r-md)', fontSize: 'var(--text-sm)',
          }}>
            <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'center', marginBottom: 4 }}>
              <Icon name="alert" size={14} style={{ color: 'var(--danger-text)' }} />
              <strong style={{ color: 'var(--danger-text)' }}>
                Estas compras no se incluirán en el F-14 hasta que les agregues NIT o DUI:
              </strong>
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-2)', marginTop: 4, marginLeft: 22 }}>
              El portal del MH rechaza filas con ambos campos vacíos. Edita cada compra y agrega NIT (jurídicas) o DUI (naturales).
            </div>
            <ul style={{ marginTop: 'var(--s-2)', marginLeft: 22, padding: 0, fontSize: 'var(--text-xs)', listStyle: 'disc' }}>
              {sinIdentidadF14.slice(0, 8).map(c => (
                <li key={c.id} style={{ marginLeft: 16, marginTop: 2 }}>
                  <strong>{c.proveedor}</strong> · {displayDate(c.fecha)} · retenido {fmt(c.metadata?.retencionRenta ?? 0)}
                </li>
              ))}
              {sinIdentidadF14.length > 8 && (
                <li style={{ marginLeft: 16, marginTop: 2, color: 'var(--fg-3)' }}>
                  …y {sinIdentidadF14.length - 8} más
                </li>
              )}
            </ul>
          </div>
        )}
      </div>

      {lastF14 && lastF14.rowCount === 0 && (
        <div className="banner banner-warning" style={{ marginBottom: 'var(--s-5)' }}>
          <Icon name="alert" size={16} />
          <div>
            No hay compras con retención válida en {MONTHS[month]} {year}.
            {lastF14.missing.length > 0 && <> {lastF14.missing.length} compra(s) están excluidas por falta de NIT/DUI.</>}
            {lastF14.missing.length === 0 && <> Marca las compras correspondientes con la casilla "Aplica retención de Renta" en el modal.</>}
          </div>
        </div>
      )}
      {lastF14 && lastF14.rowCount > 0 && (
        <div className="banner banner-success" style={{ marginBottom: 'var(--s-5)' }}>
          <Icon name="check" size={16} />
          <div>
            F-14 generado: <strong>{lastF14.rowCount}</strong> compras retenidas · Total retenido <strong>{fmt(lastF14.total)}</strong>.
            {lastF14.missing.length > 0 && (
              <> Se omitieron <strong>{lastF14.missing.length}</strong> compras por falta de NIT/DUI.</>
            )}
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
                <th>Tipo</th>
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
                <tr><td colSpan={7}>
                  <EmptyState title="Sin reportes generados aún" description="Cuando generes tu primer Anexo de Compras o F-14, aparecerá aquí." />
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
  const tipoLabel = reporte.tipo === 'f14_retenciones' ? 'F-14' : 'Anexo Compras';
  const tipoColor = reporte.tipo === 'f14_retenciones' ? 'var(--brand-accent-700)' : 'var(--brand-primary-700)';
  return (
    <tr>
      <td>
        <span style={{
          fontSize: 'var(--text-xs)', fontWeight: 600, padding: '2px 8px',
          borderRadius: 'var(--r-pill)', background: 'var(--surface-2)',
          border: '1px solid var(--border)', color: tipoColor,
        }}>{tipoLabel}</span>
      </td>
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
