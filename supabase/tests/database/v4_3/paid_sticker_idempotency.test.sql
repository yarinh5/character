BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;

CREATE OR REPLACE FUNCTION pg_temp.v4_3_create_user(_user_id uuid, _email text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES (_user_id, 'authenticated', 'authenticated', _email, 'not-used-by-local-database-tests', clock_timestamp(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp());
END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.v4_3_add_role(_user_id uuid, _role public.app_role) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.user_roles (user_id, role) VALUES (_user_id, _role) ON CONFLICT (user_id, role) DO NOTHING;
$$;
CREATE OR REPLACE FUNCTION pg_temp.v4_3_create_operator(_operator_id uuid, _user_id uuid, _full_name text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.operators (id, user_id, full_name, is_active, availability_status, presence_status, last_seen_at)
  VALUES (_operator_id, _user_id, _full_name, TRUE, 'available'::public.availability_status, 'online', clock_timestamp());
$$;
CREATE OR REPLACE FUNCTION pg_temp.v4_3_create_character(_character_id uuid, _name text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.characters (id, name, is_active, is_visible, availability_status)
  VALUES (_character_id, _name, TRUE, TRUE, 'available'::public.availability_status);
$$;
CREATE OR REPLACE FUNCTION pg_temp.v4_3_create_conversation(_conversation_id uuid, _client_id uuid, _character_id uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.conversations (id, client_id, character_id, status)
  VALUES (_conversation_id, _client_id, _character_id, 'open'::public.conversation_status);
$$;

SELECT pg_temp.v4_3_create_user(
  '00000000-0000-4000-8000-000000000301'::uuid,
  'v4-3-sticker-owner@example.invalid'
);
SELECT pg_temp.v4_3_create_user(
  '00000000-0000-4000-8000-000000000302'::uuid,
  'v4-3-sticker-other-client@example.invalid'
);
SELECT pg_temp.v4_3_create_user(
  '00000000-0000-4000-8000-000000000401'::uuid,
  'v4-3-sticker-operator@example.invalid'
);
SELECT pg_temp.v4_3_add_role('00000000-0000-4000-8000-000000000401'::uuid, 'operator');
SELECT pg_temp.v4_3_create_operator(
  '00000000-0000-4000-8000-000000002401'::uuid,
  '00000000-0000-4000-8000-000000000401'::uuid,
  'V4-3 sticker payout operator'
);
SELECT pg_temp.v4_3_create_character(
  '00000000-0000-4000-8000-000000003301'::uuid,
  'V4-3 sticker character'
);
INSERT INTO public.character_operator_assignments (character_id, operator_id)
VALUES (
  '00000000-0000-4000-8000-000000003301'::uuid,
  '00000000-0000-4000-8000-000000002401'::uuid
);
SELECT pg_temp.v4_3_create_conversation(
  '00000000-0000-4000-8000-000000004401'::uuid,
  '00000000-0000-4000-8000-000000000301'::uuid,
  '00000000-0000-4000-8000-000000003301'::uuid
);
INSERT INTO public.conversation_work_items (
  id,
  conversation_id,
  client_id,
  character_id,
  status,
  responsible_operator_id,
  assigned_at
)
VALUES (
  '00000000-0000-4000-8000-000000005501'::uuid,
  '00000000-0000-4000-8000-000000004401'::uuid,
  '00000000-0000-4000-8000-000000000301'::uuid,
  '00000000-0000-4000-8000-000000003301'::uuid,
  'assigned',
  '00000000-0000-4000-8000-000000002401'::uuid,
  clock_timestamp()
);
INSERT INTO public.conversation_handling_cycles (id, conversation_id, work_item_id, operator_id)
VALUES (
  '00000000-0000-4000-8000-000000006601'::uuid,
  '00000000-0000-4000-8000-000000004401'::uuid,
  '00000000-0000-4000-8000-000000005501'::uuid,
  '00000000-0000-4000-8000-000000002401'::uuid
);
INSERT INTO public.sticker_collections (id, slug, name, character_id, is_active)
VALUES (
  '00000000-0000-4000-8000-000000007701'::uuid,
  'v4-3-paid',
  'V4-3 paid stickers',
  '00000000-0000-4000-8000-000000003301'::uuid,
  TRUE
);
INSERT INTO public.stickers (
  id,
  collection_id,
  slug,
  name,
  object_path,
  width,
  height,
  byte_size,
  is_active,
  ingest_status,
  processed_at,
  price_credits
)
VALUES (
  '00000000-0000-4000-8000-000000008801'::uuid,
  '00000000-0000-4000-8000-000000007701'::uuid,
  'v4-3-paid-sticker',
  'V4-3 paid sticker',
  'collections/00000000-0000-4000-8000-000000007701/stickers/00000000-0000-4000-8000-000000008801/render.webp',
  1,
  1,
  1,
  TRUE,
  'ready',
  clock_timestamp(),
  7
);
UPDATE public.system_settings
SET value = 'true'::jsonb
WHERE key = 'stickers_enabled';
INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
VALUES
  ('00000000-0000-4000-8000-000000000301'::uuid, 20, 20, 0),
  ('00000000-0000-4000-8000-000000000401'::uuid, 0, 0, 0)
ON CONFLICT (user_id) DO UPDATE
SET
  balance = EXCLUDED.balance,
  lifetime_earned = EXCLUDED.lifetime_earned,
  lifetime_spent = EXCLUDED.lifetime_spent;

SELECT plan(17);

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000301';
SELECT is(current_user::text, 'authenticated'::text, 'Sticker owner runs as authenticated');
SELECT is(auth.uid(), '00000000-0000-4000-8000-000000000301'::uuid, 'Sticker owner JWT resolves to auth.uid');

SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000302';
SELECT throws_like(
  $$SELECT public.send_client_sticker_message('00000000-0000-4000-8000-000000004401'::uuid, '00000000-0000-4000-8000-000000008801'::uuid, '00000000-0000-4000-8000-000000009901'::uuid)$$,
  'conversation_access_denied',
  'Other Client cannot send a sticker into the owner conversation'
);

SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000301';
SELECT set_config(
  'v4_3.first_send_response',
  public.send_client_sticker_message(
    '00000000-0000-4000-8000-000000004401'::uuid,
    '00000000-0000-4000-8000-000000008801'::uuid,
    '00000000-0000-4000-8000-000000009901'::uuid
  )::text,
  TRUE
);
SELECT set_config(
  'v4_3.retry_send_response',
  public.send_client_sticker_message(
    '00000000-0000-4000-8000-000000004401'::uuid,
    '00000000-0000-4000-8000-000000008801'::uuid,
    '00000000-0000-4000-8000-000000009901'::uuid
  )::text,
  TRUE
);
SELECT is(
  (current_setting('v4_3.first_send_response')::jsonb ->> 'already_sent')::boolean,
  FALSE,
  'Eligible owner creates a paid sticker message'
);
SELECT is(
  (current_setting('v4_3.retry_send_response')::jsonb ->> 'already_sent')::boolean,
  TRUE,
  'Retry with the same idempotency key returns the original send'
);
SELECT ok(
  (current_setting('v4_3.first_send_response')::jsonb -> 'message' ->> 'id') IS NOT NULL
    AND (current_setting('v4_3.retry_send_response')::jsonb -> 'message' ->> 'id') IS NOT NULL,
  'First send and retry both return a message ID'
);
SELECT is(
  (current_setting('v4_3.first_send_response')::jsonb -> 'message' ->> 'id')::uuid,
  (current_setting('v4_3.retry_send_response')::jsonb -> 'message' ->> 'id')::uuid,
  'First send and idempotent retry return the same message ID'
);

RESET ROLE;
SELECT is(
  (SELECT count(*) FROM public.messages WHERE id = (current_setting('v4_3.first_send_response')::jsonb -> 'message' ->> 'id')::uuid AND conversation_id = '00000000-0000-4000-8000-000000004401'::uuid AND content = '[sticker]'),
  1::bigint,
  'Captured first-send message ID identifies the persisted sticker message'
);
SELECT is(
  (SELECT count(*) FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-000000004401'::uuid),
  1::bigint,
  'Fixture conversation contains exactly one message after first send and retry'
);
SELECT is(
  (SELECT message_id FROM private.sticker_send_attempts WHERE actor_user_id = '00000000-0000-4000-8000-000000000301'::uuid AND idempotency_key = '00000000-0000-4000-8000-000000009901'::uuid),
  (current_setting('v4_3.first_send_response')::jsonb -> 'message' ->> 'id')::uuid,
  'Captured first-send message ID matches the send-attempt row'
);
SELECT is(
  (SELECT count(*) FROM public.message_stickers WHERE message_id = (SELECT message_id FROM private.sticker_send_attempts WHERE actor_user_id = '00000000-0000-4000-8000-000000000301'::uuid AND idempotency_key = '00000000-0000-4000-8000-000000009901'::uuid)),
  1::bigint,
  'Exactly one message sticker exists'
);
SELECT is(
  (SELECT count(*) FROM public.credit_transactions WHERE message_id = (SELECT message_id FROM private.sticker_send_attempts WHERE actor_user_id = '00000000-0000-4000-8000-000000000301'::uuid AND idempotency_key = '00000000-0000-4000-8000-000000009901'::uuid) AND type = 'sticker_spend'),
  1::bigint,
  'Exactly one sticker debit exists'
);
SELECT is(
  (SELECT count(*) FROM public.credit_transactions WHERE message_id = (SELECT message_id FROM private.sticker_send_attempts WHERE actor_user_id = '00000000-0000-4000-8000-000000000301'::uuid AND idempotency_key = '00000000-0000-4000-8000-000000009901'::uuid) AND type = 'sticker_payout'),
  1::bigint,
  'Exactly one operator payout exists'
);
SELECT is(
  (SELECT balance FROM public.credit_wallets WHERE user_id = '00000000-0000-4000-8000-000000000301'::uuid),
  13,
  'Owner balance reflects one debit'
);
SELECT is(
  (SELECT balance FROM public.credit_wallets WHERE user_id = '00000000-0000-4000-8000-000000000401'::uuid),
  7,
  'Operator balance reflects one payout'
);
SELECT ok(
  (
    SELECT message_sticker.charged_transaction_id = debit.id
      AND message_sticker.payer_client_id = '00000000-0000-4000-8000-000000000301'::uuid
      AND debit.message_id = message_sticker.message_id
      AND debit.user_id = '00000000-0000-4000-8000-000000000301'::uuid
      AND debit.type = 'sticker_spend'
      AND debit.amount = -7
    FROM public.message_stickers message_sticker
    JOIN public.credit_transactions debit ON debit.id = message_sticker.charged_transaction_id
    WHERE message_sticker.message_id = (
      SELECT message_id
      FROM private.sticker_send_attempts
      WHERE actor_user_id = '00000000-0000-4000-8000-000000000301'::uuid
        AND idempotency_key = '00000000-0000-4000-8000-000000009901'::uuid
    )
  ),
  'Sticker debit is linked to the message with the correct payer, type, and signed amount'
);
SELECT ok(
  (
    SELECT message_sticker.payout_transaction_id = payout.id
      AND message_sticker.payout_operator_id = '00000000-0000-4000-8000-000000002401'::uuid
      AND payout.message_id = message_sticker.message_id
      AND payout.user_id = '00000000-0000-4000-8000-000000000401'::uuid
      AND payout.type = 'sticker_payout'
      AND payout.amount = 7
    FROM public.message_stickers message_sticker
    JOIN public.credit_transactions payout ON payout.id = message_sticker.payout_transaction_id
    WHERE message_sticker.message_id = (
      SELECT message_id
      FROM private.sticker_send_attempts
      WHERE actor_user_id = '00000000-0000-4000-8000-000000000301'::uuid
        AND idempotency_key = '00000000-0000-4000-8000-000000009901'::uuid
    )
  ),
  'Sticker payout is linked to the message with the correct Operator, type, and signed amount'
);

SELECT * FROM finish();
ROLLBACK;
