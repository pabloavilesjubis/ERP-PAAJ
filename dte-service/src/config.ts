import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().int().positive().default(3000),

  MH_ENV: z.enum(['sandbox', 'production', 'mock']),
  MH_NIT: z.string().regex(/^\d{14}$/, 'MH_NIT debe ser 14 dígitos sin guiones'),
  MH_PASSWORD: z.string().min(1),

  FIRMADOR_URL: z.string().url(),
  FIRMADOR_NIT: z.string().regex(/^\d{14}$/),
  FIRMADOR_PASSWORD: z.string().min(1),

  EMISOR_NRC: z.string().min(1),
  EMISOR_NOMBRE: z.string().min(1),
  EMISOR_COD_ACTIVIDAD: z.string().min(1),
  EMISOR_DESC_ACTIVIDAD: z.string().min(1),
  EMISOR_NOMBRE_COMERCIAL: z.string().optional(),
  EMISOR_TIPO_ESTABLECIMIENTO: z.string().length(2),
  EMISOR_DEPARTAMENTO: z.string().length(2),
  EMISOR_MUNICIPIO: z.string().length(2),
  EMISOR_COMPLEMENTO: z.string().min(1),
  EMISOR_TELEFONO: z.string().optional(),
  EMISOR_EMAIL: z.string().email(),

  // Códigos del CONTRIBUYENTE (definidos por vos, libres mientras cumplan formato).
  // Se incrustan en `emisor.codEstable` / `emisor.codPuntoVenta` y arman el
  // bloque de 8 chars del `numeroControl`. Para que MH no rechace, deben
  // coincidir con los códigos dados de alta en el portal del MH para este NIT
  // (o, si se setean `EMISOR_COD_*_MH` aparte, coincidir con esos).
  PUNTO_VENTA_ESTABLECIMIENTO: z.string().regex(/^[A-Z0-9]{4}$/),
  PUNTO_VENTA_PUNTO: z.string().regex(/^[A-Z0-9]{4}$/),

  // Códigos asignados por MH al contribuyente (visibles en el portal,
  // sección "Establecimientos"). Si están seteados se envían como
  // `emisor.codEstableMH` y `emisor.codPuntoVentaMH`. Dejarlos vacíos sólo si
  // MH no asignó códigos diferenciados — en producción casi siempre sí los hay.
  EMISOR_COD_ESTABLE_MH: z.string().regex(/^[A-Z0-9]{4}$/).optional(),
  EMISOR_COD_PUNTO_VENTA_MH: z.string().regex(/^[A-Z0-9]{4}$/).optional(),

  // BEON compatibility layer
  STORAGE_DIR: z.string().default('/app/data'),
  PUBLIC_BASE_URL: z.string().url().optional(),     // ej. http://100.79.208.55:3000 — base de los URLs de pdf/json/ticket
  BEON_API_KEY: z.string().optional(),              // si se define, los endpoints /dte y /clientes exigen X-API-Key con este valor
  BEON_ALLOWED_ORIGINS: z.string().default('http://100.79.208.55:8000'),  // CSV

  // Mailer (opcional) — si no se configura, /dte/reenviar-correo responde 503
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.flatten().fieldErrors;
    console.error('Config inválida:', JSON.stringify(issues, null, 2));
    process.exit(1);
  }
  return parsed.data;
}

export const MH_BASE: Record<Config['MH_ENV'], string> = {
  sandbox: 'https://apitest.dtes.mh.gob.sv',
  production: 'https://api.dtes.mh.gob.sv',
  mock: 'http://mock.local',     // nunca se llama en mock mode
};

export const AMBIENTE: Record<Config['MH_ENV'], '00' | '01'> = {
  sandbox: '00',
  production: '01',
  mock: '00',                    // mock se comporta como sandbox para el payload
};
