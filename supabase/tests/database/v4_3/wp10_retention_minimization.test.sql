BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT no_plan();

-- Live DB contract test. Written Offline; execution requires the isolated DB gate.
SELECT has_table('private', 'deletion_retention_results', 'Retention outcomes are durable and record-scoped');
SELECT has_function(
  'public',
  'execute_account_retention_minimization_for_server',
  ARRAY['uuid', 'uuid'],
  'Retention minimization is a fenced server operation'
);
SELECT has_function(
  'public',
  'block_account_retention_minimization_for_server',
  ARRAY['uuid', 'uuid', 'jsonb'],
  'Incomplete retention work is persisted without completing its step'
);
SELECT is(
  (SELECT decision_status FROM private.deletion_retention_policy
   WHERE policy_version = 'p04-2026-11-11'
     AND subject_kind = 'account' AND record_type = 'financial_records'),
  'pending_legal',
  'Financial classification remains pending legal/accounting approval'
);
SELECT is(
  (SELECT blocks_step FROM private.deletion_retention_policy
   WHERE policy_version = 'p04-2026-11-11'
     AND subject_kind = 'account' AND record_type = 'financial_records'),
  NULL,
  'Financial classification no longer blocks unrelated approved minimization'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.execute_account_retention_minimization_for_server(uuid,uuid)',
    'EXECUTE'
  ),
  'Clients cannot execute retention minimization'
);

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000100101', 'authenticated', 'authenticated',
  'wp10-retention@example.invalid', 'x', clock_timestamp(), '{}', '{}',
  clock_timestamp(), clock_timestamp()
);

INSERT INTO public.account_deletion_requests (
  id, user_id, idempotency_key, status, requested_at, confirmed_at,
  cancellation_deadline, irreversible_started_at, content_deletion_due_at,
  retention_policy_version
) VALUES (
  '00000000-0000-4000-8000-000000100102',
  '00000000-0000-4000-8000-000000100101',
  '00000000-0000-4000-8000-000000100103',
  'processing', clock_timestamp() - interval '9 days',
  clock_timestamp() - interval '9 days', clock_timestamp() - interval '2 days',
  clock_timestamp() - interval '1 day', clock_timestamp() + interval '21 days',
  'p04-2026-11-11'
);

INSERT INTO private.account_deletion_steps (
  request_id, step_name, status, attempt_count, claimed_at,
  claim_token, lease_expires_at
) VALUES (
  '00000000-0000-4000-8000-000000100102', 'retention_minimization',
  'processing', 1, clock_timestamp(),
  '00000000-0000-4000-8000-000000100104', clock_timestamp() + interval '5 minutes'
);

INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
VALUES ('00000000-0000-4000-8000-000000100101', 77, 100, 23)
ON CONFLICT (user_id) DO UPDATE SET balance = 77, lifetime_earned = 100, lifetime_spent = 23;

INSERT INTO public.credit_transactions (
  id, user_id, amount, balance_after, type, reason, metadata
) VALUES (
  '00000000-0000-4000-8000-000000100105',
  '00000000-0000-4000-8000-000000100101', 10, 77, 'admin_adjustment',
  'name@example.invalid', '{"email":"name@example.invalid","business_ref":"keep"}'::JSONB
);

INSERT INTO public.reports (
  id, reporter_id, reason, details, status, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000100106',
  '00000000-0000-4000-8000-000000100101', 'open safety incident',
  'protected until closure', 'open', clock_timestamp(), clock_timestamp()
);

INSERT INTO public.audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata)
VALUES (
  '00000000-0000-4000-8000-000000100107',
  '00000000-0000-4000-8000-000000100101', 'account.test', 'profile',
  '00000000-0000-4000-8000-000000100101',
  '{"email":"name@example.invalid","business_ref":"keep"}'::JSONB
);

SELECT set_config('request.jwt.claim.role', 'service_role', true);

SAVEPOINT pending_retention_claim;
UPDATE public.system_settings SET value = 'true'::JSONB
WHERE key = 'account_deletion_irreversible_enabled';
UPDATE private.account_deletion_steps
SET status = 'pending', attempt_count = 0, claimed_at = NULL,
    claim_token = NULL, lease_expires_at = NULL, failure_code = NULL
WHERE request_id = '00000000-0000-4000-8000-000000100102'
  AND step_name = 'retention_minimization';
INSERT INTO private.account_deletion_steps (request_id, step_name, status)
VALUES ('00000000-0000-4000-8000-000000100102', 'storage', 'completed');

SELECT is(
  (SELECT step_name FROM public.claim_account_deletion_step_for_server(
    '00000000-0000-4000-8000-000000100102'
  )),
  'retention_minimization',
  'A pending retention step with NULL failure_code is claimable after Storage'
);
SELECT is(
  (SELECT attempt_count FROM private.account_deletion_steps
   WHERE request_id = '00000000-0000-4000-8000-000000100102'
     AND step_name = 'retention_minimization'),
  1,
  'Claim increments the retention attempt exactly once'
);
UPDATE private.account_deletion_steps
SET status = 'failed', failure_code = 'retention_conditions_pending',
    claim_token = NULL, lease_expires_at = NULL
WHERE request_id = '00000000-0000-4000-8000-000000100102'
  AND step_name = 'retention_minimization';
SELECT is(
  (SELECT count(*)::INTEGER FROM public.claim_account_deletion_step_for_server(
    '00000000-0000-4000-8000-000000100102'
  )),
  0,
  'Unresolved retention conditions still block another claim'
);
ROLLBACK TO SAVEPOINT pending_retention_claim;

SELECT lives_ok(
  $$SELECT public.execute_account_retention_minimization_for_server(
    '00000000-0000-4000-8000-000000100102',
    '00000000-0000-4000-8000-000000100104'
  )$$,
  'Approved categories are minimized without waiting for financial classification'
);

SELECT is((SELECT balance FROM public.credit_wallets
  WHERE user_id = '00000000-0000-4000-8000-000000100101'), 77, 'Wallet balance is preserved');
SELECT is((SELECT amount FROM public.credit_transactions
  WHERE id = '00000000-0000-4000-8000-000000100105'), 10, 'Ledger amount is preserved');
SELECT is((SELECT balance_after FROM public.credit_transactions
  WHERE id = '00000000-0000-4000-8000-000000100105'), 77, 'Ledger balance-after is preserved');
SELECT is((SELECT reason FROM public.credit_transactions
  WHERE id = '00000000-0000-4000-8000-000000100105'), '[minimized]', 'Unneeded ledger free text is minimized');
SELECT is((SELECT metadata ->> 'business_ref' FROM public.credit_transactions
  WHERE id = '00000000-0000-4000-8000-000000100105'), 'keep', 'Non-PII ledger metadata is preserved');
SELECT is((SELECT metadata ->> 'email' FROM public.credit_transactions
  WHERE id = '00000000-0000-4000-8000-000000100105'), NULL, 'Direct email metadata is removed');
SELECT is((SELECT outcome FROM private.deletion_retention_results
  WHERE request_id = '00000000-0000-4000-8000-000000100102'
    AND record_type = 'financial_records'), 'pending_legal', 'Financial rows remain explicitly protected');
SELECT is((SELECT outcome FROM private.deletion_retention_results
  WHERE request_id = '00000000-0000-4000-8000-000000100102'
    AND record_type = 'safety_reports'), 'pending_anchor', 'Open safety rows remain protected without a closure anchor');

SELECT lives_ok(
  $$SELECT public.block_account_retention_minimization_for_server(
    '00000000-0000-4000-8000-000000100102',
    '00000000-0000-4000-8000-000000100104',
    jsonb_build_object('completion_ready', false, 'operation', 'retention_minimization_evaluated')
  )$$,
  'Unresolved retention conditions persist evidence and block dependent steps'
);
SELECT is((SELECT status FROM private.account_deletion_steps
  WHERE request_id = '00000000-0000-4000-8000-000000100102'
    AND step_name = 'retention_minimization'), 'failed', 'Retention step is not marked completed');
SELECT is((SELECT failure_code FROM private.account_deletion_steps
  WHERE request_id = '00000000-0000-4000-8000-000000100102'
    AND step_name = 'retention_minimization'), 'retention_conditions_pending', 'Blocking reason is explicit');

UPDATE private.account_deletion_steps
SET status = 'processing', claim_token = '00000000-0000-4000-8000-000000100104',
    lease_expires_at = clock_timestamp() + interval '5 minutes'
WHERE request_id = '00000000-0000-4000-8000-000000100102'
  AND step_name = 'retention_minimization';

SELECT lives_ok(
  $$SELECT public.execute_account_retention_minimization_for_server(
    '00000000-0000-4000-8000-000000100102',
    '00000000-0000-4000-8000-000000100104'
  )$$,
  'Retry with the same live claim is idempotent'
);
SELECT is((SELECT balance FROM public.credit_wallets
  WHERE user_id = '00000000-0000-4000-8000-000000100101'), 77, 'Retry does not change the balance');

INSERT INTO private.deletion_holds (
  id, subject_kind, subject_id, record_type, reason, review_at
) VALUES (
  '00000000-0000-4000-8000-000000100108', 'account',
  '00000000-0000-4000-8000-000000100101', 'admin_audit',
  'active safety hold', clock_timestamp() + interval '30 days'
);
UPDATE public.audit_logs SET metadata = metadata || '{"email":"held@example.invalid"}'::JSONB
WHERE id = '00000000-0000-4000-8000-000000100107';

SELECT lives_ok(
  $$SELECT public.execute_account_retention_minimization_for_server(
    '00000000-0000-4000-8000-000000100102',
    '00000000-0000-4000-8000-000000100104'
  )$$,
  'A targeted hold is recorded without blocking unrelated categories'
);
SELECT is((SELECT outcome FROM private.deletion_retention_results
  WHERE request_id = '00000000-0000-4000-8000-000000100102'
    AND record_type = 'admin_audit'), 'held', 'Held category is explicitly marked');
SELECT is((SELECT metadata ->> 'email' FROM public.audit_logs
  WHERE id = '00000000-0000-4000-8000-000000100107'), 'held@example.invalid', 'Hold prevents minimization of the protected row');

SELECT throws_ok(
  $$SELECT public.execute_account_retention_minimization_for_server(
    '00000000-0000-4000-8000-000000100102',
    '00000000-0000-4000-8000-000000100109'
  )$$,
  'P0001', 'deletion_step_claim_stale',
  'A stale worker cannot execute retention work'
);

SELECT * FROM finish();
ROLLBACK;
