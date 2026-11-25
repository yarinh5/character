BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT plan(15);

SELECT has_column('private', 'support_operations_config', 'support_timezone', 'support timezone is explicit');
SELECT has_column('private', 'support_operations_config', 'support_weekdays', 'support weekdays are explicit');
SELECT has_column('private', 'support_operations_config', 'support_day_start', 'support start time is explicit');
SELECT has_column('private', 'support_operations_config', 'support_day_end', 'support end time is explicit');
SELECT has_column('private', 'support_operations_config', 'escalation_adapter_state', 'adapter state is separate from recipient configuration');
SELECT has_function('public', 'get_support_operations_config_v2', ARRAY[]::text[], 'admin can read bounded configuration state');
SELECT has_function(
  'public', 'admin_set_support_operations_config_v2',
  ARRAY['integer','text','uuid','uuid','text','text','text','smallint[]','time without time zone','time without time zone'],
  'admin updates configuration with a version guard'
);
SELECT function_privs_are(
  'public', 'record_support_escalation_adapter_state_for_server', ARRAY['text','text'],
  'authenticated', ARRAY[]::text[], 'authenticated users cannot mark an adapter verified'
);
SELECT function_privs_are(
  'public', 'record_support_escalation_adapter_state_for_server', ARRAY['text','text'],
  'service_role', ARRAY['EXECUTE'], 'only the server adapter boundary records verification'
);
SELECT function_privs_are(
  'public', 'admin_record_support_incident_delivery', ARRAY['uuid','integer','text','text'],
  'authenticated', ARRAY[]::text[], 'admins cannot claim external delivery manually'
);
SELECT has_column('public', 'client_consent_documents', 'lifecycle_status', 'legal documents have an explicit lifecycle');
SELECT has_column('public', 'client_consent_documents', 'approved_at', 'legal approval time is recorded');
SELECT has_column('public', 'client_consent_documents', 'approved_by', 'legal approver identity is recorded');
SELECT has_column('public', 'client_consent_documents', 'approval_reference', 'legal approval reference is recorded');
SELECT results_eq(
  $$ SELECT count(*) FROM public.client_consent_documents WHERE lifecycle_status = 'active' AND approved_at IS NULL $$,
  ARRAY[0::bigint],
  'no active legal document can lack approval evidence'
);

SELECT * FROM finish();
ROLLBACK;
