-- P05: 24/7 operational wait alerts and authoritative character presence.
-- The existing (conversation_id, pending_since) wait cycle remains the event key.

INSERT INTO public.system_settings (key, value)
VALUES ('operational_wait_alert_seconds', '420'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

CREATE OR REPLACE FUNCTION private.operational_wait_event_key(
  _conversation_id UUID,
  _pending_since TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT 'operational_wait:' || _conversation_id::TEXT || ':'
    || extract(epoch FROM _pending_since)::NUMERIC::TEXT;
$$;

CREATE OR REPLACE FUNCTION private.sync_operational_wait_cycle()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _responded_at TIMESTAMPTZ;
  _event_key TEXT;
BEGIN
  IF NEW.needs_handling IS TRUE AND NEW.pending_since IS NOT NULL THEN
    INSERT INTO private.conversation_operational_wait_cycles (conversation_id, pending_since)
    VALUES (NEW.id, NEW.pending_since)
    ON CONFLICT (conversation_id, pending_since) DO NOTHING;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.needs_handling IS TRUE AND OLD.pending_since IS NOT NULL
      AND (NEW.needs_handling IS NOT TRUE OR NEW.pending_since IS DISTINCT FROM OLD.pending_since) THEN
      _responded_at := clock_timestamp();
      _event_key := private.operational_wait_event_key(NEW.id, OLD.pending_since);

      UPDATE private.conversation_operational_wait_cycles cycle
      SET responded_at = COALESCE(cycle.responded_at, _responded_at)
      WHERE cycle.conversation_id = NEW.id
        AND cycle.pending_since = OLD.pending_since;

      UPDATE public.notifications notification
      SET metadata = jsonb_set(
        jsonb_set(
          COALESCE(notification.metadata, '{}'::JSONB),
          '{state}',
          '"resolved"'::JSONB,
          TRUE
        ),
        '{resolved_at}',
        to_jsonb(_responded_at),
        TRUE
      )
      WHERE notification.type = 'operational_wait_alert'
        AND notification.conversation_id = NEW.id
        AND notification.metadata ->> 'wait_event_key' = _event_key
        AND notification.metadata ->> 'state' = 'active';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_operational_wait_cycle ON public.conversations;
CREATE TRIGGER sync_operational_wait_cycle
  AFTER INSERT OR UPDATE OF needs_handling, pending_since ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION private.sync_operational_wait_cycle();

CREATE OR REPLACE FUNCTION private.emit_operational_wait_alerts(_limit INTEGER DEFAULT 100)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _threshold INTEGER := GREATEST(private.setting_int('operational_wait_alert_seconds', 420), 60);
  _count INTEGER := 0;
BEGIN
  WITH candidates AS (
    SELECT cycle.conversation_id, cycle.pending_since
    FROM private.conversation_operational_wait_cycles cycle
    JOIN public.conversations conversation
      ON conversation.id = cycle.conversation_id
     AND conversation.needs_handling IS TRUE
     AND conversation.pending_since = cycle.pending_since
    WHERE cycle.responded_at IS NULL
      AND cycle.alerted_at IS NULL
      AND clock_timestamp() - cycle.pending_since >= make_interval(secs => _threshold)
      AND EXISTS (
        SELECT 1 FROM public.user_roles role
        WHERE role.role = 'admin'::public.app_role
      )
    ORDER BY cycle.pending_since, cycle.conversation_id
    LIMIT LEAST(GREATEST(COALESCE(_limit, 100), 1), 500)
    FOR UPDATE OF cycle SKIP LOCKED
  ), marked AS (
    UPDATE private.conversation_operational_wait_cycles cycle
    SET alerted_at = clock_timestamp()
    FROM candidates
    WHERE cycle.conversation_id = candidates.conversation_id
      AND cycle.pending_since = candidates.pending_since
    RETURNING cycle.conversation_id, cycle.pending_since, cycle.alerted_at
  ), admin_notifications AS (
    INSERT INTO public.notifications (user_id, type, title, body, link, conversation_id, metadata)
    SELECT DISTINCT
      role.user_id,
      'operational_wait_alert',
      'שיחה ממתינה למענה',
      'חלפו שבע דקות ללא מענה עסקי מוצלח',
      '/admin/conversations/' || marked.conversation_id::TEXT,
      marked.conversation_id,
      jsonb_build_object(
        'dedupe_key', private.operational_wait_event_key(marked.conversation_id, marked.pending_since),
        'wait_event_key', private.operational_wait_event_key(marked.conversation_id, marked.pending_since),
        'pending_since', marked.pending_since,
        'threshold_seconds', _threshold,
        'wait_seconds_at_alert', GREATEST(
          0,
          floor(extract(epoch FROM (marked.alerted_at - marked.pending_since)))::INTEGER
        ),
        'state', 'active',
        'resolved_at', NULL
      )
    FROM marked
    CROSS JOIN public.user_roles role
    WHERE role.role = 'admin'::public.app_role
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::INTEGER INTO _count FROM marked;

  RETURN _count;
END;
$$;

CREATE OR REPLACE FUNCTION public.emit_operational_wait_alerts(_limit INTEGER DEFAULT 100)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_or_service_role_required' USING ERRCODE = '42501';
  END IF;
  RETURN private.emit_operational_wait_alerts(_limit);
END;
$$;

-- Reuse the existing scheduler entry point. Existing 5/15 minute reporting remains
-- unchanged; only automatic alert emission is routed to the approved seven-minute event.
CREATE OR REPLACE FUNCTION private.run_new_sla_critical_scheduler()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
SET statement_timeout = '45s'
AS $$
DECLARE
  _created INTEGER;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('private.run_new_sla_critical_scheduler')) THEN
    RETURN jsonb_build_object(
      'status', 'skipped_due_to_lock',
      'lock_acquired', FALSE,
      'notifications_created', 0
    );
  END IF;

  _created := private.emit_operational_wait_alerts(100);
  RETURN jsonb_build_object(
    'status', 'completed',
    'lock_acquired', TRUE,
    'notifications_created', _created,
    'operational_wait_events_alerted', _created
  );
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
  IF auth.role() <> 'service_role' AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_or_service_role_required' USING ERRCODE = '42501';
  END IF;
  RETURN private.emit_new_sla_critical_notifications();
END;
$$;

CREATE OR REPLACE FUNCTION public.get_character_live_availability(_character_ids UUID[])
RETURNS TABLE (
  character_id UUID,
  availability_status public.availability_status
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _ids UUID[] := ARRAY(SELECT DISTINCT value FROM unnest(COALESCE(_character_ids, ARRAY[]::UUID[])) value);
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501'; END IF;
  IF cardinality(_ids) > 100 OR array_position(_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_character_ids';
  END IF;

  RETURN QUERY
  SELECT
    character.id,
    private.character_live_availability(character.id, character.availability_status)
  FROM public.characters character
  WHERE character.id = ANY(_ids)
    AND character.is_active IS TRUE
    AND character.is_visible IS TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_character_profile(_character_id UUID)
RETURNS TABLE (
  id UUID,
  name TEXT,
  avatar_url TEXT,
  fictional_age INTEGER,
  short_description TEXT,
  full_description TEXT,
  personality TEXT,
  category TEXT,
  interests TEXT[],
  availability_status public.availability_status,
  city_name TEXT,
  gallery_images TEXT[],
  is_favorite BOOLEAN,
  conversation_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _client UUID := auth.uid();
BEGIN
  IF _client IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  PERFORM private.ensure_active_client(_client);

  RETURN QUERY
  SELECT
    character.id,
    character.name,
    character.avatar_url,
    character.fictional_age,
    character.short_description,
    character.full_description,
    character.personality,
    character.category,
    character.interests,
    private.character_live_availability(character.id, character.availability_status),
    city.display_name_he,
    character.gallery_images,
    COALESCE(preference.is_favorite, FALSE),
    conversation.id
  FROM public.characters character
  LEFT JOIN public.discovery_cities city
    ON city.id = character.discovery_city_id AND city.is_active IS TRUE
  LEFT JOIN public.client_character_preferences preference
    ON preference.client_id = _client AND preference.character_id = character.id
  LEFT JOIN LATERAL (
    SELECT active_conversation.id
    FROM public.conversations active_conversation
    WHERE active_conversation.client_id = _client
      AND active_conversation.character_id = character.id
      AND active_conversation.status <> 'closed'::public.conversation_status
      AND active_conversation.client_hidden_at IS NULL
    ORDER BY active_conversation.updated_at DESC
    LIMIT 1
  ) conversation ON TRUE
  WHERE character.id = _character_id
    AND character.is_active IS TRUE
    AND character.is_visible IS TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_admin_operator_presence_overview()
RETURNS TABLE (
  operator_id UUID,
  presence_status TEXT,
  last_seen_at TIMESTAMPTZ,
  active_work_item_count INTEGER,
  eligible_new_queue_count INTEGER,
  stale_returned_count INTEGER,
  held_conversations JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _stale_minutes INTEGER := GREATEST(private.setting_int('operator_heartbeat_stale_minutes', 2), 1);
BEGIN
  IF auth.uid() IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  RETURN QUERY
  WITH active_items AS (
    SELECT wi.responsible_operator_id AS operator_id,
      COUNT(*)::INTEGER AS active_work_item_count,
      jsonb_agg(jsonb_build_object(
        'conversation_id', wi.conversation_id,
        'character_name', character.name,
        'client_display_name', profile.display_name,
        'status', wi.status,
        'last_activity_at', wi.last_activity_at
      ) ORDER BY wi.last_activity_at DESC) AS held_conversations
    FROM public.conversation_work_items wi
    JOIN public.conversations conversation ON conversation.id = wi.conversation_id
    JOIN public.characters character ON character.id = wi.character_id
    LEFT JOIN public.profiles profile ON profile.user_id = wi.client_id
    WHERE wi.status IN ('assigned', 'in_progress')
      AND wi.responsible_operator_id IS NOT NULL
      AND conversation.status <> 'closed'::public.conversation_status
    GROUP BY wi.responsible_operator_id
  ), eligible_new_items AS (
    SELECT assignment.operator_id, COUNT(*)::INTEGER AS eligible_new_queue_count
    FROM public.character_operator_assignments assignment
    JOIN public.conversation_work_items wi
      ON wi.character_id = assignment.character_id AND wi.status = 'new'
    JOIN public.conversations conversation
      ON conversation.id = wi.conversation_id
     AND conversation.status <> 'closed'::public.conversation_status
    GROUP BY assignment.operator_id
  ), stale_returns AS (
    SELECT cycle.operator_id, COUNT(*)::INTEGER AS stale_returned_count
    FROM public.conversation_handling_cycles cycle
    WHERE cycle.end_reason = 'timeout'
      AND cycle.ended_at >= clock_timestamp() - INTERVAL '24 hours'
    GROUP BY cycle.operator_id
  )
  SELECT
    operator.id,
    CASE
      WHEN operator.is_active IS NOT TRUE
        OR operator.deleted_at IS NOT NULL
        OR operator.presence_status <> 'online'
        OR operator.last_seen_at IS NULL
        OR operator.last_seen_at < clock_timestamp() - make_interval(mins => _stale_minutes)
        THEN 'offline'
      WHEN operator.last_seen_at < clock_timestamp() - INTERVAL '90 seconds' THEN 'idle'
      ELSE 'online'
    END,
    operator.last_seen_at,
    COALESCE(active_items.active_work_item_count, 0),
    COALESCE(eligible_new_items.eligible_new_queue_count, 0),
    COALESCE(stale_returns.stale_returned_count, 0),
    COALESCE(active_items.held_conversations, '[]'::JSONB)
  FROM public.operators operator
  LEFT JOIN active_items ON active_items.operator_id = operator.id
  LEFT JOIN eligible_new_items ON eligible_new_items.operator_id = operator.id
  LEFT JOIN stale_returns ON stale_returns.operator_id = operator.id
  WHERE operator.deleted_at IS NULL
  ORDER BY operator.full_name;
END;
$$;

REVOKE ALL ON FUNCTION private.operational_wait_event_key(UUID, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.emit_operational_wait_alerts(INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.sync_operational_wait_cycle()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.emit_operational_wait_alerts(INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.emit_operational_wait_alerts(INTEGER) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.emit_new_sla_critical_notifications() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.emit_new_sla_critical_notifications() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_character_live_availability(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_character_live_availability(UUID[]) TO authenticated;
REVOKE ALL ON FUNCTION public.get_character_profile(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_character_profile(UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.get_admin_operator_presence_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_operator_presence_overview() TO authenticated;

NOTIFY pgrst, 'reload schema';
