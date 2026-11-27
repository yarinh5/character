-- Legacy paid opens remain available for pre-Gift attachments, but a Gift-gated
-- attachment must use the purchase and Gift-session flow before any debit.
ALTER FUNCTION public.open_paid_message_attachment(UUID, TEXT) SET SCHEMA private;

REVOKE ALL ON FUNCTION private.open_paid_message_attachment(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.open_paid_message_attachment(
  _attachment_id UUID,
  _idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.message_attachments attachment
    JOIN public.messages message ON message.id = attachment.message_id
    JOIN public.conversations conversation ON conversation.id = message.conversation_id
    WHERE attachment.id = _attachment_id
      AND attachment.required_gift_id IS NOT NULL
      AND conversation.client_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'gift_purchase_required';
  END IF;

  RETURN private.open_paid_message_attachment(_attachment_id, _idempotency_key);
END;
$$;

REVOKE ALL ON FUNCTION public.open_paid_message_attachment(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_paid_message_attachment(UUID, TEXT) TO authenticated;
