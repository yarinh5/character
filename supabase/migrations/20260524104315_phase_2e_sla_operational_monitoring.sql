-- Phase 2E: SLA / Operational Monitoring.
-- Lightweight dashboard-time monitoring, no scheduled job.

INSERT INTO public.system_settings (key, value)
VALUES ('conversation_waiting_sla_minutes', '15'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_desc
  ON public.messages(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_status_last_message
  ON public.conversations(status, last_message_at DESC)
  WHERE status <> 'closed'::public.conversation_status;

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
VOLATILE
SET search_path = public, private
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _role public.app_role;
  _operator_id UUID;
  _sla_minutes INTEGER := 15;
  _row RECORD;
  _admin RECORD;
  _operator RECORD;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  _role := public.get_my_role();

  IF _role NOT IN ('operator'::public.app_role, 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'not_allowed';
  END IF;

  SELECT id INTO _operator_id
  FROM public.operators
  WHERE user_id = _user_id
    AND is_active = true
  LIMIT 1;

  SELECT COALESCE(
    (
      SELECT CASE
        WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::integer
        WHEN jsonb_typeof(value) = 'string' AND (value #>> '{}') ~ '^[0-9]+$' THEN (value #>> '{}')::integer
        ELSE NULL
      END
      FROM public.system_settings
      WHERE key = 'conversation_waiting_sla_minutes'
      LIMIT 1
    ),
    15
  )
  INTO _sla_minutes;

  _sla_minutes := GREATEST(_sla_minutes, 1);

  IF _notify THEN
    FOR _row IN
      WITH latest AS (
        SELECT
          c.id,
          c.character_id,
          c.client_id,
          c.status,
          c.last_message_preview,
          lm.sender_type,
          lm.created_at AS last_client_message_at
        FROM public.conversations c
        JOIN LATERAL (
          SELECT sender_type, created_at
          FROM public.messages
          WHERE conversation_id = c.id
          ORDER BY created_at DESC
          LIMIT 1
        ) lm ON true
        WHERE c.status <> 'closed'::public.conversation_status
          AND lm.sender_type = 'client'::public.sender_type
          AND lm.created_at <= clock_timestamp() - make_interval(mins => _sla_minutes)
          AND (
            _role = 'admin'::public.app_role
            OR EXISTS (
              SELECT 1
              FROM public.character_operator_assignments coa
              WHERE coa.character_id = c.character_id
                AND coa.operator_id = _operator_id
            )
          )
      )
      SELECT *
      FROM latest
      LIMIT LEAST(GREATEST(COALESCE(_limit, 20), 1), 100)
    LOOP
      FOR _operator IN
        SELECT DISTINCT o.user_id
        FROM public.character_operator_assignments coa
        JOIN public.operators o ON o.id = coa.operator_id
        WHERE coa.character_id = _row.character_id
          AND o.is_active = true
      LOOP
        PERFORM public.create_notification(
          _operator.user_id,
          'conversation_sla_risk',
          'שיחה ממתינה יותר מדי זמן',
          'שיחה חורגת מזמן המענה שהוגדר במערכת.',
          '/operator/chat/' || _row.id::text,
          _row.id,
          jsonb_build_object('sla_minutes', _sla_minutes, 'last_client_message_at', _row.last_client_message_at),
          3600
        );
      END LOOP;

      FOR _admin IN SELECT user_id FROM public.user_roles WHERE role = 'admin'::public.app_role LOOP
        PERFORM public.create_notification(
          _admin.user_id,
          'conversation_sla_risk',
          'שיחה בסיכון SLA',
          'יש שיחה שממתינה מעבר לזמן שהוגדר.',
          '/admin/conversations/' || _row.id::text,
          _row.id,
          jsonb_build_object('sla_minutes', _sla_minutes, 'last_client_message_at', _row.last_client_message_at),
          3600
        );
      END LOOP;
    END LOOP;
  END IF;

  RETURN QUERY
  WITH latest AS (
    SELECT
      c.id,
      c.character_id,
      c.client_id,
      c.status,
      c.last_message_preview,
      lm.sender_type,
      lm.created_at AS last_client_message_at
    FROM public.conversations c
    JOIN LATERAL (
      SELECT sender_type, created_at
      FROM public.messages
      WHERE conversation_id = c.id
      ORDER BY created_at DESC
      LIMIT 1
    ) lm ON true
    WHERE c.status <> 'closed'::public.conversation_status
      AND lm.sender_type = 'client'::public.sender_type
      AND lm.created_at <= clock_timestamp() - make_interval(mins => _sla_minutes)
  )
  SELECT
    l.id AS conversation_id,
    l.character_id,
    ch.name AS character_name,
    ch.avatar_url AS character_avatar_url,
    l.client_id,
    p.display_name AS client_display_name,
    l.status,
    l.last_client_message_at,
    floor(extract(epoch from (clock_timestamp() - l.last_client_message_at)) / 60)::integer AS minutes_waiting,
    l.last_message_preview
  FROM latest l
  JOIN public.characters ch ON ch.id = l.character_id
  LEFT JOIN public.profiles p ON p.user_id = l.client_id
  WHERE
    _role = 'admin'::public.app_role
    OR EXISTS (
      SELECT 1
      FROM public.character_operator_assignments coa
      WHERE coa.character_id = l.character_id
        AND coa.operator_id = _operator_id
    )
  ORDER BY l.last_client_message_at ASC
  LIMIT LEAST(GREATEST(COALESCE(_limit, 20), 1), 100);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_sla_risk_conversations(INTEGER, BOOLEAN) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.get_sla_risk_conversations(INTEGER, BOOLEAN) TO authenticated;
