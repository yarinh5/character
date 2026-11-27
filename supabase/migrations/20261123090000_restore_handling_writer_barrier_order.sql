-- Acquire the WP01 shared transaction barrier before validation or row locks.
-- Replacing the existing signatures preserves their grants and ownership.

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
  PERFORM private.acquire_handling_writer_barrier();
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

CREATE OR REPLACE FUNCTION public.finalize_client_media_upload_for_server(
  _actor_user_id UUID,
  _upload_id UUID,
  _idempotency_key TEXT,
  _content_type TEXT,
  _byte_size BIGINT,
  _finalize_claim_token UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _upload public.client_media_uploads%ROWTYPE;
  _conversation public.conversations%ROWTYPE;
  _message public.messages%ROWTYPE;
  _attachment public.message_attachments%ROWTYPE;
  _balance INTEGER;
  _credits_enabled BOOLEAN := private.setting_bool('credits_enabled', TRUE);
  _key TEXT := btrim(COALESCE(_idempotency_key, ''));
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF _actor_user_id IS NULL OR _upload_id IS NULL THEN RAISE EXCEPTION 'invalid_client_media_finalize'; END IF;
  IF char_length(_key) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'client_media_idempotency_key_required'; END IF;
  IF _content_type NOT IN ('image/jpeg', 'image/png', 'image/webp')
    OR _byte_size NOT BETWEEN 1 AND 10485760 THEN
    RAISE EXCEPTION 'client_media_validation_failed';
  END IF;

  SELECT * INTO _upload
  FROM public.client_media_uploads upload
  WHERE upload.id = _upload_id
  FOR UPDATE;
  IF NOT FOUND OR _upload.client_id IS DISTINCT FROM _actor_user_id THEN
    RAISE EXCEPTION 'client_media_upload_not_available';
  END IF;

  IF _upload.status <> 'processing' THEN
    IF _upload.finalized_at IS NULL
       OR _upload.message_id IS NULL
       OR _upload.message_attachment_id IS NULL THEN
      RAISE EXCEPTION 'client_media_upload_expired_or_changed';
    END IF;
    IF _upload.idempotency_key IS DISTINCT FROM _key THEN
      RAISE EXCEPTION 'client_media_idempotency_key_reused';
    END IF;
    SELECT * INTO _message
    FROM public.messages message
    WHERE message.id = _upload.message_id;
    SELECT * INTO _attachment
    FROM public.message_attachments attachment
    WHERE attachment.id = _upload.message_attachment_id
      AND attachment.message_id = _upload.message_id
      AND attachment.client_upload_id = _upload.id;
    IF _message.id IS NULL OR _attachment.id IS NULL THEN
      RAISE EXCEPTION 'client_media_finalize_state_invalid';
    END IF;
    SELECT wallet.balance INTO _balance
    FROM public.credit_wallets wallet
    WHERE wallet.user_id = _actor_user_id;
    RETURN jsonb_build_object(
      'message', to_jsonb(_message),
      'attachment', jsonb_build_object(
        'id', _attachment.id, 'message_id', _attachment.message_id, 'kind', _attachment.kind,
        'position', _attachment.position, 'caption', _attachment.caption,
        'metadata', _attachment.metadata, 'created_at', _attachment.created_at
      ),
      'access_expires_at', _upload.access_expires_at,
      'balance', COALESCE(_balance, 0),
      'already_finalized', TRUE
    );
  END IF;

  IF _upload.finalize_claim_token IS DISTINCT FROM _finalize_claim_token
    OR _upload.finalize_claim_expires_at <= clock_timestamp()
    OR _upload.content_type IS DISTINCT FROM _content_type THEN
    RAISE EXCEPTION 'client_media_upload_expired_or_changed';
  END IF;

  SELECT * INTO _conversation
  FROM public.conversations conversation
  WHERE conversation.id = _upload.conversation_id
  FOR UPDATE;
  IF NOT FOUND OR _conversation.client_id IS DISTINCT FROM _actor_user_id
    OR _conversation.status = 'closed'::public.conversation_status
    OR _conversation.client_hidden_at IS NOT NULL THEN
    RAISE EXCEPTION 'conversation_access_denied';
  END IF;

  INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
  VALUES (_actor_user_id, 0, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT wallet.balance INTO _balance
  FROM public.credit_wallets wallet
  WHERE wallet.user_id = _actor_user_id
  FOR UPDATE;
  IF _credits_enabled AND COALESCE(_balance, 0) < 10 THEN
    RAISE EXCEPTION 'insufficient_credits';
  END IF;

  INSERT INTO public.messages (conversation_id, sender_type, sender_id, content, created_at)
  VALUES (_conversation.id, 'client'::public.sender_type, _actor_user_id, '[image]', clock_timestamp())
  RETURNING * INTO _message;

  INSERT INTO public.message_attachments (
    message_id, client_upload_id, kind, position, caption, metadata,
    access_mode, view_mode, access_expires_at
  ) VALUES (
    _message.id, _upload.id, 'image', 0, NULL,
    jsonb_build_object('source', 'client_media_upload'),
    'standard', 'client_24h', _message.created_at + interval '24 hours'
  ) RETURNING * INTO _attachment;

  IF _credits_enabled THEN
    UPDATE public.credit_wallets
    SET balance = balance - 10,
        lifetime_spent = lifetime_spent + 10
    WHERE user_id = _actor_user_id
    RETURNING balance INTO _balance;
    INSERT INTO public.credit_transactions (
      user_id, amount, balance_after, type, reason, message_id, message_attachment_id, metadata
    ) VALUES (
      _actor_user_id, -10, _balance, 'message_spend', 'Client image spend',
      _message.id, _attachment.id,
      jsonb_build_object('conversation_id', _conversation.id, 'client_upload_id', _upload.id, 'unit_price', 10)
    );
  END IF;

  UPDATE public.client_media_uploads
  SET status = 'cleanup_pending',
      preview_path = COALESCE(
        preview_path,
        regexp_replace(source_path, '/source\.[^/]+$', '/preview.webp')
      ),
      byte_size = _byte_size,
      finalized_at = _message.created_at,
      access_expires_at = _attachment.access_expires_at,
      message_id = _message.id,
      message_attachment_id = _attachment.id,
      idempotency_key = _key,
      finalize_claimed_at = NULL,
      finalize_claim_token = NULL,
      finalize_claim_expires_at = NULL,
      next_cleanup_at = _attachment.access_expires_at,
      updated_at = clock_timestamp()
  WHERE id = _upload.id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _actor_user_id,
    'client_media.finalized',
    'client_media_upload',
    _upload.id::TEXT,
    jsonb_build_object('conversation_id', _conversation.id, 'message_id', _message.id, 'attachment_id', _attachment.id, 'access_expires_at', _attachment.access_expires_at)
  );

  RETURN jsonb_build_object(
    'message', to_jsonb(_message),
    'attachment', jsonb_build_object(
      'id', _attachment.id, 'message_id', _attachment.message_id, 'kind', _attachment.kind,
      'position', _attachment.position, 'caption', _attachment.caption,
      'metadata', _attachment.metadata, 'created_at', _attachment.created_at
    ),
    'access_expires_at', _attachment.access_expires_at,
    'balance', COALESCE(_balance, 0),
    'already_finalized', FALSE
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.purchase_attachment_gift(
  _attachment_id UUID,
  _gift_id UUID,
  _idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _client_id UUID := auth.uid();
  _attachment public.message_attachments%ROWTYPE;
  _conversation public.conversations%ROWTYPE;
  _purchase public.gift_attachment_purchases%ROWTYPE;
  _balance INTEGER;
  _transaction public.credit_transactions%ROWTYPE;
  _gift_message public.messages%ROWTYPE;
  _collection_name TEXT;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF _client_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  PERFORM private.ensure_active_client(_client_id);
  IF _idempotency_key IS NULL THEN RAISE EXCEPTION 'idempotency_key_required'; END IF;

  SELECT * INTO _purchase FROM public.gift_attachment_purchases purchase
  WHERE purchase.client_id = _client_id AND purchase.idempotency_key = _idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF _purchase.attachment_id IS DISTINCT FROM _attachment_id OR _purchase.gift_id IS DISTINCT FROM _gift_id THEN
      RAISE EXCEPTION 'idempotency_key_reused';
    END IF;
    RETURN jsonb_build_object(
      'purchase_id', _purchase.id, 'attachment_id', _purchase.attachment_id,
      'gift_id', _purchase.gift_id, 'balance', (SELECT balance FROM public.credit_wallets WHERE user_id = _client_id),
      'already_purchased', _purchase.status IN ('purchased', 'opened')
    );
  END IF;

  SELECT attachment.* INTO _attachment FROM public.message_attachments attachment
  WHERE attachment.id = _attachment_id FOR UPDATE;
  IF NOT FOUND OR _attachment.view_mode <> 'paid_open' OR _attachment.required_gift_id IS NULL THEN
    RAISE EXCEPTION 'gift_attachment_not_available';
  END IF;
  SELECT conversation.* INTO _conversation
  FROM public.messages message JOIN public.conversations conversation ON conversation.id = message.conversation_id
  WHERE message.id = _attachment.message_id FOR UPDATE OF conversation;
  IF NOT FOUND OR _conversation.client_id IS DISTINCT FROM _client_id
    OR _conversation.status = 'closed'::public.conversation_status
    OR _conversation.client_hidden_at IS NOT NULL THEN RAISE EXCEPTION 'conversation_access_denied'; END IF;
  IF _attachment.required_gift_id IS DISTINCT FROM _gift_id THEN RAISE EXCEPTION 'gift_does_not_unlock_attachment'; END IF;

  INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
  VALUES (_client_id, 0, 0, 0) ON CONFLICT (user_id) DO NOTHING;
  SELECT balance INTO _balance FROM public.credit_wallets WHERE user_id = _client_id FOR UPDATE;
  IF COALESCE(_balance, 0) < _attachment.required_gift_price_credits_snapshot THEN
    RAISE EXCEPTION 'insufficient_credits';
  END IF;

  INSERT INTO public.gift_attachment_purchases (
    attachment_id, conversation_id, client_id, gift_id, gift_name_snapshot,
    price_credits_snapshot, idempotency_key
  ) VALUES (
    _attachment.id, _conversation.id, _client_id, _gift_id,
    _attachment.required_gift_name_snapshot, _attachment.required_gift_price_credits_snapshot,
    _idempotency_key
  ) RETURNING * INTO _purchase;

  UPDATE public.credit_wallets
  SET balance = balance - _purchase.price_credits_snapshot,
      lifetime_spent = lifetime_spent + _purchase.price_credits_snapshot
  WHERE user_id = _client_id RETURNING balance INTO _balance;

  INSERT INTO public.messages (conversation_id, sender_type, sender_id, content, created_at)
  VALUES (_conversation.id, 'client'::public.sender_type, _client_id, '[sticker]', clock_timestamp())
  RETURNING * INTO _gift_message;

  SELECT collection.name INTO _collection_name
  FROM public.stickers sticker JOIN public.sticker_collections collection ON collection.id = sticker.collection_id
  WHERE sticker.id = _gift_id;
  INSERT INTO public.message_stickers (
    message_id, sticker_id, sticker_name_snapshot, collection_name_snapshot, price_credits_snapshot
  ) VALUES (
    _gift_message.id, _gift_id, _purchase.gift_name_snapshot,
    COALESCE(_collection_name, 'Gift'), _purchase.price_credits_snapshot
  );

  INSERT INTO public.credit_transactions (
    user_id, amount, balance_after, type, reason, message_id, message_attachment_id, metadata
  ) VALUES (
    _client_id, -_purchase.price_credits_snapshot, _balance, 'sticker_spend', 'attachment_gift_purchase',
    _gift_message.id, _attachment.id,
    jsonb_build_object('purchase_id', _purchase.id, 'gift_id', _gift_id, 'attachment_id', _attachment.id)
  ) RETURNING * INTO _transaction;

  UPDATE public.message_stickers
  SET payer_client_id = _client_id,
      charged_transaction_id = _transaction.id
  WHERE message_id = _gift_message.id;

  UPDATE public.gift_attachment_purchases
  SET charged_transaction_id = _transaction.id, gift_message_id = _gift_message.id,
      status = 'purchased', purchased_at = clock_timestamp()
  WHERE id = _purchase.id RETURNING * INTO _purchase;

  INSERT INTO private.gift_reward_events (purchase_id, reward_pool_points)
  VALUES (_purchase.id, _purchase.price_credits_snapshot::NUMERIC * 0.10);

  RETURN jsonb_build_object(
    'purchase_id', _purchase.id, 'attachment_id', _purchase.attachment_id,
    'gift_id', _purchase.gift_id, 'balance', _balance,
    'message', to_jsonb(_gift_message), 'already_purchased', FALSE
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.request_conversation_deletion(
  _conversation_id UUID, _reason TEXT, _idempotency_key UUID, _confirmed BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (id UUID, status TEXT, requested_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _actor UUID := auth.uid(); _request public.conversation_deletion_requests%ROWTYPE; _now TIMESTAMPTZ := clock_timestamp();
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF _actor IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'admin_only' USING ERRCODE = '42501'; END IF;
  IF _confirmed IS NOT TRUE THEN RAISE EXCEPTION 'explicit_confirmation_required'; END IF;
  IF _conversation_id IS NULL OR _idempotency_key IS NULL THEN RAISE EXCEPTION 'invalid_deletion_request'; END IF;
  IF char_length(btrim(COALESCE(_reason, ''))) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'deletion_reason_required'; END IF;
  PERFORM 1 FROM public.conversations WHERE conversations.id = _conversation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_not_found'; END IF;
  INSERT INTO public.conversation_deletion_requests (
    conversation_id, requested_by, idempotency_key, reason, status,
    access_blocked_at, deletion_due_at, retention_policy_version, updated_at
  ) VALUES (
    _conversation_id, _actor, _idempotency_key, btrim(_reason), 'access_blocked',
    _now, _now + interval '7 days', 'p04-2026-11-11', _now
  ) ON CONFLICT (requested_by, idempotency_key) DO NOTHING RETURNING * INTO _request;
  IF _request.id IS NULL THEN
    SELECT * INTO _request FROM public.conversation_deletion_requests request
    WHERE request.requested_by = _actor AND request.idempotency_key = _idempotency_key;
    IF _request.conversation_id IS DISTINCT FROM _conversation_id OR _request.reason IS DISTINCT FROM btrim(_reason) THEN
      RAISE EXCEPTION 'idempotency_key_reused';
    END IF;
  ELSE
    INSERT INTO private.conversation_deletion_steps(request_id, step_name, status)
    VALUES (_request.id, 'database_content', 'pending'), (_request.id, 'storage', 'pending'),
      (_request.id, 'finalize', 'pending');
    UPDATE public.conversations SET status = 'closed'::public.conversation_status,
      assigned_operator_id = NULL, updated_at = _now WHERE conversations.id = _conversation_id;
    UPDATE public.conversation_handling_cycles SET ended_at = _now, end_reason = 'closed'
    WHERE conversation_id = _conversation_id AND ended_at IS NULL;
    UPDATE public.conversation_work_items SET status = 'closed', responsible_operator_id = NULL,
      assigned_at = NULL, updated_at = _now WHERE conversation_id = _conversation_id
      AND status IN ('new', 'assigned', 'in_progress');
    INSERT INTO public.audit_logs(actor_user_id, action, entity_type, entity_id, metadata)
    VALUES (_actor, 'conversation_deletion_requested', 'conversation', _conversation_id,
      jsonb_build_object('request_id', _request.id, 'reason', btrim(_reason), 'access_blocked_at', _now));
  END IF;
  id := _request.id; status := _request.status; requested_at := _request.requested_at; RETURN NEXT;
END;
$$;
