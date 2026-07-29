-- Legacy SLA reads must never create notifications. The _notify argument is
-- retained for RPC compatibility, but is intentionally a no-op.
CREATE OR REPLACE FUNCTION public.get_sla_risk_conversations(
  _limit INTEGER DEFAULT 20,
  _notify BOOLEAN DEFAULT false
)
RETURNS TABLE (
  conversation_id UUID,
  character_id UUID,
  character_name TEXT,
  character_avatar_url TEXT,
  client_id UUID,
  client_display_name TEXT,
  status public.conversation_status,
  last_client_message_at TIMESTAMPTZ,
  minutes_waiting INTEGER,
  last_message_preview TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _role public.app_role;
  _operator_id UUID;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  _role := public.get_my_role();

  IF _role NOT IN ('operator'::public.app_role, 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'not_allowed';
  END IF;

  IF _role = 'operator'::public.app_role THEN
    SELECT operator.id
    INTO _operator_id
    FROM public.operators operator
    WHERE operator.user_id = _user_id
      AND operator.is_active = TRUE
      AND operator.deleted_at IS NULL
    LIMIT 1;

    IF _operator_id IS NULL THEN
      RAISE EXCEPTION 'operator_record_required';
    END IF;
  END IF;

  -- _notify is deliberately ignored: read RPCs do not create Bell rows.
  RETURN QUERY
  SELECT
    work_item.conversation_id,
    work_item.character_id,
    character.name,
    character.avatar_url,
    work_item.client_id,
    profile.display_name,
    conversation.status,
    client_message.created_at,
    FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - client_message.created_at)) / 60)::INTEGER,
    COALESCE(conversation.last_message_preview, client_message.content, '')
  FROM public.conversation_work_items work_item
  JOIN public.conversations conversation ON conversation.id = work_item.conversation_id
  JOIN public.characters character ON character.id = work_item.character_id
  JOIN public.messages client_message ON client_message.id = work_item.last_client_message_id
  JOIN public.profiles profile ON profile.user_id = work_item.client_id
  WHERE work_item.status = 'new'
    AND conversation.status <> 'closed'::public.conversation_status
    AND profile.status = 'active'
    AND profile.deleted_at IS NULL
    AND profile.pii_archived_at IS NULL
    AND client_message.sender_type = 'client'::public.sender_type
    AND client_message.created_at <= clock_timestamp() - INTERVAL '15 minutes'
    AND NOT EXISTS (
      SELECT 1
      FROM public.conversation_handling_cycles cycle
      WHERE cycle.work_item_id = work_item.id
        AND cycle.ended_at IS NULL
    )
    AND (
      _role = 'admin'::public.app_role
      OR EXISTS (
        SELECT 1
        FROM public.character_operator_assignments assignment
        WHERE assignment.character_id = work_item.character_id
          AND assignment.operator_id = _operator_id
      )
    )
    AND (
      _role = 'admin'::public.app_role
      OR NOT EXISTS (
        SELECT 1
        FROM public.operator_client_blocks block
        WHERE block.operator_id = _operator_id
          AND block.client_id = work_item.client_id
      )
    )
  ORDER BY client_message.created_at ASC
  LIMIT LEAST(GREATEST(COALESCE(_limit, 20), 1), 100);
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_on_new_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _client_user UUID;
  _character_id UUID;
  _operator RECORD;
BEGIN
  SELECT conversation.client_id, conversation.character_id
  INTO _client_user, _character_id
  FROM public.conversations conversation
  WHERE conversation.id = NEW.conversation_id;

  IF NEW.sender_type = 'client'::public.sender_type THEN
    FOR _operator IN
      SELECT DISTINCT operator.user_id
      FROM public.character_operator_assignments assignment
      JOIN public.operators operator ON operator.id = assignment.operator_id
      WHERE assignment.character_id = _character_id
        AND operator.is_active = TRUE
        AND operator.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.operator_client_blocks block
          WHERE block.operator_id = assignment.operator_id
            AND block.client_id = _client_user
        )
    LOOP
      IF _operator.user_id IS DISTINCT FROM NEW.sender_id THEN
        PERFORM public.create_notification(
          _operator.user_id,
          'new_message',
          'הודעה חדשה',
          LEFT(NEW.content, 120),
          '/operator/chat/' || NEW.conversation_id::text,
          NEW.conversation_id,
          jsonb_build_object('sender_type', NEW.sender_type, 'message_id', NEW.id),
          120
        );
      END IF;
    END LOOP;
  ELSIF NEW.sender_type = 'operator'::public.sender_type THEN
    IF _client_user IS NOT NULL THEN
      PERFORM public.create_notification(
        _client_user,
        'new_message',
        'הודעה חדשה',
        LEFT(NEW.content, 120),
        '/app/chat/' || NEW.conversation_id::text,
        NEW.conversation_id,
        jsonb_build_object('sender_type', NEW.sender_type, 'message_id', NEW.id, 'operator_id', NEW.operator_id),
        120
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.get_sla_risk_conversations(INTEGER, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sla_risk_conversations(INTEGER, BOOLEAN) TO authenticated;

REVOKE ALL ON FUNCTION public.notify_on_new_message() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
