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

SELECT pg_temp.v4_3_create_user(
  '00000000-0000-4000-8000-000000000111'::uuid,
  'v4-3-non-admin@example.invalid'
);
SELECT pg_temp.v4_3_create_user(
  '00000000-0000-4000-8000-000000000112'::uuid,
  'v4-3-admin@example.invalid'
);
SELECT pg_temp.v4_3_add_role('00000000-0000-4000-8000-000000000112'::uuid, 'admin');

SELECT plan(8);

SET LOCAL ROLE anon;
SET LOCAL "request.jwt.claim.role" = 'anon';
SET LOCAL "request.jwt.claim.sub" = '';
SELECT is(current_user::text, 'anon'::text, 'Anonymous check runs as anon');
SELECT ok(auth.uid() IS NULL, 'Anonymous JWT has no auth.uid');
SELECT ok(
  NOT has_function_privilege(
    current_user,
    'public.get_admin_operations_snapshot()'::regprocedure,
    'EXECUTE'
  ),
  'Anonymous role cannot execute the Admin snapshot'
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000111';
SELECT is(current_user::text, 'authenticated'::text, 'Non-Admin check runs as authenticated');
SELECT is(auth.uid(), '00000000-0000-4000-8000-000000000111'::uuid, 'Non-Admin JWT resolves to auth.uid');
SELECT throws_like(
  $$SELECT * FROM public.get_admin_operations_snapshot()$$,
  'admin_required',
  'Authenticated non-Admin is rejected by the internal guard'
);

SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000112';
SELECT is(
  (SELECT count(*) FROM public.get_admin_operations_snapshot()),
  1::bigint,
  'Admin receives exactly one aggregate snapshot row'
);
SELECT ok(
  (
    SELECT to_jsonb(snapshot) ?& ARRAY['generated_at', 'new_total', 'active_operator_count', 'media_asset_total']
    FROM public.get_admin_operations_snapshot() snapshot
  ),
  'Snapshot exposes aggregate operational fields'
);

SELECT * FROM finish();
ROLLBACK;
