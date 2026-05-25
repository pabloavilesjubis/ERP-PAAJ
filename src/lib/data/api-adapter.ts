import { api } from '@/lib/api/client';
import { newId } from '@/lib/utils/format';
import type {
  AppData, Compra, Contribuyente, CorrelativoDte, Producto,
  VentaConsumidor, VentaContribuyente,
} from '@/types/domain';
import type { DataAdapter } from './adapter';

/**
 * Adapter PIPELINE ERP SaaS — todas las operaciones de data hablan al backend
 * multi-tenant en /v2/*. Reemplaza el LocalAdapter (localStorage) cuando
 * `VITE_DATA_ADAPTER=api`.
 *
 * `load()` hace un bulk-fetch paralelo de todas las colecciones.
 * `save()` corre el algoritmo DIFF entre el snapshot anterior y el actual,
 *   y emite las mutaciones individuales (POST/PUT/DELETE).
 *
 * Server IDs se mantienen en un Map externo `serverIdByLocalId` indexado por
 * (kind, localId). No mutamos los objetos del domain para no romper sus tipos.
 */

interface ApiRowVenta {
  id: number; kind: 'consumidor' | 'contribuyente';
  dte_id: number | null; fecha: string; descripcion: string;
  monto: string | null; gravado: string | null; exento: string | null; iva: string | null;
  cliente_nombre: string | null; cliente_nrc: string | null; cliente_nit: string | null;
  notas: string | null; metadata: Record<string, unknown>;
}
interface ApiRowCompra {
  id: number; fecha: string; proveedor_nombre: string;
  proveedor_nit: string | null; proveedor_dui: string | null; proveedor_nrc: string | null;
  descripcion: string | null; gravado: string; exento: string; iva: string; total: string;
  notas: string | null; metadata: Record<string, unknown>;
}
interface ApiRowContribuyente {
  id: number; nombre: string; nit: string | null; dui: string | null; nrc: string | null;
  giro: string | null; telefono: string | null; email: string | null;
  direccion: string | null; departamento: string | null; municipio: string | null;
  cod_actividad: string | null; tipo: 'Cliente' | 'Proveedor' | 'Ambos';
}
interface ApiRowProducto {
  id: number; codigo: string | null; nombre: string; tipo: 'producto' | 'servicio';
  precio_unitario: string; uni_medida: number;
}
interface ApiRowCorrelativo {
  tipo_dte: '01' | '03' | '05' | '14'; ultimo_consumido: number;
}

type Kind = 'venta' | 'compra' | 'contribuyente' | 'producto';

export class ApiAdapter implements DataAdapter {
  readonly kind = 'api' as const;
  private lastSnapshot: AppData | null = null;
  /** local_id → server_id, indexado por colección. */
  private serverIds = new Map<string, number>();

  private srvKey(kind: Kind, localId: string): string { return `${kind}::${localId}`; }
  private setSrvId(kind: Kind, localId: string, serverId: number): void {
    this.serverIds.set(this.srvKey(kind, localId), serverId);
  }
  private getSrvId(kind: Kind, localId: string): number | null {
    return this.serverIds.get(this.srvKey(kind, localId)) ?? null;
  }

  async load(): Promise<AppData> {
    this.serverIds.clear();
    const [ventas, compras, contribuyentes, productos, correlativos] = await Promise.all([
      api.get<{ items: ApiRowVenta[] }>('/v2/ventas'),
      api.get<{ items: ApiRowCompra[] }>('/v2/compras'),
      api.get<{ items: ApiRowContribuyente[] }>('/v2/contribuyentes'),
      api.get<{ items: ApiRowProducto[] }>('/v2/productos'),
      api.get<{ items: ApiRowCorrelativo[] }>('/v2/correlativos/listar'),
    ]);

    const ventasConsumidor: VentaConsumidor[] = [];
    const ventasContribuyente: VentaContribuyente[] = [];
    for (const v of ventas.items) {
      const localId = newId();
      this.setSrvId('venta', localId, v.id);
      if (v.kind === 'consumidor') {
        ventasConsumidor.push({
          id: localId, fecha: v.fecha, descripcion: v.descripcion,
          monto: v.monto ?? '0.00', notas: v.notas ?? '',
          metadata: v.metadata as VentaConsumidor['metadata'],
        });
      } else {
        ventasContribuyente.push({
          id: localId, fecha: v.fecha,
          cliente: v.cliente_nombre ?? '', nrc: v.cliente_nrc ?? '',
          descripcion: v.descripcion,
          gravado: v.gravado ?? '0.00', exento: v.exento ?? '0.00',
          notas: v.notas ?? '',
          metadata: v.metadata as VentaContribuyente['metadata'],
        });
      }
    }

    const comprasMapped: Compra[] = compras.items.map(c => {
      const localId = newId();
      this.setSrvId('compra', localId, c.id);
      const total = Number(c.total) || (Number(c.gravado) + Number(c.iva) + Number(c.exento));
      return {
        id: localId, fecha: c.fecha,
        proveedor: c.proveedor_nombre,
        nrc: c.proveedor_nrc ?? '',
        descripcion: c.descripcion ?? '',
        monto: total.toFixed(2),
        ivaCredito: Number(c.iva || 0).toFixed(2),
        notas: c.notas ?? '',
        metadata: {
          ...(c.metadata as object),
          nit: c.proveedor_nit ?? undefined,
          dui: c.proveedor_dui ?? undefined,
        } as Compra['metadata'],
      };
    });

    const contribsMapped: Contribuyente[] = contribuyentes.items.map(c => {
      const localId = newId();
      this.setSrvId('contribuyente', localId, c.id);
      return {
        id: localId, nombre: c.nombre,
        nit: c.nit ?? '', dui: c.dui ?? undefined,
        nrc: c.nrc ?? '', giro: c.giro ?? undefined,
        telefono: c.telefono ?? undefined, email: c.email ?? undefined,
        direccion: c.direccion ?? undefined,
        departamento: c.departamento ?? undefined,
        municipio: c.municipio ?? undefined,
        codActividad: c.cod_actividad ?? undefined,
        tipo: c.tipo,
      };
    });

    const prodMapped: Producto[] = productos.items.map(p => {
      const localId = newId();
      this.setSrvId('producto', localId, p.id);
      return {
        id: localId, codigo: p.codigo ?? undefined,
        nombre: p.nombre, tipo: (p.tipo === 'servicio' ? 'servicio' : 'bien') as Producto['tipo'],
        precioUnitario: String(p.precio_unitario),
        uniMedida: p.uni_medida,
        activo: true,
      };
    });

    const correlativosDte: CorrelativoDte[] = correlativos.items.map(c => ({
      id: newId(),
      tipoDte: c.tipo_dte,
      ultimoConsecutivo: c.ultimo_consumido,
    }));

    const data: AppData = {
      ventasConsumidor, ventasContribuyente,
      compras: comprasMapped,
      contribuyentes: contribsMapped,
      productos: prodMapped,
      correlativosDte,
      reportesGenerados: [],
    };
    this.lastSnapshot = clone(data);
    return data;
  }

  async save(next: AppData): Promise<void> {
    if (!this.lastSnapshot) {
      this.lastSnapshot = clone(next);
      return;
    }
    const prev = this.lastSnapshot;

    await Promise.all([
      this.diffVentas('consumidor', prev.ventasConsumidor, next.ventasConsumidor),
      this.diffVentas('contribuyente', prev.ventasContribuyente, next.ventasContribuyente),
      this.diffCompras(prev.compras, next.compras),
      this.diffContribuyentes(prev.contribuyentes, next.contribuyentes),
      this.diffProductos(prev.productos, next.productos),
    ]);
    this.lastSnapshot = clone(next);
  }

  private async diffVentas(
    kind: 'consumidor' | 'contribuyente',
    prev: Array<VentaConsumidor | VentaContribuyente>,
    next: Array<VentaConsumidor | VentaContribuyente>,
  ): Promise<void> {
    const prevById = new Map(prev.map(v => [v.id, v]));
    const nextById = new Map(next.map(v => [v.id, v]));
    for (const v of next) {
      if (prevById.has(v.id)) continue;
      if (this.getSrvId('venta', v.id) !== null) continue;
      const res = await api.post<{ id: number }>('/v2/ventas', this.ventaToBody(kind, v));
      this.setSrvId('venta', v.id, res.id);
    }
    for (const v of prev) {
      if (nextById.has(v.id)) continue;
      const sid = this.getSrvId('venta', v.id);
      if (sid !== null) {
        await api.delete(`/v2/ventas/${sid}`);
        this.serverIds.delete(this.srvKey('venta', v.id));
      }
    }
    for (const v of next) {
      const p = prevById.get(v.id);
      if (!p || JSON.stringify(p) === JSON.stringify(v)) continue;
      const sid = this.getSrvId('venta', v.id);
      if (sid !== null) await api.put(`/v2/ventas/${sid}`, this.ventaToBody(kind, v));
    }
  }

  private ventaToBody(kind: 'consumidor' | 'contribuyente', v: VentaConsumidor | VentaContribuyente): Record<string, unknown> {
    if (kind === 'consumidor') {
      const vc = v as VentaConsumidor;
      return {
        kind, fecha: vc.fecha, descripcion: vc.descripcion,
        monto: vc.monto, gravado: null, exento: null, iva: vc.metadata?.iva ?? null,
        cliente_nombre: vc.metadata?.cliente ?? null,
        cliente_nrc: null, cliente_nit: null,
        notas: vc.notas, metadata: vc.metadata ?? {},
      };
    }
    const vt = v as VentaContribuyente;
    return {
      kind, fecha: vt.fecha, descripcion: vt.descripcion,
      monto: null, gravado: vt.gravado, exento: vt.exento, iva: null,
      cliente_nombre: vt.cliente, cliente_nrc: vt.nrc, cliente_nit: vt.metadata?.nit ?? null,
      notas: vt.notas, metadata: vt.metadata ?? {},
    };
  }

  private async diffCompras(prev: Compra[], next: Compra[]): Promise<void> {
    const prevById = new Map(prev.map(c => [c.id, c]));
    const nextById = new Map(next.map(c => [c.id, c]));
    for (const c of next) {
      if (prevById.has(c.id) || this.getSrvId('compra', c.id) !== null) continue;
      const res = await api.post<{ id: number }>('/v2/compras', this.compraToBody(c));
      this.setSrvId('compra', c.id, res.id);
    }
    for (const c of prev) {
      if (nextById.has(c.id)) continue;
      const sid = this.getSrvId('compra', c.id);
      if (sid !== null) {
        await api.delete(`/v2/compras/${sid}`);
        this.serverIds.delete(this.srvKey('compra', c.id));
      }
    }
    for (const c of next) {
      const p = prevById.get(c.id);
      if (!p || JSON.stringify(p) === JSON.stringify(c)) continue;
      const sid = this.getSrvId('compra', c.id);
      if (sid !== null) await api.put(`/v2/compras/${sid}`, this.compraToBody(c));
    }
  }

  private compraToBody(c: Compra): Record<string, unknown> {
    const meta = c.metadata ?? {};
    const monto = Number(c.monto || 0);
    const iva = Number(c.ivaCredito || 0);
    return {
      fecha: c.fecha, proveedor_nombre: c.proveedor,
      proveedor_nit: meta.nit ?? null,
      proveedor_dui: meta.dui ?? null,
      proveedor_nrc: c.nrc || null,
      descripcion: c.descripcion,
      gravado: (monto - iva).toFixed(2),
      exento: '0.00',
      iva: iva.toFixed(2),
      total: monto.toFixed(2),
      notas: c.notas, metadata: meta,
    };
  }

  private async diffContribuyentes(prev: Contribuyente[], next: Contribuyente[]): Promise<void> {
    const prevById = new Map(prev.map(x => [x.id, x]));
    const nextById = new Map(next.map(x => [x.id, x]));
    for (const x of next) {
      if (prevById.has(x.id) || this.getSrvId('contribuyente', x.id) !== null) continue;
      const res = await api.post<{ id: number }>('/v2/contribuyentes', this.contribToBody(x));
      this.setSrvId('contribuyente', x.id, res.id);
    }
    for (const x of prev) {
      if (nextById.has(x.id)) continue;
      const sid = this.getSrvId('contribuyente', x.id);
      if (sid !== null) {
        await api.delete(`/v2/contribuyentes/${sid}`);
        this.serverIds.delete(this.srvKey('contribuyente', x.id));
      }
    }
    for (const x of next) {
      const p = prevById.get(x.id);
      if (!p || JSON.stringify(p) === JSON.stringify(x)) continue;
      const sid = this.getSrvId('contribuyente', x.id);
      if (sid !== null) await api.put(`/v2/contribuyentes/${sid}`, this.contribToBody(x));
    }
  }

  private contribToBody(c: Contribuyente): Record<string, unknown> {
    return {
      nombre: c.nombre, nit: c.nit || null, dui: c.dui || null, nrc: c.nrc || null,
      giro: c.giro || null, telefono: c.telefono || null, email: c.email || null,
      direccion: c.direccion || null, departamento: c.departamento || null,
      municipio: c.municipio || null, cod_actividad: c.codActividad || null,
      tipo: c.tipo, metadata: {},
    };
  }

  private async diffProductos(prev: Producto[], next: Producto[]): Promise<void> {
    const prevById = new Map(prev.map(p => [p.id, p]));
    const nextById = new Map(next.map(p => [p.id, p]));
    for (const p of next) {
      if (prevById.has(p.id) || this.getSrvId('producto', p.id) !== null) continue;
      const res = await api.post<{ id: number }>('/v2/productos', this.prodToBody(p));
      this.setSrvId('producto', p.id, res.id);
    }
    for (const p of prev) {
      if (nextById.has(p.id)) continue;
      const sid = this.getSrvId('producto', p.id);
      if (sid !== null) {
        await api.delete(`/v2/productos/${sid}`);
        this.serverIds.delete(this.srvKey('producto', p.id));
      }
    }
    for (const p of next) {
      const o = prevById.get(p.id);
      if (!o || JSON.stringify(o) === JSON.stringify(p)) continue;
      const sid = this.getSrvId('producto', p.id);
      if (sid !== null) await api.put(`/v2/productos/${sid}`, this.prodToBody(p));
    }
  }

  private prodToBody(p: Producto): Record<string, unknown> {
    return {
      codigo: p.codigo ?? null, nombre: p.nombre,
      tipo: p.tipo === 'servicio' ? 'servicio' : 'producto',
      precio_unitario: Number(p.precioUnitario) || 0,
      uni_medida: p.uniMedida,
      metadata: {},
    };
  }
}

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }
