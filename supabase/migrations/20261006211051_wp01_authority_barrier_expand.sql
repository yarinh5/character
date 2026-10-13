-- WP01.1: expand the handling authority contract without activating cutover.
-- Active handling cycles remain the sole ownership token. Legacy lock behavior
-- remains available only through the compatibility guard while no cycle exists.

CREATE OR REPLACE FUNCTION private.acquire_handling_writer_barrier()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(20261006, 101);
END;
$$;

CREATE OR REPLACE FUNCTION private.acquire_handling_cutover_barrier()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(20261006, 101);
END;
$$;

REVOKE ALL ON FUNCTION private.acquire_handling_writer_barrier()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.acquire_handling_cutover_barrier()
  FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  _duplicate RECORD;
BEGIN
  SELECT cycle.conversation_id, count(*)::INTEGER AS active_count
  INTO _duplicate
  FROM public.conversation_handling_cycles cycle
  WHERE cycle.ended_at IS NULL
  GROUP BY cycle.conversation_id
  HAVING count(*) > 1
  ORDER BY cycle.conversation_id
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'duplicate_active_handling_cycles: conversation_id=%, active_count=%',
      _duplicate.conversation_id,
      _duplicate.active_count;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS conversation_handling_cycles_one_active_conversation_idx
  ON public.conversation_handling_cycles (conversation_id)
  WHERE ended_at IS NULL;

CREATE OR REPLACE FUNCTION private.enforce_handling_writer_barrier()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private, pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.enforce_handling_writer_barrier()
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE UPDATE ON TABLE public.conversations
  FROM PUBLIC, anon, authenticated;
GRANT UPDATE (status) ON TABLE public.conversations
  TO authenticated;

DROP TRIGGER IF EXISTS enforce_handling_cycle_writer_barrier
  ON public.conversation_handling_cycles;
DROP FUNCTION IF EXISTS private.enforce_handling_cycle_writer_barrier();

DROP TRIGGER IF EXISTS enforce_handling_writer_barrier ON public.messages;
CREATE TRIGGER enforce_handling_writer_barrier
  BEFORE INSERT OR UPDATE OR DELETE ON public.messages
  FOR EACH STATEMENT
  EXECUTE FUNCTION private.enforce_handling_writer_barrier();

DROP TRIGGER IF EXISTS enforce_handling_writer_barrier
  ON public.conversation_handling_cycles;
CREATE TRIGGER enforce_handling_writer_barrier
  BEFORE INSERT OR UPDATE OR DELETE ON public.conversation_handling_cycles
  FOR EACH STATEMENT
  EXECUTE FUNCTION private.enforce_handling_writer_barrier();

DROP TRIGGER IF EXISTS enforce_handling_writer_barrier
  ON public.conversation_work_items;
CREATE TRIGGER enforce_handling_writer_barrier
  BEFORE INSERT OR UPDATE OR DELETE ON public.conversation_work_items
  FOR EACH STATEMENT
  EXECUTE FUNCTION private.enforce_handling_writer_barrier();

DROP TRIGGER IF EXISTS enforce_handling_writer_barrier ON public.conversations;
CREATE TRIGGER enforce_handling_writer_barrier
  BEFORE INSERT OR UPDATE OR DELETE ON public.conversations
  FOR EACH STATEMENT
  EXECUTE FUNCTION private.enforce_handling_writer_barrier();

CREATE OR REPLACE FUNCTION public.handle_new_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM private.acquire_handling_writer_barrier();

  IF NEW.sender_type = 'client' THEN
    UPDATE public.conversations
    SET last_message_at = NEW.created_at,
        last_message_preview = LEFT(NEW.content, 200),
        operator_unread_count = operator_unread_count + 1,
        status = CASE
          WHEN status = 'closed' THEN 'open'::public.conversation_status
          ELSE 'waiting'::public.conversation_status
        END,
        updated_at = now()
    WHERE id = NEW.conversation_id;
  ELSIF NEW.sender_type = 'operator' THEN
    UPDATE public.conversations
    SET last_message_at = NEW.created_at,
        last_message_preview = LEFT(NEW.content, 200),
        client_unread_count = client_unread_count + 1,
        status = 'answered'::public.conversation_status,
        updated_at = now()
    WHERE id = NEW.conversation_id;
  ELSE
    UPDATE public.conversations
    SET last_message_at = NEW.created_at,
        last_message_preview = LEFT(NEW.content, 200),
        updated_at = now()
    WHERE id = NEW.conversation_id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_message()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.sync_client_hidden_at_from_deletion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  _character_id UUID;
  _conversation_id UUID;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();

  SELECT conversation.character_id
  INTO _character_id
  FROM public.conversations conversation
  WHERE conversation.id = NEW.conversation_id
    AND conversation.client_id = NEW.client_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_access_denied';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(NEW.client_id::TEXT),
    hashtext(_character_id::TEXT)
  );

  SELECT conversation.id
  INTO _conversation_id
  FROM public.conversations conversation
  WHERE conversation.id = NEW.conversation_id
    AND conversation.client_id = NEW.client_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_access_denied';
  END IF;

  UPDATE public.conversations
  SET client_hidden_at = COALESCE(client_hidden_at, NEW.deleted_at),
      updated_at = now()
  WHERE id = _conversation_id;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.sync_client_hidden_at_from_deletion()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.start_or_get_conversation(_character_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  _client UUID;
  _conv_id UUID;
  _operator UUID;
  _char_active BOOLEAN;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();

  _client := auth.uid();

  IF _client IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM private.ensure_active_client(_client);

  SELECT (character.is_active AND character.is_visible)
  INTO _char_active
  FROM public.characters character
  WHERE character.id = _character_id;

  IF _char_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Character not available';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(_client::TEXT),
    hashtext(_character_id::TEXT)
  );

  SELECT conversation.id
  INTO _conv_id
  FROM public.conversations conversation
  WHERE conversation.client_id = _client
    AND conversation.character_id = _character_id
    AND conversation.status <> 'closed'::public.conversation_status
    AND conversation.client_hidden_at IS NULL
  FOR UPDATE;

  IF _conv_id IS NOT NULL THEN
    RETURN _conv_id;
  END IF;

  SELECT operator.id
  INTO _operator
  FROM public.operators operator
  JOIN public.character_operator_assignments assignment
    ON assignment.operator_id = operator.id
  WHERE assignment.character_id = _character_id
    AND operator.is_active = TRUE
  ORDER BY operator.availability_status = 'available' DESC,
           (
             SELECT count(*)
             FROM public.conversations conversation
             WHERE conversation.assigned_operator_id = operator.id
               AND conversation.status <> 'closed'::public.conversation_status
           ) ASC
  LIMIT 1;

  INSERT INTO public.conversations (
    client_id,
    character_id,
    assigned_operator_id,
    status,
    client_hidden_at
  )
  VALUES (
    _client,
    _character_id,
    _operator,
    CASE
      WHEN _operator IS NULL THEN 'waiting'::public.conversation_status
      ELSE 'open'::public.conversation_status
    END,
    NULL
  )
  ON CONFLICT (client_id, character_id)
  WHERE status <> 'closed'::public.conversation_status
    AND client_hidden_at IS NULL
  DO NOTHING
  RETURNING id INTO _conv_id;

  IF _conv_id IS NULL THEN
    SELECT conversation.id
    INTO _conv_id
    FROM public.conversations conversation
    WHERE conversation.client_id = _client
      AND conversation.character_id = _character_id
      AND conversation.status <> 'closed'::public.conversation_status
      AND conversation.client_hidden_at IS NULL
    FOR UPDATE;
  END IF;

  IF _conv_id IS NULL THEN
    RAISE EXCEPTION 'conversation_creation_conflict';
  END IF;

  RETURN _conv_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.hide_conversation_for_client(
  _conversation_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  _client UUID;
  _character_id UUID;
  _locked_conversation_id UUID;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();

  _client := auth.uid();

  IF _client IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT conversation.character_id
  INTO _character_id
  FROM public.conversations conversation
  WHERE conversation.id = _conversation_id
    AND conversation.client_id = _client;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_access_denied';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(_client::TEXT),
    hashtext(_character_id::TEXT)
  );

  SELECT conversation.id
  INTO _locked_conversation_id
  FROM public.conversations conversation
  WHERE conversation.id = _conversation_id
    AND conversation.client_id = _client
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_access_denied';
  END IF;

  UPDATE public.conversations
  SET client_hidden_at = COALESCE(client_hidden_at, now()),
      updated_at = now()
  WHERE id = _locked_conversation_id;

  INSERT INTO public.client_conversation_deletions (
    client_id,
    conversation_id
  )
  VALUES (_client, _locked_conversation_id)
  ON CONFLICT (client_id, conversation_id) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_operator_can_send_base(
  _conversation_id UUID
)
RETURNS TABLE (
  operator_id UUID,
  user_id UUID,
  concurrency_mode TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID;
  _operator_id UUID;
  _conversation public.conversations%ROWTYPE;
  _concurrency_mode TEXT;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();

  _user_id := auth.uid();
  _concurrency_mode := COALESCE(private.setting_text('concurrency_mode', 'open'), 'open');

  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT operator.id
  INTO _operator_id
  FROM public.operators operator
  WHERE operator.user_id = _user_id
    AND operator.is_active = TRUE
  LIMIT 1;

  IF _operator_id IS NULL THEN
    RAISE EXCEPTION 'operator_record_required';
  END IF;

  SELECT *
  INTO _conversation
  FROM public.conversations conversation
  WHERE conversation.id = _conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  IF _conversation.status = 'closed'::public.conversation_status THEN
    RAISE EXCEPTION 'conversation_closed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.character_operator_assignments assignment
    WHERE assignment.character_id = _conversation.character_id
      AND assignment.operator_id = _operator_id
  ) THEN
    RAISE EXCEPTION 'operator_not_assigned_to_character';
  END IF;

  RETURN QUERY SELECT _operator_id, _user_id, _concurrency_mode;
END;
$$;

REVOKE ALL ON FUNCTION private.assert_operator_can_send_base(UUID)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.assert_operator_can_send_conversation_message(
  _conversation_id UUID
)
RETURNS TABLE (
  operator_id UUID,
  user_id UUID,
  concurrency_mode TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _guard RECORD;
  _active_cycle public.conversation_handling_cycles%ROWTYPE;
  _active_lock public.conversation_locks%ROWTYPE;
  _timeout_minutes INTEGER;
  _acquire_result JSONB;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();

  SELECT *
  INTO _guard
  FROM private.assert_operator_can_send_base(_conversation_id);

  SELECT *
  INTO _active_cycle
  FROM public.conversation_handling_cycles cycle
  WHERE cycle.conversation_id = _conversation_id
    AND cycle.ended_at IS NULL
  FOR UPDATE;

  IF FOUND THEN
    IF _active_cycle.operator_id IS DISTINCT FROM _guard.operator_id THEN
      RAISE EXCEPTION 'conversation_not_responsible_operator';
    END IF;

    RETURN QUERY SELECT _guard.operator_id, _guard.user_id, _guard.concurrency_mode;
    RETURN;
  END IF;

  PERFORM public.cleanup_expired_conversation_locks();
  _timeout_minutes := GREATEST(private.setting_int('lock_timeout_minutes', 10), 1);

  IF _guard.concurrency_mode = 'lock' THEN
    SELECT *
    INTO _active_lock
    FROM public.conversation_locks legacy_lock
    WHERE legacy_lock.conversation_id = _conversation_id
      AND legacy_lock.released_at IS NULL
      AND legacy_lock.expires_at > clock_timestamp()
    FOR UPDATE;

    IF FOUND AND _active_lock.locked_by_operator_id <> _guard.operator_id THEN
      RAISE EXCEPTION 'conversation_locked_by_other_operator';
    END IF;

    IF NOT FOUND THEN
      _acquire_result := public.acquire_conversation_lock(_conversation_id);
      IF COALESCE((_acquire_result->>'acquired')::BOOLEAN, FALSE) IS NOT TRUE THEN
        RAISE EXCEPTION 'conversation_locked_by_other_operator';
      END IF;
    ELSE
      UPDATE public.conversation_locks
      SET last_activity_at = clock_timestamp(),
          expires_at = clock_timestamp() + make_interval(mins => _timeout_minutes)
      WHERE conversation_id = _conversation_id;
    END IF;
  ELSIF _guard.concurrency_mode = 'warning' THEN
    _acquire_result := public.acquire_conversation_lock(_conversation_id);
  END IF;

  RETURN QUERY SELECT _guard.operator_id, _guard.user_id, _guard.concurrency_mode;
END;
$$;

REVOKE ALL ON FUNCTION private.assert_operator_can_send_conversation_message(UUID)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.assert_operator_can_claim_conversation(
  _conversation_id UUID
)
RETURNS TABLE (
  operator_id UUID,
  user_id UUID,
  concurrency_mode TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.acquire_handling_writer_barrier();

  RETURN QUERY
  SELECT guard.operator_id, guard.user_id, guard.concurrency_mode
  FROM private.assert_operator_can_send_base(_conversation_id) guard;
END;
$$;

REVOKE ALL ON FUNCTION private.assert_operator_can_claim_conversation(UUID)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.assert_operator_can_send_for_cycle(
  _conversation_id UUID,
  _expected_cycle_id UUID
)
RETURNS TABLE (
  operator_id UUID,
  user_id UUID,
  concurrency_mode TEXT,
  handling_cycle_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _guard RECORD;
  _cycle public.conversation_handling_cycles%ROWTYPE;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();

  IF _expected_cycle_id IS NULL THEN
    RAISE EXCEPTION 'handling_cycle_token_required';
  END IF;

  SELECT *
  INTO _guard
  FROM private.assert_operator_can_send_base(_conversation_id);

  SELECT *
  INTO _cycle
  FROM public.conversation_handling_cycles cycle
  WHERE cycle.id = _expected_cycle_id
    AND cycle.conversation_id = _conversation_id
    AND cycle.operator_id = _guard.operator_id
    AND cycle.ended_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'handling_cycle_token_invalid';
  END IF;

  RETURN QUERY SELECT
    _guard.operator_id,
    _guard.user_id,
    _guard.concurrency_mode,
    _cycle.id;
END;
$$;

REVOKE ALL ON FUNCTION private.assert_operator_can_send_for_cycle(UUID, UUID)
  FROM PUBLIC, anon, authenticated, service_role;

-- Preserved writer contract: private.close_conversation_work_items()
CREATE OR REPLACE FUNCTION private.close_conversation_work_items()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF NEW.status = 'closed'::public.conversation_status
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    WITH closed_items AS (
      UPDATE public.conversation_work_items
      SET status = 'closed'
      WHERE conversation_id = NEW.id
        AND status IN ('new', 'assigned', 'in_progress')
      RETURNING id
    )
    UPDATE public.conversation_handling_cycles cycle
    SET ended_at = clock_timestamp(),
        end_reason = 'closed'
    FROM closed_items item
    WHERE cycle.work_item_id = item.id
      AND cycle.ended_at IS NULL;
  END IF;

  RETURN NEW;
END;
$function$;

-- Preserved writer contract: private.close_handling_cycle_on_staff_message()
CREATE OR REPLACE FUNCTION private.close_handling_cycle_on_staff_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF NEW.sender_type NOT IN ('operator'::public.sender_type, 'admin'::public.sender_type) THEN
    RETURN NEW;
  END IF;

  IF NEW.operator_id IS NULL THEN
    RETURN NEW;
  END IF;

  WITH answered_items AS (
    UPDATE public.conversation_handling_cycles cycle
    SET ended_at = NEW.created_at,
        end_reason = 'answered'
    FROM public.conversation_work_items wi
    WHERE wi.id = cycle.work_item_id
      AND wi.conversation_id = NEW.conversation_id
      AND wi.status IN ('assigned', 'in_progress')
      AND cycle.ended_at IS NULL
      AND cycle.operator_id = NEW.operator_id
      AND cycle.started_at <= NEW.created_at
    RETURNING wi.id
  )
  UPDATE public.conversation_work_items wi
  SET status = 'closed'
  WHERE wi.id IN (SELECT id FROM answered_items);

  RETURN NEW;
END;
$function$;

-- Preserved writer contract: private.create_operator_message_with_scoring(uuid,uuid,uuid,text,jsonb)
CREATE OR REPLACE FUNCTION private.create_operator_message_with_scoring(_conversation_id uuid, _operator_id uuid, _user_id uuid, _content text, _score_metadata jsonb)
 RETURNS TABLE(message_id uuid, message jsonb, score_awarded integer, streak_position integer, consecutive_message_limit integer, monthly_points integer, scoring_enabled boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _content_clean TEXT := btrim(COALESCE(_content, ''));
  _scoring_enabled BOOLEAN;
  _limit INTEGER;
  _period_month DATE := date_trunc('month', clock_timestamp())::DATE;
  _last_client_at TIMESTAMPTZ;
  _streak_position INTEGER := 0;
  _score_awarded INTEGER := 0;
  _monthly_points INTEGER := 0;
  _message public.messages%ROWTYPE;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF char_length(_content_clean) = 0 OR char_length(_content_clean) > 2000 THEN
    RAISE EXCEPTION 'invalid_message_content';
  END IF;

  INSERT INTO public.messages (conversation_id, sender_type, sender_id, operator_id, content, created_at)
  VALUES (
    _conversation_id,
    'operator'::public.sender_type,
    _user_id,
    _operator_id,
    _content_clean,
    clock_timestamp()
  )
  RETURNING * INTO _message;

  _scoring_enabled := private.setting_bool('scoring_enabled', true);
  _limit := GREATEST(private.setting_int('consecutive_message_limit', 3), 0);

  IF _scoring_enabled AND _limit > 0 THEN
    SELECT max(m.created_at)
    INTO _last_client_at
    FROM public.messages m
    WHERE m.conversation_id = _conversation_id
      AND m.sender_type = 'client'::public.sender_type;

    SELECT COUNT(*)::INTEGER
    INTO _streak_position
    FROM public.messages m
    WHERE m.conversation_id = _conversation_id
      AND m.sender_type = 'operator'::public.sender_type
      AND m.created_at > COALESCE(_last_client_at, '-infinity'::TIMESTAMPTZ);

    IF _streak_position <= _limit THEN
      _score_awarded := 1;

      INSERT INTO public.operator_score_events (
        operator_id,
        user_id,
        conversation_id,
        message_id,
        points,
        period_month,
        streak_position,
        limit_applied,
        reason,
        metadata
      )
      VALUES (
        _operator_id,
        _user_id,
        _conversation_id,
        _message.id,
        _score_awarded,
        _period_month,
        _streak_position,
        _limit,
        'operator_message',
        COALESCE(_score_metadata, '{}'::JSONB)
      );
    END IF;

    INSERT INTO public.operator_monthly_scores (operator_id, period_month, points, message_count)
    VALUES (_operator_id, _period_month, _score_awarded, 1)
    ON CONFLICT (operator_id, period_month)
    DO UPDATE SET
      points = public.operator_monthly_scores.points + EXCLUDED.points,
      message_count = public.operator_monthly_scores.message_count + EXCLUDED.message_count,
      updated_at = clock_timestamp()
    RETURNING points INTO _monthly_points;
  END IF;

  RETURN QUERY
  SELECT
    _message.id,
    to_jsonb(_message),
    _score_awarded,
    _streak_position,
    _limit,
    _monthly_points,
    _scoring_enabled;
END;
$function$;

-- Preserved writer contract: private.return_stale_work_items_to_new()
CREATE OR REPLACE FUNCTION private.return_stale_work_items_to_new()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  _stale_minutes INTEGER := GREATEST(private.setting_int('operator_heartbeat_stale_minutes', 5), 1);
  _item RECORD;
  _returned_count INTEGER := 0;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  FOR _item IN
    SELECT
      wi.id AS work_item_id,
      wi.conversation_id,
      wi.responsible_operator_id
    FROM public.conversation_work_items wi
    JOIN public.conversations c ON c.id = wi.conversation_id
    JOIN public.operators o ON o.id = wi.responsible_operator_id
    WHERE wi.status IN ('assigned', 'in_progress')
      AND c.status <> 'closed'::public.conversation_status
      AND (
        o.last_seen_at IS NULL
        OR o.last_seen_at < clock_timestamp() - make_interval(mins => _stale_minutes)
      )
    ORDER BY wi.last_activity_at ASC
    FOR UPDATE OF wi SKIP LOCKED
  LOOP
    UPDATE public.conversation_handling_cycles
    SET ended_at = clock_timestamp(),
        end_reason = 'timeout'
    WHERE work_item_id = _item.work_item_id
      AND ended_at IS NULL;

    UPDATE public.conversation_locks
    SET released_at = clock_timestamp(),
        released_by_user_id = NULL,
        release_reason = 'heartbeat_timeout'
    WHERE conversation_id = _item.conversation_id
      AND locked_by_operator_id = _item.responsible_operator_id
      AND released_at IS NULL;

    UPDATE public.conversations
    SET assigned_operator_id = NULL,
        updated_at = clock_timestamp()
    WHERE id = _item.conversation_id
      AND assigned_operator_id = _item.responsible_operator_id;

    UPDATE public.conversation_work_items
    SET status = 'new',
        responsible_operator_id = NULL,
        assigned_at = NULL,
        last_activity_at = clock_timestamp()
    WHERE id = _item.work_item_id;

    UPDATE public.operators
    SET presence_status = 'offline'
    WHERE id = _item.responsible_operator_id
      AND (last_seen_at IS NULL OR last_seen_at < clock_timestamp() - make_interval(mins => _stale_minutes));

    _returned_count := _returned_count + 1;
  END LOOP;

  RETURN _returned_count;
END;
$function$;

-- Preserved writer contract: private.send_sticker_message(uuid,uuid,uuid,text)
CREATE OR REPLACE FUNCTION private.send_sticker_message(_conversation_id uuid, _sticker_id uuid, _idempotency_key uuid, _actor_kind text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  _user_id UUID := auth.uid();
  _operator_guard RECORD;
  _operator_id UUID;
  _client_guard RECORD;
  _client_id UUID;
  _sticker RECORD;
  _attempt private.sticker_send_attempts%ROWTYPE;
  _message public.messages%ROWTYPE;
  _message_sticker public.message_stickers%ROWTYPE;
  _charge public.credit_transactions%ROWTYPE;
  _conversation_character_id UUID;
  _payout_operator_id UUID;
  _payout_user_id UUID;
  _client_balance INTEGER;
  _client_balance_after INTEGER;
  _payout_balance_after INTEGER;
  _fingerprint TEXT := format('sticker:%s:%s:%s', _actor_kind, _conversation_id, _sticker_id);
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF _idempotency_key IS NULL THEN
    RAISE EXCEPTION 'sticker_idempotency_key_required';
  END IF;

  IF _actor_kind = 'client' THEN
    SELECT * INTO _client_guard
    FROM private.assert_client_can_send_sticker_message(_conversation_id);
    _client_id := _client_guard.user_id;
  ELSIF _actor_kind = 'operator' THEN
    SELECT * INTO _operator_guard
    FROM private.assert_operator_can_send_conversation_message(_conversation_id);
    _operator_id := _operator_guard.operator_id;
  ELSIF _actor_kind = 'admin' THEN
    SELECT * INTO _operator_guard
    FROM private.assert_admin_can_send_conversation_message(_conversation_id);
    _operator_id := _operator_guard.operator_id;
  ELSE
    RAISE EXCEPTION 'invalid_sticker_sender';
  END IF;

  SELECT conversation.character_id INTO _conversation_character_id
  FROM public.conversations conversation
  WHERE conversation.id = _conversation_id;

  SELECT * INTO _attempt
  FROM private.sticker_send_attempts attempt
  WHERE attempt.actor_user_id = _user_id
    AND attempt.idempotency_key = _idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF _attempt.request_fingerprint <> _fingerprint THEN
      RAISE EXCEPTION 'sticker_idempotency_key_reused';
    END IF;

    IF _attempt.status <> 'succeeded' OR _attempt.message_id IS NULL THEN
      RAISE EXCEPTION 'sticker_send_in_progress';
    END IF;

    SELECT * INTO _message FROM public.messages message WHERE message.id = _attempt.message_id;
    SELECT * INTO _message_sticker FROM public.message_stickers message_sticker
    WHERE message_sticker.message_id = _attempt.message_id;

    IF _attempt.charged_transaction_id IS NOT NULL THEN
      SELECT * INTO _charge
      FROM public.credit_transactions transaction
      WHERE transaction.id = _attempt.charged_transaction_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'sticker_attempt_payment_invariant_failed';
      END IF;
    END IF;

    RETURN jsonb_build_object(
      'message', to_jsonb(_message),
      'message_sticker', jsonb_build_object(
        'id', _message_sticker.id,
        'message_id', _message_sticker.message_id,
        'sticker_id', _message_sticker.sticker_id,
        'sticker_name_snapshot', _message_sticker.sticker_name_snapshot,
        'collection_name_snapshot', _message_sticker.collection_name_snapshot,
        'created_at', _message_sticker.created_at
      ),
      'balance', CASE WHEN _actor_kind = 'client' AND _attempt.charged_transaction_id IS NOT NULL THEN _charge.balance_after ELSE NULL END,
      'already_sent', TRUE
    );
  END IF;

  IF private.setting_bool('stickers_enabled', false) IS NOT TRUE THEN
    RAISE EXCEPTION 'stickers_disabled';
  END IF;

  SELECT
    sticker.id,
    sticker.name AS sticker_name,
    sticker.price_credits,
    collection.name AS collection_name
  INTO _sticker
  FROM public.stickers sticker
  JOIN public.sticker_collections collection ON collection.id = sticker.collection_id
  WHERE sticker.id = _sticker_id
    AND sticker.is_active = TRUE
    AND sticker.ingest_status = 'ready'
    AND collection.is_active = TRUE
    AND (collection.character_id IS NULL OR collection.character_id = _conversation_character_id)
  FOR UPDATE OF sticker;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'sticker_not_available';
  END IF;

  IF _actor_kind = 'client' AND _sticker.price_credits > 0 THEN
    SELECT resolved.operator_id, resolved.user_id
    INTO _payout_operator_id, _payout_user_id
    FROM private.resolve_paid_sticker_payout_operator(_conversation_id) resolved;

    IF _payout_operator_id IS NULL OR _payout_user_id IS NULL THEN
      RAISE EXCEPTION 'paid_sticker_requires_operator_context';
    END IF;

    IF _payout_user_id = _client_guard.user_id THEN
      RAISE EXCEPTION 'paid_sticker_invalid_payout_operator';
    END IF;
  END IF;

  INSERT INTO private.sticker_send_attempts (
    actor_user_id,
    actor_kind,
    conversation_id,
    sticker_id,
    idempotency_key,
    request_fingerprint,
    price_credits_snapshot
  )
  VALUES (
    _user_id,
    _actor_kind,
    _conversation_id,
    _sticker.id,
    _idempotency_key,
    _fingerprint,
    _sticker.price_credits
  )
  ON CONFLICT (actor_user_id, idempotency_key) DO NOTHING
  RETURNING * INTO _attempt;

  IF NOT FOUND THEN
    SELECT * INTO _attempt
    FROM private.sticker_send_attempts attempt
    WHERE attempt.actor_user_id = _user_id
      AND attempt.idempotency_key = _idempotency_key
    FOR UPDATE;

    IF _attempt.request_fingerprint <> _fingerprint THEN
      RAISE EXCEPTION 'sticker_idempotency_key_reused';
    END IF;

    IF _attempt.status <> 'succeeded' OR _attempt.message_id IS NULL THEN
      RAISE EXCEPTION 'sticker_send_in_progress';
    END IF;

    SELECT * INTO _message FROM public.messages message WHERE message.id = _attempt.message_id;
    SELECT * INTO _message_sticker FROM public.message_stickers message_sticker
    WHERE message_sticker.message_id = _attempt.message_id;

    IF _attempt.charged_transaction_id IS NOT NULL THEN
      SELECT * INTO _charge FROM public.credit_transactions transaction
      WHERE transaction.id = _attempt.charged_transaction_id;
    END IF;

    RETURN jsonb_build_object(
      'message', to_jsonb(_message),
      'message_sticker', jsonb_build_object(
        'id', _message_sticker.id,
        'message_id', _message_sticker.message_id,
        'sticker_id', _message_sticker.sticker_id,
        'sticker_name_snapshot', _message_sticker.sticker_name_snapshot,
        'collection_name_snapshot', _message_sticker.collection_name_snapshot,
        'created_at', _message_sticker.created_at
      ),
      'balance', CASE WHEN _actor_kind = 'client' AND _attempt.charged_transaction_id IS NOT NULL THEN _charge.balance_after ELSE NULL END,
      'already_sent', TRUE
    );
  END IF;

  PERFORM private.consume_sticker_send_rate_limit(_conversation_id, _user_id, _actor_kind);

  IF _actor_kind = 'client' AND _sticker.price_credits > 0 THEN
    INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
    VALUES
      (_client_guard.user_id, 0, 0, 0),
      (_payout_user_id, 0, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;

    IF _client_guard.user_id < _payout_user_id THEN
      SELECT wallet.balance INTO _client_balance
      FROM public.credit_wallets wallet
      WHERE wallet.user_id = _client_guard.user_id
      FOR UPDATE;

      PERFORM 1
      FROM public.credit_wallets wallet
      WHERE wallet.user_id = _payout_user_id
      FOR UPDATE;
    ELSE
      PERFORM 1
      FROM public.credit_wallets wallet
      WHERE wallet.user_id = _payout_user_id
      FOR UPDATE;

      SELECT wallet.balance INTO _client_balance
      FROM public.credit_wallets wallet
      WHERE wallet.user_id = _client_guard.user_id
      FOR UPDATE;
    END IF;

    IF COALESCE(_client_balance, 0) < _sticker.price_credits THEN
      RAISE EXCEPTION 'insufficient_credits';
    END IF;

    UPDATE public.credit_wallets
    SET
      balance = balance - _sticker.price_credits,
      lifetime_spent = lifetime_spent + _sticker.price_credits
    WHERE user_id = _client_guard.user_id
    RETURNING balance INTO _client_balance_after;

    UPDATE public.credit_wallets
    SET
      balance = balance + _sticker.price_credits,
      lifetime_earned = lifetime_earned + _sticker.price_credits
    WHERE user_id = _payout_user_id
    RETURNING balance INTO _payout_balance_after;
  END IF;

  INSERT INTO public.messages (
    conversation_id,
    sender_type,
    sender_id,
    operator_id,
    content,
    created_at
  )
  VALUES (
    _conversation_id,
    CASE WHEN _actor_kind = 'client' THEN 'client'::public.sender_type ELSE 'operator'::public.sender_type END,
    _user_id,
    _operator_id,
    '[sticker]',
    clock_timestamp()
  )
  RETURNING * INTO _message;

  IF _actor_kind = 'client' AND _sticker.price_credits > 0 THEN
    INSERT INTO public.credit_transactions (
      user_id,
      amount,
      balance_after,
      type,
      reason,
      message_id,
      metadata
    )
    VALUES (
      _client_guard.user_id,
      -_sticker.price_credits,
      _client_balance_after,
      'sticker_spend',
      'paid_sticker_send',
      _message.id,
      jsonb_build_object(
        'sticker_id', _sticker.id,
        'price_credits_snapshot', _sticker.price_credits,
        'payout_operator_id', _payout_operator_id,
        'source', 'send_client_sticker_message'
      )
    )
    RETURNING * INTO _charge;

    INSERT INTO public.credit_transactions (
      user_id,
      amount,
      balance_after,
      type,
      reason,
      message_id,
      metadata
    )
    VALUES (
      _payout_user_id,
      _sticker.price_credits,
      _payout_balance_after,
      'sticker_payout',
      'paid_sticker_payout',
      _message.id,
      jsonb_build_object(
        'sticker_id', _sticker.id,
        'price_credits_snapshot', _sticker.price_credits,
        'payer_client_id', _client_guard.user_id,
        'payout_operator_id', _payout_operator_id,
        'source', 'send_client_sticker_message'
      )
    )
    RETURNING id INTO _attempt.payout_transaction_id;
  END IF;

  INSERT INTO public.message_stickers (
    message_id,
    sticker_id,
    sticker_name_snapshot,
    collection_name_snapshot,
    price_credits_snapshot,
    payer_client_id,
    charged_transaction_id,
    payout_operator_id,
    payout_transaction_id
  )
  VALUES (
    _message.id,
    _sticker.id,
    _sticker.sticker_name,
    _sticker.collection_name,
    _sticker.price_credits,
    CASE WHEN _actor_kind = 'client' AND _sticker.price_credits > 0 THEN _client_id ELSE NULL END,
    CASE WHEN _actor_kind = 'client' AND _sticker.price_credits > 0 THEN _charge.id ELSE NULL END,
    CASE WHEN _actor_kind = 'client' AND _sticker.price_credits > 0 THEN _payout_operator_id ELSE NULL END,
    CASE WHEN _actor_kind = 'client' AND _sticker.price_credits > 0 THEN _attempt.payout_transaction_id ELSE NULL END
  )
  RETURNING * INTO _message_sticker;

  UPDATE private.sticker_send_attempts
  SET
    message_id = _message.id,
    charged_transaction_id = CASE WHEN _actor_kind = 'client' AND _sticker.price_credits > 0 THEN _charge.id ELSE NULL END,
    payout_operator_id = CASE WHEN _actor_kind = 'client' AND _sticker.price_credits > 0 THEN _payout_operator_id ELSE NULL END,
    payout_transaction_id = CASE WHEN _actor_kind = 'client' AND _sticker.price_credits > 0 THEN _attempt.payout_transaction_id ELSE NULL END,
    status = 'succeeded',
    updated_at = clock_timestamp()
  WHERE id = _attempt.id;

  IF _actor_kind = 'admin' THEN
    INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
    VALUES (
      _user_id,
      'admin_sticker.message_sent',
      'message_sticker',
      _message_sticker.id::TEXT,
      jsonb_build_object(
        'actor_kind', 'admin',
        'conversation_id', _conversation_id,
        'sticker_id', _sticker.id,
        'message_id', _message.id
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'message', to_jsonb(_message),
    'message_sticker', jsonb_build_object(
      'id', _message_sticker.id,
      'message_id', _message_sticker.message_id,
      'sticker_id', _message_sticker.sticker_id,
      'sticker_name_snapshot', _message_sticker.sticker_name_snapshot,
      'collection_name_snapshot', _message_sticker.collection_name_snapshot,
      'created_at', _message_sticker.created_at
    ),
    'balance', CASE WHEN _actor_kind = 'client' AND _sticker.price_credits > 0 THEN _client_balance_after ELSE NULL END,
    'already_sent', FALSE
  );
END;
$function$;

-- Preserved writer contract: private.upsert_conversation_work_item_from_client_message()
CREATE OR REPLACE FUNCTION private.upsert_conversation_work_item_from_client_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  _conversation public.conversations%ROWTYPE;
  _active_operator_id UUID;
  _active_started_at TIMESTAMPTZ;
  _stale_cycle RECORD;
  _stale_minutes INTEGER := GREATEST(
    private.setting_int(
      'operator_handling_cycle_stale_minutes',
      private.setting_int('operator_heartbeat_stale_minutes', 5)
    ),
    1
  );
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF NEW.sender_type <> 'client'::public.sender_type THEN
    RETURN NEW;
  END IF;

  SELECT *
  INTO _conversation
  FROM public.conversations
  WHERE id = NEW.conversation_id;

  IF NOT FOUND OR _conversation.status = 'closed'::public.conversation_status THEN
    RETURN NEW;
  END IF;

  FOR _stale_cycle IN
    SELECT
      cycle.id AS cycle_id,
      cycle.work_item_id,
      cycle.operator_id
    FROM public.conversation_handling_cycles cycle
    WHERE cycle.conversation_id = _conversation.id
      AND cycle.ended_at IS NULL
      AND cycle.started_at < NEW.created_at - make_interval(mins => _stale_minutes)
    FOR UPDATE OF cycle
  LOOP
    UPDATE public.conversation_handling_cycles
    SET ended_at = NEW.created_at,
        end_reason = 'timeout'
    WHERE id = _stale_cycle.cycle_id
      AND ended_at IS NULL;

    UPDATE public.conversation_locks
    SET released_at = NEW.created_at,
        released_by_user_id = NULL,
        release_reason = 'heartbeat_timeout'
    WHERE conversation_id = _conversation.id
      AND locked_by_operator_id = _stale_cycle.operator_id
      AND released_at IS NULL;

    UPDATE public.conversations
    SET assigned_operator_id = NULL,
        updated_at = clock_timestamp()
    WHERE id = _conversation.id
      AND assigned_operator_id = _stale_cycle.operator_id;

    UPDATE public.conversation_work_items
    SET status = 'new',
        responsible_operator_id = NULL,
        assigned_at = NULL,
        last_activity_at = GREATEST(last_activity_at, NEW.created_at)
    WHERE id = _stale_cycle.work_item_id
      AND status IN ('assigned', 'in_progress');
  END LOOP;

  SELECT cycle.operator_id, cycle.started_at
  INTO _active_operator_id, _active_started_at
  FROM public.conversation_handling_cycles cycle
  WHERE cycle.conversation_id = _conversation.id
    AND cycle.ended_at IS NULL
  ORDER BY cycle.started_at DESC
  LIMIT 1;

  INSERT INTO public.conversation_work_items (
    conversation_id,
    client_id,
    character_id,
    status,
    responsible_operator_id,
    assigned_at,
    last_client_message_id,
    last_activity_at
  )
  VALUES (
    _conversation.id,
    _conversation.client_id,
    _conversation.character_id,
    CASE WHEN _active_operator_id IS NULL THEN 'new' ELSE 'in_progress' END,
    _active_operator_id,
    CASE WHEN _active_operator_id IS NULL THEN NULL ELSE _active_started_at END,
    NEW.id,
    NEW.created_at
  )
  ON CONFLICT (conversation_id)
  WHERE status IN ('new', 'assigned', 'in_progress')
  DO UPDATE SET
    last_client_message_id = CASE
      WHEN EXCLUDED.last_activity_at >= public.conversation_work_items.last_activity_at
        THEN EXCLUDED.last_client_message_id
      ELSE public.conversation_work_items.last_client_message_id
    END,
    last_activity_at = GREATEST(
      public.conversation_work_items.last_activity_at,
      EXCLUDED.last_activity_at
    ),
    status = CASE WHEN _active_operator_id IS NULL THEN 'new' ELSE 'in_progress' END,
    responsible_operator_id = _active_operator_id,
    assigned_at = CASE WHEN _active_operator_id IS NULL THEN NULL ELSE _active_started_at END;

  RETURN NEW;
END;
$function$;

-- Preserved writer contract: public.admin_reassign_conversation(uuid,uuid)
CREATE OR REPLACE FUNCTION public.admin_reassign_conversation(_conversation_id uuid, _operator_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  _admin_id UUID := auth.uid();
  _conversation public.conversations%ROWTYPE;
  _operator public.operators%ROWTYPE;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF _admin_id IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  IF _conversation_id IS NULL THEN
    RAISE EXCEPTION 'conversation_required';
  END IF;

  IF _operator_id IS NULL THEN
    RAISE EXCEPTION 'operator_required';
  END IF;

  SELECT *
  INTO _conversation
  FROM public.conversations
  WHERE id = _conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  SELECT *
  INTO _operator
  FROM public.operators
  WHERE id = _operator_id
    AND is_active = TRUE
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator_not_active';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.character_operator_assignments assignment
    WHERE assignment.operator_id = _operator_id
      AND assignment.character_id = _conversation.character_id
  ) THEN
    RAISE EXCEPTION 'operator_not_assigned_to_character';
  END IF;

  UPDATE public.conversations
  SET
    assigned_operator_id = _operator_id,
    status = 'open'::public.conversation_status
  WHERE id = _conversation_id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _admin_id,
    'conversation.reassigned',
    'conversation',
    _conversation_id::TEXT,
    jsonb_build_object(
      'previous_operator_id', _conversation.assigned_operator_id,
      'operator_id', _operator_id,
      'previous_status', _conversation.status,
      'status', 'open'
    )
  );

  RETURN jsonb_build_object('conversation_id', _conversation_id, 'operator_id', _operator_id, 'status', 'open');
END;
$function$;

-- Preserved writer contract: public.admin_set_conversation_status(uuid,public.conversation_status)
CREATE OR REPLACE FUNCTION public.admin_set_conversation_status(_conversation_id uuid, _status conversation_status)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  _admin_id UUID := auth.uid();
  _previous_status public.conversation_status;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF _admin_id IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  IF _conversation_id IS NULL THEN
    RAISE EXCEPTION 'conversation_required';
  END IF;

  IF _status IS NULL THEN
    RAISE EXCEPTION 'status_required';
  END IF;

  SELECT status
  INTO _previous_status
  FROM public.conversations
  WHERE id = _conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  UPDATE public.conversations
  SET status = _status
  WHERE id = _conversation_id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _admin_id,
    'conversation.status_changed',
    'conversation',
    _conversation_id::TEXT,
    jsonb_build_object('previous_status', _previous_status, 'status', _status)
  );

  RETURN jsonb_build_object('conversation_id', _conversation_id, 'status', _status);
END;
$function$;

-- Preserved writer contract: public.archive_client_pii(uuid,text,text)
CREATE OR REPLACE FUNCTION public.archive_client_pii(_client_id uuid, _reason text, _confirm text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  _actor_id UUID := auth.uid();
  _profile public.profiles%ROWTYPE;
  _reason_clean TEXT := btrim(COALESCE(_reason, ''));
  _archived_at TIMESTAMPTZ;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF _actor_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_required';
  END IF;
  IF _client_id IS NULL THEN
    RAISE EXCEPTION 'client_not_found';
  END IF;
  IF _client_id = _actor_id THEN
    RAISE EXCEPTION 'cannot_archive_own_account';
  END IF;
  IF _confirm <> 'ARCHIVE_CLIENT_PII' THEN
    RAISE EXCEPTION 'pii_archive_confirmation_required';
  END IF;
  IF char_length(_reason_clean) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'invalid_pii_archive_reason';
  END IF;

  SELECT * INTO _profile
  FROM public.profiles profile
  WHERE profile.user_id = _client_id
  FOR UPDATE;

  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM public.user_roles role
    WHERE role.user_id = _client_id
      AND role.role IN ('admin'::public.app_role, 'operator'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'client_not_found';
  END IF;

  IF _profile.pii_archived_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'archived', TRUE,
      'idempotent_replay', TRUE,
      'archived_at', _profile.pii_archived_at
    );
  END IF;

  UPDATE public.profiles
  SET display_name = 'לקוח בארכיון',
      email = NULL,
      avatar_url = NULL,
      status = 'archived',
      deleted_at = COALESCE(deleted_at, clock_timestamp()),
      pii_archived_at = clock_timestamp(),
      pii_archived_by = _actor_id,
      pii_archive_reason = _reason_clean,
      updated_at = clock_timestamp()
  WHERE user_id = _client_id
  RETURNING pii_archived_at INTO _archived_at;

  UPDATE public.client_profiles
  SET age = NULL,
      gender = NULL,
      interests = ARRAY[]::TEXT[],
      conversation_preferences = NULL,
      first_name = NULL,
      last_name = NULL,
      date_of_birth = NULL,
      computed_age = NULL,
      city_id = NULL,
      bio = NULL,
      relationship_status = NULL,
      smoking_status = NULL,
      preferred_min_age = NULL,
      preferred_max_age = NULL,
      preferred_distance_km = NULL,
      content_preferences = '[]'::JSONB,
      character_preferences = '[]'::JSONB,
      profile_image_url = NULL,
      profile_image_urls = ARRAY[]::TEXT[],
      updated_at = clock_timestamp()
  WHERE user_id = _client_id;

  UPDATE public.conversation_handling_cycles cycle
  SET ended_at = clock_timestamp(),
      end_reason = 'closed'
  FROM public.conversations conversation
  WHERE cycle.conversation_id = conversation.id
    AND conversation.client_id = _client_id
    AND cycle.ended_at IS NULL;

  UPDATE public.conversation_work_items
  SET status = 'closed',
      responsible_operator_id = NULL,
      assigned_at = NULL,
      updated_at = clock_timestamp()
  WHERE client_id = _client_id
    AND status IN ('new', 'assigned', 'in_progress');

  DELETE FROM public.client_character_preferences WHERE client_id = _client_id;
  DELETE FROM public.client_discovery_cycles WHERE client_id = _client_id;
  DELETE FROM public.client_conversation_deletions WHERE client_id = _client_id;
  DELETE FROM public.conversation_read_states WHERE user_id = _client_id;
  DELETE FROM public.user_active_conversations WHERE user_id = _client_id;
  DELETE FROM public.notifications WHERE user_id = _client_id;
  DELETE FROM public.notification_settings WHERE user_id = _client_id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _actor_id,
    'client.pii_archived',
    'user',
    _client_id::TEXT,
    jsonb_build_object('reason', _reason_clean, 'auth_user_preserved', TRUE, 'pii_redacted', TRUE)
  );

  RETURN jsonb_build_object(
    'archived', TRUE,
    'idempotent_replay', FALSE,
    'archived_at', _archived_at
  );
END;
$function$;

-- Preserved writer contract: public.operator_heartbeat()
CREATE OR REPLACE FUNCTION public.operator_heartbeat()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  _user_id UUID := auth.uid();
  _operator_id UUID;
  _returned_count INTEGER;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT o.id
  INTO _operator_id
  FROM public.operators o
  WHERE o.user_id = _user_id
    AND o.is_active = true
  LIMIT 1;

  IF _operator_id IS NULL THEN
    RAISE EXCEPTION 'operator_record_required';
  END IF;

  _returned_count := private.return_stale_work_items_to_new();

  UPDATE public.operators
  SET last_seen_at = clock_timestamp(),
      presence_status = 'online'
  WHERE id = _operator_id;

  RETURN jsonb_build_object(
    'operator_id', _operator_id,
    'presence_status', 'online',
    'returned_stale_work_items', _returned_count
  );
END;
$function$;

-- Preserved writer contract: public.release_operator_conversation(uuid,text)
CREATE OR REPLACE FUNCTION public.release_operator_conversation(_conversation_id uuid, _reason text DEFAULT 'released'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  _guard RECORD;
  _work_item public.conversation_work_items%ROWTYPE;
  _conversation public.conversations%ROWTYPE;
  _release_reason TEXT := COALESCE(NULLIF(btrim(_reason), ''), 'released');
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF _release_reason NOT IN ('released', 'reassigned') THEN
    RAISE EXCEPTION 'invalid_release_reason';
  END IF;

  -- Keep release aligned with the same active/assignment/lock guard used by sends.
  SELECT *
  INTO _guard
  FROM private.assert_operator_can_send_conversation_message(_conversation_id);

  SELECT *
  INTO _work_item
  FROM public.conversation_work_items
  WHERE conversation_id = _conversation_id
    AND status IN ('assigned', 'in_progress')
  FOR UPDATE;

  IF NOT FOUND OR _work_item.responsible_operator_id <> _guard.operator_id THEN
    RAISE EXCEPTION 'conversation_not_responsible_operator';
  END IF;

  SELECT *
  INTO _conversation
  FROM public.conversations
  WHERE id = _conversation_id
  FOR UPDATE;

  IF _conversation.status = 'closed'::public.conversation_status THEN
    UPDATE public.conversation_handling_cycles
    SET ended_at = clock_timestamp(),
        end_reason = 'closed'
    WHERE work_item_id = _work_item.id
      AND ended_at IS NULL;

    UPDATE public.conversation_work_items
    SET status = 'closed'
    WHERE id = _work_item.id;

    RETURN jsonb_build_object('released', false, 'status', 'closed');
  END IF;

  UPDATE public.conversation_handling_cycles
  SET ended_at = clock_timestamp(),
      end_reason = _release_reason
  WHERE work_item_id = _work_item.id
    AND ended_at IS NULL;

  UPDATE public.conversations
  SET assigned_operator_id = NULL,
      updated_at = clock_timestamp()
  WHERE id = _conversation_id
    AND assigned_operator_id = _guard.operator_id;

  UPDATE public.conversation_work_items
  SET status = 'new',
      responsible_operator_id = NULL,
      assigned_at = NULL,
      last_activity_at = clock_timestamp()
  WHERE id = _work_item.id
  RETURNING * INTO _work_item;

  IF EXISTS (
    SELECT 1
    FROM public.conversation_locks l
    WHERE l.conversation_id = _conversation_id
      AND l.locked_by_operator_id = _guard.operator_id
      AND l.released_at IS NULL
  ) THEN
    PERFORM public.release_conversation_lock(_conversation_id);
  END IF;

  RETURN jsonb_build_object(
    'released', true,
    'work_item_id', _work_item.id,
    'conversation_id', _work_item.conversation_id,
    'status', _work_item.status
  );
END;
$function$;

-- Preserved writer contract: public.return_stale_work_items_to_new()
CREATE OR REPLACE FUNCTION public.return_stale_work_items_to_new()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF auth.uid() IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  RETURN private.return_stale_work_items_to_new();
END;
$function$;

-- Preserved writer contract: public.send_admin_media_message(uuid,text)
CREATE OR REPLACE FUNCTION public.send_admin_media_message(_reservation_id uuid, _caption text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _reservation public.character_media_reservations%ROWTYPE;
  _guard RECORD;
  _result JSONB;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  SELECT * INTO _reservation FROM public.character_media_reservations r WHERE r.id = _reservation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'media_reservation_not_found'; END IF;
  SELECT * INTO _guard FROM private.assert_admin_can_send_conversation_message(_reservation.conversation_id);
  IF _reservation.operator_id <> _guard.operator_id THEN RAISE EXCEPTION 'media_reservation_not_owned'; END IF;
  SELECT public.send_operator_media_message(_reservation_id, _caption, 'permanent') INTO _result;
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_guard.user_id, 'admin_media.message_sent', 'message_attachment',
    COALESCE(_result->'attachment'->>'id', _reservation_id::TEXT),
    jsonb_build_object('actor_kind', 'admin', 'conversation_id', _reservation.conversation_id,
      'reservation_id', _reservation_id, 'already_sent', COALESCE((_result->>'already_sent')::BOOLEAN, FALSE)));
  RETURN _result;
END;
$function$;

-- Preserved writer contract: public.send_admin_sticker_message(uuid,uuid,uuid)
CREATE OR REPLACE FUNCTION public.send_admin_sticker_message(_conversation_id uuid, _sticker_id uuid, _idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  RETURN private.send_sticker_message(
    _conversation_id,
    _sticker_id,
    _idempotency_key,
    'admin'
  );
END;
$function$;

-- Preserved writer contract: public.send_client_message(uuid,text)
CREATE OR REPLACE FUNCTION public.send_client_message(_conversation_id uuid, _content text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  _user_id UUID := auth.uid();
  _content_clean TEXT := btrim(COALESCE(_content, ''));
  _conversation public.conversations%ROWTYPE;
  _credits_enabled BOOLEAN;
  _balance INTEGER;
  _message public.messages%ROWTYPE;
  _payout_operator_id UUID;
  _payout_user_id UUID;
  _payout_balance_after INTEGER;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  PERFORM private.ensure_active_client(_user_id);

  IF char_length(_content_clean) = 0 OR char_length(_content_clean) > 2000 THEN
    RAISE EXCEPTION 'invalid_message_content';
  END IF;

  SELECT *
  INTO _conversation
  FROM public.conversations
  WHERE id = _conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  IF _conversation.client_id <> _user_id THEN
    RAISE EXCEPTION 'conversation_access_denied';
  END IF;

  IF _conversation.status = 'closed'::public.conversation_status THEN
    RAISE EXCEPTION 'conversation_closed';
  END IF;

  IF _conversation.client_hidden_at IS NOT NULL THEN
    RAISE EXCEPTION 'conversation_deleted_for_client';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.client_conversation_deletions
    WHERE client_id = _user_id
      AND conversation_id = _conversation_id
  ) THEN
    RAISE EXCEPTION 'conversation_deleted_for_client';
  END IF;

  _credits_enabled := private.setting_bool('credits_enabled', true);

  SELECT recipient.payout_operator_id, recipient.payout_user_id
  INTO _payout_operator_id, _payout_user_id
  FROM private.resolve_conversation_credit_recipient_operator(_conversation_id) recipient;

  INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
  VALUES (_user_id, 0, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;

  IF _credits_enabled AND _payout_user_id IS NOT NULL AND _payout_user_id <> _user_id THEN
    INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
    VALUES (_payout_user_id, 0, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  IF _credits_enabled THEN
    IF _payout_user_id IS NOT NULL AND _payout_user_id <> _user_id THEN
      IF _user_id < _payout_user_id THEN
        SELECT balance
        INTO _balance
        FROM public.credit_wallets
        WHERE user_id = _user_id
        FOR UPDATE;

        PERFORM 1
        FROM public.credit_wallets
        WHERE user_id = _payout_user_id
        FOR UPDATE;
      ELSE
        PERFORM 1
        FROM public.credit_wallets
        WHERE user_id = _payout_user_id
        FOR UPDATE;

        SELECT balance
        INTO _balance
        FROM public.credit_wallets
        WHERE user_id = _user_id
        FOR UPDATE;
      END IF;
    ELSE
      SELECT balance
      INTO _balance
      FROM public.credit_wallets
      WHERE user_id = _user_id
      FOR UPDATE;
    END IF;

    IF COALESCE(_balance, 0) < 1 THEN
      RAISE EXCEPTION 'insufficient_credits';
    END IF;
  END IF;

  INSERT INTO public.messages (conversation_id, sender_type, sender_id, content, created_at)
  VALUES (_conversation_id, 'client'::public.sender_type, _user_id, _content_clean, clock_timestamp())
  RETURNING * INTO _message;

  IF _credits_enabled THEN
    UPDATE public.credit_wallets
    SET
      balance = balance - 1,
      lifetime_spent = lifetime_spent + 1
    WHERE user_id = _user_id
    RETURNING balance INTO _balance;

    INSERT INTO public.credit_transactions (user_id, amount, balance_after, type, reason, message_id, metadata)
    VALUES (
      _user_id,
      -1,
      _balance,
      'message_spend',
      'Client message spend',
      _message.id,
      jsonb_build_object(
        'conversation_id', _conversation_id,
        'payout_operator_id', _payout_operator_id
      )
    );

    IF _payout_user_id IS NOT NULL AND _payout_user_id <> _user_id THEN
      UPDATE public.credit_wallets
      SET
        balance = balance + 1,
        lifetime_earned = lifetime_earned + 1
      WHERE user_id = _payout_user_id
      RETURNING balance INTO _payout_balance_after;

      INSERT INTO public.credit_transactions (user_id, amount, balance_after, type, reason, message_id, metadata)
      VALUES (
        _payout_user_id,
        1,
        _payout_balance_after,
        'message_payout',
        'Client message payout',
        _message.id,
        jsonb_build_object(
          'conversation_id', _conversation_id,
          'payout_operator_id', _payout_operator_id,
          'source', 'send_client_message'
        )
      );
    END IF;
  ELSE
    SELECT balance INTO _balance
    FROM public.credit_wallets
    WHERE user_id = _user_id;
  END IF;

  RETURN jsonb_build_object(
    'message', to_jsonb(_message),
    'balance', COALESCE(_balance, 0),
    'credits_enabled', _credits_enabled
  );
END;
$function$;

-- Preserved writer contract: public.send_client_sticker_message(uuid,uuid,uuid)
CREATE OR REPLACE FUNCTION public.send_client_sticker_message(_conversation_id uuid, _sticker_id uuid, _idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  _client_id UUID := auth.uid();
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF _client_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  PERFORM private.ensure_active_client(_client_id);
  RETURN private.send_sticker_message(_conversation_id, _sticker_id, _idempotency_key, 'client');
END;
$function$;

-- Preserved writer contract: public.send_operator_locked_media_message(uuid,text)
CREATE OR REPLACE FUNCTION public.send_operator_locked_media_message(_reservation_id uuid, _caption text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _caption_clean TEXT := NULLIF(btrim(COALESCE(_caption, '')), '');
  _conversation_id UUID;
  _asset_id UUID;
  _reservation public.character_media_reservations%ROWTYPE;
  _asset public.character_media_assets%ROWTYPE;
  _guard RECORD;
  _message_result RECORD;
  _attachment public.message_attachments%ROWTYPE;
  _message JSONB;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF NOT private.setting_bool('locked_images_enabled', false) THEN
    RAISE EXCEPTION 'locked_images_disabled';
  END IF;

  IF _caption_clean IS NOT NULL AND char_length(_caption_clean) > 1000 THEN
    RAISE EXCEPTION 'invalid_media_caption';
  END IF;

  SELECT reservation.conversation_id, reservation.media_asset_id
  INTO _conversation_id, _asset_id
  FROM public.character_media_reservations reservation
  WHERE reservation.id = _reservation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_reservation_not_found';
  END IF;

  SELECT * INTO _guard
  FROM private.assert_operator_can_send_conversation_message(_conversation_id);

  PERFORM private.expire_character_media_reservations(NULL, _asset_id);

  SELECT * INTO _asset
  FROM public.character_media_assets asset
  WHERE asset.id = _asset_id
  FOR UPDATE;

  SELECT * INTO _reservation
  FROM public.character_media_reservations reservation
  WHERE reservation.id = _reservation_id
  FOR UPDATE;

  IF _reservation.operator_id <> _guard.operator_id THEN
    RAISE EXCEPTION 'media_reservation_not_owned';
  END IF;

  IF _reservation.intended_access_mode <> 'locked' THEN
    RAISE EXCEPTION 'media_reservation_access_mode_mismatch';
  END IF;

  IF _reservation.state = 'consumed' THEN
    SELECT to_jsonb(message)
    INTO _message
    FROM public.message_attachments attachment
    JOIN public.messages message ON message.id = attachment.message_id
    WHERE attachment.reservation_id = _reservation.id
      AND attachment.access_mode = 'locked';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'media_reservation_consumed_with_different_access_mode';
    END IF;

    RETURN jsonb_build_object('message', _message, 'already_sent', TRUE, 'concurrency_mode', _guard.concurrency_mode);
  END IF;

  IF _reservation.state = 'released' THEN
    RAISE EXCEPTION 'media_reservation_released';
  ELSIF _reservation.state = 'expired' THEN
    RAISE EXCEPTION 'media_reservation_expired';
  ELSIF _reservation.state <> 'active' THEN
    RAISE EXCEPTION 'media_reservation_not_active';
  END IF;

  IF _asset.status <> 'reserved'
    OR _asset.ingest_status <> 'ready'
    OR _asset.locked_price_credits IS NULL
    OR _asset.locked_derivative_status <> 'ready' THEN
    RAISE EXCEPTION 'locked_media_asset_not_ready';
  END IF;

  SELECT * INTO _message_result
  FROM private.create_operator_message_with_scoring(
    _conversation_id,
    _guard.operator_id,
    _guard.user_id,
    COALESCE(_caption_clean, '[image]'),
    jsonb_build_object(
      'source', 'send_operator_locked_media_message',
      'attachment_kind', 'image',
      'access_mode', 'locked'
    )
  );

  INSERT INTO public.message_attachments (
    message_id, media_asset_id, reservation_id, kind, position, caption, access_mode, price_credits_snapshot
  )
  VALUES (
    _message_result.message_id, _asset.id, _reservation.id, 'image', 0, _caption_clean, 'locked', _asset.locked_price_credits
  )
  RETURNING * INTO _attachment;

  UPDATE public.character_media_reservations
  SET state = 'consumed', ended_at = clock_timestamp(), ended_by_user_id = _guard.user_id, ended_reason = 'sent'
  WHERE id = _reservation.id;

  UPDATE public.character_media_assets
  SET status = 'sent', updated_by_user_id = _guard.user_id
  WHERE id = _asset.id AND status = 'reserved';

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES
    (_guard.user_id, 'character_media_reservation.consumed', 'character_media_reservation', _reservation.id::TEXT,
      jsonb_build_object('media_asset_id', _asset.id, 'message_id', _message_result.message_id, 'access_mode', 'locked')),
    (_guard.user_id, 'message_attachment.created', 'message_attachment', _attachment.id::TEXT,
      jsonb_build_object('message_id', _message_result.message_id, 'kind', 'image', 'access_mode', 'locked'));

  RETURN jsonb_build_object(
    'message', _message_result.message,
    'already_sent', FALSE,
    'score_awarded', _message_result.score_awarded,
    'streak_position', _message_result.streak_position,
    'consecutive_message_limit', _message_result.consecutive_message_limit,
    'monthly_points', _message_result.monthly_points,
    'scoring_enabled', _message_result.scoring_enabled,
    'concurrency_mode', _guard.concurrency_mode
  );
END;
$function$;

-- Preserved writer contract: public.send_operator_media_message(uuid,text,text)
CREATE OR REPLACE FUNCTION public.send_operator_media_message(_reservation_id uuid, _caption text DEFAULT NULL::text, _view_mode text DEFAULT 'permanent'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _caption_clean TEXT := NULLIF(btrim(COALESCE(_caption, '')), '');
  _view_mode_clean TEXT := lower(btrim(COALESCE(_view_mode, 'permanent')));
  _conversation_id UUID;
  _asset_id UUID;
  _reservation public.character_media_reservations%ROWTYPE;
  _asset public.character_media_assets%ROWTYPE;
  _guard RECORD;
  _message_result RECORD;
  _attachment public.message_attachments%ROWTYPE;
  _message JSONB;
  _idempotent_result JSONB;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF _caption_clean IS NOT NULL AND char_length(_caption_clean) > 1000 THEN
    RAISE EXCEPTION 'invalid_media_caption';
  END IF;
  IF _view_mode_clean NOT IN ('permanent', 'view_once', 'paid_open') THEN
    RAISE EXCEPTION 'invalid_media_view_mode';
  END IF;

  SELECT reservation.conversation_id, reservation.media_asset_id
  INTO _conversation_id, _asset_id
  FROM public.character_media_reservations reservation
  WHERE reservation.id = _reservation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'media_reservation_not_found'; END IF;

  SELECT * INTO _guard
  FROM private.assert_operator_can_send_conversation_message(_conversation_id);
  PERFORM private.expire_character_media_reservations(NULL, _asset_id);

  SELECT * INTO _asset FROM public.character_media_assets asset WHERE asset.id = _asset_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'media_asset_not_found'; END IF;
  SELECT * INTO _reservation FROM public.character_media_reservations reservation WHERE reservation.id = _reservation_id FOR UPDATE;
  IF _reservation.operator_id <> _guard.operator_id THEN RAISE EXCEPTION 'media_reservation_not_owned'; END IF;

  IF _reservation.state = 'consumed' THEN
    SELECT to_jsonb(message) INTO _message
    FROM public.message_attachments attachment JOIN public.messages message ON message.id = attachment.message_id
    WHERE attachment.reservation_id = _reservation.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'media_reservation_consumed_without_attachment'; END IF;

    SELECT jsonb_build_object(
      'message', _message,
      'attachment', jsonb_build_object(
        'id', attachment.id, 'message_id', attachment.message_id, 'kind', attachment.kind, 'position', attachment.position,
        'caption', attachment.caption, 'metadata', attachment.metadata, 'view_mode', attachment.view_mode, 'created_at', attachment.created_at
      ),
      'already_sent', true, 'concurrency_mode', _guard.concurrency_mode
    ) INTO _idempotent_result
    FROM public.message_attachments attachment
    WHERE attachment.reservation_id = _reservation.id AND attachment.view_mode = _view_mode_clean;
    IF NOT FOUND THEN RAISE EXCEPTION 'media_reservation_view_mode_conflict'; END IF;
    RETURN _idempotent_result;
  END IF;

  IF _reservation.state = 'released' THEN RAISE EXCEPTION 'media_reservation_released';
  ELSIF _reservation.state = 'expired' THEN RAISE EXCEPTION 'media_reservation_expired';
  ELSIF _reservation.state <> 'active' THEN RAISE EXCEPTION 'media_reservation_not_active';
  END IF;
  IF _asset.status <> 'reserved' THEN RAISE EXCEPTION 'media_asset_not_reserved'; END IF;
  IF _asset.ingest_status <> 'ready' THEN RAISE EXCEPTION 'media_asset_not_ready'; END IF;
  IF _view_mode_clean IN ('view_once', 'paid_open') AND _reservation.intended_access_mode <> 'standard' THEN
    RAISE EXCEPTION 'view_mode_requires_standard_media';
  END IF;
  IF _view_mode_clean = 'paid_open' AND COALESCE(_asset.paid_open_price_credits, 0) <= 0 THEN
    RAISE EXCEPTION 'paid_open_requires_positive_price';
  END IF;

  SELECT * INTO _message_result
  FROM private.create_operator_message_with_scoring(
    _conversation_id, _guard.operator_id, _guard.user_id, COALESCE(_caption_clean, '[image]'),
    jsonb_build_object('source', 'send_operator_media_message', 'attachment_kind', 'image', 'view_mode', _view_mode_clean)
  );

  INSERT INTO public.message_attachments (
    message_id, media_asset_id, reservation_id, kind, position, caption, view_mode, price_credits_snapshot
  ) VALUES (
    _message_result.message_id, _asset.id, _reservation.id, 'image', 0, _caption_clean, _view_mode_clean,
    CASE WHEN _view_mode_clean = 'paid_open' THEN _asset.paid_open_price_credits ELSE NULL END
  ) RETURNING * INTO _attachment;

  UPDATE public.character_media_reservations
  SET state = 'consumed', ended_at = clock_timestamp(), ended_by_user_id = _guard.user_id, ended_reason = 'sent'
  WHERE id = _reservation.id;
  UPDATE public.character_media_assets
  SET status = 'sent', updated_by_user_id = _guard.user_id
  WHERE id = _asset.id AND status = 'reserved';

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES
    (_guard.user_id, 'character_media_reservation.consumed', 'character_media_reservation', _reservation.id::TEXT,
      jsonb_build_object('media_asset_id', _asset.id, 'message_id', _message_result.message_id, 'view_mode', _view_mode_clean)),
    (_guard.user_id, 'message_attachment.created', 'message_attachment', _attachment.id::TEXT,
      jsonb_build_object('message_id', _message_result.message_id, 'kind', 'image', 'view_mode', _view_mode_clean));

  RETURN jsonb_build_object(
    'message', _message_result.message,
    'attachment', jsonb_build_object(
      'id', _attachment.id, 'message_id', _attachment.message_id, 'kind', _attachment.kind, 'position', _attachment.position,
      'caption', _attachment.caption, 'metadata', _attachment.metadata, 'view_mode', _attachment.view_mode, 'created_at', _attachment.created_at
    ),
    'already_sent', false, 'score_awarded', _message_result.score_awarded,
    'streak_position', _message_result.streak_position, 'consecutive_message_limit', _message_result.consecutive_message_limit,
    'monthly_points', _message_result.monthly_points, 'scoring_enabled', _message_result.scoring_enabled,
    'concurrency_mode', _guard.concurrency_mode
  );
END;
$function$;

-- Preserved writer contract: public.send_operator_message(uuid,text)
CREATE OR REPLACE FUNCTION public.send_operator_message(_conversation_id uuid, _content text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  _content_clean TEXT := btrim(COALESCE(_content, ''));
  _guard RECORD;
  _message_result RECORD;
  _credit_awarded INTEGER := 0;
  _balance_after INTEGER;
  _is_admin BOOLEAN := public.is_admin();
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF char_length(_content_clean) = 0 OR char_length(_content_clean) > 2000 THEN
    RAISE EXCEPTION 'invalid_message_content';
  END IF;

  SELECT * INTO _guard
  FROM private.assert_operator_can_send_conversation_message(_conversation_id);

  SELECT * INTO _message_result
  FROM private.create_operator_message_with_scoring(
    _conversation_id,
    _guard.operator_id,
    _guard.user_id,
    _content_clean,
    jsonb_build_object('source', 'send_operator_message')
  );

  -- Admins may send through the operator identity for attribution, but never earn credits.
  IF _message_result.score_awarded > 0 AND _is_admin IS NOT TRUE THEN
    INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
    VALUES (_guard.user_id, 0, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;

    IF NOT EXISTS (
      SELECT 1
      FROM public.credit_transactions transaction
      WHERE transaction.message_id = _message_result.message_id
        AND transaction.type = 'operator_message_payout'
    ) THEN
      UPDATE public.credit_wallets
      SET
        balance = balance + 1,
        lifetime_earned = lifetime_earned + 1
      WHERE user_id = _guard.user_id
      RETURNING balance INTO _balance_after;

      INSERT INTO public.credit_transactions (
        user_id,
        amount,
        balance_after,
        type,
        reason,
        message_id,
        metadata
      )
      VALUES (
        _guard.user_id,
        1,
        _balance_after,
        'operator_message_payout',
        'Operator message payout',
        _message_result.message_id,
        jsonb_build_object(
          'conversation_id', _conversation_id,
          'operator_id', _guard.operator_id,
          'source', 'send_operator_message'
        )
      );

      _credit_awarded := 1;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'message', _message_result.message,
    'score_awarded', _message_result.score_awarded,
    'credit_awarded', _credit_awarded,
    'streak_position', _message_result.streak_position,
    'consecutive_message_limit', _message_result.consecutive_message_limit,
    'monthly_points', _message_result.monthly_points,
    'scoring_enabled', _message_result.scoring_enabled,
    'concurrency_mode', _guard.concurrency_mode
  );
END;
$function$;

-- Preserved writer contract: public.send_operator_sticker_message(uuid,uuid,uuid)
CREATE OR REPLACE FUNCTION public.send_operator_sticker_message(
  _conversation_id UUID,
  _sticker_id UUID,
  _idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  RETURN private.send_sticker_message(
    _conversation_id,
    _sticker_id,
    _idempotency_key,
    'operator'
  );
END;
$$;

-- Preserved writer contract: public.start_operator_outreach(uuid,uuid,text,text)
CREATE OR REPLACE FUNCTION public.start_operator_outreach(_client_id uuid, _character_id uuid, _message text, _idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  _user_id UUID := auth.uid();
  _operator_id UUID;
  _message_clean TEXT := btrim(COALESCE(_message, ''));
  _idempotency_key_clean TEXT := btrim(COALESCE(_idempotency_key, ''));
  _attempt public.operator_outreach_attempts%ROWTYPE;
  _conversation_id UUID;
  _message_id UUID;
  _character_is_available BOOLEAN;
  _result JSONB;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF _client_id IS NULL OR _character_id IS NULL THEN
    RAISE EXCEPTION 'invalid_outreach_target';
  END IF;

  IF char_length(_message_clean) = 0 OR char_length(_message_clean) > 2000 THEN
    RAISE EXCEPTION 'invalid_outreach_message';
  END IF;

  IF char_length(_idempotency_key_clean) = 0 OR char_length(_idempotency_key_clean) > 200 THEN
    RAISE EXCEPTION 'invalid_outreach_idempotency_key';
  END IF;

  SELECT o.id
  INTO _operator_id
  FROM public.operators o
  WHERE o.user_id = _user_id
    AND o.is_active = true
  LIMIT 1;

  IF _operator_id IS NULL THEN
    RAISE EXCEPTION 'operator_record_required';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(_operator_id::TEXT),
    hashtext(_idempotency_key_clean)
  );

  SELECT *
  INTO _attempt
  FROM public.operator_outreach_attempts attempt
  WHERE attempt.operator_id = _operator_id
    AND attempt.idempotency_key = _idempotency_key_clean
  FOR UPDATE;

  IF FOUND THEN
    IF _attempt.client_id <> _client_id
       OR _attempt.character_id <> _character_id
       OR _attempt.message_content <> _message_clean THEN
      RAISE EXCEPTION 'outreach_idempotency_key_reused';
    END IF;

    RETURN _attempt.result || jsonb_build_object('idempotent_replay', true);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.character_operator_assignments coa
    WHERE coa.operator_id = _operator_id
      AND coa.character_id = _character_id
  ) THEN
    RAISE EXCEPTION 'operator_not_assigned_to_character';
  END IF;

  SELECT ch.is_active AND ch.is_visible
  INTO _character_is_available
  FROM public.characters ch
  WHERE ch.id = _character_id;

  IF _character_is_available IS NOT TRUE THEN
    RAISE EXCEPTION 'outreach_character_not_available';
  END IF;

  PERFORM private.ensure_active_client(_client_id);

  IF EXISTS (
    SELECT 1
    FROM public.operator_client_blocks block
    WHERE block.operator_id = _operator_id
      AND block.client_id = _client_id
  ) THEN
    RAISE EXCEPTION 'client_blocked_by_operator';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(_operator_id::TEXT),
    hashtext(_client_id::TEXT || ':' || _character_id::TEXT)
  );

  IF EXISTS (
    SELECT 1
    FROM public.operator_outreach_attempts attempt
    WHERE attempt.operator_id = _operator_id
      AND attempt.client_id = _client_id
      AND attempt.character_id = _character_id
      AND attempt.status = 'sent'
      AND attempt.created_at >= clock_timestamp() - INTERVAL '24 hours'
  ) THEN
    RAISE EXCEPTION 'outreach_rate_limited';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.conversation_work_items wi
    JOIN public.conversations c ON c.id = wi.conversation_id
    WHERE wi.client_id = _client_id
      AND wi.character_id = _character_id
      AND wi.status = 'new'
      AND c.status <> 'closed'::public.conversation_status
  ) THEN
    RAISE EXCEPTION 'outreach_pending_new_exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.conversation_handling_cycles cycle
    JOIN public.conversations c ON c.id = cycle.conversation_id
    WHERE c.client_id = _client_id
      AND c.character_id = _character_id
      AND cycle.ended_at IS NULL
  ) THEN
    RAISE EXCEPTION 'outreach_conversation_in_progress';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(_client_id::TEXT),
    hashtext(_character_id::TEXT)
  );

  SELECT c.id
  INTO _conversation_id
  FROM public.conversations c
  WHERE c.client_id = _client_id
    AND c.character_id = _character_id
    AND c.status <> 'closed'::public.conversation_status
    AND c.client_hidden_at IS NULL
  ORDER BY c.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF _conversation_id IS NULL THEN
    INSERT INTO public.conversations (
      client_id,
      character_id,
      assigned_operator_id,
      status,
      client_hidden_at
    )
    VALUES (
      _client_id,
      _character_id,
      NULL,
      'open'::public.conversation_status,
      NULL
    )
    ON CONFLICT (client_id, character_id)
    WHERE status <> 'closed'::public.conversation_status
      AND client_hidden_at IS NULL
    DO NOTHING
    RETURNING id INTO _conversation_id;

    IF _conversation_id IS NULL THEN
      SELECT c.id
      INTO _conversation_id
      FROM public.conversations c
      WHERE c.client_id = _client_id
        AND c.character_id = _character_id
        AND c.status <> 'closed'::public.conversation_status
        AND c.client_hidden_at IS NULL
      ORDER BY c.created_at DESC
      LIMIT 1
      FOR UPDATE;
    END IF;
  END IF;

  IF _conversation_id IS NULL THEN
    RAISE EXCEPTION 'outreach_conversation_creation_conflict';
  END IF;

  -- Outreach is never an eligible operator-message credit event. The normal
  -- message trigger still updates conversation state and unread counters.
  INSERT INTO public.messages (
    conversation_id,
    sender_type,
    sender_id,
    operator_id,
    content
  )
  VALUES (
    _conversation_id,
    'operator'::public.sender_type,
    _user_id,
    _operator_id,
    _message_clean
  )
  RETURNING id INTO _message_id;

  _result := jsonb_build_object(
    'outreach_id', gen_random_uuid(),
    'conversation_id', _conversation_id,
    'message_id', _message_id,
    'status', 'sent',
    'idempotent_replay', false
  );

  INSERT INTO public.operator_outreach_attempts (
    id,
    operator_id,
    client_id,
    character_id,
    conversation_id,
    message_id,
    idempotency_key,
    message_content,
    status,
    result
  )
  VALUES (
    (_result->>'outreach_id')::UUID,
    _operator_id,
    _client_id,
    _character_id,
    _conversation_id,
    _message_id,
    _idempotency_key_clean,
    _message_clean,
    'sent',
    _result
  );

  INSERT INTO public.audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    metadata
  )
  VALUES (
    _user_id,
    'operator_outreach_started',
    'conversation',
    _conversation_id,
    jsonb_build_object(
      'operator_id', _operator_id,
      'client_id', _client_id,
      'character_id', _character_id,
      'outreach_id', _result->>'outreach_id'
    )
  );

  RETURN _result;
END;
$function$;


CREATE OR REPLACE FUNCTION public.claim_new_conversation(_work_item_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _guard RECORD;
  _work_item public.conversation_work_items%ROWTYPE;
  _active_cycle public.conversation_handling_cycles%ROWTYPE;
  _active_cycle_count INTEGER;
  _conversation_id UUID;
  _conversation_operator_id UUID;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();

  SELECT work_item.conversation_id
  INTO _conversation_id
  FROM public.conversation_work_items work_item
  WHERE work_item.id = _work_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'work_item_not_found';
  END IF;

  SELECT *
  INTO _guard
  FROM private.assert_operator_can_claim_conversation(_conversation_id);

  SELECT *
  INTO _work_item
  FROM public.conversation_work_items work_item
  WHERE work_item.id = _work_item_id
    AND work_item.conversation_id = _conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'work_item_not_found';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.operator_client_blocks block
    WHERE block.operator_id = _guard.operator_id
      AND block.client_id = _work_item.client_id
  ) THEN
    RAISE EXCEPTION 'client_blocked_by_operator';
  END IF;

  IF _work_item.status <> 'new' THEN
    IF _work_item.responsible_operator_id IS DISTINCT FROM _guard.operator_id THEN
      RAISE EXCEPTION 'conversation_already_claimed';
    END IF;

    SELECT count(*)::INTEGER
    INTO _active_cycle_count
    FROM public.conversation_handling_cycles cycle
    WHERE cycle.conversation_id = _work_item.conversation_id
      AND cycle.ended_at IS NULL
      AND cycle.work_item_id = _work_item.id
      AND cycle.operator_id = _guard.operator_id;

    IF _active_cycle_count = 1 THEN
      SELECT *
      INTO _active_cycle
      FROM public.conversation_handling_cycles cycle
      WHERE cycle.conversation_id = _work_item.conversation_id
        AND cycle.ended_at IS NULL
        AND cycle.work_item_id = _work_item.id
        AND cycle.operator_id = _guard.operator_id;
    END IF;

    SELECT conversation.assigned_operator_id
    INTO _conversation_operator_id
    FROM public.conversations conversation
    WHERE conversation.id = _work_item.conversation_id;

    IF _work_item.status <> 'assigned'
       OR _active_cycle_count <> 1
       OR _active_cycle.id IS NULL
       OR _conversation_operator_id IS DISTINCT FROM _guard.operator_id
    THEN
      RAISE EXCEPTION 'conversation_claim_state_inconsistent';
    END IF;

    RETURN jsonb_build_object(
      'claimed', TRUE,
      'already_claimed', TRUE,
      'work_item_id', _work_item.id,
      'conversation_id', _work_item.conversation_id,
      'status', _work_item.status,
      'cycle_id', _active_cycle.id
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.conversation_handling_cycles cycle
    WHERE cycle.conversation_id = _work_item.conversation_id
      AND cycle.ended_at IS NULL
  ) THEN
    RAISE EXCEPTION 'conversation_already_claimed';
  END IF;

  UPDATE public.conversations
  SET assigned_operator_id = _guard.operator_id,
      updated_at = clock_timestamp()
  WHERE id = _work_item.conversation_id;

  UPDATE public.conversation_work_items
  SET status = 'assigned',
      responsible_operator_id = _guard.operator_id,
      assigned_at = clock_timestamp()
  WHERE id = _work_item.id
  RETURNING * INTO _work_item;

  INSERT INTO public.conversation_handling_cycles (
    conversation_id,
    work_item_id,
    operator_id,
    started_at
  )
  VALUES (
    _work_item.conversation_id,
    _work_item.id,
    _guard.operator_id,
    clock_timestamp()
  )
  RETURNING * INTO _active_cycle;

  RETURN jsonb_build_object(
    'claimed', TRUE,
    'already_claimed', FALSE,
    'work_item_id', _work_item.id,
    'conversation_id', _work_item.conversation_id,
    'status', _work_item.status,
    'cycle_id', _active_cycle.id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_new_conversation(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_new_conversation(UUID) TO authenticated;

DO $$
DECLARE
  _remaining_callers TEXT;
BEGIN
  SELECT string_agg(procedure.oid::regprocedure::TEXT, ', ' ORDER BY procedure.oid::regprocedure::TEXT)
  INTO _remaining_callers
  FROM pg_proc procedure
  WHERE procedure.oid <> 'private.assert_operator_can_send_conversation_message(uuid,boolean)'::regprocedure
    AND procedure.prosrc ~ 'assert_operator_can_send_conversation_message[[:space:]]*\([^;]*,[[:space:]]*(TRUE|FALSE)';

  IF _remaining_callers IS NOT NULL THEN
    RAISE EXCEPTION 'obsolete_operator_guard_overload_still_referenced: %', _remaining_callers;
  END IF;
END;
$$;

DROP FUNCTION private.assert_operator_can_send_conversation_message(UUID, BOOLEAN);

NOTIFY pgrst, 'reload schema';
