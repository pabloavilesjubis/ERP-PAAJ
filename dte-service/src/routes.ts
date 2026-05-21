import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { buildAnulacion, type AnulacionInput } from './dte/builders/anulacion.js';
import { buildCcf, type CcfInput } from './dte/builders/ccf.js';
import { buildFcf, type FcfInput } from './dte/builders/fcf.js';
import { buildFse, type FseInput } from './dte/builders/fse.js';
import { buildNc, type NcInput } from './dte/builders/nc.js';
import { firmar } from './signing/firmador.js';
import { annulDte } from './mh/annul.js';
import { submitDte } from './mh/submit.js';
import { ValidationError } from './errors.js';
import type { DteAny } from './dte/types.js';
import { validateAgainstSchema } from './dte/validate.js';

const tipoDteVersion: Record<'fcf' | 'ccf' | 'nc' | 'fse', { tipoDte: string; version: number }> = {
  fcf: { tipoDte: '01', version: 1 },
  ccf: { tipoDte: '03', version: 3 },
  nc:  { tipoDte: '05', version: 3 },
  fse: { tipoDte: '14', version: 1 },
};

// Validación mínima del shape — el detalle de items/resumen lo valida el MH
// y/o el firmador. Esta capa sólo asegura que `tipo` sea uno de los soportados
// y que `data` exista.
const EmitBody = z.object({
  tipo: z.enum(['fcf', 'ccf', 'nc', 'fse']),
  data: z.record(z.unknown()),
});

export function registerRoutes(app: FastifyInstance, cfg: Config): void {
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

    let dte: DteAny;
    switch (tipo) {
      case 'fcf': dte = buildFcf(cfg, data as unknown as FcfInput); break;
      case 'ccf': dte = buildCcf(cfg, data as unknown as CcfInput); break;
      case 'nc':  dte = buildNc(cfg, data as unknown as NcInput); break;
      case 'fse': dte = buildFse(cfg, data as unknown as FseInput); break;
    }

    const meta = tipoDteVersion[tipo];

    // Validación AJV contra el schema oficial ANTES de firmar.
    // Atrapa shape inválido localmente en vez de gastar firmador + MH.
    validateAgainstSchema(tipo, dte);

    const documento = await firmar(cfg, dte);
    const result = await submitDte({
      cfg,
      tipoDte: meta.tipoDte,
      version: meta.version,
      documento,
      codigoGeneracion: dte.identificacion.codigoGeneracion,
    });

    req.log.info({
      tipo,
      codigoGeneracion: dte.identificacion.codigoGeneracion,
      numeroControl: dte.identificacion.numeroControl,
      estado: result.estado,
    }, 'DTE emitido');

    return reply.send({
      codigoGeneracion: dte.identificacion.codigoGeneracion,
      numeroControl: dte.identificacion.numeroControl,
      estado: result.estado,
      selloRecibido: result.selloRecibido,
      dte,
      documento,
      mh: result.raw,
    });
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
