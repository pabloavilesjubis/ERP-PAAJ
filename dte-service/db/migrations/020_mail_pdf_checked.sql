-- =============================================================================
-- 020_mail_pdf_checked — PDF de los correos del buzón.
--
-- Al registrar un DTE del correo, su PDF adjunto queda como adjunto de la
-- compra. Los correos ya procesados antes de esto se completan una vez con
-- «Revisar meses»; esta marca evita volver a abrirlos en cada revisión.
-- =============================================================================

ALTER TABLE accounting.mail_messages ADD COLUMN pdf_checked BOOLEAN NOT NULL DEFAULT false;
