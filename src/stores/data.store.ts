import { create } from 'zustand';
import { getAdapter } from '@/lib/data';
import { syncDtesFromApi, type SyncResult } from '@/lib/dte/sync';
import type { AppData, AppCollection } from '@/types/domain';

interface DataState {
  data: AppData;
  loaded: boolean;
  /**
   * `true` solo cuando el load() del adapter se completó SIN errores.
   * Si load falló (entera o parcialmente), esto queda `false` y bloquea
   * cualquier save() — porque la memoria no refleja la BD y un save haría
   * DIFF+DELETE borrando todo lo que no esté en memoria. Diseñado tras un
   * incidente real de pérdida de data por esta misma razón.
   */
  loadOk: boolean;
  saving: boolean;
  error: string | null;
  init: () => Promise<void>;
  set: <K extends AppCollection>(key: K, list: AppData[K]) => Promise<void>;
  patch: (updater: (prev: AppData) => AppData) => Promise<void>;
  replace: (next: AppData) => Promise<void>;
  reset: () => void;
  /**
   * Trae DTEs emitidos vía API (BEON, etc.) del dte-service y los mergea al
   * store. Idempotente (dedup por codigoGeneracion). Devuelve métricas para
   * mostrar en UI. Tolera fallas de red sin romper la app.
   */
  /**
   * @param full Si true, ignora el cursor incremental y trae TODO. Idempotente
   *   por codigoGeneracion. Usar en backfill / botón manual de re-import.
   */
  syncDtes: (opts?: { full?: boolean }) => Promise<SyncResult>;
}

const empty: AppData = {
  ventasConsumidor: [],
  ventasContribuyente: [],
  compras: [],
  contribuyentes: [],
  productos: [],
  correlativosDte: [],
  reportesGenerados: [],
};

async function persistAndCommit(
  set: (state: Partial<DataState>) => void,
  get: () => DataState,
  next: AppData,
) {
  // SAFETY GUARD: nunca guardamos si el load no completó con éxito. Si lo
  // hiciéramos, el DIFF+DELETE del adapter compararía la memoria (incompleta)
  // contra la BD (completa) y borraría todo lo que no está en memoria.
  // Esta protección existe porque ya pasó: se borraron datos reales tras un
  // load fallido seguido de una interacción que disparó save().
  if (!get().loadOk) {
    const msg = 'Guardado bloqueado: la carga inicial no se completó. Recarga la página o resuelve el error antes de modificar datos.';
    console.error('[ERP] save bloqueado por loadOk=false. No se persiste para evitar borrar la base.');
    set({ error: msg });
    return;
  }
  set({ data: next, saving: true, error: null });
  try {
    await getAdapter().save(next);
    set({ saving: false });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Error guardando datos';
    console.error('[ERP] Save failed:', e);
    set({ saving: false, error: `Guardado: ${msg}` });
  }
}

export const useDataStore = create<DataState>((set, get) => ({
  data: empty,
  loaded: false,
  loadOk: false,
  saving: false,
  error: null,

  async init() {
    if (get().loaded) return;
    try {
      const data = await getAdapter().load();
      // Defensa contra adapters / localStorage antiguos que no tienen alguna
      // colección nueva (ej. `productos` antes de la pestaña Facturación).
      // Spread de `empty` primero para garantizar que TODAS las claves existan.
      set({ data: { ...empty, ...data }, loaded: true, loadOk: true, error: null });

      // El SoT de correlativos vive en dte-service. NO se siembra
      // automáticamente desde localStorage — el cache del navegador no es
      // autoridad fiscal. La siembra es una acción administrativa explícita
      // hecha desde CorrelativosTab o vía POST /correlativos/sembrar. Hasta
      // que un humano siembre, las emisiones fallan con CORRELATIVO_NOT_SEEDED.
      // (Removido a propósito: el auto-sembrado desde data.correlativosDte.)

      // Post-load: traer DTEs emitidos vía API externa (BEON) que no
      // pasaron por la UI. SOLO corre en modo legacy single-tenant — en SaaS
      // (api adapter) este sync NO existe; el ApiAdapter ya carga todo vía
      // /v2/* directamente.
      const isLegacy = getAdapter().kind !== 'api';
      if (isLegacy) {
        const kickSync = () => {
          void get().syncDtes().then(r => {
            if (r.ok && (r.added + r.updated) > 0) {
              console.info(`[ERP] DTE sync: +${r.added} added, ${r.updated} updated, ${r.skipped} skipped (of ${r.fetched})`);
            } else if (!r.ok) {
              console.warn(`[ERP] DTE sync falló (no crítico): ${r.error}`);
            }
          });
        };
        kickSync();
        if (typeof window !== 'undefined' && typeof document !== 'undefined') {
          const intervalMs = 30_000;
          const interval = window.setInterval(() => {
            if (document.visibilityState === 'visible' && get().loadOk) kickSync();
          }, intervalMs);
          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && get().loadOk) kickSync();
          });
          const w = window as unknown as { __erpSyncInterval?: number };
          if (w.__erpSyncInterval) window.clearInterval(w.__erpSyncInterval);
          w.__erpSyncInterval = interval;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error cargando datos';
      console.error('[ERP] Load failed:', e);
      // IMPORTANTE: aunque haya `partialData`, dejamos `loadOk: false`. Una
      // carga parcial es PELIGROSA para guardar — el adapter haría DIFF+DELETE
      // sobre las tablas que no cargaron y borraría sus filas reales. El
      // usuario ve la data parcial pero no puede modificarla hasta resolver
      // la causa del error.
      const partial = (e as Error & { partialData?: AppData }).partialData;
      if (partial) {
        set({ data: { ...empty, ...partial }, loaded: true, loadOk: false, error: `Carga parcial — guardado bloqueado: ${msg}` });
      } else {
        set({ loaded: true, loadOk: false, error: `Carga: ${msg}` });
      }
    }
  },

  async set(key, list) {
    const next = { ...get().data, [key]: list } as AppData;
    await persistAndCommit(set, get, next);
  },

  async patch(updater) {
    const next = updater(get().data);
    await persistAndCommit(set, get, next);
  },

  async replace(next) {
    await persistAndCommit(set, get, next);
  },

  reset() {
    set({ data: empty, loaded: false, loadOk: false, error: null });
  },

  async syncDtes(opts) {
    if (!get().loadOk) {
      return { ok: false, fetched: 0, added: 0, updated: 0, skipped: 0, error: 'load no completado — sync bloqueado' };
    }
    return syncDtesFromApi(() => get().data, get().patch, opts);
  },
}));
