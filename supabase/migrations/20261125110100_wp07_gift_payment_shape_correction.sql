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
