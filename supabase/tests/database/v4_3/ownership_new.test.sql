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
  '00000000-0000-4000-8000-000000000101'::uuid,
  'v4-3-owner@example.invalid'
);
SELECT pg_temp.v4_3_create_user(
  '00000000-0000-4000-8000-000000000102'::uuid,
  'v4-3-other-client@example.invalid'
);
SELECT pg_temp.v4_3_create_user(
  '00000000-0000-4000-8000-000000000201'::uuid,
  'v4-3-assigned-operator@example.invalid'
);
SELECT pg_temp.v4_3_create_user(
  '00000000-0000-4000-8000-000000000202'::uuid,
  'v4-3-unassigned-operator@example.invalid'
);
SELECT pg_temp.v4_3_create_user(
  '00000000-0000-4000-8000-000000000203'::uuid,
  'v4-3-blocked-operator@example.invalid'
);
SELECT pg_temp.v4_3_create_user(
  '00000000-0000-4000-8000-000000000204'::uuid,
  'v4-3-competing-operator@example.invalid'
);

SELECT pg_temp.v4_3_add_role('00000000-0000-4000-8000-000000000201'::uuid, 'operator');
SELECT pg_temp.v4_3_add_role('00000000-0000-4000-8000-000000000202'::uuid, 'operator');
SELECT pg_temp.v4_3_add_role('00000000-0000-4000-8000-000000000203'::uuid, 'operator');
SELECT pg_temp.v4_3_add_role('00000000-0000-4000-8000-000000000204'::uuid, 'operator');

SELECT pg_temp.v4_3_create_operator(
  '00000000-0000-4000-8000-000000002201'::uuid,
  '00000000-0000-4000-8000-000000000201'::uuid,
  'V4-3 assigned operator'
);
SELECT pg_temp.v4_3_create_operator(
  '00000000-0000-4000-8000-000000002202'::uuid,
  '00000000-0000-4000-8000-000000000202'::uuid,
  'V4-3 unassigned operator'
);
SELECT pg_temp.v4_3_create_operator(
  '00000000-0000-4000-8000-000000002203'::uuid,
  '00000000-0000-4000-8000-000000000203'::uuid,
  'V4-3 blocked operator'
);
SELECT pg_temp.v4_3_create_operator(
  '00000000-0000-4000-8000-000000002204'::uuid,
  '00000000-0000-4000-8000-000000000204'::uuid,
  'V4-3 competing operator'
);
SELECT pg_temp.v4_3_create_character(
  '00000000-0000-4000-8000-000000003001'::uuid,
  'V4-3 queue character'
);

INSERT INTO public.character_operator_assignments (character_id, operator_id)
VALUES
  ('00000000-0000-4000-8000-000000003001'::uuid, '00000000-0000-4000-8000-000000002201'::uuid),
  ('00000000-0000-4000-8000-000000003001'::uuid, '00000000-0000-4000-8000-000000002203'::uuid),
  ('00000000-0000-4000-8000-000000003001'::uuid, '00000000-0000-4000-8000-000000002204'::uuid);

SELECT pg_temp.v4_3_create_conversation(
  '00000000-0000-4000-8000-000000004001'::uuid,
  '00000000-0000-4000-8000-000000000101'::uuid,
  '00000000-0000-4000-8000-000000003001'::uuid
);
INSERT INTO public.conversation_work_items (
  id,
  conversation_id,
  client_id,
  character_id,
  status,
  last_activity_at
)
VALUES (
  '00000000-0000-4000-8000-000000006001'::uuid,
  '00000000-0000-4000-8000-000000004001'::uuid,
  '00000000-0000-4000-8000-000000000101'::uuid,
  '00000000-0000-4000-8000-000000003001'::uuid,
  'new',
  transaction_timestamp() - INTERVAL '1 second'
);
INSERT INTO public.messages (id, conversation_id, sender_type, sender_id, content)
VALUES (
  '00000000-0000-4000-8000-000000005001'::uuid,
  '00000000-0000-4000-8000-000000004001'::uuid,
  'client'::public.sender_type,
  '00000000-0000-4000-8000-000000000101'::uuid,
  'v4-3 synthetic queue message'
);
INSERT INTO public.operator_client_blocks (operator_id, client_id, reason, created_by_operator_id)
VALUES (
  '00000000-0000-4000-8000-000000002203'::uuid,
  '00000000-0000-4000-8000-000000000101'::uuid,
  'V4-3 test block',
  '00000000-0000-4000-8000-000000002203'::uuid
);

SELECT plan(15);

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000101';
SELECT is(current_user::text, 'authenticated'::text, 'Owner runs as authenticated');
SELECT is(auth.uid(), '00000000-0000-4000-8000-000000000101'::uuid, 'Owner JWT resolves to auth.uid');
SELECT is(
  (SELECT count(*) FROM public.conversations WHERE id = '00000000-0000-4000-8000-000000004001'::uuid),
  1::bigint,
  'Owner can read the owned conversation under RLS'
);

SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000102';
SELECT is(current_user::text, 'authenticated'::text, 'Other Client runs as authenticated');
SELECT is(auth.uid(), '00000000-0000-4000-8000-000000000102'::uuid, 'Other Client JWT resolves to auth.uid');
SELECT is(
  (SELECT count(*) FROM public.conversations WHERE id = '00000000-0000-4000-8000-000000004001'::uuid),
  0::bigint,
  'Other Client cannot read the owner conversation under RLS'
);

SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000201';
SELECT is(auth.uid(), '00000000-0000-4000-8000-000000000201'::uuid, 'Assigned Operator JWT resolves to auth.uid');
SELECT is(
  (SELECT count(*) FROM public.get_operator_new_queue()),
  1::bigint,
  'Assigned Operator sees the canonical NEW work item'
);

SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000202';
SELECT is(
  (SELECT count(*) FROM public.get_operator_new_queue()),
  0::bigint,
  'Unassigned Operator does not see the canonical NEW work item'
);

SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000203';
SELECT is(
  (SELECT count(*) FROM public.get_operator_new_queue()),
  0::bigint,
  'Blocked Operator does not see the canonical NEW work item'
);

SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000201';
SELECT is(
  (public.claim_new_conversation(
    '00000000-0000-4000-8000-000000006001'::uuid
  ) ->> 'claimed')::boolean,
  TRUE,
  'Assigned Operator can claim the NEW work item'
);
RESET ROLE;
SELECT is(
  (SELECT count(*) FROM public.conversation_handling_cycles WHERE conversation_id = '00000000-0000-4000-8000-000000004001'::uuid AND ended_at IS NULL),
  1::bigint,
  'Claim creates exactly one active handling cycle'
);

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000204';
SELECT throws_like(
  $$SELECT public.claim_new_conversation('00000000-0000-4000-8000-000000006001'::uuid)$$,
  'conversation_already_claimed',
  'Competing Operator cannot claim an already claimed work item'
);
RESET ROLE;
SELECT is(
  (SELECT count(*) FROM public.conversation_handling_cycles WHERE conversation_id = '00000000-0000-4000-8000-000000004001'::uuid AND ended_at IS NULL),
  1::bigint,
  'Sequential competing claim leaves one active cycle'
);
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000204';
SELECT is(
  (SELECT count(*) FROM public.get_operator_new_queue()),
  0::bigint,
  'Claimed work item no longer appears in NEW'
);

SELECT * FROM finish();
ROLLBACK;
