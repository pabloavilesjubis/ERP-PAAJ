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

  PUNTO_VENTA_ESTABLECIMIENTO: z.string().regex(/^[A-Z0-9]{4}$/),
  PUNTO_VENTA_PUNTO: z.string().regex(/^[A-Z0-9]{4}$/),
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
