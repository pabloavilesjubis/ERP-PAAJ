import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../../auth/auth.middleware.js';
import { ValidationError } from '../../errors.js';
import { authedPlugin, ctx, parse, q, tx } from '../http.js';
import { DucaReadError, extractDuca } from './duca.js';

/** Importaciones (F6): lectura opcional de la DUCA con IA y registro en el libro de compras. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)');

export async function registerImportRoutes(app: FastifyInstance): Promise<void> {
  await authedPlugin(app, (r) => {
    r.get('/v2/imports', { preHandler: requirePerm('accounting:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const res = await q(`SELECT i.id, i.duca_number, i.acceptance_date, i.exporter_name, i.exporter_country, i.invoice_number, i.fob, i.freight,
                                  i.insurance, i.customs_value, i.dai, i.iva, i.other_taxes, i.read_by_ai, i.compra_id, i.created_by_name,
                                  a.code AS destination_code, a.name AS destination_name, p.status AS posting_status, p.entry_id
                             FROM accounting.imports i JOIN accounting.accounts a ON a.id = i.destination_account_id
                             LEFT JOIN accounting.document_postings p ON p.tenant_id = i.tenant_id AND p.module = 'compras' AND p.source_id = i.compra_id
                            WHERE i.tenant_id = $1 ORDER BY i.acceptance_date DESC, i.id DESC`, [tenantId]);
      return { items: res.rows };
    });

    r.get('/v2/imports/ai-status', { preHandler: requirePerm('accounting:view') }, async () => ({ enabled: !!process.env.ANTHROPIC_API_KEY }));

    r.post('/v2/imports/read', { preHandler: requirePerm('accounting:post'), bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return reply.code(503).send({ success: false, code: 'AI_DISABLED', message: 'La lectura con IA no está habilitada (falta ANTHROPIC_API_KEY en el servidor). Ingresa la DUCA a mano.' });
      const b = parse(z.object({ pdf_base64: z.string().min(100) }), req.body);
      const pdf = Buffer.from(b.pdf_base64, 'base64');
      if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new ValidationError('El archivo no es un PDF');
      if (pdf.length > 4 * 1024 * 1024) throw new ValidationError('El PDF supera 4 MB');
      try {
        return await extractDuca(pdf, key);
      } catch (e) {
        if (e instanceof DucaReadError) throw new ValidationError(e.message);
        throw e;
      }
    });

    r.post('/v2/imports', { preHandler: requirePerm('accounting:post') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({
        duca_number: z.string().trim().regex(/^\d{6,20}$/, 'El número de DUCA debe tener solo dígitos'),
        acceptance_date: isoDate,
        exporter_name: z.string().max(200).nullable().optional(),
        exporter_country: z.string().max(80).nullable().optional(),
        invoice_number: z.string().max(80).nullable().optional(),
        fob: z.number().min(0), freight: z.number().min(0), insurance: z.number().min(0), other_costs: z.number().min(0),
        customs_value: z.number().positive(), dai: z.number().min(0), iva: z.number().min(0), other_taxes: z.number().min(0),
        destination_account_id: z.number().int().positive(),
        read_by_ai: z.boolean().default(false),
        data: z.record(z.unknown()).optional(),
      }), req.body);
      const res = await tx(db => q<{ id: number }>('SELECT accounting.register_import($1, $2::jsonb, $3, $4) AS id',
        [c.tenantId, JSON.stringify(b), b.destination_account_id, b.read_by_ai], db), c);
      return { id: res.rows[0]!.id };
    });
  });
}
