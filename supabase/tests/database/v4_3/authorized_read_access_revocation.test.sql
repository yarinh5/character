BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;

CREATE OR REPLACE FUNCTION pg_temp.wp01_5_user(_id UUID, _email TEXT)
RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES (_id, 'authenticated', 'authenticated', _email, 'local-test', clock_timestamp(),
    '{"provider":"email","providers":["email"]}', '{}', clock_timestamp(), clock_timestamp());
$$;

SELECT pg_temp.wp01_5_user('00000000-0000-4000-8000-0000000c0101', 'wp01-5-client@example.invalid');
SELECT pg_temp.wp01_5_user('00000000-0000-4000-8000-0000000c0102', 'wp01-5-owner@example.invalid');
SELECT pg_temp.wp01_5_user('00000000-0000-4000-8000-0000000c0103', 'wp01-5-reader@example.invalid');
SELECT pg_temp.wp01_5_user('00000000-0000-4000-8000-0000000c0104', 'wp01-5-admin@example.invalid');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-4000-8000-0000000c0102', 'operator'),
  ('00000000-0000-4000-8000-0000000c0103', 'operator'),
  ('00000000-0000-4000-8000-0000000c0104', 'admin');
INSERT INTO public.operators (id, user_id, full_name, is_active, availability_status, presence_status) VALUES
  ('00000000-0000-4000-8000-0000000c1102', '00000000-0000-4000-8000-0000000c0102', 'WP01.5 owner', true, 'available', 'online'),
  ('00000000-0000-4000-8000-0000000c1103', '00000000-0000-4000-8000-0000000c0103', 'WP01.5 reader', true, 'available', 'online'),
  ('00000000-0000-4000-8000-0000000c1104', '00000000-0000-4000-8000-0000000c0104', 'WP01.5 admin', true, 'available', 'online');
INSERT INTO public.characters (id, name, is_active, is_visible, availability_status)
VALUES ('00000000-0000-4000-8000-0000000c2101', 'WP01.5 character', true, true, 'available');
INSERT INTO public.character_operator_assignments (character_id, operator_id) VALUES
  ('00000000-0000-4000-8000-0000000c2101', '00000000-0000-4000-8000-0000000c1102'),
  ('00000000-0000-4000-8000-0000000c2101', '00000000-0000-4000-8000-0000000c1103');
INSERT INTO public.conversations (id, client_id, character_id, assigned_operator_id, status)
VALUES ('00000000-0000-4000-8000-0000000c3101', '00000000-0000-4000-8000-0000000c0101', '00000000-0000-4000-8000-0000000c2101', '00000000-0000-4000-8000-0000000c1102', 'open');
INSERT INTO public.conversation_work_items (id, conversation_id, client_id, character_id, status, responsible_operator_id, assigned_at)
VALUES ('00000000-0000-4000-8000-0000000c5101', '00000000-0000-4000-8000-0000000c3101', '00000000-0000-4000-8000-0000000c0101', '00000000-0000-4000-8000-0000000c2101', 'assigned', '00000000-0000-4000-8000-0000000c1102', clock_timestamp());
INSERT INTO public.conversation_handling_cycles (id, conversation_id, work_item_id, operator_id)
VALUES ('00000000-0000-4000-8000-0000000c6101', '00000000-0000-4000-8000-0000000c3101', '00000000-0000-4000-8000-0000000c5101', '00000000-0000-4000-8000-0000000c1102');
INSERT INTO public.messages (id, conversation_id, sender_type, sender_id, content)
VALUES ('00000000-0000-4000-8000-0000000c4101', '00000000-0000-4000-8000-0000000c3101', 'client', '00000000-0000-4000-8000-0000000c0101', 'authorized history');

INSERT INTO public.discovery_cities (id, slug, display_name_he)
VALUES ('00000000-0000-4000-8000-0000000c7101', 'wp03-fixture-city', 'Fixture city');
UPDATE public.client_profiles
SET age = 29, city_id = '00000000-0000-4000-8000-0000000c7101'
WHERE user_id = '00000000-0000-4000-8000-0000000c0101';

SELECT plan(50);
SELECT ok(to_regclass('public.user_conversation_access_versions') IS NOT NULL, 'Access-version signal exists');
SELECT ok(to_regclass('public.conversation_presence_states') IS NOT NULL, 'RLS presence projection exists');
SELECT ok(NOT has_table_privilege('authenticated', 'public.user_conversation_access_versions', 'UPDATE'), 'Browser cannot forge access versions');
SELECT ok(NOT has_table_privilege('authenticated', 'public.conversation_presence_states', 'INSERT'), 'Browser cannot write presence directly');
SELECT has_function('public', 'get_operator_online_context', ARRAY['uuid[]'], 'Bounded ONLINE context RPC exists');
SELECT ok(NOT has_function_privilege('anon', 'public.get_operator_online_context(uuid[])'::regprocedure, 'EXECUTE'), 'Anon cannot read ONLINE context');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000c0103';
SELECT is((SELECT allowed FROM public.get_conversation_read_access('00000000-0000-4000-8000-0000000c3101')), true, 'Assigned non-owner has read access');
SELECT is((SELECT count(*) FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-0000000c3101'), 1::bigint, 'Assigned non-owner reads history through RLS');
SELECT lives_ok($$SELECT * FROM public.get_operator_conversation_client_profile('00000000-0000-4000-8000-0000000c3101')$$, 'Assigned reader uses current-access profile RPC');
SELECT results_eq(
  $$SELECT * FROM public.get_operator_online_context(ARRAY[
    '00000000-0000-4000-8000-0000000c3101'::uuid,
    '00000000-0000-4000-8000-0000000c3101'::uuid,
    '00000000-0000-4000-8000-0000000c3199'::uuid
  ])$$,
  $$VALUES ('00000000-0000-4000-8000-0000000c3101'::uuid, 29, 'Fixture city'::text, true)$$,
  'Assigned reader gets only age, city and read-only status for authorized conversations'
);
SELECT throws_ok(
  $$SELECT * FROM public.get_operator_online_context(array_fill('00000000-0000-4000-8000-0000000c3101'::uuid, ARRAY[301]))$$,
  '22023', 'too_many_online_conversation_ids', 'ONLINE request rejects oversized batches'
);
SELECT throws_like($$SELECT public.add_operator_internal_note('00000000-0000-4000-8000-0000000c3101','forbidden')$$, 'conversation_locked_by_other_operator', 'Non-owner cannot add notes');
SELECT throws_like($$SELECT public.add_operator_customer_info('00000000-0000-4000-8000-0000000c3101','forbidden')$$, 'conversation_locked_by_other_operator', 'Non-owner cannot mutate CRM');
SELECT throws_like($$SELECT public.update_operator_conversation_status('00000000-0000-4000-8000-0000000c3101','closed')$$, 'conversation_locked_by_other_operator', 'Non-owner cannot mutate status');
SELECT lives_ok($$SELECT public.set_conversation_presence('00000000-0000-4000-8000-0000000c3101','operator','reader',true,true)$$, 'Authorized reader can publish minimal presence');
SELECT throws_like($$SELECT public.set_conversation_presence('00000000-0000-4000-8000-0000000c3101','admin','forged admin',true,false)$$, 'presence_identity_mismatch', 'Operator cannot forge Admin presence');
SELECT throws_like($$SELECT public.touch_active_conversation('00000000-0000-4000-8000-0000000c3101','admin')$$, 'active_conversation_identity_mismatch', 'Operator cannot forge Admin active-conversation identity');
RESET ROLE;
SELECT is((SELECT operator_id FROM public.conversation_handling_cycles WHERE id = '00000000-0000-4000-8000-0000000c6101'), '00000000-0000-4000-8000-0000000c1102'::uuid, 'Presence does not change ownership');
SELECT is((SELECT role FROM public.conversation_presence_states WHERE conversation_id = '00000000-0000-4000-8000-0000000c3101' AND user_id = '00000000-0000-4000-8000-0000000c0103'), 'operator', 'Presence role comes from trusted server identity');
SELECT is((SELECT display_name FROM public.conversation_presence_states WHERE conversation_id = '00000000-0000-4000-8000-0000000c3101' AND user_id = '00000000-0000-4000-8000-0000000c0103'), 'WP01.5 reader', 'Presence display name ignores caller-supplied identity');

UPDATE public.discovery_cities SET is_active = false WHERE slug = 'wp03-fixture-city';
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000c0103';
SELECT results_eq(
  $$SELECT client_age, client_city FROM public.get_operator_online_context(ARRAY['00000000-0000-4000-8000-0000000c3101'::uuid])$$,
  $$VALUES (29, NULL::text)$$, 'Retired cities are not disclosed by the ONLINE projection'
);
RESET ROLE;
UPDATE public.discovery_cities SET is_active = true WHERE slug = 'wp03-fixture-city';

SELECT set_config('wp03.reader_version', (SELECT version::text FROM public.user_conversation_access_versions WHERE user_id = '00000000-0000-4000-8000-0000000c0103'), true);
UPDATE public.profiles SET status = 'deletion_requested' WHERE user_id = '00000000-0000-4000-8000-0000000c0101';
SELECT ok((SELECT version FROM public.user_conversation_access_versions WHERE user_id = '00000000-0000-4000-8000-0000000c0103') > current_setting('wp03.reader_version')::bigint, 'Client status change invalidates previously authorized ONLINE context');
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000c0103';
SELECT results_eq(
  $$SELECT client_age, client_city FROM public.get_operator_online_context(ARRAY['00000000-0000-4000-8000-0000000c3101'::uuid])$$,
  $$VALUES (NULL::integer, NULL::text)$$, 'Client deletion state hides profile context without exposing a deletion reason'
);
RESET ROLE;
UPDATE public.profiles SET status = 'active' WHERE user_id = '00000000-0000-4000-8000-0000000c0101';

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000c0102';
SELECT lives_ok($$SELECT public.add_operator_internal_note('00000000-0000-4000-8000-0000000c3101','owner note')$$, 'Cycle owner can add note');
SELECT lives_ok($$SELECT public.add_operator_customer_info('00000000-0000-4000-8000-0000000c3101','owner crm')$$, 'Cycle owner can add CRM information');
SELECT is(
  (SELECT under_other_operator FROM public.get_operator_online_context(ARRAY['00000000-0000-4000-8000-0000000c3101'::uuid])),
  false, 'Cycle owner is not marked read-only by ONLINE context'
);
SELECT is((SELECT count(*) FROM public.get_operator_online_context('{}'::uuid[])), 0::bigint, 'Empty input returns no metadata');
RESET ROLE;

SELECT set_config('wp01_5.reader_version', (SELECT version::text FROM public.user_conversation_access_versions WHERE user_id = '00000000-0000-4000-8000-0000000c0103'), true);
DELETE FROM public.character_operator_assignments WHERE operator_id = '00000000-0000-4000-8000-0000000c1103';
SELECT ok((SELECT version FROM public.user_conversation_access_versions WHERE user_id = '00000000-0000-4000-8000-0000000c0103') > current_setting('wp01_5.reader_version')::bigint, 'Assignment revoke bumps signal in the same transaction');
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000c0103';
SELECT is((SELECT allowed FROM public.get_conversation_read_access('00000000-0000-4000-8000-0000000c3101')), false, 'Revoked assignment denies new reads');
SELECT is((SELECT count(*) FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-0000000c3101'), 0::bigint, 'RLS withholds history after revoke');
SELECT throws_like($$SELECT public.set_conversation_presence('00000000-0000-4000-8000-0000000c3101','operator','reader',true,false)$$, 'conversation_read_forbidden', 'Revoked operator cannot renew presence');
SELECT throws_like($$SELECT * FROM public.get_operator_conversation_client_profile('00000000-0000-4000-8000-0000000c3101')$$, 'conversation_read_forbidden', 'Revoked operator cannot use profile RPC');
SELECT is((SELECT count(*) FROM public.get_operator_online_context(ARRAY['00000000-0000-4000-8000-0000000c3101'::uuid])), 0::bigint, 'ONLINE context drops a revoked conversation');
RESET ROLE;

UPDATE public.operators SET is_active = false WHERE id = '00000000-0000-4000-8000-0000000c1102';
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000c0102';
SELECT is((SELECT allowed FROM public.get_conversation_read_access('00000000-0000-4000-8000-0000000c3101')), false, 'Inactive operator is denied');
SELECT is((SELECT count(*) FROM public.customer_info_entries WHERE conversation_id = '00000000-0000-4000-8000-0000000c3101'), 0::bigint, 'CRM author exception does not survive activity revoke');
SELECT throws_like($$SELECT * FROM public.get_operator_online_context(ARRAY['00000000-0000-4000-8000-0000000c3101'::uuid])$$, 'operator_profile_required', 'Inactive operator cannot query ONLINE context');
SELECT throws_like($$SELECT public.send_operator_message('00000000-0000-4000-8000-0000000c3101','inactive send','00000000-0000-4000-8000-0000000c6101')$$, 'operator_record_required', 'Inactive operator cannot send directly');
RESET ROLE;

UPDATE public.operators SET is_active = true, deleted_at = clock_timestamp() WHERE id = '00000000-0000-4000-8000-0000000c1102';
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000c0102';
SELECT throws_like($$SELECT public.send_operator_message('00000000-0000-4000-8000-0000000c3101','deleted send','00000000-0000-4000-8000-0000000c6101')$$, 'operator_record_required', 'Soft-deleted operator cannot send directly');
RESET ROLE;

UPDATE public.operators SET deleted_at = NULL WHERE id = '00000000-0000-4000-8000-0000000c1102';
DELETE FROM public.user_roles WHERE user_id = '00000000-0000-4000-8000-0000000c0102' AND role = 'operator';
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000c0102';
SELECT throws_like($$SELECT public.send_operator_message('00000000-0000-4000-8000-0000000c3101','roleless send','00000000-0000-4000-8000-0000000c6101')$$, 'operator_record_required', 'Role-revoked operator cannot send directly');
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000c0104';
SELECT is((SELECT allowed FROM public.get_conversation_read_access('00000000-0000-4000-8000-0000000c3101')), true, 'Admin read contract remains available');
SELECT lives_ok($$SELECT * FROM public.get_operator_conversation_client_profile('00000000-0000-4000-8000-0000000c3101')$$, 'Admin profile read contract remains available');
SELECT is((SELECT count(*) FROM public.get_operator_online_context(ARRAY['00000000-0000-4000-8000-0000000c3101'::uuid])), 1::bigint, 'Active admin can use the operator projection');
RESET ROLE;

UPDATE public.profiles SET status = 'blocked' WHERE user_id = '00000000-0000-4000-8000-0000000c0104';
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000c0104';
SELECT throws_like($$SELECT * FROM public.get_operator_online_context(ARRAY['00000000-0000-4000-8000-0000000c3101'::uuid])$$, 'operator_profile_required', 'Blocked admin cannot use the operator projection with a retained role');
RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000c0101';
SELECT is((SELECT allowed FROM public.get_conversation_read_access('00000000-0000-4000-8000-0000000c3101')), true, 'Client read contract remains available');
SELECT throws_like($$SELECT * FROM public.get_operator_online_context(ARRAY['00000000-0000-4000-8000-0000000c3101'::uuid])$$, 'operator_profile_required', 'Client ownership alone does not grant the operator projection');
SELECT throws_like($$SELECT public.set_conversation_presence('00000000-0000-4000-8000-0000000c3101','admin','forged admin',true,false)$$, 'presence_identity_mismatch', 'Client cannot forge Admin presence');
SELECT lives_ok($$SELECT public.set_conversation_presence('00000000-0000-4000-8000-0000000c3101','client','forged display',true,false)$$, 'Client presence preserves its valid contract');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT ok(NOT has_function_privilege(current_user, 'public.get_conversation_read_access(uuid)'::regprocedure, 'EXECUTE'), 'Anon cannot inspect read access');
RESET ROLE;

SELECT set_config('wp03.reader_version', (SELECT version::text FROM public.user_conversation_access_versions WHERE user_id = '00000000-0000-4000-8000-0000000c0103'), true);
INSERT INTO private.restore_recovery_events (id, external_lock_id, external_authority_id, source_snapshot_id, source_snapshot_at, owner_admin_id)
VALUES ('00000000-0000-4000-8000-0000000c7199', 'wp03-test-lock', 'wp03-test', 'wp03-snapshot', clock_timestamp(), '00000000-0000-4000-8000-0000000c0104');
UPDATE private.restore_recovery_control
SET access_state = 'blocked', current_event_id = '00000000-0000-4000-8000-0000000c7199'
WHERE singleton;
SELECT ok((SELECT version FROM public.user_conversation_access_versions WHERE user_id = '00000000-0000-4000-8000-0000000c0103') > current_setting('wp03.reader_version')::bigint, 'Recovery activation invalidates ONLINE context without publishing recovery details');
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000c0103';
SELECT throws_ok($$SELECT * FROM public.get_operator_online_context(ARRAY['00000000-0000-4000-8000-0000000c3101'::uuid])$$,
  '42501', 'system_recovery_blocked', 'ONLINE context fails closed under recovery');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
