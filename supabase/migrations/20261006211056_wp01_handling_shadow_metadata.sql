-- WP01.2: add canonical-shaped handling metadata in legacy-shadow mode.
-- The legacy work-item and first-response triggers remain active. These fields
-- are observational until a separately approved cutover changes the mode.

ALTER TYPE public.sender_type ADD VALUE IF NOT EXISTS 'system';

CREATE TABLE private.handling_contract_runtime (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  mode TEXT NOT NULL DEFAULT 'legacy_shadow'
    CHECK (mode IN ('legacy_shadow', 'canonical')),
  compatibility_deployed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  cutover_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (mode = 'legacy_shadow' AND cutover_at IS NULL)
    OR (mode = 'canonical' AND cutover_at IS NOT NULL)
  )
);

INSERT INTO private.handling_contract_runtime (singleton, mode)
VALUES (TRUE, 'legacy_shadow')
ON CONFLICT (singleton) DO NOTHING;

REVOKE ALL ON TABLE private.handling_contract_runtime
  FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.conversations
  ADD COLUMN needs_handling BOOLEAN,
  ADD COLUMN pending_since TIMESTAMPTZ,
  ADD COLUMN last_business_message_at TIMESTAMPTZ,
  ADD COLUMN inactivity_expires_at TIMESTAMPTZ,
  ADD COLUMN handling_next_sequence BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN last_handling_message_sequence BIGINT,
  ADD COLUMN handling_state_initialized BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN handling_state_updated_at TIMESTAMPTZ;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_handling_next_sequence_check
    CHECK (handling_next_sequence > 0),
  ADD CONSTRAINT conversations_handling_pending_state_check
    CHECK (
      needs_handling IS DISTINCT FROM FALSE
      OR pending_since IS NULL
    ) NOT VALID,
  ADD CONSTRAINT conversations_handling_inactivity_order_check
    CHECK (
      inactivity_expires_at IS NULL
      OR last_business_message_at IS NULL
      OR inactivity_expires_at >= last_business_message_at
    ) NOT VALID;

ALTER TABLE public.messages
  ADD COLUMN handling_sequence BIGINT,
  ADD COLUMN handling_cycle_id UUID
    REFERENCES public.conversation_handling_cycles(id) ON DELETE SET NULL,
  ADD COLUMN handling_effect TEXT,
  ADD COLUMN handling_metadata_version SMALLINT,
  ADD COLUMN handling_classification_reason TEXT,
  ADD COLUMN handling_classified_at TIMESTAMPTZ;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_handling_sequence_check
    CHECK (handling_sequence IS NULL OR handling_sequence > 0) NOT VALID,
  ADD CONSTRAINT messages_handling_effect_check
    CHECK (
      handling_effect IS NULL
      OR handling_effect IN ('client_request', 'staff_response', 'none', 'unclassified')
    ) NOT VALID,
  ADD CONSTRAINT messages_handling_metadata_version_check
    CHECK (handling_metadata_version IS NULL OR handling_metadata_version > 0) NOT VALID;

CREATE UNIQUE INDEX messages_conversation_handling_sequence_idx
  ON public.messages (conversation_id, handling_sequence)
  WHERE handling_sequence IS NOT NULL;

CREATE INDEX messages_handling_cycle_id_idx
  ON public.messages (handling_cycle_id)
  WHERE handling_cycle_id IS NOT NULL;

CREATE INDEX messages_unclassified_handling_idx
  ON public.messages (conversation_id, created_at, id)
  WHERE handling_effect = 'unclassified';

CREATE TABLE private.handling_reconciliation_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL
    REFERENCES public.conversations(id) ON DELETE CASCADE,
  message_id UUID NOT NULL UNIQUE
    REFERENCES public.messages(id) ON DELETE CASCADE,
  issue_kind TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('unresolved', 'resolved', 'non_qualifying')),
  can_change_canonical_state BOOLEAN NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  resolved_at TIMESTAMPTZ,
  CHECK (
    (status = 'unresolved' AND resolved_at IS NULL)
    OR (status <> 'unresolved' AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX handling_reconciliation_issues_status_idx
  ON private.handling_reconciliation_issues (status, can_change_canonical_state, created_at);

REVOKE ALL ON TABLE private.handling_reconciliation_issues
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.classify_message_handling_effect(
  _conversation_id UUID,
  _sender_type public.sender_type,
  _operator_id UUID,
  _created_at TIMESTAMPTZ
)
RETURNS TABLE (
  handling_effect TEXT,
  handling_cycle_id UUID,
  classification_reason TEXT,
  issue_status TEXT,
  can_change_canonical_state BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _cycle_id UUID;
  _compatibility_deployed_at TIMESTAMPTZ;
BEGIN
  IF _sender_type::TEXT = 'system' THEN
    RETURN QUERY SELECT
      'none'::TEXT,
      NULL::UUID,
      'system_non_business'::TEXT,
      NULL::TEXT,
      FALSE;
    RETURN;
  END IF;

  IF _sender_type = 'client'::public.sender_type THEN
    RETURN QUERY SELECT
      'client_request'::TEXT,
      NULL::UUID,
      'client_business_message'::TEXT,
      NULL::TEXT,
      FALSE;
    RETURN;
  END IF;

  SELECT cycle.id
  INTO _cycle_id
  FROM public.conversation_handling_cycles cycle
  WHERE cycle.conversation_id = _conversation_id
    AND cycle.operator_id = _operator_id
    AND cycle.started_at <= _created_at
    AND (cycle.ended_at IS NULL OR cycle.ended_at >= _created_at)
  ORDER BY cycle.started_at DESC, cycle.id DESC
  LIMIT 1;

  IF _cycle_id IS NOT NULL THEN
    RETURN QUERY SELECT
      'staff_response'::TEXT,
      _cycle_id,
      'active_cycle_owner'::TEXT,
      NULL::TEXT,
      FALSE;
    RETURN;
  END IF;

  SELECT runtime.compatibility_deployed_at
  INTO _compatibility_deployed_at
  FROM private.handling_contract_runtime runtime
  WHERE runtime.singleton = TRUE;

  IF _sender_type = 'operator'::public.sender_type
     AND _created_at < _compatibility_deployed_at THEN
    RETURN QUERY SELECT
      'none'::TEXT,
      NULL::UUID,
      'historical_operator_no_cycle_non_qualifying'::TEXT,
      'non_qualifying'::TEXT,
      FALSE;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    'unclassified'::TEXT,
    NULL::UUID,
    CASE
      WHEN _sender_type = 'admin'::public.sender_type
        THEN 'admin_without_takeover_evidence'
      ELSE 'fallback_no_active_cycle'
    END,
    'unresolved'::TEXT,
    TRUE;
END;
$$;

REVOKE ALL ON FUNCTION private.classify_message_handling_effect(
  UUID,
  public.sender_type,
  UUID,
  TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.initialize_conversation_handling_shadow_locked(
  _conversation_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _conversation public.conversations%ROWTYPE;
  _message public.messages%ROWTYPE;
  _classification RECORD;
  _sequence BIGINT := 0;
  _needs_handling BOOLEAN := FALSE;
  _pending_since TIMESTAMPTZ;
  _last_business_message_at TIMESTAMPTZ;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();

  SELECT *
  INTO _conversation
  FROM public.conversations conversation
  WHERE conversation.id = _conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  IF _conversation.handling_state_initialized THEN
    RETURN;
  END IF;

  FOR _message IN
    SELECT message.*
    FROM public.messages message
    WHERE message.conversation_id = _conversation_id
    ORDER BY message.created_at, message.id
  LOOP
    _sequence := _sequence + 1;

    SELECT *
    INTO _classification
    FROM private.classify_message_handling_effect(
      _conversation_id,
      _message.sender_type,
      _message.operator_id,
      _message.created_at
    );

    UPDATE public.messages
    SET handling_sequence = _sequence,
        handling_cycle_id = _classification.handling_cycle_id,
        handling_effect = _classification.handling_effect,
        handling_metadata_version = 1,
        handling_classification_reason = _classification.classification_reason,
        handling_classified_at = clock_timestamp()
    WHERE id = _message.id;

    IF _classification.issue_status IS NOT NULL THEN
      INSERT INTO private.handling_reconciliation_issues (
        conversation_id,
        message_id,
        issue_kind,
        status,
        can_change_canonical_state,
        evidence,
        resolved_at
      )
      VALUES (
        _conversation_id,
        _message.id,
        _classification.classification_reason,
        _classification.issue_status,
        _classification.can_change_canonical_state,
        jsonb_build_object(
          'sender_type', _message.sender_type,
          'operator_id', _message.operator_id,
          'created_at', _message.created_at,
          'classification_source', 'historical_backfill'
        ),
        CASE
          WHEN _classification.issue_status = 'unresolved' THEN NULL
          ELSE clock_timestamp()
        END
      )
      ON CONFLICT (message_id) DO UPDATE SET
        issue_kind = EXCLUDED.issue_kind,
        status = EXCLUDED.status,
        can_change_canonical_state = EXCLUDED.can_change_canonical_state,
        evidence = EXCLUDED.evidence,
        resolved_at = EXCLUDED.resolved_at;
    END IF;

    IF _classification.handling_effect = 'client_request' THEN
      IF _needs_handling IS NOT TRUE THEN
        _pending_since := _message.created_at;
      END IF;
      _needs_handling := TRUE;
      _last_business_message_at := _message.created_at;
    ELSIF _classification.handling_effect = 'staff_response' THEN
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
      handling_next_sequence = _sequence + 1,
      last_handling_message_sequence = NULLIF(_sequence, 0),
      handling_state_initialized = TRUE,
      handling_state_updated_at = clock_timestamp()
  WHERE id = _conversation_id;
END;
$$;

REVOKE ALL ON FUNCTION private.initialize_conversation_handling_shadow_locked(UUID)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.prepare_message_handling_shadow()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _conversation public.conversations%ROWTYPE;
  _classification RECORD;
  _mode TEXT;
  _event_at TIMESTAMPTZ := COALESCE(NEW.created_at, clock_timestamp());
BEGIN
  PERFORM private.acquire_handling_writer_barrier();

  SELECT *
  INTO _conversation
  FROM public.conversations conversation
  WHERE conversation.id = NEW.conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  IF _conversation.handling_state_initialized IS NOT TRUE THEN
    PERFORM private.initialize_conversation_handling_shadow_locked(NEW.conversation_id);

    SELECT *
    INTO _conversation
    FROM public.conversations conversation
    WHERE conversation.id = NEW.conversation_id;
  END IF;

  SELECT runtime.mode
  INTO _mode
  FROM private.handling_contract_runtime runtime
  WHERE runtime.singleton = TRUE;

  SELECT *
  INTO _classification
  FROM private.classify_message_handling_effect(
    NEW.conversation_id,
    NEW.sender_type,
    NEW.operator_id,
    _event_at
  );

  IF _mode = 'canonical'
     AND _classification.handling_effect = 'unclassified' THEN
    RAISE EXCEPTION 'handling_classification_required';
  END IF;

  NEW.handling_sequence := _conversation.handling_next_sequence;
  NEW.handling_cycle_id := _classification.handling_cycle_id;
  NEW.handling_effect := _classification.handling_effect;
  NEW.handling_metadata_version := 1;
  NEW.handling_classification_reason := _classification.classification_reason;
  NEW.handling_classified_at := clock_timestamp();

  UPDATE public.conversations
  SET handling_next_sequence = _conversation.handling_next_sequence + 1,
      last_handling_message_sequence = _conversation.handling_next_sequence,
      needs_handling = CASE
        WHEN _classification.handling_effect = 'client_request' THEN TRUE
        WHEN _classification.handling_effect = 'staff_response' THEN FALSE
        ELSE needs_handling
      END,
      pending_since = CASE
        WHEN _classification.handling_effect = 'client_request'
          THEN CASE
            WHEN needs_handling IS TRUE THEN pending_since
            ELSE _event_at
          END
        WHEN _classification.handling_effect = 'staff_response' THEN NULL
        ELSE pending_since
      END,
      last_business_message_at = CASE
        WHEN _classification.handling_effect IN ('client_request', 'staff_response')
          THEN _event_at
        ELSE last_business_message_at
      END,
      inactivity_expires_at = CASE
        WHEN _classification.handling_effect IN ('client_request', 'staff_response')
          THEN _event_at + interval '180 seconds'
        ELSE inactivity_expires_at
      END,
      handling_state_updated_at = clock_timestamp()
  WHERE id = NEW.conversation_id;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.prepare_message_handling_shadow()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.record_message_handling_issue()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
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

DROP TRIGGER IF EXISTS prepare_message_handling_shadow ON public.messages;
CREATE TRIGGER prepare_message_handling_shadow
  BEFORE INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION private.prepare_message_handling_shadow();

DROP TRIGGER IF EXISTS record_message_handling_issue ON public.messages;
CREATE TRIGGER record_message_handling_issue
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION private.record_message_handling_issue();

NOTIFY pgrst, 'reload schema';
