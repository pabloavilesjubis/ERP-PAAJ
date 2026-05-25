import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ValidationError } from '../errors.js';
import { requireAuth } from '../auth/auth.middleware.js';
import { withTx, query } from '../db/client.js';
import { encryptSecret } from '../auth/crypto.js';
import * as correlativos from '../tenants/correlativo.repo.js';
import { getToken } from '../mh/auth.js';
import type { Config } from '../config.js';

interface MultipartField { type: 'field'; fieldname: string; value: unknown }
interface MultipartFile { type: 'file'; fieldname: string; file: AsyncIterable<Uint8Array> }
type MultipartPart = MultipartField | MultipartFile;

/**
 * Endpoints de onboarding multi-tenant:
 *   POST /v2/onboarding/cert      — upload del .crt MH
 *   POST /v2/onboarding/complete  — crea tenant + emisor + correlativos (TX)
 *
 * Reglas:
 *   - Requiere JWT válido de Supabase (cuenta creada).
 *   - El user puede tener tenant_id=null (todavía no asignado).
 *   - Tras `complete`, se setea tenant_id en `users` Y debería propagarse al
 *     JWT vía Supabase Admin API (app_metadata). Sin admin API key, requiere
 *     que el user haga logout/login para refrescar el JWT.
 */

const FIRMADOR_CERTS_DIR = process.env.FIRMADOR_CERTS_DIR ?? '/app/certs';

const CompleteBody = z.object({
  tenant: z.object({
    slug: z.string().min(2).max(32).regex(/^[a-z0-9-]+$/),
    nombre_legal: z.string().min(2),
    nombre_comercial: z.string().nullable().optional(),
  }),
  emisor: z.object({
    mh_env: z.enum(['sandbox', 'production']),
    mh_nit: z.string().regex(/^\d{14}$/),
    mh_password: z.string().min(1),
    firmador_password: z.string().min(1),
    emisor_nrc: z.string().min(1),
    emisor_nombre: z.string().min(1),
    emisor_cod_actividad: z.string().min(1),
    emisor_desc_actividad: z.string().min(1),
    emisor_tipo_establecimiento: z.string().regex(/^\d{2}$/),
    emisor_departamento: z.string().regex(/^\d{2}$/),
    emisor_municipio: z.string().regex(/^\d{2}$/),
    emisor_complemento: z.string().min(1),
    emisor_telefono: z.string().nullable().optional(),
    emisor_email: z.string().email(),
    punto_venta_establecimiento: z.string().regex(/^[A-Z0-9]{4}$/),
    punto_venta_punto: z.string().regex(/^[A-Z0-9]{4}$/),
    emisor_cod_estable_mh: z.string().regex(/^[A-Z0-9]{4}$/).nullable().optional(),
    emisor_cod_punto_venta_mh: z.string().regex(/^[A-Z0-9]{4}$/).nullable().optional(),
  }),
  correlativos: z.array(z.object({
    tipo_dte: z.enum(['01', '03', '05', '14']),
    ultimo_consumido: z.number().int().min(0),
  })),
});

export function registerOnboardingRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/v2/onboarding')) return;
    // Para onboarding requerimos JWT pero NO tenant — la idea es justamente
    // crear el tenant. Bypass del tenant resolution.
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) {
      reply.code(401).send({ success: false, code: 'AUTH_MISSING', message: 'Bearer requerido' });
      return reply;
    }
    // Llamamos requireAuth pero capturamos el TENANT_UNRESOLVED como OK acá.
    try {
      await requireAuth(req, reply);
    } catch { /* tenant unresolved es normal en onboarding */ }
  });

  // POST /v2/onboarding/cert — multipart real (fastify-multipart). Acepta
  // ambos modos: multipart/form-data (file) o JSON con base64 (back-compat).
  app.post('/v2/onboarding/cert', async (req, reply) => {
    const ctype = req.headers['content-type'] ?? '';
    let mhNit: string | undefined;
    let buffer: Buffer | undefined;

    if (ctype.includes('multipart/form-data')) {
      // Iterar campos con req.parts() (proporcionado por @fastify/multipart)
      const parts = (req as unknown as { parts: () => AsyncIterable<MultipartPart> }).parts();
      const chunks: Buffer[] = [];
      for await (const part of parts) {
        if (part.type === 'field' && part.fieldname === 'mh_nit') {
          mhNit = String(part.value);
        } else if (part.type === 'file' && part.fieldname === 'cert') {
          for await (const chunk of part.file) chunks.push(chunk as Buffer);
        }
      }
      if (chunks.length > 0) buffer = Buffer.concat(chunks);
    } else {
      const body = req.body as { mh_nit?: string; cert_base64?: string } | null;
      mhNit = body?.mh_nit;
      if (body?.cert_base64) buffer = Buffer.from(body.cert_base64, 'base64');
    }

    if (!mhNit || !buffer) {
      throw new ValidationError('mh_nit y cert (file o cert_base64) requeridos');
    }
    if (!/^\d{14}$/.test(mhNit)) {
      throw new ValidationError('mh_nit debe ser 14 dígitos');
    }
    await mkdir(FIRMADOR_CERTS_DIR, { recursive: true });
    const certPath = path.join(FIRMADOR_CERTS_DIR, `${mhNit}.crt`);
    await writeFile(certPath, buffer);
    req.log.info({ mh_nit: mhNit, certPath, size: buffer.length }, 'cert subido al firmador');
    return reply.send({ success: true, cert_path: certPath });
  });

  // POST /v2/onboarding/test-mh — valida credenciales MH ANTES de completar
  // onboarding. Pide token al endpoint /seguridad/auth del MH con el NIT y
  // password provistos. Si el MH devuelve token, las creds están bien.
  app.post('/v2/onboarding/test-mh', async (req, reply) => {
    const body = req.body as { mh_env?: 'sandbox' | 'production'; mh_nit?: string; mh_password?: string } | null;
    if (!body?.mh_nit || !body?.mh_password || !body?.mh_env) {
      throw new ValidationError('mh_env, mh_nit, mh_password requeridos');
    }
    try {
      // Sintetizar un Config mínimo para getToken.
      const fakeCfg = {
        MH_ENV: body.mh_env, MH_NIT: body.mh_nit, MH_PASSWORD: body.mh_password,
      } as unknown as Config;
      const token = await getToken(fakeCfg, true);
      req.log.info({ mh_nit: body.mh_nit, mh_env: body.mh_env }, 'creds MH validadas');
      return reply.send({ success: true, token_received: !!token });
    } catch (e) {
      return reply.code(400).send({
        success: false, code: 'MH_AUTH_FAILED',
        message: e instanceof Error ? e.message : 'MH rechazó las credenciales',
      });
    }
  });

  // POST /v2/onboarding/complete — crea tenant + emisor + correlativos (TX)
  app.post('/v2/onboarding/complete', async (req, reply) => {
    const parsed = CompleteBody.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Body inválido', { issues: parsed.error.flatten() });
    }
    const body = parsed.data;
    const userId = req.auth?.userId;
    if (!userId) {
      return reply.code(401).send({ success: false, code: 'AUTH_MISSING' });
    }

    // Verificar que el slug no exista
    const slugCheck = await query<{ id: number }>('SELECT id FROM tenants WHERE slug = $1', [body.tenant.slug]);
    if (slugCheck.rows.length > 0) {
      throw new ValidationError(`slug "${body.tenant.slug}" ya está en uso. Elegí otro.`);
    }

    const certPath = path.join(FIRMADOR_CERTS_DIR, `${body.emisor.mh_nit}.crt`);

    const tenantId = await withTx(async (client) => {
      // 1) Crear tenant
      const tRes = await client.query<{ id: number }>(`
        INSERT INTO tenants (slug, nombre_legal, nombre_comercial, status, brand_config)
        VALUES ($1, $2, $3, 'active', '{}'::JSONB)
        RETURNING id
      `, [body.tenant.slug, body.tenant.nombre_legal, body.tenant.nombre_comercial ?? null]);
      const newTenantId = tRes.rows[0]!.id;

      // 2) Insertar emisor con passwords encriptados
      const e = body.emisor;
      await client.query(`
        INSERT INTO tenant_emisor (
          tenant_id, mh_env, mh_nit, mh_password_enc, firmador_password_enc, cert_path,
          emisor_nrc, emisor_nombre, emisor_cod_actividad, emisor_desc_actividad,
          emisor_tipo_establecimiento, emisor_departamento, emisor_municipio,
          emisor_complemento, emisor_telefono, emisor_email,
          punto_venta_establecimiento, punto_venta_punto,
          emisor_cod_estable_mh, emisor_cod_punto_venta_mh
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
        )
      `, [
        newTenantId, e.mh_env, e.mh_nit,
        encryptSecret(e.mh_password), encryptSecret(e.firmador_password),
        certPath,
        e.emisor_nrc, e.emisor_nombre, e.emisor_cod_actividad, e.emisor_desc_actividad,
        e.emisor_tipo_establecimiento, e.emisor_departamento, e.emisor_municipio,
        e.emisor_complemento, e.emisor_telefono ?? null, e.emisor_email,
        e.punto_venta_establecimiento, e.punto_venta_punto,
        e.emisor_cod_estable_mh ?? null, e.emisor_cod_punto_venta_mh ?? null,
      ]);

      // 3) Linkear user → tenant como admin
      await client.query(`
        INSERT INTO users (id, email, tenant_id, role, full_name)
        VALUES ($1, $2, $3, 'admin', NULL)
        ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, role = 'admin'
      `, [userId, req.auth?.email ?? '', newTenantId]);

      return newTenantId;
    });

    // 4) Sembrar correlativos (fuera de la TX, vía repo que ya maneja locks)
    for (const c of body.correlativos) {
      await correlativos.sembrar(tenantId, c.tipo_dte, c.ultimo_consumido, req.auth?.email ?? 'onboarding');
    }

    req.log.info({
      audit: 'ONBOARDING_COMPLETED',
      tenantId, slug: body.tenant.slug, userId, mh_env: body.emisor.mh_env,
    }, 'tenant onboarded');

    await query(
      `INSERT INTO audit_events (tenant_id, user_id, event_type, payload)
       VALUES ($1, $2, 'ONBOARDING_COMPLETED', $3::JSONB)`,
      [tenantId, userId, JSON.stringify({ slug: body.tenant.slug, mh_env: body.emisor.mh_env })],
    );

    // 5) El user ya quedó actualizado en la TX (users.tenant_id = newTenantId).
    //    El frontend debe llamar `POST /v2/auth/refresh` para obtener un JWT
    //    nuevo con el tenant_id seteado. Cero dependencias externas.
    return reply.send({
      success: true,
      tenant_id: tenantId,
      slug: body.tenant.slug,
      action: 'call_refresh',
    });
  });
}
