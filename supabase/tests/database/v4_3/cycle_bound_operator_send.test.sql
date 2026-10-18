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
INSERT INTO public.conversations (id, client_id, character_id, assigned_operator_id, status) VALUES
  ('00000000-0000-4000-8000-0000000b3101', '00000000-0000-4000-8000-0000000b0101', '00000000-0000-4000-8000-0000000b2101', '00000000-0000-4000-8000-0000000b1102', 'open'),
  ('00000000-0000-4000-8000-0000000b3102', '00000000-0000-4000-8000-0000000b0101', '00000000-0000-4000-8000-0000000b2102', NULL, 'open');
INSERT INTO public.conversation_work_items (id, conversation_id, client_id, character_id, status, responsible_operator_id, assigned_at, last_activity_at)
VALUES ('00000000-0000-4000-8000-0000000b5101', '00000000-0000-4000-8000-0000000b3101', '00000000-0000-4000-8000-0000000b0101', '00000000-0000-4000-8000-0000000b2101', 'assigned', '00000000-0000-4000-8000-0000000b1102', clock_timestamp(), clock_timestamp());
INSERT INTO public.conversation_handling_cycles (id, conversation_id, work_item_id, operator_id)
VALUES ('00000000-0000-4000-8000-0000000b6101', '00000000-0000-4000-8000-0000000b3101', '00000000-0000-4000-8000-0000000b5101', '00000000-0000-4000-8000-0000000b1102');

SELECT plan(14);
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

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000b0103';
SELECT lives_ok(
  $$SELECT public.send_operator_message('00000000-0000-4000-8000-0000000b3102'::uuid, 'atomic first response', NULL::uuid)$$,
  'No-cycle conversation atomically claims and sends for an assigned operator'
);
RESET ROLE;
SELECT is((SELECT count(*) FROM public.conversation_handling_cycles WHERE conversation_id = '00000000-0000-4000-8000-0000000b3102'::uuid AND ended_at IS NULL), 1::bigint, 'Atomic send creates exactly one active cycle');
SELECT is((SELECT count(*) FROM private.handling_send_authority_evidence evidence JOIN public.messages message ON message.id = evidence.message_id WHERE message.content = 'atomic first response' AND evidence.authority_source = 'atomic_claim_and_send'), 1::bigint, 'Atomic send records atomic-claim authority evidence');
SELECT is((SELECT responsible_operator_id FROM public.conversation_work_items WHERE conversation_id = '00000000-0000-4000-8000-0000000b3102'::uuid AND status IN ('assigned', 'in_progress')), '00000000-0000-4000-8000-0000000b1103'::uuid, 'Atomic send assigns responsibility to the sending operator');

SELECT * FROM finish();
ROLLBACK;