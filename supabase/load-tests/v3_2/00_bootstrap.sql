BEGIN;

CREATE SCHEMA IF NOT EXISTS load_v3_2;
REVOKE ALL ON SCHEMA load_v3_2 FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS load_v3_2.fixture_runs (
  run_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL CHECK (tier IN ('pilot', 'expected', 'stress')),
  source_project_ref TEXT NOT NULL,
  target_project_ref TEXT NOT NULL,
  cleanup_owner TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  delete_by TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'preparing',
  expected_counts JSONB NOT NULL,
  notes JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS load_v3_2.fixture_manifest (
  run_id TEXT NOT NULL REFERENCES load_v3_2.fixture_runs(run_id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
  composite_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, entity_type)
);

CREATE OR REPLACE FUNCTION load_v3_2.fixture_id(
  _run_id TEXT,
  _entity_type TEXT,
  _sequence BIGINT
)
RETURNS UUID
LANGUAGE SQL
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT md5(_run_id || ':' || _entity_type || ':' || _sequence::text)::uuid;
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA load_v3_2 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA load_v3_2 FROM PUBLIC, anon, authenticated;

INSERT INTO load_v3_2.fixture_runs (
  run_id,
  namespace,
  tier,
  source_project_ref,
  target_project_ref,
  cleanup_owner,
  created_at,
  delete_by,
  expected_counts,
  notes
)
VALUES (
  'load_v3_2_20260731_pilot_01',
  'load_v3_2_20260731_pilot_01',
  'pilot',
  'qmgkmsarzfjnqltljkjl',
  'micmgokyckvfpewxgrzf',
  'Yarin',
  '2026-07-31T12:07:36Z'::timestamptz,
  '2026-08-02T12:07:36Z'::timestamptz,
  '{
    "clients": 1000,
    "operators": 25,
    "characters": 100,
    "character_operator_assignments": 500,
    "conversations": 10000,
    "messages": 200000,
    "new_work_items": 250,
    "active_handling_cycles": 75,
    "notifications": 25000,
    "analytics_events": 100000,
    "media_tags": 200,
    "media_assets": 1000,
    "media_reservations": 10000,
    "message_attachments": 10000,
    "sticker_collections": 5,
    "stickers": 25,
    "wallets": 1025,
    "credit_transactions": 50000,
    "outreach_attempts": 5000,
    "operator_client_blocks": 250,
    "operator_client_reports": 100
  }'::jsonb,
  jsonb_build_object(
    'storage_objects', 0,
    'financial_rpc_calls', 0,
    'gift_media_bucket_exception', 'empty historical bucket; no product contract or objects'
  )
)
ON CONFLICT (run_id) DO NOTHING;

COMMIT;
