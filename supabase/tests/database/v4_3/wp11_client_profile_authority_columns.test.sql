BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT plan(19);

SELECT ok(NOT has_table_privilege('authenticated', 'public.client_profiles', 'INSERT'),
  'Browser cannot insert a completed client profile');
SELECT ok(NOT has_table_privilege('authenticated', 'public.client_profiles', 'UPDATE'),
  'Browser has no table-wide client profile UPDATE');
SELECT ok(has_column_privilege('authenticated', 'public.client_profiles', 'bio', 'UPDATE'),
  'Client biography remains editable');
SELECT ok(has_column_privilege('authenticated', 'public.client_profiles', 'conversation_preferences', 'UPDATE'),
  'Conversation preferences remain editable');
SELECT ok(NOT has_column_privilege('authenticated', 'public.client_profiles', 'date_of_birth', 'UPDATE'),
  'Birth date changes use validated onboarding RPC');
SELECT ok(NOT has_column_privilege('authenticated', 'public.client_profiles', 'age', 'UPDATE'),
  'Browser cannot forge legacy age');
SELECT ok(NOT has_column_privilege('authenticated', 'public.client_profiles', 'computed_age', 'UPDATE'),
  'Browser cannot forge computed age');
SELECT ok(NOT has_column_privilege('authenticated', 'public.client_profiles', 'onboarding_step', 'UPDATE'),
  'Browser cannot forge onboarding progress');
SELECT ok(NOT has_column_privilege('authenticated', 'public.client_profiles', 'onboarding_completed_at', 'UPDATE'),
  'Browser cannot forge onboarding completion');
SELECT ok(NOT has_column_privilege('authenticated', 'public.client_profiles', 'profile_image_url', 'UPDATE'),
  'Profile image changes use the validated image RPC');
SELECT ok(NOT has_column_privilege('authenticated', 'public.client_profiles', 'user_id', 'UPDATE'),
  'Browser cannot reassign profile ownership');
SELECT ok(NOT has_column_privilege('anon', 'public.client_profiles', 'bio', 'UPDATE'),
  'Anonymous caller cannot edit a client profile');
SELECT ok(has_table_privilege('service_role', 'public.client_profiles', 'UPDATE'),
  'Trusted server writes retain table UPDATE');

INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
VALUES ('00000000-0000-4000-8000-000000119601', 'authenticated', 'authenticated',
  'client-profile-authority@example.invalid', '{}', '{}');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000119601';
SELECT lives_ok($$UPDATE public.client_profiles SET bio = 'Edited biography'
  WHERE user_id = '00000000-0000-4000-8000-000000119601'$$,
  'Active client can edit an ordinary profile field');
SELECT throws_ok($$UPDATE public.client_profiles SET onboarding_completed_at = clock_timestamp()
  WHERE user_id = '00000000-0000-4000-8000-000000119601'$$, '42501');
SELECT throws_ok($$UPDATE public.client_profiles SET date_of_birth = DATE '1995-01-01'
  WHERE user_id = '00000000-0000-4000-8000-000000119601'$$, '42501');
SELECT lives_ok($$SELECT public.save_client_onboarding_step(
  '{"date_of_birth":"1995-01-01"}'::jsonb)$$,
  'Validated server RPC still updates birth date');
RESET ROLE;
SELECT is((SELECT bio FROM public.client_profiles
  WHERE user_id = '00000000-0000-4000-8000-000000119601'), 'Edited biography',
  'Permitted client edit persisted');
SELECT is((SELECT computed_age FROM public.client_profiles
  WHERE user_id = '00000000-0000-4000-8000-000000119601'),
  EXTRACT(YEAR FROM age(CURRENT_DATE, DATE '1995-01-01'))::integer,
  'Birth-date RPC derives the server-side age');

SELECT * FROM finish();
ROLLBACK;
