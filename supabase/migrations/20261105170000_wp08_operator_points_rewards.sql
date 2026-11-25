-- WP08: Operator Points are an internal, non-monetary ledger. Existing client-credit
-- history remains immutable; future eligible score events and Gift pools use this ledger.

INSERT INTO public.system_settings (key, value)
VALUES
  ('client_text_credit_price', '10'::jsonb),
  ('operator_points_rule_version', '"wp08-v1"'::jsonb),
  ('gift_reward_precision_scale', '6'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

CREATE TABLE public.operator_point_wallets (
  operator_id uuid PRIMARY KEY REFERENCES public.operators(id) ON DELETE RESTRICT,
  balance numeric(18, 6) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  lifetime_earned numeric(18, 6) NOT NULL DEFAULT 0 CHECK (lifetime_earned >= 0),
  lifetime_adjusted numeric(18, 6) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.operator_point_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES public.operators(id) ON DELETE RESTRICT,
  amount numeric(18, 6) NOT NULL CHECK (amount <> 0),
  balance_after numeric(18, 6) NOT NULL CHECK (balance_after >= 0),
  event_type text NOT NULL CHECK (event_type IN ('response_reward', 'gift_pool', 'admin_adjustment', 'correction')),
  source_score_event_id uuid UNIQUE REFERENCES public.operator_score_events(id) ON DELETE RESTRICT,
  gift_reward_event_id uuid REFERENCES private.gift_reward_events(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (gift_reward_event_id, operator_id)
);

CREATE INDEX operator_point_transactions_operator_created_idx
  ON public.operator_point_transactions (operator_id, created_at DESC, id DESC);

CREATE TABLE private.gift_reward_allocations (
  gift_reward_event_id uuid NOT NULL REFERENCES private.gift_reward_events(id) ON DELETE RESTRICT,
  operator_id uuid NOT NULL REFERENCES public.operators(id) ON DELETE RESTRICT,
  amount numeric(18, 6) NOT NULL CHECK (amount > 0),
  point_transaction_id uuid NOT NULL UNIQUE REFERENCES public.operator_point_transactions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (gift_reward_event_id, operator_id)
);

ALTER TABLE private.gift_reward_events
  ADD COLUMN eligible_operator_count integer,
  ADD COLUMN eligibility_evaluated_at timestamptz,
  ADD COLUMN distributed_points numeric(18, 6),
  ADD COLUMN unallocated_points numeric(18, 6),
  ADD COLUMN rule_version text NOT NULL DEFAULT 'wp08-v1',
  ADD CONSTRAINT gift_reward_events_distribution_shape_check CHECK (
    (status = 'pending' AND eligible_operator_count IS NULL
      AND distributed_points IS NULL AND unallocated_points IS NULL AND processed_at IS NULL)
    OR
    (status = 'distributed' AND eligible_operator_count >= 0
      AND distributed_points >= 0 AND unallocated_points >= 0
      AND distributed_points + unallocated_points = reward_pool_points
      AND processed_at IS NOT NULL)
    OR
    (status = 'failed' AND failure_code IS NOT NULL)
  );

ALTER TABLE public.operator_point_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_point_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Operators view own point wallet"
  ON public.operator_point_wallets FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.operators operator
    WHERE operator.id = operator_point_wallets.operator_id
      AND operator.user_id = (SELECT auth.uid())
  ));
CREATE POLICY "Admins view point wallets"
  ON public.operator_point_wallets FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Operators view own point transactions"
  ON public.operator_point_transactions FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.operators operator
    WHERE operator.id = operator_point_transactions.operator_id
      AND operator.user_id = (SELECT auth.uid())
  ));
CREATE POLICY "Admins view point transactions"
  ON public.operator_point_transactions FOR SELECT TO authenticated USING (public.is_admin());

CREATE FUNCTION private.credit_operator_point_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _balance numeric(18, 6);
BEGIN
  IF NEW.points <= 0 OR EXISTS (
    SELECT 1 FROM public.user_roles role
    WHERE role.user_id = NEW.user_id AND role.role = 'admin'
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.operator_point_wallets (operator_id)
  VALUES (NEW.operator_id) ON CONFLICT (operator_id) DO NOTHING;

  PERFORM 1 FROM public.operator_point_wallets wallet
  WHERE wallet.operator_id = NEW.operator_id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.operator_point_transactions transaction
    WHERE transaction.source_score_event_id = NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  UPDATE public.operator_point_wallets
  SET balance = balance + NEW.points,
      lifetime_earned = lifetime_earned + NEW.points,
      updated_at = clock_timestamp()
  WHERE operator_id = NEW.operator_id
  RETURNING balance INTO _balance;

  INSERT INTO public.operator_point_transactions (
    operator_id, amount, balance_after, event_type, source_score_event_id, reason, metadata
  ) VALUES (
    NEW.operator_id, NEW.points, _balance, 'response_reward', NEW.id,
    'Eligible operator response',
    jsonb_build_object(
      'conversation_id', NEW.conversation_id,
      'message_id', NEW.message_id,
      'streak_position', NEW.streak_position,
      'rule_version', 'wp08-v1'
    )
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER credit_operator_point_event
  AFTER INSERT ON public.operator_score_events
  FOR EACH ROW EXECUTE FUNCTION private.credit_operator_point_event();

-- Sticker/Gift messages use the established sticker writer rather than
-- create_operator_message_with_scoring. Bridge that real path into the same
-- canonical score-event stream without creating a second points calculation.
CREATE FUNCTION private.record_operator_sticker_score_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _message public.messages%rowtype;
  _operator public.operators%rowtype;
  _last_client_at timestamptz;
  _streak_position integer;
  _limit integer := GREATEST(private.setting_int('consecutive_message_limit', 3), 0);
  _period_month date := date_trunc('month', clock_timestamp())::date;
  _points integer := 0;
BEGIN
  SELECT * INTO _message FROM public.messages message WHERE message.id = NEW.message_id;
  IF NOT FOUND OR _message.sender_type <> 'operator'::public.sender_type
    OR _message.operator_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO _operator FROM public.operators operator WHERE operator.id = _message.operator_id;
  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM public.user_roles role
    WHERE role.user_id = _operator.user_id AND role.role = 'admin'
  ) OR EXISTS (
    SELECT 1 FROM public.operator_score_events event WHERE event.message_id = _message.id
  ) THEN
    RETURN NEW;
  END IF;

  IF private.setting_bool('scoring_enabled', true) IS NOT TRUE OR _limit = 0 THEN
    RETURN NEW;
  END IF;

  SELECT max(message.created_at) INTO _last_client_at
  FROM public.messages message
  WHERE message.conversation_id = _message.conversation_id
    AND message.sender_type = 'client'::public.sender_type;

  SELECT count(*)::integer INTO _streak_position
  FROM public.messages message
  WHERE message.conversation_id = _message.conversation_id
    AND message.sender_type = 'operator'::public.sender_type
    AND message.created_at > COALESCE(_last_client_at, '-infinity'::timestamptz);

  IF _streak_position <= _limit THEN
    _points := 1;
    INSERT INTO public.operator_score_events (
      operator_id, user_id, conversation_id, message_id, points,
      period_month, streak_position, limit_applied, reason, metadata
    ) VALUES (
      _operator.id, _operator.user_id, _message.conversation_id, _message.id, _points,
      _period_month, _streak_position, _limit, 'operator_sticker',
      jsonb_build_object('source', 'send_operator_sticker_message', 'sticker_id', NEW.sticker_id)
    );
  END IF;

  INSERT INTO public.operator_monthly_scores (operator_id, period_month, points, message_count)
  VALUES (_operator.id, _period_month, _points, 1)
  ON CONFLICT (operator_id, period_month)
  DO UPDATE SET points = public.operator_monthly_scores.points + EXCLUDED.points,
                message_count = public.operator_monthly_scores.message_count + 1,
                updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER record_operator_sticker_score_event
  AFTER INSERT ON public.message_stickers
  FOR EACH ROW EXECUTE FUNCTION private.record_operator_sticker_score_event();

CREATE FUNCTION private.distribute_gift_reward_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _eligible_count integer;
  _eligible_operator_ids uuid[] := ARRAY[]::uuid[];
  _eligibility_evaluated_at timestamptz := clock_timestamp();
  _pool_micros bigint;
  _base_micros bigint;
  _remainder bigint;
  _ordinal integer := 0;
  _amount numeric(18, 6);
  _balance numeric(18, 6);
  _transaction_id uuid;
  _distributed_micros bigint := 0;
  _operator record;
  _heartbeat_stale_minutes integer := GREATEST(private.setting_int('operator_heartbeat_stale_minutes', 5), 1);
BEGIN
  SELECT COALESCE(array_agg(operator.id ORDER BY operator.id), ARRAY[]::uuid[])
  INTO _eligible_operator_ids
  FROM public.operators operator
  WHERE operator.is_active = TRUE
    AND operator.deleted_at IS NULL
    AND operator.presence_status = 'online'
    AND operator.last_seen_at >= _eligibility_evaluated_at - make_interval(mins => _heartbeat_stale_minutes)
    AND EXISTS (
      SELECT 1 FROM public.user_roles role
      WHERE role.user_id = operator.user_id AND role.role = 'operator'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.user_roles role
      WHERE role.user_id = operator.user_id AND role.role = 'admin'
    );

  _eligible_count := cardinality(_eligible_operator_ids);

  IF _eligible_count = 0 THEN
    UPDATE private.gift_reward_events
    SET status = 'distributed', eligible_operator_count = 0,
        eligibility_evaluated_at = _eligibility_evaluated_at,
        distributed_points = 0, unallocated_points = NEW.reward_pool_points,
        processed_at = clock_timestamp()
    WHERE id = NEW.id;
    RETURN NEW;
  END IF;

  _pool_micros := round(NEW.reward_pool_points * 1000000)::bigint;
  _base_micros := _pool_micros / _eligible_count;
  _remainder := mod(_pool_micros, _eligible_count);

  FOR _operator IN
    SELECT eligible.operator_id AS id
    FROM unnest(_eligible_operator_ids) WITH ORDINALITY AS eligible(operator_id, ordinal)
    ORDER BY eligible.ordinal
  LOOP
    _ordinal := _ordinal + 1;
    _amount := (_base_micros + CASE WHEN _ordinal <= _remainder THEN 1 ELSE 0 END)::numeric / 1000000;
    IF _amount <= 0 THEN CONTINUE; END IF;
    _distributed_micros := _distributed_micros + round(_amount * 1000000)::bigint;

    INSERT INTO public.operator_point_wallets (operator_id)
    VALUES (_operator.id) ON CONFLICT (operator_id) DO NOTHING;
    PERFORM 1 FROM public.operator_point_wallets wallet
    WHERE wallet.operator_id = _operator.id FOR UPDATE;
    UPDATE public.operator_point_wallets
    SET balance = balance + _amount,
        lifetime_earned = lifetime_earned + _amount,
        updated_at = clock_timestamp()
    WHERE operator_id = _operator.id
    RETURNING balance INTO _balance;

    INSERT INTO public.operator_point_transactions (
      operator_id, amount, balance_after, event_type, gift_reward_event_id, reason, metadata
    ) VALUES (
      _operator.id, _amount, _balance, 'gift_pool', NEW.id, 'Gift reward pool allocation',
      jsonb_build_object('purchase_id', NEW.purchase_id, 'rule_version', NEW.rule_version)
    ) RETURNING id INTO _transaction_id;

    INSERT INTO private.gift_reward_allocations (
      gift_reward_event_id, operator_id, amount, point_transaction_id
    ) VALUES (NEW.id, _operator.id, _amount, _transaction_id);
  END LOOP;

  UPDATE private.gift_reward_events
  SET status = 'distributed', eligible_operator_count = _eligible_count,
      eligibility_evaluated_at = _eligibility_evaluated_at,
      distributed_points = _distributed_micros::numeric / 1000000,
      unallocated_points = NEW.reward_pool_points - (_distributed_micros::numeric / 1000000),
      processed_at = clock_timestamp()
  WHERE id = NEW.id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER distribute_gift_reward_event
  AFTER INSERT ON private.gift_reward_events
  FOR EACH ROW EXECUTE FUNCTION private.distribute_gift_reward_event();

-- The production helper remains the single source of response eligibility. This
-- writer stops mirroring internal points into the client-credit wallet.
CREATE OR REPLACE FUNCTION private.send_operator_message(_conversation_id uuid, _content text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _content_clean text := btrim(COALESCE(_content, ''));
  _guard record;
  _message_result record;
BEGIN
  IF char_length(_content_clean) = 0 OR char_length(_content_clean) > 2000 THEN
    RAISE EXCEPTION 'invalid_message_content';
  END IF;
  SELECT * INTO _guard FROM private.assert_operator_can_send_conversation_message(_conversation_id);
  SELECT * INTO _message_result
  FROM private.create_operator_message_with_scoring(
    _conversation_id, _guard.operator_id, _guard.user_id, _content_clean,
    jsonb_build_object('source', 'send_operator_message')
  );
  RETURN jsonb_build_object(
    'message', _message_result.message,
    'score_awarded', _message_result.score_awarded,
    'operator_points_awarded', _message_result.score_awarded,
    'credit_awarded', 0,
    'streak_position', _message_result.streak_position,
    'consecutive_message_limit', _message_result.consecutive_message_limit,
    'monthly_points', _message_result.monthly_points,
    'scoring_enabled', _message_result.scoring_enabled,
    'concurrency_mode', _guard.concurrency_mode
  );
END;
$$;

-- Client text costs 10 credits from this version forward. No Client Credits are
-- paid to an operator; their eligible response is recorded in Operator Points.
CREATE OR REPLACE FUNCTION public.send_client_message(_conversation_id uuid, _content text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _content_clean text := btrim(COALESCE(_content, ''));
  _conversation public.conversations%rowtype;
  _credits_enabled boolean;
  _price integer := GREATEST(private.setting_int('client_text_credit_price', 10), 0);
  _balance integer;
  _message public.messages%rowtype;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF _user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  PERFORM private.ensure_active_client(_user_id);
  IF char_length(_content_clean) = 0 OR char_length(_content_clean) > 2000 THEN
    RAISE EXCEPTION 'invalid_message_content';
  END IF;
  SELECT * INTO _conversation FROM public.conversations
  WHERE id = _conversation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_not_found'; END IF;
  IF _conversation.client_id <> _user_id THEN RAISE EXCEPTION 'conversation_access_denied'; END IF;
  IF _conversation.status = 'closed'::public.conversation_status THEN RAISE EXCEPTION 'conversation_closed'; END IF;
  IF _conversation.client_hidden_at IS NOT NULL OR EXISTS (
    SELECT 1 FROM public.client_conversation_deletions deletion
    WHERE deletion.client_id = _user_id AND deletion.conversation_id = _conversation_id
  ) THEN RAISE EXCEPTION 'conversation_deleted_for_client'; END IF;

  _credits_enabled := private.setting_bool('credits_enabled', true);
  INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
  VALUES (_user_id, 0, 0, 0) ON CONFLICT (user_id) DO NOTHING;
  SELECT balance INTO _balance FROM public.credit_wallets
  WHERE user_id = _user_id FOR UPDATE;
  IF _credits_enabled AND COALESCE(_balance, 0) < _price THEN RAISE EXCEPTION 'insufficient_credits'; END IF;

  INSERT INTO public.messages (conversation_id, sender_type, sender_id, content, created_at)
  VALUES (_conversation_id, 'client'::public.sender_type, _user_id, _content_clean, clock_timestamp())
  RETURNING * INTO _message;

  IF _credits_enabled AND _price > 0 THEN
    UPDATE public.credit_wallets
    SET balance = balance - _price, lifetime_spent = lifetime_spent + _price
    WHERE user_id = _user_id RETURNING balance INTO _balance;
    INSERT INTO public.credit_transactions (
      user_id, amount, balance_after, type, reason, message_id, metadata
    ) VALUES (
      _user_id, -_price, _balance, 'message_spend', 'Client text message', _message.id,
      jsonb_build_object('conversation_id', _conversation_id, 'price_version', 'wp07-v1')
    );
  END IF;

  RETURN jsonb_build_object(
    'message', to_jsonb(_message), 'balance', COALESCE(_balance, 0),
    'credits_enabled', _credits_enabled, 'price_credits', CASE WHEN _credits_enabled THEN _price ELSE 0 END
  );
END;
$$;

CREATE FUNCTION public.admin_adjust_operator_points(
  _operator_id uuid,
  _amount numeric,
  _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _actor uuid := auth.uid();
  _amount_clean numeric(18, 6) := round(COALESCE(_amount, 0), 6);
  _reason_clean text := btrim(COALESCE(_reason, ''));
  _balance numeric(18, 6);
  _transaction_id uuid;
BEGIN
  IF _actor IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'admin_required'; END IF;
  IF _amount_clean = 0 THEN RAISE EXCEPTION 'operator_point_adjustment_required'; END IF;
  IF char_length(_reason_clean) < 3 OR char_length(_reason_clean) > 500 THEN
    RAISE EXCEPTION 'operator_point_adjustment_reason_required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.operators operator WHERE operator.id = _operator_id) THEN
    RAISE EXCEPTION 'operator_not_found';
  END IF;

  INSERT INTO public.operator_point_wallets (operator_id)
  VALUES (_operator_id) ON CONFLICT (operator_id) DO NOTHING;
  SELECT balance INTO _balance FROM public.operator_point_wallets
  WHERE operator_id = _operator_id FOR UPDATE;
  IF _balance + _amount_clean < 0 THEN RAISE EXCEPTION 'insufficient_operator_points'; END IF;

  UPDATE public.operator_point_wallets
  SET balance = balance + _amount_clean,
      lifetime_earned = lifetime_earned + GREATEST(_amount_clean, 0),
      lifetime_adjusted = lifetime_adjusted + _amount_clean,
      updated_at = clock_timestamp()
  WHERE operator_id = _operator_id RETURNING balance INTO _balance;

  INSERT INTO public.operator_point_transactions (
    operator_id, amount, balance_after, event_type, reason, metadata
  ) VALUES (
    _operator_id, _amount_clean, _balance, 'admin_adjustment', _reason_clean,
    jsonb_build_object('actor_user_id', _actor, 'rule_version', 'wp08-v1')
  ) RETURNING id INTO _transaction_id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _actor, 'operator_points.adjusted', 'operator', _operator_id::text,
    jsonb_build_object('amount', _amount_clean, 'balance_after', _balance,
      'reason', _reason_clean, 'point_transaction_id', _transaction_id)
  );
  RETURN jsonb_build_object(
    'operator_id', _operator_id, 'amount', _amount_clean,
    'balance', _balance, 'transaction_id', _transaction_id
  );
END;
$$;

REVOKE ALL ON TABLE private.gift_reward_allocations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.credit_operator_point_event() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.distribute_gift_reward_event() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.operator_point_wallets, public.operator_point_transactions FROM PUBLIC, anon;
GRANT SELECT ON public.operator_point_wallets, public.operator_point_transactions TO authenticated;
REVOKE ALL ON FUNCTION public.admin_adjust_operator_points(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_adjust_operator_points(uuid, numeric, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.send_client_message(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_client_message(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
