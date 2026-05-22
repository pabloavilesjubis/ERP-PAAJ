import { useState } from 'react';
import { Icon } from '@/components/icons/Icon';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import {
  getProximoConsecutivo, setUltimoConsecutivo, tipoDteToCodigo,
} from '@/lib/dte/correlativos';
import { useDataStore } from '@/stores/data.store';
import type { DteTipo } from '@/lib/dte/client';

interface RowDef {
  tipo: DteTipo;
  label: string;
  prefix: string;       // ej. "DTE-01-M001P001-"
  descripcion: string;
}

const ROWS: RowDef[] = [
  { tipo: 'fcf', label: 'FCF — Factura Consumidor Final', prefix: 'DTE-01-…-', descripcion: 'Ventas a consumidor final (precios CON IVA)' },
  { tipo: 'ccf', label: 'CCF — Comprobante Crédito Fiscal', prefix: 'DTE-03-…-', descripcion: 'Ventas a contribuyentes con NRC (IVA separado)' },
  { tipo: 'nc',  label: 'NC  — Nota de Crédito',          prefix: 'DTE-05-…-', descripcion: 'Ajustes/devoluciones sobre CCF previos' },
  { tipo: 'fse', label: 'FSE — Sujeto Excluido',          prefix: 'DTE-14-…-', descripcion: 'Compras a personas sin NRC' },
];

export function CorrelativosTab() {
  const correlativos = useDataStore(s => s.data.correlativosDte);
  const patch = useDataStore(s => s.patch);

  const [edits, setEdits] = useState<Record<DteTipo, string>>({
    fcf: '', ccf: '', nc: '', fse: '',
  });
  const [savedFor, setSavedFor] = useState<DteTipo | null>(null);

  function currentUltimo(tipo: DteTipo): number {
    const c = correlativos.find(r => r.tipoDte === tipoDteToCodigo(tipo));
    return c?.ultimoConsecutivo ?? 0;
  }

  async function guardar(tipo: DteTipo) {
    const raw = edits[tipo].trim();
    if (!raw) return;
    const valor = parseInt(raw, 10);
    if (!Number.isFinite(valor) || valor < 0) return;
    const codigo = tipoDteToCodigo(tipo);
    await patch(prev => ({
      ...prev,
      correlativosDte: setUltimoConsecutivo(prev.correlativosDte, codigo, valor),
    }));
    setEdits(p => ({ ...p, [tipo]: '' }));
    setSavedFor(tipo);
    setTimeout(() => setSavedFor(null), 2000);
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
          ¿Por qué importa esto?
        </div>
        <div style={{ color: 'var(--fg-2)' }}>
          El MH NO acepta duplicados de número de control. Si tu cuenta ya tiene
          DTEs emitidos por otro sistema, configura aquí el <strong>último consecutivo</strong>
          usado en producción para cada tipo. El próximo envío seguirá la secuencia
          automáticamente (sin que tengas que recordar el número).
        </div>
      </div>

      <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
        {ROWS.map(r => {
          const ultimo = currentUltimo(r.tipo);
          const proximo = getProximoConsecutivo(correlativos, tipoDteToCodigo(r.tipo));
          return (
            <div key={r.tipo} style={{
              background: 'var(--surface-1)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-md)',
              padding: 'var(--s-4)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--s-3)' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 'var(--text-md)' }}>{r.label}</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-3)', marginTop: 2 }}>{r.descripcion}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-3)' }}>Último emitido</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-lg)', fontWeight: 700 }}>
                    {String(ultimo).padStart(15, '0')}
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--success-text)', marginTop: 2 }}>
                    Próximo será {String(proximo).padStart(15, '0')}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'flex-end' }}>
                <Field label="Cambiar último emitido a">
                  <Input
                    type="number"
                    min={0}
                    placeholder={String(ultimo)}
                    value={edits[r.tipo]}
                    onChange={e => setEdits(p => ({ ...p, [r.tipo]: e.target.value }))}
                  />
                </Field>
                <Button
                  onClick={() => guardar(r.tipo)}
                  disabled={!edits[r.tipo].trim()}
                  size="sm"
                >
                  Guardar
                </Button>
                {savedFor === r.tipo && (
                  <span style={{ color: 'var(--success-text)', fontSize: 'var(--text-xs)', alignSelf: 'center' }}>
                    ✓ Guardado
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 'var(--s-5)', fontSize: 'var(--text-xs)', color: 'var(--fg-3)' }}>
        Tip: el valor "Último emitido" se actualiza automáticamente cada vez que
        emites un DTE exitoso desde el POS. Sólo edita aquí cuando estés migrando
        desde otro sistema o corrigiendo un desfase.
      </div>
    </div>
  );
}
