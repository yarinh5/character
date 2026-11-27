BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT plan(38);

SELECT is(
  (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'operator_points_rule_version'),
  'wp08-v1',
  'WP08 stores its rule version as a JSON string'
);
SELECT is(
  (SELECT jsonb_typeof(value) FROM public.system_settings WHERE key = 'operator_points_rule_version'),
  'string',
  'WP08 rule version keeps the expected JSON type'
);
SELECT is(
  (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'client_text_credit_price'),
  '10',
  'The client text credit price keeps its approved value'
);
SELECT is(
  (SELECT jsonb_typeof(value) FROM public.system_settings WHERE key = 'client_text_credit_price'),
  'number',
  'The client text credit price remains a JSON number'
);
SELECT is(
  (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'gift_reward_precision_scale'),
  '6',
  'The Gift reward precision scale keeps its approved value'
);
SELECT is(
  (SELECT jsonb_typeof(value) FROM public.system_settings WHERE key = 'gift_reward_precision_scale'),
  'number',
  'The Gift reward precision scale remains a JSON number'
);

SELECT has_table('public', 'gift_attachment_purchases', 'Gift purchases have a durable public ledger');
SELECT has_table('public', 'operator_point_wallets', 'Operator Points use a separate wallet');
SELECT has_table('public', 'operator_point_transactions', 'Operator Points use a separate transaction ledger');
SELECT ok(EXISTS (
  SELECT 1 FROM pg_publication_tables
  WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
    AND tablename = 'operator_point_wallets'
), 'The RLS-protected Operator Point wallet is published for live refresh');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM pg_publication_tables
  WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
    AND tablename = 'operator_point_transactions'
), 'Ledger metadata is not published with the wallet refresh signal');
SELECT has_function('public', 'purchase_attachment_gift', ARRAY['uuid', 'uuid', 'uuid'], 'Gift purchase RPC is installed');
SELECT has_function('public', 'open_attachment_gift_purchase', ARRAY['uuid', 'uuid', 'uuid'], 'Gift open RPC is installed');

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('00000000-0000-4000-8000-000000078001', 'authenticated', 'authenticated', 'wp07-client@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000078002', 'authenticated', 'authenticated', 'wp08-operator-a@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000078003', 'authenticated', 'authenticated', 'wp08-operator-b@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000078004', 'authenticated', 'authenticated', 'wp08-operator-c@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000078005', 'authenticated', 'authenticated', 'wp08-admin-operator@example.invalid', 'x', now(), '{}', '{}', now(), now());
INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-4000-8000-000000078002', 'operator'),
  ('00000000-0000-4000-8000-000000078003', 'operator'),
  ('00000000-0000-4000-8000-000000078004', 'operator'),
  ('00000000-0000-4000-8000-000000078005', 'operator'),
  ('00000000-0000-4000-8000-000000078005', 'admin');
INSERT INTO public.operators (id, user_id, full_name, is_active, presence_status, last_seen_at) VALUES
  ('00000000-0000-4000-8000-000000078102', '00000000-0000-4000-8000-000000078002', 'WP08 operator A', true, 'online', clock_timestamp()),
  ('00000000-0000-4000-8000-000000078103', '00000000-0000-4000-8000-000000078003', 'WP08 operator B', true, 'online', clock_timestamp()),
  ('00000000-0000-4000-8000-000000078104', '00000000-0000-4000-8000-000000078004', 'WP08 operator C', true, 'online', clock_timestamp()),
  ('00000000-0000-4000-8000-000000078105', '00000000-0000-4000-8000-000000078005', 'WP08 Admin operator', true, 'online', clock_timestamp());
INSERT INTO public.characters (id, name) VALUES
  ('00000000-0000-4000-8000-000000078201', 'WP07 character');
INSERT INTO public.media_tags (id, character_id, name, is_default) VALUES
  ('00000000-0000-4000-8000-000000078301', '00000000-0000-4000-8000-000000078201', 'WP07 media', true);
INSERT INTO public.character_media_assets (
  id, character_id, media_tag_id, source_path, preview_path, content_type,
  status, ingest_status, display_name, preview_generated_at
) VALUES (
  '00000000-0000-4000-8000-000000078401', '00000000-0000-4000-8000-000000078201',
  '00000000-0000-4000-8000-000000078301', 'assets/wp07/source.webp',
  'assets/wp07/preview.webp', 'image/webp', 'sent', 'ready', 'WP07 locked image', clock_timestamp()
);
INSERT INTO public.conversations (id, client_id, character_id, assigned_operator_id) VALUES (
  '00000000-0000-4000-8000-000000078501', '00000000-0000-4000-8000-000000078001',
  '00000000-0000-4000-8000-000000078201', '00000000-0000-4000-8000-000000078102'
);
INSERT INTO public.character_media_reservations (
  id, media_asset_id, conversation_id, client_id, operator_id, reserved_by_user_id,
  previous_asset_status, state, expires_at, ended_at
) VALUES (
  '00000000-0000-4000-8000-000000078601', '00000000-0000-4000-8000-000000078401',
  '00000000-0000-4000-8000-000000078501', '00000000-0000-4000-8000-000000078001',
  '00000000-0000-4000-8000-000000078102', '00000000-0000-4000-8000-000000078002',
  'available', 'consumed', clock_timestamp() + interval '5 minutes', clock_timestamp()
);
INSERT INTO public.sticker_collections (id, slug, name, is_active) VALUES
  ('00000000-0000-4000-8000-000000078701', 'wp07-gifts', 'WP07 Gifts', true);
INSERT INTO public.stickers (
  id, collection_id, slug, name, object_path, width, height, byte_size,
  ingest_status, price_credits, is_active, is_gift, processed_at
) VALUES
  ('00000000-0000-4000-8000-000000078801', '00000000-0000-4000-8000-000000078701',
   'exact-gift', 'Exact Gift', 'collections/00000000-0000-4000-8000-000000078701/stickers/00000000-0000-4000-8000-000000078801/render.webp',
   64, 64, 1024, 'ready', 100, true, true, clock_timestamp()),
  ('00000000-0000-4000-8000-000000078802', '00000000-0000-4000-8000-000000078701',
   'wrong-gift', 'Wrong Gift', 'collections/00000000-0000-4000-8000-000000078701/stickers/00000000-0000-4000-8000-000000078802/render.webp',
   64, 64, 1024, 'ready', 150, true, true, clock_timestamp());
INSERT INTO public.messages (id, conversation_id, sender_type, sender_id, operator_id, content) VALUES (
  '00000000-0000-4000-8000-000000078901', '00000000-0000-4000-8000-000000078501',
  'operator', '00000000-0000-4000-8000-000000078002', '00000000-0000-4000-8000-000000078102', '[image]'
);
INSERT INTO public.message_attachments (
  id, message_id, media_asset_id, reservation_id, kind, access_mode, view_mode,
  price_credits_snapshot, required_gift_id, required_gift_name_snapshot,
  required_gift_price_credits_snapshot
) VALUES (
  '00000000-0000-4000-8000-000000078911', '00000000-0000-4000-8000-000000078901',
  '00000000-0000-4000-8000-000000078401', '00000000-0000-4000-8000-000000078601',
  'image', 'standard', 'paid_open', 100, '00000000-0000-4000-8000-000000078801', 'Exact Gift', 100
);
INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned)
VALUES ('00000000-0000-4000-8000-000000078001', 300, 300);

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000078001';
SELECT throws_like(
  $$SELECT public.open_paid_message_attachment(
    '00000000-0000-4000-8000-000000078911', 'legacy-gift-bypass')$$,
  'gift_purchase_required',
  'The legacy paid-open RPC cannot charge a Gift-gated attachment'
);
RESET ROLE;
SELECT is(
  (SELECT balance FROM public.credit_wallets WHERE user_id = '00000000-0000-4000-8000-000000078001'),
  300,
  'The rejected legacy open leaves the Client wallet unchanged'
);
SET LOCAL ROLE authenticated;
SELECT throws_like(
  $$SELECT public.purchase_attachment_gift(
    '00000000-0000-4000-8000-000000078911', '00000000-0000-4000-8000-000000078802',
    '00000000-0000-4000-8000-000000078921')$$,
  'gift_does_not_unlock_attachment',
  'A different Gift cannot purchase access to the attachment'
);
SELECT set_config('wp07.purchase', public.purchase_attachment_gift(
  '00000000-0000-4000-8000-000000078911', '00000000-0000-4000-8000-000000078801',
  '00000000-0000-4000-8000-000000078922')::text, true);
SELECT is(
  (public.purchase_attachment_gift(
    '00000000-0000-4000-8000-000000078911', '00000000-0000-4000-8000-000000078801',
    '00000000-0000-4000-8000-000000078922')->>'already_purchased')::boolean,
  true,
  'A purchase retry is idempotent'
);
SELECT set_config('wp07.open', public.open_attachment_gift_purchase(
  '00000000-0000-4000-8000-000000078911',
  (current_setting('wp07.purchase')::jsonb->>'purchase_id')::uuid,
  '00000000-0000-4000-8000-000000078923')::text, true);
RESET ROLE;

SELECT is((SELECT balance FROM public.credit_wallets WHERE user_id = '00000000-0000-4000-8000-000000078001'), 200, 'The exact Gift is charged once');
SELECT is((SELECT count(*) FROM public.credit_transactions WHERE reason = 'attachment_gift_purchase'), 1::bigint, 'The Gift purchase has one Client Credit transaction');
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
    WHERE purchase.id = (current_setting('wp07.purchase')::jsonb->>'purchase_id')::uuid$$,
  $$VALUES (true, true, true)$$,
  'After replay the Gift receipt links one exact debit, with no legacy Sticker payout'
);
SELECT ok((current_setting('wp07.open')::jsonb->>'already_opened')::boolean = false, 'Purchase and open use separate idempotency operations');
SELECT ok(
  (current_setting('wp07.open')::jsonb->>'expires_at')::timestamptz
    <= clock_timestamp() + interval '60 seconds',
  'The server-side open session does not exceed 60 seconds'
);
SELECT is((SELECT eligible_operator_count FROM private.gift_reward_events), 3, 'The Gift reward snapshots online non-Admin operators once each');
SELECT ok((SELECT eligibility_evaluated_at IS NOT NULL FROM private.gift_reward_events), 'The eligibility snapshot records its single server timestamp');
SELECT is((SELECT sum(amount) FROM private.gift_reward_allocations), 10.000000::numeric, 'Gift allocations conserve the ten percent pool');
SELECT results_eq(
  $$SELECT amount FROM private.gift_reward_allocations ORDER BY operator_id$$,
  $$VALUES (3.333334::numeric), (3.333333::numeric), (3.333333::numeric)$$,
  'A remainder is assigned deterministically while conserving the Gift pool'
);

INSERT INTO public.messages (id, conversation_id, sender_type, sender_id, operator_id, content, created_at) VALUES (
  '00000000-0000-4000-8000-000000078902', '00000000-0000-4000-8000-000000078501',
  'operator', '00000000-0000-4000-8000-000000078002', '00000000-0000-4000-8000-000000078102', '[sticker]',
  (current_setting('wp07.purchase')::jsonb->'message'->>'created_at')::timestamptz + interval '1 microsecond'
);
INSERT INTO public.message_stickers (
  message_id, sticker_id, sticker_name_snapshot, collection_name_snapshot, price_credits_snapshot
) VALUES (
  '00000000-0000-4000-8000-000000078902', '00000000-0000-4000-8000-000000078801',
  'Exact Gift', 'WP07 Gifts', 100
);
SELECT is((SELECT count(*) FROM public.operator_score_events WHERE message_id = '00000000-0000-4000-8000-000000078902'), 1::bigint, 'An operator Sticker/Gift enters the canonical score event stream');
SELECT is((SELECT count(*) FROM public.operator_point_transactions WHERE source_score_event_id IS NOT NULL), 1::bigint, 'The score event credits Operator Points exactly once');

UPDATE public.operators SET presence_status = 'offline';
INSERT INTO public.messages (id, conversation_id, sender_type, sender_id, content) VALUES (
  '00000000-0000-4000-8000-000000078903', '00000000-0000-4000-8000-000000078501',
  'client', '00000000-0000-4000-8000-000000078001', '[sticker]'
);
INSERT INTO public.credit_transactions (
  id, user_id, amount, balance_after, type, reason, message_id, message_attachment_id
) VALUES (
  '00000000-0000-4000-8000-000000078931', '00000000-0000-4000-8000-000000078001',
  -100, 100, 'sticker_spend', 'wp08_no_eligible_fixture',
  '00000000-0000-4000-8000-000000078903', '00000000-0000-4000-8000-000000078911'
);
INSERT INTO public.gift_attachment_purchases (
  id, attachment_id, conversation_id, client_id, gift_id, gift_name_snapshot,
  price_credits_snapshot, idempotency_key, charged_transaction_id, gift_message_id,
  status, purchased_at
) VALUES (
  '00000000-0000-4000-8000-000000078932', '00000000-0000-4000-8000-000000078911',
  '00000000-0000-4000-8000-000000078501', '00000000-0000-4000-8000-000000078001',
  '00000000-0000-4000-8000-000000078801', 'Exact Gift', 100,
  '00000000-0000-4000-8000-000000078933', '00000000-0000-4000-8000-000000078931',
  '00000000-0000-4000-8000-000000078903', 'purchased', clock_timestamp()
);
INSERT INTO private.gift_reward_events (purchase_id, reward_pool_points)
VALUES ('00000000-0000-4000-8000-000000078932', 10);
SELECT is((SELECT unallocated_points FROM private.gift_reward_events WHERE purchase_id = (current_setting('wp07.purchase')::jsonb->>'purchase_id')::uuid), 0.000000::numeric, 'A distributed pool records no unallocated balance');
SELECT results_eq(
  $$SELECT eligible_operator_count, distributed_points, unallocated_points
    FROM private.gift_reward_events
    WHERE purchase_id = '00000000-0000-4000-8000-000000078932'$$,
  $$VALUES (0, 0.000000::numeric, 10.000000::numeric)$$,
  'A Gift with no eligible operators is recorded without a false distribution'
);
SELECT is(
  (SELECT count(*) FROM private.gift_reward_allocations allocation
   JOIN private.gift_reward_events event ON event.id = allocation.gift_reward_event_id
   WHERE event.purchase_id = '00000000-0000-4000-8000-000000078932'),
  0::bigint,
  'No operator allocation is created retroactively when the snapshot is empty'
);

-- AC22: reuse the attachment and the Client's remaining 200 credits.
UPDATE public.operators SET presence_status = 'online', last_seen_at = clock_timestamp()
WHERE id IN ('00000000-0000-4000-8000-000000078102', '00000000-0000-4000-8000-000000078103');

SET LOCAL ROLE authenticated;
SELECT set_config('wp08.ac22_two', public.purchase_attachment_gift(
  '00000000-0000-4000-8000-000000078911', '00000000-0000-4000-8000-000000078801',
  '00000000-0000-4000-8000-000000078934')::text, true);
RESET ROLE;

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000078006', 'authenticated', 'authenticated',
  'wp08-operator-d@example.invalid', 'x', now(), '{}', '{}', now(), now()
);
INSERT INTO public.user_roles (user_id, role)
VALUES ('00000000-0000-4000-8000-000000078006', 'operator');
INSERT INTO public.operators (id, user_id, full_name, is_active, presence_status, last_seen_at)
VALUES (
  '00000000-0000-4000-8000-000000078106', '00000000-0000-4000-8000-000000078006',
  'WP08 operator D', true, 'online', clock_timestamp()
);
UPDATE public.operators SET presence_status = 'online', last_seen_at = clock_timestamp()
WHERE id IN (
  '00000000-0000-4000-8000-000000078102', '00000000-0000-4000-8000-000000078103',
  '00000000-0000-4000-8000-000000078104'
);

SET LOCAL ROLE authenticated;
SELECT set_config('wp08.ac22_four', public.purchase_attachment_gift(
  '00000000-0000-4000-8000-000000078911', '00000000-0000-4000-8000-000000078801',
  '00000000-0000-4000-8000-000000078935')::text, true);
RESET ROLE;

SELECT results_eq(
  $$SELECT allocation.operator_id, allocation.amount
    FROM private.gift_reward_allocations allocation
    JOIN private.gift_reward_events event ON event.id = allocation.gift_reward_event_id
    WHERE event.purchase_id = (current_setting('wp08.ac22_two')::jsonb->>'purchase_id')::uuid
    ORDER BY allocation.operator_id$$,
  $$VALUES
    ('00000000-0000-4000-8000-000000078102'::uuid, 5::numeric),
    ('00000000-0000-4000-8000-000000078103'::uuid, 5::numeric)$$,
  'AC22: the two eligible operators receive exactly 5 points each'
);
SELECT results_eq(
  $$SELECT allocation.operator_id, allocation.amount
    FROM private.gift_reward_allocations allocation
    JOIN private.gift_reward_events event ON event.id = allocation.gift_reward_event_id
    WHERE event.purchase_id = (current_setting('wp08.ac22_four')::jsonb->>'purchase_id')::uuid
    ORDER BY allocation.operator_id$$,
  $$VALUES
    ('00000000-0000-4000-8000-000000078102'::uuid, 2.5::numeric),
    ('00000000-0000-4000-8000-000000078103'::uuid, 2.5::numeric),
    ('00000000-0000-4000-8000-000000078104'::uuid, 2.5::numeric),
    ('00000000-0000-4000-8000-000000078106'::uuid, 2.5::numeric)$$,
  'AC22: the four eligible operators receive exactly 2.5 points each'
);

SELECT set_config('wp08.ac22_wallet_balances', (
  SELECT jsonb_object_agg(operator_id, balance)::text FROM public.operator_point_wallets
  WHERE operator_id IN (
    '00000000-0000-4000-8000-000000078102', '00000000-0000-4000-8000-000000078103',
    '00000000-0000-4000-8000-000000078104', '00000000-0000-4000-8000-000000078106'
  )
), true);

SET LOCAL ROLE authenticated;
SELECT ok(
  (current_setting('wp08.ac22_two')::jsonb->>'already_purchased')::boolean = false
    AND (receipt->>'already_purchased')::boolean = true
    AND receipt->>'purchase_id' = current_setting('wp08.ac22_two')::jsonb->>'purchase_id',
  'AC22: replay of the two-operator Gift returns the original purchase'
)
FROM public.purchase_attachment_gift(
  '00000000-0000-4000-8000-000000078911', '00000000-0000-4000-8000-000000078801',
  '00000000-0000-4000-8000-000000078934') AS replay(receipt);
SELECT ok(
  (current_setting('wp08.ac22_four')::jsonb->>'already_purchased')::boolean = false
    AND (receipt->>'already_purchased')::boolean = true
    AND receipt->>'purchase_id' = current_setting('wp08.ac22_four')::jsonb->>'purchase_id',
  'AC22: replay of the four-operator Gift returns the original purchase'
)
FROM public.purchase_attachment_gift(
  '00000000-0000-4000-8000-000000078911', '00000000-0000-4000-8000-000000078801',
  '00000000-0000-4000-8000-000000078935') AS replay(receipt);
RESET ROLE;

SELECT is(
  (SELECT count(*) FROM public.gift_attachment_purchases
   WHERE client_id = '00000000-0000-4000-8000-000000078001'
     AND attachment_id = '00000000-0000-4000-8000-000000078911'),
  4::bigint,
  'AC22: replay leaves the two earlier fixtures and exactly two new purchases'
);
SELECT results_eq(
  $$SELECT purchase.price_credits_snapshot, event.eligible_operator_count,
           event.reward_pool_points, event.distributed_points, event.unallocated_points,
           (SELECT sum(amount) FROM private.gift_reward_allocations WHERE gift_reward_event_id = event.id),
           (SELECT count(*) FROM public.operator_point_transactions WHERE gift_reward_event_id = event.id),
           (SELECT sum(amount) FROM public.operator_point_transactions WHERE gift_reward_event_id = event.id)
    FROM private.gift_reward_events event
    JOIN public.gift_attachment_purchases purchase ON purchase.id = event.purchase_id
    WHERE purchase.id IN (
      (current_setting('wp08.ac22_two')::jsonb->>'purchase_id')::uuid,
      (current_setting('wp08.ac22_four')::jsonb->>'purchase_id')::uuid
    )
    ORDER BY purchase.idempotency_key$$,
  $$VALUES
    (100, 2, 10::numeric, 10::numeric, 0::numeric, 10::numeric, 2::bigint, 10::numeric),
    (100, 4, 10::numeric, 10::numeric, 0::numeric, 10::numeric, 4::bigint, 10::numeric)$$,
  'AC22: each purchase conserves its 10-point pool with no extra Point transactions after replay'
);
SELECT is(
  (SELECT jsonb_object_agg(operator_id, balance) FROM public.operator_point_wallets
   WHERE operator_id IN (
     '00000000-0000-4000-8000-000000078102', '00000000-0000-4000-8000-000000078103',
     '00000000-0000-4000-8000-000000078104', '00000000-0000-4000-8000-000000078106'
   )),
  current_setting('wp08.ac22_wallet_balances')::jsonb,
  'AC22: replay leaves the eligible operators'' Point wallet balances unchanged'
);

SELECT * FROM finish();
ROLLBACK;
