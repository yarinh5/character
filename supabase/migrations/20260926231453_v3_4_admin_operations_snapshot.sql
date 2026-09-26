-- V3-4: a bounded, aggregate-only Admin read model for operational monitoring.
-- The function deliberately contains no PII, media paths, or write-side effects.

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
      -- Operator reports have no moderation lifecycle column; every persisted row is open.
      (SELECT COUNT(*)::INTEGER FROM public.operator_client_reports) AS open_operator_report_count,
      (SELECT COUNT(*)::INTEGER FROM public.operator_client_blocks) AS active_operator_client_block_count,
      (
        SELECT COUNT(*)::INTEGER
        FROM public.profiles profile
        WHERE profile.status = 'archived'
          OR profile.deleted_at IS NOT NULL
          OR profile.pii_archived_at IS NOT NULL
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

REVOKE ALL ON FUNCTION public.get_admin_operations_snapshot() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_operations_snapshot() TO authenticated;

NOTIFY pgrst, 'reload schema';
