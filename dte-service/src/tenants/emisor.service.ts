import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { z } from 'zod';
import { encryptSecret } from '../auth/crypto.js';
import { query } from '../db/client.js';
import { ValidationError } from '../errors.js';

/**
 * Datos fiscales del emisor (tenant_emisor) y su certificado: lógica común a
 * la consola de plataforma (/v2/admin) y a "Mi empresa" (/v2/company).
 * Las claves del MH y del firmador se guardan cifradas y nunca se devuelven.
 */

export const FIRMADOR_CERTS_DIR = process.env.FIRMADOR_CERTS_DIR ?? '/app/certs';

export const EMISOR_COLS = ['mh_env', 'mh_nit', 'emisor_nrc', 'emisor_nombre', 'emisor_cod_actividad', 'emisor_desc_actividad',
  'emisor_tipo_establecimiento', 'emisor_departamento', 'emisor_municipio', 'emisor_complemento', 'emisor_telefono', 'emisor_email',
  'punto_venta_establecimiento', 'punto_venta_punto', 'emisor_cod_estable_mh', 'emisor_cod_punto_venta_mh'] as const;

const code4 = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4}$/, '4 caracteres (letras o números)');

export const EmisorInput = z.object({
  mh_env: z.enum(['sandbox', 'production']),
  mh_nit: z.string().trim().transform(v => v.replace(/\D/g, '')).refine(v => /^\d{14}$/.test(v), 'El NIT debe tener 14 dígitos'),
  emisor_nrc: z.string().trim().min(1, 'Indica el NRC'),
  emisor_nombre: z.string().trim().min(1, 'Indica el nombre del emisor'),
  emisor_cod_actividad: z.string().trim().min(1, 'Elige la actividad económica'),
  emisor_desc_actividad: z.string().trim().min(1, 'Indica la descripción de la actividad'),
  emisor_tipo_establecimiento: z.string().trim().regex(/^\d{2}$/, 'Tipo de establecimiento de 2 dígitos'),
  emisor_departamento: z.string().trim().regex(/^\d{2}$/, 'Elige el departamento'),
  emisor_municipio: z.string().trim().regex(/^\d{2}$/, 'Elige el municipio'),
  emisor_complemento: z.string().trim().min(1, 'Indica la dirección'),
  // El schema del CCF exige teléfono del emisor (no nullable, mínimo 8)
  emisor_telefono: z.string({ required_error: 'Indica el teléfono (lo exige el CCF)' }).trim().min(8, 'El teléfono debe tener al menos 8 caracteres'),
  emisor_email: z.string().trim().email('Email del emisor inválido'),
  punto_venta_establecimiento: code4,
  punto_venta_punto: code4,
  emisor_cod_estable_mh: code4.nullable().optional().or(z.literal('').transform(() => null)),
  emisor_cod_punto_venta_mh: code4.nullable().optional().or(z.literal('').transform(() => null)),
  mh_password: z.string().optional(),
  firmador_password: z.string().optional(),
});
export type EmisorData = z.infer<typeof EmisorInput>;

export const certPathFor = (nit: string) => path.join(FIRMADOR_CERTS_DIR, `${nit}.crt`);

export async function certExists(nit: string | null | undefined): Promise<boolean> {
  if (!nit) return false;
  try { await access(certPathFor(nit)); return true; } catch { return false; }
}

type Db = { query: (text: string, params?: unknown[]) => Promise<pg.QueryResult> };

/** El NIT no puede pertenecer a otra empresa del sistema. */
export async function assertNitAvailable(tenantId: number | null, nit: string, db: Db = { query }): Promise<void> {
  const other = await db.query('SELECT tenant_id FROM tenant_emisor WHERE mh_nit = $1 AND tenant_id IS DISTINCT FROM $2', [nit, tenantId]);
  if (other.rows.length) throw new ValidationError('Ese NIT ya está registrado en otra empresa del sistema');
}

/** Crea o actualiza los datos fiscales. Claves vacías = conservar las guardadas. Con `db`, dentro de esa transacción. */
export async function upsertEmisor(tenantId: number, e: EmisorData, db: Db = { query }): Promise<'created' | 'updated'> {
  await assertNitAvailable(tenantId, e.mh_nit, db);
  const existing = await db.query('SELECT 1 FROM tenant_emisor WHERE tenant_id = $1', [tenantId]);
  const vals = EMISOR_COLS.map(k => (e as Record<string, unknown>)[k] ?? null);
  if (!existing.rows.length) {
    if (!e.mh_password || !e.firmador_password) {
      throw new ValidationError('Para registrar los datos fiscales indica la clave API del MH y la clave del certificado (firmador)');
    }
    await db.query(`
      INSERT INTO tenant_emisor (tenant_id, ${EMISOR_COLS.join(', ')}, mh_password_enc, firmador_password_enc, cert_path)
      VALUES ($1, ${EMISOR_COLS.map((_, i) => `$${i + 2}`).join(', ')}, $${EMISOR_COLS.length + 2}, $${EMISOR_COLS.length + 3}, $${EMISOR_COLS.length + 4})`,
      [tenantId, ...vals, encryptSecret(e.mh_password), encryptSecret(e.firmador_password), certPathFor(e.mh_nit)]);
    return 'created';
  }
  await db.query(`
    UPDATE tenant_emisor SET ${EMISOR_COLS.map((k, i) => `${k} = $${i + 2}`).join(', ')},
           mh_password_enc = COALESCE($${EMISOR_COLS.length + 2}, mh_password_enc),
           firmador_password_enc = COALESCE($${EMISOR_COLS.length + 3}, firmador_password_enc),
           cert_path = $${EMISOR_COLS.length + 4}, updated_at = NOW()
     WHERE tenant_id = $1`,
    [tenantId, ...vals, e.mh_password ? encryptSecret(e.mh_password) : null, e.firmador_password ? encryptSecret(e.firmador_password) : null,
     certPathFor(e.mh_nit)]);
  return 'updated';
}

/** Guarda el certificado .crt del MH para un NIT (lo lee el firmador). */
export async function saveCert(nit: string, content: Buffer): Promise<string> {
  if (!/^\d{14}$/.test(nit)) throw new ValidationError('El NIT debe tener 14 dígitos');
  if (content.length < 100 || content.length > 64 * 1024) throw new ValidationError('El archivo no parece un certificado .crt del MH');
  const head = content.subarray(0, 200).toString('utf8');
  if (!/<\?xml|<CertificadoMH|-----BEGIN|^\s*[{<]/.test(head) && content[0] !== 0x30) {
    throw new ValidationError('El archivo no parece un certificado .crt del MH');
  }
  await mkdir(FIRMADOR_CERTS_DIR, { recursive: true });
  try {
    await writeFile(certPathFor(nit), content);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'EROFS' || code === 'EACCES') {
      throw new ValidationError('El servidor no puede guardar certificados (carpeta de solo lectura). Avisa al administrador del sistema.');
    }
    throw e;
  }
  return certPathFor(nit);
}
