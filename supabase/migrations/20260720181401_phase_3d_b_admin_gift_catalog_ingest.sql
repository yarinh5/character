-- Phase 3D-B: Admin-only Gift catalog and render-ready private ingest.
-- Gifts remain feature-gated. This migration does not add client Gift UI or delivery.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('gift-media', 'gift-media', false, 524288, ARRAY['image/webp'])
ON CONFLICT (id) DO UPDATE
SET
  public = false,
  file_size_limit = 524288,
  allowed_mime_types = ARRAY['image/webp'];

ALTER TABLE public.gifts
  ADD COLUMN ingest_status TEXT NOT NULL DEFAULT 'pending_upload'
    CHECK (ingest_status IN ('pending_upload', 'processing', 'ready', 'failed')),
  ADD COLUMN object_path TEXT,
  ADD COLUMN width INTEGER,
  ADD COLUMN height INTEGER,
  ADD COLUMN byte_size INTEGER,
  ADD COLUMN processing_started_at TIMESTAMPTZ,
  ADD COLUMN processed_at TIMESTAMPTZ,
  ADD COLUMN failed_at TIMESTAMPTZ,
  ADD COLUMN failure_code TEXT,
  ADD COLUMN deletion_started_at TIMESTAMPTZ;

ALTER TABLE public.gifts
  ADD CONSTRAINT gifts_object_path_check CHECK (
    object_path IS NULL
    OR object_path = format('collections/%s/gifts/%s/render.webp', collection_id, id)
  ),
  ADD CONSTRAINT gifts_active_ready_check CHECK (
    is_active = false OR ingest_status = 'ready'
  ),
  ADD CONSTRAINT gifts_ready_metadata_check CHECK (
    ingest_status <> 'ready'
    OR (
      object_path IS NOT NULL
      AND width BETWEEN 1 AND 768
      AND height BETWEEN 1 AND 768
      AND byte_size BETWEEN 1 AND 524288
      AND processed_at IS NOT NULL
    )
  ),
  ADD CONSTRAINT gifts_pending_metadata_check CHECK (
    ingest_status = 'ready'
    OR (width IS NULL AND height IS NULL AND byte_size IS NULL AND processed_at IS NULL)
  );

CREATE INDEX gifts_admin_catalog_idx
  ON public.gifts (collection_id, sort_order, created_at DESC);

CREATE OR REPLACE FUNCTION private.assert_gift_server_admin(_actor_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF _actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.user_roles role
    WHERE role.user_id = _actor_user_id
      AND role.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'admin_required';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_admin_gift_catalog()
RETURNS TABLE (
  id UUID,
  collection_id UUID,
  collection_name TEXT,
  character_id UUID,
  collection_is_active BOOLEAN,
  name TEXT,
  price_credits INTEGER,
  sort_order INTEGER,
  is_active BOOLEAN,
  ingest_status TEXT,
  width INTEGER,
  height INTEGER,
  byte_size INTEGER,
  failure_code TEXT,
  deletion_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  RETURN QUERY
  SELECT
    gift.id,
    collection.id,
    collection.name,
    collection.character_id,
    collection.is_active,
    gift.name,
    gift.price_credits,
    gift.sort_order,
    gift.is_active,
    gift.ingest_status,
    gift.width,
    gift.height,
    gift.byte_size,
    gift.failure_code,
    gift.deletion_started_at,
    gift.created_at,
    gift.updated_at
  FROM public.gifts gift
  JOIN public.gift_collections collection ON collection.id = gift.collection_id
  ORDER BY collection.sort_order, collection.name, gift.sort_order, gift.name, gift.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_create_gift_collection(
  _name TEXT,
  _character_id UUID DEFAULT NULL,
  _sort_order INTEGER DEFAULT 0
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _collection_id UUID;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_required';
  END IF;
  IF char_length(btrim(coalesce(_name, ''))) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'invalid_gift_collection_name';
  END IF;
  IF _character_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.characters character WHERE character.id = _character_id
  ) THEN
    RAISE EXCEPTION 'character_not_found';
  END IF;

  INSERT INTO public.gift_collections (name, character_id, is_active, sort_order, created_by)
  VALUES (btrim(_name), _character_id, false, coalesce(_sort_order, 0), auth.uid())
  RETURNING id INTO _collection_id;
  RETURN _collection_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_gift_collection(
  _collection_id UUID,
  _name TEXT,
  _character_id UUID,
  _is_active BOOLEAN,
  _sort_order INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_required';
  END IF;
  IF char_length(btrim(coalesce(_name, ''))) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'invalid_gift_collection_name';
  END IF;
  IF _character_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.characters character WHERE character.id = _character_id
  ) THEN
    RAISE EXCEPTION 'character_not_found';
  END IF;

  UPDATE public.gift_collections collection
  SET
    name = btrim(_name),
    character_id = _character_id,
    is_active = coalesce(_is_active, false),
    sort_order = coalesce(_sort_order, 0),
    updated_at = clock_timestamp()
  WHERE collection.id = _collection_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'gift_collection_not_found'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_gift_upload_intent_for_server(
  _actor_user_id UUID,
  _collection_id UUID,
  _gift_name TEXT,
  _price_credits INTEGER,
  _sort_order INTEGER DEFAULT 0
)
RETURNS TABLE (gift_id UUID, object_path TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _gift_id UUID := gen_random_uuid();
BEGIN
  PERFORM private.assert_gift_server_admin(_actor_user_id);
  IF char_length(btrim(coalesce(_gift_name, ''))) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'invalid_gift_name';
  END IF;
  IF _price_credits IS NULL OR _price_credits <= 0 THEN
    RAISE EXCEPTION 'invalid_gift_price';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.gift_collections collection WHERE collection.id = _collection_id) THEN
    RAISE EXCEPTION 'gift_collection_not_found';
  END IF;

  INSERT INTO public.gifts (
    id, collection_id, name, price_credits, is_active, sort_order, object_path, ingest_status, created_by
  ) VALUES (
    _gift_id,
    _collection_id,
    btrim(_gift_name),
    _price_credits,
    false,
    coalesce(_sort_order, 0),
    format('collections/%s/gifts/%s/render.webp', _collection_id, _gift_id),
    'pending_upload',
    _actor_user_id
  );

  RETURN QUERY
  SELECT _gift_id, format('collections/%s/gifts/%s/render.webp', _collection_id, _gift_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_gift(
  _gift_id UUID,
  _name TEXT,
  _price_credits INTEGER,
  _sort_order INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_required';
  END IF;
  IF char_length(btrim(coalesce(_name, ''))) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'invalid_gift_name';
  END IF;
  IF _price_credits IS NULL OR _price_credits <= 0 THEN
    RAISE EXCEPTION 'invalid_gift_price';
  END IF;

  PERFORM 1 FROM public.gifts gift WHERE gift.id = _gift_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'gift_not_found'; END IF;

  UPDATE public.gifts gift
  SET
    name = btrim(_name),
    price_credits = _price_credits,
    sort_order = coalesce(_sort_order, 0),
    updated_at = clock_timestamp()
  WHERE gift.id = _gift_id
    AND gift.deletion_started_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'gift_deletion_in_progress'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_admin_gift_active(
  _gift_id UUID,
  _is_active BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  UPDATE public.gifts gift
  SET is_active = _is_active, updated_at = clock_timestamp()
  WHERE gift.id = _gift_id
    AND gift.deletion_started_at IS NULL
    AND (NOT _is_active OR gift.ingest_status = 'ready');
  IF NOT FOUND THEN RAISE EXCEPTION 'gift_not_ready'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_gift_processing_for_server(
  _actor_user_id UUID,
  _gift_id UUID
)
RETURNS TABLE (gift_id UUID, object_path TEXT, already_ready BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _gift public.gifts%ROWTYPE;
BEGIN
  PERFORM private.assert_gift_server_admin(_actor_user_id);
  SELECT * INTO _gift FROM public.gifts gift WHERE gift.id = _gift_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'gift_not_found'; END IF;
  IF _gift.deletion_started_at IS NOT NULL THEN RAISE EXCEPTION 'gift_deletion_in_progress'; END IF;
  IF _gift.ingest_status = 'ready' THEN
    RETURN QUERY SELECT _gift.id, _gift.object_path, true;
    RETURN;
  END IF;
  IF _gift.ingest_status = 'processing' THEN RAISE EXCEPTION 'gift_processing_in_progress'; END IF;
  IF _gift.object_path IS NULL THEN RAISE EXCEPTION 'gift_upload_required'; END IF;

  UPDATE public.gifts gift
  SET
    ingest_status = 'processing',
    processing_started_at = clock_timestamp(),
    failed_at = NULL,
    failure_code = NULL,
    updated_at = clock_timestamp()
  WHERE gift.id = _gift.id;
  RETURN QUERY SELECT _gift.id, _gift.object_path, false;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_gift_processing_for_server(
  _actor_user_id UUID,
  _gift_id UUID,
  _width INTEGER,
  _height INTEGER,
  _byte_size INTEGER
)
RETURNS TABLE (gift_id UUID, ingest_status TEXT, already_ready BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _gift public.gifts%ROWTYPE;
BEGIN
  PERFORM private.assert_gift_server_admin(_actor_user_id);
  IF _width NOT BETWEEN 1 AND 768 OR _height NOT BETWEEN 1 AND 768 OR _byte_size NOT BETWEEN 1 AND 524288 THEN
    RAISE EXCEPTION 'invalid_gift_render_metadata';
  END IF;
  SELECT * INTO _gift FROM public.gifts gift WHERE gift.id = _gift_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'gift_not_found'; END IF;
  IF _gift.deletion_started_at IS NOT NULL THEN RAISE EXCEPTION 'gift_deletion_in_progress'; END IF;
  IF _gift.ingest_status = 'ready' THEN
    RETURN QUERY SELECT _gift.id, _gift.ingest_status, true;
    RETURN;
  END IF;
  IF _gift.ingest_status <> 'processing' THEN RAISE EXCEPTION 'gift_processing_not_started'; END IF;

  UPDATE public.gifts gift
  SET
    ingest_status = 'ready',
    width = _width,
    height = _height,
    byte_size = _byte_size,
    processed_at = clock_timestamp(),
    processing_started_at = NULL,
    failed_at = NULL,
    failure_code = NULL,
    updated_at = clock_timestamp()
  WHERE gift.id = _gift.id;
  RETURN QUERY SELECT _gift.id, 'ready'::TEXT, false;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_gift_processing_for_server(
  _actor_user_id UUID,
  _gift_id UUID,
  _failure_code TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.assert_gift_server_admin(_actor_user_id);
  UPDATE public.gifts gift
  SET
    ingest_status = 'failed',
    is_active = false,
    failed_at = clock_timestamp(),
    failure_code = left(coalesce(_failure_code, 'gift_processing_failed'), 100),
    processing_started_at = NULL,
    updated_at = clock_timestamp()
  WHERE gift.id = _gift_id
    AND gift.ingest_status = 'processing'
    AND gift.deletion_started_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_admin_gift_object_path_for_server(
  _actor_user_id UUID,
  _gift_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _object_path TEXT;
BEGIN
  PERFORM private.assert_gift_server_admin(_actor_user_id);
  SELECT gift.object_path INTO _object_path
  FROM public.gifts gift
  WHERE gift.id = _gift_id
    AND gift.ingest_status = 'ready'
    AND gift.deletion_started_at IS NULL;
  RETURN _object_path;
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_gift_hard_delete_for_server(
  _actor_user_id UUID,
  _gift_id UUID
)
RETURNS TABLE (gift_id UUID, object_path TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _gift public.gifts%ROWTYPE;
BEGIN
  PERFORM private.assert_gift_server_admin(_actor_user_id);
  SELECT * INTO _gift FROM public.gifts gift WHERE gift.id = _gift_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'gift_not_found'; END IF;
  IF EXISTS (SELECT 1 FROM public.message_gifts message_gift WHERE message_gift.gift_id = _gift.id)
    OR EXISTS (SELECT 1 FROM private.gift_send_attempts attempt WHERE attempt.gift_id = _gift.id) THEN
    RAISE EXCEPTION 'gift_in_use';
  END IF;

  UPDATE public.gifts gift
  SET
    is_active = false,
    deletion_started_at = coalesce(gift.deletion_started_at, clock_timestamp()),
    updated_at = clock_timestamp()
  WHERE gift.id = _gift.id;
  RETURN QUERY SELECT _gift.id, _gift.object_path;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_gift_hard_delete_for_server(
  _actor_user_id UUID,
  _gift_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _gift public.gifts%ROWTYPE;
BEGIN
  PERFORM private.assert_gift_server_admin(_actor_user_id);
  SELECT * INTO _gift FROM public.gifts gift WHERE gift.id = _gift_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'gift_not_found'; END IF;
  IF _gift.deletion_started_at IS NULL THEN RAISE EXCEPTION 'gift_delete_not_started'; END IF;
  IF EXISTS (SELECT 1 FROM public.message_gifts message_gift WHERE message_gift.gift_id = _gift.id)
    OR EXISTS (SELECT 1 FROM private.gift_send_attempts attempt WHERE attempt.gift_id = _gift.id) THEN
    RAISE EXCEPTION 'gift_in_use';
  END IF;

  BEGIN
    DELETE FROM public.gifts gift WHERE gift.id = _gift.id;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'gift_in_use';
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_conversation_gifts(
  _conversation_id UUID
)
RETURNS TABLE (
  gift_id UUID,
  collection_id UUID,
  name TEXT,
  collection_name TEXT,
  scope TEXT,
  price_credits INTEGER,
  sort_order INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _guard RECORD;
BEGIN
  IF private.setting_bool('gifts_enabled', false) IS NOT TRUE THEN
    RAISE EXCEPTION 'gifts_disabled';
  END IF;
  SELECT * INTO _guard FROM private.assert_client_can_send_gift_message(_conversation_id);
  RETURN QUERY
  SELECT gift.id, collection.id, gift.name, collection.name,
    CASE WHEN collection.character_id IS NULL THEN 'global' ELSE 'character' END,
    gift.price_credits, gift.sort_order
  FROM public.gifts gift
  JOIN public.gift_collections collection ON collection.id = gift.collection_id
  WHERE gift.is_active = true
    AND gift.ingest_status = 'ready'
    AND gift.deletion_started_at IS NULL
    AND collection.is_active = true
    AND (collection.character_id IS NULL OR collection.character_id = _guard.character_id)
  ORDER BY collection.sort_order, collection.name, gift.sort_order, gift.name, gift.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.send_client_gift(
  _conversation_id UUID,
  _gift_id UUID,
  _idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _guard RECORD;
  _attempt private.gift_send_attempts%ROWTYPE;
  _gift RECORD;
  _message public.messages%ROWTYPE;
  _message_gift public.message_gifts%ROWTYPE;
  _wallet_balance INTEGER;
  _balance_after INTEGER;
  _transaction public.credit_transactions%ROWTYPE;
  _fingerprint TEXT := format('gift:%s:%s', _conversation_id, _gift_id);
BEGIN
  IF _idempotency_key IS NULL THEN RAISE EXCEPTION 'gift_idempotency_key_required'; END IF;
  SELECT * INTO _guard FROM private.assert_client_can_send_gift_message(_conversation_id);

  SELECT * INTO _attempt
  FROM private.gift_send_attempts attempt
  WHERE attempt.client_id = _guard.user_id AND attempt.idempotency_key = _idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF _attempt.request_fingerprint <> _fingerprint THEN RAISE EXCEPTION 'gift_idempotency_key_reused'; END IF;
    IF _attempt.status <> 'succeeded' OR _attempt.message_id IS NULL OR _attempt.charged_transaction_id IS NULL THEN
      RAISE EXCEPTION 'gift_send_in_progress';
    END IF;
    SELECT * INTO _message FROM public.messages message WHERE message.id = _attempt.message_id;
    SELECT * INTO _message_gift FROM public.message_gifts message_gift WHERE message_gift.message_id = _attempt.message_id;
    SELECT * INTO _transaction FROM public.credit_transactions transaction WHERE transaction.id = _attempt.charged_transaction_id;
    IF NOT FOUND OR _message_gift.id IS NULL OR _transaction.id IS NULL THEN RAISE EXCEPTION 'gift_attempt_invariant_failed'; END IF;
    RETURN jsonb_build_object(
      'message', to_jsonb(_message),
      'message_gift', jsonb_build_object('id', _message_gift.id, 'message_id', _message_gift.message_id, 'gift_id', _message_gift.gift_id, 'gift_name_snapshot', _message_gift.gift_name_snapshot, 'collection_name_snapshot', _message_gift.collection_name_snapshot, 'price_credits_snapshot', _message_gift.price_credits_snapshot, 'created_at', _message_gift.created_at),
      'balance', _transaction.balance_after,
      'already_sent', true
    );
  END IF;

  IF private.setting_bool('gifts_enabled', false) IS NOT TRUE THEN RAISE EXCEPTION 'gifts_disabled'; END IF;
  SELECT gift.id, gift.name AS gift_name, gift.price_credits, collection.name AS collection_name
  INTO _gift
  FROM public.gifts gift
  JOIN public.gift_collections collection ON collection.id = gift.collection_id
  WHERE gift.id = _gift_id
    AND gift.is_active = true
    AND gift.ingest_status = 'ready'
    AND gift.deletion_started_at IS NULL
    AND collection.is_active = true
    AND (collection.character_id IS NULL OR collection.character_id = _guard.character_id)
  FOR UPDATE OF gift;
  IF NOT FOUND THEN RAISE EXCEPTION 'gift_not_available'; END IF;

  INSERT INTO private.gift_send_attempts (client_id, conversation_id, gift_id, idempotency_key, request_fingerprint)
  VALUES (_guard.user_id, _conversation_id, _gift.id, _idempotency_key, _fingerprint)
  ON CONFLICT (client_id, idempotency_key) DO NOTHING
  RETURNING * INTO _attempt;
  IF NOT FOUND THEN
    SELECT * INTO _attempt FROM private.gift_send_attempts attempt
    WHERE attempt.client_id = _guard.user_id AND attempt.idempotency_key = _idempotency_key FOR UPDATE;
    IF _attempt.request_fingerprint <> _fingerprint THEN RAISE EXCEPTION 'gift_idempotency_key_reused'; END IF;
    IF _attempt.status <> 'succeeded' OR _attempt.message_id IS NULL OR _attempt.charged_transaction_id IS NULL THEN RAISE EXCEPTION 'gift_send_in_progress'; END IF;
    SELECT * INTO _message FROM public.messages message WHERE message.id = _attempt.message_id;
    SELECT * INTO _message_gift FROM public.message_gifts message_gift WHERE message_gift.message_id = _attempt.message_id;
    SELECT * INTO _transaction FROM public.credit_transactions transaction WHERE transaction.id = _attempt.charged_transaction_id;
    IF NOT FOUND OR _message_gift.id IS NULL OR _transaction.id IS NULL THEN RAISE EXCEPTION 'gift_attempt_invariant_failed'; END IF;
    RETURN jsonb_build_object(
      'message', to_jsonb(_message),
      'message_gift', jsonb_build_object('id', _message_gift.id, 'message_id', _message_gift.message_id, 'gift_id', _message_gift.gift_id, 'gift_name_snapshot', _message_gift.gift_name_snapshot, 'collection_name_snapshot', _message_gift.collection_name_snapshot, 'price_credits_snapshot', _message_gift.price_credits_snapshot, 'created_at', _message_gift.created_at),
      'balance', _transaction.balance_after,
      'already_sent', true
    );
  END IF;

  PERFORM private.consume_client_gift_rate_limit(_conversation_id, _guard.user_id);
  INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
  VALUES (_guard.user_id, 0, 0, 0) ON CONFLICT (user_id) DO NOTHING;
  SELECT wallet.balance INTO _wallet_balance FROM public.credit_wallets wallet WHERE wallet.user_id = _guard.user_id FOR UPDATE;
  IF _wallet_balance < _gift.price_credits THEN RAISE EXCEPTION 'insufficient_credits'; END IF;

  UPDATE public.credit_wallets
  SET balance = balance - _gift.price_credits, lifetime_spent = lifetime_spent + _gift.price_credits
  WHERE user_id = _guard.user_id
  RETURNING balance INTO _balance_after;
  INSERT INTO public.messages (conversation_id, sender_type, sender_id, content, created_at)
  VALUES (_conversation_id, 'client'::public.sender_type, _guard.user_id, '[gift]', clock_timestamp())
  RETURNING * INTO _message;
  INSERT INTO public.credit_transactions (user_id, amount, balance_after, type, reason, message_id, metadata)
  VALUES (_guard.user_id, -_gift.price_credits, _balance_after, 'gift_spend', 'gift_spend', _message.id, jsonb_build_object('gift_id', _gift.id, 'price_credits_snapshot', _gift.price_credits, 'source', 'send_client_gift'))
  RETURNING * INTO _transaction;
  INSERT INTO public.message_gifts (message_id, gift_id, gift_name_snapshot, collection_name_snapshot, price_credits_snapshot, charged_transaction_id)
  VALUES (_message.id, _gift.id, _gift.gift_name, _gift.collection_name, _gift.price_credits, _transaction.id)
  RETURNING * INTO _message_gift;
  UPDATE private.gift_send_attempts
  SET status = 'succeeded', message_id = _message.id, charged_transaction_id = _transaction.id, updated_at = clock_timestamp()
  WHERE id = _attempt.id;
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_guard.user_id, 'gift.sent', 'message_gift', _message_gift.id::TEXT, jsonb_build_object('conversation_id', _conversation_id, 'gift_id', _gift.id, 'transaction_id', _transaction.id, 'price_credits_snapshot', _gift.price_credits));
  RETURN jsonb_build_object(
    'message', to_jsonb(_message),
    'message_gift', jsonb_build_object('id', _message_gift.id, 'message_id', _message_gift.message_id, 'gift_id', _message_gift.gift_id, 'gift_name_snapshot', _message_gift.gift_name_snapshot, 'collection_name_snapshot', _message_gift.collection_name_snapshot, 'price_credits_snapshot', _message_gift.price_credits_snapshot, 'created_at', _message_gift.created_at),
    'balance', _balance_after,
    'already_sent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION private.assert_gift_server_admin(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_gift_upload_intent_for_server(UUID, UUID, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_gift_processing_for_server(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_gift_processing_for_server(UUID, UUID, INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_gift_processing_for_server(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_admin_gift_object_path_for_server(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_gift_hard_delete_for_server(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_gift_hard_delete_for_server(UUID, UUID) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.get_admin_gift_catalog() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_create_gift_collection(TEXT, UUID, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_update_gift_collection(UUID, TEXT, UUID, BOOLEAN, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_update_gift(UUID, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_admin_gift_active(UUID, BOOLEAN) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_gift_upload_intent_for_server(UUID, UUID, TEXT, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_gift_processing_for_server(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_gift_processing_for_server(UUID, UUID, INTEGER, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_gift_processing_for_server(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_admin_gift_object_path_for_server(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_gift_hard_delete_for_server(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_gift_hard_delete_for_server(UUID, UUID) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_admin_gift_catalog() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_gift_collection(TEXT, UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_gift_collection(UUID, TEXT, UUID, BOOLEAN, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_gift(UUID, TEXT, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_admin_gift_active(UUID, BOOLEAN) TO authenticated;

NOTIFY pgrst, 'reload schema';
