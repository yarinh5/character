-- WP07/WP09: manual credit requests and canonical client message levels.
-- This migration does not add payment processing and does not rewrite balances.

CREATE TABLE public.credit_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  package_id UUID REFERENCES public.credit_packages(id) ON DELETE SET NULL,
  package_name_snapshot TEXT NOT NULL CHECK (char_length(btrim(package_name_snapshot)) BETWEEN 1 AND 120),
  credits_snapshot INTEGER NOT NULL CHECK (credits_snapshot > 0),
  price_snapshot NUMERIC(10, 2) NOT NULL CHECK (price_snapshot >= 0),
  currency_snapshot TEXT NOT NULL CHECK (char_length(currency_snapshot) BETWEEN 3 AND 8),
  idempotency_key UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution_note TEXT,
  transaction_id UUID UNIQUE REFERENCES public.credit_transactions(id) ON DELETE RESTRICT,
  CHECK (
    (status = 'pending' AND resolved_at IS NULL AND resolved_by IS NULL AND transaction_id IS NULL)
    OR (status = 'approved' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND transaction_id IS NOT NULL)
    OR (status IN ('rejected', 'cancelled') AND resolved_at IS NOT NULL AND transaction_id IS NULL)
  ),
  UNIQUE (client_id, idempotency_key)
);

CREATE INDEX credit_requests_admin_queue_idx
  ON public.credit_requests(status, requested_at, id);
CREATE INDEX credit_requests_client_created_idx
  ON public.credit_requests(client_id, requested_at DESC, id DESC);

ALTER TABLE public.credit_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.credit_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.credit_requests TO authenticated;

CREATE POLICY "Clients view own credit requests"
  ON public.credit_requests FOR SELECT TO authenticated
  USING (client_id = (SELECT auth.uid()));
CREATE POLICY "Admins view credit requests"
  ON public.credit_requests FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE OR REPLACE FUNCTION public.create_credit_request(
  _package_id UUID,
  _idempotency_key UUID
)
RETURNS TABLE (
  id UUID,
  package_id UUID,
  package_name TEXT,
  credits INTEGER,
  status TEXT,
  requested_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _client UUID := auth.uid();
  _package public.credit_packages%ROWTYPE;
  _request public.credit_requests%ROWTYPE;
BEGIN
  IF _client IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  PERFORM private.ensure_active_client(_client);
  IF _idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency_key_required';
  END IF;

  SELECT * INTO _package
  FROM public.credit_packages package
  WHERE package.id = _package_id
    AND package.is_active = TRUE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_package_unavailable';
  END IF;

  INSERT INTO public.credit_requests (
    client_id, package_id, package_name_snapshot, credits_snapshot,
    price_snapshot, currency_snapshot, idempotency_key
  )
  VALUES (
    _client, _package.id, _package.name, _package.credits,
    _package.price, _package.currency, _idempotency_key
  )
  ON CONFLICT (client_id, idempotency_key) DO NOTHING
  RETURNING * INTO _request;

  IF _request.id IS NULL THEN
    SELECT * INTO _request
    FROM public.credit_requests request
    WHERE request.client_id = _client
      AND request.idempotency_key = _idempotency_key;
    IF _request.package_id IS DISTINCT FROM _package.id THEN
      RAISE EXCEPTION 'credit_request_idempotency_conflict';
    END IF;
  END IF;

  id := _request.id;
  package_id := _request.package_id;
  package_name := _request.package_name_snapshot;
  credits := _request.credits_snapshot;
  status := _request.status;
  requested_at := _request.requested_at;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_credit_request(
  _request_id UUID,
  _decision TEXT,
  _note TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  status TEXT,
  transaction_id UUID,
  balance_after INTEGER,
  resolved_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _admin UUID := auth.uid();
  _request public.credit_requests%ROWTYPE;
  _balance INTEGER;
  _transaction_id UUID;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_only' USING ERRCODE = '42501';
  END IF;
  IF _decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'invalid_credit_request_decision';
  END IF;

  SELECT * INTO _request
  FROM public.credit_requests request
  WHERE request.id = _request_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_request_not_found';
  END IF;

  IF _request.status <> 'pending' THEN
    IF _request.status <> _decision THEN
      RAISE EXCEPTION 'credit_request_already_resolved';
    END IF;
    SELECT wallet.balance INTO _balance
    FROM public.credit_wallets wallet
    WHERE wallet.user_id = _request.client_id;
    id := _request.id;
    status := _request.status;
    transaction_id := _request.transaction_id;
    balance_after := _balance;
    resolved_at := _request.resolved_at;
    RETURN NEXT;
    RETURN;
  END IF;

  IF _decision = 'approved' THEN
    INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
    VALUES (_request.client_id, 0, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;

    SELECT wallet.balance INTO _balance
    FROM public.credit_wallets wallet
    WHERE wallet.user_id = _request.client_id
    FOR UPDATE;

    _balance := _balance + _request.credits_snapshot;
    UPDATE public.credit_wallets
    SET balance = _balance,
        lifetime_earned = lifetime_earned + _request.credits_snapshot
    WHERE user_id = _request.client_id;

    INSERT INTO public.credit_transactions (
      user_id, amount, balance_after, type, reason, package_id, created_by, metadata
    )
    VALUES (
      _request.client_id, _request.credits_snapshot, _balance,
      'admin_adjustment', 'Approved manual credit request', _request.package_id, _admin,
      jsonb_build_object(
        'source', 'credit_request',
        'credit_request_id', _request.id,
        'price_snapshot', _request.price_snapshot,
        'currency_snapshot', _request.currency_snapshot
      )
    )
    RETURNING credit_transactions.id INTO _transaction_id;
  END IF;

  UPDATE public.credit_requests request
  SET status = _decision,
      resolved_at = clock_timestamp(),
      resolved_by = _admin,
      resolution_note = NULLIF(btrim(_note), ''),
      transaction_id = _transaction_id
  WHERE request.id = _request.id
  RETURNING request.resolved_at INTO resolved_at;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _admin, 'credit_request.' || _decision, 'credit_request', _request.id::TEXT,
    jsonb_build_object(
      'client_id', _request.client_id,
      'credits', _request.credits_snapshot,
      'transaction_id', _transaction_id
    )
  );

  id := _request.id;
  status := _decision;
  transaction_id := _transaction_id;
  balance_after := _balance;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.create_credit_request(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_credit_request(UUID, UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.resolve_credit_request(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_credit_request(UUID, TEXT, TEXT) TO authenticated;

-- Canonical client level source. Rows are append-only by message id, so retries
-- and multiple downstream triggers cannot increment the count twice.
CREATE TABLE public.client_level_progress (
  client_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  eligible_message_count INTEGER NOT NULL DEFAULT 0 CHECK (eligible_message_count >= 0),
  level SMALLINT NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 5),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE private.client_level_message_events (
  message_id UUID PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('text', 'image', 'gift', 'legacy_sticker')),
  counted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.client_level_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  from_level SMALLINT NOT NULL CHECK (from_level BETWEEN 1 AND 5),
  to_level SMALLINT NOT NULL CHECK (to_level BETWEEN 1 AND 5 AND to_level > from_level),
  message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE RESTRICT,
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (client_id, to_level)
);

ALTER TABLE public.client_level_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_level_transitions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_level_progress, public.client_level_transitions
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.client_level_progress, public.client_level_transitions TO authenticated;

CREATE POLICY "Clients view own level progress"
  ON public.client_level_progress FOR SELECT TO authenticated
  USING (client_id = (SELECT auth.uid()));
CREATE POLICY "Admins view client level progress"
  ON public.client_level_progress FOR SELECT TO authenticated
  USING (public.is_admin());
CREATE POLICY "Clients view own level transitions"
  ON public.client_level_transitions FOR SELECT TO authenticated
  USING (client_id = (SELECT auth.uid()));
CREATE POLICY "Admins view client level transitions"
  ON public.client_level_transitions FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE OR REPLACE FUNCTION private.client_level_for_count(_count INTEGER)
RETURNS SMALLINT
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT CASE
    WHEN _count >= 251 THEN 5
    WHEN _count >= 69 THEN 4
    WHEN _count >= 25 THEN 3
    WHEN _count >= 5 THEN 2
    ELSE 1
  END::SMALLINT;
$$;

CREATE OR REPLACE FUNCTION private.count_client_level_message(
  _message_id UUID,
  _source_kind TEXT,
  _emit_notification BOOLEAN DEFAULT TRUE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _message public.messages%ROWTYPE;
  _client UUID;
  _old_level SMALLINT;
  _new_level SMALLINT;
  _new_count INTEGER;
  _transition_id UUID;
BEGIN
  IF _source_kind NOT IN ('text', 'image', 'gift', 'legacy_sticker') THEN
    RAISE EXCEPTION 'invalid_client_level_source';
  END IF;

  SELECT * INTO _message FROM public.messages message WHERE message.id = _message_id;
  IF NOT FOUND OR _message.sender_type <> 'client'::public.sender_type THEN
    RETURN;
  END IF;

  SELECT conversation.client_id INTO _client
  FROM public.conversations conversation
  WHERE conversation.id = _message.conversation_id;
  IF _client IS NULL OR _message.sender_id IS DISTINCT FROM _client THEN
    RETURN;
  END IF;

  INSERT INTO private.client_level_message_events (message_id, client_id, source_kind)
  VALUES (_message.id, _client, _source_kind)
  ON CONFLICT (message_id) DO NOTHING;
  IF NOT FOUND THEN
    IF _source_kind = 'gift' THEN
      UPDATE private.client_level_message_events event
      SET source_kind = 'gift'
      WHERE event.message_id = _message.id
        AND event.source_kind = 'legacy_sticker';
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.client_level_progress (client_id)
  VALUES (_client)
  ON CONFLICT (client_id) DO NOTHING;

  SELECT progress.level INTO _old_level
  FROM public.client_level_progress progress
  WHERE progress.client_id = _client
  FOR UPDATE;

  UPDATE public.client_level_progress progress
  SET eligible_message_count = eligible_message_count + 1,
      level = private.client_level_for_count(eligible_message_count + 1),
      updated_at = clock_timestamp()
  WHERE progress.client_id = _client
  RETURNING progress.eligible_message_count, progress.level
  INTO _new_count, _new_level;

  IF _new_level > _old_level THEN
    INSERT INTO public.client_level_transitions (
      client_id, from_level, to_level, message_id, notified_at
    )
    VALUES (
      _client, _old_level, _new_level, _message.id,
      CASE WHEN _emit_notification THEN clock_timestamp() ELSE NULL END
    )
    ON CONFLICT (client_id, to_level) DO NOTHING
    RETURNING id INTO _transition_id;

    IF _transition_id IS NOT NULL AND _emit_notification THEN
      INSERT INTO public.notifications (user_id, type, title, body, link, metadata)
      VALUES (
        _client,
        'level_up',
        'עלית לרמה חדשה',
        'הגעת לרמה ' || _new_level::TEXT,
        '/app/profile',
        jsonb_build_object('level', _new_level, 'message_count', _new_count)
      );
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.count_plain_client_message_level()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF NEW.sender_type = 'client'::public.sender_type
    AND NEW.content NOT IN ('[image]', '[gift]', '[sticker]') THEN
    PERFORM private.count_client_level_message(NEW.id, 'text', TRUE);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.count_client_attachment_level()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.count_client_level_message(NEW.message_id, 'image', TRUE);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.count_client_gift_level()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.count_client_level_message(NEW.gift_message_id, 'gift', TRUE);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.count_client_legacy_sticker_level()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  -- A canonical Gift row wins when both records exist; message-id dedupe keeps
  -- this explicit legacy mapping from adding a second event.
  PERFORM private.count_client_level_message(NEW.message_id, 'legacy_sticker', TRUE);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_backfill_client_levels(
  _after_message_id UUID DEFAULT NULL,
  _limit INTEGER DEFAULT 500
)
RETURNS TABLE (
  scanned INTEGER,
  next_message_id UUID,
  has_more BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _row RECORD;
  _safe_limit INTEGER := LEAST(GREATEST(COALESCE(_limit, 500), 1), 2000);
  _scanned INTEGER := 0;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_only' USING ERRCODE = '42501';
  END IF;

  FOR _row IN
    SELECT
      message.id,
      CASE
        WHEN gift.gift_message_id IS NOT NULL THEN 'gift'
        WHEN attachment.message_id IS NOT NULL THEN 'image'
        WHEN sticker.message_id IS NOT NULL THEN 'legacy_sticker'
        WHEN message.content NOT IN ('[image]', '[gift]', '[sticker]') THEN 'text'
        ELSE NULL
      END AS source_kind
    FROM public.messages message
    LEFT JOIN public.gift_attachment_purchases gift
      ON gift.gift_message_id = message.id
      AND gift.status IN ('purchased', 'opened')
    LEFT JOIN public.message_attachments attachment ON attachment.message_id = message.id
    LEFT JOIN public.message_stickers sticker ON sticker.message_id = message.id
    WHERE message.sender_type = 'client'::public.sender_type
      AND (_after_message_id IS NULL OR message.id > _after_message_id)
    ORDER BY message.id
    LIMIT _safe_limit + 1
  LOOP
    IF _scanned = _safe_limit THEN
      has_more := TRUE;
      EXIT;
    END IF;
    _scanned := _scanned + 1;
    next_message_id := _row.id;
    IF _row.source_kind IS NOT NULL THEN
      PERFORM private.count_client_level_message(_row.id, _row.source_kind, FALSE);
    END IF;
  END LOOP;

  scanned := _scanned;
  has_more := COALESCE(has_more, FALSE);
  RETURN NEXT;
END;
$$;

DROP TRIGGER IF EXISTS count_plain_client_message_level ON public.messages;
CREATE TRIGGER count_plain_client_message_level
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION private.count_plain_client_message_level();
DROP TRIGGER IF EXISTS count_client_attachment_level ON public.message_attachments;
CREATE TRIGGER count_client_attachment_level
  AFTER INSERT ON public.message_attachments
  FOR EACH ROW EXECUTE FUNCTION private.count_client_attachment_level();
DROP TRIGGER IF EXISTS count_client_gift_level ON public.gift_attachment_purchases;
CREATE TRIGGER count_client_gift_level
  AFTER UPDATE OF gift_message_id, status ON public.gift_attachment_purchases
  FOR EACH ROW
  WHEN (
    NEW.status IN ('purchased', 'opened')
    AND NEW.gift_message_id IS NOT NULL
    AND OLD.gift_message_id IS DISTINCT FROM NEW.gift_message_id
  )
  EXECUTE FUNCTION private.count_client_gift_level();
DROP TRIGGER IF EXISTS count_client_legacy_sticker_level ON public.message_stickers;
CREATE TRIGGER count_client_legacy_sticker_level
  AFTER INSERT ON public.message_stickers
  FOR EACH ROW EXECUTE FUNCTION private.count_client_legacy_sticker_level();

REVOKE ALL ON FUNCTION private.client_level_for_count(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.count_client_level_message(UUID, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.count_plain_client_message_level() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.count_client_attachment_level() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.count_client_gift_level() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.count_client_legacy_sticker_level() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_backfill_client_levels(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_backfill_client_levels(UUID, INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';
