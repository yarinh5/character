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

SELECT plan(34);
SELECT ok(to_regclass('public.user_conversation_access_versions') IS NOT NULL, 'Access-version signal exists');
SELECT ok(to_regclass('public.conversation_presence_states') IS NOT NULL, 'RLS presence projection exists');
SELECT ok(NOT has_table_privilege('authenticated', 'public.user_conversation_access_versions', 'UPDATE'), 'Browser cannot forge access versions');
SELECT ok(NOT has_table_privilege('authenticated', 'public.conversation_presence_states', 'INSERT'), 'Browser cannot write presence directly');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000c0103';
SELECT is((SELECT allowed FROM public.get_conversation_read_access('00000000-0000-4000-8000-0000000c3101')), true, 'Assigned non-owner has read access');
SELECT is((SELECT count(*) FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-0000000c3101'), 1::bigint, 'Assigned non-owner reads history through RLS');
SELECT lives_ok($$SELECT * FROM public.get_operator_conversation_client_profile('00000000-0000-4000-8000-0000000c3101')$$, 'Assigned reader uses current-access profile RPC');
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

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000c0102';
SELECT lives_ok($$SELECT public.add_operator_internal_note('00000000-0000-4000-8000-0000000c3101','owner note')$$, 'Cycle owner can add note');
SELECT lives_ok($$SELECT public.add_operator_customer_info('00000000-0000-4000-8000-0000000c3101','owner crm')$$, 'Cycle owner can add CRM information');
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
RESET ROLE;

UPDATE public.operators SET is_active = false WHERE id = '00000000-0000-4000-8000-0000000c1102';
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000c0102';
SELECT is((SELECT allowed FROM public.get_conversation_read_access('00000000-0000-4000-8000-0000000c3101')), false, 'Inactive operator is denied');
SELECT is((SELECT count(*) FROM public.customer_info_entries WHERE conversation_id = '00000000-0000-4000-8000-0000000c3101'), 0::bigint, 'CRM author exception does not survive activity revoke');
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
RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000c0101';
SELECT is((SELECT allowed FROM public.get_conversation_read_access('00000000-0000-4000-8000-0000000c3101')), true, 'Client read contract remains available');
SELECT throws_like($$SELECT public.set_conversation_presence('00000000-0000-4000-8000-0000000c3101','admin','forged admin',true,false)$$, 'presence_identity_mismatch', 'Client cannot forge Admin presence');
SELECT lives_ok($$SELECT public.set_conversation_presence('00000000-0000-4000-8000-0000000c3101','client','forged display',true,false)$$, 'Client presence preserves its valid contract');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT ok(NOT has_function_privilege(current_user, 'public.get_conversation_read_access(uuid)'::regprocedure, 'EXECUTE'), 'Anon cannot inspect read access');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
