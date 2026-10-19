-- WP01.4: strict cycle-bound operator sends. This remains legacy_shadow.

SELECT private.acquire_handling_cutover_barrier();

ALTER TABLE private.handling_contract_runtime
  ADD COLUMN IF NOT EXISTS strict_send_deployed_at timestamptz;

UPDATE private.handling_contract_runtime
SET strict_send_deployed_at = coalesce(strict_send_deployed_at, clock_timestamp()),
    updated_at = clock_timestamp()
WHERE singleton = true;

CREATE TABLE IF NOT EXISTS private.handling_send_authority_evidence (
  message_id uuid PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  handling_cycle_id uuid NOT NULL REFERENCES public.conversation_handling_cycles(id) ON DELETE RESTRICT,
  operator_id uuid NOT NULL REFERENCES public.operators(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  authority_source text NOT NULL CHECK (authority_source IN ('cycle_token', 'atomic_claim_and_send')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS handling_send_authority_evidence_conversation_idx
  ON private.handling_send_authority_evidence (conversation_id, handling_cycle_id);

REVOKE ALL ON TABLE private.handling_send_authority_evidence
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.acquire_operator_send_authority(
  _conversation_id uuid,
  _expected_cycle_id uuid
)
RETURNS TABLE(
  operator_id uuid,
  user_id uuid,
  handling_cycle_id uuid,
  work_item_id uuid,
  authority_source text,
  claimed_now boolean,
  concurrency_mode text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _guard record;
  _conversation public.conversations%ROWTYPE;
  _cycle public.conversation_handling_cycles%ROWTYPE;
  _work_item public.conversation_work_items%ROWTYPE;
  _active_work_item_count integer;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF public.is_admin() IS TRUE THEN RAISE EXCEPTION 'admin_takeover_required'; END IF;

  SELECT * INTO _guard
  FROM private.assert_operator_can_send_base(_conversation_id);

  SELECT * INTO _conversation
  FROM public.conversations conversation
  WHERE conversation.id = _conversation_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.operator_client_blocks block
    WHERE block.operator_id = _guard.operator_id AND block.client_id = _conversation.client_id
  ) THEN RAISE EXCEPTION 'client_blocked_by_operator'; END IF;

  SELECT * INTO _cycle
  FROM public.conversation_handling_cycles cycle
  WHERE cycle.conversation_id = _conversation_id AND cycle.ended_at IS NULL
  FOR UPDATE;

  IF FOUND THEN
    IF _expected_cycle_id IS NULL OR _expected_cycle_id IS DISTINCT FROM _cycle.id THEN
      RAISE EXCEPTION 'handling_cycle_token_invalid';
    END IF;
    IF _cycle.operator_id IS DISTINCT FROM _guard.operator_id THEN
      RAISE EXCEPTION 'conversation_not_responsible_operator';
    END IF;
    SELECT * INTO _work_item FROM public.conversation_work_items work_item
    WHERE work_item.id = _cycle.work_item_id FOR UPDATE;
    IF NOT FOUND
      OR _work_item.conversation_id IS DISTINCT FROM _conversation_id
      OR _work_item.responsible_operator_id IS DISTINCT FROM _guard.operator_id
      OR _work_item.status NOT IN ('assigned', 'in_progress')
      OR _conversation.assigned_operator_id IS DISTINCT FROM _guard.operator_id
    THEN RAISE EXCEPTION 'conversation_claim_state_inconsistent'; END IF;

    RETURN QUERY SELECT _guard.operator_id, _guard.user_id, _cycle.id, _work_item.id,
      'cycle_token'::text, false, _guard.concurrency_mode;
    RETURN;
  END IF;

  IF _expected_cycle_id IS NOT NULL THEN RAISE EXCEPTION 'handling_cycle_token_invalid'; END IF;

  -- Preserve the established lock-mode check before an atomic first claim.
  PERFORM private.assert_operator_can_send_conversation_message(_conversation_id);

  SELECT count(*)::integer INTO _active_work_item_count
  FROM public.conversation_work_items work_item
  WHERE work_item.conversation_id = _conversation_id
    AND work_item.status IN ('new', 'assigned', 'in_progress');
  IF _active_work_item_count > 1 THEN RAISE EXCEPTION 'conversation_claim_state_inconsistent'; END IF;

  SELECT * INTO _work_item FROM public.conversation_work_items work_item
  WHERE work_item.conversation_id = _conversation_id
    AND work_item.status IN ('new', 'assigned', 'in_progress')
  FOR UPDATE;

  IF FOUND THEN
    IF _work_item.status <> 'new' OR _work_item.responsible_operator_id IS NOT NULL OR _work_item.assigned_at IS NOT NULL THEN
      RAISE EXCEPTION 'conversation_claim_state_inconsistent';
    END IF;
    UPDATE public.conversation_work_items
    SET status = 'assigned', responsible_operator_id = _guard.operator_id,
        assigned_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE id = _work_item.id
    RETURNING * INTO _work_item;
  ELSE
    INSERT INTO public.conversation_work_items (
      conversation_id, client_id, character_id, status, responsible_operator_id, assigned_at, last_activity_at
    ) VALUES (
      _conversation_id, _conversation.client_id, _conversation.character_id,
      'assigned', _guard.operator_id, clock_timestamp(), clock_timestamp()
    ) RETURNING * INTO _work_item;
  END IF;

  UPDATE public.conversations SET assigned_operator_id = _guard.operator_id
  WHERE id = _conversation_id AND assigned_operator_id IS DISTINCT FROM _guard.operator_id;

  INSERT INTO public.conversation_handling_cycles (conversation_id, work_item_id, operator_id)
  VALUES (_conversation_id, _work_item.id, _guard.operator_id)
  RETURNING * INTO _cycle;

  RETURN QUERY SELECT _guard.operator_id, _guard.user_id, _cycle.id, _work_item.id,
    'atomic_claim_and_send'::text, true, _guard.concurrency_mode;
END;
$$;

REVOKE ALL ON FUNCTION private.acquire_operator_send_authority(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.record_operator_send_authority_evidence(
  _message_id uuid, _conversation_id uuid, _authority_operator_id uuid,
  _authority_user_id uuid, _handling_cycle_id uuid, _authority_source text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _message public.messages%ROWTYPE;
  _cycle public.conversation_handling_cycles%ROWTYPE;
BEGIN
  SELECT * INTO _message FROM public.messages message WHERE message.id = _message_id FOR KEY SHARE;
  SELECT * INTO _cycle FROM public.conversation_handling_cycles cycle WHERE cycle.id = _handling_cycle_id FOR KEY SHARE;
  IF NOT FOUND OR _message.conversation_id IS DISTINCT FROM _conversation_id
    OR _message.operator_id IS DISTINCT FROM _authority_operator_id
    OR _message.handling_cycle_id IS DISTINCT FROM _handling_cycle_id
    OR _message.handling_effect IS DISTINCT FROM 'staff_response'
    OR _cycle.conversation_id IS DISTINCT FROM _conversation_id
    OR _cycle.operator_id IS DISTINCT FROM _authority_operator_id
    OR _message.created_at < _cycle.started_at
    OR (_cycle.ended_at IS NOT NULL AND _message.created_at > _cycle.ended_at)
  THEN RAISE EXCEPTION 'handling_send_authority_evidence_invalid'; END IF;

  INSERT INTO private.handling_send_authority_evidence (
    message_id, conversation_id, handling_cycle_id, operator_id, actor_user_id, authority_source
  ) VALUES (
    _message_id, _conversation_id, _handling_cycle_id, _authority_operator_id, _authority_user_id, _authority_source
  ) ON CONFLICT (message_id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1 FROM private.handling_send_authority_evidence evidence
    WHERE evidence.message_id = _message_id AND evidence.conversation_id = _conversation_id
      AND evidence.handling_cycle_id = _handling_cycle_id AND evidence.operator_id = _authority_operator_id
      AND evidence.actor_user_id = _authority_user_id AND evidence.authority_source = _authority_source
  ) THEN RAISE EXCEPTION 'handling_send_authority_evidence_conflict'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.record_operator_send_authority_evidence(uuid, uuid, uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
-- Move the existing writer bodies behind owner-only private functions. The public
-- legacy overloads remain as fail-closed compatibility endpoints.
ALTER FUNCTION public.send_operator_message(uuid, text) SET SCHEMA private;
ALTER FUNCTION public.send_operator_sticker_message(uuid, uuid, uuid) SET SCHEMA private;
ALTER FUNCTION public.send_operator_media_message(uuid, text, text) SET SCHEMA private;
ALTER FUNCTION public.send_operator_locked_media_message(uuid, text) SET SCHEMA private;

REVOKE ALL ON FUNCTION private.send_operator_message(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.send_operator_sticker_message(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.send_operator_media_message(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.send_operator_locked_media_message(uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.send_operator_message(_conversation_id uuid, _content text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  RAISE EXCEPTION 'handling_cycle_token_required';
END;
$$;

CREATE FUNCTION public.send_operator_message(
  _conversation_id uuid,
  _content text,
  _expected_cycle_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _authority record;
  _result jsonb;
  _message_id uuid;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  SELECT * INTO _authority
  FROM private.acquire_operator_send_authority(_conversation_id, _expected_cycle_id);

  _result := private.send_operator_message(_conversation_id, _content);
  _message_id := ((_result -> 'message') ->> 'id')::uuid;
  PERFORM private.record_operator_send_authority_evidence(
    _message_id, _conversation_id, _authority.operator_id, _authority.user_id,
    _authority.handling_cycle_id, _authority.authority_source
  );

  RETURN _result || jsonb_build_object(
    'cycle_id', _authority.handling_cycle_id,
    'authority_source', _authority.authority_source,
    'claimed_now', _authority.claimed_now
  );
END;
$$;

CREATE FUNCTION public.send_operator_sticker_message(
  _conversation_id uuid,
  _sticker_id uuid,
  _idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  RAISE EXCEPTION 'handling_cycle_token_required';
END;
$$;

CREATE FUNCTION public.send_operator_sticker_message(
  _conversation_id uuid,
  _sticker_id uuid,
  _idempotency_key uuid,
  _expected_cycle_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _authority record;
  _result jsonb;
  _message_id uuid;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  SELECT * INTO _authority
  FROM private.acquire_operator_send_authority(_conversation_id, _expected_cycle_id);
  _result := private.send_operator_sticker_message(_conversation_id, _sticker_id, _idempotency_key);
  _message_id := ((_result -> 'message') ->> 'id')::uuid;

  IF coalesce((_result ->> 'already_sent')::boolean, false) IS TRUE THEN
    IF NOT EXISTS (
      SELECT 1 FROM private.handling_send_authority_evidence evidence
      WHERE evidence.message_id = _message_id AND evidence.conversation_id = _conversation_id
        AND evidence.handling_cycle_id = _authority.handling_cycle_id
        AND evidence.operator_id = _authority.operator_id AND evidence.actor_user_id = _authority.user_id
    ) THEN RAISE EXCEPTION 'handling_send_authority_evidence_missing'; END IF;
  ELSE
    PERFORM private.record_operator_send_authority_evidence(
      _message_id, _conversation_id, _authority.operator_id, _authority.user_id,
      _authority.handling_cycle_id, _authority.authority_source
    );
  END IF;

  RETURN _result || jsonb_build_object(
    'cycle_id', _authority.handling_cycle_id,
    'authority_source', _authority.authority_source,
    'claimed_now', _authority.claimed_now
  );
END;
$$;

CREATE FUNCTION public.send_operator_media_message(
  _reservation_id uuid,
  _caption text DEFAULT NULL::text,
  _view_mode text DEFAULT 'permanent'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  RAISE EXCEPTION 'handling_cycle_token_required';
END;
$$;

CREATE FUNCTION public.send_operator_media_message(
  _reservation_id uuid,
  _caption text,
  _view_mode text,
  _expected_cycle_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _conversation_id uuid;
  _authority record;
  _result jsonb;
  _message_id uuid;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  SELECT reservation.conversation_id INTO _conversation_id
  FROM public.character_media_reservations reservation WHERE reservation.id = _reservation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'media_reservation_not_found'; END IF;

  SELECT * INTO _authority
  FROM private.acquire_operator_send_authority(_conversation_id, _expected_cycle_id);
  _result := private.send_operator_media_message(_reservation_id, _caption, _view_mode);
  _message_id := ((_result -> 'message') ->> 'id')::uuid;

  IF coalesce((_result ->> 'already_sent')::boolean, false) IS TRUE THEN
    IF NOT EXISTS (
      SELECT 1 FROM private.handling_send_authority_evidence evidence
      WHERE evidence.message_id = _message_id AND evidence.conversation_id = _conversation_id
        AND evidence.handling_cycle_id = _authority.handling_cycle_id
        AND evidence.operator_id = _authority.operator_id AND evidence.actor_user_id = _authority.user_id
    ) THEN RAISE EXCEPTION 'handling_send_authority_evidence_missing'; END IF;
  ELSE
    PERFORM private.record_operator_send_authority_evidence(
      _message_id, _conversation_id, _authority.operator_id, _authority.user_id,
      _authority.handling_cycle_id, _authority.authority_source
    );
  END IF;

  RETURN _result || jsonb_build_object(
    'cycle_id', _authority.handling_cycle_id,
    'authority_source', _authority.authority_source,
    'claimed_now', _authority.claimed_now
  );
END;
$$;

CREATE FUNCTION public.send_operator_locked_media_message(
  _reservation_id uuid,
  _caption text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  RAISE EXCEPTION 'handling_cycle_token_required';
END;
$$;

CREATE FUNCTION public.send_operator_locked_media_message(
  _reservation_id uuid,
  _caption text,
  _expected_cycle_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _conversation_id uuid;
  _authority record;
  _result jsonb;
  _message_id uuid;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  SELECT reservation.conversation_id INTO _conversation_id
  FROM public.character_media_reservations reservation WHERE reservation.id = _reservation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'media_reservation_not_found'; END IF;

  SELECT * INTO _authority
  FROM private.acquire_operator_send_authority(_conversation_id, _expected_cycle_id);
  _result := private.send_operator_locked_media_message(_reservation_id, _caption);
  _message_id := ((_result -> 'message') ->> 'id')::uuid;

  IF coalesce((_result ->> 'already_sent')::boolean, false) IS TRUE THEN
    IF NOT EXISTS (
      SELECT 1 FROM private.handling_send_authority_evidence evidence
      WHERE evidence.message_id = _message_id AND evidence.conversation_id = _conversation_id
        AND evidence.handling_cycle_id = _authority.handling_cycle_id
        AND evidence.operator_id = _authority.operator_id AND evidence.actor_user_id = _authority.user_id
    ) THEN RAISE EXCEPTION 'handling_send_authority_evidence_missing'; END IF;
  ELSE
    PERFORM private.record_operator_send_authority_evidence(
      _message_id, _conversation_id, _authority.operator_id, _authority.user_id,
      _authority.handling_cycle_id, _authority.authority_source
    );
  END IF;

  RETURN _result || jsonb_build_object(
    'cycle_id', _authority.handling_cycle_id,
    'authority_source', _authority.authority_source,
    'claimed_now', _authority.claimed_now
  );
END;
$$;

REVOKE ALL ON FUNCTION public.send_operator_message(uuid, text), public.send_operator_message(uuid, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.send_operator_sticker_message(uuid, uuid, uuid), public.send_operator_sticker_message(uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.send_operator_media_message(uuid, text, text), public.send_operator_media_message(uuid, text, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.send_operator_locked_media_message(uuid, text), public.send_operator_locked_media_message(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_operator_message(uuid, text), public.send_operator_message(uuid, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.send_operator_sticker_message(uuid, uuid, uuid), public.send_operator_sticker_message(uuid, uuid, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.send_operator_media_message(uuid, text, text), public.send_operator_media_message(uuid, text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.send_operator_locked_media_message(uuid, text), public.send_operator_locked_media_message(uuid, text, uuid) TO authenticated, service_role;
-- Admin actions cannot silently acquire worker authority. A future explicit
-- takeover flow is the only permitted route for Admin-as-Worker.
CREATE OR REPLACE FUNCTION public.send_admin_media_message(_reservation_id uuid, _caption text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  RAISE EXCEPTION 'admin_takeover_required';
END;
$$;

CREATE OR REPLACE FUNCTION public.send_admin_sticker_message(_conversation_id uuid, _sticker_id uuid, _idempotency_key uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  RAISE EXCEPTION 'admin_takeover_required';
END;
$$;

CREATE OR REPLACE FUNCTION public.start_operator_outreach(_client_id uuid, _character_id uuid, _message text, _idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  RAISE EXCEPTION 'operator_outreach_send_requires_claim';
END;
$$;

-- A cycle closes only through explicit release/reassign/timeout/close paths.
DROP TRIGGER IF EXISTS close_handling_cycle_on_staff_message ON public.messages;

DROP FUNCTION IF EXISTS public.get_operator_conversation_responsibility(uuid);
CREATE FUNCTION public.get_operator_conversation_responsibility(_conversation_id uuid)
RETURNS TABLE(state text, cycle_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _operator_id uuid;
  _conversation public.conversations%ROWTYPE;
  _cycle public.conversation_handling_cycles%ROWTYPE;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT operator.id INTO _operator_id
  FROM public.operators operator
  WHERE operator.user_id = _user_id AND operator.is_active = true
  LIMIT 1;
  IF _operator_id IS NULL THEN RAISE EXCEPTION 'operator_record_required'; END IF;

  SELECT * INTO _conversation FROM public.conversations conversation WHERE conversation.id = _conversation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_not_found'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.character_operator_assignments assignment
    WHERE assignment.character_id = _conversation.character_id AND assignment.operator_id = _operator_id
  ) THEN RAISE EXCEPTION 'operator_not_assigned_to_character'; END IF;
  IF _conversation.status = 'closed'::public.conversation_status THEN
    RETURN QUERY SELECT 'closed'::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT * INTO _cycle FROM public.conversation_handling_cycles cycle
  WHERE cycle.conversation_id = _conversation_id AND cycle.ended_at IS NULL
  ORDER BY cycle.started_at DESC LIMIT 1;
  IF _cycle.id IS NULL THEN
    RETURN QUERY SELECT 'available'::text, NULL::uuid;
  ELSIF _cycle.operator_id = _operator_id THEN
    RETURN QUERY SELECT 'mine'::text, _cycle.id;
  ELSE
    RETURN QUERY SELECT 'other'::text, NULL::uuid;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.get_operator_conversation_responsibility(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_operator_conversation_responsibility(uuid) TO authenticated, service_role;
-- Preserve the M3 fold as a base and layer strict-send evidence over it without
-- rewriting historical classifications.
ALTER FUNCTION private.get_handling_shadow_reconciliation()
  RENAME TO get_handling_shadow_reconciliation_base;

CREATE FUNCTION private.get_handling_shadow_reconciliation()
RETURNS TABLE (
  conversation_id uuid,
  expected_needs_handling boolean,
  expected_pending_since timestamptz,
  expected_last_business_message_at timestamptz,
  message_count bigint,
  max_handling_sequence bigint,
  metadata_complete boolean,
  semantic_consistent boolean,
  sequence_consistent boolean,
  projection_consistent boolean,
  active_cycle_projection_consistent boolean,
  closed_projection_consistent boolean,
  shadow_consistent boolean
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, private, pg_temp
AS $$
  WITH runtime AS (
    SELECT strict_send_deployed_at
    FROM private.handling_contract_runtime
    WHERE singleton = true
  ), evaluated AS (
    SELECT base.*,
      NOT EXISTS (
        SELECT 1
        FROM public.messages message
        CROSS JOIN runtime
        WHERE message.conversation_id = base.conversation_id
          AND message.created_at >= runtime.strict_send_deployed_at
          AND message.sender_type IN ('operator'::public.sender_type, 'admin'::public.sender_type)
          AND NOT (
            message.handling_effect = 'staff_response'
            AND EXISTS (
              SELECT 1
              FROM private.handling_send_authority_evidence evidence
              JOIN public.conversation_handling_cycles cycle ON cycle.id = evidence.handling_cycle_id
              WHERE evidence.message_id = message.id
                AND evidence.conversation_id = message.conversation_id
                AND evidence.handling_cycle_id = message.handling_cycle_id
                AND evidence.operator_id = message.operator_id
                AND cycle.conversation_id = message.conversation_id
                AND cycle.operator_id = message.operator_id
                AND message.created_at >= cycle.started_at
                AND (cycle.ended_at IS NULL OR message.created_at <= cycle.ended_at)
            )
          )
      ) AS strict_evidence_consistent
    FROM private.get_handling_shadow_reconciliation_base() base
  )
  SELECT
    conversation_id,
    expected_needs_handling,
    expected_pending_since,
    expected_last_business_message_at,
    message_count,
    max_handling_sequence,
    metadata_complete AND strict_evidence_consistent,
    semantic_consistent AND strict_evidence_consistent,
    sequence_consistent,
    projection_consistent,
    active_cycle_projection_consistent,
    closed_projection_consistent,
    metadata_complete AND semantic_consistent AND sequence_consistent AND projection_consistent
      AND active_cycle_projection_consistent AND closed_projection_consistent AND strict_evidence_consistent
  FROM evaluated;
$$;

REVOKE ALL ON FUNCTION private.get_handling_shadow_reconciliation()
  FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION private.get_handling_cutover_readiness()
  RENAME TO get_handling_cutover_readiness_base;

CREATE FUNCTION private.get_handling_cutover_readiness()
RETURNS TABLE (
  mode text,
  unresolved_fallback_no_cycle_writes bigint,
  unresolved_state_changing_effects bigint,
  post_deploy_business_writes_missing_metadata bigint,
  uninitialized_conversations bigint,
  inconsistent_conversations bigint,
  shadow_consistent boolean,
  cutover_authorized boolean
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, private, pg_temp
AS $$
  WITH runtime AS (
    SELECT mode, compatibility_deployed_at, strict_send_deployed_at
    FROM private.handling_contract_runtime WHERE singleton = true
  ), fallback_blockers AS (
    SELECT message.id AS message_id FROM public.messages message
    WHERE message.handling_effect = 'unclassified'
      AND message.handling_classification_reason IN ('fallback_no_active_cycle', 'admin_without_takeover_evidence')
    UNION
    SELECT semantics.message_id FROM private.get_message_handling_semantics() semantics
    WHERE semantics.expected_handling_effect = 'unclassified'
      AND semantics.expected_classification_reason IN ('fallback_no_active_cycle', 'admin_without_takeover_evidence')
    UNION
    SELECT issue.message_id FROM private.handling_reconciliation_issues issue
    WHERE issue.status = 'unresolved'
      AND issue.issue_kind IN ('fallback_no_active_cycle', 'admin_without_takeover_evidence')
  ), state_changing_blockers AS (
    SELECT message.id AS message_id FROM public.messages message WHERE message.handling_effect = 'unclassified'
    UNION
    SELECT semantics.message_id FROM private.get_message_handling_semantics() semantics WHERE semantics.expected_handling_effect = 'unclassified'
    UNION
    SELECT issue.message_id FROM private.handling_reconciliation_issues issue
    WHERE issue.status = 'unresolved' AND issue.can_change_canonical_state IS TRUE
  ), counts AS (
    SELECT
      (SELECT count(DISTINCT blocker.message_id) FROM fallback_blockers blocker) AS fallback_count,
      (SELECT count(DISTINCT blocker.message_id) FROM state_changing_blockers blocker) AS state_changing_count,
      (
        SELECT count(*) FROM public.messages message CROSS JOIN runtime
        WHERE message.created_at >= runtime.compatibility_deployed_at
          AND message.sender_type IN ('client'::public.sender_type, 'operator'::public.sender_type, 'admin'::public.sender_type)
          AND (
            message.handling_sequence IS NULL OR message.handling_effect IS NULL
            OR message.handling_metadata_version IS NULL OR message.handling_classification_reason IS NULL
            OR message.handling_classified_at IS NULL
            OR (
              message.created_at >= runtime.strict_send_deployed_at
              AND message.sender_type IN ('operator'::public.sender_type, 'admin'::public.sender_type)
              AND NOT EXISTS (
                SELECT 1 FROM private.handling_send_authority_evidence evidence
                WHERE evidence.message_id = message.id AND evidence.conversation_id = message.conversation_id
                  AND evidence.handling_cycle_id = message.handling_cycle_id AND evidence.operator_id = message.operator_id
              )
            )
          )
      ) AS missing_metadata_count,
      (SELECT count(*) FROM public.conversations conversation WHERE conversation.handling_state_initialized IS NOT TRUE) AS uninitialized_count,
      (SELECT count(*) FROM private.get_handling_shadow_reconciliation() reconciliation WHERE reconciliation.shadow_consistent IS NOT TRUE) AS inconsistent_count
  )
  SELECT runtime.mode, counts.fallback_count, counts.state_changing_count, counts.missing_metadata_count,
    counts.uninitialized_count, counts.inconsistent_count,
    counts.fallback_count = 0 AND counts.state_changing_count = 0
      AND counts.missing_metadata_count = 0 AND counts.uninitialized_count = 0 AND counts.inconsistent_count = 0,
    false
  FROM runtime CROSS JOIN counts;
$$;

REVOKE ALL ON FUNCTION private.get_handling_cutover_readiness()
  FROM PUBLIC, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
