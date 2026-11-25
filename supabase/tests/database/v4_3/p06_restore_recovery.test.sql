BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT plan(12);

SELECT has_table('private', 'restore_recovery_events', 'restore recovery event ledger exists');
SELECT has_table('private', 'restore_recovery_requirements', 'recovery requirements exist');
SELECT has_table('private', 'restore_recovery_authority_manifests', 'external authority manifests exist');
SELECT has_table('private', 'restore_recovery_reconciliation_results', 'reconciliation evidence exists');
SELECT has_table('private', 'restore_recovery_deletion_replay', 'deletion replay queue exists');
SELECT has_function('public', 'begin_restore_recovery_for_server', ARRAY['uuid','text','text','text','timestamp with time zone','uuid','text'], 'server can establish a blocked restore event');
SELECT has_function('public', 'finalize_restore_recovery_import_for_server', ARRAY['uuid','integer'], 'server finalizes imported recovery evidence');
SELECT has_function('public', 'admin_approve_restore_recovery', ARRAY['uuid','integer','text'], 'admin approval is event/version scoped');
SELECT has_function('public', 'complete_restore_recovery_release_for_server', ARRAY['uuid','integer','text','text'], 'external release has a separate server boundary');
SELECT function_privs_are('public', 'begin_restore_recovery_for_server', ARRAY['uuid','text','text','text','timestamp with time zone','uuid','text'], 'service_role', ARRAY['EXECUTE'], 'only service role receives the recovery entrypoint');
SELECT function_privs_are('public', 'admin_approve_restore_recovery', ARRAY['uuid','integer','text'], 'anon', ARRAY[]::text[], 'anonymous users cannot approve reopening');
SELECT results_eq(
  $$ SELECT recovery_deletion_replay_enabled FROM private.restore_recovery_control WHERE singleton $$,
  ARRAY[FALSE],
  'irreversible deletion replay is disabled by default'
);

SELECT * FROM finish();
ROLLBACK;
