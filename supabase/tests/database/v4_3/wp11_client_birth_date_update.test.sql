BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT plan(10);

SELECT ok(NOT has_function_privilege('anon', 'public.update_client_birth_date(date)', 'EXECUTE'),
  'Anonymous caller cannot edit a birth date');
SELECT ok(has_function_privilege('authenticated', 'public.update_client_birth_date(date)', 'EXECUTE'),
  'Authenticated client can use the DOB-only RPC');

INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
VALUES ('00000000-0000-4000-8000-000000119701', 'authenticated', 'authenticated',
  'birth-date-update@example.invalid', '{}', '{}');
UPDATE public.profiles SET display_name = 'Custom display name'
WHERE user_id = '00000000-0000-4000-8000-000000119701';
UPDATE public.client_profiles SET interests = ARRAY['independent']
WHERE user_id = '00000000-0000-4000-8000-000000119701';
UPDATE public.client_profiles
SET onboarding_completed_at = TIMESTAMPTZ '2026-01-01T00:00:00Z'
WHERE user_id = '00000000-0000-4000-8000-000000119701';
UPDATE public.system_settings SET value = 'true'::jsonb
WHERE key = 'mandatory_onboarding_enabled';

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000119701';
SELECT is(public.update_client_birth_date(DATE '1995-01-01') ->> 'date_of_birth',
  '1995-01-01', 'RPC returns the stored birth date');
SELECT throws_ok($$SELECT public.update_client_birth_date(NULL)$$, '22023');
SELECT throws_ok($$SELECT public.update_client_birth_date(CURRENT_DATE)$$, '22023');
RESET ROLE;

SELECT is((SELECT computed_age FROM public.client_profiles
  WHERE user_id = '00000000-0000-4000-8000-000000119701'),
  EXTRACT(YEAR FROM age(CURRENT_DATE, DATE '1995-01-01'))::integer,
  'Server derives the adult age');
SELECT is((SELECT display_name FROM public.profiles
  WHERE user_id = '00000000-0000-4000-8000-000000119701'),
  'Custom display name', 'DOB edit does not rewrite display name');
SELECT is((SELECT interests FROM public.client_profiles
  WHERE user_id = '00000000-0000-4000-8000-000000119701'),
  ARRAY['independent'], 'DOB edit does not rewrite interests');
SELECT is((SELECT onboarding_completed_at FROM public.client_profiles
  WHERE user_id = '00000000-0000-4000-8000-000000119701'),
  TIMESTAMPTZ '2026-01-01T00:00:00Z', 'DOB edit preserves existing onboarding completion');

UPDATE public.profiles SET status = 'blocked'
WHERE user_id = '00000000-0000-4000-8000-000000119701';
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.update_client_birth_date(DATE '1994-01-01')$$, '42501');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
