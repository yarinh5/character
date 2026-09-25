BEGIN;
SET LOCAL session_replication_role = replica;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM load_v3_2.fixture_runs
    WHERE run_id = 'load_v3_2_20260731_pilot_01'
      AND target_project_ref = 'micmgokyckvfpewxgrzf'
      AND status = 'activity_seeded'
  ) THEN
    RAISE EXCEPTION 'load_fixture_activity_guard_failed';
  END IF;
END;
$$;

INSERT INTO public.credit_wallets (
  user_id, balance, lifetime_earned, lifetime_spent, created_at, updated_at
)
SELECT
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', sequence),
  1000,
  1000,
  0,
  '2026-07-31T12:07:36Z'::timestamptz,
  '2026-07-31T12:07:36Z'::timestamptz
FROM generate_series(1, 1025) AS sequence;

INSERT INTO public.credit_transactions (
  id, user_id, amount, balance_after, type, reason, metadata, created_at
)
SELECT
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'credit_transaction', sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', ((sequence - 1) % 1000) + 1),
  0,
  1000,
  'migration_backfill',
  'Synthetic balanced load fixture',
  jsonb_build_object('load_run_id', 'load_v3_2_20260731_pilot_01', 'sequence', sequence),
  '2026-07-01T12:07:36Z'::timestamptz + make_interval(secs => sequence * 30)
FROM generate_series(1, 50000) AS sequence;

INSERT INTO public.media_tags (
  id, character_id, name, sort_order, is_default, created_at, updated_at
)
SELECT
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'media_tag', sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'character', ((sequence - 1) / 2) + 1),
  CASE WHEN sequence % 2 = 1 THEN 'Default' ELSE 'Gallery' END,
  (sequence - 1) % 2,
  sequence % 2 = 1,
  '2026-07-31T12:07:36Z'::timestamptz,
  '2026-07-31T12:07:36Z'::timestamptz
FROM generate_series(1, 200) AS sequence;

INSERT INTO public.character_media_assets (
  id, character_id, source_path, preview_path, status, ingest_status,
  display_name, content_type, byte_size, width, height, sha256,
  preview_generated_at, media_tag_id, metadata, created_at, updated_at
)
SELECT
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'media_asset', sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'character', ((sequence - 1) / 10) + 1),
  format('load_v3_2_20260731_pilot_01/characters/%s/assets/%s/source.webp', ((sequence - 1) / 10) + 1, sequence),
  format('load_v3_2_20260731_pilot_01/characters/%s/assets/%s/preview.webp', ((sequence - 1) / 10) + 1, sequence),
  'available',
  'ready',
  format('Load media %s', sequence),
  'image/webp',
  65536 + (sequence % 4096),
  768,
  768,
  md5('load_v3_2_20260731_pilot_01:asset:' || sequence::text),
  '2026-07-31T12:07:36Z'::timestamptz,
  load_v3_2.fixture_id(
    'load_v3_2_20260731_pilot_01', 'media_tag', ((((sequence - 1) / 10)) * 2) + 1
  ),
  jsonb_build_object('load_run_id', 'load_v3_2_20260731_pilot_01', 'sequence', sequence),
  '2026-07-31T12:07:36Z'::timestamptz,
  '2026-07-31T12:07:36Z'::timestamptz
FROM generate_series(1, 1000) AS sequence;

INSERT INTO public.sticker_collections (
  id, slug, name, is_active, sort_order, metadata, created_at, updated_at
)
SELECT
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'sticker_collection', sequence),
  format('load_v3_2_collection_%s', sequence),
  format('Load collection %s', sequence),
  true,
  sequence,
  jsonb_build_object('load_run_id', 'load_v3_2_20260731_pilot_01'),
  '2026-07-31T12:07:36Z'::timestamptz,
  '2026-07-31T12:07:36Z'::timestamptz
FROM generate_series(1, 5) AS sequence;

INSERT INTO public.stickers (
  id, collection_id, slug, name, object_path, content_type,
  width, height, byte_size, is_active, sort_order, metadata,
  ingest_status, processed_at, price_credits, created_at, updated_at
)
SELECT
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'sticker', sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'sticker_collection', ((sequence - 1) % 5) + 1),
  format('load_sticker_%s', sequence),
  format('Load sticker %s', sequence),
  format(
    'collections/%s/stickers/%s/render.webp',
    load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'sticker_collection', ((sequence - 1) % 5) + 1),
    load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'sticker', sequence)
  ),
  'image/webp',
  256,
  256,
  32768,
  true,
  sequence,
  jsonb_build_object('load_run_id', 'load_v3_2_20260731_pilot_01'),
  'ready',
  '2026-07-31T12:07:36Z'::timestamptz,
  CASE WHEN sequence % 2 = 0 THEN 2 ELSE 0 END,
  '2026-07-31T12:07:36Z'::timestamptz,
  '2026-07-31T12:07:36Z'::timestamptz
FROM generate_series(1, 25) AS sequence;

INSERT INTO public.character_media_reservations (
  id, media_asset_id, conversation_id, operator_id, reserved_by_user_id,
  previous_asset_status, intended_access_mode, state,
  created_at, expires_at, ended_at, ended_reason, metadata
)
SELECT
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'media_reservation', sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'media_asset', ((sequence - 1) % 1000) + 1),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'conversation', sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'operator', ((sequence - 1) % 25) + 1),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', 1000 + (((sequence - 1) % 25) + 1)),
  'available',
  'standard',
  'consumed',
  '2026-07-31T10:00:00Z'::timestamptz,
  '2026-07-31T10:10:00Z'::timestamptz,
  '2026-07-31T10:05:00Z'::timestamptz,
  'sent',
  jsonb_build_object('load_run_id', 'load_v3_2_20260731_pilot_01', 'sequence', sequence)
FROM generate_series(1, 10000) AS sequence;

INSERT INTO public.message_attachments (
  id, message_id, media_asset_id, reservation_id, kind, position,
  access_mode, view_mode, metadata, created_at
)
SELECT
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'message_attachment', sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'message', ((sequence - 1) * 20) + 18),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'media_asset', ((sequence - 1) % 1000) + 1),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'media_reservation', sequence),
  'image',
  0,
  'standard',
  'permanent',
  jsonb_build_object('load_run_id', 'load_v3_2_20260731_pilot_01', 'sequence', sequence),
  '2026-07-31T10:05:00Z'::timestamptz
FROM generate_series(1, 10000) AS sequence;

INSERT INTO public.operator_outreach_attempts (
  id, operator_id, client_id, character_id, conversation_id,
  idempotency_key, message_content, status, result, created_at
)
SELECT
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'outreach_attempt', sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'operator', ((sequence - 1) % 25) + 1),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', ((sequence - 1) % 1000) + 1),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'character', ((sequence - 1) % 100) + 1),
  load_v3_2.fixture_id(
    'load_v3_2_20260731_pilot_01',
    'conversation',
    (((sequence - 1) % 1000) + 1) + ((((sequence - 1) / 1000) % 5) * 1000)
  ),
  format('load_v3_2_20260731_pilot_01:outreach:%s', sequence),
  'Synthetic outreach message',
  'sent',
  jsonb_build_object('load_run_id', 'load_v3_2_20260731_pilot_01'),
  '2026-07-01T12:07:36Z'::timestamptz + make_interval(secs => sequence * 60)
FROM generate_series(1, 5000) AS sequence;

INSERT INTO public.operator_client_blocks (
  operator_id, client_id, created_by_operator_id, reason, created_at
)
SELECT
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'operator', ((sequence - 1) % 25) + 1),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'operator', ((sequence - 1) % 25) + 1),
  'load_v3_2_20260731_pilot_01 synthetic block',
  '2026-07-31T12:07:36Z'::timestamptz
FROM generate_series(1, 250) AS sequence;

INSERT INTO public.operator_client_reports (
  id, operator_id, client_id, conversation_id, reason, notes, source, created_at
)
SELECT
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'operator_client_report', sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'operator', ((sequence - 1) % 25) + 1),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'conversation', sequence),
  'Synthetic load report',
  'load_v3_2_20260731_pilot_01',
  'chat',
  '2026-07-31T12:07:36Z'::timestamptz
FROM generate_series(1, 100) AS sequence;

INSERT INTO load_v3_2.fixture_manifest (run_id, entity_type, ids, composite_keys, row_count)
SELECT
  'load_v3_2_20260731_pilot_01',
  entity_type,
  ids,
  composite_keys,
  CASE WHEN cardinality(ids) > 0 THEN cardinality(ids) ELSE jsonb_array_length(composite_keys) END
FROM (
  VALUES
    ('credit_wallets', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', s) FROM generate_series(1, 1025) s), '[]'::jsonb),
    ('credit_transactions', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'credit_transaction', s) FROM generate_series(1, 50000) s), '[]'::jsonb),
    ('media_tags', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'media_tag', s) FROM generate_series(1, 200) s), '[]'::jsonb),
    ('media_assets', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'media_asset', s) FROM generate_series(1, 1000) s), '[]'::jsonb),
    ('sticker_collections', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'sticker_collection', s) FROM generate_series(1, 5) s), '[]'::jsonb),
    ('stickers', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'sticker', s) FROM generate_series(1, 25) s), '[]'::jsonb),
    ('media_reservations', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'media_reservation', s) FROM generate_series(1, 10000) s), '[]'::jsonb),
    ('message_attachments', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'message_attachment', s) FROM generate_series(1, 10000) s), '[]'::jsonb),
    ('outreach_attempts', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'outreach_attempt', s) FROM generate_series(1, 5000) s), '[]'::jsonb),
    ('operator_client_blocks', '{}'::uuid[], (
      SELECT jsonb_agg(jsonb_build_object(
        'operator_id', load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'operator', ((s - 1) % 25) + 1),
        'client_id', load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', s)
      )) FROM generate_series(1, 250) s
    )),
    ('operator_client_reports', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'operator_client_report', s) FROM generate_series(1, 100) s), '[]'::jsonb)
) AS manifest(entity_type, ids, composite_keys)
ON CONFLICT (run_id, entity_type) DO UPDATE
SET ids = EXCLUDED.ids,
    composite_keys = EXCLUDED.composite_keys,
    row_count = EXCLUDED.row_count;

UPDATE load_v3_2.fixture_runs
SET status = 'inventory_seeded'
WHERE run_id = 'load_v3_2_20260731_pilot_01';

COMMIT;
