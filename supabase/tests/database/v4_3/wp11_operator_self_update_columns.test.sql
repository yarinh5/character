BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT plan(13);

SELECT ok(NOT has_table_privilege('authenticated', 'public.operators', 'UPDATE'),
  'Authenticated has no table-wide operator UPDATE');
SELECT ok(has_column_privilege('authenticated', 'public.operators', 'full_name', 'UPDATE'),
  'Operator name remains editable');
SELECT ok(has_column_privilege('authenticated', 'public.operators', 'availability_status', 'UPDATE'),
  'Operator availability remains editable');
SELECT ok(NOT has_column_privilege('authenticated', 'public.operators', 'is_active', 'UPDATE'),
  'Operator cannot reactivate itself');
SELECT ok(NOT has_column_privilege('authenticated', 'public.operators', 'deleted_at', 'UPDATE'),
  'Operator cannot clear its archive marker');
SELECT ok(NOT has_column_privilege('authenticated', 'public.operators', 'user_id', 'UPDATE'),
  'Operator cannot change its owner');
SELECT ok(NOT has_column_privilege('authenticated', 'public.operators', 'presence_status', 'UPDATE'),
  'Presence remains heartbeat-controlled');
SELECT ok(NOT has_column_privilege('anon', 'public.operators', 'full_name', 'UPDATE'),
  'Anonymous callers cannot edit operator names');

INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
VALUES ('00000000-0000-4000-8000-000000119401', 'authenticated', 'authenticated',
  'operator-self-update@example.invalid', '{}', '{}');
INSERT INTO public.user_roles (user_id, role)
VALUES ('00000000-0000-4000-8000-000000119401', 'operator');
INSERT INTO public.operators (id, user_id, full_name, is_active, availability_status)
VALUES ('00000000-0000-4000-8000-000000119402',
  '00000000-0000-4000-8000-000000119401', 'Before edit', true, 'available');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000119401';
SELECT lives_ok($$UPDATE public.operators SET full_name = 'After edit',
  availability_status = 'busy' WHERE id = '00000000-0000-4000-8000-000000119402'$$,
  'Operator can update the two intended columns');
SELECT throws_ok($$UPDATE public.operators SET is_active = false
  WHERE id = '00000000-0000-4000-8000-000000119402'$$,
  '42501');
SELECT throws_ok($$UPDATE public.operators SET deleted_at = NULL
  WHERE id = '00000000-0000-4000-8000-000000119402'$$,
  '42501');
RESET ROLE;

SELECT is((SELECT full_name || ':' || availability_status::text FROM public.operators
  WHERE id = '00000000-0000-4000-8000-000000119402'), 'After edit:busy',
  'Permitted self-edit persisted');
UPDATE public.operators SET is_active = false, deleted_at = clock_timestamp()
WHERE id = '00000000-0000-4000-8000-000000119402';
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000119401';
UPDATE public.operators SET full_name = 'Archived edit'
WHERE id = '00000000-0000-4000-8000-000000119402';
RESET ROLE;
SELECT is((SELECT full_name FROM public.operators
  WHERE id = '00000000-0000-4000-8000-000000119402'), 'After edit',
  'Archived operator cannot edit itself');

SELECT * FROM finish();
ROLLBACK;
