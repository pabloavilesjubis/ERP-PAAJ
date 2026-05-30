-- ═══════════════════════════════════════════════════════════════════════════
-- Auth local (sin Supabase) — bcrypt + JWT firmado por el mismo backend
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Migrar users.id de UUID (Supabase legado) a TEXT genérico para soportar
-- IDs generados localmente (newUserId() → 'usr_<base64url>'). Postgres no
-- permite cambiar tipo si hay FK activas referenciando, así que:
--   1. drop FK
--   2. cambiar TIPO en ambas tablas
--   3. re-crear FK

ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_user_id_fkey;

ALTER TABLE audit_events
  ALTER COLUMN user_id TYPE TEXT
  USING user_id::TEXT;

ALTER TABLE users
  ALTER COLUMN id TYPE TEXT
  USING id::TEXT;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

-- Password hash (bcrypt). NULL para users creados antes (Supabase) que se
-- migran via reset.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Email único — necesario para login (vs el UUID que era único pero no
-- buscable por user).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(LOWER(email));

-- Tabla de tokens de password reset / email verification (TTL corto).
CREATE TABLE IF NOT EXISTS auth_tokens (
  token         TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('reset','verify')),
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);

INSERT INTO schema_migrations (version) VALUES ('004_local_auth') ON CONFLICT (version) DO NOTHING;

COMMIT;
