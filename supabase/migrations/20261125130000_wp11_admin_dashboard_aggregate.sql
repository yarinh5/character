-- Active /admin/ dashboard only. The server supplies the existing JS cutoffs and chart keys.
CREATE FUNCTION public.get_admin_dashboard_analytics_for_server(
  _since timestamptz,
  _month_start timestamptz,
  _day_keys date[]
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH recent_messages AS (
    SELECT id, conversation_id, sender_id, sender_type, created_at
    FROM public.messages
    WHERE created_at >= _since
  ),
  message_days AS (
    SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS count
    FROM recent_messages
    GROUP BY 1
  ),
  conversation_days AS (
    SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS count
    FROM public.conversations
    WHERE created_at >= _since
    GROUP BY 1
  ),
  profile_days AS (
    SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS count
    FROM public.profiles
    WHERE created_at >= _since
    GROUP BY 1
  ),
  chart_keys AS (
    -- Local midnight converted to UTC can repeat a key at DST. JS counted it only in the first bucket.
    SELECT day, position, row_number() OVER (PARTITION BY day ORDER BY position) = 1 AS first_bucket
    FROM unnest(_day_keys) WITH ORDINALITY AS keys(day, position)
  ),
  chart AS (
    SELECT jsonb_agg(
      jsonb_build_object(
        'date', keys.day,
        'conversations', coalesce(conversation_days.count, 0),
        'users', coalesce(profile_days.count, 0),
        'messages', coalesce(message_days.count, 0)
      ) ORDER BY keys.position
    ) AS days
    FROM chart_keys keys
    LEFT JOIN conversation_days ON conversation_days.day = keys.day AND keys.first_bucket
    LEFT JOIN profile_days ON profile_days.day = keys.day AND keys.first_bucket
    LEFT JOIN message_days ON message_days.day = keys.day AND keys.first_bucket
  ),
  response_sequence AS (
    -- Ignoring other senders, only a client -> operator transition consumes a pending client.
    -- Use message id for timestamp ties and millisecond elapsed times as in JS Dates.
    SELECT sender_type, date_trunc('milliseconds', created_at) AS sent_at,
      lag(sender_type) OVER thread AS previous_sender_type,
      lag(date_trunc('milliseconds', created_at)) OVER thread AS previous_sent_at
    FROM recent_messages
    WHERE sender_type IN ('client', 'operator')
    WINDOW thread AS (PARTITION BY conversation_id ORDER BY created_at, id)
  ),
  response_time AS (
    SELECT coalesce(round(avg(extract(epoch FROM sent_at - previous_sent_at))), 0) AS seconds
    FROM response_sequence
    WHERE sender_type = 'operator' AND previous_sender_type = 'client'
  ),
  operator_counts AS (
    SELECT sender_id, count(*) AS count
    FROM recent_messages
    WHERE sender_type = 'operator' AND sender_id IS NOT NULL
    GROUP BY sender_id
    ORDER BY count DESC, sender_id
    LIMIT 5
  ),
  character_counts AS (
    SELECT character_id, count(*) AS count
    FROM public.conversations
    GROUP BY character_id
    ORDER BY count DESC, character_id
    LIMIT 5
  ),
  credits AS (
    SELECT
      coalesce(sum(-(amount::bigint)) FILTER (WHERE amount < 0), 0) AS spent,
      coalesce(sum(amount) FILTER (WHERE amount > 0 AND type = 'admin_adjustment'), 0) AS added
    FROM public.credit_transactions
  ),
  message_totals AS (
    SELECT
      count(*) FILTER (WHERE sender_type = 'client') AS clients,
      count(*) FILTER (WHERE sender_type = 'operator') AS operators
    FROM public.messages
    WHERE sender_type IN ('client', 'operator')
  ),
  monthly_points AS (
    SELECT operator_id, coalesce(sum(amount) FILTER (WHERE amount > 0), 0) AS earned,
      count(*) FILTER (WHERE event_type = 'response_reward') AS responses
    FROM public.operator_point_transactions
    WHERE created_at >= _month_start
    GROUP BY operator_id
  ),
  point_rank AS (
    SELECT op.id, coalesce(op.full_name, '—') AS name,
      coalesce(wallet.balance, 0) AS available,
      coalesce(points.earned, 0) AS payouts,
      coalesce(points.responses, 0) AS messages,
      coalesce(op.availability_status::text, 'offline') AS status,
      coalesce(op.is_active, false) AS is_active
    FROM public.operators op
    LEFT JOIN public.operator_point_wallets wallet ON wallet.operator_id = op.id
    LEFT JOIN monthly_points points ON points.operator_id = op.id
    ORDER BY available DESC, payouts DESC, op.id
    LIMIT 8
  ),
  low_balances AS (
    SELECT user_id, balance
    FROM public.credit_wallets
    WHERE balance <= 2
    ORDER BY balance, user_id
    LIMIT 12
  )
  SELECT jsonb_build_object(
    'days', chart.days,
    'avgResponseSec', response_time.seconds,
    'topOperators', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object('name', coalesce(p.display_name, '—'), 'count', op.count)
        ORDER BY op.count DESC, op.sender_id
      )
      FROM operator_counts op
      LEFT JOIN public.profiles p ON p.user_id = op.sender_id
    ), '[]'::jsonb),
    'topCharacters', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object('name', coalesce(c.name, '—'), 'count', ranked.count)
        ORDER BY ranked.count DESC, ranked.character_id
      )
      FROM character_counts ranked
      LEFT JOIN public.characters c ON c.id = ranked.character_id
    ), '[]'::jsonb),
    'totalCreditsSpent', credits.spent,
    'manualCreditsAdded', credits.added,
    'clientMessages', message_totals.clients,
    'operatorMessages', message_totals.operators,
    'topOperatorsByAvailablePoints', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', id, 'name', name, 'availablePoints', available, 'monthlyPayouts', payouts,
          'messages', messages, 'status', status, 'isActive', is_active
        ) ORDER BY available DESC, payouts DESC, id
      )
      FROM point_rank
    ), '[]'::jsonb),
    'lowBalanceUsers', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'userId', wallet.user_id, 'name', coalesce(p.display_name, p.email, '—'),
          'email', p.email, 'balance', wallet.balance
        ) ORDER BY wallet.balance, wallet.user_id
      )
      FROM low_balances wallet
      LEFT JOIN public.profiles p ON p.user_id = wallet.user_id
    ), '[]'::jsonb)
  )
  FROM chart
  CROSS JOIN response_time
  CROSS JOIN credits
  CROSS JOIN message_totals;
$$;

REVOKE ALL ON FUNCTION public.get_admin_dashboard_analytics_for_server(timestamptz, timestamptz, date[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_dashboard_analytics_for_server(timestamptz, timestamptz, date[])
  TO service_role;
