BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('00000000-0000-4000-8000-000000112001', 'authenticated', 'authenticated', 'wp11-moderation-admin@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000112002', 'authenticated', 'authenticated', 'wp11-moderation-operator@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000112003', 'authenticated', 'authenticated', 'wp11-moderation-client@example.invalid', 'x', now(), '{}', '{}', now(), now());

INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-4000-8000-000000112001', 'admin'),
  ('00000000-0000-4000-8000-000000112002', 'operator')
ON CONFLICT (user_id, role) DO NOTHING;

INSERT INTO public.operators (id, user_id, full_name) VALUES
  ('00000000-0000-4000-8000-000000112101', '00000000-0000-4000-8000-000000112002', 'WP11 Moderation Operator');

INSERT INTO public.operator_client_reports (id, operator_id, client_id, reason) VALUES
  ('00000000-0000-4000-8000-000000112201', '00000000-0000-4000-8000-000000112101', '00000000-0000-4000-8000-000000112003', 'Fixture report');

SELECT plan(17);

SET LOCAL ROLE anon;
SET LOCAL "request.jwt.claim.role" = 'anon';
SET LOCAL "request.jwt.claim.sub" = '';
SELECT ok(
  NOT has_function_privilege(current_user,
    'public.admin_update_operator_client_report(uuid,integer,text,text,text)'::regprocedure, 'EXECUTE'),
  'Anonymous users cannot execute the moderation RPC'
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000112003';
SELECT ok(
  NOT has_table_privilege(current_user, 'public.operator_client_reports', 'SELECT,UPDATE'),
  'Authenticated users have no direct report table read or update grant'
);
SELECT throws_like(
  $$SELECT public.admin_update_operator_client_report('00000000-0000-4000-8000-000000112201', 1, 'in_progress', NULL)$$,
  'admin_required', 'Non-admin cannot moderate operator reports'
);
SELECT throws_like(
  $$SELECT * FROM public.get_admin_operator_client_reports()$$,
  'admin_required', 'Non-admin cannot read operator reports'
);

SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000112001';
SELECT is(
  (SELECT status FROM public.get_admin_operator_client_reports() WHERE id = '00000000-0000-4000-8000-000000112201'),
  'open', 'New reports are open'
);
SELECT is(
  (SELECT version FROM public.get_admin_operator_client_reports() WHERE id = '00000000-0000-4000-8000-000000112201'),
  1, 'New reports start at version one'
);
SELECT set_config('wp11_moderation.open_count',
  (SELECT open_operator_report_count FROM public.get_admin_operations_snapshot())::text, true);

SELECT is(
  (public.admin_update_operator_client_report('00000000-0000-4000-8000-000000112201', 1, 'in_progress', NULL)->>'version')::integer,
  2, 'In-progress update increments version'
);
SELECT is(
  (SELECT open_operator_report_count FROM public.get_admin_operations_snapshot()),
  current_setting('wp11_moderation.open_count')::integer,
  'In-progress reports remain in the unresolved count'
);
SELECT throws_like(
  $$SELECT public.admin_update_operator_client_report('00000000-0000-4000-8000-000000112201', 1, 'decided', 'Old decision')$$,
  'expected_version_mismatch', 'Stale writes are rejected'
);
SELECT throws_like(
  $$SELECT public.admin_update_operator_client_report('00000000-0000-4000-8000-000000112201', 2, 'decided', NULL)$$,
  'resolution_note_required', 'A decision requires a note'
);
SELECT is(
  (public.admin_update_operator_client_report('00000000-0000-4000-8000-000000112201', 2, 'decided', 'Reviewed evidence', 'Global restriction documented')->>'version')::integer,
  3, 'Decision increments version'
);
SELECT ok(
  (SELECT resolved_at IS NOT NULL AND resolved_by = '00000000-0000-4000-8000-000000112001'
      AND resolution_note = 'Reviewed evidence' AND global_action_note = 'Global restriction documented'
   FROM public.get_admin_operator_client_reports() WHERE id = '00000000-0000-4000-8000-000000112201'),
  'Admin read exposes decision metadata and documented global action'
);
SELECT is(
  (SELECT open_operator_report_count FROM public.get_admin_operations_snapshot()),
  current_setting('wp11_moderation.open_count')::integer - 1,
  'Decided reports leave the unresolved count'
);
SELECT is(
  (public.admin_update_operator_client_report('00000000-0000-4000-8000-000000112201', 3, 'closed', 'Reviewed evidence', 'Global restriction documented')->>'version')::integer,
  4, 'Closed update increments version'
);
SELECT is(
  (SELECT open_operator_report_count FROM public.get_admin_operations_snapshot()),
  current_setting('wp11_moderation.open_count')::integer - 1,
  'Closed reports stay out of the unresolved count'
);

RESET ROLE;
SELECT is(
  (SELECT count(*) FROM public.audit_logs
   WHERE entity_type = 'operator_client_report'
     AND entity_id = '00000000-0000-4000-8000-000000112201'
     AND action = 'operator_client_report.moderated'),
  3::bigint, 'Every successful moderation update is audited'
);
SELECT is(
  (SELECT metadata->>'global_action_note' FROM public.audit_logs
   WHERE entity_type = 'operator_client_report'
     AND entity_id = '00000000-0000-4000-8000-000000112201'
     AND action = 'operator_client_report.moderated'
   ORDER BY created_at DESC LIMIT 1),
  'Global restriction documented', 'Audit preserves the global-action note'
);

SELECT * FROM finish();
ROLLBACK;
