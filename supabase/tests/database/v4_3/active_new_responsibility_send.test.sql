BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;

CREATE OR REPLACE FUNCTION pg_temp.v4_3_e1_create_user(_id uuid, _email text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO auth.users (
    id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES (
    _id, 'authenticated', 'authenticated', _email, 'not-used-by-local-tests', clock_timestamp(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp()
  );
$$;

CREATE OR REPLACE FUNCTION pg_temp.v4_3_e1_counts()
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'messages', (SELECT count(*) FROM public.messages),
    'attachments', (SELECT count(*) FROM public.message_attachments),
    'sticker_attempts', (SELECT count(*) FROM private.sticker_send_attempts),
    'scores', (SELECT count(*) FROM public.operator_score_events),
    'ledger', (SELECT count(*) FROM public.credit_transactions),
    'notifications', (SELECT count(*) FROM public.notifications),
    'analytics', (SELECT count(*) FROM public.analytics_events)
  );
$$;

SELECT pg_temp.v4_3_e1_create_user('00000000-0000-4000-8000-000000090101', 'v4-3-e1-client@example.invalid');
SELECT pg_temp.v4_3_e1_create_user('00000000-0000-4000-8000-000000090102', 'v4-3-e1-owner@example.invalid');
SELECT pg_temp.v4_3_e1_create_user('00000000-0000-4000-8000-000000090103', 'v4-3-e1-other@example.invalid');
SELECT pg_temp.v4_3_e1_create_user('00000000-0000-4000-8000-000000090104', 'v4-3-e1-admin-worker@example.invalid');

INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-4000-8000-000000090102', 'operator'),
  ('00000000-0000-4000-8000-000000090103', 'operator'),
  ('00000000-0000-4000-8000-000000090104', 'operator'),
  ('00000000-0000-4000-8000-000000090104', 'admin');

INSERT INTO public.operators (id, user_id, full_name, is_active, availability_status, presence_status, last_seen_at) VALUES
  ('00000000-0000-4000-8000-000000091102', '00000000-0000-4000-8000-000000090102', 'V4-3-E1 owner', true, 'available', 'online', clock_timestamp()),
  ('00000000-0000-4000-8000-000000091103', '00000000-0000-4000-8000-000000090103', 'V4-3-E1 other', true, 'available', 'online', clock_timestamp()),
  ('00000000-0000-4000-8000-000000091104', '00000000-0000-4000-8000-000000090104', 'V4-3-E1 admin worker', true, 'available', 'online', clock_timestamp());

INSERT INTO public.characters (id, name, is_active, is_visible, availability_status) VALUES
  ('00000000-0000-4000-8000-000000092101', 'V4-3-E1 blocked character', true, true, 'available'),
  ('00000000-0000-4000-8000-000000092102', 'V4-3-E1 owner character', true, true, 'available'),
  ('00000000-0000-4000-8000-000000092103', 'V4-3-E1 admin character', true, true, 'available');

INSERT INTO public.character_operator_assignments (character_id, operator_id)
SELECT character_id, operator_id
FROM (VALUES
  ('00000000-0000-4000-8000-000000092101'::uuid),
  ('00000000-0000-4000-8000-000000092102'::uuid),
  ('00000000-0000-4000-8000-000000092103'::uuid)
) AS characters(character_id)
CROSS JOIN (VALUES
  ('00000000-0000-4000-8000-000000091102'::uuid),
  ('00000000-0000-4000-8000-000000091103'::uuid),
  ('00000000-0000-4000-8000-000000091104'::uuid)
) AS operators(operator_id);

INSERT INTO public.conversations (id, client_id, character_id, assigned_operator_id, status) VALUES
  ('00000000-0000-4000-8000-000000093101', '00000000-0000-4000-8000-000000090101', '00000000-0000-4000-8000-000000092101', '00000000-0000-4000-8000-000000091102', 'open'),
  ('00000000-0000-4000-8000-000000093102', '00000000-0000-4000-8000-000000090101', '00000000-0000-4000-8000-000000092102', '00000000-0000-4000-8000-000000091102', 'open'),
  ('00000000-0000-4000-8000-000000093103', '00000000-0000-4000-8000-000000090101', '00000000-0000-4000-8000-000000092103', '00000000-0000-4000-8000-000000091102', 'open');

INSERT INTO public.conversation_work_items (id, conversation_id, client_id, character_id, status, responsible_operator_id, assigned_at, last_activity_at) VALUES
  ('00000000-0000-4000-8000-000000094101', '00000000-0000-4000-8000-000000093101', '00000000-0000-4000-8000-000000090101', '00000000-0000-4000-8000-000000092101', 'assigned', '00000000-0000-4000-8000-000000091102', clock_timestamp(), clock_timestamp()),
  ('00000000-0000-4000-8000-000000094102', '00000000-0000-4000-8000-000000093102', '00000000-0000-4000-8000-000000090101', '00000000-0000-4000-8000-000000092102', 'assigned', '00000000-0000-4000-8000-000000091102', clock_timestamp(), clock_timestamp()),
  ('00000000-0000-4000-8000-000000094103', '00000000-0000-4000-8000-000000093103', '00000000-0000-4000-8000-000000090101', '00000000-0000-4000-8000-000000092103', 'assigned', '00000000-0000-4000-8000-000000091102', clock_timestamp(), clock_timestamp());

INSERT INTO public.conversation_handling_cycles (conversation_id, work_item_id, operator_id) VALUES
  ('00000000-0000-4000-8000-000000093101', '00000000-0000-4000-8000-000000094101', '00000000-0000-4000-8000-000000091102'),
  ('00000000-0000-4000-8000-000000093102', '00000000-0000-4000-8000-000000094102', '00000000-0000-4000-8000-000000091102'),
  ('00000000-0000-4000-8000-000000093103', '00000000-0000-4000-8000-000000094103', '00000000-0000-4000-8000-000000091102');

SELECT plan(21);

SELECT is(
  has_function_privilege(
    'anon',
    'private.assert_operator_can_send_conversation_message(uuid,boolean)'::regprocedure,
    'EXECUTE'
  ),
  false,
  'Anonymous callers cannot execute the two-argument active-cycle guard'
);
SELECT is(
  has_function_privilege(
    'authenticated',
    'private.assert_operator_can_send_conversation_message(uuid,boolean)'::regprocedure,
    'EXECUTE'
  ),
  false,
  'Authenticated callers cannot opt out of active-cycle ownership checks'
);
SELECT is(
  has_function_privilege(
    'service_role',
    'private.assert_operator_can_send_conversation_message(uuid,boolean)'::regprocedure,
    'EXECUTE'
  ),
  false,
  'service_role has no direct execute grant on the two-argument guard'
);
SELECT is(
  has_function_privilege(
    'anon',
    'private.assert_operator_can_send_conversation_message(uuid)'::regprocedure,
    'EXECUTE'
  ),
  false,
  'Anonymous callers cannot execute the one-argument send guard'
);
SELECT is(
  has_function_privilege(
    'authenticated',
    'private.assert_operator_can_send_conversation_message(uuid)'::regprocedure,
    'EXECUTE'
  ),
  false,
  'Authenticated callers cannot execute the one-argument send guard'
);
SELECT is(
  has_function_privilege(
    'service_role',
    'private.assert_operator_can_send_conversation_message(uuid)'::regprocedure,
    'EXECUTE'
  ),
  false,
  'service_role has no direct execute grant on the one-argument send guard'
);
SELECT is(
  (
    SELECT role.rolname
    FROM pg_proc proc
    JOIN pg_roles role ON role.oid = proc.proowner
    WHERE proc.oid = 'private.assert_operator_can_send_conversation_message(uuid,boolean)'::regprocedure
  ),
  'postgres',
  'The internal active-cycle guard remains owned by postgres'
);

SELECT set_config('v4_3_e1.before_other', pg_temp.v4_3_e1_counts()::text, true);
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000090103';
SELECT is(current_user::text, 'authenticated'::text, 'Other assigned operator runs as authenticated');
SELECT is(auth.uid(), '00000000-0000-4000-8000-000000090103'::uuid, 'Other assigned operator JWT resolves');
SELECT throws_like(
  $$SELECT public.send_operator_message('00000000-0000-4000-8000-000000093101'::uuid, 'blocked other operator')$$,
  'conversation_not_responsible_operator',
  'Other assigned operator cannot send while another active cycle owns the conversation'
);
SELECT throws_like(
  $$SELECT public.send_operator_sticker_message('00000000-0000-4000-8000-000000093101'::uuid, '00000000-0000-4000-8000-000000095101'::uuid, '00000000-0000-4000-8000-000000095102'::uuid)$$,
  'conversation_not_responsible_operator',
  'Other assigned operator cannot send a Sticker while another active cycle owns the conversation'
);
RESET ROLE;
SELECT is(pg_temp.v4_3_e1_counts(), current_setting('v4_3_e1.before_other')::jsonb, 'Rejected other-operator send has no message, attachment, sticker, score, ledger, notification, or analytics side effect');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000090102';
SELECT lives_ok(
  $$SELECT public.send_operator_message('00000000-0000-4000-8000-000000093102'::uuid, 'owner response')$$,
  'Cycle owner can send an operator message'
);
RESET ROLE;
SELECT is(
  (SELECT count(*) FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-000000093102'::uuid AND sender_id = '00000000-0000-4000-8000-000000090102'::uuid),
  1::bigint,
  'Owner response persists exactly once'
);

SELECT set_config('v4_3_e1.before_admin', pg_temp.v4_3_e1_counts()::text, true);
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000090104';
SELECT is(auth.uid(), '00000000-0000-4000-8000-000000090104'::uuid, 'Admin worker JWT resolves');
SELECT throws_like(
  $$SELECT public.send_operator_message('00000000-0000-4000-8000-000000093103'::uuid, 'blocked admin worker')$$,
  'conversation_not_responsible_operator',
  'Admin worker cannot silently bypass another operator active cycle'
);
RESET ROLE;
SELECT is(pg_temp.v4_3_e1_counts(), current_setting('v4_3_e1.before_admin')::jsonb, 'Rejected Admin worker send has no side effect');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000090102';
SELECT lives_ok(
  $$SELECT public.release_operator_conversation('00000000-0000-4000-8000-000000093101'::uuid, 'released')$$,
  'Cycle owner can explicitly release responsibility'
);
RESET ROLE;
SELECT is(
  (SELECT count(*) FROM public.conversation_handling_cycles WHERE conversation_id = '00000000-0000-4000-8000-000000093101'::uuid AND ended_at IS NULL),
  0::bigint,
  'Explicit release ends the active cycle'
);

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000090103';
SELECT lives_ok(
  $$SELECT public.send_operator_message('00000000-0000-4000-8000-000000093101'::uuid, 'post release response')$$,
  'Assigned Operator can send after an explicit release leaves no active cycle'
);
RESET ROLE;
SELECT is(
  (SELECT count(*) FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-000000093101'::uuid AND sender_id = '00000000-0000-4000-8000-000000090103'::uuid),
  1::bigint,
  'Post-release response persists exactly once'
);

SELECT * FROM finish();
ROLLBACK;
