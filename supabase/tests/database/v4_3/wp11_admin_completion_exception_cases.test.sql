BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT no_plan();

SELECT has_function(
  'public', 'get_admin_completion_exception_cases',
  ARRAY['text', 'timestamp with time zone', 'text', 'uuid', 'integer'],
  'The bounded admin exception case RPC is installed'
);
SELECT ok(
  NOT has_function_privilege('public',
    'public.get_admin_completion_exception_cases(text,timestamptz,text,uuid,integer)', 'EXECUTE'),
  'PUBLIC cannot execute the case RPC'
);
SELECT ok(
  NOT has_function_privilege('anon',
    'public.get_admin_completion_exception_cases(text,timestamptz,text,uuid,integer)', 'EXECUTE'),
  'Anon cannot execute the case RPC'
);
SELECT ok(
  has_function_privilege('authenticated',
    'public.get_admin_completion_exception_cases(text,timestamptz,text,uuid,integer)', 'EXECUTE'),
  'Authenticated callers reach the admin-checked boundary'
);

-- Separate users avoid the one-active-or-failed-request-per-user index.
INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('00000000-0000-4000-8000-000000114001', 'authenticated', 'authenticated', 'wp11-case-admin@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000114002', 'authenticated', 'authenticated', 'wp11-case-one@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000114003', 'authenticated', 'authenticated', 'wp11-case-two@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000114004', 'authenticated', 'authenticated', 'wp11-case-three@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000114005', 'authenticated', 'authenticated', 'wp11-case-four@example.invalid', 'x', now(), '{}', '{}', now(), now());
INSERT INTO public.user_roles (user_id, role)
VALUES ('00000000-0000-4000-8000-000000114001', 'admin');

INSERT INTO public.account_deletion_requests (
  id, user_id, idempotency_key, status, requested_at, failure_code
) VALUES
  ('00000000-0000-4000-8000-000000114601', '00000000-0000-4000-8000-000000114002', '00000000-0000-4000-8000-000000114701', 'blocked_retention', '2099-01-02 00:00Z', 'retention_pending'),
  ('00000000-0000-4000-8000-000000114602', '00000000-0000-4000-8000-000000114003', '00000000-0000-4000-8000-000000114702', 'failed', '2099-01-02 00:00Z', 'step_failed'),
  ('00000000-0000-4000-8000-000000114603', '00000000-0000-4000-8000-000000114004', '00000000-0000-4000-8000-000000114703', 'failed', '2099-01-02 00:00Z', 'step_failed'),
  ('00000000-0000-4000-8000-000000114604', '00000000-0000-4000-8000-000000114005', '00000000-0000-4000-8000-000000114704', 'failed', '2099-01-01 00:00Z', 'older_failure');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000114002';
SELECT throws_like(
  $$SELECT * FROM public.get_admin_completion_exception_cases()$$,
  'admin_required', 'Non-admin cannot read exception cases'
);
SELECT throws_like(
  $$SELECT * FROM public.get_admin_completion_exception_cases('bogus', NULL, NULL, NULL, 0)$$,
  'admin_required', 'Authorization precedes input validation'
);

SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000114001';
SELECT throws_like(
  $$SELECT * FROM public.get_admin_completion_exception_cases('bogus')$$,
  'invalid_exception_kind', 'Unknown kind is rejected'
);
SELECT throws_like(
  $$SELECT * FROM public.get_admin_completion_exception_cases(NULL, '2099-01-02 00:00Z')$$,
  'invalid_exception_cursor', 'Partial cursor is rejected'
);
SELECT throws_like(
  $$SELECT * FROM public.get_admin_completion_exception_cases(NULL, NULL, 'account_deletion_failed', '00000000-0000-4000-8000-000000114602')$$,
  'invalid_exception_cursor', 'Cursor without timestamp is rejected'
);
SELECT throws_like(
  $$SELECT * FROM public.get_admin_completion_exception_cases(NULL, NULL, NULL, NULL, NULL)$$,
  'invalid_page_size', 'Null page size is rejected'
);
SELECT throws_like(
  $$SELECT * FROM public.get_admin_completion_exception_cases(NULL, NULL, NULL, NULL, 0)$$,
  'invalid_page_size', 'Zero page size is rejected'
);
SELECT throws_like(
  $$SELECT * FROM public.get_admin_completion_exception_cases(NULL, NULL, NULL, NULL, 102)$$,
  'invalid_page_size', 'Page size above 101 is rejected'
);

SELECT results_eq(
  $$SELECT kind, id FROM public.get_admin_completion_exception_cases(NULL, NULL, NULL, NULL, 2)$$,
  $$VALUES
    ('account_deletion_failed'::text, '00000000-0000-4000-8000-000000114603'::uuid),
    ('account_deletion_failed'::text, '00000000-0000-4000-8000-000000114602'::uuid)$$,
  'First page orders timestamp and same-kind ID ties descending'
);
SELECT results_eq(
  $$SELECT kind, id FROM public.get_admin_completion_exception_cases(
    NULL, '2099-01-02 00:00Z', 'account_deletion_failed', '00000000-0000-4000-8000-000000114602', 2
  )$$,
  $$VALUES
    ('account_deletion_blocked'::text, '00000000-0000-4000-8000-000000114601'::uuid),
    ('account_deletion_failed'::text, '00000000-0000-4000-8000-000000114604'::uuid)$$,
  'Cursor crosses kind and timestamp ties without duplication'
);
SELECT results_eq(
  $$SELECT id FROM public.get_admin_completion_exception_cases('account_deletion_blocked')$$,
  $$VALUES ('00000000-0000-4000-8000-000000114601'::uuid)$$,
  'Kind filter returns only matching cases'
);
SELECT is(
  (SELECT count(*) FROM public.get_admin_completion_exception_cases('gift_unallocated')),
  0::bigint, 'Kind filter excludes other categories'
);
SELECT is(
  (SELECT count(*) FROM public.get_admin_completion_exception_cases(NULL, NULL, NULL, NULL, 1)),
  1::bigint, 'Minimum page size is accepted'
);
SELECT is(
  (SELECT code FROM public.get_admin_completion_exception_cases('account_deletion_blocked')),
  'retention_pending', 'Only the structured failure code is returned'
);
SELECT is(
  (SELECT subject_id FROM public.get_admin_completion_exception_cases('account_deletion_blocked')),
  '00000000-0000-4000-8000-000000114002'::uuid,
  'Account deletion subject is its user ID'
);
SELECT ok(
  (SELECT count(*) BETWEEN 4 AND 101 FROM public.get_admin_completion_exception_cases()),
  'Default page size is accepted and bounded'
);

SELECT * FROM finish();
ROLLBACK;
