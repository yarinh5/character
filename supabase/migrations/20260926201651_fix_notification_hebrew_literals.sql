-- Repair Hebrew notification literals with PostgreSQL Unicode escapes so the
-- migration transport cannot alter the stored UTF-8 text.

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
          U&'\05D4\05D5\05D3\05E2\05D4 \05D7\05D3\05E9\05D4',
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
        U&'\05D4\05D5\05D3\05E2\05D4 \05D7\05D3\05E9\05D4',
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

CREATE OR REPLACE FUNCTION private.emit_new_available_notifications(
  _work_item_id UUID,
  _last_client_message_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _item RECORD;
  _operator RECORD;
  _sent_count INTEGER := 0;
  _notification_id UUID;
BEGIN
  SELECT
    work_item.id,
    work_item.conversation_id,
    work_item.client_id,
    work_item.character_id,
    client_message.id AS client_message_id
  INTO _item
  FROM public.conversation_work_items work_item
  JOIN public.conversations conversation ON conversation.id = work_item.conversation_id
  JOIN public.profiles profile ON profile.user_id = work_item.client_id
  JOIN public.messages client_message ON client_message.id = work_item.last_client_message_id
  WHERE work_item.id = _work_item_id
    AND work_item.status = 'new'
    AND work_item.last_client_message_id = _last_client_message_id
    AND conversation.status <> 'closed'::public.conversation_status
    AND profile.status = 'active'
    AND profile.deleted_at IS NULL
    AND profile.pii_archived_at IS NULL
    AND client_message.sender_type = 'client'::public.sender_type
    AND NOT EXISTS (
      SELECT 1
      FROM public.conversation_handling_cycles cycle
      WHERE cycle.work_item_id = work_item.id
        AND cycle.ended_at IS NULL
    );

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  FOR _operator IN
    SELECT operator.id AS operator_id, operator.user_id
    FROM public.character_operator_assignments assignment
    JOIN public.operators operator ON operator.id = assignment.operator_id
    WHERE assignment.character_id = _item.character_id
      AND operator.is_active = TRUE
      AND operator.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.operator_client_blocks block
        WHERE block.operator_id = operator.id
          AND block.client_id = _item.client_id
      )
  LOOP
    PERFORM private.create_analytics_event(
      'new_available',
      _operator.user_id,
      'operator'::public.app_role,
      _item.conversation_id,
      _item.character_id,
      _operator.operator_id,
      jsonb_build_object(
        'dedupe_key', format('new_available:%s:%s:%s', _item.id, _item.client_message_id, _operator.operator_id),
        'work_item_id', _item.id,
        'last_client_message_id', _item.client_message_id
      )
    );

    _notification_id := public.create_notification(
      _operator.user_id,
      'new_available',
      U&'\05E4\05E0\05D9\05D9\05D4 \05D7\05D3\05E9\05D4 \05D6\05DE\05D9\05E0\05D4',
      U&'\05E4\05E0\05D9\05D9\05D4 \05D7\05D3\05E9\05D4 \05DE\05DE\05EA\05D9\05E0\05D4 \05DC\05D8\05D9\05E4\05D5\05DC.',
      '/operator/chat/' || _item.conversation_id::TEXT,
      _item.conversation_id,
      jsonb_build_object(
        'dedupe_key', format('new_available:%s:%s:%s', _item.id, _item.client_message_id, _operator.operator_id),
        'work_item_id', _item.id,
        'last_client_message_id', _item.client_message_id
      ),
      0
    );

    IF _notification_id IS NOT NULL THEN
      _sent_count := _sent_count + 1;
    END IF;
  END LOOP;

  RETURN _sent_count;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_on_new_message() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.emit_new_available_notifications(UUID, UUID)
  FROM PUBLIC, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
