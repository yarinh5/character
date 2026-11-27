BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;

CREATE OR REPLACE FUNCTION pg_temp.wp01_4_create_user(_id uuid, _email text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO auth.users (
    id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES (
    _id, 'authenticated', 'authenticated', _email, 'not-used-by-local-tests', clock_timestamp(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp()
  );
$$;

CREATE OR REPLACE FUNCTION pg_temp.wp01_4_send_counts()
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'messages', (SELECT count(*) FROM public.messages),
    'evidence', (SELECT count(*) FROM private.handling_send_authority_evidence),
    'ledger', (SELECT count(*) FROM public.credit_transactions),
    'notifications', (SELECT count(*) FROM public.notifications),
    'analytics', (SELECT count(*) FROM public.analytics_events)
  );
$$;

SELECT pg_temp.wp01_4_create_user('00000000-0000-4000-8000-0000000b0101', 'v4-3-wp01-4-client@example.invalid');
SELECT pg_temp.wp01_4_create_user('00000000-0000-4000-8000-0000000b0102', 'v4-3-wp01-4-owner@example.invalid');
SELECT pg_temp.wp01_4_create_user('00000000-0000-4000-8000-0000000b0103', 'v4-3-wp01-4-other@example.invalid');

INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-4000-8000-0000000b0102', 'operator'),
  ('00000000-0000-4000-8000-0000000b0103', 'operator');
INSERT INTO public.operators (id, user_id, full_name, is_active, availability_status, presence_status, last_seen_at) VALUES
  ('00000000-0000-4000-8000-0000000b1102', '00000000-0000-4000-8000-0000000b0102', 'WP01.4 owner', true, 'available', 'online', clock_timestamp()),
  ('00000000-0000-4000-8000-0000000b1103', '00000000-0000-4000-8000-0000000b0103', 'WP01.4 other', true, 'available', 'online', clock_timestamp());
INSERT INTO public.characters (id, name, is_active, is_visible, availability_status) VALUES
  ('00000000-0000-4000-8000-0000000b2101', 'WP01.4 strict character', true, true, 'available'),
  ('00000000-0000-4000-8000-0000000b2102', 'WP01.4 atomic character', true, true, 'available');
INSERT INTO public.character_operator_assignments (character_id, operator_id)
SELECT character_id, operator_id
FROM (VALUES
  ('00000000-0000-4000-8000-0000000b2101'::uuid),
  ('00000000-0000-4000-8000-0000000b2102'::uuid)
) characters(character_id)
CROSS JOIN (VALUES
  ('00000000-0000-4000-8000-0000000b1102'::uuid),
  ('00000000-0000-4000-8000-0000000b1103'::uuid)
) operators(operator_id);

WITH owner_activity AS (SELECT clock_timestamp() AS activity_at)
INSERT INTO public.conversations (
  id, client_id, character_id, assigned_operator_id, status,
  last_business_message_at, inactivity_expires_at
)
SELECT
  '00000000-0000-4000-8000-0000000b3101', '00000000-0000-4000-8000-0000000b0101',
  '00000000-0000-4000-8000-0000000b2101', '00000000-0000-4000-8000-0000000b1102',
  'open', activity_at, activity_at + interval '180 seconds'
FROM owner_activity;

INSERT INTO public.conversations (id, client_id, character_id, assigned_operator_id, status) VALUES
  ('00000000-0000-4000-8000-0000000b3102', '00000000-0000-4000-8000-0000000b0101', '00000000-0000-4000-8000-0000000b2102', NULL, 'open');
INSERT INTO public.conversation_work_items (id, conversation_id, client_id, character_id, status, responsible_operator_id, assigned_at, last_activity_at)
VALUES ('00000000-0000-4000-8000-0000000b5101', '00000000-0000-4000-8000-0000000b3101', '00000000-0000-4000-8000-0000000b0101', '00000000-0000-4000-8000-0000000b2101', 'assigned', '00000000-0000-4000-8000-0000000b1102', clock_timestamp(), clock_timestamp());
INSERT INTO public.conversation_handling_cycles (id, conversation_id, work_item_id, operator_id)
VALUES ('00000000-0000-4000-8000-0000000b6101', '00000000-0000-4000-8000-0000000b3101', '00000000-0000-4000-8000-0000000b5101', '00000000-0000-4000-8000-0000000b1102');

-- A client request projects pending work and routes it into the NEW queue.
INSERT INTO public.messages (id, conversation_id, sender_type, sender_id, content, created_at)
VALUES (
  '00000000-0000-4000-8000-0000000b7102', '00000000-0000-4000-8000-0000000b3102',
  'client', '00000000-0000-4000-8000-0000000b0101', 'pending request for atomic claim', clock_timestamp()
);

SELECT plan(21);
SELECT ok(to_regprocedure('public.send_operator_message(uuid,text,uuid)') IS NOT NULL, 'Strict text send overload exists');
SELECT set_config('wp01_4.before_rejected', pg_temp.wp01_4_send_counts()::text, true);
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000b0103';
SELECT throws_like(
  $$SELECT public.send_operator_message('00000000-0000-4000-8000-0000000b3101'::uuid, 'missing token', NULL::uuid)$$,
  'handling_cycle_token_invalid',
  'Missing token is rejected before the send body'
);
SELECT throws_like(
  $$SELECT public.send_operator_message('00000000-0000-4000-8000-0000000b3101'::uuid, 'foreign token', '00000000-0000-4000-8000-0000000b6101'::uuid)$$,
  'conversation_not_responsible_operator',
  'A co-assigned non-owner cannot use the active cycle token'
);
RESET ROLE;
SELECT is(pg_temp.wp01_4_send_counts(), current_setting('wp01_4.before_rejected')::jsonb, 'Rejected token attempts create no send side effects');

SELECT ok(EXISTS (
  SELECT 1 FROM public.conversations
  WHERE id = '00000000-0000-4000-8000-0000000b3101'
    AND inactivity_expires_at = last_business_message_at + interval '180 seconds'
    AND inactivity_expires_at > clock_timestamp()
), 'Owner conversation is inside its 180-second business activity window');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000b0102';
SELECT throws_like(
  $$SELECT public.send_operator_message('00000000-0000-4000-8000-0000000b3101'::uuid, 'legacy endpoint', NULL::uuid)$$,
  'handling_cycle_token_invalid',
  'The strict endpoint rejects a null token while a cycle is active'
);
SELECT lives_ok(
  $$SELECT public.send_operator_message('00000000-0000-4000-8000-0000000b3101'::uuid, 'owner strict response', '00000000-0000-4000-8000-0000000b6101'::uuid)$$,
  'Cycle owner sends with the exact active token'
);
RESET ROLE;
SELECT is((SELECT count(*) FROM public.messages WHERE content = 'owner strict response'), 1::bigint, 'Owner strict response persists once');
SELECT is((SELECT handling_effect FROM public.messages WHERE content = 'owner strict response'), 'staff_response', 'Owner strict response is a staff response');
SELECT is((SELECT handling_cycle_id FROM public.messages WHERE content = 'owner strict response'), '00000000-0000-4000-8000-0000000b6101'::uuid, 'Owner strict response stores the exact cycle');
SELECT is((SELECT count(*) FROM private.handling_send_authority_evidence evidence JOIN public.messages message ON message.id = evidence.message_id WHERE message.content = 'owner strict response' AND evidence.authority_source = 'cycle_token'), 1::bigint, 'Owner strict response records cycle-token authority evidence');

SELECT is((
  SELECT count(*)
  FROM public.conversations conversation
  JOIN public.messages message ON message.conversation_id = conversation.id
  JOIN public.conversation_work_items work_item ON work_item.conversation_id = conversation.id
  WHERE conversation.id = '00000000-0000-4000-8000-0000000b3102'
    AND message.id = '00000000-0000-4000-8000-0000000b7102'
    AND conversation.assigned_operator_id IS NULL
    AND conversation.needs_handling IS TRUE
    AND conversation.pending_since = message.created_at
    AND conversation.last_business_message_at = message.created_at
    AND conversation.inactivity_expires_at = message.created_at + interval '180 seconds'
    AND conversation.inactivity_expires_at > clock_timestamp()
    AND work_item.last_client_message_id = message.id
    AND work_item.status = 'new' AND work_item.responsible_operator_id IS NULL
    AND work_item.assigned_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.conversation_handling_cycles cycle
      WHERE cycle.conversation_id = conversation.id AND cycle.ended_at IS NULL
    )
), 1::bigint, 'Client request is pending with one unowned NEW work item and no active cycle');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000b0103';
SELECT lives_ok(
  $$SELECT public.send_operator_message('00000000-0000-4000-8000-0000000b3102'::uuid, 'atomic first response', NULL::uuid)$$,
  'Assigned operator atomically claims pending NEW work and sends without a prior cycle'
);
RESET ROLE;
SELECT is((SELECT count(*) FROM public.conversation_handling_cycles WHERE conversation_id = '00000000-0000-4000-8000-0000000b3102'::uuid AND ended_at IS NULL), 1::bigint, 'Atomic send creates exactly one active cycle');
SELECT is((SELECT count(*) FROM private.handling_send_authority_evidence evidence JOIN public.messages message ON message.id = evidence.message_id WHERE message.content = 'atomic first response' AND evidence.authority_source = 'atomic_claim_and_send'), 1::bigint, 'Atomic send records atomic-claim authority evidence');
SELECT is((SELECT responsible_operator_id FROM public.conversation_work_items WHERE conversation_id = '00000000-0000-4000-8000-0000000b3102'::uuid AND status IN ('assigned', 'in_progress')), '00000000-0000-4000-8000-0000000b1103'::uuid, 'Atomic send assigns responsibility to the sending operator');

-- Fresh conversations keep these rejections independent of the two successful sends.
SELECT pg_temp.wp01_4_create_user('00000000-0000-4000-8000-0000000b0104', 'wp01-expiry-client@example.invalid');
SELECT pg_temp.wp01_4_create_user('00000000-0000-4000-8000-0000000b0105', 'wp01-stale-client@example.invalid');
INSERT INTO public.conversations (id, client_id, character_id, assigned_operator_id, status) VALUES
  ('00000000-0000-4000-8000-0000000b3103', '00000000-0000-4000-8000-0000000b0104', '00000000-0000-4000-8000-0000000b2101', '00000000-0000-4000-8000-0000000b1103', 'open'),
  ('00000000-0000-4000-8000-0000000b3105', '00000000-0000-4000-8000-0000000b0104', '00000000-0000-4000-8000-0000000b2102', NULL, 'open');

WITH stale_activity AS (SELECT clock_timestamp() - interval '181 seconds' AS activity_at)
INSERT INTO public.conversations (
  id, client_id, character_id, assigned_operator_id, status, last_business_message_at, inactivity_expires_at
)
SELECT '00000000-0000-4000-8000-0000000b3104', '00000000-0000-4000-8000-0000000b0105',
       '00000000-0000-4000-8000-0000000b2101', '00000000-0000-4000-8000-0000000b1103',
       'open', activity_at, activity_at + interval '180 seconds'
FROM stale_activity;

INSERT INTO public.conversation_work_items (
  conversation_id, client_id, character_id, status, responsible_operator_id, assigned_at
)
SELECT id, client_id, character_id, 'assigned', assigned_operator_id, clock_timestamp()
FROM public.conversations
WHERE id IN ('00000000-0000-4000-8000-0000000b3103', '00000000-0000-4000-8000-0000000b3104');

INSERT INTO public.conversation_handling_cycles (id, conversation_id, work_item_id, operator_id)
SELECT target.cycle_id, item.conversation_id, item.id, item.responsible_operator_id
FROM (VALUES
  ('00000000-0000-4000-8000-0000000b3103'::uuid, '00000000-0000-4000-8000-0000000b6103'::uuid),
  ('00000000-0000-4000-8000-0000000b3104'::uuid, '00000000-0000-4000-8000-0000000b6104'::uuid)
) target(conversation_id, cycle_id)
JOIN public.conversation_work_items item ON item.conversation_id = target.conversation_id;

SELECT ok(
  EXISTS (SELECT 1 FROM public.conversations WHERE id = '00000000-0000-4000-8000-0000000b3103'
          AND inactivity_expires_at IS NULL)
  AND EXISTS (SELECT 1 FROM public.conversations WHERE id = '00000000-0000-4000-8000-0000000b3104'
              AND inactivity_expires_at = last_business_message_at + interval '180 seconds'
              AND inactivity_expires_at <= clock_timestamp())
  AND EXISTS (SELECT 1 FROM public.conversations c WHERE id = '00000000-0000-4000-8000-0000000b3105'
              AND c.status = 'open' AND c.assigned_operator_id IS NULL
              AND c.needs_handling IS NOT TRUE AND c.pending_since IS NULL
              AND NOT EXISTS (SELECT 1 FROM public.conversation_handling_cycles h
                              WHERE h.conversation_id = c.id AND h.ended_at IS NULL)),
  'Rejection fixtures distinguish missing expiry, elapsed expiry and open non-pending work'
);

SELECT set_config('wp01_4.before_invalid_states', pg_temp.wp01_4_send_counts()::text, true);
-- The last authenticated caller is the same co-assigned operator who owns these two cycles.
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$SELECT public.send_operator_message('00000000-0000-4000-8000-0000000b3103', 'absent expiry', '00000000-0000-4000-8000-0000000b6103')$$,
  'P0001', 'handling_cycle_expired', 'Exact owner token cannot send with a missing expiry'
);
SELECT throws_ok(
  $$SELECT public.send_operator_message('00000000-0000-4000-8000-0000000b3104', 'expired window', '00000000-0000-4000-8000-0000000b6104')$$,
  'P0001', 'handling_cycle_expired', 'Exact owner token cannot send after expiry'
);
SELECT throws_ok(
  $$SELECT public.send_operator_message('00000000-0000-4000-8000-0000000b3105', 'no pending request', NULL::uuid)$$,
  'P0001', 'conversation_not_available_for_claim', 'An open conversation without pending work cannot be claimed on send'
);
RESET ROLE;
SELECT is(pg_temp.wp01_4_send_counts(), current_setting('wp01_4.before_invalid_states')::jsonb,
  'Rejected expiry and claim probes leave message, authority, ledger, notification and analytics counts unchanged');

SELECT * FROM finish();
ROLLBACK;
