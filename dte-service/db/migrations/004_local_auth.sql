-- ═══════════════════════════════════════════════════════════════════════════
-- Auth local (sin Supabase) — bcrypt + JWT firmado por el mismo backend
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Migrar users.id de UUID (Supabase) a TEXT genérico para soportar IDs
-- generados localmente. Mantenemos compat con UUIDs existentes.
ALTER TABLE users
  ALTER COLUMN id TYPE TEXT;

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

INSERT INTO schema_migrations (version) VALUES ('004_local_auth');

COMMIT;
