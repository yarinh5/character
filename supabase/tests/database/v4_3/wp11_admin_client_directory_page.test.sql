BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT no_plan();

SELECT has_function('public', 'admin_list_clients_page',
  ARRAY['boolean', 'text', 'text', 'timestamp with time zone',
        'timestamp with time zone', 'timestamp with time zone', 'uuid', 'integer'],
  'Client directory RPC has the explicit paged filter contract');
SELECT ok(prosecdef AND provolatile = 's'
  AND array_to_string(proconfig, ',') LIKE 'search_path=%',
  'Privileged directory function is stable and pins its search path')
FROM pg_proc
WHERE oid = 'public.admin_list_clients_page(boolean,text,text,timestamptz,timestamptz,timestamptz,uuid,integer)'::regprocedure;
SELECT ok(NOT has_function_privilege('public',
  'public.admin_list_clients_page(boolean,text,text,timestamptz,timestamptz,timestamptz,uuid,integer)', 'EXECUTE'),
  'PUBLIC cannot execute the directory RPC');

SET LOCAL ROLE anon;
SELECT ok(NOT has_function_privilege(current_user,
  'public.admin_list_clients_page(boolean,text,text,timestamptz,timestamptz,timestamptz,uuid,integer)', 'EXECUTE'),
  'Anon cannot execute the directory RPC');
RESET ROLE;

INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-000000119001', 'authenticated', 'authenticated', 'directory-admin@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000119002', 'authenticated', 'authenticated', 'directory-one@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000119003', 'authenticated', 'authenticated', 'directory-two@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000119004', 'authenticated', 'authenticated', 'directory-three@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000119005', 'authenticated', 'authenticated', 'directory-four@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000119006', 'authenticated', 'authenticated', 'directory-five@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000119007', 'authenticated', 'authenticated', 'directory-operator@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000119008', 'authenticated', 'authenticated', 'directory-orphan@example.invalid', '{}', '{}');

INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-4000-8000-000000119001', 'admin'),
  ('00000000-0000-4000-8000-000000119007', 'operator');
DELETE FROM public.user_roles WHERE user_id = '00000000-0000-4000-8000-000000119002' AND role = 'client';
DELETE FROM public.client_profiles WHERE user_id = '00000000-0000-4000-8000-000000119003';
DELETE FROM public.user_roles WHERE user_id = '00000000-0000-4000-8000-000000119008';
DELETE FROM public.client_profiles WHERE user_id = '00000000-0000-4000-8000-000000119008';

UPDATE public.profiles SET created_at = '2099-04-03 00:00Z', display_name = 'Alpha%_' || chr(92) || 'Beta'
WHERE user_id = '00000000-0000-4000-8000-000000119002';
UPDATE public.profiles SET created_at = '2099-04-03 00:00Z', display_name = 'Under_score'
WHERE user_id = '00000000-0000-4000-8000-000000119003';
UPDATE public.profiles SET created_at = '2099-04-02 00:00Z', display_name = 'Inactive', status = 'blocked'
WHERE user_id = '00000000-0000-4000-8000-000000119004';
UPDATE public.profiles SET created_at = '2099-04-01 00:00Z', display_name = 'Archived',
  status = 'archived', deleted_at = '2099-04-04 00:00Z'
WHERE user_id = '00000000-0000-4000-8000-000000119005';
UPDATE public.profiles SET created_at = '2099-03-31 00:00Z', display_name = 'Older'
WHERE user_id = '00000000-0000-4000-8000-000000119006';
INSERT INTO public.credit_wallets (user_id, balance)
VALUES ('00000000-0000-4000-8000-000000119003', 42);
DELETE FROM public.credit_wallets WHERE user_id = '00000000-0000-4000-8000-000000119002';

INSERT INTO public.characters (id, name)
VALUES ('00000000-0000-4000-8000-000000119101', 'Directory character');
INSERT INTO public.conversations (client_id, character_id, status, last_message_at, client_hidden_at)
SELECT '00000000-0000-4000-8000-000000119002',
  '00000000-0000-4000-8000-000000119101',
  CASE WHEN n = 1002 THEN 'closed' ELSE 'open' END::public.conversation_status,
  '2099-03-01 00:00Z'::timestamptz + n * interval '1 minute',
  CASE WHEN n = 1 THEN NULL ELSE '2099-03-02 00:00Z'::timestamptz END
FROM generate_series(1, 1002) AS fixture(n);

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '';
SELECT throws_like($$SELECT * FROM public.admin_list_clients_page()$$,
  'admin_required', 'Missing auth UID is rejected');
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000119002';
SELECT throws_like($$SELECT * FROM public.admin_list_clients_page()$$,
  'admin_required', 'Client cannot list the directory');
SELECT throws_like($$SELECT * FROM public.admin_list_clients_page(_page_size => 0)$$,
  'admin_required', 'Authorization precedes input validation');
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000119007';
SELECT throws_like($$SELECT * FROM public.admin_list_clients_page()$$,
  'admin_required', 'Operator cannot list the directory');

SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000119001';
SELECT ok(has_function_privilege(current_user,
  'public.admin_list_clients_page(boolean,text,text,timestamptz,timestamptz,timestamptz,uuid,integer)', 'EXECUTE'),
  'Authenticated admin can execute the directory RPC');
SELECT throws_like($$SELECT * FROM public.admin_list_clients_page(_include_archived => NULL)$$,
  'invalid_client_filter', 'Null archive selector is rejected');
SELECT throws_like($$SELECT * FROM public.admin_list_clients_page(_status => 'blocked')$$,
  'invalid_client_filter', 'Unknown status is rejected');
SELECT throws_like($$SELECT * FROM public.admin_list_clients_page(_search => repeat('x', 121))$$,
  'invalid_client_search', 'Oversize search is rejected');
SELECT throws_like($$SELECT * FROM public.admin_list_clients_page(
  _created_from => '2099-04-03', _created_before => '2099-04-03')$$,
  'invalid_client_date_range', 'Empty date window is rejected');
SELECT throws_like($$SELECT * FROM public.admin_list_clients_page(_before_created_at => now())$$,
  'invalid_client_cursor', 'Timestamp-only cursor is rejected');
SELECT throws_like($$SELECT * FROM public.admin_list_clients_page(
  _before_user_id => '00000000-0000-4000-8000-000000119002')$$,
  'invalid_client_cursor', 'ID-only cursor is rejected');
SELECT throws_like($$SELECT * FROM public.admin_list_clients_page(_page_size => NULL)$$,
  'invalid_page_size', 'Null page size is rejected');
SELECT throws_like($$SELECT * FROM public.admin_list_clients_page(_page_size => 0)$$,
  'invalid_page_size', 'Zero page size is rejected');
SELECT throws_like($$SELECT * FROM public.admin_list_clients_page(_page_size => 102)$$,
  'invalid_page_size', 'Page size above 101 is rejected');

SELECT results_eq(
  $$SELECT user_id FROM public.admin_list_clients_page(_page_size => 2)$$,
  $$VALUES ('00000000-0000-4000-8000-000000119003'::uuid),
           ('00000000-0000-4000-8000-000000119002'::uuid)$$,
  'First page sorts tied timestamps by descending user ID');
SELECT results_eq(
  $$SELECT user_id FROM public.admin_list_clients_page(
    _before_created_at => '2099-04-03',
    _before_user_id => '00000000-0000-4000-8000-000000119003', _page_size => 2)$$,
  $$VALUES ('00000000-0000-4000-8000-000000119002'::uuid),
           ('00000000-0000-4000-8000-000000119004'::uuid)$$,
  'Cursor crosses a timestamp tie without omission');
SELECT results_eq(
  $$SELECT user_id FROM public.admin_list_clients_page(
    _before_created_at => '2099-04-03',
    _before_user_id => '00000000-0000-4000-8000-000000119002', _page_size => 2)$$,
  $$VALUES ('00000000-0000-4000-8000-000000119004'::uuid),
           ('00000000-0000-4000-8000-000000119006'::uuid)$$,
  'Next page contains no duplicate');
SELECT results_eq(
  $$SELECT user_id FROM public.admin_list_clients_page(
    _created_from => '2099-04-02', _created_before => '2099-04-03')$$,
  $$VALUES ('00000000-0000-4000-8000-000000119004'::uuid)$$,
  'Created-at bounds are inclusive/exclusive');
SELECT results_eq(
  $$SELECT user_id FROM public.admin_list_clients_page(_status => 'active')$$,
  $$VALUES ('00000000-0000-4000-8000-000000119003'::uuid),
           ('00000000-0000-4000-8000-000000119002'::uuid),
           ('00000000-0000-4000-8000-000000119006'::uuid)$$,
  'Active status excludes blocked and archived accounts');
SELECT results_eq(
  $$SELECT user_id FROM public.admin_list_clients_page(_status => 'inactive')$$,
  $$VALUES ('00000000-0000-4000-8000-000000119004'::uuid)$$,
  'Inactive status includes blocked live clients only');
SELECT results_eq(
  $$SELECT user_id FROM public.admin_list_clients_page(_include_archived => true)$$,
  $$VALUES ('00000000-0000-4000-8000-000000119005'::uuid)$$,
  'Archived selector is separate from live clients');
SELECT is((SELECT count(*) FROM public.admin_list_clients_page(
  _include_archived => true, _status => 'active')),
  0::bigint, 'Archived rows never match active status');
SELECT is((SELECT count(*) FROM public.admin_list_clients_page(
  _include_archived => true, _status => 'inactive')),
  0::bigint, 'Archived rows never match inactive status');
SELECT is((SELECT status FROM public.admin_list_clients_page(_include_archived => true)),
  'archived'::text, 'Archived row has the effective archived status');
SELECT results_eq(
  $$SELECT user_id FROM public.admin_list_clients_page(_search => '%')$$,
  $$VALUES ('00000000-0000-4000-8000-000000119002'::uuid)$$,
  'Percent sign is searched literally');
SELECT results_eq(
  $$SELECT user_id FROM public.admin_list_clients_page(_search => '_')$$,
  $$VALUES ('00000000-0000-4000-8000-000000119003'::uuid),
           ('00000000-0000-4000-8000-000000119002'::uuid)$$,
  'Underscore is searched literally');
SELECT results_eq(
  $$SELECT user_id FROM public.admin_list_clients_page(_search => 'DIRECTORY-TWO@EXAMPLE.INVALID')$$,
  $$VALUES ('00000000-0000-4000-8000-000000119003'::uuid)$$,
  'Email search is case-insensitive');
SELECT results_eq(
  $$SELECT user_id FROM public.admin_list_clients_page(_search => chr(92))$$,
  $$VALUES ('00000000-0000-4000-8000-000000119002'::uuid)$$,
  'Backslash is searched literally');
SELECT is((SELECT credits_balance FROM public.admin_list_clients_page(_search => 'Alpha%_')),
  NULL::integer, 'Missing wallet remains NULL');
SELECT is((SELECT credits_balance FROM public.admin_list_clients_page(_search => 'Under_score')),
  42::integer, 'Wallet balance comes from its source row');
SELECT is((SELECT conversations_count FROM public.admin_list_clients_page(_search => 'Alpha%_')),
  1002::bigint, 'Conversation count is not capped at 1000');
SELECT is((SELECT active_conversations_count FROM public.admin_list_clients_page(_search => 'Alpha%_')),
  1001::bigint, 'Active count uses the full conversation set');
SELECT is((SELECT last_message_at FROM public.admin_list_clients_page(_search => 'Alpha%_')),
  '2099-03-01 16:42Z'::timestamptz, 'Last message timestamp comes from the full set');
SELECT is((SELECT conversations_count FROM public.admin_list_clients_page(_search => 'Under_score')),
  0::bigint, 'Clients without conversations receive exact zero counts');

SELECT * FROM finish();
ROLLBACK;
