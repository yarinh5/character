CREATE OR REPLACE FUNCTION public.claim_account_deletion_step_for_server(_request_id UUID)
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
        step.step_name <> 'retention_minimization'
        OR step.failure_code IS DISTINCT FROM 'retention_conditions_pending'
      )
      AND (
        step.step_name = 'session_revocation'
        OR (
          _irreversible_enabled
          AND request.irreversible_started_at IS NOT NULL
          AND NOT private.account_deletion_hold_blocks_step(request.user_id, step.step_name)
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
          AND (
            CASE step.step_name
              WHEN 'retention_minimization' THEN predecessor.step_name = 'storage'
              WHEN 'auth_delete' THEN predecessor.step_name = 'retention_minimization'
              WHEN 'finalize' THEN predecessor.step_name IN (
                'session_revocation', 'database_content', 'storage', 'retention_minimization', 'auth_delete'
              )
              ELSE FALSE
            END
          )
          AND predecessor.status <> 'completed'
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
  RETURNING step.request_id, step.step_name, step.attempt_count,
    step.claim_token, step.lease_expires_at;
END;
$$;
