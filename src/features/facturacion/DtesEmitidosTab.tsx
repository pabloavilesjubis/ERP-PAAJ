import { useMemo, useState } from 'react';
import { Icon } from '@/components/icons/Icon';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { displayDate, fmt, num } from '@/lib/utils/format';
import { useDataStore } from '@/stores/data.store';
import { annulDte, DteServiceError } from '@/lib/dte/client';
import type { VentaConsumidor, VentaContribuyente } from '@/types/domain';

type TipoDte = 'fcf' | 'ccf';
type FilterTipo = 'todos' | TipoDte;
type FilterEstado = 'todos' | 'procesado' | 'anulado';

/** Vista unificada de DTEs emitidos (combina FCF y CCF). */
interface DteEmitido {
  ventaId: string;
  origenColeccion: 'ventasConsumidor' | 'ventasContribuyente';
  tipo: TipoDte;
  fecha: string;
  cliente: string;
  total: number;
  codigoGeneracion: string;
  numeroControl: string;
  selloRecibido: string | null;
  anulado: boolean;
  documentoJws?: string;
  /** Datos extra que necesita la anulación. */
  montoIva: number;
  nit?: string;
  dui?: string;
  receptorTipoDocumento?: string;
}

interface DtesEmitidosTabProps {
  onCrearNc?: (ccf: DteEmitido) => void;
}

export function DtesEmitidosTab({ onCrearNc }: DtesEmitidosTabProps) {
  const ventasConsumidor = useDataStore(s => s.data.ventasConsumidor);
  const ventasContribuyente = useDataStore(s => s.data.ventasContribuyente);
  const patch = useDataStore(s => s.patch);

  const [filterTipo, setFilterTipo] = useState<FilterTipo>('todos');
  const [filterEstado, setFilterEstado] = useState<FilterEstado>('todos');
  const [search, setSearch] = useState('');
  const [detalle, setDetalle] = useState<DteEmitido | null>(null);
  const [anulando, setAnulando] = useState<DteEmitido | null>(null);

  const dtes = useMemo<DteEmitido[]>(() => {
    const fromFcf: DteEmitido[] = ventasConsumidor
      .filter(v => v.metadata?.codigoGeneracion || v.metadata?.selloRecibido)
      .map(v => ({
        ventaId: v.id,
        origenColeccion: 'ventasConsumidor',
        tipo: 'fcf',
        fecha: v.fecha,
        cliente: v.metadata?.cliente ?? 'Consumidor anónimo',
        total: num(v.monto),
        codigoGeneracion: v.metadata?.codigoGeneracion ?? '',
        numeroControl: v.metadata?.numeroControl ?? '',
        selloRecibido: v.metadata?.selloRecibido ?? null,
        anulado: !!v.metadata?.anulado,
        documentoJws: v.metadata?.documentoJws,
        montoIva: num(v.metadata?.iva ?? 0),
      }));
    const fromCcf: DteEmitido[] = ventasContribuyente
      .filter(v => v.metadata?.numeroDocumento && v.metadata?.tipoDocumento === '03')
      .map(v => {
        const gravado = num(v.gravado);
        const iva = +(gravado * 0.13).toFixed(2);
        return {
          ventaId: v.id,
          origenColeccion: 'ventasContribuyente',
          tipo: 'ccf' as const,
          fecha: v.fecha,
          cliente: v.cliente,
          total: gravado + iva + num(v.exento),
          codigoGeneracion: v.metadata?.numeroDocumento ?? '',
          numeroControl: v.metadata?.numeroControl ?? '',
          selloRecibido: v.metadata?.selloRecibido ?? null,
          anulado: !!v.metadata?.anulado,
          documentoJws: v.metadata?.documentoJws,
          montoIva: iva,
          nit: v.metadata?.nit,
          receptorTipoDocumento: '36',
        };
      });
    return [...fromFcf, ...fromCcf].sort((a, b) => b.fecha.localeCompare(a.fecha));
  }, [ventasConsumidor, ventasContribuyente]);

  const filtered = useMemo(() => {
    return dtes.filter(d => {
      if (filterTipo !== 'todos' && d.tipo !== filterTipo) return false;
      if (filterEstado === 'procesado' && d.anulado) return false;
      if (filterEstado === 'anulado' && !d.anulado) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return d.cliente.toLowerCase().includes(q)
          || d.codigoGeneracion.toLowerCase().includes(q)
          || d.numeroControl.toLowerCase().includes(q)
          || (d.selloRecibido ?? '').toLowerCase().includes(q);
      }
      return true;
    });
  }, [dtes, filterTipo, filterEstado, search]);

  function downloadJson(dte: DteEmitido): void {
    // El JWS guarda el DTE original en el payload (base64-url segundo segmento).
    // Si no tenemos JWS, exportamos lo mínimo que sí tenemos.
    let payload: unknown = {
      codigoGeneracion: dte.codigoGeneracion,
      numeroControl: dte.numeroControl,
      selloRecibido: dte.selloRecibido,
      tipo: dte.tipo,
      cliente: dte.cliente,
      total: dte.total,
      anulado: dte.anulado,
    };
    if (dte.documentoJws) {
      const parts = dte.documentoJws.split('.');
      if (parts.length === 3 && parts[1]) {
        try {
          const decoded = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
          payload = JSON.parse(decoded);
        } catch {
          // payload no decodificable — uso el resumen
        }
      }
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${dte.tipo.toUpperCase()}_${dte.codigoGeneracion}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      {/* Filtros */}
      <div style={{ display: 'flex', gap: 'var(--s-2)', marginBottom: 'var(--s-4)', flexWrap: 'wrap' }}>
        <Input
          type="search"
          placeholder="Buscar por cliente, sello, código…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: '1 1 240px', maxWidth: 360 }}
        />
        <Select
          value={filterTipo}
          onChange={e => setFilterTipo(e.target.value as FilterTipo)}
          style={{ flex: '0 0 140px' }}
        >
          <option value="todos">Todos los tipos</option>
          <option value="fcf">Solo FCF</option>
          <option value="ccf">Solo CCF</option>
        </Select>
        <Select
          value={filterEstado}
          onChange={e => setFilterEstado(e.target.value as FilterEstado)}
          style={{ flex: '0 0 140px' }}
        >
          <option value="todos">Todos los estados</option>
          <option value="procesado">Solo vigentes</option>
          <option value="anulado">Solo anulados</option>
        </Select>
        <div style={{ marginLeft: 'auto', alignSelf: 'center', fontSize: 'var(--text-xs)', color: 'var(--fg-3)' }}>
          {filtered.length} de {dtes.length} DTEs
        </div>
      </div>

      {/* Lista */}
      <div className="table-wrap">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th style={{ width: 60 }}>Tipo</th>
                <th>Cliente</th>
                <th>N° Control</th>
                <th className="num">Total</th>
                <th>Sello</th>
                <th style={{ width: 100 }}>Estado</th>
                <th style={{ width: 60 }} />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={8}>
                  <EmptyState
                    title={dtes.length === 0 ? 'Sin DTEs emitidos' : 'Sin resultados'}
                    description={dtes.length === 0
                      ? 'Cuando emitas un FCF o CCF desde el POS, aparecerá aquí.'
                      : 'Cambia los filtros o búsqueda.'}
                  />
                </td></tr>
              )}
              {filtered.map(d => (
                <tr key={d.ventaId} style={{ cursor: 'pointer' }} onClick={() => setDetalle(d)}>
                  <td className="muted">{displayDate(d.fecha)}</td>
                  <td>
                    <span style={{
                      fontSize: 'var(--text-xs)', fontWeight: 600, padding: '2px 8px',
                      borderRadius: 'var(--r-pill)',
                      background: d.tipo === 'ccf' ? 'var(--brand-primary-50)' : 'var(--surface-2)',
                      color: d.tipo === 'ccf' ? 'var(--brand-primary-700)' : 'var(--fg-2)',
                    }}>{d.tipo.toUpperCase()}</span>
                  </td>
                  <td style={{ fontWeight: 500 }}>{d.cliente}</td>
                  <td><code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{d.numeroControl.slice(-12)}</code></td>
                  <td className="num"><strong>{fmt(d.total)}</strong></td>
                  <td>
                    {d.selloRecibido
                      ? <code style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)' }}>{d.selloRecibido.slice(0, 12)}…</code>
                      : <span style={{ color: 'var(--fg-4)' }}>—</span>}
                  </td>
                  <td>
                    {d.anulado
                      ? <span style={{ color: 'var(--danger-text)', fontSize: 'var(--text-xs)' }}>⊘ Anulado</span>
                      : <span style={{ color: 'var(--success-text)', fontSize: 'var(--text-xs)' }}>● Vigente</span>}
                  </td>
                  <td onClick={e => e.stopPropagation()}>
                    <Button size="sm" variant="secondary" onClick={() => setDetalle(d)}>Ver</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal de detalle */}
      {detalle && (
        <DetalleModal
          dte={detalle}
          onClose={() => setDetalle(null)}
          onDownload={() => downloadJson(detalle)}
          onAnular={() => { setAnulando(detalle); setDetalle(null); }}
          onCrearNc={() => { onCrearNc?.(detalle); setDetalle(null); }}
        />
      )}

      {/* Modal de anulación */}
      {anulando && (
        <AnularModal
          dte={anulando}
          onClose={() => setAnulando(null)}
          onAnulado={async (resultado) => {
            await patch(prev => {
              if (anulando.origenColeccion === 'ventasConsumidor') {
                return {
                  ...prev,
                  ventasConsumidor: prev.ventasConsumidor.map(v =>
                    v.id === anulando.ventaId
                      ? {
                          ...v,
                          metadata: {
                            ...v.metadata,
                            anulado: true,
                            codigoEventoAnulacion: resultado.codigoGeneracionEvento,
                            selloEventoAnulacion: resultado.selloEvento ?? undefined,
                            fechaAnulacion: new Date().toISOString(),
                            motivoAnulacion: resultado.motivo,
                          },
                        }
                      : v,
                  ),
                };
              }
              return {
                ...prev,
                ventasContribuyente: prev.ventasContribuyente.map(v =>
                  v.id === anulando.ventaId
                    ? {
                        ...v,
                        metadata: {
                          ...v.metadata,
                          anulado: true,
                          codigoEventoAnulacion: resultado.codigoGeneracionEvento,
                          selloEventoAnulacion: resultado.selloEvento ?? undefined,
                          fechaAnulacion: new Date().toISOString(),
                          motivoAnulacion: resultado.motivo,
                        },
                      }
                    : v,
                ),
              };
            });
            setAnulando(null);
          }}
        />
      )}
    </div>
  );
}

/* ──────────────────────── Detalle Modal ──────────────────────── */

function DetalleModal({
  dte, onClose, onDownload, onAnular, onCrearNc,
}: {
  dte: DteEmitido;
  onClose: () => void;
  onDownload: () => void;
  onAnular: () => void;
  onCrearNc: () => void;
}) {
  return (
    <Modal title={`DTE ${dte.tipo.toUpperCase()} · ${dte.cliente}`} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <Row label="Fecha"><span>{displayDate(dte.fecha)}</span></Row>
        <Row label="Cliente"><strong>{dte.cliente}</strong></Row>
        <Row label="Total"><strong>{fmt(dte.total)}</strong></Row>
        <Row label="Código de Generación">
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', wordBreak: 'break-all' }}>
            {dte.codigoGeneracion}
          </code>
        </Row>
        <Row label="Número de Control">
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{dte.numeroControl}</code>
        </Row>
        <Row label="Sello Recibido (MH)">
          {dte.selloRecibido
            ? <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', wordBreak: 'break-all' }}>{dte.selloRecibido}</code>
            : <span style={{ color: 'var(--fg-4)' }}>— sin sello —</span>}
        </Row>
        <Row label="Estado">
          {dte.anulado
            ? <span style={{ color: 'var(--danger-text)' }}>⊘ ANULADO</span>
            : <span style={{ color: 'var(--success-text)' }}>● VIGENTE</span>}
        </Row>

        <div style={{ display: 'flex', gap: 'var(--s-2)', marginTop: 'var(--s-3)', flexWrap: 'wrap' }}>
          <Button variant="secondary" leading={<Icon name="download" size={14} />} onClick={onDownload}>
            Descargar JSON
          </Button>
          {!dte.anulado && (
            <Button variant="danger" leading={<Icon name="trash" size={14} />} onClick={onAnular}>
              Anular DTE
            </Button>
          )}
          {dte.tipo === 'ccf' && !dte.anulado && (
            <Button leading={<Icon name="plus" size={14} />} onClick={onCrearNc}>
              Crear Nota de Crédito
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s-3)', alignItems: 'flex-start' }}>
      <span style={{ color: 'var(--fg-3)', fontSize: 'var(--text-sm)', minWidth: 140 }}>{label}</span>
      <div style={{ flex: 1, textAlign: 'right', fontSize: 'var(--text-sm)' }}>{children}</div>
    </div>
  );
}

/* ──────────────────────── Anular Modal ──────────────────────── */

interface AnularResultado {
  codigoGeneracionEvento: string;
  selloEvento: string | null;
  motivo: string;
}

function AnularModal({
  dte, onClose, onAnulado,
}: {
  dte: DteEmitido;
  onClose: () => void;
  onAnulado: (r: AnularResultado) => void;
}) {
  const [tipoAnulacion, setTipoAnulacion] = useState<'1' | '2' | '3'>('2');
  const [motivo, setMotivo] = useState('');
  const [nombreResp, setNombreResp] = useState('');
  const [docResp, setDocResp] = useState('');
  const [nombreSol, setNombreSol] = useState(dte.cliente);
  const [docSol, setDocSol] = useState(dte.nit ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = motivo.trim().length >= 5 && nombreResp.trim() && docResp.trim()
    && nombreSol.trim() && docSol.trim();

  async function ejecutar() {
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        tipoDte: dte.tipo === 'ccf' ? '03' : '01',
        codigoGeneracion: dte.codigoGeneracion,
        selloRecibido: dte.selloRecibido ?? '',
        numeroControl: dte.numeroControl,
        fecEmi: dte.fecha,
        montoIva: dte.montoIva,
        tipoDocumentoReceptor: dte.receptorTipoDocumento ?? '36',
        numDocumentoReceptor: dte.nit ?? dte.dui ?? 'sin-doc',
        nombreReceptor: dte.cliente,
        tipoAnulacion: parseInt(tipoAnulacion, 10),
        motivoAnulacion: motivo,
        nombreResponsable: nombreResp,
        tipDocResponsable: '36',
        numDocResponsable: docResp.replace(/-/g, ''),
        nombreSolicita: nombreSol,
        tipDocSolicita: '36',
        numDocSolicita: docSol.replace(/-/g, ''),
      };
      const result = await annulDte(payload as unknown as Record<string, unknown>);
      onAnulado({
        codigoGeneracionEvento: result.codigoGeneracionEvento,
        selloEvento: result.selloEvento,
        motivo,
      });
    } catch (e) {
      const msg = e instanceof DteServiceError
        ? `${e.code} — ${e.message}`
        : (e instanceof Error ? e.message : 'Error desconocido');
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={`Anular DTE ${dte.tipo.toUpperCase()}`}
      onClose={onClose}
      onSave={ejecutar}
      saveDisabled={!valid || submitting}
      saveLabel={submitting ? 'Anulando…' : 'Anular en MH'}
    >
      <div style={{
        background: 'var(--danger-bg)', border: '1px solid var(--danger-border)',
        padding: 'var(--s-3)', borderRadius: 'var(--r-md)', fontSize: 'var(--text-xs)',
        color: 'var(--danger-text)', marginBottom: 'var(--s-3)',
      }}>
        <strong>Esto es irreversible.</strong> El MH marcará el DTE como inválido. Confirma datos antes de continuar.
        Plazos: <strong>CCF/NC/ND 24h</strong> desde emisión; <strong>FCF/FEX hasta 3 meses</strong>.
      </div>

      <Field label="Tipo de anulación">
        <Select value={tipoAnulacion} onChange={e => setTipoAnulacion(e.target.value as '1' | '2' | '3')}>
          <option value="1">1 — Error en información (requiere DTE de reemplazo)</option>
          <option value="2">2 — Rescisión de la operación</option>
          <option value="3">3 — Otro</option>
        </Select>
      </Field>

      <Field label="Motivo de la anulación *">
        <Input
          type="text"
          placeholder="Mínimo 5 caracteres — explica el motivo"
          value={motivo}
          onChange={e => setMotivo(e.target.value)}
        />
      </Field>

      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-3)', marginTop: 8 }}>
        Responsable de la anulación (quien autoriza desde tu empresa):
      </div>
      <div className="two-col">
        <Field label="Nombre del responsable *">
          <Input type="text" value={nombreResp} onChange={e => setNombreResp(e.target.value)} />
        </Field>
        <Field label="NIT del responsable *">
          <Input type="text" placeholder="06140000000000" value={docResp} onChange={e => setDocResp(e.target.value)} />
        </Field>
      </div>

      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-3)', marginTop: 8 }}>
        Solicitante (quien pidió la anulación; normalmente el cliente):
      </div>
      <div className="two-col">
        <Field label="Nombre del solicitante *">
          <Input type="text" value={nombreSol} onChange={e => setNombreSol(e.target.value)} />
        </Field>
        <Field label="NIT/DUI del solicitante *">
          <Input type="text" value={docSol} onChange={e => setDocSol(e.target.value)} />
        </Field>
      </div>

      {error && (
        <div className="banner banner-danger" style={{ fontSize: 'var(--text-xs)' }}>
          <Icon name="alert" size={14} />
          <div>{error}</div>
        </div>
      )}
    </Modal>
  );
}

// Export del tipo para que FacturacionPage pueda manejarlo en el flujo de NC
export type { DteEmitido };

// Suprime el warning de "VentaConsumidor/VentaContribuyente importados sin uso"
// — los tenemos aquí porque el componente potencialmente los expande en futuras
// iteraciones (mostrar items del DTE original, etc.).
void (null as unknown as VentaConsumidor | VentaContribuyente);
