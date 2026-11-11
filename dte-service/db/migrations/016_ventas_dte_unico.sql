-- =============================================================================
-- 016_ventas_dte_unico — Una venta por DTE.
--
-- Las ventas de PAAJ emitidas por BEON / rutas originales entran a `ventas`
-- con la sincronización del ERP (lib/dte/sync.ts), que ahora corre sola.
-- Con dos pestañas abiertas podrían insertar el mismo DTE dos veces: este
-- índice lo impide. Solo aplica a códigos de generación reales (UUID); las
-- ventas manuales sin DTE no se tocan.
-- =============================================================================

CREATE UNIQUE INDEX ventas_dte_codigo_unico ON public.ventas (
  tenant_id,
  (upper(COALESCE(NULLIF(metadata->>'codigoGeneracion', ''), metadata->>'numeroDocumento')))
) WHERE upper(COALESCE(NULLIF(metadata->>'codigoGeneracion', ''), metadata->>'numeroDocumento'))
  ~ '^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$';
