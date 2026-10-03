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

SELECT pg_temp.v4_3_create_user('00000000-0000-4000-8000-000000040101'::uuid, 'v4-3-d1-admin@example.invalid');
SELECT pg_temp.v4_3_create_user('00000000-0000-4000-8000-000000040102'::uuid, 'v4-3-d1-client@example.invalid');
SELECT pg_temp.v4_3_create_user('00000000-0000-4000-8000-000000040103'::uuid, 'v4-3-d1-non-admin-client@example.invalid');
SELECT pg_temp.v4_3_create_user('00000000-0000-4000-8000-000000040104'::uuid, 'v4-3-d1-non-admin-operator@example.invalid');
SELECT pg_temp.v4_3_create_user('00000000-0000-4000-8000-000000040105'::uuid, 'v4-3-d1-admin-target@example.invalid');
SELECT pg_temp.v4_3_create_user('00000000-0000-4000-8000-000000040106'::uuid, 'v4-3-d1-operator-target@example.invalid');

SELECT pg_temp.v4_3_add_role('00000000-0000-4000-8000-000000040101'::uuid, 'admin');
SELECT pg_temp.v4_3_add_role('00000000-0000-4000-8000-000000040102'::uuid, 'client');
SELECT pg_temp.v4_3_add_role('00000000-0000-4000-8000-000000040103'::uuid, 'client');
SELECT pg_temp.v4_3_add_role('00000000-0000-4000-8000-000000040104'::uuid, 'operator');
SELECT pg_temp.v4_3_add_role('00000000-0000-4000-8000-000000040105'::uuid, 'admin');
SELECT pg_temp.v4_3_add_role('00000000-0000-4000-8000-000000040106'::uuid, 'operator');

INSERT INTO public.operators (id, user_id, full_name, is_active, availability_status, presence_status, last_seen_at)
VALUES (
  '00000000-0000-4000-8000-000000040201'::uuid,
  '00000000-0000-4000-8000-000000040104'::uuid,
  'V4-3-D1 operator',
  TRUE,
  'available'::public.availability_status,
  'online',
  clock_timestamp()
);

UPDATE public.profiles
SET display_name = 'V4-3-D1 client name', email = 'v4-3-d1-client@example.invalid', avatar_url = 'https://example.invalid/v4-3-d1-avatar.png'
WHERE user_id = '00000000-0000-4000-8000-000000040102'::uuid;

UPDATE public.client_profiles
SET age = 31,
    gender = 'other',
    interests = ARRAY['v4-3-d1'],
    conversation_preferences = 'synthetic',
    first_name = 'V4',
    last_name = 'Client',
    date_of_birth = DATE '1995-01-01',
    computed_age = 31,
    bio = 'Synthetic PII',
    relationship_status = 'single',
    smoking_status = 'no',
    preferred_min_age = 25,
    preferred_max_age = 40,
    preferred_distance_km = 25,
    content_preferences = '["synthetic"]'::jsonb,
    character_preferences = '["synthetic"]'::jsonb,
    profile_image_url = 'https://example.invalid/v4-3-d1-profile.png',
    profile_image_urls = ARRAY['https://example.invalid/v4-3-d1-profile.png']
WHERE user_id = '00000000-0000-4000-8000-000000040102'::uuid;

INSERT INTO public.characters (id, name, is_active, is_visible, availability_status)
VALUES ('00000000-0000-4000-8000-000000040301'::uuid, 'V4-3-D1 character', TRUE, TRUE, 'available'::public.availability_status);

INSERT INTO public.conversations (id, client_id, character_id, status)
VALUES ('00000000-0000-4000-8000-000000040401'::uuid, '00000000-0000-4000-8000-000000040102'::uuid, '00000000-0000-4000-8000-000000040301'::uuid, 'open'::public.conversation_status);

INSERT INTO public.conversation_work_items (id, conversation_id, client_id, character_id, status, responsible_operator_id, assigned_at)
VALUES ('00000000-0000-4000-8000-000000040501'::uuid, '00000000-0000-4000-8000-000000040401'::uuid, '00000000-0000-4000-8000-000000040102'::uuid, '00000000-0000-4000-8000-000000040301'::uuid, 'assigned', '00000000-0000-4000-8000-000000040201'::uuid, clock_timestamp());

INSERT INTO public.conversation_handling_cycles (conversation_id, work_item_id, operator_id)
VALUES ('00000000-0000-4000-8000-000000040401'::uuid, '00000000-0000-4000-8000-000000040501'::uuid, '00000000-0000-4000-8000-000000040201'::uuid);

INSERT INTO public.client_character_preferences (client_id, character_id, is_favorite)
VALUES ('00000000-0000-4000-8000-000000040102'::uuid, '00000000-0000-4000-8000-000000040301'::uuid, TRUE);
INSERT INTO public.client_discovery_cycles (client_id, filter_hash, cycle_number)
VALUES ('00000000-0000-4000-8000-000000040102'::uuid, 'v4-3-d1', 401);
INSERT INTO public.client_conversation_deletions (client_id, conversation_id)
VALUES ('00000000-0000-4000-8000-000000040102'::uuid, '00000000-0000-4000-8000-000000040401'::uuid);
INSERT INTO public.conversation_read_states (conversation_id, user_id)
VALUES ('00000000-0000-4000-8000-000000040401'::uuid, '00000000-0000-4000-8000-000000040102'::uuid);
INSERT INTO public.user_active_conversations (user_id, conversation_id, role)
VALUES ('00000000-0000-4000-8000-000000040102'::uuid, '00000000-0000-4000-8000-000000040401'::uuid, 'client');
INSERT INTO public.notification_settings (user_id) VALUES ('00000000-0000-4000-8000-000000040102'::uuid);
INSERT INTO public.notifications (user_id, type, title, body, conversation_id)
VALUES ('00000000-0000-4000-8000-000000040102'::uuid, 'system', 'V4-3-D1', 'synthetic', '00000000-0000-4000-8000-000000040401'::uuid);

SELECT plan(32);

SELECT ok(NOT has_function_privilege('public', 'public.archive_client_pii(uuid,text,text)'::regprocedure, 'EXECUTE'), 'PUBLIC cannot execute archive_client_pii');
SET LOCAL ROLE anon;
SET LOCAL "request.jwt.claim.role" = 'anon';
SET LOCAL "request.jwt.claim.sub" = '';
SELECT ok(NOT has_function_privilege(current_user, 'public.archive_client_pii(uuid,text,text)'::regprocedure, 'EXECUTE'), 'anon cannot execute archive_client_pii');

RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000040103';
SELECT ok(has_function_privilege(current_user, 'public.archive_client_pii(uuid,text,text)'::regprocedure, 'EXECUTE'), 'authenticated retains execute for the guarded archive RPC');
SELECT throws_like($$SELECT public.archive_client_pii('00000000-0000-4000-8000-000000040102'::uuid, 'valid reason', 'ARCHIVE_CLIENT_PII')$$, 'admin_required', 'Non-Admin Client is rejected');
RESET ROLE;
SELECT is((SELECT status FROM public.profiles WHERE user_id = '00000000-0000-4000-8000-000000040102'::uuid), 'active', 'Rejected Client call leaves the target active');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000040104';
SELECT throws_like($$SELECT public.archive_client_pii('00000000-0000-4000-8000-000000040102'::uuid, 'valid reason', 'ARCHIVE_CLIENT_PII')$$, 'admin_required', 'Non-Admin Operator is rejected');

SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000040101';
SELECT throws_like($$SELECT public.archive_client_pii('00000000-0000-4000-8000-000000040101'::uuid, 'valid reason', 'ARCHIVE_CLIENT_PII')$$, 'cannot_archive_own_account', 'Admin cannot archive their own account');
SELECT throws_like($$SELECT public.archive_client_pii('00000000-0000-4000-8000-000000040105'::uuid, 'valid reason', 'ARCHIVE_CLIENT_PII')$$, 'client_not_found', 'Admin cannot archive another Admin target');
SELECT throws_like($$SELECT public.archive_client_pii('00000000-0000-4000-8000-000000040106'::uuid, 'valid reason', 'ARCHIVE_CLIENT_PII')$$, 'client_not_found', 'Admin cannot archive an Operator target');
SELECT throws_like($$SELECT public.archive_client_pii('00000000-0000-4000-8000-000000040102'::uuid, 'valid reason', 'wrong')$$, 'pii_archive_confirmation_required', 'Invalid confirmation is rejected');
SELECT throws_like($$SELECT public.archive_client_pii('00000000-0000-4000-8000-000000040102'::uuid, 'x', 'ARCHIVE_CLIENT_PII')$$, 'invalid_pii_archive_reason', 'Invalid reason is rejected');
RESET ROLE;
SELECT is((SELECT count(*) FROM public.audit_logs WHERE action = 'client.pii_archived' AND entity_id = '00000000-0000-4000-8000-000000040102'), 0::bigint, 'Rejected calls create no archive audit row');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000040101';
SELECT set_config('v4_3.archive_first', public.archive_client_pii('00000000-0000-4000-8000-000000040102'::uuid, '  valid archive reason  ', 'ARCHIVE_CLIENT_PII')::text, TRUE);
RESET ROLE;

SELECT ok((current_setting('v4_3.archive_first')::jsonb ->> 'archived')::boolean, 'Successful archive returns archived=true');
SELECT ok(NOT (current_setting('v4_3.archive_first')::jsonb ->> 'idempotent_replay')::boolean, 'First archive is not an idempotent replay');
SELECT ok((current_setting('v4_3.archive_first')::jsonb ->> 'archived_at') IS NOT NULL, 'Successful archive returns archived_at');
SELECT ok((SELECT display_name = U&'\05DC\05E7\05D5\05D7 \05D1\05D0\05E8\05DB\05D9\05D5\05DF' AND email IS NULL AND avatar_url IS NULL AND status = 'archived' AND deleted_at IS NOT NULL AND pii_archived_at IS NOT NULL AND pii_archived_by = '00000000-0000-4000-8000-000000040101'::uuid AND pii_archive_reason = 'valid archive reason' FROM public.profiles WHERE user_id = '00000000-0000-4000-8000-000000040102'::uuid), 'Profile PII and archive metadata are redacted exactly');
SELECT ok((SELECT age IS NULL AND gender IS NULL AND interests = ARRAY[]::text[] AND conversation_preferences IS NULL AND first_name IS NULL AND last_name IS NULL AND date_of_birth IS NULL AND computed_age IS NULL AND city_id IS NULL AND bio IS NULL AND relationship_status IS NULL AND smoking_status IS NULL AND preferred_min_age IS NULL AND preferred_max_age IS NULL AND preferred_distance_km IS NULL AND content_preferences = '[]'::jsonb AND character_preferences = '[]'::jsonb AND profile_image_url IS NULL AND profile_image_urls = ARRAY[]::text[] FROM public.client_profiles WHERE user_id = '00000000-0000-4000-8000-000000040102'::uuid), 'Client profile PII is nulled or emptied by the existing contract');
SELECT ok((SELECT ended_at IS NOT NULL AND end_reason = 'closed' FROM public.conversation_handling_cycles WHERE conversation_id = '00000000-0000-4000-8000-000000040401'::uuid), 'Active handling cycle is closed');
SELECT ok((SELECT status = 'closed' AND responsible_operator_id IS NULL AND assigned_at IS NULL FROM public.conversation_work_items WHERE id = '00000000-0000-4000-8000-000000040501'::uuid), 'Active work item is closed and unassigned');
SELECT is((SELECT count(*) FROM public.client_character_preferences WHERE client_id = '00000000-0000-4000-8000-000000040102'::uuid), 0::bigint, 'Client character preferences are deleted');
SELECT is((SELECT count(*) FROM public.client_discovery_cycles WHERE client_id = '00000000-0000-4000-8000-000000040102'::uuid), 0::bigint, 'Client discovery cycles are deleted');
SELECT is((SELECT count(*) FROM public.client_conversation_deletions WHERE client_id = '00000000-0000-4000-8000-000000040102'::uuid), 0::bigint, 'Client conversation deletions are deleted');
SELECT is((SELECT count(*) FROM public.conversation_read_states WHERE user_id = '00000000-0000-4000-8000-000000040102'::uuid), 0::bigint, 'Conversation read states are deleted');
SELECT is((SELECT count(*) FROM public.user_active_conversations WHERE user_id = '00000000-0000-4000-8000-000000040102'::uuid), 0::bigint, 'Active conversation state is deleted');
SELECT is((SELECT count(*) FROM public.notifications WHERE user_id = '00000000-0000-4000-8000-000000040102'::uuid), 0::bigint, 'Notifications are deleted');
SELECT is((SELECT count(*) FROM public.notification_settings WHERE user_id = '00000000-0000-4000-8000-000000040102'::uuid), 0::bigint, 'Notification settings are deleted');
SELECT ok((SELECT actor_user_id = '00000000-0000-4000-8000-000000040101'::uuid AND entity_type = 'user' AND entity_id = '00000000-0000-4000-8000-000000040102' AND metadata @> '{"reason":"valid archive reason","auth_user_preserved":true,"pii_redacted":true}'::jsonb FROM public.audit_logs WHERE action = 'client.pii_archived' AND entity_id = '00000000-0000-4000-8000-000000040102'), 'Archive audit row has the expected sanitized metadata');
SELECT is((SELECT count(*) FROM public.audit_logs WHERE action = 'client.pii_archived' AND entity_id = '00000000-0000-4000-8000-000000040102'), 1::bigint, 'Exactly one archive audit row exists');
SELECT is((SELECT count(*) FROM auth.users WHERE id = '00000000-0000-4000-8000-000000040102'::uuid), 1::bigint, 'Archive preserves the Auth user');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000040101';
SELECT set_config('v4_3.archive_retry', public.archive_client_pii('00000000-0000-4000-8000-000000040102'::uuid, 'valid archive reason', 'ARCHIVE_CLIENT_PII')::text, TRUE);
RESET ROLE;
SELECT ok((current_setting('v4_3.archive_retry')::jsonb ->> 'archived')::boolean AND (current_setting('v4_3.archive_retry')::jsonb ->> 'idempotent_replay')::boolean, 'Replay returns archived=true and idempotent_replay=true');
SELECT is((current_setting('v4_3.archive_retry')::jsonb ->> 'archived_at')::timestamptz, (current_setting('v4_3.archive_first')::jsonb ->> 'archived_at')::timestamptz, 'Replay preserves the original archive timestamp');
SELECT is((SELECT count(*) FROM public.audit_logs WHERE action = 'client.pii_archived' AND entity_id = '00000000-0000-4000-8000-000000040102'), 1::bigint, 'Replay creates no second archive audit row');

SELECT * FROM finish();
ROLLBACK;
