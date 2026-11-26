BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT no_plan();

SELECT has_function('public', 'admin_set_user_status', ARRAY['uuid', 'text'],
  'Status changes use an authenticated DB transaction');
SELECT has_function('public', 'admin_update_user_db',
  ARRAY['uuid', 'text', 'text', 'text', 'app_role'],
  'Combined edits use an authenticated DB transaction');
SELECT ok(NOT has_function_privilege('public',
  'public.admin_set_user_status(uuid,text)', 'EXECUTE'), 'PUBLIC cannot set status');
SELECT ok(NOT has_function_privilege('public',
  'public.admin_update_user_db(uuid,text,text,text,public.app_role)', 'EXECUTE'),
  'PUBLIC cannot edit users');

INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-000000119501', 'authenticated', 'authenticated', 'status-admin@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000119502', 'authenticated', 'authenticated', 'status-operator@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000119503', 'authenticated', 'authenticated', 'status-client@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000119504', 'authenticated', 'authenticated', 'status-failing@example.invalid', '{}', '{}');
INSERT INTO public.user_roles (user_id, role)
VALUES ('00000000-0000-4000-8000-000000119501', 'admin');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000119503';
SELECT throws_like($$SELECT public.admin_set_user_status(
  '00000000-0000-4000-8000-000000119502', 'blocked')$$,
  'admin_required', 'Non-admin cannot block an operator');
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000119501';
SELECT is(public.admin_set_user_role('00000000-0000-4000-8000-000000119502', 'operator'),
  true, 'Target is an active operator before blocking');
SELECT throws_like($$SELECT public.admin_set_user_status(
  '00000000-0000-4000-8000-000000119501', 'blocked')$$,
  'cannot_change_own_status', 'Admin cannot block self');
SELECT is(public.admin_set_user_status('00000000-0000-4000-8000-000000119502', 'blocked'),
  true, 'Admin can block an operator');
SELECT ok(EXISTS (SELECT 1 FROM public.operators
  WHERE user_id = '00000000-0000-4000-8000-000000119502'
    AND NOT is_active AND availability_status = 'offline'),
  'Blocked operator is not allocatable');
SELECT is((SELECT count(*)::integer FROM public.audit_logs
  WHERE actor_user_id = '00000000-0000-4000-8000-000000119501'
    AND entity_id = '00000000-0000-4000-8000-000000119502'
    AND action = 'user.status_changed'), 1, 'Block and audit commit together');
SELECT throws_like($$SELECT public.admin_set_user_role(
  '00000000-0000-4000-8000-000000119502', 'operator')$$,
  'blocked_privileged_role_forbidden', 'Direct role RPC cannot reactivate a blocked operator');
SELECT is(public.admin_set_user_status('00000000-0000-4000-8000-000000119503', 'blocked'),
  true, 'Client is blocked before attempted admin promotion');
SELECT throws_like($$SELECT public.admin_set_user_role(
  '00000000-0000-4000-8000-000000119503', 'admin')$$,
  'blocked_privileged_role_forbidden', 'Blocked client cannot become admin');
SELECT is(public.admin_set_user_status('00000000-0000-4000-8000-000000119502', 'active'),
  true, 'Admin can unblock a non-archived operator');
SELECT ok(EXISTS (SELECT 1 FROM public.operators
  WHERE user_id = '00000000-0000-4000-8000-000000119502'
    AND NOT is_active AND availability_status = 'offline'),
  'Unblocking does not silently restore operator availability');
SELECT throws_like($$SELECT public.admin_update_user_db(
  '00000000-0000-4000-8000-000000119502', NULL, NULL, 'blocked', 'operator')$$,
  'blocked_privileged_role_forbidden', 'Combined edit cannot block and enable an operator');
SELECT is(public.admin_update_user_db('00000000-0000-4000-8000-000000119503',
  'Updated Client', NULL, 'blocked', NULL), true, 'Combined profile/status edit succeeds');
SELECT ok(EXISTS (SELECT 1 FROM public.profiles
  WHERE user_id = '00000000-0000-4000-8000-000000119503'
    AND display_name = 'Updated Client' AND status = 'blocked'),
  'Combined edit writes both fields');
SELECT is((SELECT count(*)::integer FROM public.audit_logs
  WHERE entity_id = '00000000-0000-4000-8000-000000119503'
    AND action = 'user.profile_updated'), 1,
  'Combined edit audits the profile fields');
SELECT is((SELECT count(*)::integer FROM public.audit_logs
  WHERE entity_id = '00000000-0000-4000-8000-000000119503'
    AND action = 'user.status_changed'), 2,
  'The preparation block and combined edit each audit status');

RESET ROLE;
CREATE FUNCTION pg_temp.wp11_reject_status_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'injected_status_audit_failure';
END;
$$;
CREATE TRIGGER wp11_reject_status_audit
  BEFORE INSERT ON public.audit_logs
  FOR EACH ROW WHEN (NEW.action = 'user.status_changed'
    AND NEW.entity_id = '00000000-0000-4000-8000-000000119504')
  EXECUTE FUNCTION pg_temp.wp11_reject_status_audit();
SET LOCAL ROLE authenticated;
SELECT throws_like($$SELECT public.admin_set_user_status(
  '00000000-0000-4000-8000-000000119504', 'blocked')$$,
  'injected_status_audit_failure', 'Audit failure rejects the status change');
SELECT ok(EXISTS (SELECT 1 FROM public.profiles
  WHERE user_id = '00000000-0000-4000-8000-000000119504' AND status = 'active'),
  'Audit failure rolls back the profile update');
SELECT * FROM finish();
ROLLBACK;
