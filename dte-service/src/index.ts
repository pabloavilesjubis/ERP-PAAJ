import 'dotenv/config';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { DteError, MhRejectedError, ValidationError } from './errors.js';
import { registerRoutes } from './routes.js';

const cfg = loadConfig();

const app = Fastify({
  logger: {
    level: cfg.LOG_LEVEL,
    transport: cfg.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
    // No volcar tokens ni JWS firmados a logs.
    redact: ['req.headers.authorization', 'res.body.documento'],
  },
});

await app.register(cors, { origin: true });

registerRoutes(app, cfg);

app.setErrorHandler((rawErr, req, reply) => {
  const err = rawErr as unknown as Error;
  req.log.error({ err }, 'request failed');
  if (err instanceof ValidationError) {
    return reply.code(400).send({ code: err.code, message: err.message, details: err.details });
  }
  if (err instanceof MhRejectedError) {
    return reply.code(422).send({
      code: err.code,
      message: err.message,
      mhMessage: err.mhMessage,
      observaciones: err.observaciones,
      details: err.details,
    });
  }
  if (err instanceof DteError) {
    const status = err.code === 'MH_AUTH_FAILED' ? 502
      : err.code === 'FIRMADOR_FAILED' ? 502
      : err.code === 'MH_TRANSIENT' ? 503
      : 500;
    return reply.code(status).send({ code: err.code, message: err.message, details: err.details });
  }
  return reply.code(500).send({ code: 'INTERNAL', message: 'Error inesperado' });
});

try {
  const addr = await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
  app.log.info(`DTE service listening on ${addr} · MH_ENV=${cfg.MH_ENV}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
