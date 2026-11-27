BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT no_plan();

SELECT is(
  pg_get_function_result('public.get_admin_operator_client_reports_page(timestamptz,uuid,integer)'::regprocedure),
  pg_get_function_result('public.get_admin_operator_client_reports()'::regprocedure),
  'Paged and legacy reports expose the same return columns and types'
);
SELECT ok(
  NOT has_function_privilege('public',
    'public.get_admin_operator_client_reports_page(timestamptz,uuid,integer)', 'EXECUTE'),
  'PUBLIC cannot execute the page RPC'
);

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('00000000-0000-4000-8000-000000113001', 'authenticated', 'authenticated', 'wp11-page-admin@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000113002', 'authenticated', 'authenticated', 'wp11-page-operator@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000113003', 'authenticated', 'authenticated', 'wp11-page-client@example.invalid', 'x', now(), '{}', '{}', now(), now());

INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-4000-8000-000000113001', 'admin'),
  ('00000000-0000-4000-8000-000000113002', 'operator');
INSERT INTO public.operators (id, user_id, full_name) VALUES
  ('00000000-0000-4000-8000-000000113101', '00000000-0000-4000-8000-000000113002', 'WP11 Page Operator');

INSERT INTO public.operator_client_reports (id, operator_id, client_id, reason, created_at) VALUES
  ('00000000-0000-4000-8000-000000113201', '00000000-0000-4000-8000-000000113101', '00000000-0000-4000-8000-000000113003', 'Page fixture', '2099-01-02 00:00Z'),
  ('00000000-0000-4000-8000-000000113202', '00000000-0000-4000-8000-000000113101', '00000000-0000-4000-8000-000000113003', 'Page fixture', '2099-01-02 00:00Z'),
  ('00000000-0000-4000-8000-000000113203', '00000000-0000-4000-8000-000000113101', '00000000-0000-4000-8000-000000113003', 'Page fixture', '2099-01-02 00:00Z'),
  ('00000000-0000-4000-8000-000000113204', '00000000-0000-4000-8000-000000113101', '00000000-0000-4000-8000-000000113003', 'Page fixture', '2099-01-01 00:00Z');

SET LOCAL ROLE anon;
SELECT ok(
  NOT has_function_privilege(current_user,
    'public.get_admin_operator_client_reports_page(timestamptz,uuid,integer)'::regprocedure, 'EXECUTE'),
  'Anon cannot execute the page RPC'
);
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000113003';
SELECT throws_like(
  $$SELECT * FROM public.get_admin_operator_client_reports_page()$$,
  'admin_required', 'Non-admin cannot read paged reports'
);
SELECT throws_like(
  $$SELECT * FROM public.get_admin_operator_client_reports_page(NULL, NULL, 0)$$,
  'admin_required', 'Admin authorization precedes input validation'
);

SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000113001';
SELECT throws_like(
  $$SELECT * FROM public.get_admin_operator_client_reports_page('2099-01-02 00:00Z')$$,
  'invalid_report_cursor', 'Timestamp-only cursor is rejected'
);
SELECT throws_like(
  $$SELECT * FROM public.get_admin_operator_client_reports_page(NULL, '00000000-0000-4000-8000-000000113202')$$,
  'invalid_report_cursor', 'ID-only cursor is rejected'
);
SELECT throws_like(
  $$SELECT * FROM public.get_admin_operator_client_reports_page(NULL, NULL, NULL)$$,
  'invalid_page_size', 'Null page size is rejected'
);
SELECT throws_like(
  $$SELECT * FROM public.get_admin_operator_client_reports_page(NULL, NULL, 0)$$,
  'invalid_page_size', 'Zero page size is rejected'
);
SELECT throws_like(
  $$SELECT * FROM public.get_admin_operator_client_reports_page(NULL, NULL, 102)$$,
  'invalid_page_size', 'Page size above 101 is rejected'
);

SELECT results_eq(
  $$SELECT id FROM public.get_admin_operator_client_reports_page(NULL, NULL, 2)$$,
  $$VALUES ('00000000-0000-4000-8000-000000113203'::uuid),
           ('00000000-0000-4000-8000-000000113202'::uuid)$$,
  'First page orders equal timestamps by descending ID and respects the limit'
);
SELECT results_eq(
  $$SELECT id FROM public.get_admin_operator_client_reports_page(
    '2099-01-02 00:00Z', '00000000-0000-4000-8000-000000113202', 2
  )$$,
  $$VALUES ('00000000-0000-4000-8000-000000113201'::uuid),
           ('00000000-0000-4000-8000-000000113204'::uuid)$$,
  'Cursor crosses timestamp tie without duplicates or skipped rows'
);
SELECT is(
  (SELECT count(*) FROM public.get_admin_operator_client_reports_page(NULL, NULL, 1)),
  1::bigint, 'One-row page size is accepted'
);
SELECT ok(
  (SELECT count(*) BETWEEN 4 AND 101 FROM public.get_admin_operator_client_reports_page()),
  'Default page size is accepted and caps the result at 101 rows'
);

SELECT * FROM finish();
ROLLBACK;
