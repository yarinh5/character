BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT no_plan();

SELECT has_function('public', 'admin_set_user_role', ARRAY['uuid', 'app_role'],
  'Admin role transition exposes the typed RPC');
SELECT ok(NOT has_function_privilege('public',
  'public.admin_set_user_role(uuid,public.app_role)', 'EXECUTE'),
  'PUBLIC cannot execute the role transition');
SET LOCAL ROLE anon;
SELECT ok(NOT has_function_privilege(current_user,
  'public.admin_set_user_role(uuid,public.app_role)', 'EXECUTE'),
  'Anon cannot execute the role transition');
RESET ROLE;

INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-000000119301', 'authenticated', 'authenticated', 'role-admin@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000119302', 'authenticated', 'authenticated', 'role-target@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000119303', 'authenticated', 'authenticated', 'role-client@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000119304', 'authenticated', 'authenticated', 'role-orphan@example.invalid', '{}', '{}');
INSERT INTO public.user_roles (user_id, role)
VALUES ('00000000-0000-4000-8000-000000119301', 'admin');
UPDATE public.profiles SET display_name = 'Role Target'
WHERE user_id = '00000000-0000-4000-8000-000000119302';
DELETE FROM public.profiles
WHERE user_id = '00000000-0000-4000-8000-000000119304';

SET LOCAL ROLE authenticated;
SELECT ok(has_function_privilege(current_user,
  'public.admin_set_user_role(uuid,public.app_role)', 'EXECUTE'),
  'Authenticated can invoke the guarded RPC');
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '';
SELECT throws_like($$SELECT public.admin_set_user_role(
  '00000000-0000-4000-8000-000000119302', 'operator')$$,
  'admin_required', 'Missing JWT subject is rejected');
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000119303';
SELECT throws_like($$SELECT public.admin_set_user_role(
  '00000000-0000-4000-8000-000000119302', 'operator')$$,
  'admin_required', 'Non-admin is rejected');
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000119301';
SELECT throws_like($$SELECT public.admin_set_user_role(
  '00000000-0000-4000-8000-000000119301', 'operator')$$,
  'cannot_change_own_role', 'Admin cannot change their own role');
SELECT throws_like($$SELECT public.admin_set_user_role(
  '00000000-0000-4000-8000-000000119304', 'operator')$$,
  'target_profile_not_found', 'Missing target profile is rejected');
SELECT results_eq(
  $$SELECT role FROM public.user_roles
    WHERE user_id = '00000000-0000-4000-8000-000000119302'$$,
  $$VALUES ('client'::public.app_role)$$,
  'Rejected calls leave the target role unchanged');
SELECT is((SELECT count(*)::integer FROM public.audit_logs
  WHERE action = 'user.role_changed' AND entity_id = '00000000-0000-4000-8000-000000119302'),
  0, 'Rejected calls write no target audit entry');

SELECT is(public.admin_set_user_role('00000000-0000-4000-8000-000000119302', 'operator'),
  true, 'Client can become operator');
SELECT results_eq(
  $$SELECT role FROM public.user_roles
    WHERE user_id = '00000000-0000-4000-8000-000000119302'$$,
  $$VALUES ('operator'::public.app_role)$$,
  'Operator transition replaces every previous role');
SELECT ok(EXISTS (SELECT 1 FROM public.operators
  WHERE user_id = '00000000-0000-4000-8000-000000119302'
    AND full_name = 'Role Target' AND is_active AND availability_status = 'available'),
  'Operator record is created active with profile name');

SELECT is(public.admin_set_user_role('00000000-0000-4000-8000-000000119302', 'admin'),
  true, 'Operator can become admin');
SELECT results_eq(
  $$SELECT role FROM public.user_roles
    WHERE user_id = '00000000-0000-4000-8000-000000119302'$$,
  $$VALUES ('admin'::public.app_role)$$,
  'Admin transition leaves exactly the admin role');
SELECT ok(EXISTS (SELECT 1 FROM public.operators
  WHERE user_id = '00000000-0000-4000-8000-000000119302'
    AND is_active AND availability_status = 'available'),
  'Admin transition preserves the existing operator state');

RESET ROLE;
UPDATE public.operators SET is_active = false, availability_status = 'offline'
WHERE user_id = '00000000-0000-4000-8000-000000119302';
SET LOCAL ROLE authenticated;
SELECT is(public.admin_set_user_role('00000000-0000-4000-8000-000000119302', 'operator'),
  true, 'Inactive operator can be restored');
SELECT ok(EXISTS (SELECT 1 FROM public.operators
  WHERE user_id = '00000000-0000-4000-8000-000000119302'
    AND is_active AND availability_status = 'available'),
  'Existing operator is reactivated and available');

RESET ROLE;
DELETE FROM public.client_profiles
WHERE user_id = '00000000-0000-4000-8000-000000119302';
SET LOCAL ROLE authenticated;
SELECT is(public.admin_set_user_role('00000000-0000-4000-8000-000000119302', 'client'),
  true, 'Operator can become client');
SELECT results_eq(
  $$SELECT role FROM public.user_roles
    WHERE user_id = '00000000-0000-4000-8000-000000119302'$$,
  $$VALUES ('client'::public.app_role)$$,
  'Client transition leaves exactly the client role');
SELECT ok(EXISTS (SELECT 1 FROM public.operators
  WHERE user_id = '00000000-0000-4000-8000-000000119302'
    AND NOT is_active AND availability_status = 'offline'),
  'Client transition deactivates the operator record');
SELECT ok(EXISTS (SELECT 1 FROM public.client_profiles
  WHERE user_id = '00000000-0000-4000-8000-000000119302'),
  'Client transition creates the missing client profile');
SELECT is((SELECT count(*)::integer FROM public.audit_logs
  WHERE action = 'user.role_changed' AND entity_type = 'user'
    AND entity_id = '00000000-0000-4000-8000-000000119302'
    AND actor_user_id = '00000000-0000-4000-8000-000000119301'
    AND metadata ->> 'role' IN ('operator', 'admin', 'client')),
  4, 'Every successful transition writes its actor, target and role audit');

RESET ROLE;
CREATE FUNCTION pg_temp.wp11_reject_role_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'injected_audit_failure';
END;
$$;
CREATE TRIGGER wp11_reject_role_audit
  BEFORE INSERT ON public.audit_logs
  FOR EACH ROW WHEN (NEW.action = 'user.role_changed')
  EXECUTE FUNCTION pg_temp.wp11_reject_role_audit();
SET LOCAL ROLE authenticated;
SELECT throws_like($$SELECT public.admin_set_user_role(
  '00000000-0000-4000-8000-000000119302', 'operator')$$,
  'injected_audit_failure', 'Audit failure aborts the role transition');
SELECT results_eq(
  $$SELECT role FROM public.user_roles
    WHERE user_id = '00000000-0000-4000-8000-000000119302'$$,
  $$VALUES ('client'::public.app_role)$$,
  'Failed audit rolls role replacement back');
SELECT ok(EXISTS (SELECT 1 FROM public.operators
  WHERE user_id = '00000000-0000-4000-8000-000000119302'
    AND NOT is_active AND availability_status = 'offline'),
  'Failed audit rolls operator reactivation back');
SELECT is((SELECT count(*)::integer FROM public.audit_logs
  WHERE action = 'user.role_changed' AND entity_id = '00000000-0000-4000-8000-000000119302'),
  4, 'Failed transition leaves audit count unchanged');

SELECT * FROM finish();
ROLLBACK;
