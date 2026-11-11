-- =============================================================================
-- 018_mailboxes_multi — Varias cuentas de correo por empresa.
--
-- Antes: un buzón por empresa (PK tenant_id). Ahora cada cuenta tiene su id;
-- los correos ya leídos se registran por cuenta (dos cuentas pueden tener una
-- carpeta INBOX con los mismos UID).
-- =============================================================================

ALTER TABLE accounting.mailboxes ADD COLUMN id BIGSERIAL;
ALTER TABLE accounting.mailboxes ADD COLUMN label TEXT;
ALTER TABLE accounting.mailboxes DROP CONSTRAINT mailboxes_pkey;
ALTER TABLE accounting.mailboxes ADD PRIMARY KEY (id);
CREATE INDEX mailboxes_tenant ON accounting.mailboxes (tenant_id);
CREATE UNIQUE INDEX mailboxes_cuenta_unica ON accounting.mailboxes (tenant_id, lower(host), lower(username), folder);

ALTER TABLE accounting.mail_messages ADD COLUMN mailbox_id BIGINT REFERENCES accounting.mailboxes(id) ON DELETE CASCADE;
UPDATE accounting.mail_messages m SET mailbox_id = b.id FROM accounting.mailboxes b WHERE b.tenant_id = m.tenant_id;
DELETE FROM accounting.mail_messages WHERE mailbox_id IS NULL;
ALTER TABLE accounting.mail_messages ALTER COLUMN mailbox_id SET NOT NULL;
ALTER TABLE accounting.mail_messages DROP CONSTRAINT mail_messages_pkey;
ALTER TABLE accounting.mail_messages ADD PRIMARY KEY (mailbox_id, folder, uid_validity, uid);
