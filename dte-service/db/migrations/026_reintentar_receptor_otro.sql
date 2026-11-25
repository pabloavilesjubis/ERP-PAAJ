-- =============================================================================
-- 026_reintentar_receptor_otro — El receptor puede venir con tipo de documento 37
-- («otro», p. ej. Almacenes Siman y Credisiman) y el DUI o NIT del titular: el
-- lector ahora lo reconoce por la cantidad de dígitos. Los correos con DTEs
-- rechazados vuelven a quedar pendientes para que «Revisar meses» los registre.
-- =============================================================================

UPDATE accounting.mail_messages SET status = 'error', pdf_checked = false
 WHERE status = 'procesado' AND dte_count > 0 AND detail ~ ': rechazado';
