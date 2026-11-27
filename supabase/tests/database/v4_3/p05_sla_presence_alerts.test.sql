BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT plan(22);

-- This pgTAP suite is written for the live DB gate. It is intentionally not run Offline.
CREATE OR REPLACE FUNCTION pg_temp.p05_create_user(_id UUID, _email TEXT)
RETURNS VOID LANGUAGE SQL AS $$
  INSERT INTO auth.users (
    id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES (
    _id, 'authenticated', 'authenticated', _email, 'not-used-by-local-tests', clock_timestamp(),
    '{"provider":"email","providers":["email"]}'::JSONB, '{}'::JSONB,
    clock_timestamp(), clock_timestamp()
  );
$$;

SELECT pg_temp.p05_create_user('50000000-0000-4000-8000-000000000101', 'p05-admin-a@example.test');
SELECT pg_temp.p05_create_user('50000000-0000-4000-8000-000000000102', 'p05-admin-b@example.test');
SELECT pg_temp.p05_create_user('50000000-0000-4000-8000-000000000103', 'p05-client@example.test');
SELECT pg_temp.p05_create_user('50000000-0000-4000-8000-000000000104', 'p05-operator-a@example.test');
SELECT pg_temp.p05_create_user('50000000-0000-4000-8000-000000000105', 'p05-operator-b@example.test');
SELECT pg_temp.p05_create_user('50000000-0000-4000-8000-000000000106', 'p05-second-client@example.test');

-- The auth insert trigger supplies the client roles; add only extra roles.
INSERT INTO public.user_roles (user_id, role)
SELECT user_id, 'admin'::public.app_role
FROM (VALUES
  ('50000000-0000-4000-8000-000000000101'::UUID),
  ('50000000-0000-4000-8000-000000000102'::UUID)
) account(user_id);
INSERT INTO public.user_roles (user_id, role) VALUES
  ('50000000-0000-4000-8000-000000000104', 'operator'),
  ('50000000-0000-4000-8000-000000000105', 'operator');

UPDATE public.profiles
SET display_name = CASE user_id
  WHEN '50000000-0000-4000-8000-000000000103'::UUID THEN 'P05 Client'
  WHEN '50000000-0000-4000-8000-000000000106'::UUID THEN 'P05 Second Client'
  WHEN '50000000-0000-4000-8000-000000000104'::UUID THEN 'P05 Operator A'
  ELSE 'P05 Operator B'
END,
status = 'active'
WHERE user_id IN (
  '50000000-0000-4000-8000-000000000103',
  '50000000-0000-4000-8000-000000000104',
  '50000000-0000-4000-8000-000000000105',
  '50000000-0000-4000-8000-000000000106'
);

INSERT INTO public.operators (id, user_id, full_name, is_active, availability_status, presence_status, last_seen_at)
VALUES
  ('50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000104', 'P05 A', TRUE, 'available', 'online', clock_timestamp()),
  ('50000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000105', 'P05 B', TRUE, 'available', 'online', clock_timestamp() - interval '3 minutes');

INSERT INTO public.characters (id, name, is_active, is_visible, availability_status)
VALUES ('50000000-0000-4000-8000-000000000010', 'P05 Character', TRUE, TRUE, 'available');

INSERT INTO public.character_operator_assignments (character_id, operator_id)
VALUES ('50000000-0000-4000-8000-000000000010', '50000000-0000-4000-8000-000000000001');

-- Two visible open waits on the same character must have different clients.
INSERT INTO public.conversations (
  id, client_id, character_id, status, needs_handling, pending_since
)
VALUES
  ('50000000-0000-4000-8000-000000000020', '50000000-0000-4000-8000-000000000106', '50000000-0000-4000-8000-000000000010', 'open', TRUE, clock_timestamp() - interval '419 seconds'),
  ('50000000-0000-4000-8000-000000000021', '50000000-0000-4000-8000-000000000103', '50000000-0000-4000-8000-000000000010', 'open', TRUE, clock_timestamp() - interval '421 seconds');

SET LOCAL ROLE service_role;
SET LOCAL "request.jwt.claim.role" = 'service_role';
SET LOCAL "request.jwt.claim.sub" = '';
SELECT is(public.emit_operational_wait_alerts(100), 1, 'only the wait at 420 seconds is emitted');
SELECT is(
  (SELECT count(*) FROM public.notifications WHERE conversation_id = '50000000-0000-4000-8000-000000000020'),
  0::BIGINT,
  '419 seconds remains below the alert threshold'
);
SELECT is(
  (SELECT count(*) FROM public.notifications WHERE conversation_id = '50000000-0000-4000-8000-000000000021'),
  2::BIGINT,
  'one notification is created for each authorized admin recipient'
);
SELECT is(public.emit_operational_wait_alerts(100), 0, 'polling and retry do not duplicate a wait event');
SELECT is(
  (SELECT count(DISTINCT metadata ->> 'dedupe_key') FROM public.notifications WHERE conversation_id = '50000000-0000-4000-8000-000000000021'),
  1::BIGINT,
  'all recipients share the canonical wait-event key'
);

UPDATE public.conversations
SET needs_handling = FALSE, pending_since = NULL
WHERE id = '50000000-0000-4000-8000-000000000021';

SELECT is(
  (SELECT count(*) FROM public.notifications WHERE conversation_id = '50000000-0000-4000-8000-000000000021' AND metadata ->> 'state' = 'resolved'),
  2::BIGINT,
  'successful response resolves every active recipient notification'
);
SELECT is(
  (SELECT count(*) FROM public.notifications WHERE conversation_id = '50000000-0000-4000-8000-000000000021' AND is_read IS FALSE),
  2::BIGINT,
  'resolution does not force notification read state'
);
RESET ROLE;
SELECT ok(
  (SELECT responded_at IS NOT NULL FROM private.conversation_operational_wait_cycles WHERE conversation_id = '50000000-0000-4000-8000-000000000021' LIMIT 1),
  'the canonical wait cycle preserves its response timestamp'
);
SET LOCAL ROLE service_role;

UPDATE public.conversations
SET needs_handling = TRUE, pending_since = clock_timestamp() - interval '421 seconds'
WHERE id = '50000000-0000-4000-8000-000000000021';
SELECT is(public.emit_operational_wait_alerts(100), 1, 'a new wait event may emit a new alert');
SELECT is(
  (SELECT count(DISTINCT metadata ->> 'wait_event_key') FROM public.notifications WHERE conversation_id = '50000000-0000-4000-8000-000000000021'),
  2::BIGINT,
  'the new wait has a distinct event identity'
);

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '50000000-0000-4000-8000-000000000103';
SELECT throws_ok(
  $$SELECT public.send_operator_message('50000000-0000-4000-8000-000000000021', 'not allowed', NULL::UUID)$$,
  'P0001',
  'operator_record_required',
  'failed send is rejected'
);
SELECT ok(
  (SELECT needs_handling FROM public.conversations WHERE id = '50000000-0000-4000-8000-000000000021'),
  'failed send does not close the wait'
);
RESET ROLE;
SELECT is(
  (SELECT count(*) FROM public.notifications WHERE conversation_id = '50000000-0000-4000-8000-000000000021' AND metadata ->> 'state' = 'active'),
  2::BIGINT,
  'failed send does not resolve the active alert'
);

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '50000000-0000-4000-8000-000000000103';
SELECT is(
  (SELECT availability_status::TEXT FROM public.get_character_live_availability(ARRAY['50000000-0000-4000-8000-000000000010'::UUID])),
  'available',
  'an assigned active connected operator makes the character available'
);
RESET ROLE;
UPDATE public.operators SET last_seen_at = clock_timestamp() - interval '3 minutes' WHERE id = '50000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT availability_status::TEXT FROM public.get_character_live_availability(ARRAY['50000000-0000-4000-8000-000000000010'::UUID])),
  'offline',
  'an expired heartbeat removes online availability'
);
RESET ROLE;
INSERT INTO public.character_operator_assignments (character_id, operator_id)
VALUES ('50000000-0000-4000-8000-000000000010', '50000000-0000-4000-8000-000000000002');
UPDATE public.operators SET last_seen_at = clock_timestamp() WHERE id = '50000000-0000-4000-8000-000000000002';
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT availability_status::TEXT FROM public.get_character_live_availability(ARRAY['50000000-0000-4000-8000-000000000010'::UUID])),
  'available',
  'another assigned operator with a valid heartbeat keeps the character available'
);
RESET ROLE;
UPDATE public.operators SET is_active = FALSE WHERE id = '50000000-0000-4000-8000-000000000002';
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT availability_status::TEXT FROM public.get_character_live_availability(ARRAY['50000000-0000-4000-8000-000000000010'::UUID])),
  'offline',
  'inactive operators cannot make a character online'
);

SET LOCAL "request.jwt.claim.sub" = '50000000-0000-4000-8000-000000000101';
SELECT is(
  (SELECT presence_status FROM public.get_admin_operator_presence_overview() WHERE operator_id = '50000000-0000-4000-8000-000000000002'),
  'offline',
  'admin presence uses active state and the heartbeat contract'
);
SELECT is(
  (SELECT target_seconds FROM public.get_admin_operational_wait_summary()),
  420,
  'the operational target is exactly seven minutes'
);
SELECT ok(
  (SELECT oldest_wait_seconds >= 420 FROM public.get_admin_operational_wait_summary()),
  'wait age is derived from server timestamps continuously'
);
RESET ROLE;
SELECT lives_ok(
  $$SELECT private.run_new_sla_critical_scheduler()$$,
  'the existing scheduler entry point is connected to the operational alert path'
);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT count(*) FROM public.notifications WHERE type = 'operational_wait_alert' AND metadata ? 'wait_event_key'),
  4::BIGINT,
  'only the two canonical wait events produced operational notifications'
);

SELECT * FROM finish();
ROLLBACK;
