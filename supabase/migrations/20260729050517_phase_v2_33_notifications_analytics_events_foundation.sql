-- V2 events use durable semantic keys so retries and repeated scheduler runs do
-- not create notification or analytics noise.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_semantic_dedupe_key_unique
  ON public.notifications (user_id, type, (metadata ->> 'dedupe_key'))
  WHERE NULLIF(metadata ->> 'dedupe_key', '') IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS analytics_events_semantic_dedupe_key_unique
  ON public.analytics_events (event_name, (metadata ->> 'dedupe_key'))
  WHERE NULLIF(metadata ->> 'dedupe_key', '') IS NOT NULL;

CREATE OR REPLACE FUNCTION public.create_notification(
  _user_id UUID,
  _type TEXT,
  _title TEXT,
  _body TEXT DEFAULT NULL,
  _link TEXT DEFAULT NULL,
  _conversation_id UUID DEFAULT NULL,
  _metadata JSONB DEFAULT '{}'::jsonb,
  _dedupe_window_seconds INTEGER DEFAULT 120
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _existing_id UUID;
  _new_id UUID;
  _window_seconds INTEGER := GREATEST(COALESCE(_dedupe_window_seconds, 120), 0);
  _dedupe_key TEXT := NULLIF(BTRIM(COALESCE(_metadata ->> 'dedupe_key', '')), '');
BEGIN
  IF _user_id IS NULL OR _type IS NULL OR _title IS NULL THEN
    RETURN NULL;
  END IF;

  DELETE FROM public.user_active_conversations
  WHERE expires_at < clock_timestamp();

  IF _conversation_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.user_active_conversations active_conversation
    WHERE active_conversation.user_id = _user_id
      AND active_conversation.conversation_id = _conversation_id
      AND active_conversation.expires_at > clock_timestamp()
  ) THEN
    RETURN NULL;
  END IF;

  IF private.notification_enabled(_user_id, _type) IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  IF _dedupe_key IS NOT NULL THEN
    SELECT notification.id
    INTO _existing_id
    FROM public.notifications notification
    WHERE notification.user_id = _user_id
      AND notification.type = _type
      AND notification.metadata ->> 'dedupe_key' = _dedupe_key
    LIMIT 1;
  ELSIF _window_seconds > 0 THEN
    SELECT notification.id
    INTO _existing_id
    FROM public.notifications notification
    WHERE notification.user_id = _user_id
      AND notification.type = _type
      AND (
        (_conversation_id IS NULL AND notification.conversation_id IS NULL)
        OR notification.conversation_id = _conversation_id
      )
      AND notification.created_at >= clock_timestamp() - make_interval(secs => _window_seconds)
    ORDER BY notification.created_at DESC
    LIMIT 1;
  END IF;

  IF _existing_id IS NOT NULL THEN
    RETURN _existing_id;
  END IF;

  INSERT INTO public.notifications (user_id, type, title, body, link, conversation_id, metadata)
  VALUES (
    _user_id,
    _type,
    _title,
    NULLIF(_body, ''),
    NULLIF(_link, ''),
    _conversation_id,
    COALESCE(_metadata, '{}'::jsonb)
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO _new_id;

  IF _new_id IS NULL AND _dedupe_key IS NOT NULL THEN
    SELECT notification.id
    INTO _new_id
    FROM public.notifications notification
    WHERE notification.user_id = _user_id
      AND notification.type = _type
      AND notification.metadata ->> 'dedupe_key' = _dedupe_key
    LIMIT 1;
  END IF;

  RETURN _new_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.create_analytics_event(
  _event_name TEXT,
  _actor_user_id UUID DEFAULT NULL,
  _role public.app_role DEFAULT NULL,
  _conversation_id UUID DEFAULT NULL,
  _character_id UUID DEFAULT NULL,
  _operator_id UUID DEFAULT NULL,
  _metadata JSONB DEFAULT '{}'::jsonb,
  _dedupe_seconds INTEGER DEFAULT 0
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _existing_id UUID;
  _event_id UUID;
  _resolved_role public.app_role;
  _window_seconds INTEGER := GREATEST(COALESCE(_dedupe_seconds, 0), 0);
  _dedupe_key TEXT := NULLIF(BTRIM(COALESCE(_metadata ->> 'dedupe_key', '')), '');
BEGIN
  IF _event_name IS NULL OR _event_name !~ '^[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'invalid_event_name';
  END IF;

  _resolved_role := COALESCE(_role, private.analytics_role_for_user(_actor_user_id));

  IF _dedupe_key IS NOT NULL THEN
    SELECT event.id
    INTO _existing_id
    FROM public.analytics_events event
    WHERE event.event_name = _event_name
      AND event.metadata ->> 'dedupe_key' = _dedupe_key
    LIMIT 1;
  ELSIF _window_seconds > 0 THEN
    SELECT event.id
    INTO _existing_id
    FROM public.analytics_events event
    WHERE event.event_name = _event_name
      AND event.actor_user_id IS NOT DISTINCT FROM _actor_user_id
      AND event.conversation_id IS NOT DISTINCT FROM _conversation_id
      AND event.character_id IS NOT DISTINCT FROM _character_id
      AND event.operator_id IS NOT DISTINCT FROM _operator_id
      AND event.created_at >= clock_timestamp() - make_interval(secs => _window_seconds)
    ORDER BY event.created_at DESC
    LIMIT 1;
  END IF;

  IF _existing_id IS NOT NULL THEN
    RETURN _existing_id;
  END IF;

  INSERT INTO public.analytics_events (
    event_name,
    actor_user_id,
    role,
    conversation_id,
    character_id,
    operator_id,
    metadata,
    created_at
  )
  VALUES (
    _event_name,
    _actor_user_id,
    _resolved_role,
    _conversation_id,
    _character_id,
    _operator_id,
    COALESCE(_metadata, '{}'::jsonb),
    clock_timestamp()
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO _event_id;

  IF _event_id IS NULL AND _dedupe_key IS NOT NULL THEN
    SELECT event.id
    INTO _event_id
    FROM public.analytics_events event
    WHERE event.event_name = _event_name
      AND event.metadata ->> 'dedupe_key' = _dedupe_key
    LIMIT 1;
  END IF;

  RETURN _event_id;
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
      'פנייה חדשה זמינה',
      'פנייה חדשה ממתינה לטיפול.',
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

CREATE OR REPLACE FUNCTION private.emit_new_sla_critical_notifications()
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
  FOR _item IN
    SELECT
      work_item.id AS work_item_id,
      work_item.conversation_id,
      work_item.client_id,
      work_item.character_id,
      client_message.id AS client_message_id
    FROM public.conversation_work_items work_item
    JOIN public.conversations conversation ON conversation.id = work_item.conversation_id
    JOIN public.profiles profile ON profile.user_id = work_item.client_id
    JOIN public.messages client_message ON client_message.id = work_item.last_client_message_id
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
  LOOP
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
      _notification_id := public.create_notification(
        _operator.user_id,
        'new_sla_critical',
        'פנייה חורגת מ-SLA',
        'פנייה חדשה ממתינה יותר מ-15 דקות.',
        '/operator/chat/' || _item.conversation_id::TEXT,
        _item.conversation_id,
        jsonb_build_object(
          'dedupe_key', format('new_sla_critical:%s:%s:%s', _item.work_item_id, _item.client_message_id, _operator.operator_id),
          'work_item_id', _item.work_item_id,
          'last_client_message_id', _item.client_message_id,
          'sla_state', 'critical'
        ),
        0
      );

      IF _notification_id IS NOT NULL THEN
        _sent_count := _sent_count + 1;
      END IF;
    END LOOP;
  END LOOP;

  RETURN _sent_count;
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

CREATE OR REPLACE FUNCTION private.emit_v2_33_new_available_on_work_item()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF NEW.status = 'new'
    AND NEW.last_client_message_id IS NOT NULL
    AND (
      TG_OP = 'INSERT'
      OR OLD.status IS DISTINCT FROM NEW.status
      OR OLD.last_client_message_id IS DISTINCT FROM NEW.last_client_message_id
    ) THEN
    PERFORM private.emit_new_available_notifications(NEW.id, NEW.last_client_message_id);
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.record_v2_33_handling_cycle_started()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _operator_user_id UUID;
  _character_id UUID;
BEGIN
  SELECT operator.user_id, work_item.character_id
  INTO _operator_user_id, _character_id
  FROM public.operators operator
  JOIN public.conversation_work_items work_item ON work_item.id = NEW.work_item_id
  WHERE operator.id = NEW.operator_id;

  PERFORM private.create_analytics_event(
    'new_claimed',
    _operator_user_id,
    'operator'::public.app_role,
    NEW.conversation_id,
    _character_id,
    NEW.operator_id,
    jsonb_build_object('dedupe_key', format('new_claimed:%s', NEW.id), 'work_item_id', NEW.work_item_id, 'cycle_id', NEW.id)
  );

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.record_v2_33_handling_cycle_ended()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _event_name TEXT;
  _operator_user_id UUID;
  _character_id UUID;
BEGIN
  IF OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL THEN
    RETURN NEW;
  END IF;

  _event_name := CASE NEW.end_reason
    WHEN 'released' THEN 'new_released'
    WHEN 'reassigned' THEN 'new_released'
    WHEN 'timeout' THEN 'new_timed_out'
    ELSE NULL
  END;

  IF _event_name IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT operator.user_id, work_item.character_id
  INTO _operator_user_id, _character_id
  FROM public.operators operator
  JOIN public.conversation_work_items work_item ON work_item.id = NEW.work_item_id
  WHERE operator.id = NEW.operator_id;

  PERFORM private.create_analytics_event(
    _event_name,
    _operator_user_id,
    'operator'::public.app_role,
    NEW.conversation_id,
    _character_id,
    NEW.operator_id,
    jsonb_build_object(
      'dedupe_key', format('%s:%s', _event_name, NEW.id),
      'work_item_id', NEW.work_item_id,
      'cycle_id', NEW.id,
      'end_reason', NEW.end_reason
    )
  );

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.record_v2_33_outreach_sent()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _operator_user_id UUID;
BEGIN
  IF NEW.status <> 'sent' THEN
    RETURN NEW;
  END IF;

  SELECT operator.user_id INTO _operator_user_id
  FROM public.operators operator
  WHERE operator.id = NEW.operator_id;

  PERFORM private.create_analytics_event(
    'online_outreach_sent',
    _operator_user_id,
    'operator'::public.app_role,
    NEW.conversation_id,
    NEW.character_id,
    NEW.operator_id,
    jsonb_build_object('dedupe_key', format('online_outreach_sent:%s', NEW.id), 'outreach_attempt_id', NEW.id)
  );

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.record_v2_33_outreach_replied()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _attempt RECORD;
  _character_id UUID;
BEGIN
  IF NEW.sender_type <> 'client'::public.sender_type THEN
    RETURN NEW;
  END IF;

  SELECT attempt.id, attempt.operator_id
  INTO _attempt
  FROM public.operator_outreach_attempts attempt
  WHERE attempt.conversation_id = NEW.conversation_id
    AND attempt.status = 'sent'
    AND attempt.created_at < NEW.created_at
  ORDER BY attempt.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  SELECT conversation.character_id INTO _character_id
  FROM public.conversations conversation
  WHERE conversation.id = NEW.conversation_id;

  PERFORM private.create_analytics_event(
    'online_outreach_replied',
    NEW.sender_id,
    'client'::public.app_role,
    NEW.conversation_id,
    _character_id,
    _attempt.operator_id,
    jsonb_build_object('dedupe_key', format('online_outreach_replied:%s', _attempt.id), 'outreach_attempt_id', _attempt.id, 'message_id', NEW.id)
  );

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.record_v2_33_paid_sticker_payout()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _message RECORD;
BEGIN
  IF NEW.payout_transaction_id IS NULL OR NEW.payout_operator_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT message.sender_id, message.conversation_id, conversation.character_id
  INTO _message
  FROM public.messages message
  JOIN public.conversations conversation ON conversation.id = message.conversation_id
  WHERE message.id = NEW.message_id;

  PERFORM private.create_analytics_event(
    'paid_sticker_payout_completed',
    _message.sender_id,
    'client'::public.app_role,
    _message.conversation_id,
    _message.character_id,
    NEW.payout_operator_id,
    jsonb_build_object('dedupe_key', format('paid_sticker_payout_completed:%s', NEW.id), 'message_sticker_id', NEW.id, 'payout_transaction_id', NEW.payout_transaction_id)
  );

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.record_v2_33_paid_image_payout()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _character_id UUID;
BEGIN
  IF NEW.payout_transaction_id IS NULL OR NEW.payout_operator_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT conversation.character_id INTO _character_id
  FROM public.conversations conversation
  WHERE conversation.id = NEW.conversation_id;

  PERFORM private.create_analytics_event(
    'paid_image_payout_completed',
    NEW.client_id,
    'client'::public.app_role,
    NEW.conversation_id,
    _character_id,
    NEW.payout_operator_id,
    jsonb_build_object('dedupe_key', format('paid_image_payout_completed:%s', NEW.id), 'open_session_id', NEW.id, 'payout_transaction_id', NEW.payout_transaction_id)
  );

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.record_v2_33_operator_report()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _operator_user_id UUID;
  _character_id UUID;
  _admin RECORD;
BEGIN
  SELECT operator.user_id INTO _operator_user_id
  FROM public.operators operator
  WHERE operator.id = NEW.operator_id;

  SELECT conversation.character_id INTO _character_id
  FROM public.conversations conversation
  WHERE conversation.id = NEW.conversation_id;

  PERFORM private.create_analytics_event(
    'operator_report_submitted',
    _operator_user_id,
    'operator'::public.app_role,
    NEW.conversation_id,
    _character_id,
    NEW.operator_id,
    jsonb_build_object('dedupe_key', format('operator_report_submitted:%s', NEW.id), 'operator_report_id', NEW.id)
  );

  FOR _admin IN
    SELECT admin_role.user_id
    FROM public.user_roles admin_role
    JOIN public.profiles profile ON profile.user_id = admin_role.user_id
    WHERE admin_role.role = 'admin'::public.app_role
      AND profile.status = 'active'
      AND profile.deleted_at IS NULL
  LOOP
    PERFORM public.create_notification(
      _admin.user_id,
      'operator_report_submitted',
      'דיווח חדש מעובד',
      'נשלח דיווח חדש לבדיקה.',
      '/admin/reports',
      NEW.conversation_id,
      jsonb_build_object('dedupe_key', format('operator_report:%s:%s', NEW.id, _admin.user_id), 'operator_report_id', NEW.id),
      0
    );
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_v2_33_new_available ON public.conversation_work_items;
CREATE TRIGGER trg_v2_33_new_available
  AFTER INSERT OR UPDATE OF status, last_client_message_id ON public.conversation_work_items
  FOR EACH ROW
  EXECUTE FUNCTION private.emit_v2_33_new_available_on_work_item();

DROP TRIGGER IF EXISTS trg_v2_33_handling_cycle_started ON public.conversation_handling_cycles;
CREATE TRIGGER trg_v2_33_handling_cycle_started
  AFTER INSERT ON public.conversation_handling_cycles
  FOR EACH ROW
  EXECUTE FUNCTION private.record_v2_33_handling_cycle_started();

DROP TRIGGER IF EXISTS trg_v2_33_handling_cycle_ended ON public.conversation_handling_cycles;
CREATE TRIGGER trg_v2_33_handling_cycle_ended
  AFTER UPDATE OF ended_at, end_reason ON public.conversation_handling_cycles
  FOR EACH ROW
  EXECUTE FUNCTION private.record_v2_33_handling_cycle_ended();

DROP TRIGGER IF EXISTS trg_v2_33_outreach_sent ON public.operator_outreach_attempts;
CREATE TRIGGER trg_v2_33_outreach_sent
  AFTER INSERT ON public.operator_outreach_attempts
  FOR EACH ROW
  EXECUTE FUNCTION private.record_v2_33_outreach_sent();

DROP TRIGGER IF EXISTS trg_v2_33_outreach_replied ON public.messages;
CREATE TRIGGER trg_v2_33_outreach_replied
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION private.record_v2_33_outreach_replied();

DROP TRIGGER IF EXISTS trg_v2_33_paid_sticker_payout ON public.message_stickers;
CREATE TRIGGER trg_v2_33_paid_sticker_payout
  AFTER INSERT ON public.message_stickers
  FOR EACH ROW
  EXECUTE FUNCTION private.record_v2_33_paid_sticker_payout();

DROP TRIGGER IF EXISTS trg_v2_33_paid_image_payout ON private.message_attachment_open_sessions;
CREATE TRIGGER trg_v2_33_paid_image_payout
  AFTER INSERT ON private.message_attachment_open_sessions
  FOR EACH ROW
  EXECUTE FUNCTION private.record_v2_33_paid_image_payout();

DROP TRIGGER IF EXISTS trg_v2_33_operator_report ON public.operator_client_reports;
CREATE TRIGGER trg_v2_33_operator_report
  AFTER INSERT ON public.operator_client_reports
  FOR EACH ROW
  EXECUTE FUNCTION private.record_v2_33_operator_report();

REVOKE ALL ON FUNCTION public.create_notification(UUID, TEXT, TEXT, TEXT, TEXT, UUID, JSONB, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.create_analytics_event(TEXT, UUID, public.app_role, UUID, UUID, UUID, JSONB, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.emit_new_available_notifications(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.emit_new_sla_critical_notifications() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.emit_v2_33_new_available_on_work_item() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.record_v2_33_handling_cycle_started() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.record_v2_33_handling_cycle_ended() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.record_v2_33_outreach_sent() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.record_v2_33_outreach_replied() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.record_v2_33_paid_sticker_payout() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.record_v2_33_paid_image_payout() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.record_v2_33_operator_report() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.emit_new_sla_critical_notifications() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.emit_new_sla_critical_notifications() TO authenticated;

NOTIFY pgrst, 'reload schema';
