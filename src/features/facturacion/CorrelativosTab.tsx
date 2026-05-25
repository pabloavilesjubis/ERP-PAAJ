import { useEffect, useState } from 'react';
import { Icon } from '@/components/icons/Icon';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import {
  listarCorrelativos, sembrarCorrelativos, type CorrelativoRecord,
} from '@/lib/dte/correlativos-client';
import { tipoDteToCodigo } from '@/lib/dte/correlativos';
import type { DteTipo } from '@/lib/dte/client';
import type { TipoDteCode } from '@/types/domain';

interface RowDef {
  tipo: DteTipo;
  codigo: TipoDteCode;
  label: string;
  prefix: string;
  descripcion: string;
}

const ROWS: RowDef[] = [
  { tipo: 'fcf', codigo: '01', label: 'FCF — Factura Consumidor Final', prefix: 'DTE-01-…-', descripcion: 'Ventas a consumidor final (precios CON IVA)' },
  { tipo: 'ccf', codigo: '03', label: 'CCF — Comprobante Crédito Fiscal', prefix: 'DTE-03-…-', descripcion: 'Ventas a contribuyentes con NRC (IVA separado)' },
  { tipo: 'nc',  codigo: '05', label: 'NC  — Nota de Crédito',          prefix: 'DTE-05-…-', descripcion: 'Ajustes/devoluciones sobre CCF previos' },
  { tipo: 'fse', codigo: '14', label: 'FSE — Sujeto Excluido',          prefix: 'DTE-14-…-', descripcion: 'Compras a personas sin NRC' },
];

/**
 * Vista del estado de correlativos. La data viene 100% del SoT (dte-service).
 * No hay cache local autoritativo. La acción "Sembrar" es la ÚNICA forma de:
 *  - inicializar un tipoDte (sin esto las emisiones fallan)
 *  - corregir un desfase tras migración desde otro sistema
 *
 * Importante: el seed NO se hace automáticamente desde el navegador en init().
 * Es una acción explícita y auditada.
 */
export function CorrelativosTab() {
  const [server, setServer] = useState<Record<string, CorrelativoRecord> | null>(null);
  const [loading, setLoading] = useState(false);
  const [edits, setEdits] = useState<Record<DteTipo, string>>({
    fcf: '', ccf: '', nc: '', fse: '',
  });
  const [savedFor, setSavedFor] = useState<DteTipo | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const items = await listarCorrelativos();
      const map: Record<string, CorrelativoRecord> = {};
      for (const r of items) map[r.tipo_dte] = r;
      setServer(map);
    } catch (e) {
      setError(`No se pudo leer correlativos del dte-service: ${e instanceof Error ? e.message : 'error de red'}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  function rec(tipo: DteTipo): CorrelativoRecord | undefined {
    return server?.[tipoDteToCodigo(tipo)];
  }

  async function sembrar(tipo: DteTipo) {
    const raw = edits[tipo].trim();
    if (!raw) return;
    const valor = parseInt(raw, 10);
    if (!Number.isFinite(valor) || valor < 0) return;
    setError(null);
    try {
      await sembrarCorrelativos([{ tipo_dte: tipoDteToCodigo(tipo), ultimo_consumido: valor }]);
      setEdits(p => ({ ...p, [tipo]: '' }));
      setSavedFor(tipo);
      setTimeout(() => setSavedFor(null), 2500);
      await refresh();
    } catch (e) {
      setError(`Sembrado falló: ${e instanceof Error ? e.message : 'error de red'}`);
    }
  }

  return (
    <div>
      <div style={{
        background: 'var(--warning-bg, var(--surface-2))',
        border: '1px solid var(--warning-border, var(--border))',
        padding: 'var(--s-4)',
        borderRadius: 'var(--r-md)',
        marginBottom: 'var(--s-5)',
        fontSize: 'var(--text-sm)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', marginBottom: 4, fontWeight: 600 }}>
          <Icon name="alert" size={15} />
          Fuente de verdad fiscal: dte-service
        </div>
        <div style={{ color: 'var(--fg-2)' }}>
          El MH no acepta duplicados de número de control. dte-service es la
          única fuente fiscal; este panel lee y escribe directamente sobre su
          storage. <strong>Si un tipo no está sembrado, las emisiones fallan
          con CORRELATIVO_NOT_SEEDED</strong> — sembralo acá indicando el
          último consecutivo que ya emitiste en producción. La operación solo
          sube valores (nunca baja) por seguridad.
        </div>
      </div>

      {error && (
        <div style={{
          background: 'var(--danger-bg, #fee)',
          border: '1px solid var(--danger-border, #fcc)',
          color: 'var(--danger-fg, #900)',
          padding: 'var(--s-3)',
          borderRadius: 'var(--r-md)',
          marginBottom: 'var(--s-4)',
          fontSize: 'var(--text-sm)',
        }}>{error}</div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--s-3)' }}>
        <Button onClick={refresh} variant="secondary" size="sm" disabled={loading}>
          {loading ? 'Cargando…' : 'Recargar desde server'}
        </Button>
      </div>

      <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
        {ROWS.map(r => {
          const cur = rec(r.tipo);
          const seeded = cur?.seeded ?? false;
          const ultimo = cur?.ultimo_consumido ?? 0;
          const proximo = seeded ? ultimo + 1 : null;
          return (
            <div key={r.tipo} style={{
              background: 'var(--surface-1)',
              border: `1px solid ${seeded ? 'var(--border)' : 'var(--danger-border, #fcc)'}`,
              borderRadius: 'var(--r-md)',
              padding: 'var(--s-4)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--s-3)' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 'var(--text-md)' }}>{r.label}</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-3)', marginTop: 2 }}>{r.descripcion}</div>
                  <div style={{ fontSize: 'var(--text-xs)', marginTop: 6 }}>
                    {seeded ? (
                      <span style={{ color: 'var(--success-text, #060)' }}>
                        ✓ Sembrado{cur?.seeded_at ? ` el ${new Date(cur.seeded_at).toLocaleString()}` : ''}
                        {cur?.seeded_by ? ` por ${cur.seeded_by}` : ''}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--danger-fg, #900)', fontWeight: 600 }}>
                        ✗ NO SEMBRADO — emisiones bloqueadas hasta que sembres
                      </span>
                    )}
                  </div>
                  {cur && cur.reservados.length > 0 && (
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-3)', marginTop: 4 }}>
                      In-flight: {cur.reservados.join(', ')}
                    </div>
                  )}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-3)' }}>Último consumido</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-lg)', fontWeight: 700 }}>
                    {String(ultimo).padStart(15, '0')}
                  </div>
                  {proximo !== null && (
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--success-text)', marginTop: 2 }}>
                      Próximo será {String(proximo).padStart(15, '0')}
                    </div>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'flex-end' }}>
                <Field label={seeded ? 'Subir último consumido a' : 'Sembrar con último consumido'}>
                  <Input
                    type="number"
                    min={0}
                    placeholder={String(ultimo)}
                    value={edits[r.tipo]}
                    onChange={e => setEdits(p => ({ ...p, [r.tipo]: e.target.value }))}
                  />
                </Field>
                <Button
                  onClick={() => sembrar(r.tipo)}
                  disabled={!edits[r.tipo].trim()}
                  size="sm"
                  variant={seeded ? 'secondary' : 'primary'}
                >
                  {seeded ? 'Actualizar' : 'Sembrar'}
                </Button>
                {savedFor === r.tipo && (
                  <span style={{ color: 'var(--success-text)', fontSize: 'var(--text-xs)', alignSelf: 'center' }}>
                    ✓ Guardado en server
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 'var(--s-5)', fontSize: 'var(--text-xs)', color: 'var(--fg-3)' }}>
        El valor se actualiza automáticamente en el server cada vez que se
        emite un DTE exitoso (POS o BEON). Edita aquí solo para inicializar un
        tipo nuevo o corregir un desfase tras migrar desde otro sistema.
      </div>
    </div>
  );
}
