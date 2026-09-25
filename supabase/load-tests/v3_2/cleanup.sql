BEGIN;
SET LOCAL session_replication_role = replica;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM load_v3_2.fixture_runs
    WHERE run_id = 'load_v3_2_20260731_pilot_01'
      AND target_project_ref = 'micmgokyckvfpewxgrzf'
  ) THEN
    RAISE EXCEPTION 'load_fixture_cleanup_guard_failed';
  END IF;
END;
$$;

DELETE FROM public.operator_client_reports
WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'operator_client_reports');

DELETE FROM public.operator_client_blocks
WHERE reason = 'load_v3_2_20260731_pilot_01 synthetic block';

DELETE FROM public.operator_outreach_attempts
WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'outreach_attempts');

DELETE FROM public.message_attachments
WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'message_attachments');

DELETE FROM public.character_media_reservations
WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'media_reservations');

DELETE FROM public.stickers
WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'stickers');

DELETE FROM public.sticker_collections
WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'sticker_collections');

DELETE FROM public.character_media_assets
WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'media_assets');

DELETE FROM public.media_tags
WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'media_tags');

DELETE FROM public.analytics_events
WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'analytics_events');

DELETE FROM public.notifications
WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'notifications');

DELETE FROM public.conversation_handling_cycles
WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'conversation_handling_cycles');

DELETE FROM public.conversation_work_items
WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'conversation_work_items');

DELETE FROM public.messages
WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'messages');

DELETE FROM public.conversations
WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'conversations');

DELETE FROM public.credit_transactions
WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'credit_transactions');

DELETE FROM public.credit_wallets
WHERE user_id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'credit_wallets');

DELETE FROM public.character_operator_assignments
WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'character_operator_assignments');

DELETE FROM public.client_profiles
WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'client_profiles');

DELETE FROM public.operators
WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'operators');

DELETE FROM public.characters
WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'characters');

DELETE FROM public.user_roles
WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'user_roles');

DELETE FROM public.profiles
WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'profiles');

DELETE FROM auth.users
WHERE id IN (SELECT unnest(ids) FROM load_v3_2.fixture_manifest WHERE run_id = 'load_v3_2_20260731_pilot_01' AND entity_type = 'auth_users');

DROP SCHEMA load_v3_2 CASCADE;

COMMIT;

SELECT
  (SELECT count(*) FROM auth.users WHERE email LIKE 'load_v3_2_20260731_pilot_01_%@example.invalid') AS remaining_users,
  (
    SELECT count(*)
    FROM public.conversations
    WHERE id = md5('load_v3_2_20260731_pilot_01:conversation:1')::uuid
  ) AS remaining_probe;
