-- WP01.3: resumable backfill, explicit repair, reconciliation and cutover
-- readiness. This migration does not change legacy_shadow mode.

CREATE TABLE private.handling_backfill_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  requested_limit INTEGER NOT NULL CHECK (requested_limit BETWEEN 1 AND 1000),
  initialized_count INTEGER NOT NULL DEFAULT 0,
  unresolved_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed'))
);

REVOKE ALL ON TABLE private.handling_backfill_runs
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.recompute_conversation_handling_shadow_locked(
  _conversation_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _message RECORD;
  _needs_handling BOOLEAN := FALSE;
  _pending_since TIMESTAMPTZ;
  _last_business_message_at TIMESTAMPTZ;
  _last_sequence BIGINT;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();

  PERFORM 1
  FROM public.conversations conversation
  WHERE conversation.id = _conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  FOR _message IN
    SELECT
      semantics.handling_sequence,
      semantics.created_at,
      semantics.expected_handling_effect AS handling_effect
    FROM private.get_message_handling_semantics() semantics
    WHERE semantics.conversation_id = _conversation_id
      AND semantics.handling_sequence IS NOT NULL
    ORDER BY semantics.handling_sequence, semantics.message_id
  LOOP
    _last_sequence := _message.handling_sequence;

    IF _message.handling_effect = 'client_request' THEN
      IF _needs_handling IS NOT TRUE THEN
        _pending_since := _message.created_at;
      END IF;
      _needs_handling := TRUE;
      _last_business_message_at := _message.created_at;
    ELSIF _message.handling_effect = 'staff_response' THEN
      _needs_handling := FALSE;
      _pending_since := NULL;
      _last_business_message_at := _message.created_at;
    END IF;
  END LOOP;

  UPDATE public.conversations
  SET needs_handling = _needs_handling,
      pending_since = _pending_since,
      last_business_message_at = _last_business_message_at,
      inactivity_expires_at = CASE
        WHEN _last_business_message_at IS NULL THEN NULL
        ELSE _last_business_message_at + interval '180 seconds'
      END,
      handling_next_sequence = COALESCE(_last_sequence, 0) + 1,
      last_handling_message_sequence = _last_sequence,
      handling_state_initialized = TRUE,
      handling_state_updated_at = clock_timestamp()
  WHERE id = _conversation_id;
END;
$$;

REVOKE ALL ON FUNCTION private.recompute_conversation_handling_shadow_locked(UUID)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.backfill_handling_shadow_batch(
  _limit INTEGER DEFAULT 100
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _effective_limit INTEGER := LEAST(GREATEST(COALESCE(_limit, 100), 1), 1000);
  _run private.handling_backfill_runs%ROWTYPE;
  _conversation RECORD;
  _initialized_count INTEGER := 0;
  _unresolved_count INTEGER;
  _remaining_count INTEGER;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();

  INSERT INTO private.handling_backfill_runs (requested_limit)
  VALUES (_effective_limit)
  RETURNING * INTO _run;

  FOR _conversation IN
    SELECT conversation.id
    FROM public.conversations conversation
    WHERE conversation.handling_state_initialized IS NOT TRUE
    ORDER BY conversation.id
    FOR UPDATE SKIP LOCKED
    LIMIT _effective_limit
  LOOP
    PERFORM private.initialize_conversation_handling_shadow_locked(_conversation.id);
    _initialized_count := _initialized_count + 1;
  END LOOP;

  SELECT count(*)::INTEGER
  INTO _unresolved_count
  FROM private.handling_reconciliation_issues issue
  WHERE issue.status = 'unresolved';

  SELECT count(*)::INTEGER
  INTO _remaining_count
  FROM public.conversations conversation
  WHERE conversation.handling_state_initialized IS NOT TRUE;

  UPDATE private.handling_backfill_runs
  SET completed_at = clock_timestamp(),
      initialized_count = _initialized_count,
      unresolved_count = _unresolved_count,
      status = 'completed'
  WHERE id = _run.id;

  RETURN jsonb_build_object(
    'run_id', _run.id,
    'initialized_count', _initialized_count,
    'unresolved_count', _unresolved_count,
    'remaining_count', _remaining_count
  );
END;
$$;

REVOKE ALL ON FUNCTION private.backfill_handling_shadow_batch(INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.resolve_handling_reconciliation_issue(
  _message_id UUID,
  _handling_effect TEXT,
  _handling_cycle_id UUID,
  _resolution TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _issue private.handling_reconciliation_issues%ROWTYPE;
  _message public.messages%ROWTYPE;
  _conversation public.conversations%ROWTYPE;
  _cycle public.conversation_handling_cycles%ROWTYPE;
  _classification RECORD;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();

  IF _handling_effect NOT IN ('client_request', 'staff_response', 'none') THEN
    RAISE EXCEPTION 'invalid_handling_effect_resolution';
  END IF;

  IF NULLIF(btrim(COALESCE(_resolution, '')), '') IS NULL THEN
    RAISE EXCEPTION 'handling_resolution_required';
  END IF;

  SELECT *
  INTO _issue
  FROM private.handling_reconciliation_issues issue
  WHERE issue.message_id = _message_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'unresolved_handling_issue_required';
  END IF;

  SELECT *
  INTO _message
  FROM public.messages message
  WHERE message.id = _message_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'message_not_found';
  END IF;

  IF _issue.conversation_id IS DISTINCT FROM _message.conversation_id THEN
    RAISE EXCEPTION 'handling_issue_conversation_mismatch';
  END IF;

  IF _issue.issue_kind IS DISTINCT FROM _message.handling_classification_reason THEN
    RAISE EXCEPTION 'handling_issue_kind_mismatch';
  END IF;

  IF _issue.status <> 'unresolved' THEN
    RAISE EXCEPTION 'unresolved_handling_issue_required';
  END IF;

  IF _issue.can_change_canonical_state IS NOT TRUE THEN
    RAISE EXCEPTION 'handling_issue_not_state_changing';
  END IF;

  SELECT *
  INTO _conversation
  FROM public.conversations conversation
  WHERE conversation.id = _message.conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  IF _handling_effect = 'staff_response' THEN
    IF _message.sender_type NOT IN (
      'operator'::public.sender_type,
      'admin'::public.sender_type
    ) THEN
      RAISE EXCEPTION 'staff_response_sender_invalid';
    END IF;

    IF _handling_cycle_id IS NULL THEN
      RAISE EXCEPTION 'handling_cycle_evidence_required';
    END IF;

    SELECT *
    INTO _cycle
    FROM public.conversation_handling_cycles cycle
    WHERE cycle.id = _handling_cycle_id
      AND cycle.conversation_id = _message.conversation_id
      AND cycle.operator_id = _message.operator_id
      AND cycle.started_at <= _message.created_at
      AND (cycle.ended_at IS NULL OR cycle.ended_at >= _message.created_at)
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'handling_cycle_evidence_invalid';
    END IF;
  ELSIF _handling_cycle_id IS NOT NULL THEN
    RAISE EXCEPTION 'handling_cycle_not_allowed_for_effect';
  END IF;

  SELECT *
  INTO _classification
  FROM private.classify_message_handling_effect(
    _message.conversation_id,
    _message.sender_type,
    _message.operator_id,
    _message.created_at
  );

  IF _handling_effect = 'client_request' THEN
    IF _message.sender_type <> 'client'::public.sender_type
       OR _message.sender_id IS DISTINCT FROM _conversation.client_id THEN
      RAISE EXCEPTION 'client_request_sender_invalid';
    END IF;

    IF _message.handling_effect <> 'unclassified'
       OR _classification.handling_effect <> 'client_request' THEN
      RAISE EXCEPTION 'client_request_evidence_invalid';
    END IF;
  ELSIF _handling_effect = 'staff_response' THEN
    IF _message.handling_effect <> 'unclassified'
       OR _classification.handling_effect <> 'staff_response'
       OR _classification.handling_cycle_id IS DISTINCT FROM _handling_cycle_id THEN
      RAISE EXCEPTION 'staff_response_evidence_invalid';
    END IF;
  ELSIF NOT (
    _classification.handling_effect = 'unclassified'
    OR (
      _classification.handling_effect = 'none'
      AND (
        _classification.issue_status = 'non_qualifying'
        OR _classification.classification_reason = 'system_non_business'
      )
    )
  ) THEN
    RAISE EXCEPTION 'none_resolution_not_allowed_for_qualifying_message';
  END IF;

  UPDATE public.messages
  SET handling_effect = _handling_effect,
      handling_cycle_id = _handling_cycle_id,
      handling_classification_reason = 'explicit_reconciliation',
      handling_classified_at = clock_timestamp()
  WHERE id = _message_id;

  UPDATE private.handling_reconciliation_issues
  SET status = CASE
        WHEN _handling_effect = 'none' THEN 'non_qualifying'
        ELSE 'resolved'
      END,
      can_change_canonical_state = FALSE,
      resolution = btrim(_resolution),
      evidence = evidence || jsonb_build_object(
        'resolution_source', 'explicit_reconciliation',
        'original_issue_kind', _issue.issue_kind,
        'original_handling_effect', _message.handling_effect,
        'original_handling_cycle_id', _message.handling_cycle_id,
        'original_classification_reason', _message.handling_classification_reason,
        'raw_handling_effect', _classification.handling_effect,
        'raw_handling_cycle_id', _classification.handling_cycle_id,
        'raw_classification_reason', _classification.classification_reason,
        'raw_issue_status', _classification.issue_status,
        'resolved_effect', _handling_effect,
        'resolved_cycle_id', _handling_cycle_id
      ),
      resolved_at = clock_timestamp()
  WHERE id = _issue.id;

  PERFORM private.recompute_conversation_handling_shadow_locked(_message.conversation_id);

  RETURN jsonb_build_object(
    'message_id', _message_id,
    'conversation_id', _message.conversation_id,
    'handling_effect', _handling_effect,
    'handling_cycle_id', _handling_cycle_id,
    'resolved', TRUE
  );
END;
$$;

REVOKE ALL ON FUNCTION private.resolve_handling_reconciliation_issue(
  UUID,
  TEXT,
  UUID,
  TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.record_message_handling_issue()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.acquire_handling_writer_barrier();

  IF NEW.handling_effect <> 'unclassified' THEN
    RETURN NEW;
  END IF;

  INSERT INTO private.handling_reconciliation_issues (
    conversation_id,
    message_id,
    issue_kind,
    status,
    can_change_canonical_state,
    evidence
  )
  VALUES (
    NEW.conversation_id,
    NEW.id,
    COALESCE(NEW.handling_classification_reason, 'unclassified_business_write'),
    'unresolved',
    TRUE,
    jsonb_build_object(
      'sender_type', NEW.sender_type,
      'operator_id', NEW.operator_id,
      'created_at', NEW.created_at,
      'handling_sequence', NEW.handling_sequence,
      'classification_source', 'legacy_shadow_writer'
    )
  )
  ON CONFLICT (message_id) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.record_message_handling_issue()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.get_message_handling_semantics()
RETURNS TABLE (
  message_id UUID,
  conversation_id UUID,
  handling_sequence BIGINT,
  created_at TIMESTAMPTZ,
  expected_handling_effect TEXT,
  expected_handling_cycle_id UUID,
  expected_classification_reason TEXT,
  metadata_complete BOOLEAN,
  semantic_consistent BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, private, pg_temp
AS $$
  WITH source AS (
    SELECT
      message.id AS message_id,
      message.conversation_id,
      message.sender_type,
      message.sender_id,
      message.operator_id,
      message.created_at,
      message.handling_sequence,
      message.handling_cycle_id,
      message.handling_effect,
      message.handling_metadata_version,
      message.handling_classification_reason,
      message.handling_classified_at,
      conversation.client_id,
      classification.handling_effect AS source_handling_effect,
      classification.handling_cycle_id AS source_handling_cycle_id,
      classification.classification_reason AS source_classification_reason,
      classification.issue_status AS source_issue_status,
      classification.can_change_canonical_state AS source_can_change_canonical_state,
      issue.message_id AS issue_message_id,
      issue.conversation_id AS issue_conversation_id,
      issue.issue_kind,
      issue.status AS issue_status,
      issue.can_change_canonical_state AS issue_can_change_canonical_state,
      issue.evidence AS issue_evidence,
      issue.resolution AS issue_resolution,
      issue.resolved_at AS issue_resolved_at
    FROM public.messages message
    JOIN public.conversations conversation
      ON conversation.id = message.conversation_id
    CROSS JOIN LATERAL private.classify_message_handling_effect(
      message.conversation_id,
      message.sender_type,
      message.operator_id,
      message.created_at
    ) classification
    LEFT JOIN private.handling_reconciliation_issues issue
      ON issue.message_id = message.id
  ),
  normalized AS (
    SELECT
      source.*,
      CASE
        WHEN source.issue_evidence->>'resolved_cycle_id'
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN (source.issue_evidence->>'resolved_cycle_id')::UUID
        ELSE NULL
      END AS resolved_cycle_id,
      CASE
        WHEN source.sender_type::TEXT = 'system' THEN TRUE
        WHEN source.sender_type = 'client'::public.sender_type THEN
          COALESCE(source.sender_id = source.client_id, FALSE)
          AND source.operator_id IS NULL
        WHEN source.sender_type = 'operator'::public.sender_type THEN
          EXISTS (
            SELECT 1
            FROM public.operators operator
            WHERE operator.user_id = source.sender_id
              AND (
                source.operator_id IS NULL
                OR operator.id = source.operator_id
              )
          )
        WHEN source.sender_type = 'admin'::public.sender_type THEN
          source.operator_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM public.operators operator
            WHERE operator.id = source.operator_id
              AND operator.user_id = source.sender_id
          )
        ELSE FALSE
      END AS sender_identity_consistent,
      CASE
        WHEN source.source_issue_status IS NULL THEN
          source.issue_message_id IS NULL
        ELSE
          COALESCE(
            source.issue_message_id = source.message_id
            AND source.issue_conversation_id = source.conversation_id
            AND source.issue_kind = source.source_classification_reason
            AND source.issue_status = source.source_issue_status
            AND source.issue_can_change_canonical_state
              IS NOT DISTINCT FROM source.source_can_change_canonical_state,
            FALSE
          )
      END AS source_issue_consistent
    FROM source
  ),
  resolved AS (
    SELECT
      normalized.*,
      (
        normalized.handling_classification_reason = 'explicit_reconciliation'
        AND normalized.sender_identity_consistent
        AND normalized.issue_message_id = normalized.message_id
        AND normalized.issue_conversation_id = normalized.conversation_id
        AND normalized.issue_evidence->>'resolution_source' = 'explicit_reconciliation'
        AND normalized.issue_kind = normalized.issue_evidence->>'original_issue_kind'
        AND normalized.issue_evidence->>'original_classification_reason'
          = normalized.issue_kind
        AND normalized.issue_evidence->>'original_handling_effect'
          IN ('unclassified', 'none')
        AND normalized.issue_status = CASE
          WHEN normalized.issue_evidence->>'resolved_effect' = 'none'
            THEN 'non_qualifying'
          ELSE 'resolved'
        END
        AND normalized.issue_can_change_canonical_state IS FALSE
        AND normalized.issue_resolved_at IS NOT NULL
        AND NULLIF(btrim(COALESCE(normalized.issue_resolution, '')), '') IS NOT NULL
        AND normalized.issue_evidence->>'resolved_effect'
          IN ('client_request', 'staff_response', 'none')
        AND (
          (
            normalized.issue_evidence->>'resolved_effect' = 'client_request'
            AND normalized.sender_type = 'client'::public.sender_type
            AND normalized.resolved_cycle_id IS NULL
            AND normalized.source_handling_effect = 'client_request'
          )
          OR (
            normalized.issue_evidence->>'resolved_effect' = 'staff_response'
            AND normalized.sender_type IN (
              'operator'::public.sender_type,
              'admin'::public.sender_type
            )
            AND normalized.resolved_cycle_id IS NOT NULL
            AND normalized.source_handling_effect = 'staff_response'
            AND normalized.source_handling_cycle_id = normalized.resolved_cycle_id
            AND EXISTS (
              SELECT 1
              FROM public.conversation_handling_cycles cycle
              WHERE cycle.id = normalized.resolved_cycle_id
                AND cycle.conversation_id = normalized.conversation_id
                AND cycle.operator_id = normalized.operator_id
                AND cycle.started_at <= normalized.created_at
                AND (cycle.ended_at IS NULL OR cycle.ended_at >= normalized.created_at)
            )
          )
          OR (
            normalized.issue_evidence->>'resolved_effect' = 'none'
            AND normalized.resolved_cycle_id IS NULL
            AND (
              normalized.issue_evidence->>'raw_handling_effect' = 'unclassified'
              OR (
                normalized.issue_evidence->>'raw_handling_effect' = 'none'
                AND (
                  normalized.issue_evidence->>'raw_issue_status' = 'non_qualifying'
                  OR normalized.issue_evidence->>'raw_classification_reason'
                    = 'system_non_business'
                )
              )
            )
          )
        )
      ) AS explicit_resolution_consistent
    FROM normalized
  ),
  expected AS (
    SELECT
      resolved.*,
      CASE
        WHEN resolved.sender_type = 'client'::public.sender_type
         AND resolved.sender_id = resolved.client_id
          THEN resolved.source_handling_effect
        WHEN resolved.sender_identity_consistent IS NOT TRUE
          THEN 'unclassified'
        WHEN resolved.explicit_resolution_consistent
          THEN resolved.issue_evidence->>'resolved_effect'
        ELSE resolved.source_handling_effect
      END AS computed_handling_effect,
      CASE
        WHEN resolved.sender_type = 'client'::public.sender_type
         AND resolved.sender_id = resolved.client_id
          THEN resolved.source_handling_cycle_id
        WHEN resolved.sender_identity_consistent IS NOT TRUE
          THEN NULL::UUID
        WHEN resolved.explicit_resolution_consistent
          THEN resolved.resolved_cycle_id
        ELSE resolved.source_handling_cycle_id
      END AS computed_handling_cycle_id,
      CASE
        WHEN resolved.sender_type = 'client'::public.sender_type
         AND resolved.sender_id = resolved.client_id
          THEN resolved.source_classification_reason
        WHEN resolved.sender_identity_consistent IS NOT TRUE
          THEN 'sender_identity_mismatch'
        WHEN resolved.explicit_resolution_consistent
          THEN 'explicit_reconciliation'
        ELSE resolved.source_classification_reason
      END AS computed_classification_reason
    FROM resolved
  )
  SELECT
    expected.message_id,
    expected.conversation_id,
    expected.handling_sequence,
    expected.created_at,
    expected.computed_handling_effect,
    expected.computed_handling_cycle_id,
    expected.computed_classification_reason,
    (
      expected.handling_sequence IS NOT NULL
      AND expected.handling_sequence > 0
      AND expected.handling_effect IS NOT NULL
      AND expected.handling_metadata_version IS NOT NULL
      AND expected.handling_classification_reason IS NOT NULL
      AND expected.handling_classified_at IS NOT NULL
      AND (
        (
          expected.handling_classification_reason = 'explicit_reconciliation'
          AND expected.explicit_resolution_consistent
        )
        OR (
          expected.handling_classification_reason <> 'explicit_reconciliation'
          AND expected.source_issue_consistent
        )
      )
    ) AS metadata_complete,
    (
      COALESCE(expected.sender_identity_consistent, FALSE)
      AND expected.handling_effect IS NOT DISTINCT FROM expected.computed_handling_effect
      AND expected.handling_cycle_id IS NOT DISTINCT FROM expected.computed_handling_cycle_id
      AND expected.handling_classification_reason
        IS NOT DISTINCT FROM expected.computed_classification_reason
      AND (
        (
          expected.handling_classification_reason = 'explicit_reconciliation'
          AND expected.explicit_resolution_consistent
        )
        OR (
          expected.handling_classification_reason <> 'explicit_reconciliation'
          AND expected.source_issue_consistent
        )
      )
    ) AS semantic_consistent
  FROM expected;
$$;

REVOKE ALL ON FUNCTION private.get_message_handling_semantics()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.get_handling_shadow_reconciliation()
RETURNS TABLE (
  conversation_id UUID,
  expected_needs_handling BOOLEAN,
  expected_pending_since TIMESTAMPTZ,
  expected_last_business_message_at TIMESTAMPTZ,
  message_count BIGINT,
  max_handling_sequence BIGINT,
  metadata_complete BOOLEAN,
  semantic_consistent BOOLEAN,
  sequence_consistent BOOLEAN,
  projection_consistent BOOLEAN,
  active_cycle_projection_consistent BOOLEAN,
  closed_projection_consistent BOOLEAN,
  shadow_consistent BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, private, pg_temp
AS $$
  WITH message_rollup AS (
    SELECT
      conversation.id AS conversation_id,
      count(semantics.message_id) AS message_count,
      count(semantics.handling_sequence) AS sequenced_count,
      count(DISTINCT semantics.handling_sequence) AS distinct_sequence_count,
      max(semantics.handling_sequence) AS max_sequence,
      bool_and(
        semantics.message_id IS NULL
        OR semantics.handling_sequence > 0
      ) AS sequences_positive,
      max(semantics.handling_sequence)
        FILTER (
          WHERE semantics.expected_handling_effect = 'staff_response'
        ) AS last_staff_sequence,
      bool_and(
        semantics.message_id IS NULL
        OR semantics.metadata_complete
      ) AS metadata_complete,
      bool_and(
        semantics.message_id IS NULL
        OR semantics.semantic_consistent
      ) AS semantic_consistent
    FROM public.conversations conversation
    LEFT JOIN private.get_message_handling_semantics() semantics
      ON semantics.conversation_id = conversation.id
    GROUP BY conversation.id
  ),
  expected AS (
    SELECT
      rollup.*,
      COALESCE(last_business.handling_effect = 'client_request', FALSE)
        AS expected_needs_handling,
      CASE
        WHEN last_business.handling_effect = 'client_request'
          THEN first_pending.created_at
        ELSE NULL
      END AS expected_pending_since,
      last_business.created_at AS expected_last_business_message_at
    FROM message_rollup rollup
    LEFT JOIN LATERAL (
      SELECT
        semantics.expected_handling_effect AS handling_effect,
        semantics.created_at
      FROM private.get_message_handling_semantics() semantics
      WHERE semantics.conversation_id = rollup.conversation_id
        AND semantics.expected_handling_effect IN (
          'client_request',
          'staff_response'
        )
      ORDER BY semantics.handling_sequence DESC, semantics.message_id DESC
      LIMIT 1
    ) last_business ON TRUE
    LEFT JOIN LATERAL (
      SELECT semantics.created_at
      FROM private.get_message_handling_semantics() semantics
      WHERE semantics.conversation_id = rollup.conversation_id
        AND semantics.expected_handling_effect = 'client_request'
        AND semantics.handling_sequence > COALESCE(rollup.last_staff_sequence, 0)
      ORDER BY semantics.handling_sequence, semantics.message_id
      LIMIT 1
    ) first_pending ON last_business.handling_effect = 'client_request'
  ),
  evaluated AS (
    SELECT
      conversation.id AS conversation_id,
      expected.expected_needs_handling,
      expected.expected_pending_since,
      expected.expected_last_business_message_at,
      expected.message_count,
      expected.max_sequence,
      expected.metadata_complete,
      expected.semantic_consistent,
      (
        expected.sequenced_count = expected.message_count
        AND expected.distinct_sequence_count = expected.message_count
        AND expected.sequences_positive
      ) AS sequence_consistent,
      (
        conversation.handling_state_initialized IS TRUE
        AND conversation.needs_handling IS NOT DISTINCT FROM expected.expected_needs_handling
        AND conversation.pending_since IS NOT DISTINCT FROM expected.expected_pending_since
        AND conversation.last_business_message_at
          IS NOT DISTINCT FROM expected.expected_last_business_message_at
        AND conversation.inactivity_expires_at IS NOT DISTINCT FROM
          CASE
            WHEN expected.expected_last_business_message_at IS NULL THEN NULL
            ELSE expected.expected_last_business_message_at + interval '180 seconds'
          END
        AND conversation.handling_next_sequence > COALESCE(expected.max_sequence, 0)
        AND conversation.last_handling_message_sequence
          IS NOT DISTINCT FROM expected.max_sequence
      ) AS projection_consistent,
      (
        (
          SELECT count(*)
          FROM public.conversation_handling_cycles cycle
          WHERE cycle.conversation_id = conversation.id
            AND cycle.ended_at IS NULL
        ) <= 1
        AND NOT EXISTS (
          SELECT 1
          FROM public.conversation_handling_cycles cycle
          LEFT JOIN public.conversation_work_items work_item
            ON work_item.id = cycle.work_item_id
          WHERE cycle.conversation_id = conversation.id
            AND cycle.ended_at IS NULL
            AND (
              work_item.id IS NULL
              OR work_item.conversation_id IS DISTINCT FROM conversation.id
              OR work_item.responsible_operator_id IS DISTINCT FROM cycle.operator_id
              OR work_item.status NOT IN ('assigned', 'in_progress')
              OR conversation.assigned_operator_id IS DISTINCT FROM cycle.operator_id
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.conversation_work_items work_item
          WHERE work_item.conversation_id = conversation.id
            AND work_item.status IN ('assigned', 'in_progress')
            AND NOT EXISTS (
              SELECT 1
              FROM public.conversation_handling_cycles cycle
              WHERE cycle.work_item_id = work_item.id
                AND cycle.conversation_id = conversation.id
                AND cycle.operator_id = work_item.responsible_operator_id
                AND cycle.ended_at IS NULL
            )
        )
      ) AS active_cycle_projection_consistent,
      (
        conversation.status <> 'closed'::public.conversation_status
        OR NOT EXISTS (
          SELECT 1
          FROM public.conversation_work_items work_item
          WHERE work_item.conversation_id = conversation.id
            AND work_item.status IN ('new', 'assigned', 'in_progress')
        )
      ) AS closed_projection_consistent
    FROM public.conversations conversation
    JOIN expected ON expected.conversation_id = conversation.id
  )
  SELECT
    evaluated.conversation_id,
    evaluated.expected_needs_handling,
    evaluated.expected_pending_since,
    evaluated.expected_last_business_message_at,
    evaluated.message_count,
    evaluated.max_sequence,
    evaluated.metadata_complete,
    evaluated.semantic_consistent,
    evaluated.sequence_consistent,
    evaluated.projection_consistent,
    evaluated.active_cycle_projection_consistent,
    evaluated.closed_projection_consistent,
    evaluated.metadata_complete
      AND evaluated.semantic_consistent
      AND evaluated.sequence_consistent
      AND evaluated.projection_consistent
      AND evaluated.active_cycle_projection_consistent
      AND evaluated.closed_projection_consistent
  FROM evaluated;
$$;

REVOKE ALL ON FUNCTION private.get_handling_shadow_reconciliation()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION private.get_handling_shadow_reconciliation() IS
  'Read-only WP01 message fold and projection reconciliation. It performs no repair.';

CREATE OR REPLACE FUNCTION private.get_handling_cutover_readiness()
RETURNS TABLE (
  mode TEXT,
  unresolved_fallback_no_cycle_writes BIGINT,
  unresolved_state_changing_effects BIGINT,
  post_deploy_business_writes_missing_metadata BIGINT,
  uninitialized_conversations BIGINT,
  inconsistent_conversations BIGINT,
  shadow_consistent BOOLEAN,
  cutover_authorized BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, private, pg_temp
AS $$
  WITH runtime AS (
    SELECT contract.mode, contract.compatibility_deployed_at
    FROM private.handling_contract_runtime contract
    WHERE contract.singleton = TRUE
  ),
  fallback_blockers AS (
    SELECT message.id AS message_id
    FROM public.messages message
    WHERE message.handling_effect = 'unclassified'
      AND message.handling_classification_reason IN (
        'fallback_no_active_cycle',
        'admin_without_takeover_evidence'
      )

    UNION

    SELECT semantics.message_id
    FROM private.get_message_handling_semantics() semantics
    WHERE semantics.expected_handling_effect = 'unclassified'
      AND semantics.expected_classification_reason IN (
        'fallback_no_active_cycle',
        'admin_without_takeover_evidence'
      )

    UNION

    SELECT issue.message_id
    FROM private.handling_reconciliation_issues issue
    WHERE issue.status = 'unresolved'
      AND issue.issue_kind IN (
        'fallback_no_active_cycle',
        'admin_without_takeover_evidence'
      )
  ),
  state_changing_blockers AS (
    SELECT message.id AS message_id
    FROM public.messages message
    WHERE message.handling_effect = 'unclassified'

    UNION

    SELECT semantics.message_id
    FROM private.get_message_handling_semantics() semantics
    WHERE semantics.expected_handling_effect = 'unclassified'

    UNION

    SELECT issue.message_id
    FROM private.handling_reconciliation_issues issue
    WHERE issue.status = 'unresolved'
      AND issue.can_change_canonical_state IS TRUE
  ),
  counts AS (
    SELECT
      (
        SELECT count(DISTINCT blocker.message_id)
        FROM fallback_blockers blocker
      ) AS fallback_count,
      (
        SELECT count(DISTINCT blocker.message_id)
        FROM state_changing_blockers blocker
      ) AS state_changing_count,
      (
        SELECT count(*)
        FROM public.messages message
        CROSS JOIN runtime
        WHERE message.created_at >= runtime.compatibility_deployed_at
          AND message.sender_type IN (
            'client'::public.sender_type,
            'operator'::public.sender_type,
            'admin'::public.sender_type
          )
          AND (
            message.handling_sequence IS NULL
            OR message.handling_effect IS NULL
            OR message.handling_metadata_version IS NULL
            OR message.handling_classification_reason IS NULL
            OR message.handling_classified_at IS NULL
          )
      ) AS missing_metadata_count,
      (
        SELECT count(*)
        FROM public.conversations conversation
        WHERE conversation.handling_state_initialized IS NOT TRUE
      ) AS uninitialized_count,
      (
        SELECT count(*)
        FROM private.get_handling_shadow_reconciliation() reconciliation
        WHERE reconciliation.shadow_consistent IS NOT TRUE
      ) AS inconsistent_count
  )
  SELECT
    runtime.mode,
    counts.fallback_count,
    counts.state_changing_count,
    counts.missing_metadata_count,
    counts.uninitialized_count,
    counts.inconsistent_count,
    counts.fallback_count = 0
      AND counts.state_changing_count = 0
      AND counts.missing_metadata_count = 0
      AND counts.uninitialized_count = 0
      AND counts.inconsistent_count = 0 AS shadow_consistent,
    FALSE AS cutover_authorized
  FROM runtime
  CROSS JOIN counts;
$$;

REVOKE ALL ON FUNCTION private.get_handling_cutover_readiness()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION private.get_handling_cutover_readiness() IS
  'Read-only WP01 readiness evidence. cutover_authorized is always false.';

NOTIFY pgrst, 'reload schema';
