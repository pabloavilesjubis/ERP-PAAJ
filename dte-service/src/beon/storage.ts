import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CorrelativoNotSeededError } from '../errors.js';

/**
 * Persistencia simple basada en archivos JSON. Suficiente para el contrato BEON
 * (un microservicio sin DB propia). Cada registro vive en su propio archivo
 * para evitar contención de escritura concurrente. Las escrituras son atómicas
 * (write a .tmp + rename).
 *
 * Layout:
 *   {STORAGE_DIR}/
 *     dtes/{erp_invoice_id}.json
 *     clientes/{erp_customer_id}.json
 *     idempotency/{key}.json
 *     correlativos/{tipoDte}.json    (ÚNICA secuencia fiscal — ver nota)
 *     index/sale_to_invoice.json     (beon_sale_id -> erp_invoice_id)
 *     index/beon_customer.json       (beon_customer_id -> erp_customer_id)
 *     files/...                      (pdfs, jsons, tickets generados, servidos como estáticos)
 *
 * REGLA FISCAL — Correlativos:
 *   dte-service es la ÚNICA fuente de verdad. Tanto la UI POS del ERP como
 *   BEON consumen del mismo storage vía HTTP (POST /correlativos/reservar
 *   antes de emitir, POST /correlativos/consumir tras éxito MH, POST
 *   /correlativos/devolver tras rechazo). No existe un segundo contador en
 *   localStorage ni en BEON. Reservaciones in-flight se trackean para soportar
 *   concurrencia y rollback en rechazo.
 */

export interface DteRecord {
  erp_invoice_id: string;
  beon_sale_id: string | null;
  tenant_id: string | null;
  /**
   * Quién originó la emisión. Crítico para reportes y auditoría: las ventas
   * vía API (BEON, integraciones) no son visibles directamente en la UI POS
   * del ERP, así que el `origen` permite filtrar/conciliar.
   */
  origen: 'POS' | 'BEON' | 'API';
  /** Identificador libre del vendedor que originó la venta (BEON lo manda opcional). */
  vendedor_nombre: string | null;
  tipo_dte: '01' | '03' | '05' | '14';
  estado: 'EMITIDO' | 'RECHAZADO' | 'ANULADO';
  /** Timestamp del momento en que el ERP frontend confirmó haber pulleado este DTE — null si todavía no. Útil para reportes "qué falta sincronizar". */
  erp_synced_at: string | null;
  codigo_generacion: string;
  numero_control: string;
  sello_recibido: string | null;
  fh_procesamiento: string | null;
  fec_emi: string;
  hor_emi: string;
  ambiente: '00' | '01';
  receptor_correo: string | null;
  receptor_nombre: string | null;
  consecutivo: number;
  dte_json: Record<string, unknown>;
  documento_jws: string;
  mh_raw: Record<string, unknown>;
  pdf_path: string | null;
  json_path: string | null;
  ticket_path: string | null;
  created_at: string;
  updated_at: string;
  // anulación
  anulacion?: {
    codigo_generacion_evento: string;
    sello_evento: string | null;
    fec_anula: string;
    motivo: string;
    mh_raw: Record<string, unknown>;
  };
}

export interface ClienteRecord {
  erp_customer_id: string;
  beon_customer_id: string | null;
  tenant_id: string | null;
  tipo_documento: string | null;       // '13'=DUI '36'=NIT '37'=otro
  num_documento: string | null;
  nrc: string | null;
  nombre: string;
  nombre_comercial: string | null;
  cod_actividad: string | null;
  desc_actividad: string | null;
  direccion: {
    departamento: string | null;
    municipio: string | null;
    complemento: string | null;
  };
  telefono: string | null;
  correo: string | null;
  created_at: string;
  updated_at: string;
}

export interface IdempotencyRecord {
  key: string;
  status_code: number;
  response: unknown;
  created_at: string;
  expires_at: string;
}

const IDEMP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Estado persistido por tipo de DTE.
 *   - `seeded`: true SOLO después de una acción administrativa explícita
 *     (POST /correlativos/sembrar o CorrelativosTab). Sin esto NO se permite
 *     reservar — la sequence parte solo cuando un humano confirmó el
 *     "último consecutivo histórico". Defensa contra arrancar en 1 y
 *     chocar con DTEs ya emitidos en MH.
 *   - `seeded_at`: timestamp del seed para auditoría.
 *   - `seeded_by`: identificador libre del caller que sembró (opcional —
 *     ej. tenant_id, user, "admin-cli"). Trazabilidad.
 *   - `ultimo_consumido`: último que confirmó MH (PROCESADO).
 *   - `reservados`: consecutivos in-flight — reservados pero sin commit aún.
 *     Una reservación o se commitea (sube ultimo_consumido) o se devuelve
 *     (queda como gap; MH no exige contigüidad estricta).
 */
export interface CorrelativoRecord {
  tipo_dte: string;
  seeded: boolean;
  seeded_at: string | null;
  seeded_by: string | null;
  ultimo_consumido: number;
  reservados: number[];
  updated_at: string;
}

const TIPOS_VALIDOS = new Set(['01', '03', '05', '14']);

export class Storage {
  constructor(public readonly baseDir: string) {}

  async init(): Promise<void> {
    for (const sub of ['dtes', 'clientes', 'idempotency', 'correlativos', 'index', 'files']) {
      await mkdir(path.join(this.baseDir, sub), { recursive: true });
    }
  }

  filesDir(): string {
    return path.join(this.baseDir, 'files');
  }

  // ── DTEs ──────────────────────────────────────────────────────────────────

  async saveDte(rec: DteRecord): Promise<void> {
    await atomicWriteJson(path.join(this.baseDir, 'dtes', `${rec.erp_invoice_id}.json`), rec);
    if (rec.beon_sale_id) {
      await this.indexSet('sale_to_invoice.json', rec.beon_sale_id, rec.erp_invoice_id);
    }
  }

  async getDteById(erpInvoiceId: string): Promise<DteRecord | null> {
    const rec = await readJson<DteRecord>(path.join(this.baseDir, 'dtes', `${erpInvoiceId}.json`));
    return rec ? normalizeDteRecord(rec) : null;
  }

  async getDteByBeonSale(beonSaleId: string): Promise<DteRecord | null> {
    const idx = await readJson<Record<string, string>>(path.join(this.baseDir, 'index', 'sale_to_invoice.json')) ?? {};
    const id = idx[beonSaleId];
    return id ? this.getDteById(id) : null;
  }

  /**
   * Lista DTEs almacenados. Scan completo del directorio — aceptable para
   * volúmenes pequeños/medianos (decenas de miles). Si crece, agregar índice
   * por (tipo_dte, created_at). El filtro `since` permite sync incremental
   * desde el ERP sin re-leer todo en cada poll.
   */
  async listDtes(opts: {
    since?: string;          // ISO datetime; incluye DTEs con created_at >= since
    tipoDte?: DteRecord['tipo_dte'];
    estado?: DteRecord['estado'];
    limit?: number;          // default 1000 — protege contra responses gigantes
  } = {}): Promise<DteRecord[]> {
    const dir = path.join(this.baseDir, 'dtes');
    if (!existsSync(dir)) return [];
    const limit = opts.limit ?? 1000;
    const sinceMs = opts.since ? new Date(opts.since).getTime() : null;
    const out: DteRecord[] = [];
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.json')) continue;
      const raw = await readJson<DteRecord>(path.join(dir, f));
      if (!raw) continue;
      const rec = normalizeDteRecord(raw);
      if (opts.tipoDte && rec.tipo_dte !== opts.tipoDte) continue;
      if (opts.estado && rec.estado !== opts.estado) continue;
      if (sinceMs !== null && new Date(rec.created_at).getTime() < sinceMs) continue;
      out.push(rec);
    }
    // Orden cronológico ascendente — útil para sync incremental con cursor.
    out.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return out.slice(0, limit);
  }

  // ── Clientes ──────────────────────────────────────────────────────────────

  async saveCliente(rec: ClienteRecord): Promise<void> {
    await atomicWriteJson(path.join(this.baseDir, 'clientes', `${rec.erp_customer_id}.json`), rec);
    if (rec.beon_customer_id) {
      await this.indexSet('beon_customer.json', rec.beon_customer_id, rec.erp_customer_id);
    }
  }

  async getClienteById(erpCustomerId: string): Promise<ClienteRecord | null> {
    return readJson<ClienteRecord>(path.join(this.baseDir, 'clientes', `${erpCustomerId}.json`));
  }

  async getClienteByBeonId(beonCustomerId: string): Promise<ClienteRecord | null> {
    const idx = await readJson<Record<string, string>>(path.join(this.baseDir, 'index', 'beon_customer.json')) ?? {};
    const id = idx[beonCustomerId];
    return id ? this.getClienteById(id) : null;
  }

  async getClienteByDocumento(tipoDocumento: string, numDocumento: string): Promise<ClienteRecord | null> {
    // Scan — aceptable porque clientes son pocos miles a lo sumo. Si crece,
    // agregar índice por (tipoDocumento, numDocumento).
    const dir = path.join(this.baseDir, 'clientes');
    if (!existsSync(dir)) return null;
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.json')) continue;
      const rec = await readJson<ClienteRecord>(path.join(dir, f));
      if (rec && rec.tipo_documento === tipoDocumento && rec.num_documento === numDocumento) return rec;
    }
    return null;
  }

  // ── Idempotency ───────────────────────────────────────────────────────────

  async getIdempotent(key: string): Promise<IdempotencyRecord | null> {
    const rec = await readJson<IdempotencyRecord>(path.join(this.baseDir, 'idempotency', `${safeFile(key)}.json`));
    if (!rec) return null;
    if (new Date(rec.expires_at).getTime() < Date.now()) return null;
    return rec;
  }

  async saveIdempotent(key: string, statusCode: number, response: unknown): Promise<void> {
    const now = new Date();
    const rec: IdempotencyRecord = {
      key,
      status_code: statusCode,
      response,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + IDEMP_TTL_MS).toISOString(),
    };
    await atomicWriteJson(path.join(this.baseDir, 'idempotency', `${safeFile(key)}.json`), rec);
  }

  // ── Correlativos ──────────────────────────────────────────────────────────
  // dte-service es SoT único de la secuencia fiscal.
  //
  // ⚠️  SINGLE-INSTANCE ONLY  ⚠️
  // La concurrencia se serializa con un mutex in-process por tipoDte. Esto
  // garantiza atomicidad SOLO mientras dte-service corra como un único proceso
  // Node.js detrás de UN único puerto. Múltiples réplicas detrás de un load
  // balancer = DOS contadores in-memory desincronizados = duplicados MH.
  //
  // TODO (horizontal scaling): cuando se justifique, migrar el storage de
  // correlativos a Postgres y reemplazar el mutex in-process por:
  //   - SELECT ... FOR UPDATE dentro de una transacción
  //   - o pg_advisory_xact_lock(hash(tipoDte))
  // Antes de escalar, este TODO debe quedar resuelto o duplicaremos DTEs.

  private readonly correlativoLocks = new Map<string, Promise<unknown>>();

  /**
   * Lee el estado sin modificar. Si el archivo NO existe, devuelve un
   * record con `seeded: false` — el resto del sistema usa eso para rechazar
   * reservaciones hasta que un humano sembre explícitamente.
   */
  async peekCorrelativo(tipoDte: string): Promise<CorrelativoRecord> {
    if (!TIPOS_VALIDOS.has(tipoDte)) {
      throw new Error(`tipoDte inválido: ${tipoDte}`);
    }
    const p = path.join(this.baseDir, 'correlativos', `${tipoDte}.json`);
    const raw = await readJson<Partial<CorrelativoRecord> & { ultimo?: number }>(p);
    if (raw) {
      // Normalización completa de archivos legacy. Schemas vistos en disco:
      //   v1 (pre-seeded-flag): { tipo_dte, ultimo, updated_at }
      //   v2 (sin reservados):  { tipo_dte, ultimo_consumido, updated_at }
      //   v3 (actual):          { tipo_dte, seeded, seeded_at, seeded_by,
      //                            ultimo_consumido, reservados, updated_at }
      // Sin esto, `reservarCorrelativo` crashea con
      //   "Cannot read properties of undefined (reading 'length')"
      // cuando `reservados` no existe.
      const ultimoConsumido = typeof raw.ultimo_consumido === 'number'
        ? raw.ultimo_consumido
        : typeof raw.ultimo === 'number'           // alias legacy v1
          ? raw.ultimo
          : 0;
      const rec: CorrelativoRecord = {
        tipo_dte: raw.tipo_dte ?? tipoDte,
        // Si el archivo existe sin flag, asumimos `seeded: true` (estaba en
        // uso operativo antes del cambio). Para forzar re-seed explícito,
        // borrá el archivo del volumen.
        seeded: typeof raw.seeded === 'boolean' ? raw.seeded : true,
        seeded_at: raw.seeded_at ?? raw.updated_at ?? null,
        seeded_by: raw.seeded_by ?? 'legacy-pre-flag',
        ultimo_consumido: ultimoConsumido,
        reservados: Array.isArray(raw.reservados) ? raw.reservados : [],
        updated_at: raw.updated_at ?? new Date().toISOString(),
      };
      return rec;
    }
    return {
      tipo_dte: tipoDte,
      seeded: false,
      seeded_at: null,
      seeded_by: null,
      ultimo_consumido: 0,
      reservados: [],
      updated_at: new Date(0).toISOString(),
    };
  }

  /**
   * Reserva atómicamente el siguiente consecutivo. Devuelve N tal que:
   *   N = max(ultimo_consumido, ...reservados) + 1
   * y agrega N a `reservados`. La reservación NO incrementa ultimo_consumido
   * — eso pasa solo cuando MH confirma vía `consumirCorrelativo`.
   *
   * Lanza CorrelativoNotSeededError si el tipo nunca fue sembrado. Sin
   * seed explícito, dte-service NO arranca secuencias — es la única defensa
   * contra empezar en 1 y chocar con DTEs históricos en MH.
   */
  async reservarCorrelativo(tipoDte: string): Promise<number> {
    return this.withCorrelativoLock(tipoDte, async () => {
      const cur = await this.peekCorrelativo(tipoDte);
      if (!cur.seeded) {
        throw new CorrelativoNotSeededError(tipoDte);
      }
      const maxReservado = cur.reservados.length > 0 ? Math.max(...cur.reservados) : 0;
      const next = Math.max(cur.ultimo_consumido, maxReservado) + 1;
      await this.writeCorrelativo({
        ...cur,
        reservados: [...cur.reservados, next],
        updated_at: new Date().toISOString(),
      });
      return next;
    });
  }

  /**
   * Confirma una reservación: quita N de reservados y, si es estrictamente
   * mayor a ultimo_consumido, lo sube. Idempotente.
   */
  async consumirCorrelativo(tipoDte: string, consecutivo: number): Promise<CorrelativoRecord> {
    return this.withCorrelativoLock(tipoDte, async () => {
      const cur = await this.peekCorrelativo(tipoDte);
      const reservados = cur.reservados.filter(n => n !== consecutivo);
      const ultimo = Math.max(cur.ultimo_consumido, consecutivo);
      const next: CorrelativoRecord = {
        ...cur,
        ultimo_consumido: ultimo,
        reservados,
        updated_at: new Date().toISOString(),
      };
      await this.writeCorrelativo(next);
      return next;
    });
  }

  /**
   * Libera una reservación sin consumirla — usado cuando MH rechaza y queremos
   * que el correlativo NO quede "in-flight" eterno. El número queda como gap.
   * MH no exige contigüidad estricta.
   */
  async devolverCorrelativo(tipoDte: string, consecutivo: number): Promise<CorrelativoRecord> {
    return this.withCorrelativoLock(tipoDte, async () => {
      const cur = await this.peekCorrelativo(tipoDte);
      const reservados = cur.reservados.filter(n => n !== consecutivo);
      const next: CorrelativoRecord = {
        ...cur,
        reservados,
        updated_at: new Date().toISOString(),
      };
      await this.writeCorrelativo(next);
      return next;
    });
  }

  /**
   * Seed administrativo del último consecutivo histórico. ESTE es el único
   * camino para marcar un tipoDte como `seeded`. Idempotente: solo sube
   * ultimo_consumido (nunca baja, protege contra duplicación accidental).
   * Trazabilidad: registra `seeded_by` (libre — tenant, usuario, "admin-cli").
   */
  async sembrarCorrelativo(
    tipoDte: string,
    ultimoConsumido: number,
    seededBy: string | null = null,
  ): Promise<CorrelativoRecord> {
    return this.withCorrelativoLock(tipoDte, async () => {
      const cur = await this.peekCorrelativo(tipoDte);
      const nowIso = new Date().toISOString();
      const nuevoUltimo = Math.max(cur.ultimo_consumido, ultimoConsumido);
      const next: CorrelativoRecord = {
        tipo_dte: tipoDte,
        seeded: true,
        seeded_at: cur.seeded_at ?? nowIso,    // primer seed gana en timestamp
        seeded_by: cur.seeded_by ?? seededBy,
        ultimo_consumido: nuevoUltimo,
        reservados: cur.reservados.filter(n => n > nuevoUltimo),
        updated_at: nowIso,
      };
      await this.writeCorrelativo(next);
      return next;
    });
  }

  /** Lista todos los correlativos (todos los tipos). Útil para debug/UI. */
  async listarCorrelativos(): Promise<CorrelativoRecord[]> {
    const out: CorrelativoRecord[] = [];
    for (const tipo of TIPOS_VALIDOS) {
      out.push(await this.peekCorrelativo(tipo));
    }
    return out;
  }

  private async writeCorrelativo(rec: CorrelativoRecord): Promise<void> {
    const p = path.join(this.baseDir, 'correlativos', `${rec.tipo_dte}.json`);
    await atomicWriteJson(p, rec);
  }

  /** Serializa todas las ops sobre un tipoDte para garantizar atomicidad. */
  private async withCorrelativoLock<T>(tipoDte: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.correlativoLocks.get(tipoDte) ?? Promise.resolve();
    const next = prev.then(fn, fn);   // se ejecuta también si la previa falló
    this.correlativoLocks.set(tipoDte, next.catch(() => undefined));
    return next;
  }

  // ── Helpers internos ──────────────────────────────────────────────────────

  private async indexSet(file: string, key: string, value: string): Promise<void> {
    const p = path.join(this.baseDir, 'index', file);
    const cur = (await readJson<Record<string, string>>(p)) ?? {};
    cur[key] = value;
    await atomicWriteJson(p, cur);
  }
}

/**
 * Normaliza un DteRecord legado para que tenga todos los campos del shape
 * actual. Los DTEs guardados antes de agregar `origen`, `vendedor_nombre`,
 * `erp_synced_at` quedaron sin esos campos en disco; al leerlos asumimos
 * `origen: 'BEON'` (todos los persistidos vienen de /dte/emitir, ruta BEON)
 * y los otros como null.
 */
function normalizeDteRecord(raw: DteRecord): DteRecord {
  return {
    ...raw,
    origen: raw.origen ?? 'BEON',
    vendedor_nombre: raw.vendedor_nombre ?? null,
    erp_synced_at: raw.erp_synced_at ?? null,
  };
}

async function atomicWriteJson(target: string, data: unknown): Promise<void> {
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await rename(tmp, target);
}

async function readJson<T>(target: string): Promise<T | null> {
  try {
    const raw = await readFile(target, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Sanitiza una clave para usar como nombre de archivo (sin path traversal). */
function safeFile(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

export function newErpInvoiceId(): string {
  return `inv_${randomBytes(12).toString('hex')}`;
}

export function newErpCustomerId(): string {
  return `cli_${randomBytes(12).toString('hex')}`;
}
