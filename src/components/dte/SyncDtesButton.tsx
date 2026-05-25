import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useDataStore } from '@/stores/data.store';

/**
 * Botón para forzar la sincronización de DTEs emitidos vía API externa (BEON,
 * etc.) hacia el store del ERP. Lo usa cualquier página que muestre ventas:
 * VentasConsumidor, VentasContribuyente, DtesEmitidos.
 *
 * El sync automático corre al cargar la app (data.store.init), pero si BEON
 * emite mientras la app está abierta este botón cierra el gap sin necesidad
 * de recargar.
 */
export function SyncDtesButton({ compact }: { compact?: boolean }) {
  const syncDtes = useDataStore(s => s.syncDtes);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  async function run(full: boolean) {
    setSyncing(true);
    setMsg(null);
    setIsError(false);
    const r = await syncDtes({ full });
    setSyncing(false);
    if (!r.ok) {
      setIsError(true);
      setMsg(`Sync falló: ${r.error ?? 'error desconocido'}`);
    } else if (r.added + r.updated === 0) {
      setMsg(`Sin cambios nuevos (${r.fetched} revisados)`);
    } else {
      setMsg(`✓ ${r.added} nueva(s), ${r.updated} actualizada(s)${full ? ' [backfill]' : ''}`);
    }
    setTimeout(() => setMsg(null), 6000);
  }

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)' }}>
      <Button
        onClick={() => run(false)}
        disabled={syncing}
        variant="secondary"
        size={compact ? 'sm' : 'md'}
        title="Sync incremental — trae lo nuevo desde la última sincronización"
      >
        {syncing ? 'Sincronizando…' : 'Sincronizar API'}
      </Button>
      <Button
        onClick={() => run(true)}
        disabled={syncing}
        variant="secondary"
        size={compact ? 'sm' : 'md'}
        title="Re-import COMPLETO — trae TODOS los DTEs del server. Idempotente (dedup por codigoGeneracion). Usar tras migrar o si faltan ventas históricas."
      >
        Re-importar todo
      </Button>
      {msg && (
        <span style={{
          fontSize: 'var(--text-xs)',
          color: isError ? 'var(--danger-fg, #b91c1c)' : 'var(--fg-3)',
        }}>
          {msg}
        </span>
      )}
    </div>
  );
}
