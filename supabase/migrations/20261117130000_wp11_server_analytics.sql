-- WP11: compute the complete bounded analytics report inside PostgreSQL. The
-- server boundary receives only aggregated JSON; it never truncates source rows.
CREATE OR REPLACE FUNCTION public.get_admin_advanced_analytics_for_server(
  _start_date date,
  _end_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _result jsonb;
BEGIN
  IF _start_date IS NULL
     OR _end_date IS NULL
     OR _start_date > _end_date
     OR (_end_date - _start_date) > 180 THEN
    RAISE EXCEPTION 'invalid_analytics_date_range';
  END IF;

  WITH
  bounds AS (
    SELECT
      (_start_date::timestamp AT TIME ZONE 'UTC') AS start_at,
      ((_end_date + 1)::timestamp AT TIME ZONE 'UTC') AS end_at
  ),
  profile_daily AS (
    SELECT (profile.created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS count
    FROM public.profiles profile, bounds
    WHERE profile.created_at >= bounds.start_at AND profile.created_at < bounds.end_at
    GROUP BY 1
  ),
  conversation_daily AS (
    SELECT (conversation.created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS count
    FROM public.conversations conversation, bounds
    WHERE conversation.created_at >= bounds.start_at AND conversation.created_at < bounds.end_at
    GROUP BY 1
  ),
  message_daily AS (
    SELECT
      (message.created_at AT TIME ZONE 'UTC')::date AS day,
      COUNT(*) FILTER (WHERE message.sender_type = 'client') AS client_count,
      COUNT(*) FILTER (WHERE message.sender_type = 'operator') AS operator_count
    FROM public.messages message, bounds
    WHERE message.created_at >= bounds.start_at AND message.created_at < bounds.end_at
    GROUP BY 1
  ),
  event_daily AS (
    SELECT (event.created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS count
    FROM public.analytics_events event, bounds
    WHERE event.created_at >= bounds.start_at AND event.created_at < bounds.end_at
    GROUP BY 1
  ),
  event_counts AS (
    SELECT event.event_name, COUNT(*) AS count
    FROM public.analytics_events event, bounds
    WHERE event.created_at >= bounds.start_at AND event.created_at < bounds.end_at
    GROUP BY event.event_name
  ),
  day_rows AS (
    SELECT
      series.day::date AS day,
      COALESCE(profile_daily.count, 0) AS signups,
      COALESCE(conversation_daily.count, 0) AS conversations,
      COALESCE(message_daily.client_count, 0) AS client_messages,
      COALESCE(message_daily.operator_count, 0) AS operator_messages,
      COALESCE(event_daily.count, 0) AS events
    FROM generate_series(_start_date, _end_date, interval '1 day') AS series(day)
    LEFT JOIN profile_daily ON profile_daily.day = series.day::date
    LEFT JOIN conversation_daily ON conversation_daily.day = series.day::date
    LEFT JOIN message_daily ON message_daily.day = series.day::date
    LEFT JOIN event_daily ON event_daily.day = series.day::date
  ),
  character_conversations AS (
    SELECT conversation.character_id, COUNT(*) AS count
    FROM public.conversations conversation, bounds
    WHERE conversation.created_at >= bounds.start_at AND conversation.created_at < bounds.end_at
    GROUP BY conversation.character_id
  ),
  character_views AS (
    SELECT event.character_id, COUNT(*) AS count
    FROM public.analytics_events event, bounds
    WHERE event.created_at >= bounds.start_at
      AND event.created_at < bounds.end_at
      AND event.event_name = 'character_viewed'
      AND event.character_id IS NOT NULL
    GROUP BY event.character_id
  ),
  top_characters AS (
    SELECT
      character.id,
      character.name,
      COALESCE(character_conversations.count, 0) AS conversations,
      COALESCE(character_views.count, 0) AS views
    FROM public.characters character
    LEFT JOIN character_conversations ON character_conversations.character_id = character.id
    LEFT JOIN character_views ON character_views.character_id = character.id
    WHERE character_conversations.character_id IS NOT NULL OR character_views.character_id IS NOT NULL
    ORDER BY
      COALESCE(character_conversations.count, 0) + COALESCE(character_views.count, 0) DESC,
      character.id
    LIMIT 8
  ),
  operator_messages AS (
    SELECT message.operator_id, COUNT(*) AS count
    FROM public.messages message, bounds
    WHERE message.created_at >= bounds.start_at
      AND message.created_at < bounds.end_at
      AND message.sender_type = 'operator'
      AND message.operator_id IS NOT NULL
    GROUP BY message.operator_id
  ),
  operator_points AS (
    SELECT transaction.operator_id, SUM(GREATEST(transaction.amount, 0)) AS points
    FROM public.operator_point_transactions transaction, bounds
    WHERE transaction.created_at >= bounds.start_at AND transaction.created_at < bounds.end_at
    GROUP BY transaction.operator_id
  ),
  top_operators AS (
    SELECT
      operator.id,
      operator.full_name AS name,
      COALESCE(operator_messages.count, 0) AS messages,
      COALESCE(operator_points.points, 0) AS points,
      operator.availability_status::text AS status
    FROM public.operators operator
    LEFT JOIN operator_messages ON operator_messages.operator_id = operator.id
    LEFT JOIN operator_points ON operator_points.operator_id = operator.id
    WHERE operator_messages.operator_id IS NOT NULL OR operator_points.operator_id IS NOT NULL
    ORDER BY
      COALESCE(operator_messages.count, 0) + COALESCE(operator_points.points, 0) DESC,
      operator.id
    LIMIT 8
  ),
  funnel_names(event_name, ordinal) AS (
    VALUES
      ('signup_completed'::text, 1),
      ('onboarding_completed'::text, 2),
      ('character_viewed'::text, 3),
      ('conversation_started'::text, 4),
      ('first_message_sent'::text, 5),
      ('packages_viewed'::text, 6)
  )
  SELECT jsonb_build_object(
    'range', jsonb_build_object(
      'startDate', _start_date::text,
      'endDate', _end_date::text
    ),
    'kpis', jsonb_build_object(
      'newUsers', (
        SELECT COUNT(*) FROM public.profiles profile, bounds
        WHERE profile.created_at >= bounds.start_at AND profile.created_at < bounds.end_at
      ),
      'conversationsStarted', (
        SELECT COUNT(*) FROM public.conversations conversation, bounds
        WHERE conversation.created_at >= bounds.start_at AND conversation.created_at < bounds.end_at
      ),
      'clientMessages', (
        SELECT COUNT(*) FROM public.messages message, bounds
        WHERE message.created_at >= bounds.start_at AND message.created_at < bounds.end_at
          AND message.sender_type = 'client'
      ),
      'operatorMessages', (
        SELECT COUNT(*) FROM public.messages message, bounds
        WHERE message.created_at >= bounds.start_at AND message.created_at < bounds.end_at
          AND message.sender_type = 'operator'
      ),
      'characterViews', COALESCE((
        SELECT event_counts.count FROM event_counts WHERE event_counts.event_name = 'character_viewed'
      ), 0),
      'packagesViewed', COALESCE((
        SELECT event_counts.count FROM event_counts WHERE event_counts.event_name = 'packages_viewed'
      ), 0),
      'insufficientCredits', COALESCE((
        SELECT event_counts.count FROM event_counts WHERE event_counts.event_name = 'insufficient_credits_shown'
      ), 0),
      'creditsBurn', COALESCE((
        SELECT SUM(ABS(transaction.amount))
        FROM public.credit_transactions transaction, bounds
        WHERE transaction.created_at >= bounds.start_at
          AND transaction.created_at < bounds.end_at
          AND transaction.amount < 0
      ), 0)
    ),
    'funnel', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('eventName', funnel_names.event_name, 'count', COALESCE(event_counts.count, 0))
        ORDER BY funnel_names.ordinal
      )
      FROM funnel_names
      LEFT JOIN event_counts ON event_counts.event_name = funnel_names.event_name
    ), '[]'::jsonb),
    'days', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'date', day_rows.day::text,
          'signups', day_rows.signups,
          'conversations', day_rows.conversations,
          'clientMessages', day_rows.client_messages,
          'operatorMessages', day_rows.operator_messages,
          'events', day_rows.events
        ) ORDER BY day_rows.day
      ) FROM day_rows
    ), '[]'::jsonb),
    'topCharacters', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', top_characters.id,
          'name', top_characters.name,
          'conversations', top_characters.conversations,
          'views', top_characters.views
        ) ORDER BY top_characters.conversations + top_characters.views DESC, top_characters.id
      ) FROM top_characters
    ), '[]'::jsonb),
    'topOperators', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', top_operators.id,
          'name', top_operators.name,
          'messages', top_operators.messages,
          'points', top_operators.points,
          'status', top_operators.status
        ) ORDER BY top_operators.messages + top_operators.points DESC, top_operators.id
      ) FROM top_operators
    ), '[]'::jsonb)
  ) INTO _result;

  RETURN _result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_advanced_analytics_for_server(date, date)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_admin_advanced_analytics_for_server(date, date)
TO service_role;
