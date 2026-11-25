BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT no_plan();

SELECT has_function(
  'public',
  'get_admin_advanced_analytics_for_server',
  ARRAY['date', 'date'],
  'Advanced analytics is aggregated through the bounded server-only database function'
);
SELECT function_privs_are(
  'public',
  'get_admin_advanced_analytics_for_server',
  ARRAY['date', 'date'],
  'authenticated',
  ARRAY[]::text[],
  'Authenticated clients cannot execute the server analytics boundary directly'
);
SELECT function_privs_are(
  'public',
  'get_admin_advanced_analytics_for_server',
  ARRAY['date', 'date'],
  'service_role',
  ARRAY['EXECUTE'],
  'Only the service role can execute the server analytics boundary'
);

CREATE TEMP TABLE wp11_empty_analytics_snapshot(payload jsonb) ON COMMIT DROP;
INSERT INTO wp11_empty_analytics_snapshot(payload)
SELECT public.get_admin_advanced_analytics_for_server(current_date, current_date);
SELECT is(
  (SELECT payload -> 'range' ->> 'startDate' FROM wp11_empty_analytics_snapshot),
  current_date::text,
  'The aggregate reports the requested start date'
);
SELECT is(
  jsonb_array_length((SELECT payload -> 'days' FROM wp11_empty_analytics_snapshot)),
  1,
  'A one-day range returns exactly one complete daily bucket'
);

SELECT has_table('public', 'credit_requests', 'Credit requests have a durable workflow table');
SELECT has_function(
  'public', 'create_credit_request', ARRAY['uuid', 'uuid'],
  'A client can create an idempotent credit request'
);
SELECT has_function(
  'public', 'resolve_credit_request', ARRAY['uuid', 'text', 'text'],
  'An admin resolves a request through the atomic wallet RPC'
);
SELECT has_table('public', 'client_level_progress', 'Client levels have a server-owned projection');
SELECT has_table('public', 'client_level_transitions', 'Level transitions are durable and unique');
SELECT hasnt_table('public', 'message_gifts', 'The removed legacy Gift table is not restored');
SELECT has_trigger(
  'public', 'gift_attachment_purchases', 'count_client_gift_level',
  'Client Gift levels are counted from the canonical purchase result'
);

SELECT is(private.client_level_for_count(0), 1::smallint, 'Zero qualifying messages is level 1');
SELECT is(private.client_level_for_count(4), 1::smallint, 'The top of the first range stays level 1');
SELECT is(private.client_level_for_count(5), 2::smallint, 'Five qualifying messages starts level 2');
SELECT is(private.client_level_for_count(24), 2::smallint, 'Twenty-four stays level 2');
SELECT is(private.client_level_for_count(25), 3::smallint, 'Twenty-five starts level 3');
SELECT is(private.client_level_for_count(68), 3::smallint, 'Sixty-eight stays level 3');
SELECT is(private.client_level_for_count(69), 4::smallint, 'Sixty-nine starts level 4');
SELECT is(private.client_level_for_count(250), 4::smallint, 'Two hundred and fifty stays level 4');
SELECT is(private.client_level_for_count(251), 5::smallint, 'Two hundred and fifty-one starts level 5');

SELECT ok(
  has_function_privilege('authenticated', 'public.admin_backfill_client_levels(uuid,integer)', 'EXECUTE'),
  'Authenticated callers reach the backfill boundary, which enforces Admin authorization internally'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.admin_backfill_client_levels(uuid,integer)', 'EXECUTE'),
  'Anonymous callers cannot execute the level backfill'
);

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('00000000-0000-4000-8000-000000079001', 'authenticated', 'authenticated', 'wp09-client-a@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000079002', 'authenticated', 'authenticated', 'wp09-client-b@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000079003', 'authenticated', 'authenticated', 'wp09-operator@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000079004', 'authenticated', 'authenticated', 'wp09-admin@example.invalid', 'x', now(), '{}', '{}', now(), now());
INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-4000-8000-000000079003', 'operator'),
  ('00000000-0000-4000-8000-000000079004', 'admin');
INSERT INTO public.operators (id, user_id, full_name, is_active, presence_status, last_seen_at)
VALUES (
  '00000000-0000-4000-8000-000000079103', '00000000-0000-4000-8000-000000079003',
  'WP09 operator', true, 'online', clock_timestamp()
);
INSERT INTO public.characters (id, name)
VALUES ('00000000-0000-4000-8000-000000079201', 'WP09 character');
INSERT INTO public.media_tags (id, character_id, name, is_default)
VALUES (
  '00000000-0000-4000-8000-000000079301',
  '00000000-0000-4000-8000-000000079201',
  'WP09 media', true
);
INSERT INTO public.character_media_assets (
  id, character_id, media_tag_id, source_path, preview_path, content_type,
  status, ingest_status, display_name, preview_generated_at
) VALUES (
  '00000000-0000-4000-8000-000000079401', '00000000-0000-4000-8000-000000079201',
  '00000000-0000-4000-8000-000000079301', 'assets/wp09/source.webp',
  'assets/wp09/preview.webp', 'image/webp', 'sent', 'ready', 'WP09 locked image', clock_timestamp()
);
INSERT INTO public.conversations (id, client_id, character_id, assigned_operator_id) VALUES
  (
    '00000000-0000-4000-8000-000000079501', '00000000-0000-4000-8000-000000079001',
    '00000000-0000-4000-8000-000000079201', '00000000-0000-4000-8000-000000079103'
  ),
  (
    '00000000-0000-4000-8000-000000079502', '00000000-0000-4000-8000-000000079002',
    '00000000-0000-4000-8000-000000079201', '00000000-0000-4000-8000-000000079103'
  );
INSERT INTO public.character_media_reservations (
  id, media_asset_id, conversation_id, client_id, operator_id, reserved_by_user_id,
  previous_asset_status, state, expires_at, ended_at
) VALUES (
  '00000000-0000-4000-8000-000000079601', '00000000-0000-4000-8000-000000079401',
  '00000000-0000-4000-8000-000000079501', '00000000-0000-4000-8000-000000079001',
  '00000000-0000-4000-8000-000000079103', '00000000-0000-4000-8000-000000079003',
  'available', 'consumed', clock_timestamp() + interval '5 minutes', clock_timestamp()
);
INSERT INTO public.sticker_collections (id, slug, name, is_active)
VALUES ('00000000-0000-4000-8000-000000079701', 'wp09-gifts', 'WP09 Gifts', true);
INSERT INTO public.stickers (
  id, collection_id, slug, name, object_path, width, height, byte_size,
  ingest_status, price_credits, is_active, is_gift, processed_at
) VALUES (
  '00000000-0000-4000-8000-000000079801', '00000000-0000-4000-8000-000000079701',
  'level-gift', 'Level Gift',
  'collections/00000000-0000-4000-8000-000000079701/stickers/00000000-0000-4000-8000-000000079801/render.webp',
  64, 64, 1024, 'ready', 100, true, true, clock_timestamp()
);
INSERT INTO public.messages (id, conversation_id, sender_type, sender_id, operator_id, content)
VALUES (
  '00000000-0000-4000-8000-000000079901', '00000000-0000-4000-8000-000000079501',
  'operator', '00000000-0000-4000-8000-000000079003',
  '00000000-0000-4000-8000-000000079103', '[image]'
);
INSERT INTO public.message_attachments (
  id, message_id, media_asset_id, reservation_id, kind, access_mode, view_mode,
  price_credits_snapshot, required_gift_id, required_gift_name_snapshot,
  required_gift_price_credits_snapshot
) VALUES (
  '00000000-0000-4000-8000-000000079911', '00000000-0000-4000-8000-000000079901',
  '00000000-0000-4000-8000-000000079401', '00000000-0000-4000-8000-000000079601',
  'image', 'standard', 'paid_open', 100, '00000000-0000-4000-8000-000000079801',
  'Level Gift', 100
);
INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned)
VALUES ('00000000-0000-4000-8000-000000079001', 300, 300);

INSERT INTO public.gift_attachment_purchases (
  id, attachment_id, conversation_id, client_id, gift_id, gift_name_snapshot,
  price_credits_snapshot, idempotency_key
) VALUES (
  '00000000-0000-4000-8000-000000079920', '00000000-0000-4000-8000-000000079911',
  '00000000-0000-4000-8000-000000079501', '00000000-0000-4000-8000-000000079001',
  '00000000-0000-4000-8000-000000079801', 'Level Gift', 100,
  '00000000-0000-4000-8000-000000079921'
);
SELECT is(
  COALESCE((SELECT eligible_message_count FROM public.client_level_progress
    WHERE client_id = '00000000-0000-4000-8000-000000079001'), 0),
  0,
  'A started Gift purchase does not count toward the Client level'
);

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000079001';
SELECT throws_like(
  $$SELECT * FROM public.admin_backfill_client_levels(NULL, 2000)$$,
  'admin_only',
  'A Client cannot run the level backfill'
);
SELECT set_config('wp09.purchase', public.purchase_attachment_gift(
  '00000000-0000-4000-8000-000000079911',
  '00000000-0000-4000-8000-000000079801',
  '00000000-0000-4000-8000-000000079922'
)::text, true);
SELECT is(
  (SELECT eligible_message_count FROM public.client_level_progress
    WHERE client_id = '00000000-0000-4000-8000-000000079001'),
  1,
  'Linking the completed canonical Gift counts exactly once'
);
SELECT is(
  (public.purchase_attachment_gift(
    '00000000-0000-4000-8000-000000079911',
    '00000000-0000-4000-8000-000000079801',
    '00000000-0000-4000-8000-000000079922'
  )->>'already_purchased')::boolean,
  true,
  'A purchase replay returns the original canonical result'
);
SELECT is(
  (SELECT eligible_message_count FROM public.client_level_progress
    WHERE client_id = '00000000-0000-4000-8000-000000079001'),
  1,
  'A purchase replay does not count the Gift again'
);
SELECT set_config('wp09.open', public.open_attachment_gift_purchase(
  '00000000-0000-4000-8000-000000079911',
  (current_setting('wp09.purchase')::jsonb->>'purchase_id')::uuid,
  '00000000-0000-4000-8000-000000079923'
)::text, true);
SELECT is(
  (public.open_attachment_gift_purchase(
    '00000000-0000-4000-8000-000000079911',
    (current_setting('wp09.purchase')::jsonb->>'purchase_id')::uuid,
    '00000000-0000-4000-8000-000000079923'
  )->>'already_opened')::boolean,
  true,
  'An open replay returns the existing open session'
);
SELECT is(
  (SELECT eligible_message_count FROM public.client_level_progress
    WHERE client_id = '00000000-0000-4000-8000-000000079001'),
  1,
  'Opening and replaying the Gift do not count it again'
);
RESET ROLE;

SELECT is(
  (SELECT source_kind FROM private.client_level_message_events
    WHERE message_id = (current_setting('wp09.purchase')::jsonb->'message'->>'id')::uuid),
  'gift',
  'The canonical Gift link promotes its Sticker event to Gift'
);
SELECT is(
  (SELECT count(*) FROM public.message_stickers
    WHERE message_id = (current_setting('wp09.purchase')::jsonb->'message'->>'id')::uuid),
  1::bigint,
  'The tested canonical purchase uses the real Sticker/Gift writer'
);
SELECT results_eq(
  $$SELECT ledger.id = purchase.charged_transaction_id,
           ledger.user_id = purchase.client_id
             AND ledger.message_attachment_id = purchase.attachment_id
             AND ledger.amount = -purchase.price_credits_snapshot
             AND ledger.type = 'sticker_spend'
             AND ledger.reason = 'attachment_gift_purchase',
           sticker.payer_client_id IS NULL AND sticker.charged_transaction_id IS NULL
             AND sticker.payout_operator_id IS NULL AND sticker.payout_transaction_id IS NULL
    FROM public.gift_attachment_purchases purchase
    JOIN public.message_stickers sticker ON sticker.message_id = purchase.gift_message_id
    JOIN public.credit_transactions ledger ON ledger.message_id = purchase.gift_message_id
    WHERE purchase.id = (current_setting('wp09.purchase')::jsonb->>'purchase_id')::uuid$$,
  $$VALUES (true, true, true)$$,
  'After replay the Gift receipt links one exact debit, with no legacy Sticker payout'
);
UPDATE public.gift_attachment_purchases
SET status = status
WHERE id = (current_setting('wp09.purchase')::jsonb->>'purchase_id')::uuid;
SELECT is(
  (SELECT eligible_message_count FROM public.client_level_progress
    WHERE client_id = '00000000-0000-4000-8000-000000079001'),
  1,
  'A repeated canonical purchase-row update is fenced from duplicate counting'
);
SELECT is(
  (SELECT count(*) FROM public.notifications
    WHERE user_id = '00000000-0000-4000-8000-000000079001' AND type = 'level_up'),
  0::bigint,
  'Gift promotion does not create an extra level notification'
);

INSERT INTO public.messages (id, conversation_id, sender_type, sender_id, content)
VALUES (
  '00000000-0000-4000-8000-000000079902', '00000000-0000-4000-8000-000000079501',
  'client', '00000000-0000-4000-8000-000000079001', '[sticker]'
);
INSERT INTO public.message_stickers (
  message_id, sticker_id, sticker_name_snapshot, collection_name_snapshot, price_credits_snapshot
) VALUES (
  '00000000-0000-4000-8000-000000079902', '00000000-0000-4000-8000-000000079801',
  'Level Gift', 'WP09 Gifts', 100
);
SELECT is(
  (SELECT source_kind FROM private.client_level_message_events
    WHERE message_id = '00000000-0000-4000-8000-000000079902'),
  'legacy_sticker',
  'A pre-existing Sticker event starts with the explicit legacy classification'
);
SELECT is(
  (SELECT eligible_message_count FROM public.client_level_progress
    WHERE client_id = '00000000-0000-4000-8000-000000079001'),
  2,
  'The legacy Sticker message is counted once before canonical Gift linkage'
);
INSERT INTO public.credit_transactions (
  id, user_id, amount, balance_after, type, reason, message_id, message_attachment_id
) VALUES (
  '00000000-0000-4000-8000-000000079931', '00000000-0000-4000-8000-000000079001',
  -100, 100, 'sticker_spend', 'wp09_legacy_promotion_fixture',
  '00000000-0000-4000-8000-000000079902', '00000000-0000-4000-8000-000000079911'
);
INSERT INTO public.gift_attachment_purchases (
  id, attachment_id, conversation_id, client_id, gift_id, gift_name_snapshot,
  price_credits_snapshot, idempotency_key
) VALUES (
  '00000000-0000-4000-8000-000000079932', '00000000-0000-4000-8000-000000079911',
  '00000000-0000-4000-8000-000000079501', '00000000-0000-4000-8000-000000079001',
  '00000000-0000-4000-8000-000000079801', 'Level Gift', 100,
  '00000000-0000-4000-8000-000000079933'
);
UPDATE public.gift_attachment_purchases
SET charged_transaction_id = '00000000-0000-4000-8000-000000079931',
    gift_message_id = '00000000-0000-4000-8000-000000079902',
    status = 'purchased',
    purchased_at = clock_timestamp()
WHERE id = '00000000-0000-4000-8000-000000079932';
SELECT is(
  (SELECT eligible_message_count FROM public.client_level_progress
    WHERE client_id = '00000000-0000-4000-8000-000000079001'),
  2,
  'Canonical linkage of an existing legacy event does not increment again'
);
SELECT is(
  (SELECT source_kind FROM private.client_level_message_events
    WHERE message_id = '00000000-0000-4000-8000-000000079902'),
  'gift',
  'Canonical linkage promotes the existing legacy event to Gift'
);
SELECT is(
  (SELECT count(*) FROM public.notifications
    WHERE user_id = '00000000-0000-4000-8000-000000079001' AND type = 'level_up'),
  0::bigint,
  'Legacy-to-Gift promotion does not emit a duplicate notification'
);

ALTER TABLE public.messages DISABLE TRIGGER count_plain_client_message_level;
INSERT INTO public.messages (id, conversation_id, sender_type, sender_id, content) VALUES
  ('00000000-0000-4000-8000-000000079941', '00000000-0000-4000-8000-000000079502', 'client', '00000000-0000-4000-8000-000000079002', 'Historical one'),
  ('00000000-0000-4000-8000-000000079942', '00000000-0000-4000-8000-000000079502', 'client', '00000000-0000-4000-8000-000000079002', 'Historical two'),
  ('00000000-0000-4000-8000-000000079943', '00000000-0000-4000-8000-000000079502', 'client', '00000000-0000-4000-8000-000000079002', 'Historical three'),
  ('00000000-0000-4000-8000-000000079944', '00000000-0000-4000-8000-000000079502', 'client', '00000000-0000-4000-8000-000000079002', 'Historical four'),
  ('00000000-0000-4000-8000-000000079945', '00000000-0000-4000-8000-000000079502', 'client', '00000000-0000-4000-8000-000000079002', 'Historical five');
ALTER TABLE public.messages ENABLE TRIGGER count_plain_client_message_level;
SELECT is(
  (SELECT count(*) FROM public.client_level_progress
    WHERE client_id = '00000000-0000-4000-8000-000000079002'),
  0::bigint,
  'Historical fixtures remain uncounted before the controlled backfill'
);

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000079004';
SELECT lives_ok(
  $$SELECT * FROM public.admin_backfill_client_levels(NULL, 2000)$$,
  'An Admin can execute the controlled level backfill'
);
RESET ROLE;
SELECT is(
  (SELECT eligible_message_count FROM public.client_level_progress
    WHERE client_id = '00000000-0000-4000-8000-000000079002'),
  5,
  'The first backfill counts each historical Client message once'
);
SELECT is(
  (SELECT level FROM public.client_level_progress
    WHERE client_id = '00000000-0000-4000-8000-000000079002'),
  2::smallint,
  'The historical count reaches the approved level boundary'
);
SELECT is(
  (SELECT count(*) FROM public.client_level_transitions
    WHERE client_id = '00000000-0000-4000-8000-000000079002'),
  1::bigint,
  'The first backfill records one historical level transition'
);
SELECT ok(
  (SELECT notified_at IS NULL FROM public.client_level_transitions
    WHERE client_id = '00000000-0000-4000-8000-000000079002'),
  'A historical transition is stored without marking a notification as sent'
);
SELECT is(
  (SELECT count(*) FROM public.notifications
    WHERE user_id = '00000000-0000-4000-8000-000000079002' AND type = 'level_up'),
  0::bigint,
  'The historical backfill does not create level notifications'
);
SELECT is(
  (SELECT eligible_message_count FROM public.client_level_progress
    WHERE client_id = '00000000-0000-4000-8000-000000079001'),
  2,
  'Backfilling another Client preserves Client isolation'
);
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000079004';
SELECT lives_ok(
  $$SELECT * FROM public.admin_backfill_client_levels(NULL, 2000)$$,
  'Repeating the controlled backfill is idempotent'
);
RESET ROLE;
SELECT is(
  (SELECT eligible_message_count FROM public.client_level_progress
    WHERE client_id = '00000000-0000-4000-8000-000000079002'),
  5,
  'A repeated backfill does not duplicate historical events'
);
SELECT is(
  (SELECT count(*) FROM public.client_level_transitions
    WHERE client_id = '00000000-0000-4000-8000-000000079002'),
  1::bigint,
  'A repeated backfill does not duplicate historical transitions'
);
SELECT is(
  (SELECT count(*) FROM public.notifications
    WHERE user_id = '00000000-0000-4000-8000-000000079002' AND type = 'level_up'),
  0::bigint,
  'A repeated backfill still emits no historical notification'
);

SELECT has_table(
  'public', 'account_deletion_requests',
  'Account deletion requests are durable before destructive work'
);
SELECT has_table(
  'private', 'account_deletion_steps',
  'Deletion execution has resumable private step evidence'
);
SELECT has_function(
  'public', 'request_account_deletion', ARRAY['uuid'],
  'The client request boundary is installed'
);
SELECT has_function(
  'public', 'claim_account_deletion_step_for_server', ARRAY['uuid'],
  'Destructive work is exposed only through the service claim boundary'
);
SELECT has_function(
  'public', 'complete_account_deletion_step_for_server', ARRAY['uuid', 'text', 'uuid', 'jsonb'],
  'Account deletion completion requires a fenced claim and evidence'
);
SELECT has_function(
  'public', 'fail_account_deletion_step_for_server', ARRAY['uuid', 'text', 'uuid', 'text'],
  'Account deletion failures preserve the fenced claim boundary'
);
SELECT has_function(
  'public', 'request_conversation_deletion', ARRAY['uuid', 'text', 'uuid', 'boolean'],
  'Only the explicit admin request boundary creates a conversation deletion workflow'
);
SELECT has_table(
  'private', 'conversation_deletion_steps',
  'Conversation deletion tracks database, storage and finalize steps independently'
);
SELECT is(
  (SELECT value FROM public.system_settings WHERE key = 'account_deletion_irreversible_enabled'),
  'false'::jsonb,
  'Irreversible account deletion stays disabled until a separate runtime approval'
);

SELECT has_function(
  'public', 'get_admin_operational_wait_summary', ARRAY[]::text[],
  'The independent operational wait summary is installed'
);
SELECT has_function(
  'public', 'emit_operational_wait_alerts', ARRAY['integer'],
  'The once-per-wait-cycle alert writer is installed'
);
SELECT has_function(
  'public', 'get_admin_completion_exceptions', ARRAY[]::text[],
  'The admin exception board aggregates authoritative server sources'
);
SELECT is(
  (SELECT value FROM public.system_settings WHERE key = 'operational_wait_alert_seconds'),
  '420'::jsonb,
  'The operational alert target is seven minutes and independent of inactivity release'
);

SELECT is(
  (SELECT value FROM public.system_settings WHERE key = 'regular_media_60s_policy_enabled'),
  'true'::jsonb,
  'The approved regular-media policy is enabled for newly inserted view-once attachments'
);
SELECT is(
  (
    SELECT is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'message_attachments'
      AND column_name = 'view_policy_version'
  ),
  'NO',
  'Every attachment has an explicit policy version while legacy rows retain the legacy default'
);

SELECT * FROM finish();
ROLLBACK;
