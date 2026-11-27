-- WP11: admin moderation lifecycle for operator-submitted client reports.

ALTER TABLE public.operator_client_reports
  ADD COLUMN status TEXT NOT NULL DEFAULT 'open',
  ADD COLUMN resolution_note TEXT,
  ADD COLUMN global_action_note TEXT,
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN resolved_at TIMESTAMPTZ,
  ADD COLUMN resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD CONSTRAINT operator_client_reports_status_check
    CHECK (status IN ('open', 'in_progress', 'decided', 'closed')),
  ADD CONSTRAINT operator_client_reports_resolution_note_check
    CHECK (resolution_note IS NULL OR char_length(btrim(resolution_note)) BETWEEN 1 AND 2000),
  ADD CONSTRAINT operator_client_reports_global_action_note_check
    CHECK (global_action_note IS NULL OR char_length(btrim(global_action_note)) BETWEEN 1 AND 2000),
  ADD CONSTRAINT operator_client_reports_version_check CHECK (version > 0),
  ADD CONSTRAINT operator_client_reports_resolution_check CHECK (
    (status IN ('open', 'in_progress') AND resolved_at IS NULL AND resolved_by IS NULL)
    OR (status IN ('decided', 'closed') AND resolution_note IS NOT NULL
        AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
  );

UPDATE public.operator_client_reports
SET updated_at = created_at;

CREATE FUNCTION public.admin_update_operator_client_report(
  _report_id UUID,
  _expected_version INTEGER,
  _status TEXT,
  _resolution_note TEXT,
  _global_action_note TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _admin_id UUID := auth.uid();
  _report public.operator_client_reports%ROWTYPE;
  _updated public.operator_client_reports%ROWTYPE;
  _note_clean TEXT := NULLIF(btrim(_resolution_note), '');
  _global_action_note_clean TEXT := NULLIF(btrim(_global_action_note), '');
BEGIN
  IF _admin_id IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;
  IF _report_id IS NULL THEN
    RAISE EXCEPTION 'report_required';
  END IF;
  IF _status IS NULL OR _status NOT IN ('open', 'in_progress', 'decided', 'closed') THEN
    RAISE EXCEPTION 'invalid_report_status';
  END IF;
  IF _expected_version IS NULL OR _expected_version < 1 THEN
    RAISE EXCEPTION 'invalid_expected_version';
  END IF;
  IF _note_clean IS NOT NULL AND char_length(_note_clean) > 2000 THEN
    RAISE EXCEPTION 'resolution_note_too_long';
  END IF;
  IF _status IN ('decided', 'closed') AND _note_clean IS NULL THEN
    RAISE EXCEPTION 'resolution_note_required';
  END IF;
  IF _global_action_note_clean IS NOT NULL AND char_length(_global_action_note_clean) > 2000 THEN
    RAISE EXCEPTION 'global_action_note_too_long';
  END IF;

  SELECT * INTO _report
  FROM public.operator_client_reports
  WHERE id = _report_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'report_not_found';
  END IF;
  IF _report.version <> _expected_version THEN
    RAISE EXCEPTION 'expected_version_mismatch';
  END IF;

  UPDATE public.operator_client_reports
  SET status = _status,
      resolution_note = _note_clean,
      global_action_note = _global_action_note_clean,
      version = _report.version + 1,
      updated_at = clock_timestamp(),
      updated_by = _admin_id,
      resolved_at = CASE
        WHEN _status IN ('decided', 'closed') THEN COALESCE(_report.resolved_at, clock_timestamp())
        ELSE NULL
      END,
      resolved_by = CASE
        WHEN _status IN ('decided', 'closed') THEN COALESCE(_report.resolved_by, _admin_id)
        ELSE NULL
      END
  WHERE id = _report_id
  RETURNING * INTO _updated;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _admin_id,
    'operator_client_report.moderated',
    'operator_client_report',
    _report_id::TEXT,
    jsonb_build_object(
      'previous_status', _report.status,
      'status', _updated.status,
      'previous_version', _report.version,
      'version', _updated.version,
      'resolution_note', _updated.resolution_note,
      'global_action_note', _updated.global_action_note
    )
  );

  RETURN jsonb_build_object(
    'report_id', _updated.id,
    'status', _updated.status,
    'version', _updated.version
  );
END;
$$;

-- PostgreSQL cannot replace a RETURNS TABLE function with a wider row type.
DROP FUNCTION public.get_admin_operator_client_reports();
CREATE FUNCTION public.get_admin_operator_client_reports()
RETURNS TABLE (
  id UUID,
  operator_id UUID,
  operator_name TEXT,
  client_id UUID,
  client_display_name TEXT,
  conversation_id UUID,
  reason TEXT,
  notes TEXT,
  source TEXT,
  created_at TIMESTAMPTZ,
  status TEXT,
  resolution_note TEXT,
  global_action_note TEXT,
  version INTEGER,
  updated_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID,
  updated_by UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  RETURN QUERY
  SELECT
    report.id,
    report.operator_id,
    operator.full_name,
    report.client_id,
    profile.display_name,
    report.conversation_id,
    report.reason,
    report.notes,
    report.source,
    report.created_at,
    report.status,
    report.resolution_note,
    report.global_action_note,
    report.version,
    report.updated_at,
    report.resolved_at,
    report.resolved_by,
    report.updated_by
  FROM public.operator_client_reports report
  JOIN public.operators operator ON operator.id = report.operator_id
  LEFT JOIN public.profiles profile ON profile.user_id = report.client_id
  ORDER BY report.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_admin_operations_snapshot()
RETURNS TABLE (
  generated_at TIMESTAMPTZ,
  activity_window_started_at TIMESTAMPTZ,
  new_total INTEGER,
  new_normal_count INTEGER,
  new_warning_count INTEGER,
  new_critical_count INTEGER,
  new_oldest_wait_seconds INTEGER,
  new_returned_count INTEGER,
  active_operator_count INTEGER,
  online_operator_count INTEGER,
  offline_operator_count INTEGER,
  active_handling_cycle_count INTEGER,
  outreach_sent_count INTEGER,
  outreach_replied_count INTEGER,
  open_client_report_count INTEGER,
  open_operator_report_count INTEGER,
  active_operator_client_block_count INTEGER,
  archived_client_count INTEGER,
  media_asset_total INTEGER,
  media_asset_available_count INTEGER,
  media_asset_reserved_count INTEGER,
  media_asset_sent_count INTEGER,
  media_asset_restored_count INTEGER,
  media_asset_disabled_count INTEGER,
  active_media_reservation_count INTEGER,
  active_media_tag_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
SET statement_timeout = '8s'
AS $$
DECLARE
  _generated_at TIMESTAMPTZ := clock_timestamp();
  _activity_window_started_at TIMESTAMPTZ := _generated_at - INTERVAL '24 hours';
BEGIN
  IF auth.uid() IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  RETURN QUERY
  WITH canonical_new AS (
    SELECT
      work_item.id AS work_item_id,
      client_message.created_at AS last_client_message_at,
      GREATEST(
        0,
        FLOOR(EXTRACT(EPOCH FROM (_generated_at - client_message.created_at)))::INTEGER
      ) AS wait_seconds
    FROM public.conversation_work_items work_item
    JOIN public.conversations conversation ON conversation.id = work_item.conversation_id
    JOIN public.messages client_message ON client_message.id = work_item.last_client_message_id
    JOIN public.profiles profile ON profile.user_id = work_item.client_id
    WHERE work_item.status = 'new'
      AND conversation.status <> 'closed'::public.conversation_status
      AND profile.status = 'active'
      AND profile.deleted_at IS NULL
      AND profile.pii_archived_at IS NULL
      AND client_message.sender_type = 'client'::public.sender_type
      AND NOT EXISTS (
        SELECT 1
        FROM public.conversation_handling_cycles active_cycle
        WHERE active_cycle.work_item_id = work_item.id
          AND active_cycle.ended_at IS NULL
      )
  ),
  new_metrics AS (
    SELECT
      COUNT(*)::INTEGER AS new_total,
      COUNT(*) FILTER (WHERE item.wait_seconds < 300)::INTEGER AS new_normal_count,
      COUNT(*) FILTER (WHERE item.wait_seconds >= 300 AND item.wait_seconds < 900)::INTEGER AS new_warning_count,
      COUNT(*) FILTER (WHERE item.wait_seconds >= 900)::INTEGER AS new_critical_count,
      COALESCE(MAX(item.wait_seconds), 0)::INTEGER AS new_oldest_wait_seconds,
      COUNT(*) FILTER (
        WHERE last_cycle.end_reason IN ('released', 'reassigned', 'timeout')
          AND item.last_client_message_at <= last_cycle.ended_at
      )::INTEGER AS new_returned_count
    FROM canonical_new item
    LEFT JOIN LATERAL (
      SELECT cycle.end_reason, cycle.ended_at
      FROM public.conversation_handling_cycles cycle
      WHERE cycle.work_item_id = item.work_item_id
        AND cycle.ended_at IS NOT NULL
      ORDER BY cycle.ended_at DESC
      LIMIT 1
    ) last_cycle ON TRUE
  ),
  operator_metrics AS (
    SELECT
      COUNT(*) FILTER (
        WHERE operator.is_active = TRUE
          AND operator.deleted_at IS NULL
      )::INTEGER AS active_operator_count,
      COUNT(*) FILTER (
        WHERE operator.is_active = TRUE
          AND operator.deleted_at IS NULL
          AND operator.last_seen_at >= _generated_at - INTERVAL '90 seconds'
      )::INTEGER AS online_operator_count,
      COUNT(*) FILTER (
        WHERE operator.is_active = TRUE
          AND operator.deleted_at IS NULL
          AND (operator.last_seen_at IS NULL OR operator.last_seen_at < _generated_at - INTERVAL '90 seconds')
      )::INTEGER AS offline_operator_count
    FROM public.operators operator
  ),
  handling_metrics AS (
    SELECT COUNT(*)::INTEGER AS active_handling_cycle_count
    FROM public.conversation_handling_cycles cycle
    WHERE cycle.ended_at IS NULL
  ),
  online_metrics AS (
    SELECT
      COUNT(*) FILTER (WHERE event.event_name = 'online_outreach_sent')::INTEGER AS outreach_sent_count,
      COUNT(*) FILTER (WHERE event.event_name = 'online_outreach_replied')::INTEGER AS outreach_replied_count
    FROM public.analytics_events event
    WHERE event.created_at >= _activity_window_started_at
      AND event.event_name IN ('online_outreach_sent', 'online_outreach_replied')
      AND NULLIF(event.metadata ->> 'dedupe_key', '') IS NOT NULL
  ),
  moderation_metrics AS (
    SELECT
      (SELECT COUNT(*)::INTEGER FROM public.reports report WHERE report.status = 'open') AS open_client_report_count,
      (SELECT COUNT(*)::INTEGER FROM public.operator_client_reports report
       WHERE report.status IN ('open', 'in_progress')) AS open_operator_report_count,
      (SELECT COUNT(*)::INTEGER FROM public.operator_client_blocks) AS active_operator_client_block_count,
      (
        SELECT COUNT(*)::INTEGER
        FROM public.profiles profile
        WHERE (
          profile.status = 'archived'
          OR profile.deleted_at IS NOT NULL
          OR profile.pii_archived_at IS NOT NULL
        )
          AND EXISTS (
            SELECT 1
            FROM public.user_roles role
            WHERE role.user_id = profile.user_id
              AND role.role = 'client'::public.app_role
          )
      ) AS archived_client_count
  ),
  media_metrics AS (
    SELECT
      COUNT(*)::INTEGER AS media_asset_total,
      COUNT(*) FILTER (WHERE asset.status = 'available')::INTEGER AS media_asset_available_count,
      COUNT(*) FILTER (WHERE asset.status = 'reserved')::INTEGER AS media_asset_reserved_count,
      COUNT(*) FILTER (WHERE asset.status = 'sent')::INTEGER AS media_asset_sent_count,
      COUNT(*) FILTER (WHERE asset.status = 'restored')::INTEGER AS media_asset_restored_count,
      COUNT(*) FILTER (WHERE asset.status = 'disabled')::INTEGER AS media_asset_disabled_count
    FROM public.character_media_assets asset
  ),
  reservation_metrics AS (
    SELECT COUNT(*)::INTEGER AS active_media_reservation_count
    FROM public.character_media_reservations reservation
    WHERE reservation.state = 'active'
      AND reservation.expires_at > _generated_at
  ),
  tag_metrics AS (
    -- Tags have no inactive state; every persisted tag is active in the current model.
    SELECT COUNT(*)::INTEGER AS active_media_tag_count
    FROM public.media_tags
  )
  SELECT
    _generated_at,
    _activity_window_started_at,
    new_metrics.new_total,
    new_metrics.new_normal_count,
    new_metrics.new_warning_count,
    new_metrics.new_critical_count,
    new_metrics.new_oldest_wait_seconds,
    new_metrics.new_returned_count,
    operator_metrics.active_operator_count,
    operator_metrics.online_operator_count,
    operator_metrics.offline_operator_count,
    handling_metrics.active_handling_cycle_count,
    online_metrics.outreach_sent_count,
    online_metrics.outreach_replied_count,
    moderation_metrics.open_client_report_count,
    moderation_metrics.open_operator_report_count,
    moderation_metrics.active_operator_client_block_count,
    moderation_metrics.archived_client_count,
    media_metrics.media_asset_total,
    media_metrics.media_asset_available_count,
    media_metrics.media_asset_reserved_count,
    media_metrics.media_asset_sent_count,
    media_metrics.media_asset_restored_count,
    media_metrics.media_asset_disabled_count,
    reservation_metrics.active_media_reservation_count,
    tag_metrics.active_media_tag_count
  FROM new_metrics
  CROSS JOIN operator_metrics
  CROSS JOIN handling_metrics
  CROSS JOIN online_metrics
  CROSS JOIN moderation_metrics
  CROSS JOIN media_metrics
  CROSS JOIN reservation_metrics
  CROSS JOIN tag_metrics;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_update_operator_client_report(UUID, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_operator_client_report(UUID, INTEGER, TEXT, TEXT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.get_admin_operator_client_reports() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_operator_client_reports() TO authenticated;
REVOKE ALL ON FUNCTION public.get_admin_operations_snapshot() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_operations_snapshot() TO authenticated;

NOTIFY pgrst, 'reload schema';
