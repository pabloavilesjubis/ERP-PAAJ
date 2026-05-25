import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Storage } from './beon/storage.js';
import { buildAnulacion, type AnulacionInput } from './dte/builders/anulacion.js';
import { buildCcf, type CcfInput } from './dte/builders/ccf.js';
import { buildFcf, type FcfInput } from './dte/builders/fcf.js';
import { buildFse, type FseInput } from './dte/builders/fse.js';
import { buildNc, type NcInput } from './dte/builders/nc.js';
import { firmar } from './signing/firmador.js';
import { annulDte } from './mh/annul.js';
import { submitDte } from './mh/submit.js';
import { CorrelativoNotSeededError, ValidationError } from './errors.js';
import type { DteAny } from './dte/types.js';
import { validateAgainstSchema } from './dte/validate.js';

const tipoDteVersion: Record<'fcf' | 'ccf' | 'nc' | 'fse', { tipoDte: string; version: number }> = {
  fcf: { tipoDte: '01', version: 1 },
  ccf: { tipoDte: '03', version: 3 },
  nc:  { tipoDte: '05', version: 3 },
  fse: { tipoDte: '14', version: 1 },
};

const TIPO_TO_CODIGO: Record<'fcf' | 'ccf' | 'nc' | 'fse', '01' | '03' | '05' | '14'> = {
  fcf: '01', ccf: '03', nc: '05', fse: '14',
};

// Validación mínima del shape — el detalle de items/resumen lo valida el MH
// y/o el firmador. Esta capa sólo asegura que `tipo` sea uno de los soportados
// y que `data` exista.
const EmitBody = z.object({
  tipo: z.enum(['fcf', 'ccf', 'nc', 'fse']),
  data: z.record(z.unknown()),
});

export function registerRoutes(app: FastifyInstance, cfg: Config, storage: Storage): void {
  app.get('/health', async () => ({
    status: 'ok',
    mhEnv: cfg.MH_ENV,
    time: new Date().toISOString(),
  }));

  app.post('/emit', async (req, reply) => {
    const parsed = EmitBody.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Body inválido para /emit', { issues: parsed.error.flatten() });
    }
    const { tipo, data } = parsed.data;
    const codigoTipo = TIPO_TO_CODIGO[tipo];

    // ── Resolver correlativo desde el SoT (dte-service storage) ───────────
    // Mismo flujo que /dte/emitir — UNA sola secuencia. Bloqueo duro si el
    // tipo nunca fue sembrado (CorrelativoNotSeededError).
    const stateBefore = await storage.peekCorrelativo(codigoTipo);
    if (!stateBefore.seeded) {
      throw new CorrelativoNotSeededError(codigoTipo);
    }

    const suppliedConsecutivo = typeof data.consecutivo === 'number' ? data.consecutivo : undefined;
    let consecutivo: number;
    let reservadoPorNosotros = false;
    if (suppliedConsecutivo !== undefined) {
      if (!Number.isInteger(suppliedConsecutivo) || suppliedConsecutivo < 1) {
        throw new ValidationError('consecutivo debe ser entero positivo', { consecutivo: suppliedConsecutivo });
      }
      if (suppliedConsecutivo <= stateBefore.ultimo_consumido) {
        throw new ValidationError(
          `Correlativo ${suppliedConsecutivo} ya fue consumido (último=${stateBefore.ultimo_consumido}). ` +
          `Omití el campo para que dte-service reserve el siguiente.`,
          { consecutivoPedido: suppliedConsecutivo, ultimoConsumido: stateBefore.ultimo_consumido, tipoDte: codigoTipo },
        );
      }
      consecutivo = suppliedConsecutivo;
    } else {
      consecutivo = await storage.reservarCorrelativo(codigoTipo);
      reservadoPorNosotros = true;
    }

    req.log.info({
      audit: 'CORRELATIVO_RESERVED',
      tipo, tipoDte: codigoTipo, consecutivoReservado: consecutivo,
      correlativoSource: reservadoPorNosotros ? 'dte-service (auto-reservado)' : 'caller-supplied (validado)',
      estadoAntes: {
        seeded: stateBefore.seeded,
        seededAt: stateBefore.seeded_at,
        seededBy: stateBefore.seeded_by,
        ultimoConsumido: stateBefore.ultimo_consumido,
        reservados: stateBefore.reservados,
      },
    }, 'AUDIT — correlativo reservado pre-MH (POS)');

    // Inyectamos el consecutivo resuelto al data (puede haber venido sin él).
    const dataWithConsecutivo = { ...data, consecutivo };

    try {
      let dte: DteAny;
      switch (tipo) {
        case 'fcf': dte = buildFcf(cfg, dataWithConsecutivo as unknown as FcfInput); break;
        case 'ccf': dte = buildCcf(cfg, dataWithConsecutivo as unknown as CcfInput); break;
        case 'nc':  dte = buildNc(cfg, dataWithConsecutivo as unknown as NcInput); break;
        case 'fse': dte = buildFse(cfg, dataWithConsecutivo as unknown as FseInput); break;
      }

      const meta = tipoDteVersion[tipo];

      // Protección dura: numeroControl debe terminar con el correlativo zero-padded.
      const correlativoExpected = String(consecutivo).padStart(15, '0');
      if (dte.identificacion.numeroControl.slice(-15) !== correlativoExpected) {
        throw new ValidationError(
          'Inconsistencia interna: numeroControl construido no coincide con correlativo reservado.',
          { consecutivo, numeroControl: dte.identificacion.numeroControl },
        );
      }

      validateAgainstSchema(tipo, dte);

      const documento = await firmar(cfg, dte);
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
        const stateAfter = await storage.devolverCorrelativo(codigoTipo, consecutivo);
        req.log.warn({
          audit: 'CORRELATIVO_RELEASED',
          tipoDte: codigoTipo, consecutivo,
          numeroControl: dte.identificacion.numeroControl,
          razon: e instanceof Error ? e.message : 'MH rechazó o transient',
          estadoDespues: {
            ultimoConsumido: stateAfter.ultimo_consumido,
            reservados: stateAfter.reservados,
          },
        }, 'AUDIT — correlativo devuelto (POS)');
        throw e;
      }

      // MH aceptó → commit
      const stateAfter = await storage.consumirCorrelativo(codigoTipo, consecutivo);
      req.log.info({
        audit: 'CORRELATIVO_COMMITTED',
        tipoDte: codigoTipo, consecutivo,
        numeroControl: dte.identificacion.numeroControl,
        codigoGeneracion: dte.identificacion.codigoGeneracion,
        selloRecibido: result.selloRecibido,
        estadoDespues: {
          ultimoConsumido: stateAfter.ultimo_consumido,
          reservados: stateAfter.reservados,
        },
      }, 'AUDIT — correlativo consumido (POS)');

      req.log.info({
        tipo,
        codigoGeneracion: dte.identificacion.codigoGeneracion,
        numeroControl: dte.identificacion.numeroControl,
        estado: result.estado,
        consecutivo,
      }, 'DTE emitido');

      return reply.send({
        codigoGeneracion: dte.identificacion.codigoGeneracion,
        numeroControl: dte.identificacion.numeroControl,
        estado: result.estado,
        selloRecibido: result.selloRecibido,
        consecutivo,
        dte,
        documento,
        mh: result.raw,
      });
    } catch (e) {
      // Falla pre-MH (build/schema/firmador): devolver reservación si la hicimos.
      if (reservadoPorNosotros) {
        try {
          const cur = await storage.peekCorrelativo(codigoTipo);
          if (cur.reservados.includes(consecutivo)) {
            await storage.devolverCorrelativo(codigoTipo, consecutivo);
          }
        } catch (releaseErr) {
          req.log.error({ err: releaseErr }, 'No se pudo devolver reservación tras falla pre-MH');
        }
      }
      throw e;
    }
  });

  app.post('/annul', async (req, reply) => {
    // Validación mínima — campos esenciales para construir el evento
    const partial = req.body as Partial<AnulacionInput> | null | undefined;
    if (!partial?.tipoDte || !partial.codigoGeneracion || !partial.selloRecibido
        || !partial.numeroControl || !partial.fecEmi || partial.montoIva === undefined
        || !partial.tipoAnulacion || !partial.motivoAnulacion
        || !partial.nombreResponsable || !partial.tipDocResponsable || !partial.numDocResponsable
        || !partial.nombreSolicita || !partial.tipDocSolicita || !partial.numDocSolicita
        || !partial.tipoDocumentoReceptor || !partial.numDocumentoReceptor || !partial.nombreReceptor) {
      throw new ValidationError('Faltan campos obligatorios para anular');
    }
    const evento = buildAnulacion(cfg, partial as AnulacionInput);
    validateAgainstSchema('anulacion', evento);
    const documento = await firmar(cfg, evento);
    const result = await annulDte({ cfg, documento });

    req.log.info({
      codigoGeneracionEvento: evento.identificacion.codigoGeneracion,
      dteAnulado: evento.documento.codigoGeneracion,
    }, 'DTE anulado');

    return reply.send({
      codigoGeneracionEvento: evento.identificacion.codigoGeneracion,
      selloEvento: result.selloRecibido,
      mh: result.raw,
    });
  });
}
