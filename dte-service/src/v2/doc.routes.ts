import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { requireAuth } from '../auth/auth.middleware.js';
import { buildDteFiles } from '../beon/pdf.js';
import type { DteRecord } from '../beon/storage.js';
import { ValidationError } from '../errors.js';
import type { Config } from '../config.js';

/**
 * Generación on-demand del PDF + JSON de un DTE a partir del `documentoJws`
 * (su payload es el JSON canónico del DTE). Reusa el generador pdfkit
 * (buildDteFiles). Cachea: si el archivo ya existe, no lo regenera.
 *
 *   POST /v2/dte/render  { documentoJws, codigoGeneracion?, numeroControl?,
 *                          selloRecibido?, tipoDte?, ambiente?, fecEmi? }
 *     → { pdf_url, json_url, ticket_url } (servidos públicamente bajo /files/*)
 *
 * Los /files/* quedan GUARDADOS en el volumen del contenedor.
 */
export function registerDocRoutes(app: FastifyInstance, cfg: Config): void {
  const filesDir = path.join(cfg.STORAGE_DIR, 'files');

  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/v2/dte/render')) return;
    await requireAuth(req, reply);
  });

  app.post('/v2/dte/render', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    if (!b.documentoJws) throw new ValidationError('documentoJws requerido');

    let dteJson: Record<string, unknown>;
    try {
      const payload = b.documentoJws.split('.')[1] ?? b.documentoJws;
      const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
      dteJson = JSON.parse(json) as Record<string, unknown>;
    } catch {
      throw new ValidationError('documentoJws inválido (no se pudo decodificar el JSON)');
    }

    const ident = (dteJson.identificacion ?? {}) as Record<string, string | undefined>;
    const codGen = b.codigoGeneracion || ident.codigoGeneracion || '';
    if (!codGen) throw new ValidationError('codigoGeneracion no disponible en el DTE');
    const safeId = codGen.replace(/[^a-zA-Z0-9._-]/g, '_');

    const pdfFile = path.join(filesDir, `${safeId}.pdf`);
    if (!existsSync(pdfFile)) {
      const beonSaleId = b.beonSaleId || null;
      const origen = b.origen || (beonSaleId ? 'BEON' : 'API');
      const rec = {
        erp_invoice_id: codGen,
        beon_sale_id: beonSaleId,
        origen,
        vendedor_nombre: null,
        tipo_dte: (b.tipoDte || ident.tipoDte || '01'),
        estado: 'EMITIDO',
        codigo_generacion: codGen,
        numero_control: b.numeroControl || ident.numeroControl || '',
        sello_recibido: b.selloRecibido || null,
        fh_procesamiento: null,
        fec_emi: b.fecEmi || ident.fecEmi || '',
        hor_emi: ident.horEmi || '',
        ambiente: b.ambiente || ident.ambiente || '01',
        receptor_correo: null,
        receptor_nombre: null,
        consecutivo: 0,
        dte_json: dteJson,
        documento_jws: b.documentoJws,
        mh_raw: {},
        pdf_path: null,
        json_path: null,
        ticket_path: null,
        anulacion: null,
        erp_synced_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as unknown as DteRecord;
      await buildDteFiles({ rec, outDir: filesDir });
      req.log.info({ codGen, safeId }, 'PDF/JSON generado y guardado desde documentoJws');
    }

    const base = (cfg.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
    return reply.send({
      success: true,
      pdf_url: `${base}/files/${safeId}.pdf`,
      json_url: `${base}/files/${safeId}.json`,
      ticket_url: `${base}/files/${safeId}-ticket.pdf`,
    });
  });
}
