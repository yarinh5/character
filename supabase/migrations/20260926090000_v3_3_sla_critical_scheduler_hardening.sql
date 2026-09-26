-- Harden the SLA-critical notification path before any scheduler is enabled.
-- This migration deliberately creates no pg_cron extension or cron job.

CREATE OR REPLACE FUNCTION private.create_new_sla_critical_notification(
  _user_id UUID,
  _conversation_id UUID,
  _work_item_id UUID,
  _last_client_message_id UUID,
  _operator_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _dedupe_key TEXT;
  _notification_id UUID;
BEGIN
  IF _user_id IS NULL
    OR _conversation_id IS NULL
    OR _work_item_id IS NULL
    OR _last_client_message_id IS NULL
    OR _operator_id IS NULL THEN
    RETURN 'suppressed';
  END IF;

  DELETE FROM public.user_active_conversations
  WHERE expires_at < clock_timestamp();

  IF EXISTS (
    SELECT 1
    FROM public.user_active_conversations active_conversation
    WHERE active_conversation.user_id = _user_id
      AND active_conversation.conversation_id = _conversation_id
      AND active_conversation.expires_at > clock_timestamp()
  ) OR private.notification_enabled(_user_id, 'new_sla_critical') IS NOT TRUE THEN
    RETURN 'suppressed';
  END IF;

  _dedupe_key := format(
    'new_sla_critical:%s:%s:%s',
    _work_item_id,
    _last_client_message_id,
    _operator_id
  );

  INSERT INTO public.notifications (
    user_id,
    type,
    title,
    body,
    link,
    conversation_id,
    metadata
  )
  VALUES (
    _user_id,
    'new_sla_critical',
    'פנייה חורגת מ-SLA',
    'פנייה חדשה ממתינה יותר מ-15 דקות.',
    '/operator/chat/' || _conversation_id::TEXT,
    _conversation_id,
    jsonb_build_object(
      'dedupe_key', _dedupe_key,
      'work_item_id', _work_item_id,
      'last_client_message_id', _last_client_message_id,
      'sla_state', 'critical'
    )
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO _notification_id;

  IF _notification_id IS NOT NULL THEN
    RETURN 'created';
  END IF;

  RETURN 'deduplicated';
END;
$$;

CREATE OR REPLACE FUNCTION private.process_new_sla_critical_notifications(
  _batch_limit INTEGER DEFAULT 100
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _candidate RECORD;
  _item RECORD;
  _operator RECORD;
  _outcome TEXT;
  _limit INTEGER := LEAST(GREATEST(COALESCE(_batch_limit, 100), 1), 100);
  _work_items_examined INTEGER := 0;
  _recipients_attempted INTEGER := 0;
  _notifications_created INTEGER := 0;
  _notifications_deduplicated INTEGER := 0;
  _notifications_suppressed INTEGER := 0;
BEGIN
  FOR _candidate IN
    SELECT
      work_item.id AS work_item_id,
      client_message.created_at AS client_message_created_at
    FROM public.conversation_work_items work_item
    JOIN public.messages client_message
      ON client_message.id = work_item.last_client_message_id
    WHERE work_item.status = 'new'
      AND client_message.sender_type = 'client'::public.sender_type
      AND client_message.created_at <= clock_timestamp() - INTERVAL '15 minutes'
    ORDER BY client_message.created_at ASC, work_item.id ASC
    LIMIT _limit
    FOR UPDATE OF work_item SKIP LOCKED
  LOOP
    _work_items_examined := _work_items_examined + 1;

    -- Re-read all eligibility predicates after the work-item row lock is held.
    SELECT
      work_item.id AS work_item_id,
      work_item.conversation_id,
      work_item.client_id,
      work_item.character_id,
      client_message.id AS client_message_id
    INTO _item
    FROM public.conversation_work_items work_item
    JOIN public.conversations conversation
      ON conversation.id = work_item.conversation_id
    JOIN public.profiles profile
      ON profile.user_id = work_item.client_id
    JOIN public.messages client_message
      ON client_message.id = work_item.last_client_message_id
    WHERE work_item.id = _candidate.work_item_id
      AND work_item.status = 'new'
      AND conversation.status <> 'closed'::public.conversation_status
      AND profile.status = 'active'
      AND profile.deleted_at IS NULL
      AND profile.pii_archived_at IS NULL
      AND client_message.sender_type = 'client'::public.sender_type
      AND client_message.created_at <= clock_timestamp() - INTERVAL '15 minutes'
      AND client_message.id = (
        SELECT latest_message.id
        FROM public.messages latest_message
        WHERE latest_message.conversation_id = work_item.conversation_id
        ORDER BY latest_message.created_at DESC, latest_message.id DESC
        LIMIT 1
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.conversation_handling_cycles cycle
        WHERE cycle.work_item_id = work_item.id
          AND cycle.ended_at IS NULL
      );

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    FOR _operator IN
      SELECT operator.id AS operator_id, operator.user_id
      FROM public.character_operator_assignments assignment
      JOIN public.operators operator ON operator.id = assignment.operator_id
      WHERE assignment.character_id = _item.character_id
        AND operator.is_active IS TRUE
        AND operator.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.operator_client_blocks block
          WHERE block.operator_id = operator.id
            AND block.client_id = _item.client_id
        )
    LOOP
      -- Revalidate the recipient immediately before its notification attempt.
      IF NOT EXISTS (
        SELECT 1
        FROM public.character_operator_assignments assignment
        JOIN public.operators operator ON operator.id = assignment.operator_id
        WHERE assignment.character_id = _item.character_id
          AND assignment.operator_id = _operator.operator_id
          AND operator.is_active IS TRUE
          AND operator.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM public.operator_client_blocks block
            WHERE block.operator_id = operator.id
              AND block.client_id = _item.client_id
          )
      ) THEN
        CONTINUE;
      END IF;

      _recipients_attempted := _recipients_attempted + 1;
      _outcome := private.create_new_sla_critical_notification(
        _operator.user_id,
        _item.conversation_id,
        _item.work_item_id,
        _item.client_message_id,
        _operator.operator_id
      );

      CASE _outcome
        WHEN 'created' THEN _notifications_created := _notifications_created + 1;
        WHEN 'deduplicated' THEN _notifications_deduplicated := _notifications_deduplicated + 1;
        ELSE _notifications_suppressed := _notifications_suppressed + 1;
      END CASE;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'lock_acquired', TRUE,
    'work_items_examined', _work_items_examined,
    'recipients_attempted', _recipients_attempted,
    'notifications_created', _notifications_created,
    'notifications_deduplicated', _notifications_deduplicated,
    'notifications_suppressed', _notifications_suppressed
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.run_new_sla_critical_scheduler()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('private.run_new_sla_critical_scheduler')) THEN
    RETURN jsonb_build_object(
      'status', 'skipped_due_to_lock',
      'lock_acquired', FALSE,
      'work_items_examined', 0,
      'recipients_attempted', 0,
      'notifications_created', 0,
      'notifications_deduplicated', 0,
      'notifications_suppressed', 0
    );
  END IF;

  PERFORM set_config('statement_timeout', '45s', TRUE);

  RETURN private.process_new_sla_critical_notifications(100)
    || jsonb_build_object('status', 'completed');
END;
$$;

CREATE OR REPLACE FUNCTION private.emit_new_sla_critical_notifications()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _result JSONB;
BEGIN
  _result := private.run_new_sla_critical_scheduler();
  RETURN COALESCE((_result ->> 'notifications_created')::INTEGER, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.emit_new_sla_critical_notifications()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF public.is_admin() IS NOT TRUE THEN
      RAISE EXCEPTION 'admin_required';
    END IF;
  ELSIF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  RETURN private.emit_new_sla_critical_notifications();
END;
$$;

REVOKE ALL ON FUNCTION private.create_new_sla_critical_notification(UUID, UUID, UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.process_new_sla_critical_notifications(INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.run_new_sla_critical_scheduler()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.emit_new_sla_critical_notifications()
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.emit_new_sla_critical_notifications() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.emit_new_sla_critical_notifications() TO authenticated;

NOTIFY pgrst, 'reload schema';
