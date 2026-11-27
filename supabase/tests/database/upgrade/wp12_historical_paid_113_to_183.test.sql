-- Run after committing the WP01 M113 fixture and the WP12 paid fixture at M113,
-- then applying M114-M184. Every observation here is rolled back.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;

SELECT plan(28);

SELECT is((SELECT count(*) FROM supabase_migrations.schema_migrations), 184::bigint,
  'The complete 184-migration chain is installed');
SELECT is((SELECT max(version) FROM supabase_migrations.schema_migrations),
  '20261127010000', 'The installed chain ends at M184');

SELECT is((SELECT count(*) FROM public.character_media_assets
  WHERE id = '00000000-0000-4000-8000-0000000b0501'
    AND character_id = '00000000-0000-4000-8000-0000000b0031'
    AND source_path = 'wp12-rehearsal/legacy-source.png'
    AND preview_path = 'wp12-rehearsal/legacy-preview.png'
    AND locked_teaser_path = 'wp12-rehearsal/legacy-teaser.png'
    AND locked_delivery_path = 'wp12-rehearsal/legacy-delivery.png'
    AND locked_price_credits = 10 AND ingest_status = 'ready' AND status = 'restored'),
  1::bigint, 'Historical paid asset and its derivatives survive catalog-state conversion');
SELECT is((SELECT count(*) FROM public.character_media_deliveries
  WHERE message_attachment_id = '00000000-0000-4000-8000-0000000b0503'
    AND media_asset_id = '00000000-0000-4000-8000-0000000b0501'),
  1::bigint, 'Catalog-state conversion retains exactly one historical delivery');
SELECT is((SELECT count(*) FROM public.character_media_reservations
  WHERE id = '00000000-0000-4000-8000-0000000b0502'
    AND media_asset_id = '00000000-0000-4000-8000-0000000b0501'
    AND conversation_id = '00000000-0000-4000-8000-0000000b0102'
    AND operator_id = '00000000-0000-4000-8000-0000000b0021'
    AND state = 'consumed' AND intended_access_mode = 'locked'),
  1::bigint, 'Consumed historical reservation retains its asset and conversation');
SELECT is((SELECT count(*) FROM public.message_attachments
  WHERE id = '00000000-0000-4000-8000-0000000b0503'
    AND message_id = '00000000-0000-4000-8000-0000000b0303'
    AND media_asset_id = '00000000-0000-4000-8000-0000000b0501'
    AND reservation_id = '00000000-0000-4000-8000-0000000b0502'
    AND kind = 'image' AND access_mode = 'locked' AND view_mode = 'permanent'
    AND price_credits_snapshot = 10),
  1::bigint, 'Historical locked attachment retains its price and links');

-- The M113 Auth trigger grants 10 signup credits before this fixture adds 100
-- and spends 10. The rehearsal observed balance 100, earned 110, spent 10.
SELECT is((SELECT count(*) FROM public.credit_wallets
  WHERE user_id = '00000000-0000-4000-8000-0000000b0002'
    AND balance = 100 AND lifetime_earned = 110 AND lifetime_spent = 10),
  1::bigint, 'Buyer wallet preserves the observed post-charge totals');
SELECT is((SELECT count(*) FROM public.credit_transactions
  WHERE user_id = '00000000-0000-4000-8000-0000000b0002'
    AND reason LIKE 'wp12_synthetic_legacy_%'),
  2::bigint, 'Exactly the synthetic funding and charge survive');
SELECT is((SELECT count(*) FROM public.credit_transactions
  WHERE id = '00000000-0000-4000-8000-0000000b0504'
    AND user_id = '00000000-0000-4000-8000-0000000b0002'
    AND amount = 100 AND balance_after = 110 AND type = 'admin_adjustment'
    AND reason = 'wp12_synthetic_legacy_funding'),
  1::bigint, 'Funding ledger row retains amount, type and balance');
SELECT is((SELECT count(*) FROM public.credit_transactions
  WHERE id = '00000000-0000-4000-8000-0000000b0505'
    AND user_id = '00000000-0000-4000-8000-0000000b0002'
    AND amount = -10 AND balance_after = 100 AND type = 'locked_image_unlock'
    AND reason = 'wp12_synthetic_legacy_charge'
    AND message_id = '00000000-0000-4000-8000-0000000b0303'
    AND message_attachment_id = '00000000-0000-4000-8000-0000000b0503'),
  1::bigint, 'Charge ledger row retains its attachment and message links');
SELECT is((SELECT count(*) FROM public.message_attachment_unlocks
  WHERE attachment_id = '00000000-0000-4000-8000-0000000b0503'),
  1::bigint, 'Exactly one durable unlock remains');
SELECT is((SELECT count(*) FROM public.message_attachment_unlocks
  WHERE id = '00000000-0000-4000-8000-0000000b0506'
    AND attachment_id = '00000000-0000-4000-8000-0000000b0503'
    AND client_id = '00000000-0000-4000-8000-0000000b0002'
    AND charged_transaction_id = '00000000-0000-4000-8000-0000000b0505'
    AND unlocked_at = '2026-10-01T10:06:00Z'::timestamptz
    AND revoked_at IS NULL AND refunded_at IS NULL),
  1::bigint, 'The original unlock remains paid and unrevoked');

SELECT ok((SELECT bool_and(relrowsecurity) FROM pg_class
  WHERE oid IN ('public.messages'::regclass,
                'public.message_attachments'::regclass,
                'public.character_media_assets'::regclass,
                'public.character_media_reservations'::regclass,
                'public.credit_wallets'::regclass,
                'public.credit_transactions'::regclass,
                'public.message_attachment_unlocks'::regclass))
  AND (SELECT count(*) FROM pg_class
    WHERE oid IN ('public.messages'::regclass,
                  'public.message_attachments'::regclass,
                  'public.character_media_assets'::regclass,
                  'public.character_media_reservations'::regclass,
                  'public.credit_wallets'::regclass,
                  'public.credit_transactions'::regclass,
                  'public.message_attachment_unlocks'::regclass)) = 7,
  'Message and paid-media tables retain RLS');
SELECT ok(NOT has_function_privilege('anon',
  'public.get_message_attachment_access(uuid[])', 'EXECUTE'),
  'Anonymous callers cannot execute the attachment access RPC');
SELECT ok(has_function_privilege('authenticated',
  'public.get_message_attachment_access(uuid[])', 'EXECUTE'),
  'Authenticated callers retain the attachment access RPC grant');
SELECT ok(NOT has_table_privilege('anon', 'public.message_attachments', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.message_attachment_unlocks', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.character_media_assets', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.character_media_reservations', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.credit_wallets', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.credit_transactions', 'SELECT'),
  'Anonymous callers have no direct paid-media or credit table reads');
SELECT ok(NOT has_table_privilege('authenticated',
  'public.message_attachment_unlocks', 'SELECT'),
  'Authenticated callers cannot directly enumerate unlocks');
SELECT ok(has_column_privilege('authenticated',
  'public.message_attachments', 'id', 'SELECT'),
  'Authenticated attachment reads retain their restricted column grant');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000b0002', true);
SELECT is((SELECT count(*) FROM public.get_message_attachment_access(
  ARRAY['00000000-0000-4000-8000-0000000b0503'::uuid])
  WHERE attachment_id = '00000000-0000-4000-8000-0000000b0503'
    AND access_mode = 'locked' AND view_mode = 'permanent'
    AND price_credits_snapshot = 10 AND is_unlocked IS TRUE),
  1::bigint, 'Buyer sees the permanent paid attachment as unlocked');
SELECT is((SELECT count(*) FROM public.messages
  WHERE id = '00000000-0000-4000-8000-0000000b0303'),
  1::bigint, 'Buyer can still read the historical message');
SELECT is((SELECT count(id) FROM public.message_attachments
  WHERE id = '00000000-0000-4000-8000-0000000b0503'),
  1::bigint, 'Buyer can still read the historical attachment');
SELECT is((SELECT count(*) FROM public.credit_wallets
  WHERE user_id = '00000000-0000-4000-8000-0000000b0002'),
  1::bigint, 'Buyer can still read their historical credit wallet');
SELECT is((SELECT count(*) FROM public.credit_transactions
  WHERE user_id = '00000000-0000-4000-8000-0000000b0002'
    AND reason LIKE 'wp12_synthetic_legacy_%'),
  2::bigint, 'Buyer can still read their two historical credit entries');

SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000b0001', true);
SELECT is((SELECT count(*) FROM public.get_message_attachment_access(
  ARRAY['00000000-0000-4000-8000-0000000b0503'::uuid])),
  0::bigint, 'Another client receives no paid-attachment access row');
SELECT is((SELECT count(*) FROM public.messages
  WHERE id = '00000000-0000-4000-8000-0000000b0303'),
  0::bigint, 'Another client cannot read the historical message');
SELECT is((SELECT count(id) FROM public.message_attachments
  WHERE id = '00000000-0000-4000-8000-0000000b0503'),
  0::bigint, 'Another client cannot read the historical attachment');
SELECT is((SELECT count(*) FROM public.credit_wallets
  WHERE user_id = '00000000-0000-4000-8000-0000000b0002'),
  0::bigint, 'Another client cannot read the buyer credit wallet');
SELECT is((SELECT count(*) FROM public.credit_transactions
  WHERE user_id = '00000000-0000-4000-8000-0000000b0002'
    AND reason LIKE 'wp12_synthetic_legacy_%'),
  0::bigint, 'Another client cannot read the buyer credit entries');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
