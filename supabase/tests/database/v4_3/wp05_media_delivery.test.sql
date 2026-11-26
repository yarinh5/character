BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT plan(38);

SELECT has_table('public', 'character_media_asset_characters', 'WP05 character assignments exist');
SELECT has_table('public', 'character_media_asset_tags', 'WP05 tag assignments exist');
SELECT has_table('public', 'character_media_deliveries', 'WP05 durable delivery ledger exists');
SELECT has_column('public', 'character_media_assets', 'is_global', 'Assets support the general catalog');
SELECT has_column('public', 'character_media_reservations', 'client_id', 'Reservations bind the derived client');
SELECT col_not_null('public', 'character_media_reservations', 'client_id', 'Reservation client binding is required');
SELECT has_index('public', 'character_media_reservations', 'character_media_reservations_one_active_asset_client_idx', 'Active reservations are unique per asset and client');
SELECT has_index('public', 'character_media_deliveries', 'character_media_deliveries_media_asset_id_client_id_key', 'Deliveries are unique per asset and client');

SET LOCAL ROLE anon;
SELECT ok(NOT has_table_privilege(current_user, 'public.character_media_deliveries', 'SELECT'), 'Anonymous callers cannot read delivery history');
SELECT ok(
  NOT has_function_privilege(current_user, 'public.set_admin_media_asset_assignments(uuid,uuid[],uuid[],boolean)'::regprocedure, 'EXECUTE'),
  'Anonymous callers cannot change catalog assignments'
);
RESET ROLE;
SELECT ok(
  EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'character_media_deliveries' AND policyname = 'Admins view media deliveries'),
  'Delivery history has an explicit admin policy'
);
SELECT is(
  (
    SELECT count(*)
    FROM public.message_attachments attachment
    WHERE attachment.media_asset_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.character_media_deliveries delivery
        WHERE delivery.message_attachment_id = attachment.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM private.character_media_backfill_conflicts conflict
        WHERE conflict.message_attachment_id = attachment.id
      )
  ),
  0::bigint,
  'Every historical media attachment is represented by a delivery or an explicit backfill conflict'
);
SELECT is(
  (
    SELECT count(*)
    FROM (
      SELECT media_asset_id, client_id
      FROM public.character_media_deliveries
      GROUP BY media_asset_id, client_id
      HAVING count(*) > 1
    ) duplicate
  ),
  0::bigint,
  'Backfilled delivery history contains no duplicate asset and client ledger rows'
);
SELECT is(
  (
    SELECT count(*)
    FROM public.character_media_reservations reservation
    JOIN public.conversations conversation ON conversation.id = reservation.conversation_id
    WHERE reservation.client_id IS DISTINCT FROM conversation.client_id
  ),
  0::bigint,
  'Backfilled reservations are bound to the client derived from their conversation'
);

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('00000000-0000-4000-8000-000000050001', 'authenticated', 'authenticated', 'wp05-admin@example.test', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000050002', 'authenticated', 'authenticated', 'wp05-operator@example.test', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000050003', 'authenticated', 'authenticated', 'wp05-client-a@example.test', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000050004', 'authenticated', 'authenticated', 'wp05-client-b@example.test', 'x', now(), '{}', '{}', now(), now());
INSERT INTO public.user_roles (user_id, role) VALUES ('00000000-0000-4000-8000-000000050001', 'admin');
INSERT INTO public.operators (id, user_id, full_name) VALUES ('00000000-0000-4000-8000-000000050101', '00000000-0000-4000-8000-000000050002', 'WP05 Operator');
INSERT INTO public.characters (id, name) VALUES
  ('00000000-0000-4000-8000-000000050201', 'WP05 Character A'),
  ('00000000-0000-4000-8000-000000050202', 'WP05 Character B');
INSERT INTO public.media_tags (id, character_id, name, is_default) VALUES
  ('00000000-0000-4000-8000-000000050301', '00000000-0000-4000-8000-000000050201', 'WP05 Tag A', true),
  ('00000000-0000-4000-8000-000000050302', '00000000-0000-4000-8000-000000050202', 'WP05 Tag B', false);
INSERT INTO public.character_media_assets (
  id, character_id, media_tag_id, source_path, preview_path, content_type,
  status, ingest_status, display_name, preview_generated_at
) VALUES
  ('00000000-0000-4000-8000-000000050401', '00000000-0000-4000-8000-000000050201', '00000000-0000-4000-8000-000000050301', 'assets/wp05-a/source.webp', 'assets/wp05-a/preview.webp', 'image/webp', 'available', 'ready', 'WP05 Asset A', now()),
  ('00000000-0000-4000-8000-000000050402', '00000000-0000-4000-8000-000000050201', '00000000-0000-4000-8000-000000050301', 'assets/wp05-b/source.webp', 'assets/wp05-b/preview.webp', 'image/webp', 'available', 'ready', 'WP05 Asset B', now());
INSERT INTO public.character_media_asset_characters (media_asset_id, character_id) VALUES
  ('00000000-0000-4000-8000-000000050401', '00000000-0000-4000-8000-000000050201'),
  ('00000000-0000-4000-8000-000000050402', '00000000-0000-4000-8000-000000050201');
INSERT INTO public.character_media_asset_tags (media_asset_id, media_tag_id) VALUES
  ('00000000-0000-4000-8000-000000050401', '00000000-0000-4000-8000-000000050301'),
  ('00000000-0000-4000-8000-000000050402', '00000000-0000-4000-8000-000000050301');
INSERT INTO public.conversations (id, client_id, character_id, assigned_operator_id) VALUES
  ('00000000-0000-4000-8000-000000050501', '00000000-0000-4000-8000-000000050003', '00000000-0000-4000-8000-000000050201', '00000000-0000-4000-8000-000000050101'),
  ('00000000-0000-4000-8000-000000050502', '00000000-0000-4000-8000-000000050004', '00000000-0000-4000-8000-000000050201', '00000000-0000-4000-8000-000000050101');

INSERT INTO public.character_media_deliveries (media_asset_id, client_id)
VALUES ('00000000-0000-4000-8000-000000050401', '00000000-0000-4000-8000-000000050003');
SELECT lives_ok(
  $$INSERT INTO public.character_media_deliveries (media_asset_id, client_id)
    VALUES ('00000000-0000-4000-8000-000000050401', '00000000-0000-4000-8000-000000050004')$$,
  'The same asset can be delivered to a second client'
);
SELECT is((SELECT count(*) FROM public.character_media_deliveries WHERE media_asset_id = '00000000-0000-4000-8000-000000050401'), 2::bigint, 'Both client delivery rows remain durable');
SELECT throws_like(
  $$INSERT INTO public.character_media_deliveries (media_asset_id, client_id)
    VALUES ('00000000-0000-4000-8000-000000050401', '00000000-0000-4000-8000-000000050003')$$,
  '%character_media_deliveries_media_asset_id_client_id_key%',
  'A duplicate asset and client delivery is rejected by the database'
);

INSERT INTO public.character_media_reservations (
  media_asset_id, conversation_id, client_id, operator_id, reserved_by_user_id,
  previous_asset_status, expires_at
) VALUES (
  '00000000-0000-4000-8000-000000050402', '00000000-0000-4000-8000-000000050501',
  '00000000-0000-4000-8000-000000050003', '00000000-0000-4000-8000-000000050101',
  '00000000-0000-4000-8000-000000050002', 'available', clock_timestamp() + interval '5 minutes'
);
SELECT lives_ok(
  $$INSERT INTO public.character_media_reservations (
      media_asset_id, conversation_id, client_id, operator_id, reserved_by_user_id,
      previous_asset_status, expires_at
    ) VALUES (
      '00000000-0000-4000-8000-000000050402', '00000000-0000-4000-8000-000000050502',
      '00000000-0000-4000-8000-000000050004', '00000000-0000-4000-8000-000000050101',
      '00000000-0000-4000-8000-000000050002', 'available', clock_timestamp() + interval '5 minutes'
    )$$,
  'The same asset can be reserved independently for a second client'
);
SELECT throws_like(
  $$INSERT INTO public.character_media_reservations (
      media_asset_id, conversation_id, client_id, operator_id, reserved_by_user_id,
      previous_asset_status, expires_at
    ) VALUES (
      '00000000-0000-4000-8000-000000050402', '00000000-0000-4000-8000-000000050501',
      '00000000-0000-4000-8000-000000050003', '00000000-0000-4000-8000-000000050101',
      '00000000-0000-4000-8000-000000050002', 'available', clock_timestamp() + interval '5 minutes'
    )$$,
  '%character_media_reservations_one_active_asset_client_idx%',
  'A second active reservation for the same asset and client is rejected'
);

-- Canonical preview uses the reservation and its current authority, not the global asset status.
INSERT INTO public.user_roles (user_id, role)
VALUES ('00000000-0000-4000-8000-000000050002', 'operator');
INSERT INTO public.character_operator_assignments (character_id, operator_id)
VALUES ('00000000-0000-4000-8000-000000050201', '00000000-0000-4000-8000-000000050101');
INSERT INTO public.messages (conversation_id, sender_type, sender_id, content)
VALUES ('00000000-0000-4000-8000-000000050501', 'client',
  '00000000-0000-4000-8000-000000050003', 'Synthetic preview request');
UPDATE public.conversation_work_items SET status = 'assigned',
  responsible_operator_id = '00000000-0000-4000-8000-000000050101', assigned_at = clock_timestamp()
WHERE conversation_id = '00000000-0000-4000-8000-000000050501';
INSERT INTO public.conversation_handling_cycles (conversation_id, work_item_id, operator_id)
SELECT conversation_id, id, responsible_operator_id FROM public.conversation_work_items
WHERE conversation_id = '00000000-0000-4000-8000-000000050501';
UPDATE public.character_media_reservations r SET handling_cycle_id = cycle.id
FROM public.conversation_handling_cycles cycle
WHERE r.conversation_id = cycle.conversation_id
  AND r.conversation_id = '00000000-0000-4000-8000-000000050501';
SELECT set_config('wp05.preview_reservation', id::text, true)
FROM public.character_media_reservations
WHERE conversation_id = '00000000-0000-4000-8000-000000050501';

SELECT is(public.resolve_character_media_preview_path_for_server(
  '00000000-0000-4000-8000-000000050002', 'reserved_preview', current_setting('wp05.preview_reservation')::uuid),
  'assets/wp05-b/preview.webp', 'Reservation owner can preview an available canonical asset');
SELECT is(public.resolve_character_media_preview_path_for_server(
  '00000000-0000-4000-8000-000000050001', 'reserved_preview', current_setting('wp05.preview_reservation')::uuid),
  NULL::text, 'General admin read access does not grant another actor private reservation preview');
SELECT is(public.resolve_character_media_preview_path_for_server(
  '00000000-0000-4000-8000-000000050003', 'reserved_preview', current_setting('wp05.preview_reservation')::uuid),
  NULL::text, 'Conversation client cannot read the private reservation preview');
DELETE FROM public.character_media_asset_characters
WHERE media_asset_id = '00000000-0000-4000-8000-000000050402'
  AND character_id = '00000000-0000-4000-8000-000000050201';
SELECT is(public.resolve_character_media_preview_path_for_server(
  '00000000-0000-4000-8000-000000050002', 'reserved_preview', current_setting('wp05.preview_reservation')::uuid),
  NULL::text, 'A reservation cannot preview media removed from the character catalog');
INSERT INTO public.character_media_asset_characters (media_asset_id, character_id)
VALUES ('00000000-0000-4000-8000-000000050402', '00000000-0000-4000-8000-000000050201');
UPDATE public.conversations SET assigned_operator_id = NULL
WHERE id = '00000000-0000-4000-8000-000000050501';
SELECT is(public.resolve_character_media_preview_path_for_server(
  '00000000-0000-4000-8000-000000050002', 'reserved_preview', current_setting('wp05.preview_reservation')::uuid),
  NULL::text, 'A stale reservation cannot preview after responsibility is cleared');
UPDATE public.conversations SET assigned_operator_id = '00000000-0000-4000-8000-000000050101',
  last_business_message_at = clock_timestamp() - interval '181 seconds',
  inactivity_expires_at = clock_timestamp() - interval '1 second'
WHERE id = '00000000-0000-4000-8000-000000050501';
SELECT is(public.resolve_character_media_preview_path_for_server(
  '00000000-0000-4000-8000-000000050002', 'reserved_preview', current_setting('wp05.preview_reservation')::uuid),
  NULL::text, 'An expired handling deadline cannot preview before the cycle scanner runs');
UPDATE public.conversations SET inactivity_expires_at = clock_timestamp() + interval '180 seconds'
WHERE id = '00000000-0000-4000-8000-000000050501';
UPDATE public.character_media_assets SET status = 'disabled', disabled_at = clock_timestamp(),
  status_before_disabled = status
WHERE id = '00000000-0000-4000-8000-000000050402';
SELECT is(public.resolve_character_media_preview_path_for_server(
  '00000000-0000-4000-8000-000000050002', 'reserved_preview', current_setting('wp05.preview_reservation')::uuid),
  NULL::text, 'A reservation cannot preview a disabled asset');
UPDATE public.character_media_assets SET status = status_before_disabled, disabled_at = NULL,
  status_before_disabled = NULL
WHERE id = '00000000-0000-4000-8000-000000050402';
UPDATE public.conversation_handling_cycles SET ended_at = clock_timestamp(), end_reason = 'closed'
WHERE conversation_id = '00000000-0000-4000-8000-000000050501';
SELECT is(public.resolve_character_media_preview_path_for_server(
  '00000000-0000-4000-8000-000000050002', 'reserved_preview', current_setting('wp05.preview_reservation')::uuid),
  NULL::text, 'An ended cycle cannot issue a preview');
SELECT is(public.resolve_character_media_preview_path_for_server(
  '00000000-0000-4000-8000-000000050002', 'reserved_preview', gen_random_uuid()),
  NULL::text, 'A missing reservation cannot issue a preview');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000050001';
SELECT lives_ok(
  $$SELECT public.set_admin_media_asset_assignments(
    '00000000-0000-4000-8000-000000050401',
    ARRAY['00000000-0000-4000-8000-000000050202'::uuid, '00000000-0000-4000-8000-000000050202'::uuid],
    ARRAY['00000000-0000-4000-8000-000000050302'::uuid, '00000000-0000-4000-8000-000000050302'::uuid],
    false
  )$$,
  'Assignment RPC normalizes duplicate input'
);
RESET ROLE;
SELECT is((SELECT count(*) FROM public.character_media_asset_characters WHERE media_asset_id = '00000000-0000-4000-8000-000000050401'), 1::bigint, 'Canonical character assignments contain one normalized row');
SELECT is((SELECT count(*) FROM public.character_media_asset_tags WHERE media_asset_id = '00000000-0000-4000-8000-000000050401'), 1::bigint, 'Canonical tag assignments contain one normalized row');
SELECT results_eq(
  $$SELECT character_id, media_tag_id FROM public.character_media_assets WHERE id = '00000000-0000-4000-8000-000000050401'$$,
  $$VALUES ('00000000-0000-4000-8000-000000050202'::uuid, '00000000-0000-4000-8000-000000050302'::uuid)$$,
  'Legacy primary fields remain a coherent compatibility pair'
);

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000050001';
SELECT lives_ok(
  $$SELECT public.set_admin_media_asset_assignments('00000000-0000-4000-8000-000000050402', '{}'::uuid[], '{}'::uuid[], true)$$,
  'A general-catalog asset may have empty canonical assignments'
);
SELECT set_config(
  'wp05.tag_count',
  (SELECT asset_count::text FROM public.get_admin_media_tags('00000000-0000-4000-8000-000000050202') WHERE id = '00000000-0000-4000-8000-000000050302'),
  true
);
RESET ROLE;
SELECT is(
  (SELECT count(*) FROM public.character_media_asset_characters WHERE media_asset_id = '00000000-0000-4000-8000-000000050402')
  + (SELECT count(*) FROM public.character_media_asset_tags WHERE media_asset_id = '00000000-0000-4000-8000-000000050402'),
  0::bigint,
  'Empty general-catalog assignments remove canonical join rows only'
);
SELECT is(current_setting('wp05.tag_count'), '1', 'Admin tag counts use canonical assignments');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000050001';
SELECT throws_like($$SELECT public.delete_admin_media_tag('00000000-0000-4000-8000-000000050302')$$, 'media_tag_in_use', 'A canonical tag assignment prevents deletion');
SELECT throws_like(
  $$SELECT public.set_admin_media_asset_assignments('00000000-0000-4000-8000-000000050401', '{}'::uuid[], '{}'::uuid[], false)$$,
  'media_asset_assignment_required',
  'A non-global asset cannot lose all character assignments'
);
SELECT throws_like(
  $$SELECT public.set_admin_media_asset_assignments(
    '00000000-0000-4000-8000-000000050401',
    ARRAY['00000000-0000-4000-8000-000000050201'::uuid],
    ARRAY['00000000-0000-4000-8000-000000050302'::uuid], false
  )$$,
  'media_tag_character_mismatch',
  'A tag cannot be assigned without its owning character'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
