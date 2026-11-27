BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT plan(13);

SELECT ok(NOT has_table_privilege('authenticated', 'public.profiles', 'UPDATE'),
  'Authenticated has no table-wide profile UPDATE');
SELECT ok(has_column_privilege('authenticated', 'public.profiles', 'display_name', 'UPDATE'),
  'Display name remains editable');
SELECT ok(NOT has_column_privilege('authenticated', 'public.profiles', 'email', 'UPDATE'),
  'User cannot forge the directory email');
SELECT ok(NOT has_column_privilege('authenticated', 'public.profiles', 'status', 'UPDATE'),
  'User cannot change account state directly');
SELECT ok(NOT has_column_privilege('authenticated', 'public.profiles', 'avatar_url', 'UPDATE'),
  'Avatar remains on its server-owned workflow');
SELECT ok(NOT has_column_privilege('authenticated', 'public.profiles', 'deleted_at', 'UPDATE'),
  'User cannot change the archive marker');
SELECT ok(NOT has_column_privilege('authenticated', 'public.profiles', 'pii_archived_at', 'UPDATE'),
  'User cannot change the PII archive marker');
SELECT ok(NOT has_column_privilege('anon', 'public.profiles', 'display_name', 'UPDATE'),
  'Anonymous callers cannot edit profiles');
SELECT ok(has_table_privilege('service_role', 'public.profiles', 'UPDATE'),
  'Server-owned profile writes retain table UPDATE');

INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
VALUES ('00000000-0000-4000-8000-000000119501', 'authenticated', 'authenticated',
  'profile-self-update@example.invalid', '{}', '{}');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000119501';
SELECT lives_ok($$UPDATE public.profiles SET display_name = 'Edited name'
  WHERE user_id = '00000000-0000-4000-8000-000000119501'$$,
  'Active user can edit their display name');
SELECT throws_ok($$UPDATE public.profiles SET email = 'forged@example.invalid'
  WHERE user_id = '00000000-0000-4000-8000-000000119501'$$, '42501');
SELECT throws_ok($$UPDATE public.profiles SET avatar_url = 'https://example.invalid/forged.png'
  WHERE user_id = '00000000-0000-4000-8000-000000119501'$$, '42501');
RESET ROLE;
SELECT is((SELECT display_name FROM public.profiles
  WHERE user_id = '00000000-0000-4000-8000-000000119501'), 'Edited name',
  'Permitted display-name edit persisted');

SELECT * FROM finish();
ROLLBACK;
