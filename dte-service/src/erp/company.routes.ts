import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../auth/auth.middleware.js';
import { decryptSecret } from '../auth/crypto.js';
import { query } from '../db/client.js';
import { DteError, ValidationError } from '../errors.js';
import { testCredentials } from '../mh/auth.js';
import * as correlativos from '../tenants/correlativo.repo.js';
import { certExists, EMISOR_COLS, EmisorInput, saveCert, upsertEmisor } from '../tenants/emisor.service.js';
import { authedPlugin, ctx, parse } from './http.js';

/**
 * "Mi empresa": el admin de cada empresa carga sus datos generales, los datos
 * fiscales del emisor (NIT, NRC, actividad, dirección, establecimiento), las
 * credenciales del MH, el certificado de firma y los correlativos de DTE.
 *
 *   GET  /v2/company                  datos + estado de la configuración (company:view)
 *   PUT  /v2/company                  nombre legal y comercial (company:manage)
 *   PUT  /v2/company/emisor           datos fiscales (claves vacías = conservar)
 *   POST /v2/company/cert             certificado .crt del MH (para el NIT de la empresa)
 *   POST /v2/company/test-mh          prueba las credenciales contra el MH
 *   POST /v2/company/correlativos     último número emitido por tipo de DTE
 */

const GeneralBody = z.object({
  nombre_legal: z.string().trim().min(2, 'Indica el nombre legal'),
  nombre_comercial: z.string().trim().nullable().optional().transform(v => v || null),
});

const TIPOS = ['01', '03', '05', '14'] as const;

async function audit(tenantId: number, userId: string, event: string, payload: unknown): Promise<void> {
  await query(`INSERT INTO audit_events (tenant_id, user_id, event_type, payload) VALUES ($1, $2, $3, $4::JSONB)`,
    [tenantId, userId, event, JSON.stringify(payload)]);
}

async function storedEmisor(tenantId: number) {
  const r = await query<{ mh_env: 'sandbox' | 'production'; mh_nit: string; mh_password_enc: string | null }>(
    'SELECT mh_env, mh_nit, mh_password_enc FROM tenant_emisor WHERE tenant_id = $1', [tenantId]);
  return r.rows[0] ?? null;
}

export async function registerCompanyRoutes(app: FastifyInstance): Promise<void> {
  await authedPlugin(app, (r) => {
    r.get('/v2/company', { preHandler: requirePerm('company:view') }, async (req) => {
      const { tenantId } = ctx(req);
      const t = await query('SELECT id, slug, nombre_legal, nombre_comercial, status FROM tenants WHERE id = $1', [tenantId]);
      const e = await query<Record<string, unknown> & { mh_nit: string }>(`
        SELECT ${EMISOR_COLS.join(', ')}, updated_at,
               mh_password_enc IS NOT NULL AS has_mh_password, firmador_password_enc IS NOT NULL AS has_firmador_password
          FROM tenant_emisor WHERE tenant_id = $1`, [tenantId]);
      const emisor = e.rows[0] ?? null;
      const corr = await correlativos.listAll(tenantId);
      const cert = await certExists(emisor?.mh_nit);
      return {
        tenant: t.rows[0],
        emisor,
        cert: { present: cert },
        correlativos: corr.map(c => ({ tipo_dte: c.tipo_dte, seeded: c.seeded, ultimo_consumido: c.ultimo_consumido })),
        checklist: {
          general: !!t.rows[0]?.nombre_legal,
          fiscal: !!emisor,
          credentials: !!emisor?.has_mh_password && !!emisor?.has_firmador_password,
          cert,
          correlativos: corr.some(c => c.seeded),
        },
      };
    });

    r.put('/v2/company', { preHandler: requirePerm('company:manage') }, async (req) => {
      const c = ctx(req);
      const b = parse(GeneralBody, req.body);
      await query('UPDATE tenants SET nombre_legal = $2, nombre_comercial = $3, updated_at = NOW() WHERE id = $1',
        [c.tenantId, b.nombre_legal, b.nombre_comercial]);
      await audit(c.tenantId, c.userId, 'COMPANY_UPDATED', b);
      return { success: true };
    });

    r.put('/v2/company/emisor', { preHandler: requirePerm('company:manage') }, async (req) => {
      const c = ctx(req);
      const e = parse(EmisorInput, req.body);
      const result = await upsertEmisor(c.tenantId, e);
      await audit(c.tenantId, c.userId, 'COMPANY_EMISOR_UPDATED',
        { nit: e.mh_nit, env: e.mh_env, result, passwords_changed: !!(e.mh_password || e.firmador_password) });
      return { success: true, result };
    });

    r.post('/v2/company/cert', { preHandler: requirePerm('company:manage'), bodyLimit: 512 * 1024 }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({ cert_base64: z.string().min(1, 'Elige el archivo .crt') }), req.body);
      const em = await storedEmisor(c.tenantId);
      if (!em) throw new ValidationError('Guarda primero los datos fiscales: el certificado se asocia al NIT de la empresa');
      await saveCert(em.mh_nit, Buffer.from(b.cert_base64, 'base64'));
      await audit(c.tenantId, c.userId, 'COMPANY_CERT_UPLOADED', { nit: em.mh_nit });
      return { success: true };
    });

    r.post('/v2/company/test-mh', { preHandler: requirePerm('company:manage') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({
        mh_env: z.enum(['sandbox', 'production']).optional(),
        mh_nit: z.string().optional(),
        mh_password: z.string().optional(),
      }), req.body);
      const em = await storedEmisor(c.tenantId);
      const env = b.mh_env ?? em?.mh_env;
      const nit = (b.mh_nit ?? em?.mh_nit ?? '').replace(/\D/g, '');
      const password = b.mh_password || (em?.mh_password_enc ? decryptSecret(em.mh_password_enc) : '');
      if (!env || !/^\d{14}$/.test(nit) || !password) throw new ValidationError('Indica ambiente, NIT y clave API del MH');
      try {
        await testCredentials(env, nit, password);
        return { ok: true };
      } catch (e) {
        if (e instanceof DteError) return { ok: false, error: e.message };
        return { ok: false, error: 'No se pudo conectar con el MH. Intenta de nuevo en unos minutos.' };
      }
    });

    r.post('/v2/company/correlativos', { preHandler: requirePerm('company:manage') }, async (req) => {
      const c = ctx(req);
      const b = parse(z.object({
        items: z.array(z.object({ tipo_dte: z.enum(TIPOS), ultimo_consumido: z.number().int().min(0) })).min(1),
      }), req.body);
      const out = [];
      for (const it of b.items) {
        const rec = await correlativos.sembrar(c.tenantId, it.tipo_dte, it.ultimo_consumido, req.auth!.email);
        out.push({ tipo_dte: rec.tipo_dte, seeded: rec.seeded, ultimo_consumido: rec.ultimo_consumido });
      }
      await audit(c.tenantId, c.userId, 'COMPANY_CORRELATIVOS_SEEDED', b.items);
      return { items: out };
    });
  });
}
