BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT no_plan();

SELECT has_function('public', 'admin_soft_delete_user', ARRAY['uuid'],
  'Admin soft delete exposes a guarded RPC');
SELECT ok(NOT has_function_privilege('public',
  'public.admin_soft_delete_user(uuid)', 'EXECUTE'),
  'PUBLIC cannot execute soft delete');
SET LOCAL ROLE anon;
SELECT ok(NOT has_function_privilege(current_user,
  'public.admin_soft_delete_user(uuid)', 'EXECUTE'),
  'Anon cannot execute soft delete');
RESET ROLE;

INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-000000119401', 'authenticated', 'authenticated', 'archive-admin@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000119402', 'authenticated', 'authenticated', 'archive-operator@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000119403', 'authenticated', 'authenticated', 'archive-client@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000119404', 'authenticated', 'authenticated', 'archive-failing@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000119405', 'authenticated', 'authenticated', 'archive-admin-target@example.invalid', '{}', '{}');
INSERT INTO public.user_roles (user_id, role)
VALUES ('00000000-0000-4000-8000-000000119401', 'admin'),
  ('00000000-0000-4000-8000-000000119405', 'admin');
INSERT INTO public.operators (user_id, full_name)
VALUES ('00000000-0000-4000-8000-000000119402', 'Archive Operator');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000119403';
SELECT throws_like($$SELECT public.admin_soft_delete_user(
  '00000000-0000-4000-8000-000000119402')$$,
  'admin_required', 'Non-admin cannot archive another user');
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000119401';
SELECT throws_like($$SELECT public.admin_soft_delete_user(
  '00000000-0000-4000-8000-000000119401')$$,
  'cannot_delete_own_account', 'Admin cannot archive self');
SELECT throws_like($$SELECT public.admin_soft_delete_user(
  '00000000-0000-4000-8000-000000119499')$$,
  'target_profile_not_found', 'Missing profile is rejected');
SELECT throws_like($$SELECT public.admin_soft_delete_user(
  '00000000-0000-4000-8000-000000119405')$$,
  'admin_account_requires_separate_deprovisioning',
  'Admin cannot archive another admin');
SELECT throws_like($$SELECT public.admin_soft_delete_user(NULL)$$,
  'target_user_required', 'Missing target is rejected');
SELECT ok(EXISTS (SELECT 1 FROM public.profiles
  WHERE user_id = '00000000-0000-4000-8000-000000119402'
    AND deleted_at IS NULL AND status = 'active'),
  'Rejected calls leave the target active');

SELECT is(public.admin_soft_delete_user('00000000-0000-4000-8000-000000119402'),
  true, 'Admin can archive an operator');
SELECT ok(EXISTS (SELECT 1 FROM public.profiles
  WHERE user_id = '00000000-0000-4000-8000-000000119402'
    AND status = 'blocked' AND deleted_at IS NOT NULL
    AND email = 'deleted+00000000000040008000000000119402@deleted.local'),
  'Profile is blocked, timestamped and anonymized');
SELECT ok(EXISTS (SELECT 1 FROM public.operators
  WHERE user_id = '00000000-0000-4000-8000-000000119402'
    AND NOT is_active AND availability_status = 'offline'
    AND deleted_at = (SELECT deleted_at FROM public.profiles
      WHERE user_id = '00000000-0000-4000-8000-000000119402')),
  'Operator is deactivated with the same archive timestamp');
SELECT is((SELECT count(*)::integer FROM public.audit_logs
  WHERE action = 'user.soft_deleted' AND entity_id = '00000000-0000-4000-8000-000000119402'
    AND actor_user_id = '00000000-0000-4000-8000-000000119401'
    AND metadata ->> 'repeated' = 'false'), 1,
  'First archive records actor and target once');

CREATE TEMP TABLE wp11_archive_marker AS
SELECT deleted_at FROM public.profiles
WHERE user_id = '00000000-0000-4000-8000-000000119402';
SELECT is(public.admin_soft_delete_user('00000000-0000-4000-8000-000000119402'),
  true, 'Repeated archive remains valid');
SELECT is((SELECT deleted_at FROM public.profiles
  WHERE user_id = '00000000-0000-4000-8000-000000119402'),
  (SELECT deleted_at FROM wp11_archive_marker),
  'Repeated archive preserves the retention start');
SELECT is((SELECT count(*)::integer FROM public.audit_logs
  WHERE action = 'user.soft_deleted' AND entity_id = '00000000-0000-4000-8000-000000119402'
    AND metadata ->> 'repeated' = 'true'), 1,
  'Repeated archive is auditable');
SELECT throws_like($$SELECT public.admin_soft_delete_user(
  '00000000-0000-4000-8000-000000119401')$$,
  'cannot_delete_own_account', 'Admin target remains protected');

RESET ROLE;
CREATE FUNCTION pg_temp.wp11_reject_soft_delete_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'injected_soft_delete_audit_failure';
END;
$$;
CREATE TRIGGER wp11_reject_soft_delete_audit
  BEFORE INSERT ON public.audit_logs
  FOR EACH ROW WHEN (NEW.action = 'user.soft_deleted'
    AND NEW.entity_id = '00000000-0000-4000-8000-000000119404')
  EXECUTE FUNCTION pg_temp.wp11_reject_soft_delete_audit();
SET LOCAL ROLE authenticated;
SELECT throws_like($$SELECT public.admin_soft_delete_user(
  '00000000-0000-4000-8000-000000119404')$$,
  'injected_soft_delete_audit_failure',
  'Audit failure aborts the DB archive transaction');
SELECT ok(EXISTS (SELECT 1 FROM public.profiles
  WHERE user_id = '00000000-0000-4000-8000-000000119404'
    AND deleted_at IS NULL AND status = 'active'
    AND email = 'archive-failing@example.invalid'),
  'Failed audit rolls back profile changes');
SELECT is((SELECT count(*)::integer FROM public.audit_logs
  WHERE action = 'user.soft_deleted' AND entity_id = '00000000-0000-4000-8000-000000119404'),
  0, 'Failed audit leaves no archive entry');

SELECT * FROM finish();
ROLLBACK;
