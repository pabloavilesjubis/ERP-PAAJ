import type {
  AppData, Compra, Contribuyente, Producto, ProductoTipo, ReporteGenerado, ReporteTipo,
  VentaConsumidor, VentaContribuyente,
} from '@/types/domain';
import { requireSupabase } from '@/lib/supabase/client';
import type { DataAdapter } from './adapter';

/**
 * Supabase adapter: carga el estado completo del usuario activo y lo replica
 * en memoria. Las escrituras se hacen completas (idempotentes) sobre la empresa
 * actual. En la siguiente iteración se pueden mover a mutaciones por fila con
 * realtime — la API pública del adapter no cambia.
 */
export class SupabaseAdapter implements DataAdapter {
  readonly kind = 'supabase' as const;

  private async getCompanyId(): Promise<string> {
    const supabase = requireSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('No hay sesión activa.');

    const { data: companies, error } = await supabase
      .from('companies').select('id').eq('owner_id', user.id).limit(1);
    if (error) throw error;
    if (companies && companies.length) return companies[0].id;

    const { data: created, error: e2 } = await supabase
      .from('companies').insert({ owner_id: user.id, nombre: 'Mi empresa' })
      .select('id').single();
    if (e2) throw e2;
    return created.id;
  }

  async load(): Promise<AppData> {
    const supabase = requireSupabase();
    const companyId = await this.getCompanyId();

    const [vc, vt, cp, cs, pr, rg] = await Promise.all([
      supabase.from('ventas_consumidor').select('*').eq('company_id', companyId).order('fecha'),
      supabase.from('ventas_contribuyente').select('*').eq('company_id', companyId).order('fecha'),
      supabase.from('compras').select('*').eq('company_id', companyId).order('fecha'),
      supabase.from('contribuyentes').select('*').eq('company_id', companyId).order('nombre'),
      supabase.from('productos').select('*').eq('company_id', companyId).order('nombre'),
      supabase.from('reportes_generados').select('*').eq('company_id', companyId).order('generated_at', { ascending: false }),
    ]);

    const labeled = [
      ['ventas_consumidor', vc.error],
      ['ventas_contribuyente', vt.error],
      ['compras', cp.error],
      ['contribuyentes', cs.error],
      ['productos', pr.error],
      ['reportes_generados', rg.error],
    ] as const;
    for (const [t, err] of labeled) if (err) console.error(`[ERP] load ${t} →`, err);

    // Construimos el AppData con lo que sí cargó. Las tablas con error
    // simplemente quedan como arrays vacíos (porque `r.data ?? []`).
    // Esto evita que un único table missing (migración pendiente, RLS) deje
    // al usuario sin VER nada del resto de su data.
    const partial: AppData = {
      ventasConsumidor: (vc.data ?? []).map(r => ({
        id: r.id, fecha: r.fecha, descripcion: r.descripcion, monto: String(r.monto), notas: r.notas ?? '',
        metadata: r.metadata ?? undefined,
      })) satisfies VentaConsumidor[],
      ventasContribuyente: (vt.data ?? []).map(r => ({
        id: r.id, fecha: r.fecha, cliente: r.cliente, nrc: r.nrc, descripcion: r.descripcion,
        gravado: String(r.gravado), exento: String(r.exento), notas: r.notas ?? '',
        metadata: r.metadata ?? undefined,
      })) satisfies VentaContribuyente[],
      compras: (cp.data ?? []).map(r => ({
        id: r.id, fecha: r.fecha, proveedor: r.proveedor, nrc: r.nrc, descripcion: r.descripcion,
        monto: String(r.monto), ivaCredito: String(r.iva_credito), notas: r.notas ?? '',
        metadata: r.metadata ?? undefined,
      })) satisfies Compra[],
      contribuyentes: (cs.data ?? []).map(r => ({
        id: r.id, nombre: r.nombre, nit: r.nit, dui: r.dui ?? undefined,
        nrc: r.nrc, giro: r.giro ?? '',
        telefono: r.telefono ?? '', email: r.email ?? '', direccion: r.direccion ?? '',
        departamento: r.departamento ?? undefined,
        municipio: r.municipio ?? undefined,
        codActividad: r.cod_actividad ?? undefined,
        tipo: r.tipo,
      })) satisfies Contribuyente[],
      productos: (pr.data ?? []).map(r => ({
        id: r.id,
        codigo: r.codigo ?? undefined,
        nombre: r.nombre,
        descripcion: r.descripcion ?? undefined,
        tipo: r.tipo as ProductoTipo,
        precioUnitario: String(r.precio_unitario),
        uniMedida: r.uni_medida,
        codActividad: r.cod_actividad ?? undefined,
        activo: r.activo,
      })) satisfies Producto[],
      reportesGenerados: (rg.data ?? []).map(r => ({
        id: r.id,
        tipo: r.tipo as ReporteTipo,
        periodoYear: r.periodo_year,
        periodoMonth: r.periodo_month,
        filename: r.filename,
        csvContent: r.csv_content,
        rowCount: r.row_count,
        totalAmount: String(r.total_amount),
        generatedAt: r.generated_at,
      })) satisfies ReporteGenerado[],
    };

    // Si hay errores de tabla, los empaquetamos en una excepción que el store
    // sabe cómo tratar — adjuntamos la data parcial para que el usuario sí
    // vea lo que sí se cargó.
    const erroredTables = labeled.filter(([, e]) => e);
    if (erroredTables.length > 0) {
      const message = erroredTables
        .map(([t, e]) => `${t}: ${e?.message ?? 'unknown'}`)
        .join(' · ');
      const err = new Error(message) as Error & { partialData?: AppData };
      err.partialData = partial;
      throw err;
    }
    return partial;
  }

  async save(data: AppData): Promise<void> {
    const supabase = requireSupabase();
    const companyId = await this.getCompanyId();

    // ── DIFF + DELETE ─────────────────────────────────────────────────────
    // Para cada tabla, identificamos qué IDs existen en BD pero NO en el
    // estado actual, y los borramos. Esto permite que .del() funcione: antes
    // el upsert solo insertaba/actualizaba pero nunca eliminaba filas faltantes.
    const tablesAndIds: Array<[string, Set<string>]> = [
      ['ventas_consumidor', new Set(data.ventasConsumidor.map(r => r.id))],
      ['ventas_contribuyente', new Set(data.ventasContribuyente.map(r => r.id))],
      ['compras', new Set(data.compras.map(r => r.id))],
      ['contribuyentes', new Set(data.contribuyentes.map(r => r.id))],
      ['productos', new Set(data.productos.map(r => r.id))],
      ['reportes_generados', new Set(data.reportesGenerados.map(r => r.id))],
    ];

    for (const [table, currentIds] of tablesAndIds) {
      const { data: dbRows, error: errSel } = await supabase
        .from(table).select('id').eq('company_id', companyId);
      if (errSel) {
        console.error(`[ERP] diff select ${table} →`, errSel);
        continue;
      }
      const toDelete = (dbRows ?? [])
        .map(r => (r as { id: string }).id)
        .filter(id => !currentIds.has(id));
      if (toDelete.length > 0) {
        const { error: errDel } = await supabase
          .from(table).delete().in('id', toDelete);
        if (errDel) {
          console.error(`[ERP] delete ${table} →`, errDel);
          throw new Error(`${table}: ${errDel.message}`);
        }
      }
    }

    // ── UPSERT ────────────────────────────────────────────────────────────
    // Helper: solo upsert si hay filas. Postgres rechaza arrays vacíos en ciertos
    // contextos y un upsert vacío no aporta nada.
    type UpsertResult = { error: { message: string } | null };
    const tasks: Array<[string, PromiseLike<UpsertResult>]> = [];

    if (data.ventasConsumidor.length) {
      tasks.push(['ventas_consumidor', supabase.from('ventas_consumidor').upsert(
        data.ventasConsumidor.map(r => ({
          id: r.id, company_id: companyId, fecha: r.fecha,
          descripcion: r.descripcion, monto: parseFloat(r.monto) || 0, notas: r.notas ?? null,
          metadata: r.metadata ?? null,
        })),
      )]);
    }
    if (data.ventasContribuyente.length) {
      tasks.push(['ventas_contribuyente', supabase.from('ventas_contribuyente').upsert(
        data.ventasContribuyente.map(r => ({
          id: r.id, company_id: companyId, fecha: r.fecha,
          cliente: r.cliente, nrc: r.nrc, descripcion: r.descripcion,
          gravado: parseFloat(r.gravado) || 0, exento: parseFloat(r.exento) || 0, notas: r.notas ?? null,
          metadata: r.metadata ?? null,
        })),
      )]);
    }
    if (data.compras.length) {
      tasks.push(['compras', supabase.from('compras').upsert(
        data.compras.map(r => ({
          id: r.id, company_id: companyId, fecha: r.fecha,
          proveedor: r.proveedor, nrc: r.nrc, descripcion: r.descripcion,
          monto: parseFloat(r.monto) || 0, iva_credito: parseFloat(r.ivaCredito) || 0,
          notas: r.notas ?? null,
          metadata: r.metadata ?? null,
        })),
      )]);
    }
    if (data.contribuyentes.length) {
      tasks.push(['contribuyentes', supabase.from('contribuyentes').upsert(
        data.contribuyentes.map(r => ({
          id: r.id, company_id: companyId, nombre: r.nombre, nit: r.nit, dui: r.dui ?? null,
          nrc: r.nrc,
          giro: r.giro ?? null, telefono: r.telefono ?? null, email: r.email ?? null,
          direccion: r.direccion ?? null,
          departamento: r.departamento ?? null,
          municipio: r.municipio ?? null,
          cod_actividad: r.codActividad ?? null,
          tipo: r.tipo,
        })),
      )]);
    }
    if (data.productos.length) {
      tasks.push(['productos', supabase.from('productos').upsert(
        data.productos.map(r => ({
          id: r.id, company_id: companyId,
          codigo: r.codigo ?? null,
          nombre: r.nombre,
          descripcion: r.descripcion ?? null,
          tipo: r.tipo,
          precio_unitario: parseFloat(r.precioUnitario) || 0,
          uni_medida: r.uniMedida,
          cod_actividad: r.codActividad ?? null,
          activo: r.activo,
        })),
      )]);
    }
    if (data.reportesGenerados.length) {
      tasks.push(['reportes_generados', supabase.from('reportes_generados').upsert(
        data.reportesGenerados.map(r => ({
          id: r.id,
          company_id: companyId,
          tipo: r.tipo,
          periodo_year: r.periodoYear,
          periodo_month: r.periodoMonth,
          filename: r.filename,
          csv_content: r.csvContent,
          row_count: r.rowCount,
          total_amount: parseFloat(r.totalAmount) || 0,
          generated_at: r.generatedAt,
        })),
      )]);
    }

    const results = await Promise.all(tasks.map(([, p]) => p));
    let firstError: { table: string; message: string } | null = null;
    results.forEach((r, i) => {
      const table = tasks[i][0];
      if (r.error) {
        console.error(`[ERP] save ${table} →`, r.error);
        if (!firstError) firstError = { table, message: r.error.message };
      }
    });
    if (firstError) {
      const e = firstError as { table: string; message: string };
      throw new Error(`${e.table}: ${e.message}`);
    }
  }
}
