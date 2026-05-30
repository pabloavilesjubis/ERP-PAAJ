-- ═══════════════════════════════════════════════════════════════════════════
-- Migración 002 — siembra PAAJ como tenant_id=1
-- ═══════════════════════════════════════════════════════════════════════════
-- Preserva el sistema actual como el primer tenant del SaaS PIPELINE ERP.
-- Los datos sensibles (mh_password, firmador_password) se sobreescriben con
-- placeholders — el deploy real corre `src/db/migrate-paaj.ts` que lee el .env
-- existente y los inserta encriptados.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

INSERT INTO tenants (id, slug, nombre_legal, nombre_comercial, status, brand_config)
VALUES (
  1,
  'paaj',
  'PABLO ALBERTO AVILES JUBIS',
  'BEON NUTRITION WELLNESS',
  'active',
  '{"color_primary": "#10b981", "color_accent": "#059669"}'::JSONB
)
ON CONFLICT (id) DO NOTHING;

-- Reserva el slug 'paaj' aunque el id auto-incremente — sequence resync.
SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), 1));

-- Sembrar correlativo 01 al estado ACTUAL del filesystem (ultimo_consumido=206)
-- IMPORTANTE: el script de migración real (migrate-paaj.ts) actualiza este
-- valor leyendo /app/data/correlativos/01.json en tiempo de deploy para
-- garantizar consistencia. El INSERT acá es por si arrancás desde cero.
INSERT INTO tenant_correlativos (tenant_id, tipo_dte, seeded, seeded_at, seeded_by, ultimo_consumido)
VALUES
  (1, '01', TRUE, NOW(), 'migration-002', 0),
  (1, '03', FALSE, NULL, NULL, 0),
  (1, '05', FALSE, NULL, NULL, 0),
  (1, '14', FALSE, NULL, NULL, 0)
ON CONFLICT (tenant_id, tipo_dte) DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('002_seed_paaj_tenant') ON CONFLICT (version) DO NOTHING;

COMMIT;
