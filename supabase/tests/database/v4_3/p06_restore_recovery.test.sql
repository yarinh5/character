BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT plan(22);

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

INSERT INTO auth.users (id, aud, role, email, email_confirmed_at)
VALUES
  ('00000000-0000-4000-8000-0000000d0601', 'authenticated', 'authenticated', 'p06-restore-owner@example.invalid', now()),
  ('00000000-0000-4000-8000-0000000d0602', 'authenticated', 'authenticated', 'p06-restore-client@example.invalid', now());
INSERT INTO public.user_roles (user_id, role)
VALUES ('00000000-0000-4000-8000-0000000d0601', 'admin');
INSERT INTO public.characters (id, name, is_active, is_visible, availability_status)
VALUES ('00000000-0000-4000-8000-0000000d0603', 'P06 recovery fixture', TRUE, TRUE, 'available');
INSERT INTO public.conversations (id, client_id, character_id, status)
VALUES ('00000000-0000-4000-8000-0000000d0604', '00000000-0000-4000-8000-0000000d0602',
        '00000000-0000-4000-8000-0000000d0603', 'open');

SELECT lives_ok(
  $$ SELECT private.ensure_active_client('00000000-0000-4000-8000-0000000d0602') $$,
  'the recovery fixture client is eligible before the gate blocks'
);

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-0000000d0602"}';
SELECT results_eq(
  $$ SELECT id FROM public.conversations WHERE id = '00000000-0000-4000-8000-0000000d0604' $$,
  ARRAY['00000000-0000-4000-8000-0000000d0604'::uuid],
  'the eligible client can read their conversation before recovery'
);
RESET ROLE;

SET LOCAL ROLE service_role;
SET LOCAL request.jwt.claims = '{"role":"service_role"}';
SELECT results_eq(
  $$ SELECT event_id, event_version, status FROM public.begin_restore_recovery_for_server(
    '00000000-0000-4000-8000-0000000d0605', 'fixture-recovery-lock', 'fixture-authority',
    'fixture-snapshot', now(), '00000000-0000-4000-8000-0000000d0601', repeat('a', 64)
  ) $$,
  $$ VALUES ('00000000-0000-4000-8000-0000000d0605'::uuid, 1, 'blocked'::text) $$,
  'beginning recovery blocks access before evidence import'
);
RESET ROLE;

SET LOCAL ROLE anon;
SET LOCAL request.jwt.claims = '{"role":"anon"}';
SELECT results_eq(
  $$ SELECT blocked FROM public.get_restore_recovery_access_state() $$,
  ARRAY[TRUE], 'the public recovery endpoint reports access blocked'
);
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-0000000d0602"}';
SELECT is_empty(
  $$ SELECT id FROM public.conversations WHERE id = '00000000-0000-4000-8000-0000000d0604' $$,
  'the same authenticated client cannot read the conversation during recovery'
);
SELECT throws_ok(
  $$ SELECT public.send_client_message('00000000-0000-4000-8000-0000000d0604', 'fixture message') $$,
  '42501', 'system_recovery_blocked', 'client send fails at the recovery gate before a write'
);
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-0000000d0601"}';
SELECT throws_ok(
  $$ SELECT public.admin_approve_restore_recovery('00000000-0000-4000-8000-0000000d0605', 1, 'fixture approval') $$,
  'P0001', 'restore_recovery_requirements_incomplete',
  'the event owner cannot approve before the required evidence is verified'
);
RESET ROLE;

SELECT is_empty(
  $$ SELECT id FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-0000000d0604' $$,
  'the blocked send left the conversation without messages'
);
SELECT results_eq(
  $$ SELECT requirement_name FROM private.restore_recovery_requirements
     WHERE event_id = '00000000-0000-4000-8000-0000000d0605' AND status = 'pending'
     ORDER BY requirement_name $$,
  ARRAY['deletion_replay', 'ledger_reconciliation', 'personal_data_review'],
  'unverified reconciliation, deletion replay and PII review remain pending'
);
SELECT results_eq(
  $$ SELECT access_state, current_event_id, recovery_deletion_replay_enabled
     FROM private.restore_recovery_control WHERE singleton $$,
  $$ VALUES ('blocked'::text, '00000000-0000-4000-8000-0000000d0605'::uuid, FALSE) $$,
  'missing evidence leaves the correct recovery event blocked and replay disabled'
);

SELECT * FROM finish();
ROLLBACK;
