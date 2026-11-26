BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT plan(42);

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

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-0000000d0601"}';
SELECT results_eq(
  $$ SELECT (result->>'balance_after')::integer - (result->>'balance_before')::integer
     FROM public.admin_adjust_client_credits(
       '00000000-0000-4000-8000-0000000d0602', 10, 'fixture credit before recovery'
     ) AS adjustment(result) $$,
  ARRAY[10], 'the authorized admin can adjust this client wallet before recovery'
);
RESET ROLE;

CREATE TEMP TABLE recovery_wallet_before ON COMMIT DROP AS
SELECT balance, lifetime_earned, lifetime_spent FROM public.credit_wallets
WHERE user_id = '00000000-0000-4000-8000-0000000d0602';

SET LOCAL ROLE service_role;
SET LOCAL request.jwt.claims = '{"role":"service_role"}';
SELECT throws_ok(
  $$ DO $fixture$ BEGIN
       PERFORM public.begin_restore_recovery_for_server(
         '00000000-0000-4000-8000-0000000d0605', 'fixture-recovery-lock', 'fixture-authority',
         'fixture-snapshot', '-infinity', '00000000-0000-4000-8000-0000000d0601', repeat('a', 64)
       );
       RAISE EXCEPTION 'fixture_expected_snapshot_rejection';
     END $fixture$ $$,
  '23514', 'new row for relation "restore_recovery_events" violates check constraint "restore_recovery_snapshot_time_finite"',
  'a non-finite snapshot cannot start a blocked recovery event'
);
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
SELECT throws_ok(
  $$ SELECT public.admin_adjust_client_credits(
    '00000000-0000-4000-8000-0000000d0602', 10, 'fixture credit during recovery'
  ) $$,
  '42501', 'system_recovery_blocked', 'even an authorized admin cannot adjust credits during recovery'
);
RESET ROLE;

SELECT results_eq(
  $$ SELECT balance, lifetime_earned, lifetime_spent FROM public.credit_wallets
     WHERE user_id = '00000000-0000-4000-8000-0000000d0602' $$,
  $$ SELECT balance, lifetime_earned, lifetime_spent FROM recovery_wallet_before $$,
  'the rejected adjustment did not change the restored wallet'
);
SELECT results_eq(
  $$ SELECT amount, reason FROM public.credit_transactions
     WHERE user_id = '00000000-0000-4000-8000-0000000d0602' AND type = 'admin_adjustment' $$,
  $$ VALUES (10, 'fixture credit before recovery'::text) $$,
  'the rejected adjustment did not add an entry to the credit ledger'
);
SELECT results_eq(
  $$ SELECT type FROM public.notifications
     WHERE user_id = '00000000-0000-4000-8000-0000000d0601' AND type = 'restore_recovery_blocked' $$,
  ARRAY['restore_recovery_blocked'], 'the admin receives the in-app recovery alert once'
);
SELECT is_empty(
  $$ SELECT id FROM public.notifications
     WHERE user_id = '00000000-0000-4000-8000-0000000d0602' AND type = 'restore_recovery_blocked' $$,
  'the client does not receive the admin recovery alert'
);

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



SET LOCAL ROLE service_role;
SET LOCAL request.jwt.claims = '{"role":"service_role"}';
SELECT throws_ok(
  $$ DO $fixture$ BEGIN
       PERFORM public.import_restore_recovery_manifest_for_server(
         '00000000-0000-4000-8000-0000000d0605', 1, 'future-coverage', 'fixture-authority',
         1, NULL, repeat('b', 64), now() + interval '1 second', now(), TRUE
       );
       RAISE EXCEPTION 'fixture_expected_coverage_rejection';
     END $fixture$ $$,
  '22023', 'invalid_restore_authority_manifest_coverage',
  'a manifest cannot attest coverage after it was generated'
);
SELECT throws_ok(
  $$ DO $fixture$ BEGIN
       PERFORM public.import_restore_recovery_manifest_for_server(
         '00000000-0000-4000-8000-0000000d0605', 1, 'short-coverage', 'fixture-authority',
         1, NULL, repeat('b', 64), now() - interval '1 second', now(), TRUE
       );
       RAISE EXCEPTION 'fixture_expected_coverage_rejection';
     END $fixture$ $$,
  '22023', 'invalid_restore_authority_manifest_coverage',
  'complete deletion coverage must reach the restored snapshot'
);
SELECT throws_ok(
  $$ DO $fixture$ BEGIN
       PERFORM public.import_restore_recovery_manifest_for_server(
         '00000000-0000-4000-8000-0000000d0605', 1, 'infinite-coverage', 'fixture-authority',
         1, NULL, repeat('b', 64), '-infinity', now(), FALSE
       );
       RAISE EXCEPTION 'fixture_expected_coverage_rejection';
     END $fixture$ $$,
  '22023', 'invalid_restore_authority_manifest_coverage',
  'coverage must be a finite timestamp even for partial evidence'
);
SELECT lives_ok(
  $$ SELECT public.import_restore_recovery_manifest_for_server(
       '00000000-0000-4000-8000-0000000d0605', 1, 'partial', 'fixture-authority',
       1, NULL, repeat('b', 64), now() - interval '1 second', now(), FALSE
     ) $$,
  'partial coverage may be recorded without claiming completeness'
);
SELECT throws_ok(
  $$ DO $fixture$ BEGIN
       PERFORM public.import_restore_recovery_manifest_for_server(
         '00000000-0000-4000-8000-0000000d0605', 1, 'regressing-coverage', 'fixture-authority',
         2, repeat('b', 64), repeat('c', 64), now() - interval '2 seconds', now(), FALSE
       );
       RAISE EXCEPTION 'fixture_expected_coverage_rejection';
     END $fixture$ $$,
  '22023', 'invalid_restore_authority_manifest_coverage',
  'a hash-linked successor cannot move the coverage watermark backwards'
);
SELECT lives_ok(
  $$ SELECT public.import_restore_recovery_manifest_for_server(
       '00000000-0000-4000-8000-0000000d0605', 1, 'complete', 'fixture-authority',
       2, repeat('b', 64), repeat('c', 64), now(), now(), TRUE
     ) $$,
  'complete evidence can reach exactly the snapshot and generation time'
);
SELECT lives_ok(
  $$ SELECT public.import_restore_recovery_manifest_for_server(
       '00000000-0000-4000-8000-0000000d0605', 1, 'equal-watermark', 'fixture-authority',
       3, repeat('c', 64), repeat('d', 64), now(), now(), TRUE
     ) $$,
  'a later manifest may preserve the previous coverage watermark'
);
RESET ROLE;

SELECT results_eq(
  $$ SELECT manifest_id FROM private.restore_recovery_authority_manifests
     WHERE event_id = '00000000-0000-4000-8000-0000000d0605' ORDER BY sequence $$,
  ARRAY['partial', 'complete', 'equal-watermark'],
  'only the valid hash-linked manifests were recorded'
);
SELECT results_eq(
  $$ SELECT access_state, recovery_deletion_replay_enabled FROM private.restore_recovery_control WHERE singleton $$,
  $$ VALUES ('blocked'::text, FALSE) $$,
  'recording evidence neither reopens business access nor enables replay'
);



SET LOCAL ROLE service_role;
SET LOCAL request.jwt.claims = '{"role":"service_role"}';
SELECT public.record_restore_reconciliation_for_server(
  '00000000-0000-4000-8000-0000000d0605', 1, 'equal-watermark', category,
  'matched', 0, 0, 0, repeat('e', 64)
) FROM unnest(ARRAY['credit_ledger', 'gift_purchases', 'credit_requests']) category;
SELECT * FROM public.finalize_restore_recovery_import_for_server(
  '00000000-0000-4000-8000-0000000d0605', 1
);
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-0000000d0601"}';
SELECT public.admin_verify_restore_personal_data(
  '00000000-0000-4000-8000-0000000d0605', 2, 'fixture review', repeat('f', 64), 'fixture review'
);
RESET ROLE;

SELECT results_eq(
  $$ SELECT status FROM private.restore_recovery_events
     WHERE id = '00000000-0000-4000-8000-0000000d0605' $$,
  ARRAY['ready_for_approval'], 'the finalized evidence can reach readiness before a successor arrives'
);

SET LOCAL ROLE service_role;
SET LOCAL request.jwt.claims = '{"role":"service_role"}';
SELECT lives_ok(
  $$ SELECT public.import_restore_recovery_manifest_for_server(
       '00000000-0000-4000-8000-0000000d0605', 3, 'new-partial', 'fixture-authority',
       4, repeat('d', 64), repeat('0', 64), now(), now(), FALSE
     ) $$,
  'later partial evidence may enter reconciliation'
);
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-0000000d0601"}';
SELECT throws_ok(
  $$ DO $fixture$ BEGIN
       PERFORM public.admin_approve_restore_recovery(
         '00000000-0000-4000-8000-0000000d0605', 3, 'fixture approval'
       );
       RAISE EXCEPTION 'fixture_expected_approval_rejection';
     END $fixture$ $$,
  'P0001', 'restore_recovery_requirements_incomplete',
  'approval cannot reuse verified evidence from before the partial successor'
);
RESET ROLE;

SELECT results_eq(
  $$ SELECT requirement_name || ':' || status FROM private.restore_recovery_requirements
     WHERE event_id = '00000000-0000-4000-8000-0000000d0605' ORDER BY requirement_name $$,
  ARRAY['deletion_replay:pending', 'external_lock:verified', 'ledger_reconciliation:pending', 'personal_data_review:pending'],
  'appending evidence invalidates old readiness but retains the verified lock'
);

SELECT * FROM finish();
ROLLBACK;
