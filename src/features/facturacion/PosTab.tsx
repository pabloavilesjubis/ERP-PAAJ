import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/icons/Icon';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { fmt, newId, num } from '@/lib/utils/format';
import { useDataStore } from '@/stores/data.store';
import { env } from '@/config/env';
import {
  ACTIVIDADES_ECONOMICAS, DEPARTAMENTOS, getMunicipiosFor,
} from '@/lib/catalogos/mh';
import {
  bumpCorrelativo, getProximoConsecutivo, tipoDteToCodigo,
} from '@/lib/dte/correlativos';
import {
  downloadDtePdf, downloadDteTicket, extractPdfData, type PdfData,
} from '@/lib/dte/pdf';
import {
  buildCcfData, buildFcfData, buildFseData, buildNcData, calcCartTotals,
  type CartLine, type NcReference,
} from '@/lib/dte/payload';
import {
  DteServiceError, emitDte, pingDteService, type DteEmitSuccess, type DteTipo,
} from '@/lib/dte/client';
import type { Contribuyente, Producto, VentaConsumidor, VentaContribuyente } from '@/types/domain';

type ClienteAddTipo = 'consumidor' | 'contribuyente';

interface ClienteForm {
  tipo: ClienteAddTipo;
  nombre: string;
  nit: string;
  dui: string;
  nrc: string;
  /** Código actividad económica (CAT-019). 'otro' habilita modo libre. */
  codActividad: string;
  /** Descripción libre cuando codActividad === 'otro' o cuando se necesita
   *  ajustar el descActividad propuesto por el catálogo. */
  giro: string;
  /** Código departamento (CAT-012). */
  departamento: string;
  /** Código municipio (CAT-013) — único dentro del departamento. */
  municipio: string;
  /** Dirección complemento (calle, colonia, número). */
  direccion: string;
  email: string;
  telefono: string;
}

const emptyClienteForm: ClienteForm = {
  tipo: 'consumidor',
  nombre: '',
  nit: '',
  dui: '',
  nrc: '',
  codActividad: '',
  giro: '',
  departamento: '06',  // San Salvador como default razonable para PyMEs
  municipio: '14',     // San Salvador (capital)
  direccion: '',
  email: '',
  telefono: '',
};

type TipoFilter = 'todos' | 'servicio' | 'bien';

export interface NcContext {
  ref: NcReference;
  clienteNit?: string;
  clienteNombre: string;
  /** Opcional: callback cuando se completa la NC para limpiar el state del padre. */
  onCompleted?: () => void;
}

interface PosTabProps {
  ncContext?: NcContext;
}

export function PosTab({ ncContext }: PosTabProps = {}) {
  const productos = useDataStore(s => s.data.productos);
  const contribuyentes = useDataStore(s => s.data.contribuyentes);
  const correlativosDte = useDataStore(s => s.data.correlativosDte);
  const patch = useDataStore(s => s.patch);

  const [search, setSearch] = useState('');
  const [tipoFilter, setTipoFilter] = useState<TipoFilter>('todos');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [tipoDte, setTipoDte] = useState<DteTipo>(ncContext ? 'nc' : 'fcf');
  const [clienteId, setClienteId] = useState<string>('');
  // Consecutivo auto-driven: viene del store según el tipo activo. El usuario
  // puede override si necesita (caso: re-emitir tras anulación), pero por
  // default sigue la secuencia para no chocar con duplicados en el MH.
  const proximoAuto = getProximoConsecutivo(correlativosDte, tipoDteToCodigo(tipoDte));
  const [consecutivoOverride, setConsecutivoOverride] = useState<string>('');
  const consecutivo = consecutivoOverride !== '' ? consecutivoOverride : String(proximoAuto);
  const [emitting, setEmitting] = useState(false);
  const [result, setResult] = useState<DteEmitSuccess | null>(null);
  const [error, setError] = useState<{ message: string; details?: string[] } | null>(null);
  const [serviceStatus, setServiceStatus] = useState<{ ok: boolean; mhEnv?: string } | null>(null);
  const [showClienteModal, setShowClienteModal] = useState(false);
  const [clienteForm, setClienteForm] = useState<ClienteForm>(emptyClienteForm);
  // Modal automático tras emisión exitosa — para imprimir ticket / enviar correo
  const [postEmit, setPostEmit] = useState<{
    pdfData: PdfData;
    receptorEmail: string | null;
    receptorNombre: string;
  } | null>(null);

  // Cuando llega un ncContext (creando NC desde DTEs Emitidos), forzamos el
  // tipo a NC y pre-seleccionamos el cliente original del CCF por NIT.
  useEffect(() => {
    if (!ncContext) return;
    setTipoDte('nc');
    if (ncContext.clienteNit) {
      const cleanNit = ncContext.clienteNit.replace(/-/g, '');
      const match = contribuyentes.find(
        c => (c.nit ?? '').replace(/-/g, '') === cleanNit,
      );
      if (match) setClienteId(match.id);
    }
  }, [ncContext, contribuyentes]);

  const productosActivos = useMemo(
    () => productos.filter(p => p.activo),
    [productos],
  );

  const filteredProductos = useMemo(() => {
    return productosActivos.filter(p => {
      if (tipoFilter !== 'todos' && p.tipo !== tipoFilter) return false;
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return p.nombre.toLowerCase().includes(q)
        || (p.codigo?.toLowerCase() ?? '').includes(q);
    });
  }, [productosActivos, tipoFilter, search]);

  // Tolerante a inconsistencias de casing en el campo `tipo` (datos antiguos).
  const baseClientes = useMemo(() => {
    return contribuyentes
      .filter(c => {
        const t = String(c.tipo ?? '').trim().toLowerCase();
        return t === 'cliente' || t === 'ambos';
      })
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
  }, [contribuyentes]);

  // CCF exige contribuyente formal (NIT + NRC). FCF y FSE aceptan cualquier
  // cliente — incluso consumidores con sólo DUI o sin doc.
  const clientesElegibles = useMemo(() => {
    if (tipoDte === 'ccf') {
      return baseClientes.filter(c =>
        (c.nit ?? '').replace(/-/g, '').trim()
        && (c.nrc ?? '').replace(/-/g, '').trim(),
      );
    }
    return baseClientes;
  }, [baseClientes, tipoDte]);

  const cliente = clientesElegibles.find(c => c.id === clienteId) ?? null;
  const totals = calcCartTotals(cart, tipoDte);

  function addToCart(p: Producto) {
    setResult(null);
    setError(null);
    setCart(prev => {
      const existing = prev.find(l => l.producto.id === p.id);
      if (existing) {
        return prev.map(l => l.producto.id === p.id
          ? { ...l, cantidad: l.cantidad + 1 }
          : l);
      }
      return [...prev, {
        producto: p,
        cantidad: 1,
        precioUnitario: num(p.precioUnitario),
      }];
    });
  }

  function updateLine(id: string, patch: Partial<CartLine>): void {
    setCart(prev => prev.map(l => l.producto.id === id ? { ...l, ...patch } : l));
  }

  function removeLine(id: string) {
    setCart(prev => prev.filter(l => l.producto.id !== id));
  }

  function clearCart() {
    setCart([]);
    setResult(null);
    setError(null);
  }

  async function checkService() {
    const status = await pingDteService();
    setServiceStatus(status);
  }

  function openAddCliente(initialTipo: ClienteAddTipo) {
    setClienteForm({ ...emptyClienteForm, tipo: initialTipo });
    setShowClienteModal(true);
  }

  async function saveCliente() {
    const f = clienteForm;
    if (!f.nombre.trim()) return;
    if (f.tipo === 'contribuyente' && (!f.nit.trim() || !f.nrc.trim())) return;

    // Si eligió actividad del catálogo, derivamos giro/codActividad del catálogo;
    // si eligió "otro" el usuario escribe ambos a mano.
    let codActividad: string | undefined;
    let giroDescriptivo: string | undefined;
    if (f.codActividad && f.codActividad !== 'otro') {
      const cat = ACTIVIDADES_ECONOMICAS.find(a => a.codigo === f.codActividad);
      codActividad = f.codActividad;
      giroDescriptivo = cat?.nombre ?? f.giro.trim() ?? undefined;
    } else if (f.giro.trim()) {
      giroDescriptivo = f.giro.trim();
    }

    const nuevo: Contribuyente = {
      id: newId(),
      nombre: f.nombre.trim(),
      tipo: 'Cliente',
      nit: f.nit.trim(),
      nrc: f.nrc.trim(),
      dui: f.dui.trim() || undefined,
      giro: giroDescriptivo,
      codActividad,
      departamento: f.departamento || undefined,
      municipio: f.municipio || undefined,
      direccion: f.direccion.trim() || undefined,
      email: f.email.trim() || undefined,
      telefono: f.telefono.trim() || undefined,
    };
    await patch(prev => ({
      ...prev,
      contribuyentes: [...prev.contribuyentes, nuevo],
    }));
    setClienteId(nuevo.id);   // auto-selecciona el recién creado
    setShowClienteModal(false);
  }

  const clienteFormValid = (() => {
    if (!clienteForm.nombre.trim()) return false;
    if (clienteForm.tipo === 'consumidor') return true;
    // Contribuyente: requiere todo lo que el schema CCF exige no-nullable.
    if (!clienteForm.nit.trim() || !clienteForm.nrc.trim()) return false;
    if (!clienteForm.email.trim()) return false;
    if (!clienteForm.departamento || !clienteForm.municipio) return false;
    if (!clienteForm.codActividad) return false;
    if (clienteForm.codActividad === 'otro' && !clienteForm.giro.trim()) return false;
    return true;
  })();

  async function emit() {
    if (cart.length === 0) return;

    if (tipoDte === 'ccf' && !cliente) {
      setError({ message: 'CCF requiere un cliente seleccionado (contribuyente con NIT y NRC).' });
      return;
    }
    if (tipoDte === 'fse' && !cliente) {
      setError({ message: 'FSE requiere un sujeto excluido seleccionado.' });
      return;
    }
    if (tipoDte === 'nc' && !ncContext) {
      setError({ message: 'NC requiere abrirse desde un CCF emitido (botón "Crear NC" en DTEs Emitidos).' });
      return;
    }
    if (tipoDte === 'nc' && !cliente) {
      setError({ message: 'NC requiere el cliente original del CCF.' });
      return;
    }

    setEmitting(true);
    setResult(null);
    setError(null);

    try {
      let data: Record<string, unknown>;
      const consecutivoNum = parseInt(consecutivo, 10) || 1;
      switch (tipoDte) {
        case 'fcf':
          data = buildFcfData({
            consecutivo: consecutivoNum, lines: cart, receptor: cliente,
          });
          break;
        case 'ccf':
          data = buildCcfData({
            consecutivo: consecutivoNum, lines: cart, receptor: cliente!,
          });
          break;
        case 'fse':
          data = buildFseData({
            consecutivo: consecutivoNum, lines: cart, sujetoExcluido: cliente!,
          });
          break;
        case 'nc':
          data = buildNcData({
            consecutivo: consecutivoNum,
            lines: cart,
            receptor: cliente!,
            ncRef: ncContext!.ref,
          });
          break;
      }

      const res = await emitDte({ tipo: tipoDte, data });
      setResult(res);
      // Reset del override — el próximo emit volverá a usar el auto del store
      // (que ya estará incrementado por el bump abajo).
      setConsecutivoOverride('');

      // Persistir en la tabla de ventas correspondiente para que aparezca en
      // los anexos mensuales y en la pestaña DTEs Emitidos.
      // Y actualizar el correlativo: ahora ultimoConsecutivo = el que acabamos
      // de usar. Crítico: sin esto, el siguiente emit usaría el mismo número
      // y el MH lo rechazaría como duplicado.
      const codigoTipo = tipoDteToCodigo(tipoDte);
      await persistVenta({
        tipo: tipoDte,
        cliente,
        cart,
        totals,
        emitResult: res,
        documentoJws: res.documento,
        ncRelacionada: tipoDte === 'nc' ? ncContext?.ref.ccfCodigo : undefined,
      });
      await patch(prev => ({
        ...prev,
        correlativosDte: bumpCorrelativo(prev.correlativosDte, codigoTipo, consecutivoNum),
      }));
      setCart([]);

      // Dispara modal post-emisión: ofrece imprimir ticket y enviar correo
      // sin tener que ir hasta DTEs Emitidos. Pre-llena con el JWS recién
      // firmado — extractPdfData saca emisor/items/totales del payload.
      const fecha = new Date().toISOString().slice(0, 10);
      const pdfData = extractPdfData({
        tipo: tipoDte,
        codigoGeneracion: res.codigoGeneracion,
        numeroControl: res.numeroControl,
        selloRecibido: res.selloRecibido,
        fecha,
        cliente: cliente?.nombre ?? 'Consumidor anónimo',
        total: totals.total,
        documentoJws: res.documento,
        anulado: false,
      });
      setPostEmit({
        pdfData,
        receptorEmail: cliente?.email ?? null,
        receptorNombre: cliente?.nombre ?? 'Cliente',
      });

      // Si era NC, notifica al padre para limpiar el context
      if (tipoDte === 'nc') ncContext?.onCompleted?.();
    } catch (e) {
      if (e instanceof DteServiceError) {
        const obs = (e.details?.failures as Array<{ message: string; path: string }> | undefined)
          ?.map(f => `${f.path}: ${f.message}`);
        setError({
          message: `${e.code} — ${e.message}`,
          details: e.raw?.observaciones ?? obs,
        });
      } else {
        setError({ message: e instanceof Error ? e.message : 'Error desconocido' });
      }
    } finally {
      setEmitting(false);
    }
  }

  async function persistVenta(args: {
    tipo: DteTipo;
    cliente: Contribuyente | null;
    cart: CartLine[];
    totals: { subtotal: number; iva: number; total: number };
    emitResult: DteEmitSuccess;
    documentoJws?: string;
    ncRelacionada?: string;
  }): Promise<void> {
    const { tipo, cliente, cart, totals, emitResult, documentoJws, ncRelacionada } = args;
    const fecha = new Date().toISOString().slice(0, 10);
    const descripcion = cart.map(l => `${l.cantidad}× ${l.producto.nombre}`).join(' · ');

    if (tipo === 'fcf') {
      const venta: VentaConsumidor = {
        id: newId(),
        fecha,
        descripcion,
        monto: totals.total.toFixed(2),
        notas: '',
        metadata: {
          source: 'pos',
          tipoDocumento: '01',
          numeroDocumento: emitResult.codigoGeneracion,
          numeroControl: emitResult.numeroControl,
          codigoGeneracion: emitResult.codigoGeneracion,
          selloRecibido: emitResult.selloRecibido ?? undefined,
          cliente: cliente?.nombre,
          subtotal: (totals.total - totals.iva).toFixed(2),
          iva: totals.iva.toFixed(2),
          documentoJws,
        },
      };
      await patch(prev => ({
        ...prev,
        ventasConsumidor: [...prev.ventasConsumidor, venta],
      }));
    } else if (tipo === 'ccf' || tipo === 'nc') {
      const venta: VentaContribuyente = {
        id: newId(),
        fecha,
        cliente: cliente!.nombre,
        nrc: cliente!.nrc,
        descripcion: tipo === 'nc'
          ? `NC: ${descripcion}`
          : descripcion,
        // NC: el monto representa CRÉDITO al cliente — se reflejará como
        // negativo en los reportes mensuales si filtramos por tipoDocumento.
        gravado: totals.subtotal.toFixed(2),
        exento: '0.00',
        notas: '',
        metadata: {
          source: 'manual',
          claseDocumento: '4',
          tipoDocumento: tipo === 'nc' ? '05' : '03',
          numeroDocumento: emitResult.codigoGeneracion,
          numeroControl: emitResult.numeroControl,
          selloRecibido: emitResult.selloRecibido ?? undefined,
          nit: cliente!.nit,
          documentoJws,
          ncRelacionadaCodigo: ncRelacionada,
        },
      };
      await patch(prev => ({
        ...prev,
        ventasContribuyente: [...prev.ventasContribuyente, venta],
      }));
    }
    // FSE no persistimos como venta (es comprobante de COMPRA al sujeto
    // excluido). La compra correspondiente se registra desde el módulo de
    // Compras manualmente, vinculándola con el codigoGeneracion devuelto.
  }

  const canEmit = cart.length > 0
    && !emitting
    && (tipoDte === 'fcf' || cliente !== null);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 420px', gap: 'var(--s-5)' }}>
      {ncContext && (
        <div style={{
          gridColumn: '1 / -1',
          background: 'var(--brand-accent-50)',
          border: '1px solid var(--brand-accent-300)',
          borderRadius: 'var(--r-md)',
          padding: 'var(--s-3) var(--s-4)',
          fontSize: 'var(--text-sm)',
          display: 'flex', alignItems: 'center', gap: 'var(--s-3)', justifyContent: 'space-between',
        }}>
          <div>
            <strong>Creando Nota de Crédito</strong> sobre CCF{' '}
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{ncContext.ref.ccfCodigo.slice(0, 16)}…</code>
            {' '}emitido a <strong>{ncContext.clienteNombre}</strong>
          </div>
          <button
            onClick={() => ncContext.onCompleted?.()}
            style={{
              fontSize: 'var(--text-xs)', background: 'none', border: 'none',
              color: 'var(--fg-3)', cursor: 'pointer', textDecoration: 'underline',
            }}
          >
            Cancelar NC
          </button>
        </div>
      )}
      {/* ───────── Catálogo ───────── */}
      <div>
        <div style={{ display: 'flex', gap: 'var(--s-2)', marginBottom: 'var(--s-4)', flexWrap: 'wrap' }}>
          <Input
            type="search"
            placeholder="Buscar producto…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ flex: '1 1 200px' }}
            autoFocus
          />
          <Select
            value={tipoFilter}
            onChange={e => setTipoFilter(e.target.value as TipoFilter)}
            style={{ flex: '0 0 150px' }}
          >
            <option value="todos">Todos</option>
            <option value="servicio">Servicios</option>
            <option value="bien">Bienes</option>
          </Select>
        </div>

        {filteredProductos.length === 0 ? (
          <EmptyState
            title={productos.length === 0 ? 'Sin productos en el catálogo' : 'Sin resultados'}
            description={productos.length === 0
              ? 'Ve a la pestaña "Productos" y agrega tu primer producto o servicio.'
              : 'Prueba con otro término de búsqueda.'}
          />
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
            gap: 'var(--s-3)',
          }}>
            {filteredProductos.map(p => (
              <button
                key={p.id}
                onClick={() => addToCart(p)}
                style={{
                  textAlign: 'left',
                  padding: 'var(--s-3)',
                  background: 'var(--surface-1)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r-md)',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  display: 'flex', flexDirection: 'column', gap: 6,
                  minHeight: 100,
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.borderColor = 'var(--brand-primary-500)';
                  e.currentTarget.style.boxShadow = 'var(--shadow-1)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.borderColor = 'var(--border)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                {p.codigo && (
                  <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--fg-3)' }}>
                    {p.codigo}
                  </code>
                )}
                <div style={{ fontWeight: 500, fontSize: 'var(--text-sm)', flex: 1 }}>{p.nombre}</div>
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                }}>
                  <span style={{
                    fontSize: 'var(--text-xs)',
                    color: p.tipo === 'servicio' ? 'var(--brand-primary-700)' : 'var(--fg-3)',
                  }}>
                    {p.tipo === 'servicio' ? 'Servicio' : 'Bien'}
                  </span>
                  <strong style={{ fontSize: 'var(--text-md)' }}>{fmt(p.precioUnitario)}</strong>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ───────── Carrito ───────── */}
      <div style={{
        background: 'var(--surface-1)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-lg)',
        padding: 'var(--s-4)',
        position: 'sticky',
        top: 'var(--s-4)',
        alignSelf: 'flex-start',
        display: 'flex', flexDirection: 'column', gap: 'var(--s-3)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 600, fontSize: 'var(--text-md)' }}>Carrito</div>
          {cart.length > 0 && (
            <button
              onClick={clearCart}
              style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-3)', background: 'none', border: 'none', cursor: 'pointer' }}
            >
              Limpiar
            </button>
          )}
        </div>

        {/* Tipo de documento */}
        <div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-3)', marginBottom: 4 }}>Tipo de documento</div>
          {ncContext ? (
            <div style={{
              padding: '8px 12px',
              background: 'var(--brand-accent-700)',
              color: '#fff',
              fontSize: 'var(--text-xs)',
              fontWeight: 600,
              borderRadius: 'var(--r-md)',
              textAlign: 'center',
            }}>
              NC — Nota de Crédito
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 4 }}>
              {(['fcf', 'ccf', 'fse'] as DteTipo[]).map(t => (
                <button
                  key={t}
                  onClick={() => { setTipoDte(t); setResult(null); setError(null); }}
                  style={{
                    flex: 1,
                    padding: '8px 4px',
                    fontSize: 'var(--text-xs)',
                    fontWeight: 600,
                    background: tipoDte === t ? 'var(--brand-primary-700)' : 'var(--surface-2)',
                    color: tipoDte === t ? '#fff' : 'var(--fg-2)',
                    border: '1px solid ' + (tipoDte === t ? 'var(--brand-primary-700)' : 'var(--border)'),
                    borderRadius: 'var(--r-md)',
                    cursor: 'pointer',
                  }}
                >
                  {t.toUpperCase()}
                </button>
              ))}
            </div>
          )}
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-3)', marginTop: 4 }}>
            {tipoDte === 'fcf' && 'Factura Consumidor — IVA incluido en el precio'}
            {tipoDte === 'ccf' && 'Crédito Fiscal — IVA se suma al precio'}
            {tipoDte === 'fse' && 'Sujeto Excluido — sin IVA (compra a no contribuyente)'}
            {tipoDte === 'nc' && 'Crédito al cliente — ajusta el CCF original'}
          </div>
        </div>

        {/* Cliente */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-3)' }}>
              {tipoDte === 'fse' ? 'Sujeto excluido' : 'Cliente'}
              {tipoDte !== 'fcf' && <span style={{ color: 'var(--danger-text)', marginLeft: 4 }}>*</span>}
            </span>
            <span style={{ fontSize: 10, color: 'var(--fg-4)' }}>
              {clientesElegibles.length} disponible{clientesElegibles.length === 1 ? '' : 's'}
              {tipoDte === 'ccf' && baseClientes.length > clientesElegibles.length
                && ` · ${baseClientes.length - clientesElegibles.length} sin NIT/NRC`}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <Select value={clienteId} onChange={e => setClienteId(e.target.value)} style={{ flex: 1 }}>
              <option value="">{tipoDte === 'fcf' ? '— Consumidor anónimo —' : '— Selecciona —'}</option>
              {clientesElegibles.map(c => {
                const doc = c.nit?.trim() || c.dui?.trim() || c.nrc?.trim() || 'sin doc.';
                return (
                  <option key={c.id} value={c.id}>{c.nombre} · {doc}</option>
                );
              })}
            </Select>
            <button
              type="button"
              onClick={() => openAddCliente(tipoDte === 'ccf' ? 'contribuyente' : 'consumidor')}
              title="Agregar cliente"
              style={{
                width: 36, height: 36,
                background: 'var(--brand-primary-50)',
                border: '1px solid var(--brand-primary-200)',
                borderRadius: 'var(--r-md)',
                color: 'var(--brand-primary-700)',
                cursor: 'pointer', fontSize: 18,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <Icon name="plus" size={16} />
            </button>
          </div>
          {clientesElegibles.length === 0 && tipoDte === 'ccf' && baseClientes.length > 0 && (
            <div style={{ fontSize: 10, color: 'var(--warning-text)', marginTop: 4 }}>
              Tus clientes existentes no tienen NIT+NRC completos. CCF los exige.
            </div>
          )}
          {clientesElegibles.length === 0 && baseClientes.length === 0 && (
            <div style={{ fontSize: 10, color: 'var(--fg-3)', marginTop: 4 }}>
              No hay clientes registrados — usa el botón <strong>+</strong> para agregar uno.
            </div>
          )}
        </div>

        {/* Líneas del carrito */}
        <div style={{ borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', maxHeight: 280, overflowY: 'auto' }}>
          {cart.length === 0 ? (
            <div style={{ padding: 'var(--s-4)', textAlign: 'center', color: 'var(--fg-3)', fontSize: 'var(--text-sm)' }}>
              Toca un producto para agregarlo
            </div>
          ) : (
            cart.map(l => (
              <div key={l.producto.id} style={{
                padding: 'var(--s-2) 0', borderBottom: '1px solid var(--border)',
                display: 'flex', flexDirection: 'column', gap: 4,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, fontSize: 'var(--text-sm)', fontWeight: 500 }}>{l.producto.nombre}</div>
                  <button
                    className="btn-icon"
                    onClick={() => removeLine(l.producto.id)}
                    style={{ color: 'var(--danger-text)' }}
                    aria-label="Quitar"
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--text-xs)' }}>
                  <input
                    type="number"
                    min={1}
                    step="1"
                    value={l.cantidad}
                    onChange={e => updateLine(l.producto.id, { cantidad: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                    style={{ width: 50, padding: '2px 6px', fontSize: 'var(--text-xs)', border: '1px solid var(--border)', borderRadius: 4 }}
                  />
                  <span style={{ color: 'var(--fg-3)' }}>×</span>
                  <input
                    type="number"
                    step="0.01"
                    value={l.precioUnitario}
                    onChange={e => updateLine(l.producto.id, { precioUnitario: num(e.target.value) })}
                    style={{ width: 80, padding: '2px 6px', fontSize: 'var(--text-xs)', border: '1px solid var(--border)', borderRadius: 4 }}
                  />
                  <span style={{ marginLeft: 'auto', fontWeight: 600 }}>
                    {fmt(l.cantidad * l.precioUnitario)}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Totales */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--text-sm)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--fg-3)' }}>
              {tipoDte === 'fcf' ? 'Subtotal (IVA incl.)' : 'Subtotal'}
            </span>
            <span>{fmt(totals.subtotal)}</span>
          </div>
          {tipoDte !== 'fse' && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--fg-3)' }}>
                {tipoDte === 'fcf' ? 'IVA (implícito)' : 'IVA 13%'}
              </span>
              <span style={{ color: tipoDte === 'fcf' ? 'var(--fg-3)' : 'var(--success-text)' }}>
                {fmt(totals.iva)}
              </span>
            </div>
          )}
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            paddingTop: 6, borderTop: '1px solid var(--border)',
            fontSize: 'var(--text-md)', fontWeight: 700,
          }}>
            <span>Total</span>
            <span>{fmt(totals.total)}</span>
          </div>
        </div>

        {/* Consecutivo auto-driven desde store, override opcional */}
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 4,
          fontSize: 'var(--text-xs)', color: 'var(--fg-3)',
          padding: 'var(--s-2)', background: 'var(--surface-2)',
          borderRadius: 'var(--r-md)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Próximo consecutivo ({tipoDte.toUpperCase()})</span>
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-2)' }}>
              {String(proximoAuto).padStart(15, '0')}
            </code>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 10 }}>Override (vacío = auto):</span>
            <input
              type="number"
              min={1}
              placeholder={String(proximoAuto)}
              value={consecutivoOverride}
              onChange={e => setConsecutivoOverride(e.target.value)}
              style={{ flex: 1, padding: '2px 6px', border: '1px solid var(--border)', borderRadius: 4, fontSize: 10 }}
            />
          </div>
          <div style={{ fontSize: 10, color: 'var(--fg-4)' }}>
            Configurar el último emitido en pestaña <strong>Correlativos</strong>.
          </div>
        </div>

        <Button
          onClick={emit}
          disabled={!canEmit}
          leading={<Icon name="upload" size={15} />}
          style={{ width: '100%', justifyContent: 'center' }}
        >
          {emitting
            ? 'Emitiendo…'
            : `Emitir ${tipoDte.toUpperCase()} · ${fmt(totals.total)}`}
        </Button>

        {/* Estado dte-service */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          fontSize: 'var(--text-xs)', color: 'var(--fg-3)',
          paddingTop: 'var(--s-2)', borderTop: '1px solid var(--border)',
        }}>
          <span>
            <Icon name="cloud" size={11} style={{ marginRight: 4 }} />
            {env.dteServiceUrl}
          </span>
          <button
            onClick={checkService}
            style={{ background: 'none', border: 'none', color: 'var(--brand-primary-700)', cursor: 'pointer', fontSize: 'var(--text-xs)' }}
          >
            {serviceStatus === null
              ? 'verificar'
              : serviceStatus.ok
                ? `✓ ${serviceStatus.mhEnv}`
                : '✗ no responde'}
          </button>
        </div>

        {/* Resultado / errores */}
        {result && (
          <div className="banner banner-success" style={{ fontSize: 'var(--text-xs)' }}>
            <Icon name="check" size={14} />
            <div>
              <strong>{result.estado}</strong> — sello {result.selloRecibido?.slice(0, 16)}…
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginTop: 2 }}>
                {result.numeroControl}
              </div>
            </div>
          </div>
        )}
        {error && (
          <div className="banner banner-danger" style={{ fontSize: 'var(--text-xs)' }}>
            <Icon name="alert" size={14} />
            <div>
              <strong>{error.message}</strong>
              {error.details && error.details.length > 0 && (
                <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                  {error.details.slice(0, 5).map((d, i) => (
                    <li key={i} style={{ fontSize: 10 }}>{d}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      {postEmit && (
        <PostEmitModal
          pdfData={postEmit.pdfData}
          receptorEmail={postEmit.receptorEmail}
          receptorNombre={postEmit.receptorNombre}
          emisorNombre={postEmit.pdfData.emisor.nombreComercial || postEmit.pdfData.emisor.nombre}
          onClose={() => setPostEmit(null)}
        />
      )}
      {showClienteModal && (
        <Modal
          title="Agregar cliente"
          onClose={() => setShowClienteModal(false)}
          onSave={saveCliente}
          saveDisabled={!clienteFormValid}
          saveLabel="Guardar cliente"
        >
          {/* Toggle Consumidor / Contribuyente */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 'var(--s-3)' }}>
            <button
              type="button"
              onClick={() => setClienteForm(p => ({ ...p, tipo: 'consumidor' }))}
              style={{
                flex: 1, padding: '10px 12px',
                background: clienteForm.tipo === 'consumidor' ? 'var(--brand-primary-700)' : 'var(--surface-2)',
                color: clienteForm.tipo === 'consumidor' ? '#fff' : 'var(--fg-2)',
                border: '1px solid ' + (clienteForm.tipo === 'consumidor' ? 'var(--brand-primary-700)' : 'var(--border)'),
                borderRadius: 'var(--r-md)',
                cursor: 'pointer',
                fontSize: 'var(--text-sm)', fontWeight: 600,
                textAlign: 'left',
              }}
            >
              <div>Cliente Consumidor</div>
              <div style={{ fontSize: 10, fontWeight: 400, marginTop: 2, opacity: 0.85 }}>
                Persona individual · DUI · sólo FCF
              </div>
            </button>
            <button
              type="button"
              onClick={() => setClienteForm(p => ({ ...p, tipo: 'contribuyente' }))}
              style={{
                flex: 1, padding: '10px 12px',
                background: clienteForm.tipo === 'contribuyente' ? 'var(--brand-primary-700)' : 'var(--surface-2)',
                color: clienteForm.tipo === 'contribuyente' ? '#fff' : 'var(--fg-2)',
                border: '1px solid ' + (clienteForm.tipo === 'contribuyente' ? 'var(--brand-primary-700)' : 'var(--border)'),
                borderRadius: 'var(--r-md)',
                cursor: 'pointer',
                fontSize: 'var(--text-sm)', fontWeight: 600,
                textAlign: 'left',
              }}
            >
              <div>Cliente Contribuyente</div>
              <div style={{ fontSize: 10, fontWeight: 400, marginTop: 2, opacity: 0.85 }}>
                Empresa con NRC · NIT · CCF/FCF
              </div>
            </button>
          </div>

          <Field label="Nombre / Razón social *">
            <Input
              type="text"
              placeholder={clienteForm.tipo === 'consumidor' ? 'Juan Pérez' : 'ACME, S.A. de C.V.'}
              value={clienteForm.nombre}
              onChange={e => setClienteForm(p => ({ ...p, nombre: e.target.value }))}
              autoFocus
            />
          </Field>

          {clienteForm.tipo === 'consumidor' ? (
            <>
              <div className="two-col">
                <Field label="DUI">
                  <Input
                    type="text"
                    placeholder="12345678-9"
                    value={clienteForm.dui}
                    onChange={e => setClienteForm(p => ({ ...p, dui: e.target.value }))}
                  />
                </Field>
                <Field label="NIT (alternativo)">
                  <Input
                    type="text"
                    placeholder="0614-…"
                    value={clienteForm.nit}
                    onChange={e => setClienteForm(p => ({ ...p, nit: e.target.value }))}
                  />
                </Field>
              </div>
              <div className="two-col">
                <Field label="Correo">
                  <Input
                    type="email"
                    placeholder="cliente@ejemplo.sv"
                    value={clienteForm.email}
                    onChange={e => setClienteForm(p => ({ ...p, email: e.target.value }))}
                  />
                </Field>
                <Field label="Teléfono">
                  <Input
                    type="text"
                    value={clienteForm.telefono}
                    onChange={e => setClienteForm(p => ({ ...p, telefono: e.target.value }))}
                  />
                </Field>
              </div>
              <div style={{
                fontSize: 'var(--text-xs)', color: 'var(--fg-3)',
                background: 'var(--surface-2)', padding: 8, borderRadius: 'var(--r-md)',
              }}>
                Un consumidor sólo puede recibir <strong>FCF</strong>. Si necesitas emitirle un CCF,
                guárdalo como <em>Cliente Contribuyente</em> con NIT y NRC.
              </div>
            </>
          ) : (
            <>
              <div className="two-col">
                <Field label="NIT *">
                  <Input
                    type="text"
                    placeholder="0614-010190-001-2"
                    value={clienteForm.nit}
                    onChange={e => setClienteForm(p => ({ ...p, nit: e.target.value }))}
                  />
                </Field>
                <Field label="NRC *">
                  <Input
                    type="text"
                    placeholder="123456-7"
                    value={clienteForm.nrc}
                    onChange={e => setClienteForm(p => ({ ...p, nrc: e.target.value }))}
                  />
                </Field>
              </div>
              <Field label="Actividad económica (CAT-019 del MH)">
                <Select
                  value={clienteForm.codActividad}
                  onChange={e => {
                    const codigo = e.target.value;
                    const cat = ACTIVIDADES_ECONOMICAS.find(a => a.codigo === codigo);
                    setClienteForm(p => ({
                      ...p,
                      codActividad: codigo,
                      // Auto-rellena la descripción si viene del catálogo.
                      giro: cat ? cat.nombre : (codigo === 'otro' ? p.giro : ''),
                    }));
                  }}
                >
                  <option value="">— Selecciona una actividad —</option>
                  {ACTIVIDADES_ECONOMICAS.map(a => (
                    <option key={a.codigo} value={a.codigo}>
                      {a.codigo} — {a.nombre}
                    </option>
                  ))}
                  <option value="otro">Otra (ingresar manualmente)</option>
                </Select>
              </Field>

              {clienteForm.codActividad === 'otro' && (
                <div className="two-col">
                  <Field label="Código de actividad (2-6 dígitos) *">
                    <Input
                      type="text"
                      placeholder="46900"
                      value={clienteForm.giro && /^\d{2,6}$/.test(clienteForm.giro) ? clienteForm.giro : ''}
                      onChange={e => setClienteForm(p => ({ ...p, codActividad: e.target.value.replace(/\D/g, '').slice(0, 6) || 'otro' }))}
                    />
                  </Field>
                  <Field label="Descripción de actividad *">
                    <Input
                      type="text"
                      placeholder="Mi actividad económica"
                      value={clienteForm.giro}
                      onChange={e => setClienteForm(p => ({ ...p, giro: e.target.value }))}
                    />
                  </Field>
                </div>
              )}

              <div className="two-col">
                <Field label="Departamento (CAT-012) *">
                  <Select
                    value={clienteForm.departamento}
                    onChange={e => {
                      const nuevoDept = e.target.value;
                      // Reset del municipio al cambiar de depto — los códigos
                      // de municipio son únicos sólo dentro del departamento.
                      const munis = getMunicipiosFor(nuevoDept);
                      setClienteForm(p => ({
                        ...p,
                        departamento: nuevoDept,
                        municipio: munis[0]?.codigo ?? '',
                      }));
                    }}
                  >
                    {DEPARTAMENTOS.map(d => (
                      <option key={d.codigo} value={d.codigo}>
                        {d.codigo} — {d.nombre}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Municipio (CAT-013) *">
                  <Select
                    value={clienteForm.municipio}
                    onChange={e => setClienteForm(p => ({ ...p, municipio: e.target.value }))}
                  >
                    {getMunicipiosFor(clienteForm.departamento).map(m => (
                      <option key={m.codigo} value={m.codigo}>
                        {m.codigo} — {m.nombre}
                      </option>
                    ))}
                    {getMunicipiosFor(clienteForm.departamento).length === 0 && (
                      <option value="">— Selecciona depto. primero —</option>
                    )}
                  </Select>
                </Field>
              </div>

              <Field label="Dirección (calle, colonia, número)">
                <Input
                  type="text"
                  placeholder="Col. Escalón, Calle Los Almendros #15"
                  value={clienteForm.direccion}
                  onChange={e => setClienteForm(p => ({ ...p, direccion: e.target.value }))}
                />
              </Field>
              <div className="two-col">
                <Field label="Correo *">
                  <Input
                    type="email"
                    placeholder="cliente@empresa.sv"
                    value={clienteForm.email}
                    onChange={e => setClienteForm(p => ({ ...p, email: e.target.value }))}
                  />
                </Field>
                <Field label="Teléfono">
                  <Input
                    type="text"
                    value={clienteForm.telefono}
                    onChange={e => setClienteForm(p => ({ ...p, telefono: e.target.value }))}
                  />
                </Field>
              </div>
              <div style={{
                fontSize: 'var(--text-xs)', color: 'var(--fg-3)',
                background: 'var(--surface-2)', padding: 8, borderRadius: 'var(--r-md)',
              }}>
                Los campos marcados con <strong>*</strong> son requeridos por el portal del MH para emitir CCF.
                El correo no puede ser nulo en CCF.
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

/* ─────────────────────── Modal Post-Emit ─────────────────────── */

interface PostEmitModalProps {
  pdfData: PdfData;
  receptorEmail: string | null;
  receptorNombre: string;
  emisorNombre: string;
  onClose: () => void;
}

function PostEmitModal({ pdfData, receptorEmail, receptorNombre, emisorNombre, onClose }: PostEmitModalProps) {
  async function imprimirTicket(): Promise<void> {
    await downloadDteTicket(pdfData, { mode: 'print' });
  }

  async function enviarEImprimir(): Promise<void> {
    if (!receptorEmail) return;
    // 1) Descarga el PDF Carta para que el usuario lo adjunte al correo manualmente
    //    (mailto: no soporta attachments — limitación del protocolo).
    await downloadDtePdf(pdfData);
    // 2) Abre el cliente de correo con asunto + cuerpo pre-llenados, incluyendo
    //    la URL de consulta pública del MH para que el cliente pueda verificar.
    const consultaUrl = `https://admin.factura.gob.sv/consultaPublica?ambiente=${pdfData.ambiente}&codGen=${pdfData.codigoGeneracion}&fechaEmi=${pdfData.fecha}`;
    const subject = `Su Factura Electrónica · ${pdfData.numeroControl}`;
    const body = [
      `Estimado/a ${receptorNombre},`,
      '',
      `Adjuntamos su Documento Tributario Electrónico (DTE) emitido por ${emisorNombre}.`,
      '',
      `Total: $${pdfData.totales.total.toFixed(2)}`,
      `Número de Control: ${pdfData.numeroControl}`,
      `Código de Generación: ${pdfData.codigoGeneracion}`,
      `Sello recibido por MH: ${pdfData.selloRecibido ?? '(pendiente)'}`,
      '',
      `Puede verificar la autenticidad de este DTE directamente en el portal del Ministerio de Hacienda:`,
      consultaUrl,
      '',
      `El PDF de la factura se descargó en su navegador — por favor adjúntelo a este correo antes de enviar.`,
      '',
      `Gracias por su preferencia.`,
      '',
      `— ${emisorNombre}`,
    ].join('\n');
    const mailto = `mailto:${receptorEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = mailto;
    // 3) Imprime el ticket térmico
    await downloadDteTicket(pdfData, { mode: 'print' });
  }

  return (
    <Modal title="DTE emitido exitosamente" onClose={onClose}>
      <div style={{
        background: 'var(--success-bg, #e6f7e9)',
        border: '1px solid var(--success-border, #28a745)',
        borderRadius: 'var(--r-md)',
        padding: 'var(--s-3) var(--s-4)',
        marginBottom: 'var(--s-4)',
        display: 'flex', alignItems: 'center', gap: 'var(--s-3)',
      }}>
        <Icon name="check" size={20} style={{ color: 'var(--success-text)' }} />
        <div style={{ fontSize: 'var(--text-sm)' }}>
          <strong>PROCESADO</strong> por el MH.
          <span style={{ color: 'var(--fg-3)', marginLeft: 6 }}>
            Sello {pdfData.selloRecibido?.slice(0, 16)}…
          </span>
        </div>
      </div>

      <div style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--s-4)', display: 'grid', gap: 6 }}>
        <PostEmitRow k="Tipo" v={pdfData.tipo.toUpperCase()} />
        <PostEmitRow k="Núm. Control" v={pdfData.numeroControl} mono />
        <PostEmitRow k="Receptor" v={receptorNombre} />
        <PostEmitRow k="Total" v={`$${pdfData.totales.total.toFixed(2)}`} strong />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
        <Button onClick={imprimirTicket} leading={<Icon name="receipt" size={15} />}>
          Imprimir Ticket
        </Button>
        <Button
          onClick={enviarEImprimir}
          disabled={!receptorEmail}
          variant="secondary"
          leading={<Icon name="upload" size={15} />}
          title={receptorEmail ?? 'El cliente no tiene correo registrado'}
        >
          {receptorEmail ? `Enviar a ${receptorEmail} e Imprimir` : 'Enviar e Imprimir (sin correo)'}
        </Button>
      </div>

      {!receptorEmail && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-3)', marginTop: 'var(--s-3)', textAlign: 'center' }}>
          Para enviar por correo, agrega el email al cliente en Contribuyentes.
        </div>
      )}
    </Modal>
  );
}

function PostEmitRow({ k, v, mono, strong }: { k: string; v: string; mono?: boolean; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ color: 'var(--fg-3)' }}>{k}</span>
      <span style={{
        fontFamily: mono ? 'var(--font-mono)' : undefined,
        fontWeight: strong ? 700 : 400,
        fontSize: mono ? 11 : undefined,
      }}>{v}</span>
    </div>
  );
}
