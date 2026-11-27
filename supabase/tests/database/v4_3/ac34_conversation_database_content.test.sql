BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT no_plan();

-- All rows, settings and destructive calls are confined to this transaction.
INSERT INTO auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
VALUES
  ('00000000-0000-4000-8000-000000340101', 'authenticated', 'authenticated', 'ac34-admin@example.invalid', now(), '{}', '{}'),
  ('00000000-0000-4000-8000-000000340102', 'authenticated', 'authenticated', 'ac34-client@example.invalid', now(), '{}', '{}'),
  ('00000000-0000-4000-8000-000000340103', 'authenticated', 'authenticated', 'ac34-operator@example.invalid', now(), '{}', '{}');
INSERT INTO public.user_roles (user_id, role) VALUES ('00000000-0000-4000-8000-000000340101', 'admin');
INSERT INTO public.operators (id, user_id, full_name, is_active, presence_status, last_seen_at)
VALUES ('00000000-0000-4000-8000-000000340104', '00000000-0000-4000-8000-000000340103', 'AC34 operator', true, 'online', clock_timestamp());
INSERT INTO public.characters (id, name) VALUES
  ('00000000-0000-4000-8000-000000340105', 'AC34 shared character'),
  ('00000000-0000-4000-8000-000000340109', 'AC34 unrelated character');
INSERT INTO public.conversations (id, client_id, character_id, status) VALUES
  ('00000000-0000-4000-8000-000000340106', '00000000-0000-4000-8000-000000340102', '00000000-0000-4000-8000-000000340105', 'open'),
  ('00000000-0000-4000-8000-000000340107', '00000000-0000-4000-8000-000000340102', '00000000-0000-4000-8000-000000340109', 'open');
INSERT INTO public.messages (id, conversation_id, sender_type, sender_id, content) VALUES
  ('00000000-0000-4000-8000-000000340201', '00000000-0000-4000-8000-000000340106', 'client', '00000000-0000-4000-8000-000000340102', 'AC34 private text'),
  ('00000000-0000-4000-8000-000000340202', '00000000-0000-4000-8000-000000340106', 'client', '00000000-0000-4000-8000-000000340102', '[image]'),
  ('00000000-0000-4000-8000-000000340203', '00000000-0000-4000-8000-000000340106', 'client', '00000000-0000-4000-8000-000000340102', '[sticker]'),
  ('00000000-0000-4000-8000-000000340204', '00000000-0000-4000-8000-000000340106', 'operator', '00000000-0000-4000-8000-000000340103', '[image]'),
  ('00000000-0000-4000-8000-000000340205', '00000000-0000-4000-8000-000000340107', 'client', '00000000-0000-4000-8000-000000340102', 'AC34 unrelated text');
INSERT INTO public.client_media_uploads
  (id, client_id, conversation_id, source_path, preview_path, content_type, status, upload_expires_at)
VALUES
  ('00000000-0000-4000-8000-000000340301', '00000000-0000-4000-8000-000000340102', '00000000-0000-4000-8000-000000340106', 'ac34/target/source.webp', 'ac34/target/preview.webp', 'image/webp', 'pending_upload', clock_timestamp() + interval '1 day'),
  ('00000000-0000-4000-8000-000000340302', '00000000-0000-4000-8000-000000340102', '00000000-0000-4000-8000-000000340107', 'ac34/other/source.webp', 'ac34/other/preview.webp', 'image/webp', 'pending_upload', clock_timestamp() + interval '1 day');
UPDATE public.client_media_uploads SET status = 'processing', finalize_claimed_at = clock_timestamp(),
  finalize_claim_token = '00000000-0000-4000-8000-000000340399', finalize_claim_expires_at = clock_timestamp() + interval '5 minutes'
WHERE id = '00000000-0000-4000-8000-000000340301';
INSERT INTO public.message_attachments (id, message_id, client_upload_id, kind, view_mode, access_expires_at, caption, metadata)
SELECT '00000000-0000-4000-8000-000000340303', id, '00000000-0000-4000-8000-000000340301',
  'image', 'client_24h', created_at + interval '24 hours', 'AC34 private caption', '{"private":"media"}'::jsonb
FROM public.messages WHERE id = '00000000-0000-4000-8000-000000340202';
UPDATE public.client_media_uploads SET status = 'finalized', finalized_at = clock_timestamp(),
  access_expires_at = (SELECT access_expires_at FROM public.message_attachments WHERE id = '00000000-0000-4000-8000-000000340303'),
  message_id = '00000000-0000-4000-8000-000000340202', message_attachment_id = '00000000-0000-4000-8000-000000340303',
  idempotency_key = 'ac34-media', finalize_claimed_at = NULL, finalize_claim_token = NULL, finalize_claim_expires_at = NULL
WHERE id = '00000000-0000-4000-8000-000000340301';
INSERT INTO public.sticker_collections (id, slug, name, character_id)
VALUES ('00000000-0000-4000-8000-000000340401', 'ac34-shared', 'AC34 shared collection', '00000000-0000-4000-8000-000000340105');
INSERT INTO public.stickers (id, collection_id, slug, name, object_path, width, height, byte_size, ingest_status, is_active, price_credits, is_gift, processed_at)
VALUES ('00000000-0000-4000-8000-000000340402', '00000000-0000-4000-8000-000000340401', 'ac34-sticker', 'AC34 shared sticker', 'collections/00000000-0000-4000-8000-000000340401/stickers/00000000-0000-4000-8000-000000340402/render.webp', 64, 64, 1024, 'ready', true, 7, true, clock_timestamp());
INSERT INTO public.message_stickers (message_id, sticker_id, sticker_name_snapshot, collection_name_snapshot, price_credits_snapshot)
VALUES ('00000000-0000-4000-8000-000000340203', '00000000-0000-4000-8000-000000340402', 'AC34 shared sticker', 'AC34 shared collection', 7);
INSERT INTO public.character_media_assets (id, character_id, source_path, preview_path, preview_generated_at, content_type, status, ingest_status, paid_open_price_credits)
VALUES ('00000000-0000-4000-8000-000000340501', '00000000-0000-4000-8000-000000340105', 'ac34/shared/paid.webp', 'ac34/shared/paid-preview.webp', clock_timestamp(), 'image/webp', 'sent', 'ready', 7);
INSERT INTO public.character_media_reservations
  (id, media_asset_id, conversation_id, client_id, operator_id, reserved_by_user_id, previous_asset_status, state, expires_at, ended_at)
VALUES ('00000000-0000-4000-8000-000000340502', '00000000-0000-4000-8000-000000340501', '00000000-0000-4000-8000-000000340106', '00000000-0000-4000-8000-000000340102', '00000000-0000-4000-8000-000000340104', '00000000-0000-4000-8000-000000340103', 'available', 'consumed', clock_timestamp() + interval '5 minutes', clock_timestamp());
INSERT INTO public.message_attachments
  (id, message_id, media_asset_id, reservation_id, kind, access_mode, view_mode, price_credits_snapshot,
   required_gift_id, required_gift_name_snapshot, required_gift_price_credits_snapshot, caption, metadata)
VALUES ('00000000-0000-4000-8000-000000340503', '00000000-0000-4000-8000-000000340204', '00000000-0000-4000-8000-000000340501', '00000000-0000-4000-8000-000000340502', 'image', 'standard', 'paid_open', 7,
  '00000000-0000-4000-8000-000000340402', 'AC34 shared sticker', 7, 'AC34 paid caption', '{"private":"paid"}');
INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
VALUES ('00000000-0000-4000-8000-000000340102', 43, 50, 7);
INSERT INTO public.credit_transactions
  (id, user_id, amount, balance_after, type, reason, message_id, message_attachment_id)
VALUES ('00000000-0000-4000-8000-000000340504', '00000000-0000-4000-8000-000000340102', -7, 43, 'sticker_spend', 'attachment_gift_purchase', '00000000-0000-4000-8000-000000340203', '00000000-0000-4000-8000-000000340503');
INSERT INTO public.gift_attachment_purchases
  (id, attachment_id, conversation_id, client_id, gift_id, gift_name_snapshot, price_credits_snapshot,
   idempotency_key, charged_transaction_id, gift_message_id, status, purchased_at, opened_at)
VALUES ('00000000-0000-4000-8000-000000340505', '00000000-0000-4000-8000-000000340503',
  '00000000-0000-4000-8000-000000340106', '00000000-0000-4000-8000-000000340102',
  '00000000-0000-4000-8000-000000340402', 'AC34 shared sticker', 7,
  '00000000-0000-4000-8000-000000340506', '00000000-0000-4000-8000-000000340504',
  '00000000-0000-4000-8000-000000340203', 'opened', clock_timestamp(), clock_timestamp());
INSERT INTO private.gift_attachment_open_sessions
  (id, purchase_id, attachment_id, client_id, idempotency_key, expires_at)
VALUES ('00000000-0000-4000-8000-000000340507', '00000000-0000-4000-8000-000000340505',
  '00000000-0000-4000-8000-000000340503', '00000000-0000-4000-8000-000000340102',
  '00000000-0000-4000-8000-000000340508', clock_timestamp() + interval '60 seconds');
INSERT INTO public.internal_notes (conversation_id, operator_id, note)
VALUES ('00000000-0000-4000-8000-000000340106', '00000000-0000-4000-8000-000000340104', 'AC34 private note');
INSERT INTO public.customer_info_entries (client_id, conversation_id, operator_id, created_by_user_id, content, metadata)
VALUES ('00000000-0000-4000-8000-000000340102', '00000000-0000-4000-8000-000000340106', '00000000-0000-4000-8000-000000340104', '00000000-0000-4000-8000-000000340103', 'AC34 private entry', '{"private":"entry"}');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000340101';
SELECT set_config('ac34.request', (SELECT id::text FROM public.request_conversation_deletion(
  '00000000-0000-4000-8000-000000340106', 'AC34 synthetic deletion', '00000000-0000-4000-8000-000000340601', true)), true);
RESET ROLE;
SELECT is((SELECT status FROM public.conversation_deletion_requests WHERE id = current_setting('ac34.request')::uuid), 'access_blocked', 'Request blocks access before destructive execution');
SELECT is((SELECT count(*) FROM private.conversation_deletion_steps WHERE request_id = current_setting('ac34.request')::uuid), 3::bigint, 'Request creates the three workflow steps');

UPDATE public.system_settings SET value = 'true'::jsonb WHERE key = 'conversation_deletion_irreversible_enabled';
SET LOCAL ROLE service_role;
SET LOCAL "request.jwt.claim.role" = 'service_role';
SELECT set_config('ac34.claim', (SELECT claim_token::text FROM public.claim_conversation_deletion_step_for_server(current_setting('ac34.request')::uuid) WHERE step_name = 'database_content'), true);
SELECT ok(current_setting('ac34.claim', true) IS NOT NULL, 'Service obtains a fenced database_content claim');
SELECT throws_like($$SELECT public.execute_conversation_deletion_database_step_for_server(current_setting('ac34.request')::uuid, '00000000-0000-4000-8000-000000340699')$$, 'conversation_deletion_step_claim_stale', 'Wrong token cannot execute');
SELECT set_config('ac34.first', public.execute_conversation_deletion_database_step_for_server(current_setting('ac34.request')::uuid, current_setting('ac34.claim')::uuid)::text, true);
SELECT is(current_setting('ac34.first')::jsonb ->> 'operation', 'conversation_content_minimized', 'Database step reports its actual operation');
SELECT is((current_setting('ac34.first')::jsonb ->> 'messages_redacted')::integer, 4, 'All target messages are redacted');
SELECT is((current_setting('ac34.first')::jsonb ->> 'storage_objects_manifested')::integer, 2, 'Only target upload paths are manifested');
SELECT is((public.execute_conversation_deletion_database_step_for_server(current_setting('ac34.request')::uuid, current_setting('ac34.claim')::uuid)->>'messages_redacted')::integer, 0, 'Repeat execution under the same claim is idempotent');
SELECT is(public.complete_conversation_deletion_step_for_server(current_setting('ac34.request')::uuid, 'database_content', current_setting('ac34.claim')::uuid, current_setting('ac34.first')::jsonb), 'processing', 'Fenced completion leaves later work pending');
SELECT throws_like($$SELECT public.execute_conversation_deletion_database_step_for_server(current_setting('ac34.request')::uuid, current_setting('ac34.claim')::uuid)$$, 'conversation_deletion_step_claim_stale', 'Completed claim cannot re-execute');
SELECT set_config('ac34.storage_claim', (SELECT claim_token::text FROM public.claim_conversation_deletion_step_for_server(current_setting('ac34.request')::uuid) WHERE step_name = 'storage'), true);
SELECT ok(current_setting('ac34.storage_claim', true) IS NOT NULL, 'Storage can be claimed only after database_content completes');
SELECT results_eq(
  $$SELECT bucket_id, object_path FROM public.list_deletion_storage_objects_for_server('conversation', current_setting('ac34.request')::uuid, current_setting('ac34.storage_claim')::uuid)$$,
  $$VALUES ('client-media'::text, 'ac34/target/preview.webp'::text), ('client-media'::text, 'ac34/target/source.webp'::text)$$,
  'Fenced Storage list exposes only target upload paths');
RESET ROLE;

SELECT ok((SELECT bool_and(content = '[deleted]' AND (sender_type <> 'client' OR sender_id IS NULL)) FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-000000340106'), 'Target text, media, sticker and paid-open message bodies are redacted');
SELECT is((SELECT content FROM public.messages WHERE id = '00000000-0000-4000-8000-000000340205'), 'AC34 unrelated text', 'Other conversation remains untouched');
SELECT ok((SELECT bool_and(caption IS NULL AND metadata = '{}'::jsonb) FROM public.message_attachments WHERE message_id IN ('00000000-0000-4000-8000-000000340202', '00000000-0000-4000-8000-000000340204')), 'Client-media and paid-open attachment metadata are cleared');
SELECT is((SELECT note FROM public.internal_notes WHERE conversation_id = '00000000-0000-4000-8000-000000340106'), '[deleted]', 'Internal note is redacted');
SELECT ok((SELECT content = '[deleted]' AND metadata = '{}'::jsonb FROM public.customer_info_entries WHERE conversation_id = '00000000-0000-4000-8000-000000340106'), 'Customer entry is minimized');
SELECT results_eq(
  $$SELECT bucket_id, object_path FROM private.deletion_storage_objects WHERE request_kind = 'conversation' AND request_id = current_setting('ac34.request')::uuid ORDER BY object_path$$,
  $$VALUES ('client-media'::text, 'ac34/target/preview.webp'::text), ('client-media'::text, 'ac34/target/source.webp'::text)$$,
  'Manifest names only exact target upload objects, not unrelated or shared catalog assets');
SELECT is((SELECT count(*) FROM private.deletion_storage_objects WHERE request_id = current_setting('ac34.request')::uuid), 2::bigint, 'Repeat execution does not duplicate manifest entries');
SELECT is((SELECT status FROM public.client_media_uploads WHERE id = '00000000-0000-4000-8000-000000340301'), 'finalized', 'Database minimization leaves upload disposal to Storage');
SELECT ok((SELECT sticker_id = '00000000-0000-4000-8000-000000340402' FROM public.message_stickers WHERE message_id = '00000000-0000-4000-8000-000000340203'), 'Sticker relation remains without deleting shared catalog');
SELECT is((SELECT count(*) FROM public.stickers WHERE id = '00000000-0000-4000-8000-000000340402'), 1::bigint, 'Shared sticker survives');
SELECT is((SELECT count(*) FROM public.character_media_assets WHERE id = '00000000-0000-4000-8000-000000340501'), 1::bigint, 'Shared media asset survives');
SELECT is((SELECT balance FROM public.credit_wallets WHERE user_id = '00000000-0000-4000-8000-000000340102'), 43, 'Wallet balance is unchanged');
SELECT ok((SELECT amount = -7 AND balance_after = 43 AND message_id = '00000000-0000-4000-8000-000000340203' AND message_attachment_id = '00000000-0000-4000-8000-000000340503' FROM public.credit_transactions WHERE id = '00000000-0000-4000-8000-000000340504'), 'Paid-open Gift ledger link and amount survive');
SELECT is((SELECT count(*) FROM public.credit_transactions WHERE user_id = '00000000-0000-4000-8000-000000340102'), 1::bigint, 'Retry adds no charge or refund');
SELECT ok((SELECT status = 'opened' AND charged_transaction_id = '00000000-0000-4000-8000-000000340504' FROM public.gift_attachment_purchases WHERE id = '00000000-0000-4000-8000-000000340505'), 'Paid-open purchase remains linked to the original charge');
SELECT ok((SELECT purchase_id = '00000000-0000-4000-8000-000000340505' AND attachment_id = '00000000-0000-4000-8000-000000340503' FROM private.gift_attachment_open_sessions WHERE id = '00000000-0000-4000-8000-000000340507'), 'Paid-open session remains linked to the preserved purchase');
SELECT is((SELECT status FROM private.conversation_deletion_steps WHERE request_id = current_setting('ac34.request')::uuid AND step_name = 'finalize'), 'pending', 'Finalize remains pending');
SELECT is((SELECT decision_status FROM private.deletion_retention_policy WHERE policy_version = 'p04-2026-11-11' AND subject_kind = 'conversation' AND record_type = 'business_records' AND blocks_step = 'finalize'), 'pending_legal', 'Existing legal classification still blocks finalize');
SELECT * FROM finish();
ROLLBACK;
