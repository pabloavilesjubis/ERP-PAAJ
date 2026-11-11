-- =============================================================================
-- 019_emisor_claves_opcionales — Datos fiscales sin claves del MH.
--
-- Las claves (API del MH y del certificado) solo hacen falta para emitir desde
-- las rutas por empresa (/v2). Una empresa puede registrar sus datos fiscales
-- (NIT, NRC, DUI…) para validar los DTE que recibe sin cargarlas; PAAJ emite
-- con la configuración del servidor. Emitir sin claves da un error claro.
-- =============================================================================

ALTER TABLE public.tenant_emisor ALTER COLUMN mh_password_enc DROP NOT NULL;
ALTER TABLE public.tenant_emisor ALTER COLUMN firmador_password_enc DROP NOT NULL;
