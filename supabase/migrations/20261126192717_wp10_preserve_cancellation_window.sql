CREATE OR REPLACE FUNCTION public.complete_account_deletion_step_for_server(
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
  SET status = CASE
      WHEN _remaining = 0 THEN 'active_system_completed'
      WHEN _step_name = 'session_revocation'
        AND request.status IN ('blocked_retention', 'ready_for_deletion') THEN request.status
      WHEN _step_name = 'session_revocation'
        AND request.irreversible_started_at IS NULL THEN 'cancellation_window'
      ELSE 'processing'
    END,
    active_system_completed_at = CASE WHEN _remaining = 0 THEN clock_timestamp() ELSE active_system_completed_at END,
    completed_at = CASE WHEN _remaining = 0 THEN clock_timestamp() ELSE completed_at END,
    updated_at = clock_timestamp(), failure_code = NULL
  WHERE request.id = _request_id RETURNING request.status INTO _status;
  RETURN _status;
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
  UPDATE public.profiles profile SET status = 'active', updated_at = _now
  WHERE profile.user_id = _verified_user_id AND profile.status = 'deletion_requested';
  UPDATE private.account_deletion_steps step
  SET status = 'failed', failure_code = 'request_cancelled',
    claim_token = NULL, lease_expires_at = NULL, updated_at = _now
  WHERE step.request_id = _request_id AND step.status <> 'completed';
  INSERT INTO public.audit_logs(actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_verified_user_id, 'account_deletion_cancelled', 'account_deletion_request', _request_id,
    jsonb_build_object('requires_new_login', true, 'identity_verification', 'supabase_auth_email'));
  RETURN NEXT;
END;
$$;

UPDATE public.account_deletion_requests request
SET status = 'cancellation_window', updated_at = clock_timestamp()
WHERE request.status = 'processing'
  AND request.cancellation_deadline > clock_timestamp()
  AND request.irreversible_started_at IS NULL
  AND EXISTS (
    SELECT 1 FROM private.account_deletion_steps step
    WHERE step.request_id = request.id
      AND step.step_name = 'session_revocation' AND step.status = 'completed'
  )
  AND NOT EXISTS (
    SELECT 1 FROM private.account_deletion_steps step
    WHERE step.request_id = request.id
      AND step.step_name <> 'session_revocation' AND step.status <> 'pending'
  );
