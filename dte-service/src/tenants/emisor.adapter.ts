import type { Config } from '../config.js';
import type { TenantEmisorFull } from './tenant.types.js';

/**
 * Convierte un TenantEmisorFull (data del Postgres por tenant) en un objeto
 * shape-compatible con el `Config` que los builders/firmador/submit esperan.
 *
 * Mezcla:
 *   - Campos GLOBALES (vienen de cfg): NODE_ENV, FIRMADOR_URL, STORAGE_DIR,
 *     LOG_LEVEL, PORT, BEON_*, SMTP_*, PUBLIC_BASE_URL
 *   - Campos PER-TENANT (vienen del DB): MH_ENV, MH_NIT, MH_PASSWORD,
 *     FIRMADOR_NIT, FIRMADOR_PASSWORD, EMISOR_*, PUNTO_VENTA_*
 *
 * El resultado es un Config que se le puede pasar tal cual a buildFcf,
 * firmar(), submitDte(), etc. — todo el código existente sigue funcionando
 * sin tocar.
 */
export function configForTenant(globalCfg: Config, emisor: TenantEmisorFull): Config {
  return {
    ...globalCfg,
    MH_ENV: emisor.mh_env,
    MH_NIT: emisor.mh_nit,
    MH_PASSWORD: emisor.mh_password,
    FIRMADOR_NIT: emisor.mh_nit,                  // típicamente el mismo NIT
    FIRMADOR_PASSWORD: emisor.firmador_password,
    EMISOR_NRC: emisor.emisor_nrc,
    EMISOR_NOMBRE: emisor.emisor_nombre,
    EMISOR_COD_ACTIVIDAD: emisor.emisor_cod_actividad,
    EMISOR_DESC_ACTIVIDAD: emisor.emisor_desc_actividad,
    EMISOR_NOMBRE_COMERCIAL: undefined,           // viene de tenants.nombre_comercial — futuro
    EMISOR_TIPO_ESTABLECIMIENTO: emisor.emisor_tipo_establecimiento,
    EMISOR_DEPARTAMENTO: emisor.emisor_departamento,
    EMISOR_MUNICIPIO: emisor.emisor_municipio,
    EMISOR_COMPLEMENTO: emisor.emisor_complemento,
    EMISOR_TELEFONO: emisor.emisor_telefono ?? undefined,
    EMISOR_EMAIL: emisor.emisor_email,
    PUNTO_VENTA_ESTABLECIMIENTO: emisor.punto_venta_establecimiento,
    PUNTO_VENTA_PUNTO: emisor.punto_venta_punto,
    EMISOR_COD_ESTABLE_MH: emisor.emisor_cod_estable_mh ?? undefined,
    EMISOR_COD_PUNTO_VENTA_MH: emisor.emisor_cod_punto_venta_mh ?? undefined,
  };
}
