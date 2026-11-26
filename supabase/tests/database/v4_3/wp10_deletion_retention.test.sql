BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT no_plan();

SELECT has_table('private', 'deletion_retention_policy', 'P04 retention rules are versioned');
SELECT has_table('private', 'deletion_holds', 'Targeted legal and safety holds are durable');
SELECT has_table('private', 'deletion_completion_ledger', 'Restore replay has a minimal protected ledger');
SELECT has_table('private', 'account_deletion_cancellation_verifications', 'Cancellation consumes a separate one-time identity proof');
SELECT has_table('private', 'deletion_storage_objects', 'Deletion Storage work uses an exact owned-object manifest');
SELECT has_column('public', 'account_deletion_requests', 'confirmed_at', 'Confirmation has a server-owned anchor');
SELECT has_column('public', 'account_deletion_requests', 'cancellation_deadline', 'Account requests expose the seven-day boundary');
SELECT has_column('public', 'account_deletion_requests', 'content_deletion_due_at', 'Account content has a confirmation-anchored due date');
SELECT has_column('public', 'conversation_deletion_requests', 'access_blocked_at', 'Conversation access is blocked independently of physical deletion');
SELECT has_column('public', 'conversation_deletion_requests', 'deletion_due_at', 'Conversation content has a seven-day due date');
SELECT has_column('private', 'account_deletion_steps', 'claim_token', 'Account work is fenced');
SELECT has_column('private', 'account_deletion_steps', 'lease_expires_at', 'Account work has a bounded lease');

SELECT has_function('public', 'get_my_account_deletion_status', ARRAY[]::text[], 'Users can read authoritative workflow state');
SELECT has_function('public', 'verify_account_deletion_for_server', ARRAY['uuid', 'text', 'uuid'], 'Verification binds the proof to the authenticated account');
SELECT has_function('public', 'cancel_account_deletion_for_server', ARRAY['uuid', 'uuid', 'text'], 'Cancellation consumes a fresh identity proof');
SELECT has_function('public', 'authorize_early_account_deletion_for_server', ARRAY['uuid', 'text'], 'Early deletion requires a documented service boundary');
SELECT has_function('public', 'complete_account_deletion_step_for_server', ARRAY['uuid', 'text', 'uuid', 'jsonb'], 'Completion requires claim fencing and evidence');
SELECT has_function('public', 'complete_conversation_deletion_step_for_server', ARRAY['uuid', 'text', 'uuid', 'jsonb'], 'Conversation completion requires claim fencing and evidence');
SELECT has_function('public', 'execute_account_deletion_database_step_for_server', ARRAY['uuid', 'uuid'], 'Account database deletion is a fenced service operation');
SELECT has_function('public', 'execute_conversation_deletion_database_step_for_server', ARRAY['uuid', 'uuid'], 'Conversation database deletion is a fenced service operation');
SELECT has_function('public', 'list_deletion_storage_objects_for_server', ARRAY['text', 'uuid', 'uuid'], 'Storage deletion reads a fenced exact manifest');
SELECT has_function('public', 'record_deletion_completion_for_server', ARRAY['text', 'uuid', 'uuid'], 'Completion evidence is recorded through a fenced service operation');

SELECT is((SELECT value FROM public.system_settings WHERE key = 'deletion_policy_version'), '"p04-2026-11-11"'::jsonb, 'The approved P04 policy version is explicit');
SELECT is((SELECT value FROM public.system_settings WHERE key = 'account_deletion_irreversible_enabled'), 'false'::jsonb, 'Account deletion execution defaults off');
SELECT is((SELECT value FROM public.system_settings WHERE key = 'conversation_deletion_irreversible_enabled'), 'false'::jsonb, 'Conversation deletion execution defaults off');
SELECT is((SELECT value FROM public.system_settings WHERE key = 'deletion_scheduler_enabled'), 'false'::jsonb, 'The deletion scheduler defaults off');

SELECT is(
  (SELECT decision_status FROM private.deletion_retention_policy
   WHERE policy_version = 'p04-2026-11-11' AND subject_kind = 'account' AND record_type = 'financial_records'),
  'pending_legal',
  'Financial classification remains a localized legal/accounting gate'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM private.deletion_retention_policy
    WHERE policy_version = 'p04-2026-11-11' AND subject_kind = 'account'
      AND record_type = 'financial_records' AND decision_status = 'pending_legal'
      AND retention_interval IS NULL AND blocks_step IS NULL
  ),
  'Financial classification stays pending without vetoing minimization of unrelated categories'
);
SELECT is(
  (SELECT decision_status FROM private.deletion_retention_policy
   WHERE policy_version = 'p04-2026-11-11' AND subject_kind = 'account' AND record_type = 'backups'),
  'provider_unverified',
  'The 30-day backup target is not represented as verified provider behavior'
);

SELECT ok(
  to_regprocedure('public.cancel_account_deletion(uuid)') IS NULL,
  'The obsolete direct cancellation RPC is absent'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.cancel_account_deletion_for_server(uuid, uuid, text)', 'EXECUTE'),
  'Clients cannot bypass the fresh identity verification boundary'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.claim_account_deletion_step_for_server(uuid)', 'EXECUTE'),
  'Clients cannot claim destructive account work'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.claim_conversation_deletion_step_for_server(uuid)', 'EXECUTE'),
  'Clients cannot claim destructive conversation work'
);

-- Transaction-only fixtures. No deletion worker or irreversible step is invoked.
INSERT INTO auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
VALUES
  ('00000000-0000-4000-8000-000000100501', 'authenticated', 'authenticated',
    'wp10-write-admin@example.invalid', now(), '{}', '{}'),
  ('00000000-0000-4000-8000-000000100502', 'authenticated', 'authenticated',
    'wp10-write-client@example.invalid', now(), '{}', '{}');
INSERT INTO public.user_roles (user_id, role)
VALUES ('00000000-0000-4000-8000-000000100501', 'admin');
INSERT INTO public.characters (id, name, is_active, is_visible)
VALUES ('00000000-0000-4000-8000-000000100503', 'WP10 synthetic write character', true, true);
INSERT INTO public.conversations (id, client_id, character_id, status)
VALUES
  ('00000000-0000-4000-8000-000000100504', '00000000-0000-4000-8000-000000100502',
    '00000000-0000-4000-8000-000000100503', 'closed'),
  ('00000000-0000-4000-8000-000000100505', '00000000-0000-4000-8000-000000100502',
    '00000000-0000-4000-8000-000000100503', 'waiting');
INSERT INTO public.conversation_deletion_requests
  (conversation_id, requested_by, idempotency_key, reason, status, access_blocked_at)
VALUES ('00000000-0000-4000-8000-000000100505', '00000000-0000-4000-8000-000000100501',
  '00000000-0000-4000-8000-000000100506', 'WP10 synthetic gate fixture', 'access_blocked', now());
INSERT INTO public.credit_wallets (user_id, balance)
VALUES ('00000000-0000-4000-8000-000000100502', 20)
ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance;
UPDATE public.system_settings SET value = 'true'::jsonb WHERE key = 'credits_enabled';
UPDATE public.system_settings SET value = '10'::jsonb WHERE key = 'client_text_credit_price';

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000100501';
SELECT throws_ok(
  $$SELECT public.admin_set_conversation_status('00000000-0000-4000-8000-000000100505', 'open')$$,
  '42501', 'conversation_access_denied', 'A deletion block prevents ordinary reactivation');
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000100502';
SELECT throws_ok(
  $$SELECT public.send_client_message('00000000-0000-4000-8000-000000100505', 'Synthetic negative write')$$,
  '42501', 'conversation_access_denied', 'A deletion block denies the client text writer');
RESET ROLE;
SELECT is((SELECT status::text FROM public.conversations
  WHERE id = '00000000-0000-4000-8000-000000100505'), 'waiting',
  'A denied status change does not change the row');
SELECT is((SELECT count(*) FROM public.audit_logs WHERE action = 'conversation.status_changed'
  AND entity_id = '00000000-0000-4000-8000-000000100505'), 0::bigint,
  'A denied change does not create a success audit event');
SELECT is((SELECT count(*) FROM public.messages
  WHERE conversation_id = '00000000-0000-4000-8000-000000100505'), 0::bigint,
  'A denied text creates no message');
SELECT is((SELECT balance FROM public.credit_wallets
  WHERE user_id = '00000000-0000-4000-8000-000000100502'), 20, 'A denied text does not debit the wallet');
SELECT is((SELECT count(*) FROM public.credit_transactions WHERE type = 'message_spend'
  AND user_id = '00000000-0000-4000-8000-000000100502'), 0::bigint,
  'A denied text creates no ledger entry');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000100501';
SELECT lives_ok(
  $$SELECT public.admin_set_conversation_status('00000000-0000-4000-8000-000000100505', 'closed')$$,
  'The admin can still close a deletion-blocked conversation');
SELECT lives_ok(
  $$SELECT public.admin_set_conversation_status('00000000-0000-4000-8000-000000100504', 'waiting')$$,
  'The admin can reopen an unrelated row without a deletion block');
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000100502';
SELECT is((public.send_client_message('00000000-0000-4000-8000-000000100504', 'Synthetic positive write')
  ->> 'balance')::integer, 10, 'An ordinary text can still send and charge once');
RESET ROLE;
SELECT is((SELECT count(*) FROM public.credit_transactions WHERE type = 'message_spend'
  AND user_id = '00000000-0000-4000-8000-000000100502'), 1::bigint,
  'The ordinary text creates exactly one ledger entry');

SELECT * FROM finish();
ROLLBACK;
