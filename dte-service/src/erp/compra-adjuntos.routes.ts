import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../auth/auth.middleware.js';
import { query } from '../db/client.js';
import { ValidationError } from '../errors.js';
import { authedPlugin, ctx, parse } from './http.js';

/**
 * PDF y JSON adjuntos a cada compra (uno de cada tipo), por empresa.
 *
 *   GET    /v2/compras/:id/adjuntos/:kind   descarga el archivo
 *   PUT    /v2/compras/:id/adjuntos/:kind   sube o reemplaza { filename, content_base64 } (payables:manage)
 *   DELETE /v2/compras/:id/adjuntos/:kind   lo quita (payables:manage)
 *
 * El listado de /v2/compras trae `adjuntos` ({ pdf?: {filename,size}, json?: … }).
 */

const KINDS = { pdf: 'application/pdf', json: 'application/json' } as const;
type Kind = keyof typeof KINDS;
const MAX_BYTES = 10 * 1024 * 1024;

const UploadBody = z.object({
  filename: z.string().trim().min(1).max(200),
  content_base64: z.string().min(1, 'Elige el archivo'),
});

function params(raw: unknown): { id: number; kind: Kind } {
  const p = raw as { id: string; kind: string };
  const id = parseInt(p.id, 10);
  if (!Number.isFinite(id)) throw new ValidationError('Compra inválida');
  if (!(p.kind in KINDS)) throw new ValidationError('Tipo de adjunto inválido (pdf o json)');
  return { id, kind: p.kind as Kind };
}

/** Si el JSON es un DTE, debe ser el de esta compra (mismo código de generación). */
function checkJson(content: Buffer, compraCodigo: string | null): void {
  let doc: unknown;
  try { doc = JSON.parse(content.toString('utf8').replace(/^﻿/, '')); } catch { throw new ValidationError('El archivo no es un JSON válido'); }
  const ident = (doc as { identificacion?: { codigoGeneracion?: string } } | null)?.identificacion;
  const codigo = ident?.codigoGeneracion?.toUpperCase();
  if (codigo && compraCodigo && codigo !== compraCodigo.toUpperCase()) {
    throw new ValidationError(`Ese JSON es de otro DTE (${codigo.slice(0, 8)}…), no de esta compra`);
  }
}

export async function registerCompraAdjuntosRoutes(app: FastifyInstance): Promise<void> {
  await authedPlugin(app, (r) => {
    r.get('/v2/compras/:id/adjuntos/:kind', async (req, reply) => {
      const { tenantId } = ctx(req);
      const { id, kind } = params(req.params);
      const res = await query<{ filename: string; mime: string; content: Buffer }>(
        'SELECT filename, mime, content FROM compra_adjuntos WHERE tenant_id = $1 AND compra_id = $2 AND kind = $3', [tenantId, id, kind]);
      const f = res.rows[0];
      if (!f) return reply.code(404).send({ success: false, code: 'NOT_FOUND', message: 'La compra no tiene ese adjunto' });
      return reply
        .header('Content-Type', f.mime)
        .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.filename)}`)
        .send(f.content);
    });

    r.put('/v2/compras/:id/adjuntos/:kind', { preHandler: requirePerm('payables:manage'), bodyLimit: Math.ceil(MAX_BYTES * 1.4) }, async (req) => {
      const c = ctx(req);
      const { id, kind } = params(req.params);
      const b = parse(UploadBody, req.body);
      const compra = await query<{ codigo: string | null }>(
        "SELECT metadata->>'numeroDocumento' AS codigo FROM compras WHERE tenant_id = $1 AND id = $2", [c.tenantId, id]);
      if (!compra.rows.length) throw new ValidationError('Compra no encontrada');
      const content = Buffer.from(b.content_base64, 'base64');
      if (!content.length) throw new ValidationError('El archivo está vacío');
      if (content.length > MAX_BYTES) throw new ValidationError('El archivo pesa más de 10 MB');
      if (kind === 'pdf' && content.subarray(0, 5).toString('latin1') !== '%PDF-') throw new ValidationError('El archivo no es un PDF');
      // Solo se compara con el código de generación si la compra es un DTE (UUID)
      const codigo = compra.rows[0]!.codigo;
      if (kind === 'json') checkJson(content, codigo && /^[0-9A-F-]{36}$/i.test(codigo) ? codigo : null);
      await query(`
        INSERT INTO compra_adjuntos (tenant_id, compra_id, kind, filename, mime, size, content, uploaded_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (compra_id, kind) DO UPDATE SET filename = EXCLUDED.filename, mime = EXCLUDED.mime, size = EXCLUDED.size,
          content = EXCLUDED.content, uploaded_by = EXCLUDED.uploaded_by, created_at = NOW()`,
        [c.tenantId, id, kind, b.filename, KINDS[kind], content.length, content, c.userName]);
      return { kind, filename: b.filename, size: content.length };
    });

    r.delete('/v2/compras/:id/adjuntos/:kind', { preHandler: requirePerm('payables:manage') }, async (req) => {
      const { tenantId } = ctx(req);
      const { id, kind } = params(req.params);
      await query('DELETE FROM compra_adjuntos WHERE tenant_id = $1 AND compra_id = $2 AND kind = $3', [tenantId, id, kind]);
      return { success: true };
    });
  });
}
