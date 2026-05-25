import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { buildCcf, type CcfInput } from '../dte/builders/ccf.js';
import { buildFcf, type FcfInput } from '../dte/builders/fcf.js';
import { buildFse, type FseInput } from '../dte/builders/fse.js';
import { buildNc, type NcInput } from '../dte/builders/nc.js';
import { firmar } from '../signing/firmador.js';
import { submitDte } from '../mh/submit.js';
import { CorrelativoNotSeededError, ValidationError } from '../errors.js';
import { validateAgainstSchema } from '../dte/validate.js';
import { requireAuth } from '../auth/auth.middleware.js';
import { getEmisor } from '../tenants/tenant.repo.js';
import { configForTenant } from '../tenants/emisor.adapter.js';
import * as correlativos from '../tenants/correlativo.repo.js';
import { query } from '../db/client.js';

/**
 * Rutas v2 — multi-tenant, gated por `requireAuth`. Cada handler resuelve
 * el tenant desde el JWT (o el path `/t/<slug>`), trae el emisor del DB,
 * construye un Config sintético con `configForTenant` y reutiliza TODOS los
 * builders/firmador/submitDte existentes sin tocarlos.
 *
 * El namespace queda en `/t/:slug/...` o `/v2/...` (a elección del montaje).
 */

const TIPO_VERSION: Record<'fcf' | 'ccf' | 'nc' | 'fse', { tipoDte: string; version: number }> = {
  fcf: { tipoDte: '01', version: 1 },
  ccf: { tipoDte: '03', version: 3 },
  nc: { tipoDte: '05', version: 3 },
  fse: { tipoDte: '14', version: 1 },
};

const TIPO_TO_CODIGO = { fcf: '01', ccf: '03', nc: '05', fse: '14' } as const;

const EmitBody = z.object({
  tipo: z.enum(['fcf', 'ccf', 'nc', 'fse']),
  data: z.record(z.unknown()),
});

export function registerV2Routes(app: FastifyInstance, globalCfg: Config): void {
  app.addHook('preHandler', async (req, reply) => {
    // Aplica requireAuth a TODAS las rutas registradas en este plugin.
    // Si el caller no tiene JWT válido, requireAuth ya respondió 401/403.
    if (!req.url.startsWith('/v2/') && !req.url.startsWith('/t/')) return;
    await requireAuth(req, reply);
  });

  // ── POST /v2/dte/emit ─────────────────────────────────────────────────────
  app.post('/v2/dte/emit', async (req, reply) => {
    const parsed = EmitBody.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Body inválido', { issues: parsed.error.flatten() });
    }
    const { tipo, data } = parsed.data;
    const tenantId = req.tenantId!;

    const emisor = await getEmisor(tenantId);
    if (!emisor) {
      throw new ValidationError(
        'tenant_emisor no configurado — completá el onboarding antes de emitir',
        { tenantId },
      );
    }
    const tenantCfg = configForTenant(globalCfg, emisor);
    const codigoTipo = TIPO_TO_CODIGO[tipo];

    // Resolver consecutivo (atomic via SELECT FOR UPDATE en Postgres)
    const stateBefore = await correlativos.peek(tenantId, codigoTipo);
    if (!stateBefore.seeded) {
      throw new CorrelativoNotSeededError(codigoTipo);
    }
    const suppliedConsecutivo = typeof data.consecutivo === 'number' ? data.consecutivo : undefined;
    let consecutivo: number;
    let reservadoPorNosotros = false;
    if (suppliedConsecutivo !== undefined) {
      if (suppliedConsecutivo <= stateBefore.ultimo_consumido) {
        throw new ValidationError(
          `Correlativo ${suppliedConsecutivo} ya consumido (último=${stateBefore.ultimo_consumido})`,
          { suppliedConsecutivo, ultimoConsumido: stateBefore.ultimo_consumido, tipoDte: codigoTipo },
        );
      }
      consecutivo = suppliedConsecutivo;
    } else {
      consecutivo = await correlativos.reservar(tenantId, codigoTipo);
      reservadoPorNosotros = true;
    }

    req.log.info({
      audit: 'CORRELATIVO_RESERVED',
      tenantId, tipo, tipoDte: codigoTipo,
      consecutivoReservado: consecutivo,
      estadoAntes: stateBefore,
    }, 'AUDIT — correlativo reservado pre-MH (v2)');

    await query(
      `INSERT INTO audit_events (tenant_id, user_id, event_type, payload)
       VALUES ($1, $2, 'CORRELATIVO_RESERVED', $3::JSONB)`,
      [tenantId, req.auth?.userId ?? null, JSON.stringify({ tipoDte: codigoTipo, consecutivo })],
    );

    const dataWithConsecutivo = { ...data, consecutivo };

    try {
      let dte;
      switch (tipo) {
        case 'fcf': dte = buildFcf(tenantCfg, dataWithConsecutivo as unknown as FcfInput); break;
        case 'ccf': dte = buildCcf(tenantCfg, dataWithConsecutivo as unknown as CcfInput); break;
        case 'nc': dte = buildNc(tenantCfg, dataWithConsecutivo as unknown as NcInput); break;
        case 'fse': dte = buildFse(tenantCfg, dataWithConsecutivo as unknown as FseInput); break;
      }

      // Protección dura
      const correlativoExpected = String(consecutivo).padStart(15, '0');
      if (dte.identificacion.numeroControl.slice(-15) !== correlativoExpected) {
        throw new ValidationError(
          'numeroControl no coincide con correlativo reservado',
          { consecutivo, numeroControl: dte.identificacion.numeroControl },
        );
      }

      validateAgainstSchema(tipo, dte);

      const documento = await firmar(tenantCfg, dte);
      const meta = TIPO_VERSION[tipo];
      let result;
      try {
        result = await submitDte({
          cfg: tenantCfg, tipoDte: meta.tipoDte, version: meta.version,
          documento, codigoGeneracion: dte.identificacion.codigoGeneracion,
          numeroControl: dte.identificacion.numeroControl,
          nitEmisor: dte.emisor.nit, log: req.log,
        });
      } catch (e) {
        await correlativos.devolver(tenantId, codigoTipo, consecutivo);
        req.log.warn({ audit: 'CORRELATIVO_RELEASED', tenantId, consecutivo, tipoDte: codigoTipo }, 'rejected by MH or transient');
        throw e;
      }

      const stateAfter = await correlativos.consumir(tenantId, codigoTipo, consecutivo);

      // Persist DTE en Postgres
      const erpInvoiceId = `inv_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      await query(`
        INSERT INTO dtes (
          tenant_id, erp_invoice_id, origen, vendedor_nombre,
          tipo_dte, estado, codigo_generacion, numero_control, sello_recibido,
          fh_procesamiento, fec_emi, hor_emi, ambiente,
          receptor_correo, receptor_nombre, consecutivo,
          dte_json, documento_jws, mh_raw
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::JSONB,$18,$19::JSONB
        )
      `, [
        tenantId, erpInvoiceId, 'POS', req.auth?.email ?? null,
        codigoTipo, result.estado === 'PROCESADO' ? 'EMITIDO' : 'RECHAZADO',
        dte.identificacion.codigoGeneracion, dte.identificacion.numeroControl,
        result.selloRecibido, (result.raw.fhProcesamiento as string) ?? null,
        dte.identificacion.fecEmi, dte.identificacion.horEmi, dte.identificacion.ambiente,
        extractReceptorCorreo(dte), extractReceptorNombre(dte), consecutivo,
        JSON.stringify(dte), documento, JSON.stringify(result.raw),
      ]);

      req.log.info({
        audit: 'CORRELATIVO_COMMITTED',
        tenantId, consecutivo, tipoDte: codigoTipo,
        numeroControl: dte.identificacion.numeroControl,
        selloRecibido: result.selloRecibido,
        estadoDespues: stateAfter,
      }, 'AUDIT — DTE emitido (v2)');

      return reply.send({
        success: true,
        erp_invoice_id: erpInvoiceId,
        codigoGeneracion: dte.identificacion.codigoGeneracion,
        numeroControl: dte.identificacion.numeroControl,
        estado: result.estado,
        selloRecibido: result.selloRecibido,
        consecutivo,
      });
    } catch (e) {
      if (reservadoPorNosotros) {
        try { await correlativos.devolver(tenantId, codigoTipo, consecutivo); }
        catch (releaseErr) { req.log.error({ err: releaseErr }, 'no se pudo devolver'); }
      }
      throw e;
    }
  });

  // ── GET /v2/dte/listar ────────────────────────────────────────────────────
  app.get('/v2/dte/listar', async (req, reply) => {
    const tenantId = req.tenantId!;
    const q = req.query as Record<string, string | undefined>;
    const since = q.since;
    const limit = Math.min(parseInt(q.limit ?? '500', 10) || 500, 5000);
    const params: unknown[] = [tenantId];
    let where = 'WHERE tenant_id = $1';
    if (since) { params.push(since); where += ` AND created_at >= $${params.length}`; }
    const res = await query<DteListedRow>(`
      SELECT * FROM dtes ${where}
       ORDER BY created_at DESC
       LIMIT ${limit}
    `, params);
    return reply.send({ count: res.rows.length, items: res.rows });
  });

  // ── GET /v2/correlativos/listar ───────────────────────────────────────────
  app.get('/v2/correlativos/listar', async (req, reply) => {
    return reply.send({ items: await correlativos.listAll(req.tenantId!) });
  });

  // ── POST /v2/correlativos/sembrar ─────────────────────────────────────────
  app.post('/v2/correlativos/sembrar', async (req, reply) => {
    const body = req.body as { items?: Array<{ tipo_dte?: string; ultimo_consumido?: number }> } | null;
    if (!body || !Array.isArray(body.items)) {
      throw new ValidationError('body debe traer { items: [...] }');
    }
    const tenantId = req.tenantId!;
    const seededBy = req.auth?.email ?? 'admin';
    const out = [];
    for (const item of body.items) {
      if (!item.tipo_dte || !['01', '03', '05', '14'].includes(item.tipo_dte)) continue;
      if (typeof item.ultimo_consumido !== 'number' || item.ultimo_consumido < 0) continue;
      const rec = await correlativos.sembrar(tenantId, item.tipo_dte as '01' | '03' | '05' | '14', item.ultimo_consumido, seededBy);
      out.push({ tipo_dte: rec.tipo_dte, seeded: rec.seeded, ultimo_consumido: rec.ultimo_consumido });
    }
    return reply.send({ resultados: out });
  });

  // ── GET /v2/me — info del usuario + tenant ────────────────────────────────
  app.get('/v2/me', async (req, reply) => {
    return reply.send({
      user: req.auth,
      tenant_id: req.tenantId,
      tenant_slug: req.tenantSlug,
    });
  });
}

// Helpers locales
interface DteListedRow {
  id: string;
  tenant_id: string;
  erp_invoice_id: string;
  tipo_dte: string;
  estado: string;
  codigo_generacion: string;
  numero_control: string;
  sello_recibido: string | null;
  fec_emi: string;
  created_at: string;
}

function extractReceptorCorreo(dte: unknown): string | null {
  const d = dte as { receptor?: { correo?: string } | null; sujetoExcluido?: { correo?: string } | null };
  return d.receptor?.correo ?? d.sujetoExcluido?.correo ?? null;
}
function extractReceptorNombre(dte: unknown): string | null {
  const d = dte as { receptor?: { nombre?: string } | null; sujetoExcluido?: { nombre?: string } | null };
  return d.receptor?.nombre ?? d.sujetoExcluido?.nombre ?? null;
}
