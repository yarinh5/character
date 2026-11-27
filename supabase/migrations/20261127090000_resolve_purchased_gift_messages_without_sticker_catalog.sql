CREATE OR REPLACE FUNCTION public.resolve_sticker_object_path_for_server(
  _actor_user_id UUID, _message_sticker_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
DECLARE
  _conversation_id UUID;
  _object_path TEXT;
BEGIN
  SELECT message.conversation_id INTO _conversation_id
  FROM public.message_stickers message_sticker
  JOIN public.messages message ON message.id = message_sticker.message_id
  WHERE message_sticker.id = _message_sticker_id;
  IF private.can_user_read_conversation(_conversation_id, _actor_user_id) IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  IF private.setting_bool('stickers_enabled', FALSE) THEN
    RETURN public.resolve_sticker_object_path_before_wp01_5(_actor_user_id, _message_sticker_id);
  END IF;

  -- Disabling the ordinary sticker catalog must not hide a Gift already bought in this conversation.
  SELECT sticker.object_path INTO _object_path
  FROM public.message_stickers message_sticker
  JOIN public.messages gift_message ON gift_message.id = message_sticker.message_id
  JOIN public.gift_attachment_purchases purchase
    ON purchase.gift_message_id = gift_message.id
    AND purchase.gift_id = message_sticker.sticker_id
    AND purchase.conversation_id = gift_message.conversation_id
  JOIN public.conversations conversation
    ON conversation.id = gift_message.conversation_id
    AND conversation.client_id = purchase.client_id
  JOIN public.message_attachments attachment
    ON attachment.id = purchase.attachment_id
    AND attachment.required_gift_id = purchase.gift_id
  JOIN public.messages source_message
    ON source_message.id = attachment.message_id
    AND source_message.conversation_id = gift_message.conversation_id
  JOIN public.stickers sticker ON sticker.id = message_sticker.sticker_id
  JOIN public.sticker_collections collection ON collection.id = sticker.collection_id
  WHERE message_sticker.id = _message_sticker_id
    AND purchase.status IN ('purchased', 'opened')
    AND purchase.charged_transaction_id IS NOT NULL
    AND sticker.is_active = TRUE AND sticker.ingest_status = 'ready'
    AND collection.is_active = TRUE;
  RETURN _object_path;
END;
$$;
