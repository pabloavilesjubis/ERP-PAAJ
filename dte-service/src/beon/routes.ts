import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { buildCcf } from '../dte/builders/ccf.js';
import { buildFcf } from '../dte/builders/fcf.js';
import { buildNc } from '../dte/builders/nc.js';
import { buildAnulacion } from '../dte/builders/anulacion.js';
import { validateAgainstSchema } from '../dte/validate.js';
import { CorrelativoNotConfiguredError, CorrelativoNotSeededError, ValidationError } from '../errors.js';
import { annulDte } from '../mh/annul.js';
import { submitDte } from '../mh/submit.js';
import { firmar } from '../signing/firmador.js';
import { requireApiKey } from './auth.js';
import { sendDteByMail } from './mailer.js';
import {
  mapToCcfInput, mapToFcfInput, mapToNcInput, montoIvaFromDte,
} from './mapper.js';
import { buildDteFiles, buildQrUrl } from './pdf.js';
import {
  newErpCustomerId, newErpInvoiceId, type ClienteRecord, type DteRecord, type Storage,
} from './storage.js';
import {
  BeonAnularRequest, BeonClienteSyncRequest, BeonEmitirRequest, BeonReenviarCorreoRequest,
  type CanonicalResponse,
} from './types.js';

const TIPO_VERSION: Record<'01' | '03' | '05' | '14', { tipoDte: string; version: number }> = {
  '01': { tipoDte: '01', version: 1 },
  '03': { tipoDte: '03', version: 3 },
  '05': { tipoDte: '05', version: 3 },
  '14': { tipoDte: '14', version: 1 },
};

const TIPO_TO_SCHEMA = { '01': 'fcf', '03': 'ccf', '05': 'nc', '14': 'fse' } as const;

export function registerBeonRoutes(app: FastifyInstance, cfg: Config, storage: Storage): void {
  const auth = requireApiKey(cfg);

  // Captura el body raw del POST como `tenant` resuelto desde header — usado
  // por idempotencia y para guardar `tenant_id` en el record.
  function tenantFromReq(req: FastifyRequest): string | null {
    const h = req.headers['x-tenant-id'];
    return (Array.isArray(h) ? h[0] : h) ?? null;
  }

  function idemKeyFromReq(req: FastifyRequest): string | null {
    const h = req.headers['idempotency-key'];
    return (Array.isArray(h) ? h[0] : h) ?? null;
  }

  function publicUrl(file: string): string {
    const base = cfg.PUBLIC_BASE_URL ?? `http://127.0.0.1:${cfg.PORT}`;
    return `${base.replace(/\/$/, '')}/files/${file}`;
  }

  function toCanonical(rec: DteRecord): CanonicalResponse {
    return {
      success: rec.estado !== 'RECHAZADO',
      erp_invoice_id: rec.erp_invoice_id,
      beon_sale_id: rec.beon_sale_id,
      tipo_dte: rec.tipo_dte,
      estado: rec.estado,
      codigo_generacion: rec.codigo_generacion,
      numero_control: rec.numero_control,
      sello_recibido: rec.sello_recibido,
      fh_procesamiento: rec.fh_procesamiento,
      pdf_url: rec.pdf_path ? publicUrl(`${rec.erp_invoice_id}.pdf`) : null,
      json_url: rec.json_path ? publicUrl(`${rec.erp_invoice_id}.json`) : null,
      ticket_url: rec.ticket_path ? publicUrl(`${rec.erp_invoice_id}-ticket.pdf`) : null,
      qr_url: buildQrUrl(rec),
    };
  }

  // ── POST /dte/emitir ───────────────────────────────────────────────────────
  app.post('/dte/emitir', { preHandler: auth }, async (req, reply) => {
    const parsed = BeonEmitirRequest.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Body inválido para /dte/emitir', { issues: parsed.error.flatten() });
    }
    const body = parsed.data;
    const tenantId = tenantFromReq(req) ?? body.tenant_id ?? null;
    const idemKey = idemKeyFromReq(req);

    // Idempotencia 1: header explícito
    if (idemKey) {
      const cached = await storage.getIdempotent(idemKey);
      if (cached) {
        return reply.code(cached.status_code).send(cached.response);
      }
    }
    // Idempotencia 2: beon_sale_id ya emitido
    if (body.beon_sale_id) {
      const prev = await storage.getDteByBeonSale(body.beon_sale_id);
      if (prev && prev.estado !== 'RECHAZADO') {
        const response = toCanonical(prev);
        if (idemKey) await storage.saveIdempotent(idemKey, 200, response);
        return reply.send(response);
      }
    }

    // ── Resolver correlativo ──────────────────────────────────────────────
    // dte-service es SoT único. Si el tipo nunca fue sembrado, reservar lanza
    // CorrelativoNotSeededError. Si el caller mandó `consecutivo` lo VALIDAMOS
    // pero también exigimos que esté sembrado (no se permite emitir sin seed).
    const stateBefore = await storage.peekCorrelativo(body.tipo_dte);
    if (!stateBefore.seeded) {
      // Bloqueo duro antes de reservar — error idéntico a lo que tiraría
      // reservarCorrelativo, pero más explícito en este punto del flujo.
      throw new CorrelativoNotSeededError(body.tipo_dte);
    }

    let consecutivo: number;
    let reservadoPorNosotros = false;
    if (typeof body.consecutivo === 'number') {
      if (body.consecutivo <= stateBefore.ultimo_consumido) {
        throw new ValidationError(
          `Correlativo ${body.consecutivo} ya fue consumido (último=${stateBefore.ultimo_consumido}). ` +
          `No se permite re-emitir. Omití el campo para que dte-service reserve el siguiente.`,
          { consecutivoPedido: body.consecutivo, ultimoConsumido: stateBefore.ultimo_consumido, tipoDte: body.tipo_dte },
        );
      }
      consecutivo = body.consecutivo;
    } else {
      consecutivo = await storage.reservarCorrelativo(body.tipo_dte);
      reservadoPorNosotros = true;
    }

    // AUDIT pre-MH — todo el contexto fiscal en un solo evento estructurado.
    // Permite reconstruir incidentes leyendo solo logs.
    req.log.info({
      audit: 'CORRELATIVO_RESERVED',
      tipoDte: body.tipo_dte,
      consecutivoReservado: consecutivo,
      correlativoSource: reservadoPorNosotros ? 'dte-service (auto-reservado)' : 'caller-supplied (validado)',
      estadoAntes: {
        seeded: stateBefore.seeded,
        seededAt: stateBefore.seeded_at,
        seededBy: stateBefore.seeded_by,
        ultimoConsumido: stateBefore.ultimo_consumido,
        reservados: stateBefore.reservados,
      },
      beonSaleId: body.beon_sale_id ?? null,
      tenantId,
    }, 'AUDIT — correlativo reservado pre-MH');

    // De acá en adelante, si algo falla antes de MH, devolvemos la reservación
    // (si la creamos nosotros) para no dejar gaps por errores transitorios.
    // Después de MH: commit en PROCESADO, release en RECHAZADO.
    try {
      // Construir DTE canónico
      const tipoDteKey = TIPO_TO_SCHEMA[body.tipo_dte];
      let dte: ReturnType<typeof buildFcf> | ReturnType<typeof buildCcf> | ReturnType<typeof buildNc>;
      switch (body.tipo_dte) {
        case '01': dte = buildFcf(cfg, mapToFcfInput(body, cfg, consecutivo)); break;
        case '03': dte = buildCcf(cfg, mapToCcfInput(body, cfg, consecutivo)); break;
        case '05': dte = buildNc(cfg, mapToNcInput(body, cfg, consecutivo)); break;
        case '14': throw new ValidationError('FSE (14) no soportado aún por mapper BEON');
      }

      // ── Protección dura ──────────────────────────────────────────────────
      // numeroControl debe terminar exactamente en `consecutivo` zero-padded
      // a 15 dígitos. Si el builder generó otra cosa (bug, override,
      // condición de carrera), ABORTAMOS antes de firmar — no contaminamos
      // la secuencia fiscal con un correlativo distinto al reservado.
      const correlativoExpected = String(consecutivo).padStart(15, '0');
      const correlativoBuilt = dte.identificacion.numeroControl.slice(-15);
      if (correlativoBuilt !== correlativoExpected) {
        req.log.error({
          tipoDte: body.tipo_dte,
          consecutivoReservado: consecutivo,
          correlativoEsperado: correlativoExpected,
          correlativoConstruido: correlativoBuilt,
          numeroControl: dte.identificacion.numeroControl,
        }, 'ABORT: numeroControl construido NO coincide con correlativo reservado');
        throw new ValidationError(
          'Inconsistencia interna: numeroControl construido no coincide con correlativo reservado. ' +
          'Emisión abortada antes de firmar.',
          {
            consecutivoReservado: consecutivo,
            correlativoEsperado: correlativoExpected,
            correlativoConstruido: correlativoBuilt,
            numeroControl: dte.identificacion.numeroControl,
          },
        );
      }

      validateAgainstSchema(tipoDteKey, dte);

      // Firmar y transmitir
      const documento = await firmar(cfg, dte);
      const meta = TIPO_VERSION[body.tipo_dte];
      let result;
      try {
        result = await submitDte({
          cfg,
          tipoDte: meta.tipoDte,
          version: meta.version,
          documento,
          codigoGeneracion: dte.identificacion.codigoGeneracion,
          numeroControl: dte.identificacion.numeroControl,
          nitEmisor: dte.emisor.nit,
          log: req.log,
        });
      } catch (e) {
        // MH rechazó o transient — devolvemos la reservación (queda como gap).
        const stateAfter = await storage.devolverCorrelativo(body.tipo_dte, consecutivo);
        req.log.warn({
          audit: 'CORRELATIVO_RELEASED',
          tipoDte: body.tipo_dte,
          consecutivo,
          numeroControl: dte.identificacion.numeroControl,
          razon: e instanceof Error ? e.message : 'MH rechazó o error transient',
          estadoDespues: {
            ultimoConsumido: stateAfter.ultimo_consumido,
            reservados: stateAfter.reservados,
          },
        }, 'AUDIT — correlativo devuelto (MH rechazó/falló)');
        throw e;
      }

      // MH aceptó → commitear el consumo.
      const stateAfter = await storage.consumirCorrelativo(body.tipo_dte, consecutivo);
      req.log.info({
        audit: 'CORRELATIVO_COMMITTED',
        tipoDte: body.tipo_dte,
        consecutivo,
        numeroControl: dte.identificacion.numeroControl,
        codigoGeneracion: dte.identificacion.codigoGeneracion,
        selloRecibido: result.selloRecibido,
        estadoDespues: {
          ultimoConsumido: stateAfter.ultimo_consumido,
          reservados: stateAfter.reservados,
        },
      }, 'AUDIT — correlativo consumido (MH PROCESADO)');

      // Persistir
      const erpInvoiceId = newErpInvoiceId();
      const now = new Date().toISOString();
      const rec: DteRecord = {
        erp_invoice_id: erpInvoiceId,
        beon_sale_id: body.beon_sale_id ?? null,
        tenant_id: tenantId,
        origen: 'BEON',
        vendedor_nombre: body.vendedor_nombre ?? null,
        tipo_dte: body.tipo_dte,
        estado: result.estado === 'PROCESADO' ? 'EMITIDO' : 'RECHAZADO',
        erp_synced_at: null,                 // se setea cuando ERP confirme pull
        codigo_generacion: dte.identificacion.codigoGeneracion,
        numero_control: dte.identificacion.numeroControl,
        sello_recibido: result.selloRecibido,
        fh_procesamiento: (result.raw.fhProcesamiento as string | undefined) ?? null,
        fec_emi: dte.identificacion.fecEmi,
        hor_emi: dte.identificacion.horEmi,
        ambiente: dte.identificacion.ambiente,
        receptor_correo: extractReceptorCorreo(dte),
        receptor_nombre: extractReceptorNombre(dte),
        consecutivo,
        dte_json: dte as unknown as Record<string, unknown>,
        documento_jws: documento,
        mh_raw: result.raw as unknown as Record<string, unknown>,
        pdf_path: null,
        json_path: null,
        ticket_path: null,
        created_at: now,
        updated_at: now,
      };

      // Generar PDF + JSON + ticket
      const files = await buildDteFiles({ rec, outDir: storage.filesDir() });
      rec.pdf_path = files.pdfPath;
      rec.json_path = files.jsonPath;
      rec.ticket_path = files.ticketPath;
      let erpSyncFailed: string | null = null;
      try {
        await storage.saveDte(rec);
      } catch (e) {
        // Falla del guardado interno DESPUÉS de MH PROCESADO + correlativo
        // commiteado. Regla fiscal: NO revertir correlativo, NO marcar la
        // emisión como fallida. Loguear ERP_SYNC_FAILED y devolver success
        // con warning para que BEON sepa que debe disparar replay-sync.
        erpSyncFailed = e instanceof Error ? e.message : 'unknown';
        req.log.error({
          audit: 'ERP_SYNC_FAILED',
          tipoDte: rec.tipo_dte,
          beon_sale_id: rec.beon_sale_id,
          codigoGeneracion: rec.codigo_generacion,
          numeroControl: rec.numero_control,
          selloRecibido: rec.sello_recibido,
          err: erpSyncFailed,
        }, 'CRÍTICO — emisión fiscal exitosa pero guardado interno falló. Replay requerido vía /dte/sync-beon/:beon_sale_id');
      }

      // AUDIT POST-COMMIT — intención de sync hacia el ERP. Es la huella que
      // el ERP debería ingerir (vía pull /dte/listar o /dte/sync-beon).
      // El ERP frontend dispara syncDtes() para materializar este intent
      // en su store local.
      req.log.info({
        audit: 'ERP_SYNC_INTENT',
        origen: rec.origen,
        beon_sale_id: rec.beon_sale_id,
        erp_invoice_id: rec.erp_invoice_id,
        tipo_dte: rec.tipo_dte,
        codigo_generacion: rec.codigo_generacion,
        numero_control: rec.numero_control,
        sello_recibido: rec.sello_recibido,
        fec_emi: rec.fec_emi,
        receptor_nombre: rec.receptor_nombre,
        vendedor_nombre: rec.vendedor_nombre,
        estado_mh: rec.estado,
        erp_sync_failed: erpSyncFailed,
      }, erpSyncFailed
        ? 'ERP sync con WARNING — replay manual requerido'
        : 'ERP sync intent registrado — esperando pull del ERP frontend');

      const response = {
        ...toCanonical(rec),
        origen: rec.origen,
        // Si el guardado interno falló, el caller puede ver el warning y
        // disparar el replay. La emisión fiscal siempre vale.
        erp_sync_warning: erpSyncFailed,
      };
      if (idemKey && !erpSyncFailed) await storage.saveIdempotent(idemKey, 200, response);
      return reply.send(response);
    } catch (e) {
      // Falla pre-submitDte (build, schema, firmador): la reservación que
      // creamos sigue colgada — la devolvemos. Si el caller mandó el
      // consecutivo (no reservamos nosotros) NO lo tocamos: es su sequence.
      // Si la falla fue post-submit, el catch interno ya devolvió.
      if (reservadoPorNosotros) {
        try {
          const cur = await storage.peekCorrelativo(body.tipo_dte);
          if (cur.reservados.includes(consecutivo)) {
            await storage.devolverCorrelativo(body.tipo_dte, consecutivo);
            req.log.warn({ tipoDte: body.tipo_dte, consecutivo }, 'Falla pre-MH: reservación devuelta');
          }
        } catch (releaseErr) {
          req.log.error({ err: releaseErr }, 'No se pudo devolver reservación tras falla pre-MH');
        }
      }
      throw e;
    }
  });

  // ── POST /dte/anular ───────────────────────────────────────────────────────
  app.post('/dte/anular', { preHandler: auth }, async (req, reply) => {
    const parsed = BeonAnularRequest.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Body inválido para /dte/anular', { issues: parsed.error.flatten() });
    }
    const body = parsed.data;
    const idemKey = idemKeyFromReq(req);

    if (idemKey) {
      const cached = await storage.getIdempotent(idemKey);
      if (cached) return reply.code(cached.status_code).send(cached.response);
    }

    // Resolver DTE
    let rec: DteRecord | null = null;
    if (body.erp_invoice_id) rec = await storage.getDteById(body.erp_invoice_id);
    if (!rec && body.beon_sale_id) rec = await storage.getDteByBeonSale(body.beon_sale_id);
    if (!rec) throw new ValidationError('DTE no encontrado para anular');
    if (rec.estado === 'ANULADO') {
      const response = toCanonical(rec);
      return reply.send(response);
    }
    if (rec.estado !== 'EMITIDO' || !rec.sello_recibido) {
      throw new ValidationError('Solo se pueden anular DTEs en estado EMITIDO con sello recibido');
    }

    // Receptor info (necesaria para el evento de anulación). El schema MH
    // exige tipoDocumento+numDocumento+nombre y los compara con lo que tienen
    // registrado para el DTE original. Para FCF anónimos (receptor.tipoDoc=null
    // en el JWS), MH no aceptaba '37'/'00000000' con error
    //   [documento.tipoDocumento] DATO NO COINCIDE CON DTE
    // Convención que funciona en ESV: usar el NIT del propio emisor como
    // placeholder. MH lo trata como "self-receptor" y acepta la anulación.
    const dte = rec.dte_json as Record<string, unknown>;
    const receptor = (dte.receptor ?? dte.sujetoExcluido ?? {}) as Record<string, unknown>;
    const receptorTipoDoc = (receptor.tipoDocumento as string | undefined)
      ?? (receptor.nit ? '36' : '36');
    const receptorNumDoc = (receptor.numDocumento as string | undefined)
      ?? (receptor.nit as string | undefined)
      ?? cfg.MH_NIT;
    const receptorNombre = (receptor.nombre as string | undefined) ?? cfg.EMISOR_NOMBRE;

    // Default responsable/solicita = el emisor (caso típico PAAJ: el
    // contribuyente único es quien opera y solicita sus anulaciones).
    // MH acepta tipo_documento='36' (NIT) con el MH_NIT como num_documento.
    const responsable = body.responsable ?? {
      nombre: cfg.EMISOR_NOMBRE,
      tipo_documento: '36',
      num_documento: cfg.MH_NIT,
    };
    const solicita = body.solicita ?? responsable;

    const evento = buildAnulacion(cfg, {
      tipoDte: rec.tipo_dte,
      codigoGeneracion: rec.codigo_generacion,
      selloRecibido: rec.sello_recibido,
      numeroControl: rec.numero_control,
      fecEmi: rec.fec_emi,
      montoIva: montoIvaFromDte(dte as { resumen: Record<string, unknown> }),
      tipoDocumentoReceptor: receptorTipoDoc,
      numDocumentoReceptor: receptorNumDoc,
      nombreReceptor: receptorNombre,
      tipoAnulacion: body.tipo_anulacion,
      motivoAnulacion: body.motivo,
      nombreResponsable: responsable.nombre,
      tipDocResponsable: responsable.tipo_documento,
      numDocResponsable: responsable.num_documento,
      nombreSolicita: solicita.nombre,
      tipDocSolicita: solicita.tipo_documento,
      numDocSolicita: solicita.num_documento,
      codigoGeneracionReemplazo: body.codigo_generacion_reemplazo ?? undefined,
    });
    validateAgainstSchema('anulacion', evento);
    const documento = await firmar(cfg, evento);
    const result = await annulDte({ cfg, documento });

    rec.estado = 'ANULADO';
    rec.anulacion = {
      codigo_generacion_evento: evento.identificacion.codigoGeneracion,
      sello_evento: result.selloRecibido,
      fec_anula: evento.identificacion.fecAnula,
      motivo: body.motivo,
      mh_raw: result.raw as unknown as Record<string, unknown>,
    };
    rec.updated_at = new Date().toISOString();
    // Re-render PDF con sello "ANULADO"
    const files = await buildDteFiles({ rec, outDir: storage.filesDir() });
    rec.pdf_path = files.pdfPath;
    rec.ticket_path = files.ticketPath;
    await storage.saveDte(rec);

    const response = toCanonical(rec);
    if (idemKey) await storage.saveIdempotent(idemKey, 200, response);
    return reply.send(response);
  });

  // ── Correlativos (ERP-facing, sin auth) ────────────────────────────────────
  // Única secuencia fiscal. Tanto la UI POS como /dte/emitir consumen de acá.
  // El ERP localStorage `correlativosDte` queda como caché de display, NO
  // autoritativo — toda decisión fiscal pasa por estos endpoints.

  app.get('/correlativos/listar', async () => ({
    items: await storage.listarCorrelativos(),
  }));

  app.get('/correlativos/peek', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const tipoDte = q.tipo_dte;
    if (!tipoDte || !['01', '03', '05', '14'].includes(tipoDte)) {
      throw new ValidationError('tipo_dte requerido y válido (01|03|05|14)', { tipo_dte: tipoDte });
    }
    return reply.send(await storage.peekCorrelativo(tipoDte));
  });

  app.post('/correlativos/reservar', async (req, reply) => {
    const body = req.body as { tipo_dte?: string } | null;
    const tipoDte = body?.tipo_dte;
    if (!tipoDte || !['01', '03', '05', '14'].includes(tipoDte)) {
      throw new ValidationError('tipo_dte requerido y válido (01|03|05|14)', { tipo_dte: tipoDte });
    }
    const consecutivo = await storage.reservarCorrelativo(tipoDte);
    req.log.info({ tipoDte, consecutivo, op: 'reservar' }, 'Correlativo reservado');
    return reply.send({ tipo_dte: tipoDte, consecutivo });
  });

  app.post('/correlativos/consumir', async (req, reply) => {
    const body = req.body as { tipo_dte?: string; consecutivo?: number } | null;
    const tipoDte = body?.tipo_dte;
    const consecutivo = body?.consecutivo;
    if (!tipoDte || !['01', '03', '05', '14'].includes(tipoDte)) {
      throw new ValidationError('tipo_dte requerido y válido', { tipo_dte: tipoDte });
    }
    if (typeof consecutivo !== 'number' || !Number.isInteger(consecutivo) || consecutivo < 1) {
      throw new ValidationError('consecutivo debe ser entero positivo', { consecutivo });
    }
    const rec = await storage.consumirCorrelativo(tipoDte, consecutivo);
    req.log.info({ tipoDte, consecutivo, op: 'consumir', ultimoConsumido: rec.ultimo_consumido }, 'Correlativo consumido');
    return reply.send(rec);
  });

  app.post('/correlativos/devolver', async (req, reply) => {
    const body = req.body as { tipo_dte?: string; consecutivo?: number } | null;
    const tipoDte = body?.tipo_dte;
    const consecutivo = body?.consecutivo;
    if (!tipoDte || !['01', '03', '05', '14'].includes(tipoDte)) {
      throw new ValidationError('tipo_dte requerido y válido', { tipo_dte: tipoDte });
    }
    if (typeof consecutivo !== 'number' || !Number.isInteger(consecutivo) || consecutivo < 1) {
      throw new ValidationError('consecutivo debe ser entero positivo', { consecutivo });
    }
    const rec = await storage.devolverCorrelativo(tipoDte, consecutivo);
    req.log.warn({ tipoDte, consecutivo, op: 'devolver' }, 'Correlativo devuelto (queda como gap)');
    return reply.send(rec);
  });

  /**
   * Seed/migración desde un sistema legacy (ej. localStorage del ERP antes
   * de migrar a dte-service como SoT). Idempotente — SOLO sube
   * ultimo_consumido si el valor propuesto es mayor. Nunca baja. Útil para
   * el primer deploy: el ERP llama esto con sus correlativosDte actuales y
   * dte-service queda sincronizado al estado real.
   */
  app.post('/correlativos/sembrar', async (req, reply) => {
    const body = req.body as {
      items?: Array<{ tipo_dte?: string; ultimo_consumido?: number }>;
      seeded_by?: string;
    } | null;
    if (!body || !Array.isArray(body.items)) {
      throw new ValidationError('body debe traer { items: [{ tipo_dte, ultimo_consumido }], seeded_by? }');
    }
    const seededBy = body.seeded_by ?? tenantFromReq(req) ?? null;
    const out: Array<{
      tipo_dte: string;
      antes: number;
      despues: number;
      seeded_antes: boolean;
      seeded_ahora: boolean;
      seeded_at: string | null;
      aplicado: boolean;
    }> = [];
    for (const item of body.items) {
      if (!item.tipo_dte || !['01', '03', '05', '14'].includes(item.tipo_dte)) continue;
      if (typeof item.ultimo_consumido !== 'number' || item.ultimo_consumido < 0) continue;
      const before = await storage.peekCorrelativo(item.tipo_dte);
      const after = await storage.sembrarCorrelativo(item.tipo_dte, item.ultimo_consumido, seededBy);
      out.push({
        tipo_dte: item.tipo_dte,
        antes: before.ultimo_consumido,
        despues: after.ultimo_consumido,
        seeded_antes: before.seeded,
        seeded_ahora: after.seeded,
        seeded_at: after.seeded_at,
        aplicado: after.ultimo_consumido > before.ultimo_consumido || (!before.seeded && after.seeded),
      });
    }
    req.log.info({ resultados: out, seededBy }, 'Correlativos sembrados (acción administrativa)');
    return reply.send({ resultados: out });
  });

  // ── GET /dte/listar ────────────────────────────────────────────────────────
  // Endpoint ERP-facing (sin auth — mismo trust que /emit). Permite al ERP
  // sincronizar las ventas emitidas vía BEON API que de otro modo nunca verían
  // las pestañas VentasConsumidor/VentasContribuyente. Query params:
  //   ?since=2026-01-01T00:00:00Z   (incremental sync — created_at >= since)
  //   ?tipo_dte=01|03|05|14         (opcional)
  //   ?estado=EMITIDO|RECHAZADO|ANULADO
  //   ?limit=N                      (default 1000, máx 5000)
  app.get('/dte/listar', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const tipoDte = q.tipo_dte as DteRecord['tipo_dte'] | undefined;
    if (tipoDte && !['01', '03', '05', '14'].includes(tipoDte)) {
      throw new ValidationError('tipo_dte inválido', { tipo_dte: tipoDte });
    }
    const estado = q.estado as DteRecord['estado'] | undefined;
    if (estado && !['EMITIDO', 'RECHAZADO', 'ANULADO'].includes(estado)) {
      throw new ValidationError('estado inválido', { estado });
    }
    const limit = q.limit ? Math.min(parseInt(q.limit, 10) || 1000, 5000) : 1000;
    const records = await storage.listDtes({
      since: q.since,
      tipoDte,
      estado,
      limit,
    });
    // Devolvemos el record completo + URLs públicas. El ERP necesita
    // `dte_json` para reconstruir VentaConsumidor/VentaContribuyente con
    // descripción, totales y receptor; toCanonical() no incluye esos datos.
    return reply.send({
      items: records.map(rec => ({
        ...toCanonical(rec),
        origen: rec.origen,
        fec_emi: rec.fec_emi,
        hor_emi: rec.hor_emi,
        ambiente: rec.ambiente,
        receptor_correo: rec.receptor_correo,
        receptor_nombre: rec.receptor_nombre,
        vendedor_nombre: rec.vendedor_nombre,
        consecutivo: rec.consecutivo,
        dte_json: rec.dte_json,
        documento_jws: rec.documento_jws,
        anulacion: rec.anulacion ?? null,
        created_at: rec.created_at,
        updated_at: rec.updated_at,
        erp_synced_at: rec.erp_synced_at,
      })),
      count: records.length,
      limit,
    });
  });

  // ── POST /dte/sync-beon/:beon_sale_id ──────────────────────────────────────
  // Replay puntual de un DTE específico hacia el ERP. Devuelve el record
  // canonical + dte_json + documento_jws para que el ERP frontend lo importe.
  // Casos de uso:
  //   - El sync automático del ERP falló al pullear este DTE.
  //   - BEON nota que un sale_id no se vio reflejado en reportes y lo
  //     re-empuja.
  // Idempotente: ejecutarlo N veces devuelve el mismo record.
  app.post('/dte/sync-beon/:beon_sale_id', async (req, reply) => {
    const { beon_sale_id } = req.params as { beon_sale_id?: string };
    if (!beon_sale_id) {
      throw new ValidationError('beon_sale_id requerido en path');
    }
    const rec = await storage.getDteByBeonSale(beon_sale_id);
    if (!rec) {
      return reply.code(404).send({
        success: false,
        code: 'NOT_FOUND',
        message: `No existe DTE con beon_sale_id=${beon_sale_id} en dte-service`,
      });
    }
    req.log.info({
      audit: 'ERP_REPLAY_SINGLE',
      beon_sale_id,
      erp_invoice_id: rec.erp_invoice_id,
      origen: rec.origen,
      codigoGeneracion: rec.codigo_generacion,
    }, 'Replay individual de DTE hacia ERP');
    return reply.send({
      success: true,
      record: {
        ...toCanonical(rec),
        origen: rec.origen,
        fec_emi: rec.fec_emi,
        hor_emi: rec.hor_emi,
        ambiente: rec.ambiente,
        receptor_correo: rec.receptor_correo,
        receptor_nombre: rec.receptor_nombre,
        vendedor_nombre: rec.vendedor_nombre,
        consecutivo: rec.consecutivo,
        dte_json: rec.dte_json,
        documento_jws: rec.documento_jws,
        anulacion: rec.anulacion ?? null,
        created_at: rec.created_at,
        updated_at: rec.updated_at,
        erp_synced_at: rec.erp_synced_at,
      },
    });
  });

  // ── POST /dte/replay-sync ──────────────────────────────────────────────────
  // Replay masivo. Devuelve la lista completa de DTEs (filtros opcionales) en
  // el mismo shape que /dte/listar, pero MARCADOS como replay para auditoría.
  // El ERP frontend los ingiere igual que en sync normal.
  app.post('/dte/replay-sync', async (req, reply) => {
    const body = (req.body ?? {}) as {
      origen?: 'POS' | 'BEON' | 'API';
      since?: string;
      only_unsynced?: boolean;
      limit?: number;
    };
    const records = await storage.listDtes({
      since: body.since,
      limit: body.limit ?? 1000,
    });
    let filtered = records;
    if (body.origen) {
      filtered = filtered.filter(r => r.origen === body.origen);
    }
    if (body.only_unsynced) {
      filtered = filtered.filter(r => !r.erp_synced_at);
    }
    req.log.info({
      audit: 'ERP_REPLAY_BULK',
      total: filtered.length,
      origen: body.origen ?? 'all',
      onlyUnsynced: !!body.only_unsynced,
      since: body.since ?? null,
    }, 'Replay masivo de DTEs hacia ERP');
    return reply.send({
      success: true,
      count: filtered.length,
      items: filtered.map(rec => ({
        ...toCanonical(rec),
        origen: rec.origen,
        fec_emi: rec.fec_emi,
        hor_emi: rec.hor_emi,
        ambiente: rec.ambiente,
        receptor_correo: rec.receptor_correo,
        receptor_nombre: rec.receptor_nombre,
        vendedor_nombre: rec.vendedor_nombre,
        consecutivo: rec.consecutivo,
        dte_json: rec.dte_json,
        documento_jws: rec.documento_jws,
        anulacion: rec.anulacion ?? null,
        created_at: rec.created_at,
        updated_at: rec.updated_at,
        erp_synced_at: rec.erp_synced_at,
      })),
    });
  });

  // ── POST /dte/ack-sync ─────────────────────────────────────────────────────
  // Confirmación del ERP frontend de que pulleó un DTE específico. Setea
  // erp_synced_at para que /dte/replay-sync?only_unsynced=true sepa qué falta.
  // No-op si el DTE no existe (graceful — el ERP puede haber cacheado uno borrado).
  app.post('/dte/ack-sync', async (req, reply) => {
    const body = (req.body ?? {}) as { codigo_generacion?: string };
    if (!body.codigo_generacion) {
      throw new ValidationError('codigo_generacion requerido');
    }
    // Scan — aceptable para volúmenes actuales. Si crece, indexar.
    const records = await storage.listDtes({ limit: 5000 });
    const rec = records.find(r => r.codigo_generacion === body.codigo_generacion);
    if (!rec) {
      return reply.send({ success: true, found: false });
    }
    if (!rec.erp_synced_at) {
      rec.erp_synced_at = new Date().toISOString();
      rec.updated_at = rec.erp_synced_at;
      await storage.saveDte(rec);
      req.log.info({ audit: 'ERP_SYNC_ACK', codigoGeneracion: rec.codigo_generacion, beon_sale_id: rec.beon_sale_id }, 'ERP confirmó pull');
    }
    return reply.send({ success: true, found: true, erp_synced_at: rec.erp_synced_at });
  });

  // ── GET /dte/estado ────────────────────────────────────────────────────────
  app.get('/dte/estado', { preHandler: auth }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const beonSaleId = q.beon_sale_id;
    const erpInvoiceId = q.erp_invoice_id;
    let rec: DteRecord | null = null;
    if (erpInvoiceId) rec = await storage.getDteById(erpInvoiceId);
    if (!rec && beonSaleId) rec = await storage.getDteByBeonSale(beonSaleId);
    if (!rec) {
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'DTE no encontrado' });
    }
    return reply.send(toCanonical(rec));
  });

  // ── POST /dte/reenviar-correo ──────────────────────────────────────────────
  app.post('/dte/reenviar-correo', { preHandler: auth }, async (req, reply) => {
    const parsed = BeonReenviarCorreoRequest.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Body inválido', { issues: parsed.error.flatten() });
    }
    const body = parsed.data;
    let rec: DteRecord | null = null;
    if (body.erp_invoice_id) rec = await storage.getDteById(body.erp_invoice_id);
    if (!rec && body.beon_sale_id) rec = await storage.getDteByBeonSale(body.beon_sale_id);
    if (!rec) throw new ValidationError('DTE no encontrado');
    const dest = body.destinatario ?? rec.receptor_correo;
    if (!dest) throw new ValidationError('No hay destinatario — proporcione `destinatario` o asegure que el DTE tenga correo de receptor');

    await sendDteByMail(cfg, rec, dest);
    return reply.send({ success: true, sent_to: dest, erp_invoice_id: rec.erp_invoice_id });
  });

  // ── POST /clientes/sync ────────────────────────────────────────────────────
  app.post('/clientes/sync', { preHandler: auth }, async (req, reply) => {
    const parsed = BeonClienteSyncRequest.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Body inválido para /clientes/sync', { issues: parsed.error.flatten() });
    }
    const body = parsed.data;
    const tenantId = tenantFromReq(req) ?? null;

    // Resolver doc / NIT
    const tipoDocumento = body.nit ? '36' : (body.tipo_documento ?? null);
    const numDocumento = body.nit ?? body.num_documento ?? null;

    // Buscar existente: por erp_customer_id > beon_customer_id > (tipoDoc+numDoc)
    let existing: ClienteRecord | null = null;
    if (body.erp_customer_id) existing = await storage.getClienteById(body.erp_customer_id);
    if (!existing && body.beon_customer_id) existing = await storage.getClienteByBeonId(body.beon_customer_id);
    if (!existing && tipoDocumento && numDocumento) {
      existing = await storage.getClienteByDocumento(tipoDocumento, numDocumento);
    }

    const now = new Date().toISOString();
    const rec: ClienteRecord = {
      erp_customer_id: existing?.erp_customer_id ?? newErpCustomerId(),
      beon_customer_id: body.beon_customer_id ?? existing?.beon_customer_id ?? null,
      tenant_id: tenantId ?? existing?.tenant_id ?? null,
      tipo_documento: tipoDocumento ?? existing?.tipo_documento ?? null,
      num_documento: numDocumento ?? existing?.num_documento ?? null,
      nrc: body.nrc ?? existing?.nrc ?? null,
      nombre: body.nombre ?? existing?.nombre ?? '',
      nombre_comercial: body.nombre_comercial ?? existing?.nombre_comercial ?? null,
      cod_actividad: body.cod_actividad ?? existing?.cod_actividad ?? null,
      desc_actividad: body.desc_actividad ?? existing?.desc_actividad ?? null,
      direccion: {
        departamento: body.direccion?.departamento ?? existing?.direccion?.departamento ?? null,
        municipio: body.direccion?.municipio ?? existing?.direccion?.municipio ?? null,
        complemento: body.direccion?.complemento ?? existing?.direccion?.complemento ?? null,
      },
      telefono: body.telefono ?? existing?.telefono ?? null,
      correo: body.correo ?? existing?.correo ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    await storage.saveCliente(rec);
    return reply.send({
      success: true,
      erp_customer_id: rec.erp_customer_id,
      created: !existing,
      cliente: rec,
    });
  });
}

function extractReceptorCorreo(dte: unknown): string | null {
  const d = dte as { receptor?: { correo?: string } | null; sujetoExcluido?: { correo?: string } | null };
  return d.receptor?.correo ?? d.sujetoExcluido?.correo ?? null;
}

function extractReceptorNombre(dte: unknown): string | null {
  const d = dte as { receptor?: { nombre?: string } | null; sujetoExcluido?: { nombre?: string } | null };
  return d.receptor?.nombre ?? d.sujetoExcluido?.nombre ?? null;
}
