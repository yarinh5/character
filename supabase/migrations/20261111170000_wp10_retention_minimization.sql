-- WP10 / P04: execute the approved, non-financial retention minimization work.
-- This migration only prepares fenced workflow operations. Scheduler and
-- irreversible execution gates remain disabled.

ALTER TABLE private.deletion_retention_policy
  ADD COLUMN IF NOT EXISTS personal_fields TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  ADD COLUMN IF NOT EXISTS business_need TEXT,
  ADD COLUMN IF NOT EXISTS minimization_action TEXT;

UPDATE private.deletion_retention_policy
SET personal_fields = ARRAY['message_content', 'notes', 'profile_fields', 'personal_media'],
    business_need = 'No continuing business need after the approved deletion deadline.',
    minimization_action = 'Handled by the fenced database_content and storage steps.'
WHERE policy_version = 'p04-2026-11-11' AND subject_kind = 'account'
  AND record_type = 'personal_content';

UPDATE private.deletion_retention_policy
SET personal_fields = ARRAY['free_text_reason', 'metadata_identifiers'],
    business_need = 'Reconciliation, duplicate prevention and dispute handling for internal credits and levels.',
    minimization_action = 'Preserve amounts, balances, rights and internal identifiers; remove free text and direct identifier metadata.'
WHERE policy_version = 'p04-2026-11-11' AND subject_kind = 'account'
  AND record_type = 'internal_credits_points';

UPDATE private.deletion_retention_policy
SET personal_fields = ARRAY['report_details', 'reporter_internal_id'],
    business_need = 'Authorized safety review for 24 months after incident closure.',
    minimization_action = 'Remove optional details only after a closure anchor exists; unresolved incidents remain protected.'
WHERE policy_version = 'p04-2026-11-11' AND subject_kind = 'account'
  AND record_type = 'safety_reports';

UPDATE private.deletion_retention_policy
SET personal_fields = ARRAY['free_text_reason'],
    business_need = 'Enforce an active block and retain it for up to 12 months after account deletion.',
    minimization_action = 'Remove the free-text reason while preserving the scoped operator/client block relation.'
WHERE policy_version = 'p04-2026-11-11' AND subject_kind = 'account'
  AND record_type = 'blocks';

UPDATE private.deletion_retention_policy
SET personal_fields = ARRAY['metadata.email', 'metadata.name', 'metadata.phone', 'metadata.content', 'metadata.note'],
    business_need = 'Authorized operational audit for 24 months after the action.',
    minimization_action = 'Remove direct-identifier and free-content metadata while retaining action, time and limited internal identifiers.'
WHERE policy_version = 'p04-2026-11-11' AND subject_kind = 'account'
  AND record_type = 'admin_audit';

UPDATE private.deletion_retention_policy
SET personal_fields = ARRAY['classification_dependent_identifiers'],
    business_need = 'Preserve only records later confirmed as legally or financially required.',
    minimization_action = 'No mutation until legal/accounting classification and anchor are approved.',
    blocks_step = NULL,
    notes = 'Accounting/legal classification remains pending. The record class stays protected without blocking unrelated approved minimization.'
WHERE policy_version = 'p04-2026-11-11' AND subject_kind = 'account'
  AND record_type = 'financial_records';

UPDATE private.deletion_retention_policy
SET personal_fields = ARRAY['provider_backup_copy'],
    business_need = 'Provider disaster recovery subject to a separately verified retention contract.',
    minimization_action = 'No active-system mutation; provider expiry remains unverified.'
WHERE policy_version = 'p04-2026-11-11' AND subject_kind = 'account'
  AND record_type = 'backups';

CREATE TABLE private.deletion_retention_results (
  request_id UUID NOT NULL REFERENCES public.account_deletion_requests(id) ON DELETE CASCADE,
  record_type TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  decision_status TEXT NOT NULL CHECK (
    decision_status IN ('approved', 'pending_legal', 'provider_unverified')
  ),
  outcome TEXT NOT NULL CHECK (
    outcome IN (
      'minimized', 'retained_until', 'no_records', 'held',
      'pending_anchor', 'pending_legal', 'provider_unverified'
    )
  ),
  anchor_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  hold_id UUID REFERENCES private.deletion_holds(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z0-9_]{3,120}$'),
  evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  claim_token UUID NOT NULL,
  PRIMARY KEY (request_id, record_type),
  CHECK (due_at IS NULL OR anchor_at IS NOT NULL),
  CHECK ((outcome = 'held') = (hold_id IS NOT NULL))
);

CREATE INDEX deletion_retention_results_due_idx
  ON private.deletion_retention_results(due_at, request_id, record_type)
  WHERE outcome = 'retained_until';

REVOKE ALL ON TABLE private.deletion_retention_results
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.account_deletion_hold_blocks_step(
  _user_id UUID,
  _step_name TEXT
)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = private, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM private.deletion_holds hold
    WHERE hold.subject_kind = 'account'
      AND hold.subject_id = _user_id
      AND hold.released_at IS NULL
      AND (
        hold.record_type = '*'
        OR hold.record_type NOT IN (
          'personal_content', 'internal_credits_points', 'financial_records',
          'safety_reports', 'blocks', 'admin_audit', 'backups'
        )
        OR (
          hold.record_type = 'personal_content'
          AND _step_name IN ('database_content', 'storage')
        )
      )
  );
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
      AND NOT (
        step.step_name = 'retention_minimization'
        AND step.failure_code = 'retention_conditions_pending'
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

CREATE OR REPLACE FUNCTION public.execute_account_retention_minimization_for_server(
  _request_id UUID,
  _claim_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _request public.account_deletion_requests%ROWTYPE;
  _now TIMESTAMPTZ := clock_timestamp();
  _hold_id UUID;
  _count INTEGER := 0;
  _open_safety INTEGER := 0;
  _anchor TIMESTAMPTZ;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;

  PERFORM 1
  FROM private.account_deletion_steps step
  WHERE step.request_id = _request_id
    AND step.step_name = 'retention_minimization'
    AND step.status = 'processing'
    AND step.claim_token = _claim_token
    AND step.lease_expires_at > _now
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'deletion_step_claim_stale'; END IF;

  SELECT * INTO _request
  FROM public.account_deletion_requests request
  WHERE request.id = _request_id
    AND request.irreversible_started_at IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'deletion_request_not_irreversible'; END IF;

  -- Personal content was minimized by the fenced predecessor steps.
  SELECT hold.id INTO _hold_id
  FROM private.deletion_holds hold
  WHERE hold.subject_kind = 'account' AND hold.subject_id = _request.user_id
    AND hold.record_type IN ('*', 'personal_content') AND hold.released_at IS NULL
  ORDER BY (hold.record_type = '*') DESC, hold.created_at LIMIT 1;
  INSERT INTO private.deletion_retention_results (
    request_id, record_type, policy_version, decision_status, outcome,
    anchor_at, due_at, hold_id, reason_code, evidence, claim_token
  ) VALUES (
    _request_id, 'personal_content', _request.retention_policy_version, 'approved',
    CASE WHEN _hold_id IS NULL THEN 'minimized' ELSE 'held' END,
    _request.confirmed_at, _request.content_deletion_due_at, _hold_id,
    CASE WHEN _hold_id IS NULL THEN 'predecessor_steps_verified' ELSE 'active_targeted_hold' END,
    jsonb_build_object('handled_by', ARRAY['database_content', 'storage']), _claim_token
  )
  ON CONFLICT (request_id, record_type) DO UPDATE SET
    outcome = EXCLUDED.outcome, anchor_at = EXCLUDED.anchor_at, due_at = EXCLUDED.due_at,
    hold_id = EXCLUDED.hold_id, reason_code = EXCLUDED.reason_code,
    evidence = EXCLUDED.evidence, evaluated_at = _now, claim_token = EXCLUDED.claim_token;

  -- Internal credit and level records keep amounts, balances, rights and identifiers.
  _hold_id := NULL;
  SELECT hold.id INTO _hold_id FROM private.deletion_holds hold
  WHERE hold.subject_kind = 'account' AND hold.subject_id = _request.user_id
    AND hold.record_type IN ('*', 'internal_credits_points') AND hold.released_at IS NULL
  ORDER BY (hold.record_type = '*') DESC, hold.created_at LIMIT 1;
  _count := 0;
  IF _hold_id IS NULL THEN
    UPDATE public.credit_transactions credit_tx
    SET reason = CASE WHEN credit_tx.reason IS NULL THEN NULL ELSE '[minimized]' END,
        metadata = COALESCE(credit_tx.metadata, '{}'::JSONB)
          - ARRAY['email', 'name', 'display_name', 'phone', 'content', 'message', 'note']
    WHERE credit_tx.user_id = _request.user_id
      AND credit_tx.type <> 'package_purchase'
      AND (
        credit_tx.reason IS DISTINCT FROM CASE WHEN credit_tx.reason IS NULL THEN NULL ELSE '[minimized]' END
        OR credit_tx.metadata ?| ARRAY['email', 'name', 'display_name', 'phone', 'content', 'message', 'note']
      );
    GET DIAGNOSTICS _count = ROW_COUNT;
  END IF;
  INSERT INTO private.deletion_retention_results (
    request_id, record_type, policy_version, decision_status, outcome,
    anchor_at, due_at, hold_id, reason_code, evidence, claim_token
  ) VALUES (
    _request_id, 'internal_credits_points', _request.retention_policy_version, 'approved',
    CASE WHEN _hold_id IS NOT NULL THEN 'held' ELSE 'pending_anchor' END,
    NULL, NULL, _hold_id,
    CASE WHEN _hold_id IS NOT NULL THEN 'active_targeted_hold' ELSE 'active_system_completion_anchor_pending' END,
    jsonb_build_object(
      'metadata_rows_minimized', _count,
      'ledger_amounts_preserved', true,
      'wallet_balances_preserved', true,
      'package_purchase_records_untouched', true
    ), _claim_token
  )
  ON CONFLICT (request_id, record_type) DO UPDATE SET
    outcome = EXCLUDED.outcome, anchor_at = EXCLUDED.anchor_at, due_at = EXCLUDED.due_at,
    hold_id = EXCLUDED.hold_id, reason_code = EXCLUDED.reason_code,
    evidence = EXCLUDED.evidence, evaluated_at = _now, claim_token = EXCLUDED.claim_token;

  -- Safety rows without an authoritative closure anchor remain protected.
  _hold_id := NULL; _count := 0; _open_safety := 0; _anchor := NULL;
  SELECT hold.id INTO _hold_id FROM private.deletion_holds hold
  WHERE hold.subject_kind = 'account' AND hold.subject_id = _request.user_id
    AND hold.record_type IN ('*', 'safety_reports') AND hold.released_at IS NULL
  ORDER BY (hold.record_type = '*') DESC, hold.created_at LIMIT 1;
  IF _hold_id IS NULL THEN
    UPDATE public.reports report
    SET details = NULL
    WHERE report.reporter_id = _request.user_id
      AND report.status IN ('resolved', 'dismissed')
      AND report.details IS NOT NULL;
    GET DIAGNOSTICS _count = ROW_COUNT;
    SELECT count(*) INTO _open_safety FROM public.reports report
      WHERE report.reporter_id = _request.user_id AND report.status IN ('open', 'reviewed');
    _open_safety := _open_safety + (
      SELECT count(*) FROM public.operator_client_reports report
      WHERE report.client_id = _request.user_id
    );
    SELECT max(report.updated_at) INTO _anchor FROM public.reports report
      WHERE report.reporter_id = _request.user_id AND report.status IN ('resolved', 'dismissed');
  END IF;
  INSERT INTO private.deletion_retention_results (
    request_id, record_type, policy_version, decision_status, outcome,
    anchor_at, due_at, hold_id, reason_code, evidence, claim_token
  ) VALUES (
    _request_id, 'safety_reports', _request.retention_policy_version, 'approved',
    CASE
      WHEN _hold_id IS NOT NULL THEN 'held'
      WHEN _open_safety > 0 THEN 'pending_anchor'
      WHEN _anchor IS NULL THEN 'no_records'
      ELSE 'retained_until'
    END,
    CASE WHEN _open_safety = 0 THEN _anchor ELSE NULL END,
    CASE WHEN _open_safety = 0 AND _anchor IS NOT NULL THEN _anchor + interval '24 months' ELSE NULL END,
    _hold_id,
    CASE
      WHEN _hold_id IS NOT NULL THEN 'active_targeted_hold'
      WHEN _open_safety > 0 THEN 'incident_closure_anchor_missing'
      WHEN _anchor IS NULL THEN 'no_matching_records'
      ELSE 'approved_retention_window'
    END,
    jsonb_build_object('details_minimized', _count, 'records_without_closure_anchor', _open_safety),
    _claim_token
  )
  ON CONFLICT (request_id, record_type) DO UPDATE SET
    outcome = EXCLUDED.outcome, anchor_at = EXCLUDED.anchor_at, due_at = EXCLUDED.due_at,
    hold_id = EXCLUDED.hold_id, reason_code = EXCLUDED.reason_code,
    evidence = EXCLUDED.evidence, evaluated_at = _now, claim_token = EXCLUDED.claim_token;

  -- Active blocks retain their relationship while free text is removed.
  _hold_id := NULL; _count := 0;
  SELECT hold.id INTO _hold_id FROM private.deletion_holds hold
  WHERE hold.subject_kind = 'account' AND hold.subject_id = _request.user_id
    AND hold.record_type IN ('*', 'blocks') AND hold.released_at IS NULL
  ORDER BY (hold.record_type = '*') DESC, hold.created_at LIMIT 1;
  IF _hold_id IS NULL THEN
    UPDATE public.operator_client_blocks client_block SET reason = NULL
    WHERE client_block.client_id = _request.user_id AND client_block.reason IS NOT NULL;
    GET DIAGNOSTICS _count = ROW_COUNT;
  END IF;
  INSERT INTO private.deletion_retention_results (
    request_id, record_type, policy_version, decision_status, outcome,
    anchor_at, due_at, hold_id, reason_code, evidence, claim_token
  ) VALUES (
    _request_id, 'blocks', _request.retention_policy_version, 'approved',
    CASE WHEN _hold_id IS NOT NULL THEN 'held' ELSE 'pending_anchor' END,
    NULL, NULL, _hold_id,
    CASE WHEN _hold_id IS NOT NULL THEN 'active_targeted_hold' ELSE 'active_system_completion_anchor_pending' END,
    jsonb_build_object('free_text_rows_minimized', _count, 'block_relations_preserved', true),
    _claim_token
  )
  ON CONFLICT (request_id, record_type) DO UPDATE SET
    outcome = EXCLUDED.outcome, anchor_at = EXCLUDED.anchor_at, due_at = EXCLUDED.due_at,
    hold_id = EXCLUDED.hold_id, reason_code = EXCLUDED.reason_code,
    evidence = EXCLUDED.evidence, evaluated_at = _now, claim_token = EXCLUDED.claim_token;

  -- Audit action/time and limited identifiers remain; direct metadata is removed.
  _hold_id := NULL; _count := 0; _anchor := NULL;
  SELECT hold.id INTO _hold_id FROM private.deletion_holds hold
  WHERE hold.subject_kind = 'account' AND hold.subject_id = _request.user_id
    AND hold.record_type IN ('*', 'admin_audit') AND hold.released_at IS NULL
  ORDER BY (hold.record_type = '*') DESC, hold.created_at LIMIT 1;
  IF _hold_id IS NULL THEN
    UPDATE public.audit_logs audit
    SET metadata = COALESCE(audit.metadata, '{}'::JSONB)
      - ARRAY['email', 'name', 'display_name', 'phone', 'content', 'message', 'note', 'details']
    WHERE (audit.actor_user_id = _request.user_id OR audit.entity_id = _request.user_id::TEXT)
      AND audit.metadata ?| ARRAY['email', 'name', 'display_name', 'phone', 'content', 'message', 'note', 'details'];
    GET DIAGNOSTICS _count = ROW_COUNT;
    SELECT max(audit.created_at) INTO _anchor FROM public.audit_logs audit
    WHERE audit.actor_user_id = _request.user_id OR audit.entity_id = _request.user_id::TEXT;
  END IF;
  INSERT INTO private.deletion_retention_results (
    request_id, record_type, policy_version, decision_status, outcome,
    anchor_at, due_at, hold_id, reason_code, evidence, claim_token
  ) VALUES (
    _request_id, 'admin_audit', _request.retention_policy_version, 'approved',
    CASE
      WHEN _hold_id IS NOT NULL THEN 'held'
      WHEN _anchor IS NULL THEN 'no_records'
      ELSE 'retained_until'
    END,
    _anchor, CASE WHEN _anchor IS NULL THEN NULL ELSE _anchor + interval '24 months' END,
    _hold_id,
    CASE
      WHEN _hold_id IS NOT NULL THEN 'active_targeted_hold'
      WHEN _anchor IS NULL THEN 'no_matching_records'
      ELSE 'approved_retention_window'
    END,
    jsonb_build_object('metadata_rows_minimized', _count, 'audit_action_and_time_preserved', true),
    _claim_token
  )
  ON CONFLICT (request_id, record_type) DO UPDATE SET
    outcome = EXCLUDED.outcome, anchor_at = EXCLUDED.anchor_at, due_at = EXCLUDED.due_at,
    hold_id = EXCLUDED.hold_id, reason_code = EXCLUDED.reason_code,
    evidence = EXCLUDED.evidence, evaluated_at = _now, claim_token = EXCLUDED.claim_token;

  -- Financial classification and provider backup expiry are deliberately not guessed.
  _hold_id := NULL;
  SELECT hold.id INTO _hold_id FROM private.deletion_holds hold
  WHERE hold.subject_kind = 'account' AND hold.subject_id = _request.user_id
    AND hold.record_type IN ('*', 'financial_records') AND hold.released_at IS NULL
  ORDER BY (hold.record_type = '*') DESC, hold.created_at LIMIT 1;
  INSERT INTO private.deletion_retention_results (
    request_id, record_type, policy_version, decision_status, outcome,
    hold_id, reason_code, evidence, claim_token
  ) VALUES (
    _request_id, 'financial_records', _request.retention_policy_version, 'pending_legal',
    CASE WHEN _hold_id IS NULL THEN 'pending_legal' ELSE 'held' END,
    _hold_id,
    CASE WHEN _hold_id IS NULL THEN 'financial_classification_pending' ELSE 'active_targeted_hold' END,
    jsonb_build_object('records_mutated', false, 'ledger_preserved', true), _claim_token
  )
  ON CONFLICT (request_id, record_type) DO UPDATE SET
    outcome = EXCLUDED.outcome, anchor_at = NULL, due_at = NULL,
    hold_id = EXCLUDED.hold_id, reason_code = EXCLUDED.reason_code,
    evidence = EXCLUDED.evidence, evaluated_at = _now, claim_token = EXCLUDED.claim_token;

  INSERT INTO private.deletion_retention_results (
    request_id, record_type, policy_version, decision_status, outcome,
    reason_code, evidence, claim_token
  ) VALUES (
    _request_id, 'backups', _request.retention_policy_version, 'provider_unverified',
    'provider_unverified', 'backup_expiry_not_verified',
    jsonb_build_object('active_system_completion_is_not_backup_expiry', true), _claim_token
  )
  ON CONFLICT (request_id, record_type) DO UPDATE SET
    outcome = EXCLUDED.outcome, anchor_at = NULL, due_at = NULL, hold_id = NULL,
    reason_code = EXCLUDED.reason_code, evidence = EXCLUDED.evidence,
    evaluated_at = _now, claim_token = EXCLUDED.claim_token;

  RETURN jsonb_build_object(
    'operation', 'retention_minimization_evaluated',
    'policy_version', _request.retention_policy_version,
    'ledger_amounts_preserved', true,
    'financial_classification_pending', true,
    'backup_expiry_verified', false,
    'completion_ready', NOT EXISTS (
      SELECT 1
      FROM private.deletion_retention_results blocked
      WHERE blocked.request_id = _request_id
        AND (
          blocked.outcome IN ('held', 'pending_legal')
          OR (
            blocked.outcome = 'pending_anchor'
            AND blocked.reason_code <> 'active_system_completion_anchor_pending'
          )
        )
    ),
    'blocking_reasons', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'record_type', blocked.record_type,
        'reason_code', blocked.reason_code
      ) ORDER BY blocked.record_type)
      FROM private.deletion_retention_results blocked
      WHERE blocked.request_id = _request_id
        AND (
          blocked.outcome IN ('held', 'pending_legal')
          OR (
            blocked.outcome = 'pending_anchor'
            AND blocked.reason_code <> 'active_system_completion_anchor_pending'
          )
        )
    ), '[]'::JSONB),
    'results', (
      SELECT jsonb_object_agg(result.record_type, jsonb_build_object(
        'outcome', result.outcome,
        'reason_code', result.reason_code,
        'anchor_at', result.anchor_at,
        'due_at', result.due_at
      ) ORDER BY result.record_type)
      FROM private.deletion_retention_results result
      WHERE result.request_id = _request_id
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.block_account_retention_minimization_for_server(
  _request_id UUID,
  _claim_token UUID,
  _evidence JSONB
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF COALESCE((_evidence ->> 'completion_ready')::BOOLEAN, TRUE) THEN
    RAISE EXCEPTION 'retention_block_evidence_required';
  END IF;

  UPDATE private.account_deletion_steps step
  SET status = 'failed',
      failure_code = 'retention_conditions_pending',
      evidence = _evidence,
      claimed_at = NULL,
      claim_token = NULL,
      lease_expires_at = NULL
  WHERE step.request_id = _request_id
    AND step.step_name = 'retention_minimization'
    AND step.status = 'processing'
    AND step.claim_token = _claim_token
    AND step.lease_expires_at > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'deletion_step_claim_stale'; END IF;

  UPDATE public.account_deletion_requests
  SET status = 'blocked_retention', updated_at = clock_timestamp()
  WHERE id = _request_id
    AND status NOT IN ('cancelled', 'completed', 'active_system_completed');
END;
$$;

CREATE OR REPLACE FUNCTION private.anchor_account_retention_after_completion()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = private, pg_temp
AS $$
BEGIN
  IF OLD.active_system_completed_at IS NULL AND NEW.active_system_completed_at IS NOT NULL THEN
    UPDATE private.deletion_retention_results result
    SET outcome = 'retained_until',
        anchor_at = NEW.active_system_completed_at,
        due_at = NEW.active_system_completed_at + CASE result.record_type
          WHEN 'internal_credits_points' THEN interval '24 months'
          WHEN 'blocks' THEN interval '12 months'
        END,
        reason_code = 'approved_retention_window',
        evaluated_at = clock_timestamp()
    WHERE result.request_id = NEW.id
      AND result.record_type IN ('internal_credits_points', 'blocks')
      AND result.outcome = 'pending_anchor'
      AND result.hold_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS anchor_account_retention_after_completion
  ON public.account_deletion_requests;
CREATE TRIGGER anchor_account_retention_after_completion
AFTER UPDATE OF active_system_completed_at ON public.account_deletion_requests
FOR EACH ROW EXECUTE FUNCTION private.anchor_account_retention_after_completion();

REVOKE ALL ON FUNCTION private.account_deletion_hold_blocks_step(UUID, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.anchor_account_retention_after_completion()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_account_deletion_step_for_server(UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.execute_account_retention_minimization_for_server(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.block_account_retention_minimization_for_server(UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_account_deletion_step_for_server(UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.execute_account_retention_minimization_for_server(UUID, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.block_account_retention_minimization_for_server(UUID, UUID, JSONB)
  TO service_role;
