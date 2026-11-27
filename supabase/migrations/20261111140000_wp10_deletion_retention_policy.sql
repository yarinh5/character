-- WP10 / P04: verified, cancellable and resumable deletion lifecycle.
-- This migration prepares the workflow only. Irreversible execution and scheduling stay disabled.

INSERT INTO public.system_settings (key, value)
VALUES
  ('deletion_policy_version', '"p04-2026-11-11"'::jsonb),
  ('account_deletion_irreversible_enabled', 'false'::jsonb),
  ('conversation_deletion_irreversible_enabled', 'false'::jsonb),
  ('deletion_scheduler_enabled', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.account_deletion_requests
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS access_blocked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_deadline TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS irreversible_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS content_deletion_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS active_system_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retention_policy_version TEXT,
  ADD COLUMN IF NOT EXISTS completion_evidence JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.account_deletion_requests
  DROP CONSTRAINT IF EXISTS account_deletion_requests_status_check;
ALTER TABLE public.account_deletion_requests
  ADD CONSTRAINT account_deletion_requests_status_check CHECK (status IN (
    'awaiting_verification', 'verified', 'cancellation_window', 'cancelled',
    'ready_for_deletion', 'blocked_retention', 'processing',
    'active_system_completed', 'completed', 'failed'
  ));

DROP INDEX IF EXISTS public.account_deletion_one_active_request_idx;
CREATE UNIQUE INDEX account_deletion_one_active_request_idx
  ON public.account_deletion_requests(user_id)
  WHERE status IN (
    'awaiting_verification', 'verified', 'cancellation_window', 'ready_for_deletion',
    'blocked_retention', 'processing', 'active_system_completed', 'failed'
  );

ALTER TABLE public.conversation_deletion_requests
  ADD COLUMN IF NOT EXISTS access_blocked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deletion_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS irreversible_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS active_system_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retention_policy_version TEXT,
  ADD COLUMN IF NOT EXISTS completion_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();

ALTER TABLE public.conversation_deletion_requests
  DROP CONSTRAINT IF EXISTS conversation_deletion_requests_status_check;
ALTER TABLE public.conversation_deletion_requests
  ADD CONSTRAINT conversation_deletion_requests_status_check CHECK (status IN (
    'access_blocked', 'blocked_retention', 'ready_for_deletion', 'processing',
    'active_system_completed', 'completed', 'failed', 'cancelled'
  ));

ALTER TABLE private.account_deletion_steps
  DROP CONSTRAINT IF EXISTS account_deletion_steps_step_name_check;
UPDATE private.account_deletion_steps SET step_name = 'database_content' WHERE step_name = 'database';
UPDATE private.account_deletion_steps SET step_name = 'auth_delete' WHERE step_name = 'auth';
ALTER TABLE private.account_deletion_steps
  ADD CONSTRAINT account_deletion_steps_step_name_check CHECK (step_name IN (
    'session_revocation', 'database_content', 'storage', 'retention_minimization',
    'auth_delete', 'finalize'
  ));
ALTER TABLE private.account_deletion_steps
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE private.conversation_deletion_steps
  DROP CONSTRAINT IF EXISTS conversation_deletion_steps_step_name_check;
ALTER TABLE private.conversation_deletion_steps
  ADD CONSTRAINT conversation_deletion_steps_step_name_check CHECK (step_name IN (
    'database_content', 'storage', 'finalize'
  ));
ALTER TABLE private.conversation_deletion_steps
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE private.deletion_retention_policy (
  policy_version TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('account', 'conversation')),
  record_type TEXT NOT NULL,
  anchor_kind TEXT NOT NULL,
  retention_interval INTERVAL,
  decision_status TEXT NOT NULL CHECK (decision_status IN ('approved', 'pending_legal', 'provider_unverified')),
  blocks_step TEXT,
  notes TEXT NOT NULL,
  PRIMARY KEY (policy_version, subject_kind, record_type)
);

INSERT INTO private.deletion_retention_policy (
  policy_version, subject_kind, record_type, anchor_kind, retention_interval,
  decision_status, blocks_step, notes
)
VALUES
  ('p04-2026-11-11', 'account', 'personal_content', 'confirmed_at', interval '30 days', 'approved', NULL,
    'Messages, notes, profile data and personal media are due within 30 days of confirmation.'),
  ('p04-2026-11-11', 'account', 'internal_credits_points', 'active_system_completed_at', interval '24 months', 'approved', NULL,
    'Retain only when required; minimize direct identifiers and preserve ledger correctness.'),
  ('p04-2026-11-11', 'account', 'financial_records', 'classified_transaction_anchor', NULL, 'pending_legal', 'retention_minimization',
    'Accounting/legal classification and anchor remain subject to approval.'),
  ('p04-2026-11-11', 'account', 'safety_reports', 'incident_closed_at', interval '24 months', 'approved', NULL,
    'Targeted safety retention only.'),
  ('p04-2026-11-11', 'account', 'blocks', 'block_ended_or_account_deleted_at', interval '12 months', 'approved', NULL,
    'Retain while active and up to 12 months after removal or account deletion.'),
  ('p04-2026-11-11', 'account', 'admin_audit', 'action_at', interval '24 months', 'approved', NULL,
    'Transaction-linked audit follows the separately classified transaction.'),
  ('p04-2026-11-11', 'account', 'backups', 'active_system_completed_at', interval '30 days', 'provider_unverified', NULL,
    'Proposed target only; active-system completion is reported separately.'),
  ('p04-2026-11-11', 'conversation', 'personal_content', 'requested_at', interval '7 days', 'approved', NULL,
    'Conversation text, personal attachments and previews are due within seven days.'),
  ('p04-2026-11-11', 'conversation', 'business_records', 'record_specific_anchor', NULL, 'pending_legal', 'finalize',
    'Preserve required transaction records without unnecessary personal content.')
ON CONFLICT (policy_version, subject_kind, record_type) DO NOTHING;

CREATE TABLE private.deletion_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('account', 'conversation')),
  subject_id UUID NOT NULL,
  record_type TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  review_at TIMESTAMPTZ NOT NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  released_at TIMESTAMPTZ,
  released_by UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  CHECK (released_at IS NULL OR released_at >= created_at)
);
CREATE INDEX deletion_holds_active_subject_idx
  ON private.deletion_holds(subject_kind, subject_id)
  WHERE released_at IS NULL;

CREATE TABLE private.deletion_completion_ledger (
  request_kind TEXT NOT NULL CHECK (request_kind IN ('account', 'conversation')),
  request_id UUID NOT NULL,
  policy_version TEXT NOT NULL,
  active_system_completed_at TIMESTAMPTZ NOT NULL,
  evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  backup_expiry_verified_at TIMESTAMPTZ,
  PRIMARY KEY (request_kind, request_id)
);

CREATE TABLE private.account_deletion_cancellation_verifications (
  request_id UUID PRIMARY KEY REFERENCES public.account_deletion_requests(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE private.deletion_storage_objects (
  request_kind TEXT NOT NULL CHECK (request_kind IN ('account', 'conversation')),
  request_id UUID NOT NULL,
  bucket_id TEXT NOT NULL CHECK (bucket_id IN ('client-media', 'user-avatars')),
  object_path TEXT NOT NULL CHECK (
    object_path <> '' AND object_path !~ '(^|/)(\.|\.\.)(/|$)' AND object_path !~ '[\\]'
  ),
  ownership_source TEXT NOT NULL CHECK (ownership_source IN ('client_media_upload', 'storage_owner')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'deleted')),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (request_kind, request_id, bucket_id, object_path)
);

REVOKE ALL ON TABLE private.deletion_retention_policy, private.deletion_holds,
  private.deletion_completion_ledger, private.account_deletion_cancellation_verifications,
  private.deletion_storage_objects FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.account_deletion_blocks_business_activity(_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.account_deletion_requests request
    WHERE request.user_id = _user_id
      AND request.confirmed_at IS NOT NULL
      AND request.status NOT IN ('cancelled', 'completed')
  );
$$;
REVOKE ALL ON FUNCTION private.account_deletion_blocks_business_activity(UUID)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.ensure_active_client(_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF private.account_deletion_blocks_business_activity(_user_id) OR NOT EXISTS (
    SELECT 1
    FROM public.user_roles role
    JOIN public.profiles profile ON profile.user_id = role.user_id
    WHERE role.user_id = _user_id
      AND role.role = 'client'::public.app_role
      AND COALESCE(profile.status, 'active') = 'active'
      AND profile.deleted_at IS NULL
      AND profile.pii_archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'client_account_inactive';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION private.ensure_active_client(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.ensure_active_client(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.request_account_deletion(_idempotency_key UUID)
RETURNS TABLE (id UUID, status TEXT, requested_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user UUID := auth.uid();
  _request public.account_deletion_requests%ROWTYPE;
BEGIN
  IF _user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF _idempotency_key IS NULL THEN RAISE EXCEPTION 'idempotency_key_required'; END IF;

  SELECT * INTO _request FROM public.account_deletion_requests request
  WHERE request.user_id = _user
    AND request.status NOT IN ('cancelled', 'completed')
  ORDER BY request.requested_at DESC LIMIT 1 FOR UPDATE;

  IF _request.id IS NULL THEN
    INSERT INTO public.account_deletion_requests (user_id, idempotency_key)
    VALUES (_user, _idempotency_key)
    ON CONFLICT (user_id, idempotency_key) DO NOTHING
    RETURNING * INTO _request;
  END IF;
  IF _request.id IS NULL THEN
    SELECT * INTO _request FROM public.account_deletion_requests request
    WHERE request.user_id = _user AND request.idempotency_key = _idempotency_key;
  END IF;
  id := _request.id; status := _request.status; requested_at := _request.requested_at;
  RETURN NEXT;
END;
$$;

DROP FUNCTION IF EXISTS public.verify_account_deletion_for_server(UUID, TEXT);
CREATE FUNCTION public.verify_account_deletion_for_server(
  _request_id UUID,
  _token_hash TEXT,
  _verified_user_id UUID
)
RETURNS TABLE (id UUID, status TEXT, verified_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _verification private.account_deletion_verifications%ROWTYPE;
  _request public.account_deletion_requests%ROWTYPE;
  _now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  SELECT * INTO _verification FROM private.account_deletion_verifications verification
  WHERE verification.request_id = _request_id FOR UPDATE;
  IF NOT FOUND OR _verification.consumed_at IS NOT NULL
    OR _verification.expires_at <= _now
    OR _verification.token_hash IS DISTINCT FROM _token_hash THEN
    RAISE EXCEPTION 'deletion_verification_invalid_or_expired';
  END IF;
  SELECT * INTO _request FROM public.account_deletion_requests request
  WHERE request.id = _request_id FOR UPDATE;
  IF NOT FOUND OR _request.status <> 'awaiting_verification'
    OR _request.user_id IS DISTINCT FROM _verified_user_id THEN
    RAISE EXCEPTION 'deletion_request_not_verifiable';
  END IF;
  PERFORM 1 FROM auth.users auth_user
  WHERE auth_user.id = _request.user_id
    AND auth_user.email IS NOT NULL
    AND auth_user.email_confirmed_at IS NOT NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'verified_email_required'; END IF;

  UPDATE private.account_deletion_verifications SET consumed_at = _now
  WHERE request_id = _request_id;
  UPDATE public.account_deletion_requests request
  SET status = 'cancellation_window',
      verified_at = COALESCE(request.verified_at, _now),
      confirmed_at = COALESCE(request.confirmed_at, _now),
      access_blocked_at = COALESCE(request.access_blocked_at, _now),
      cancellation_deadline = COALESCE(request.cancellation_deadline, _now + interval '7 days'),
      content_deletion_due_at = COALESCE(request.content_deletion_due_at, _now + interval '30 days'),
      retention_policy_version = COALESCE(request.retention_policy_version, 'p04-2026-11-11'),
      updated_at = _now
  WHERE request.id = _request_id
  RETURNING request.id, request.status, request.verified_at INTO id, status, verified_at;

  UPDATE public.profiles profile
  SET status = 'deletion_requested', updated_at = _now
  WHERE profile.user_id = _request.user_id AND COALESCE(profile.status, 'active') = 'active';

  INSERT INTO private.account_deletion_steps (request_id, step_name, status)
  VALUES
    (_request_id, 'session_revocation', 'pending'),
    (_request_id, 'database_content', 'pending'),
    (_request_id, 'storage', 'pending'),
    (_request_id, 'retention_minimization', 'pending'),
    (_request_id, 'auth_delete', 'pending'),
    (_request_id, 'finalize', 'pending')
  ON CONFLICT (request_id, step_name) DO NOTHING;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_account_deletion_status()
RETURNS TABLE (
  id UUID, status TEXT, requested_at TIMESTAMPTZ, confirmed_at TIMESTAMPTZ,
  cancellation_deadline TIMESTAMPTZ, content_deletion_due_at TIMESTAMPTZ,
  active_system_completed_at TIMESTAMPTZ, failure_code TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT request.id, request.status, request.requested_at, request.confirmed_at,
    request.cancellation_deadline, request.content_deletion_due_at,
    request.active_system_completed_at, request.failure_code
  FROM public.account_deletion_requests request
  WHERE request.user_id = auth.uid()
  ORDER BY request.requested_at DESC LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.prepare_account_deletion_cancellation_for_server(
  _request_id UUID,
  _user_id UUID,
  _token_hash TEXT,
  _expires_at TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF _token_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_token_hash'; END IF;
  IF _expires_at <= clock_timestamp() OR _expires_at > clock_timestamp() + interval '30 minutes' THEN
    RAISE EXCEPTION 'invalid_verification_expiry';
  END IF;
  PERFORM 1 FROM public.account_deletion_requests request
  WHERE request.id = _request_id AND request.user_id = _user_id
    AND request.status = 'cancellation_window'
    AND request.cancellation_deadline > clock_timestamp()
    AND request.irreversible_started_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'deletion_request_not_cancellable'; END IF;
  INSERT INTO private.account_deletion_cancellation_verifications (
    request_id, user_id, token_hash, expires_at
  ) VALUES (_request_id, _user_id, _token_hash, _expires_at)
  ON CONFLICT (request_id) DO UPDATE
  SET user_id = EXCLUDED.user_id, token_hash = EXCLUDED.token_hash,
      expires_at = EXCLUDED.expires_at, consumed_at = NULL,
      created_at = clock_timestamp();
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_account_deletion_for_server(
  _request_id UUID,
  _verified_user_id UUID,
  _token_hash TEXT
)
RETURNS TABLE (id UUID, status TEXT, cancelled_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _request public.account_deletion_requests%ROWTYPE;
  _verification private.account_deletion_cancellation_verifications%ROWTYPE;
  _now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  SELECT * INTO _verification
  FROM private.account_deletion_cancellation_verifications verification
  WHERE verification.request_id = _request_id FOR UPDATE;
  IF NOT FOUND OR _verification.user_id IS DISTINCT FROM _verified_user_id
    OR _verification.token_hash IS DISTINCT FROM _token_hash
    OR _verification.consumed_at IS NOT NULL OR _verification.expires_at <= _now THEN
    RAISE EXCEPTION 'fresh_identity_verification_required';
  END IF;
  SELECT * INTO _request FROM public.account_deletion_requests request
  WHERE request.id = _request_id AND request.user_id = _verified_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'deletion_request_not_found'; END IF;
  IF _request.status <> 'cancellation_window'
    OR _request.cancellation_deadline <= _now
    OR _request.irreversible_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'deletion_cancellation_window_closed';
  END IF;

  UPDATE private.account_deletion_cancellation_verifications
  SET consumed_at = _now WHERE request_id = _request_id;
  UPDATE public.account_deletion_requests request
  SET status = 'cancelled', cancelled_at = _now, updated_at = _now
  WHERE request.id = _request_id
  RETURNING request.id, request.status, request.cancelled_at INTO id, status, cancelled_at;
  UPDATE public.profiles SET status = 'active', updated_at = _now
  WHERE user_id = _verified_user_id AND status = 'deletion_requested';
  UPDATE private.account_deletion_steps SET status = 'failed', failure_code = 'request_cancelled',
    claim_token = NULL, lease_expires_at = NULL, updated_at = _now
  WHERE request_id = _request_id AND status <> 'completed';
  INSERT INTO public.audit_logs(actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_verified_user_id, 'account_deletion_cancelled', 'account_deletion_request', _request_id,
    jsonb_build_object('requires_new_login', true, 'identity_verification', 'supabase_auth_email'));
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.authorize_early_account_deletion_for_server(
  _request_id UUID,
  _reason TEXT
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF char_length(btrim(COALESCE(_reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'documented_legal_reason_required';
  END IF;
  UPDATE public.account_deletion_requests request
  SET cancellation_deadline = LEAST(request.cancellation_deadline, clock_timestamp()),
      completion_evidence = request.completion_evidence || jsonb_build_object(
        'early_deletion_authorized', true, 'early_deletion_reason', btrim(_reason)
      ), updated_at = clock_timestamp()
  WHERE request.id = _request_id AND request.status = 'cancellation_window';
  IF NOT FOUND THEN RAISE EXCEPTION 'deletion_request_not_eligible'; END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.claim_account_deletion_step_for_server(UUID);
CREATE FUNCTION public.claim_account_deletion_step_for_server(_request_id UUID)
RETURNS TABLE (
  request_id UUID, step_name TEXT, attempt_count INTEGER,
  claim_token UUID, lease_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _request public.account_deletion_requests%ROWTYPE;
  _irreversible_enabled BOOLEAN := private.setting_bool('account_deletion_irreversible_enabled', FALSE);
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  SELECT * INTO _request FROM public.account_deletion_requests request
  WHERE request.id = _request_id FOR UPDATE;
  IF NOT FOUND OR _request.status IN ('cancelled', 'completed', 'active_system_completed') THEN RETURN; END IF;

  IF _request.status = 'cancellation_window' AND clock_timestamp() >= _request.cancellation_deadline THEN
    IF NOT _irreversible_enabled THEN
      UPDATE public.account_deletion_requests SET status = 'blocked_retention', updated_at = clock_timestamp()
      WHERE id = _request_id;
    ELSE
      UPDATE public.account_deletion_requests
      SET status = 'ready_for_deletion', irreversible_started_at = COALESCE(irreversible_started_at, clock_timestamp()),
        updated_at = clock_timestamp()
      WHERE id = _request_id AND irreversible_started_at IS NULL;
    END IF;
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT step.request_id, step.step_name
    FROM private.account_deletion_steps step
    JOIN public.account_deletion_requests request ON request.id = step.request_id
    WHERE step.request_id = _request_id
      AND step.attempt_count < 5
      AND (step.status IN ('pending', 'failed')
        OR (step.status = 'processing' AND step.lease_expires_at <= clock_timestamp()))
      AND (
        step.step_name = 'session_revocation'
        OR (
          _irreversible_enabled
          AND request.irreversible_started_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM private.deletion_holds hold
            WHERE hold.subject_kind = 'account' AND hold.subject_id = request.user_id
              AND hold.released_at IS NULL
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM private.deletion_retention_policy policy
        WHERE policy.policy_version = request.retention_policy_version
          AND policy.subject_kind = 'account'
          AND policy.blocks_step = step.step_name
          AND policy.decision_status <> 'approved'
      )
      AND NOT EXISTS (
        SELECT 1 FROM private.account_deletion_steps predecessor
        WHERE predecessor.request_id = step.request_id
          AND CASE step.step_name
            WHEN 'database_content' THEN predecessor.step_name = 'session_revocation'
            WHEN 'storage' THEN predecessor.step_name = 'database_content'
            WHEN 'retention_minimization' THEN predecessor.step_name = 'storage'
            WHEN 'auth_delete' THEN predecessor.step_name = 'retention_minimization'
            WHEN 'finalize' THEN predecessor.step_name IN (
              'session_revocation', 'database_content', 'storage', 'retention_minimization', 'auth_delete'
            )
            ELSE FALSE
          END AND predecessor.status <> 'completed'
      )
    ORDER BY CASE step.step_name
      WHEN 'session_revocation' THEN 1 WHEN 'database_content' THEN 2 WHEN 'storage' THEN 3
      WHEN 'retention_minimization' THEN 4 WHEN 'auth_delete' THEN 5 ELSE 6 END
    LIMIT 1 FOR UPDATE OF step SKIP LOCKED
  )
  UPDATE private.account_deletion_steps step
  SET status = 'processing', attempt_count = step.attempt_count + 1,
    claimed_at = clock_timestamp(), claim_token = gen_random_uuid(),
    lease_expires_at = clock_timestamp() + interval '5 minutes', failure_code = NULL,
    updated_at = clock_timestamp()
  FROM candidate
  WHERE step.request_id = candidate.request_id AND step.step_name = candidate.step_name
  RETURNING step.request_id, step.step_name, step.attempt_count, step.claim_token, step.lease_expires_at;
END;
$$;

DROP FUNCTION IF EXISTS public.complete_account_deletion_step_for_server(UUID, TEXT);
CREATE FUNCTION public.complete_account_deletion_step_for_server(
  _request_id UUID, _step_name TEXT, _claim_token UUID, _evidence JSONB
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _remaining INTEGER; _status TEXT;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF _evidence IS NULL OR _evidence = '{}'::jsonb THEN RAISE EXCEPTION 'deletion_evidence_required'; END IF;
  UPDATE private.account_deletion_steps step
  SET status = 'completed', completed_at = clock_timestamp(), evidence = _evidence,
    claim_token = NULL, lease_expires_at = NULL, failure_code = NULL, updated_at = clock_timestamp()
  WHERE step.request_id = _request_id AND step.step_name = _step_name
    AND step.status = 'processing' AND step.claim_token = _claim_token
    AND step.lease_expires_at > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'deletion_step_claim_stale'; END IF;
  SELECT count(*) INTO _remaining FROM private.account_deletion_steps
  WHERE request_id = _request_id AND status <> 'completed';
  UPDATE public.account_deletion_requests request
  SET status = CASE WHEN _remaining = 0 THEN 'active_system_completed' ELSE 'processing' END,
    active_system_completed_at = CASE WHEN _remaining = 0 THEN clock_timestamp() ELSE active_system_completed_at END,
    completed_at = CASE WHEN _remaining = 0 THEN clock_timestamp() ELSE completed_at END,
    updated_at = clock_timestamp(), failure_code = NULL
  WHERE request.id = _request_id RETURNING request.status INTO _status;
  RETURN _status;
END;
$$;

DROP FUNCTION IF EXISTS public.fail_account_deletion_step_for_server(UUID, TEXT, TEXT);
CREATE FUNCTION public.fail_account_deletion_step_for_server(
  _request_id UUID, _step_name TEXT, _claim_token UUID, _failure_code TEXT
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF char_length(COALESCE(_failure_code, '')) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'invalid_failure_code'; END IF;
  UPDATE private.account_deletion_steps step
  SET status = 'failed', failure_code = _failure_code, claim_token = NULL,
    lease_expires_at = NULL, updated_at = clock_timestamp()
  WHERE step.request_id = _request_id AND step.step_name = _step_name
    AND step.status = 'processing' AND step.claim_token = _claim_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'deletion_step_claim_stale'; END IF;
  UPDATE public.account_deletion_requests SET status = 'failed', failure_code = _failure_code,
    updated_at = clock_timestamp() WHERE id = _request_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.request_conversation_deletion(
  _conversation_id UUID, _reason TEXT, _idempotency_key UUID, _confirmed BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (id UUID, status TEXT, requested_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _actor UUID := auth.uid(); _request public.conversation_deletion_requests%ROWTYPE; _now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF _actor IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'admin_only' USING ERRCODE = '42501'; END IF;
  IF _confirmed IS NOT TRUE THEN RAISE EXCEPTION 'explicit_confirmation_required'; END IF;
  IF _conversation_id IS NULL OR _idempotency_key IS NULL THEN RAISE EXCEPTION 'invalid_deletion_request'; END IF;
  IF char_length(btrim(COALESCE(_reason, ''))) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'deletion_reason_required'; END IF;
  PERFORM 1 FROM public.conversations WHERE conversations.id = _conversation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_not_found'; END IF;
  INSERT INTO public.conversation_deletion_requests (
    conversation_id, requested_by, idempotency_key, reason, status,
    access_blocked_at, deletion_due_at, retention_policy_version, updated_at
  ) VALUES (
    _conversation_id, _actor, _idempotency_key, btrim(_reason), 'access_blocked',
    _now, _now + interval '7 days', 'p04-2026-11-11', _now
  ) ON CONFLICT (requested_by, idempotency_key) DO NOTHING RETURNING * INTO _request;
  IF _request.id IS NULL THEN
    SELECT * INTO _request FROM public.conversation_deletion_requests request
    WHERE request.requested_by = _actor AND request.idempotency_key = _idempotency_key;
    IF _request.conversation_id IS DISTINCT FROM _conversation_id OR _request.reason IS DISTINCT FROM btrim(_reason) THEN
      RAISE EXCEPTION 'idempotency_key_reused';
    END IF;
  ELSE
    INSERT INTO private.conversation_deletion_steps(request_id, step_name, status)
    VALUES (_request.id, 'database_content', 'pending'), (_request.id, 'storage', 'pending'),
      (_request.id, 'finalize', 'pending');
    UPDATE public.conversations SET status = 'closed'::public.conversation_status,
      assigned_operator_id = NULL, updated_at = _now WHERE conversations.id = _conversation_id;
    UPDATE public.conversation_handling_cycles SET ended_at = _now, end_reason = 'closed'
    WHERE conversation_id = _conversation_id AND ended_at IS NULL;
    UPDATE public.conversation_work_items SET status = 'closed', responsible_operator_id = NULL,
      assigned_at = NULL, updated_at = _now WHERE conversation_id = _conversation_id
      AND status IN ('new', 'assigned', 'in_progress');
    INSERT INTO public.audit_logs(actor_user_id, action, entity_type, entity_id, metadata)
    VALUES (_actor, 'conversation_deletion_requested', 'conversation', _conversation_id,
      jsonb_build_object('request_id', _request.id, 'reason', btrim(_reason), 'access_blocked_at', _now));
  END IF;
  id := _request.id; status := _request.status; requested_at := _request.requested_at; RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION private.conversation_deletion_blocks_access(_conversation_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversation_deletion_requests request
    WHERE request.conversation_id = _conversation_id
      AND request.status NOT IN ('cancelled')
  );
$$;
REVOKE ALL ON FUNCTION private.conversation_deletion_blocks_access(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.conversation_deletion_blocks_access(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.is_conversation_client(_conversation_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
  SELECT NOT private.conversation_deletion_blocks_access(_conversation_id) AND EXISTS (
    SELECT 1 FROM public.conversations WHERE id = _conversation_id AND client_id = auth.uid()
  );
$$;
CREATE OR REPLACE FUNCTION public.is_conversation_operator(_conversation_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
  SELECT NOT private.conversation_deletion_blocks_access(_conversation_id) AND EXISTS (
    SELECT 1 FROM public.conversations conversation
    JOIN public.character_operator_assignments assignment ON assignment.character_id = conversation.character_id
    JOIN public.operators operator ON operator.id = assignment.operator_id
    WHERE conversation.id = _conversation_id AND operator.user_id = auth.uid() AND operator.is_active
  );
$$;

DROP POLICY IF EXISTS "Admins view all conversations" ON public.conversations;
DROP POLICY IF EXISTS "Clients view own conversations" ON public.conversations;
CREATE POLICY "Clients view own undeleted conversations" ON public.conversations FOR SELECT
  USING (auth.uid() = client_id AND NOT private.conversation_deletion_blocks_access(id));
CREATE POLICY "Admins view undeleted conversations" ON public.conversations FOR SELECT
  USING (public.is_admin() AND NOT private.conversation_deletion_blocks_access(id));
DROP POLICY IF EXISTS "Admins view all messages" ON public.messages;
CREATE POLICY "Admins view undeleted conversation messages" ON public.messages FOR SELECT
  USING (public.is_admin() AND NOT private.conversation_deletion_blocks_access(conversation_id));
DROP POLICY IF EXISTS "Admins view all message attachments" ON public.message_attachments;
CREATE POLICY "Admins view undeleted message attachments" ON public.message_attachments FOR SELECT TO authenticated
  USING (public.is_admin() AND EXISTS (
    SELECT 1 FROM public.messages message WHERE message.id = message_id
      AND NOT private.conversation_deletion_blocks_access(message.conversation_id)
  ));
DROP POLICY IF EXISTS "Clients view own Gift attachment purchases" ON public.gift_attachment_purchases;
CREATE POLICY "Clients view own undeleted Gift attachment purchases"
  ON public.gift_attachment_purchases FOR SELECT TO authenticated
  USING (
    auth.uid() = client_id
    AND NOT private.conversation_deletion_blocks_access(conversation_id)
    AND (
      gift_message_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.messages message
        WHERE message.id = gift_message_id
          AND message.conversation_id = gift_attachment_purchases.conversation_id
          AND NOT private.conversation_deletion_blocks_access(message.conversation_id)
      )
    )
  );
DROP POLICY IF EXISTS "Admins view Gift attachment purchases" ON public.gift_attachment_purchases;
CREATE POLICY "Admins view undeleted Gift attachment purchases"
  ON public.gift_attachment_purchases FOR SELECT TO authenticated
  USING (
    public.is_admin()
    AND NOT private.conversation_deletion_blocks_access(conversation_id)
    AND (
      gift_message_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.messages message
        WHERE message.id = gift_message_id
          AND message.conversation_id = gift_attachment_purchases.conversation_id
          AND NOT private.conversation_deletion_blocks_access(message.conversation_id)
      )
    )
  );
DROP POLICY IF EXISTS "Admins view all notes" ON public.internal_notes;
CREATE POLICY "Admins view undeleted conversation notes" ON public.internal_notes FOR SELECT
  USING (public.is_admin() AND NOT private.conversation_deletion_blocks_access(conversation_id));
DROP POLICY IF EXISTS "Admins view customer info" ON public.customer_info_entries;
CREATE POLICY "Admins view undeleted customer info" ON public.customer_info_entries FOR SELECT
  USING (public.is_admin() AND NOT private.conversation_deletion_blocks_access(conversation_id));
DROP POLICY IF EXISTS "Authorized users can read message stickers" ON public.message_stickers;
CREATE POLICY "Authorized users read undeleted message stickers"
  ON public.message_stickers FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.messages message
      JOIN public.conversations conversation ON conversation.id = message.conversation_id
      WHERE message.id = message_stickers.message_id
        AND NOT private.conversation_deletion_blocks_access(conversation.id)
        AND (
          conversation.client_id = auth.uid()
          OR public.is_admin()
          OR public.is_conversation_operator(conversation.id)
        )
    )
  );

DROP FUNCTION IF EXISTS public.claim_conversation_deletion_step_for_server(UUID);
CREATE FUNCTION public.claim_conversation_deletion_step_for_server(_request_id UUID)
RETURNS TABLE (
  request_id UUID, step_name TEXT, attempt_count INTEGER,
  claim_token UUID, lease_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _enabled BOOLEAN := private.setting_bool('conversation_deletion_irreversible_enabled', FALSE);
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF NOT _enabled THEN
    UPDATE public.conversation_deletion_requests SET status = 'blocked_retention', updated_at = clock_timestamp()
    WHERE id = _request_id AND status IN ('access_blocked', 'ready_for_deletion', 'failed');
    RETURN;
  END IF;
  UPDATE public.conversation_deletion_requests
  SET status = 'ready_for_deletion', irreversible_started_at = COALESCE(irreversible_started_at, clock_timestamp()),
    updated_at = clock_timestamp()
  WHERE id = _request_id AND status IN ('access_blocked', 'blocked_retention', 'failed')
    AND NOT EXISTS (
      SELECT 1 FROM private.deletion_holds hold WHERE hold.subject_kind = 'conversation'
        AND hold.subject_id = conversation_deletion_requests.conversation_id AND hold.released_at IS NULL
    );
  RETURN QUERY
  WITH candidate AS (
    SELECT step.request_id, step.step_name
    FROM private.conversation_deletion_steps step
    JOIN public.conversation_deletion_requests request ON request.id = step.request_id
    WHERE step.request_id = _request_id AND request.irreversible_started_at IS NOT NULL
      AND step.attempt_count < 5
      AND (step.status IN ('pending', 'failed')
        OR (step.status = 'processing' AND step.lease_expires_at <= clock_timestamp()))
      AND NOT EXISTS (
        SELECT 1 FROM private.deletion_retention_policy policy
        WHERE policy.policy_version = request.retention_policy_version
          AND policy.subject_kind = 'conversation' AND policy.blocks_step = step.step_name
          AND policy.decision_status <> 'approved'
      )
      AND NOT EXISTS (
        SELECT 1 FROM private.conversation_deletion_steps predecessor
        WHERE predecessor.request_id = step.request_id
          AND CASE step.step_name WHEN 'storage' THEN predecessor.step_name = 'database_content'
            WHEN 'finalize' THEN predecessor.step_name IN ('database_content', 'storage') ELSE FALSE END
          AND predecessor.status <> 'completed'
      )
    ORDER BY CASE step.step_name WHEN 'database_content' THEN 1 WHEN 'storage' THEN 2 ELSE 3 END
    LIMIT 1 FOR UPDATE OF step SKIP LOCKED
  )
  UPDATE private.conversation_deletion_steps step
  SET status = 'processing', attempt_count = step.attempt_count + 1,
    claimed_at = clock_timestamp(), claim_token = gen_random_uuid(),
    lease_expires_at = clock_timestamp() + interval '5 minutes', failure_code = NULL,
    updated_at = clock_timestamp()
  FROM candidate
  WHERE step.request_id = candidate.request_id AND step.step_name = candidate.step_name
  RETURNING step.request_id, step.step_name, step.attempt_count, step.claim_token, step.lease_expires_at;
END;
$$;

DROP FUNCTION IF EXISTS public.complete_conversation_deletion_step_for_server(UUID, TEXT);
CREATE FUNCTION public.complete_conversation_deletion_step_for_server(
  _request_id UUID, _step_name TEXT, _claim_token UUID, _evidence JSONB
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _remaining INTEGER; _status TEXT;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF _evidence IS NULL OR _evidence = '{}'::jsonb THEN RAISE EXCEPTION 'deletion_evidence_required'; END IF;
  UPDATE private.conversation_deletion_steps step
  SET status = 'completed', completed_at = clock_timestamp(), evidence = _evidence,
    claim_token = NULL, lease_expires_at = NULL, failure_code = NULL, updated_at = clock_timestamp()
  WHERE step.request_id = _request_id AND step.step_name = _step_name
    AND step.status = 'processing' AND step.claim_token = _claim_token
    AND step.lease_expires_at > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_deletion_step_claim_stale'; END IF;
  SELECT count(*) INTO _remaining FROM private.conversation_deletion_steps
  WHERE request_id = _request_id AND status <> 'completed';
  UPDATE public.conversation_deletion_requests request
  SET status = CASE WHEN _remaining = 0 THEN 'active_system_completed' ELSE 'processing' END,
    active_system_completed_at = CASE WHEN _remaining = 0 THEN clock_timestamp() ELSE active_system_completed_at END,
    completed_at = CASE WHEN _remaining = 0 THEN clock_timestamp() ELSE completed_at END,
    updated_at = clock_timestamp(), failure_code = NULL
  WHERE request.id = _request_id RETURNING request.status INTO _status;
  RETURN _status;
END;
$$;

DROP FUNCTION IF EXISTS public.fail_conversation_deletion_step_for_server(UUID, TEXT, TEXT);
CREATE FUNCTION public.fail_conversation_deletion_step_for_server(
  _request_id UUID, _step_name TEXT, _claim_token UUID, _failure_code TEXT
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF char_length(COALESCE(_failure_code, '')) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'invalid_failure_code'; END IF;
  UPDATE private.conversation_deletion_steps step
  SET status = 'failed', failure_code = _failure_code, claim_token = NULL,
    lease_expires_at = NULL, updated_at = clock_timestamp()
  WHERE step.request_id = _request_id AND step.step_name = _step_name
    AND step.status = 'processing' AND step.claim_token = _claim_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_deletion_step_claim_stale'; END IF;
  UPDATE public.conversation_deletion_requests SET status = 'failed', failure_code = _failure_code,
    updated_at = clock_timestamp() WHERE id = _request_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.execute_account_deletion_database_step_for_server(
  _request_id UUID,
  _claim_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, storage, pg_temp
AS $$
DECLARE
  _request public.account_deletion_requests%ROWTYPE;
  _messages INTEGER := 0;
  _notes INTEGER := 0;
  _customer_entries INTEGER := 0;
  _now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  PERFORM 1 FROM private.account_deletion_steps step
  WHERE step.request_id = _request_id AND step.step_name = 'database_content'
    AND step.status = 'processing' AND step.claim_token = _claim_token
    AND step.lease_expires_at > _now FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'deletion_step_claim_stale'; END IF;
  SELECT * INTO _request FROM public.account_deletion_requests request
  WHERE request.id = _request_id AND request.irreversible_started_at IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'deletion_request_not_irreversible'; END IF;

  INSERT INTO private.deletion_storage_objects (
    request_kind, request_id, bucket_id, object_path, ownership_source
  )
  SELECT 'account', _request_id, object.bucket_id, object.name, 'storage_owner'
  FROM storage.objects object
  WHERE object.bucket_id = 'user-avatars' AND object.owner_id = _request.user_id::TEXT
  ON CONFLICT DO NOTHING;
  INSERT INTO private.deletion_storage_objects (
    request_kind, request_id, bucket_id, object_path, ownership_source
  )
  SELECT 'account', _request_id, upload.bucket_id, path.object_path, 'client_media_upload'
  FROM public.client_media_uploads upload
  CROSS JOIN LATERAL unnest(ARRAY[upload.source_path, upload.preview_path]) path(object_path)
  WHERE upload.client_id = _request.user_id AND path.object_path IS NOT NULL
  ON CONFLICT DO NOTHING;

  UPDATE public.messages message
  SET content = '[deleted]', sender_id = CASE
      WHEN message.sender_type = 'client'::public.sender_type THEN NULL ELSE message.sender_id END
  FROM public.conversations conversation
  WHERE conversation.id = message.conversation_id AND conversation.client_id = _request.user_id
    AND (message.content <> '[deleted]' OR (
      message.sender_type = 'client'::public.sender_type AND message.sender_id IS NOT NULL));
  GET DIAGNOSTICS _messages = ROW_COUNT;
  UPDATE public.internal_notes note SET note = '[deleted]'
  FROM public.conversations conversation
  WHERE conversation.id = note.conversation_id AND conversation.client_id = _request.user_id
    AND note.note <> '[deleted]';
  GET DIAGNOSTICS _notes = ROW_COUNT;
  UPDATE public.customer_info_entries entry
  SET content = '[deleted]', metadata = '{}'::JSONB, updated_at = _now
  WHERE entry.client_id = _request.user_id
    AND (entry.content <> '[deleted]' OR entry.metadata <> '{}'::JSONB);
  GET DIAGNOSTICS _customer_entries = ROW_COUNT;

  UPDATE public.profiles
  SET display_name = 'לקוח שנמחק', email = NULL, avatar_url = NULL,
      status = 'archived', deleted_at = COALESCE(deleted_at, _now),
      pii_archived_at = COALESCE(pii_archived_at, _now), pii_archived_by = NULL,
      pii_archive_reason = 'account deletion request', updated_at = _now
  WHERE user_id = _request.user_id;
  UPDATE public.client_profiles
  SET age = NULL, gender = NULL, interests = ARRAY[]::TEXT[],
      conversation_preferences = NULL, first_name = NULL, last_name = NULL,
      date_of_birth = NULL, computed_age = NULL, city_id = NULL, bio = NULL,
      relationship_status = NULL, smoking_status = NULL, preferred_min_age = NULL,
      preferred_max_age = NULL, preferred_distance_km = NULL,
      content_preferences = '[]'::JSONB, character_preferences = '[]'::JSONB,
      profile_image_url = NULL, profile_image_urls = ARRAY[]::TEXT[], updated_at = _now
  WHERE user_id = _request.user_id;
  DELETE FROM public.client_character_preferences WHERE client_id = _request.user_id;
  DELETE FROM public.client_discovery_cycles WHERE client_id = _request.user_id;
  DELETE FROM public.conversation_read_states WHERE user_id = _request.user_id;
  DELETE FROM public.user_active_conversations WHERE user_id = _request.user_id;
  DELETE FROM public.notifications WHERE user_id = _request.user_id;
  DELETE FROM public.notification_settings WHERE user_id = _request.user_id;

  RETURN jsonb_build_object(
    'operation', 'database_content_minimized', 'messages_redacted', _messages,
    'notes_redacted', _notes, 'customer_entries_redacted', _customer_entries,
    'storage_objects_manifested', (
      SELECT count(*) FROM private.deletion_storage_objects object
      WHERE object.request_kind = 'account' AND object.request_id = _request_id
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.execute_conversation_deletion_database_step_for_server(
  _request_id UUID,
  _claim_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _request public.conversation_deletion_requests%ROWTYPE;
  _messages INTEGER := 0;
  _notes INTEGER := 0;
  _customer_entries INTEGER := 0;
  _now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  PERFORM 1 FROM private.conversation_deletion_steps step
  WHERE step.request_id = _request_id AND step.step_name = 'database_content'
    AND step.status = 'processing' AND step.claim_token = _claim_token
    AND step.lease_expires_at > _now FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_deletion_step_claim_stale'; END IF;
  SELECT * INTO _request FROM public.conversation_deletion_requests request
  WHERE request.id = _request_id AND request.irreversible_started_at IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_deletion_not_irreversible'; END IF;

  INSERT INTO private.deletion_storage_objects (
    request_kind, request_id, bucket_id, object_path, ownership_source
  )
  SELECT 'conversation', _request_id, upload.bucket_id, path.object_path, 'client_media_upload'
  FROM public.client_media_uploads upload
  CROSS JOIN LATERAL unnest(ARRAY[upload.source_path, upload.preview_path]) path(object_path)
  WHERE upload.conversation_id = _request.conversation_id AND path.object_path IS NOT NULL
  ON CONFLICT DO NOTHING;

  UPDATE public.messages SET content = '[deleted]',
    sender_id = CASE WHEN sender_type = 'client'::public.sender_type THEN NULL ELSE sender_id END
  WHERE conversation_id = _request.conversation_id
    AND (content <> '[deleted]' OR (sender_type = 'client'::public.sender_type AND sender_id IS NOT NULL));
  GET DIAGNOSTICS _messages = ROW_COUNT;
  UPDATE public.message_attachments attachment
  SET caption = NULL, metadata = '{}'::JSONB
  FROM public.messages message
  WHERE message.id = attachment.message_id AND message.conversation_id = _request.conversation_id;
  UPDATE public.internal_notes SET note = '[deleted]'
  WHERE conversation_id = _request.conversation_id AND note <> '[deleted]';
  GET DIAGNOSTICS _notes = ROW_COUNT;
  UPDATE public.customer_info_entries
  SET content = '[deleted]', metadata = '{}'::JSONB, updated_at = _now
  WHERE conversation_id = _request.conversation_id
    AND (content <> '[deleted]' OR metadata <> '{}'::JSONB);
  GET DIAGNOSTICS _customer_entries = ROW_COUNT;

  RETURN jsonb_build_object(
    'operation', 'conversation_content_minimized', 'messages_redacted', _messages,
    'notes_redacted', _notes, 'customer_entries_redacted', _customer_entries,
    'storage_objects_manifested', (
      SELECT count(*) FROM private.deletion_storage_objects object
      WHERE object.request_kind = 'conversation' AND object.request_id = _request_id
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.list_deletion_storage_objects_for_server(
  _request_kind TEXT,
  _request_id UUID,
  _claim_token UUID
)
RETURNS TABLE (bucket_id TEXT, object_path TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF _request_kind = 'account' THEN
    PERFORM 1 FROM private.account_deletion_steps step
    WHERE step.request_id = _request_id AND step.step_name = 'storage'
      AND step.status = 'processing' AND step.claim_token = _claim_token
      AND step.lease_expires_at > clock_timestamp();
  ELSIF _request_kind = 'conversation' THEN
    PERFORM 1 FROM private.conversation_deletion_steps step
    WHERE step.request_id = _request_id AND step.step_name = 'storage'
      AND step.status = 'processing' AND step.claim_token = _claim_token
      AND step.lease_expires_at > clock_timestamp();
  ELSE
    RAISE EXCEPTION 'invalid_deletion_request_kind';
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'deletion_storage_claim_stale'; END IF;
  RETURN QUERY SELECT object.bucket_id, object.object_path
  FROM private.deletion_storage_objects object
  WHERE object.request_kind = _request_kind AND object.request_id = _request_id
    AND object.status = 'pending'
  ORDER BY object.bucket_id, object.object_path;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_deletion_storage_object_for_server(
  _request_kind TEXT,
  _request_id UUID,
  _claim_token UUID,
  _bucket_id TEXT,
  _object_path TEXT
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM public.list_deletion_storage_objects_for_server(_request_kind, _request_id, _claim_token);
  UPDATE private.deletion_storage_objects object
  SET status = 'deleted', deleted_at = clock_timestamp()
  WHERE object.request_kind = _request_kind AND object.request_id = _request_id
    AND object.bucket_id = _bucket_id AND object.object_path = _object_path
    AND object.status = 'pending';
  IF NOT FOUND AND NOT EXISTS (
    SELECT 1 FROM private.deletion_storage_objects object
    WHERE object.request_kind = _request_kind AND object.request_id = _request_id
      AND object.bucket_id = _bucket_id AND object.object_path = _object_path
      AND object.status = 'deleted'
  ) THEN RAISE EXCEPTION 'deletion_storage_object_not_manifested'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.summarize_deletion_storage_step_for_server(
  _request_kind TEXT,
  _request_id UUID,
  _claim_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _pending INTEGER; _deleted INTEGER;
BEGIN
  PERFORM public.list_deletion_storage_objects_for_server(_request_kind, _request_id, _claim_token);
  SELECT count(*) FILTER (WHERE status = 'pending'), count(*) FILTER (WHERE status = 'deleted')
  INTO _pending, _deleted FROM private.deletion_storage_objects
  WHERE request_kind = _request_kind AND request_id = _request_id;
  IF _pending <> 0 THEN RAISE EXCEPTION 'deletion_storage_objects_pending'; END IF;
  RETURN jsonb_build_object('operation', 'storage_objects_deleted', 'deleted_count', _deleted);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_account_deletion_subject_for_server(
  _request_id UUID,
  _step_name TEXT,
  _claim_token UUID
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _user_id UUID;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  SELECT request.user_id INTO _user_id
  FROM public.account_deletion_requests request
  JOIN private.account_deletion_steps step ON step.request_id = request.id
  WHERE request.id = _request_id AND step.step_name = _step_name
    AND step.status = 'processing' AND step.claim_token = _claim_token
    AND step.lease_expires_at > clock_timestamp();
  IF _user_id IS NULL THEN RAISE EXCEPTION 'deletion_step_claim_stale'; END IF;
  RETURN _user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_deletion_completion_for_server(
  _request_kind TEXT,
  _request_id UUID,
  _claim_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _policy_version TEXT; _evidence_hash TEXT;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF _request_kind = 'account' THEN
    SELECT request.retention_policy_version INTO _policy_version
    FROM public.account_deletion_requests request
    JOIN private.account_deletion_steps step ON step.request_id = request.id
    WHERE request.id = _request_id AND step.step_name = 'finalize'
      AND step.status = 'processing' AND step.claim_token = _claim_token
      AND step.lease_expires_at > clock_timestamp();
    SELECT encode(extensions.digest(COALESCE(jsonb_agg(jsonb_build_object(
      'step', step.step_name, 'evidence', step.evidence
    ) ORDER BY step.step_name), '[]'::JSONB)::TEXT, 'sha256'), 'hex')
    INTO _evidence_hash FROM private.account_deletion_steps step
    WHERE step.request_id = _request_id AND step.step_name <> 'finalize';
  ELSIF _request_kind = 'conversation' THEN
    SELECT request.retention_policy_version INTO _policy_version
    FROM public.conversation_deletion_requests request
    JOIN private.conversation_deletion_steps step ON step.request_id = request.id
    WHERE request.id = _request_id AND step.step_name = 'finalize'
      AND step.status = 'processing' AND step.claim_token = _claim_token
      AND step.lease_expires_at > clock_timestamp();
    SELECT encode(extensions.digest(COALESCE(jsonb_agg(jsonb_build_object(
      'step', step.step_name, 'evidence', step.evidence
    ) ORDER BY step.step_name), '[]'::JSONB)::TEXT, 'sha256'), 'hex')
    INTO _evidence_hash FROM private.conversation_deletion_steps step
    WHERE step.request_id = _request_id AND step.step_name <> 'finalize';
  ELSE RAISE EXCEPTION 'invalid_deletion_request_kind';
  END IF;
  IF _policy_version IS NULL THEN RAISE EXCEPTION 'deletion_step_claim_stale'; END IF;
  INSERT INTO private.deletion_completion_ledger (
    request_kind, request_id, policy_version, active_system_completed_at, evidence_hash
  ) VALUES (_request_kind, _request_id, _policy_version, clock_timestamp(), _evidence_hash)
  ON CONFLICT (request_kind, request_id) DO UPDATE
  SET evidence_hash = EXCLUDED.evidence_hash;
  RETURN jsonb_build_object('operation', 'completion_ledger_recorded',
    'policy_version', _policy_version, 'evidence_hash', _evidence_hash,
    'backup_expiry_verified', false);
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_account_deletion_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_account_deletion_status() TO authenticated;
REVOKE ALL ON FUNCTION public.authorize_early_account_deletion_for_server(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_account_deletion_for_server(UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_account_deletion_cancellation_for_server(UUID, UUID, TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_account_deletion_for_server(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_account_deletion_step_for_server(UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_account_deletion_step_for_server(UUID, TEXT, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_account_deletion_step_for_server(UUID, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_conversation_deletion_step_for_server(UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_conversation_deletion_step_for_server(UUID, TEXT, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_conversation_deletion_step_for_server(UUID, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.execute_account_deletion_database_step_for_server(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.execute_conversation_deletion_database_step_for_server(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_deletion_storage_objects_for_server(TEXT, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_deletion_storage_object_for_server(TEXT, UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.summarize_deletion_storage_step_for_server(TEXT, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_account_deletion_subject_for_server(UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_deletion_completion_for_server(TEXT, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_early_account_deletion_for_server(UUID, TEXT),
  public.prepare_account_deletion_verification_for_server(UUID, TEXT, TIMESTAMPTZ),
  public.verify_account_deletion_for_server(UUID, TEXT, UUID),
  public.prepare_account_deletion_cancellation_for_server(UUID, UUID, TEXT, TIMESTAMPTZ),
  public.cancel_account_deletion_for_server(UUID, UUID, TEXT),
  public.claim_account_deletion_step_for_server(UUID),
  public.complete_account_deletion_step_for_server(UUID, TEXT, UUID, JSONB),
  public.fail_account_deletion_step_for_server(UUID, TEXT, UUID, TEXT),
  public.claim_conversation_deletion_step_for_server(UUID),
  public.complete_conversation_deletion_step_for_server(UUID, TEXT, UUID, JSONB),
  public.fail_conversation_deletion_step_for_server(UUID, TEXT, UUID, TEXT),
  public.execute_account_deletion_database_step_for_server(UUID, UUID),
  public.execute_conversation_deletion_database_step_for_server(UUID, UUID),
  public.list_deletion_storage_objects_for_server(TEXT, UUID, UUID),
  public.complete_deletion_storage_object_for_server(TEXT, UUID, UUID, TEXT, TEXT),
  public.summarize_deletion_storage_step_for_server(TEXT, UUID, UUID),
  public.get_account_deletion_subject_for_server(UUID, TEXT, UUID),
  public.record_deletion_completion_for_server(TEXT, UUID, UUID)
  TO service_role;

NOTIFY pgrst, 'reload schema';
