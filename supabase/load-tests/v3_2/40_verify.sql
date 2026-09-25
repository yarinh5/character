BEGIN;

DO $$
DECLARE
  _run_id CONSTANT TEXT := 'load_v3_2_20260731_pilot_01';
  _count BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM load_v3_2.fixture_runs
    WHERE run_id = _run_id
      AND target_project_ref = 'micmgokyckvfpewxgrzf'
      AND status = 'inventory_seeded'
  ) THEN
    RAISE EXCEPTION 'load_fixture_inventory_guard_failed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM load_v3_2.fixture_runs
    WHERE run_id = _run_id
      AND delete_by IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'fixture_run_delete_by_must_be_null';
  END IF;

  SELECT count(*) INTO _count
  FROM auth.users
  WHERE email LIKE 'load_v3_2_20260731_pilot_01_%@example.invalid';
  IF _count <> 1025 THEN RAISE EXCEPTION 'fixture_user_count_mismatch: %', _count; END IF;

  SELECT count(*) INTO _count FROM public.operators
  WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = _run_id AND entity_type = 'operators');
  IF _count <> 25 THEN RAISE EXCEPTION 'fixture_operator_count_mismatch: %', _count; END IF;

  SELECT count(*) INTO _count FROM public.characters
  WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = _run_id AND entity_type = 'characters');
  IF _count <> 100 THEN RAISE EXCEPTION 'fixture_character_count_mismatch: %', _count; END IF;

  SELECT count(*) INTO _count FROM public.conversations
  WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = _run_id AND entity_type = 'conversations');
  IF _count <> 10000 THEN RAISE EXCEPTION 'fixture_conversation_count_mismatch: %', _count; END IF;

  SELECT count(*) INTO _count FROM public.messages
  WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = _run_id AND entity_type = 'messages');
  IF _count <> 200000 THEN RAISE EXCEPTION 'fixture_message_count_mismatch: %', _count; END IF;

  SELECT count(*) INTO _count FROM public.conversation_work_items
  WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = _run_id AND entity_type = 'conversation_work_items')
    AND status = 'new';
  IF _count <> 250 THEN RAISE EXCEPTION 'fixture_new_count_mismatch: %', _count; END IF;

  SELECT count(*) INTO _count FROM public.conversation_handling_cycles
  WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = _run_id AND entity_type = 'conversation_handling_cycles')
    AND ended_at IS NULL;
  IF _count <> 75 THEN RAISE EXCEPTION 'fixture_cycle_count_mismatch: %', _count; END IF;

  SELECT count(*) INTO _count FROM public.notifications
  WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = _run_id AND entity_type = 'notifications');
  IF _count <> 25000 THEN RAISE EXCEPTION 'fixture_notification_count_mismatch: %', _count; END IF;

  SELECT count(*) INTO _count FROM public.analytics_events
  WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = _run_id AND entity_type = 'analytics_events');
  IF _count <> 100000 THEN RAISE EXCEPTION 'fixture_analytics_count_mismatch: %', _count; END IF;

  SELECT count(*) INTO _count FROM public.character_media_assets
  WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = _run_id AND entity_type = 'media_assets');
  IF _count <> 1000 THEN RAISE EXCEPTION 'fixture_media_asset_count_mismatch: %', _count; END IF;

  SELECT count(*) INTO _count FROM public.message_attachments
  WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = _run_id AND entity_type = 'message_attachments');
  IF _count <> 10000 THEN RAISE EXCEPTION 'fixture_attachment_count_mismatch: %', _count; END IF;

  SELECT count(*) INTO _count FROM public.credit_transactions
  WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = _run_id AND entity_type = 'credit_transactions')
    AND amount = 0
    AND type = 'migration_backfill';
  IF _count <> 50000 THEN RAISE EXCEPTION 'fixture_ledger_count_mismatch: %', _count; END IF;

  IF EXISTS (
    SELECT 1 FROM public.credit_transactions
    WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = _run_id AND entity_type = 'credit_transactions')
      AND type IN (
        'message_spend', 'message_payout', 'operator_message_payout',
        'sticker_spend', 'sticker_payout',
        'locked_image_unlock', 'paid_image_open_spend', 'paid_image_open_payout'
      )
  ) THEN
    RAISE EXCEPTION 'fixture_financial_transaction_detected';
  END IF;

  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE email LIKE 'load_v3_2_20260731_pilot_01_%'
      AND email NOT LIKE '%@example.invalid'
  ) THEN
    RAISE EXCEPTION 'fixture_non_synthetic_email_detected';
  END IF;

  IF EXISTS (SELECT 1 FROM storage.objects WHERE name LIKE 'load_v3_2_20260731_pilot_01/%') THEN
    RAISE EXCEPTION 'fixture_storage_object_detected';
  END IF;

  IF to_regclass('public.gifts') IS NOT NULL
    OR EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'gifts_enabled') THEN
    RAISE EXCEPTION 'fixture_gift_contract_regression';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM load_v3_2.fixture_manifest
    WHERE run_id = _run_id
      AND row_count <> CASE
        WHEN cardinality(ids) > 0 THEN cardinality(ids)
        ELSE jsonb_array_length(composite_keys)
      END
  ) THEN
    RAISE EXCEPTION 'fixture_manifest_count_mismatch';
  END IF;

  UPDATE load_v3_2.fixture_runs
  SET status = 'ready'
  WHERE run_id = _run_id;
END;
$$;

COMMIT;

SELECT
  run_id,
  tier,
  status,
  created_at,
  delete_by,
  expected_counts,
  (SELECT count(*) FROM load_v3_2.fixture_manifest manifest WHERE manifest.run_id = run.run_id) AS manifest_entity_types,
  pg_database_size(current_database()) AS database_size_bytes,
  (SELECT count(*) FROM storage.objects WHERE name LIKE 'load_v3_2_20260731_pilot_01/%') AS storage_objects,
  (SELECT count(*) FROM storage.objects WHERE bucket_id = 'gift-media') AS gift_bucket_objects
FROM load_v3_2.fixture_runs run
WHERE run_id = 'load_v3_2_20260731_pilot_01';
