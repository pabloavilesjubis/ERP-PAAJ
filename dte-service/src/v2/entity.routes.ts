import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAuth } from '../auth/auth.middleware.js';
import { isPlatformAdmin } from '../auth/platform-admin.js';
import { query } from '../db/client.js';
import { ValidationError } from '../errors.js';

/**
 * CRUD genérico v2 para las colecciones que el ERP frontend lee/escribe:
 *   - ventas (consumidor + contribuyente, una sola tabla `kind` discriminado)
 *   - compras
 *   - contribuyentes (catálogo de clientes/proveedores)
 *   - productos
 *
 * Todas las queries scoped por `tenant_id`. El cuerpo de POST/PUT acepta el
 * shape canónico de cada entidad menos `id`, `tenant_id`, `created_at`, `updated_at`.
 *
 * Convención: el frontend hace bulk-read al login (GET /v2/<entity>) y
 * mutaciones individuales (POST/PUT/DELETE).
 */

interface Authed extends FastifyRequest { tenantId: number }
function tid(req: FastifyRequest): number {
  const id = (req as Authed).tenantId;
  if (!id) throw new ValidationError('tenantId no resuelto — falla del middleware auth');
  return id;
}

export function registerV2EntityRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/v2/ventas') && !req.url.startsWith('/v2/compras')
      && !req.url.startsWith('/v2/contribuyentes') && !req.url.startsWith('/v2/productos')
      && !req.url.startsWith('/v2/me')) return;
    await requireAuth(req, reply);
  });

  // ── Ventas ────────────────────────────────────────────────────────────────
  app.get('/v2/ventas', async (req, reply) => {
    const q = req.query as { kind?: string; since?: string; limit?: string };
    const params: unknown[] = [tid(req)];
    let where = 'WHERE tenant_id = $1';
    if (q.kind === 'consumidor' || q.kind === 'contribuyente') {
      params.push(q.kind); where += ` AND kind = $${params.length}`;
    }
    if (q.since) { params.push(q.since); where += ` AND fecha >= $${params.length}`; }
    const limit = Math.min(parseInt(q.limit ?? '5000', 10) || 5000, 50000);
    const res = await query(`SELECT * FROM ventas ${where} ORDER BY fecha DESC, id DESC LIMIT ${limit}`, params);
    return reply.send({ items: res.rows });
  });

  app.post('/v2/ventas', async (req, reply) => {
    const v = req.body as Record<string, unknown> | null;
    if (!v) throw new ValidationError('body requerido');
    const kind = v.kind as string;
    if (kind !== 'consumidor' && kind !== 'contribuyente') {
      throw new ValidationError('kind debe ser consumidor|contribuyente');
    }
    const res = await query<{ id: number }>(`
      INSERT INTO ventas (
        tenant_id, kind, dte_id, fecha, descripcion,
        monto, gravado, exento, iva,
        cliente_nombre, cliente_nrc, cliente_nit, notas, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::JSONB)
      RETURNING id
    `, [
      tid(req), kind, v.dte_id ?? null, v.fecha, v.descripcion ?? '',
      v.monto ?? null, v.gravado ?? null, v.exento ?? null, v.iva ?? null,
      v.cliente_nombre ?? null, v.cliente_nrc ?? null, v.cliente_nit ?? null,
      v.notas ?? null, JSON.stringify(v.metadata ?? {}),
    ]);
    return reply.send({ id: res.rows[0]!.id });
  });

  app.put('/v2/ventas/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const v = req.body as Record<string, unknown>;
    await query(`
      UPDATE ventas SET
        kind=$3, fecha=$4, descripcion=$5,
        monto=$6, gravado=$7, exento=$8, iva=$9,
        cliente_nombre=$10, cliente_nrc=$11, cliente_nit=$12,
        notas=$13, metadata=$14::JSONB
       WHERE id=$1 AND tenant_id=$2
    `, [
      id, tid(req), v.kind, v.fecha, v.descripcion ?? '',
      v.monto ?? null, v.gravado ?? null, v.exento ?? null, v.iva ?? null,
      v.cliente_nombre ?? null, v.cliente_nrc ?? null, v.cliente_nit ?? null,
      v.notas ?? null, JSON.stringify(v.metadata ?? {}),
    ]);
    return reply.send({ success: true });
  });

  app.delete('/v2/ventas/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    await query('DELETE FROM ventas WHERE id=$1 AND tenant_id=$2', [id, tid(req)]);
    return reply.send({ success: true });
  });

  // ── Compras ───────────────────────────────────────────────────────────────
  app.get('/v2/compras', async (req, reply) => {
    const q = req.query as { since?: string; limit?: string };
    const params: unknown[] = [tid(req)];
    let where = 'WHERE tenant_id = $1';
    if (q.since) { params.push(q.since); where += ` AND fecha >= $${params.length}`; }
    const limit = Math.min(parseInt(q.limit ?? '5000', 10) || 5000, 50000);
    const res = await query(`SELECT * FROM compras ${where} ORDER BY fecha DESC, id DESC LIMIT ${limit}`, params);
    return reply.send({ items: res.rows });
  });

  app.post('/v2/compras', async (req, reply) => {
    const c = req.body as Record<string, unknown>;
    const res = await query<{ id: number }>(`
      INSERT INTO compras (
        tenant_id, fecha, proveedor_nombre, proveedor_nit, proveedor_dui, proveedor_nrc,
        descripcion, gravado, exento, iva, total, notas, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::JSONB)
      RETURNING id
    `, [
      tid(req), c.fecha, c.proveedor_nombre ?? '', c.proveedor_nit ?? null,
      c.proveedor_dui ?? null, c.proveedor_nrc ?? null,
      c.descripcion ?? null, c.gravado ?? 0, c.exento ?? 0, c.iva ?? 0, c.total ?? 0,
      c.notas ?? null, JSON.stringify(c.metadata ?? {}),
    ]);
    return reply.send({ id: res.rows[0]!.id });
  });

  app.put('/v2/compras/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const c = req.body as Record<string, unknown>;
    await query(`
      UPDATE compras SET
        fecha=$3, proveedor_nombre=$4, proveedor_nit=$5, proveedor_dui=$6, proveedor_nrc=$7,
        descripcion=$8, gravado=$9, exento=$10, iva=$11, total=$12, notas=$13, metadata=$14::JSONB
       WHERE id=$1 AND tenant_id=$2
    `, [
      id, tid(req), c.fecha, c.proveedor_nombre ?? '', c.proveedor_nit ?? null,
      c.proveedor_dui ?? null, c.proveedor_nrc ?? null,
      c.descripcion ?? null, c.gravado ?? 0, c.exento ?? 0, c.iva ?? 0, c.total ?? 0,
      c.notas ?? null, JSON.stringify(c.metadata ?? {}),
    ]);
    return reply.send({ success: true });
  });

  app.delete('/v2/compras/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    await query('DELETE FROM compras WHERE id=$1 AND tenant_id=$2', [id, tid(req)]);
    return reply.send({ success: true });
  });

  // ── Contribuyentes (catálogo) ─────────────────────────────────────────────
  app.get('/v2/contribuyentes', async (req, reply) => {
    const res = await query('SELECT * FROM contribuyentes WHERE tenant_id=$1 ORDER BY nombre', [tid(req)]);
    return reply.send({ items: res.rows });
  });

  app.post('/v2/contribuyentes', async (req, reply) => {
    const c = req.body as Record<string, unknown>;
    const res = await query<{ id: number }>(`
      INSERT INTO contribuyentes (
        tenant_id, nombre, nit, dui, nrc, giro, telefono, email,
        direccion, departamento, municipio, cod_actividad, tipo, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::JSONB)
      RETURNING id
    `, [
      tid(req), c.nombre, c.nit ?? null, c.dui ?? null, c.nrc ?? null,
      c.giro ?? null, c.telefono ?? null, c.email ?? null,
      c.direccion ?? null, c.departamento ?? null, c.municipio ?? null,
      c.cod_actividad ?? null, c.tipo ?? 'Cliente',
      JSON.stringify(c.metadata ?? {}),
    ]);
    return reply.send({ id: res.rows[0]!.id });
  });

  app.put('/v2/contribuyentes/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const c = req.body as Record<string, unknown>;
    await query(`
      UPDATE contribuyentes SET
        nombre=$3, nit=$4, dui=$5, nrc=$6, giro=$7, telefono=$8, email=$9,
        direccion=$10, departamento=$11, municipio=$12, cod_actividad=$13,
        tipo=$14, metadata=$15::JSONB
       WHERE id=$1 AND tenant_id=$2
    `, [
      id, tid(req), c.nombre, c.nit ?? null, c.dui ?? null, c.nrc ?? null,
      c.giro ?? null, c.telefono ?? null, c.email ?? null,
      c.direccion ?? null, c.departamento ?? null, c.municipio ?? null,
      c.cod_actividad ?? null, c.tipo ?? 'Cliente',
      JSON.stringify(c.metadata ?? {}),
    ]);
    return reply.send({ success: true });
  });

  app.delete('/v2/contribuyentes/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    await query('DELETE FROM contribuyentes WHERE id=$1 AND tenant_id=$2', [id, tid(req)]);
    return reply.send({ success: true });
  });

  // ── Productos ─────────────────────────────────────────────────────────────
  app.get('/v2/productos', async (req, reply) => {
    const res = await query('SELECT * FROM productos WHERE tenant_id=$1 ORDER BY nombre', [tid(req)]);
    return reply.send({ items: res.rows });
  });

  app.post('/v2/productos', async (req, reply) => {
    const p = req.body as Record<string, unknown>;
    const res = await query<{ id: number }>(`
      INSERT INTO productos (
        tenant_id, codigo, nombre, tipo, precio_unitario, uni_medida, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::JSONB) RETURNING id
    `, [
      tid(req), p.codigo ?? null, p.nombre, p.tipo ?? 'producto',
      p.precio_unitario ?? 0, p.uni_medida ?? 59,
      JSON.stringify(p.metadata ?? {}),
    ]);
    return reply.send({ id: res.rows[0]!.id });
  });

  app.put('/v2/productos/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const p = req.body as Record<string, unknown>;
    await query(`
      UPDATE productos SET
        codigo=$3, nombre=$4, tipo=$5, precio_unitario=$6, uni_medida=$7, metadata=$8::JSONB
       WHERE id=$1 AND tenant_id=$2
    `, [
      id, tid(req), p.codigo ?? null, p.nombre, p.tipo ?? 'producto',
      p.precio_unitario ?? 0, p.uni_medida ?? 59,
      JSON.stringify(p.metadata ?? {}),
    ]);
    return reply.send({ success: true });
  });

  app.delete('/v2/productos/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    await query('DELETE FROM productos WHERE id=$1 AND tenant_id=$2', [id, tid(req)]);
    return reply.send({ success: true });
  });

  // ── /v2/me ENRICHED: incluye tenant + brand_config para que el frontend
  //    pueda aplicar branding sin un segundo round-trip.
  app.get('/v2/me/full', async (req, reply) => {
    const tenantId = tid(req);
    const tRes = await query<{ id: number; slug: string; nombre_legal: string; nombre_comercial: string | null; brand_config: Record<string, unknown> }>(
      'SELECT id, slug, nombre_legal, nombre_comercial, brand_config FROM tenants WHERE id=$1',
      [tenantId],
    );
    const t = tRes.rows[0];
    return reply.send({
      user: req.auth,
      is_platform_admin: isPlatformAdmin(req.auth?.email),
      tenant: t ? {
        id: t.id, slug: t.slug,
        nombre_legal: t.nombre_legal,
        nombre_comercial: t.nombre_comercial,
        brand_config: t.brand_config ?? {},
      } : null,
    });
  });

  // ── PUT /v2/me/brand: el tenant edita su branding (título del sidebar + logo).
  //    Hace merge con el brand_config existente (no pisa colores u otros campos).
  app.put('/v2/me/brand', async (req, reply) => {
    const tenantId = tid(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ALLOWED = ['title', 'logo_url', 'color_primary', 'color_accent', 'footer_text'];
    const cur = await query<{ brand_config: Record<string, unknown> }>(
      'SELECT brand_config FROM tenants WHERE id=$1', [tenantId],
    );
    const merged: Record<string, unknown> = { ...(cur.rows[0]?.brand_config ?? {}) };
    for (const k of ALLOWED) {
      if (k in b) {
        const v = b[k];
        if (v === null || v === '') delete merged[k];   // vacío = quitar
        else merged[k] = v;
      }
    }
    await query('UPDATE tenants SET brand_config = $1::jsonb, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(merged), tenantId]);
    return reply.send({ success: true, brand_config: merged });
  });
}
