-- Candidate only. Do not apply this file directly.
-- Under a separately authorized integration run, create a forward-only migration with
-- `supabase migration new product_completion_read_access_gate` and copy this reviewed body.

DO $$
BEGIN
  IF to_regprocedure('private.can_user_read_conversation(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'wp01_5_read_access_contract_missing';
  END IF;
  IF to_regprocedure('public.get_message_attachment_access(uuid[])') IS NULL THEN
    RAISE EXCEPTION 'product_attachment_access_contract_missing';
  END IF;
  IF to_regprocedure('public.resolve_message_attachment_media_for_server(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'product_attachment_media_resolver_missing';
  END IF;
END;
$$;

ALTER FUNCTION public.get_message_attachment_access(UUID[])
  RENAME TO get_message_attachment_access_before_product_read_access_gate;

REVOKE ALL ON FUNCTION public.get_message_attachment_access_before_product_read_access_gate(UUID[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_message_attachment_access_before_product_read_access_gate(UUID[])
  TO service_role;

CREATE FUNCTION public.get_message_attachment_access(_attachment_ids UUID[])
RETURNS TABLE (
  attachment_id UUID,
  access_mode TEXT,
  render_state TEXT,
  price_credits_snapshot INTEGER,
  is_unlocked BOOLEAN,
  view_mode TEXT,
  session_expires_at TIMESTAMPTZ,
  required_gift_id UUID,
  required_gift_name TEXT,
  required_gift_price_credits INTEGER,
  available_purchase_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _allowed_ids UUID[];
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF _attachment_ids IS NULL OR cardinality(_attachment_ids) = 0 THEN RETURN; END IF;
  IF cardinality(_attachment_ids) > 100 THEN RAISE EXCEPTION 'too_many_attachment_ids'; END IF;

  SELECT COALESCE(array_agg(attachment.id ORDER BY attachment.id), ARRAY[]::UUID[])
  INTO _allowed_ids
  FROM public.message_attachments attachment
  JOIN public.messages message ON message.id = attachment.message_id
  WHERE attachment.id = ANY (_attachment_ids)
    AND private.can_user_read_conversation(message.conversation_id, auth.uid()) IS TRUE;

  RETURN QUERY
  SELECT *
  FROM public.get_message_attachment_access_before_product_read_access_gate(_allowed_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.get_message_attachment_access(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_message_attachment_access(UUID[]) TO authenticated;

ALTER FUNCTION public.resolve_message_attachment_media_for_server(UUID, UUID)
  RENAME TO resolve_message_attachment_media_before_product_read_access_gate;

REVOKE ALL ON FUNCTION public.resolve_message_attachment_media_before_product_read_access_gate(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_message_attachment_media_before_product_read_access_gate(UUID, UUID)
  TO service_role;

CREATE FUNCTION public.resolve_message_attachment_media_for_server(
  _actor_user_id UUID,
  _attachment_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _conversation_id UUID;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;

  SELECT message.conversation_id
  INTO _conversation_id
  FROM public.message_attachments attachment
  JOIN public.messages message ON message.id = attachment.message_id
  WHERE attachment.id = _attachment_id;

  IF _conversation_id IS NULL
    OR private.can_user_read_conversation(_conversation_id, _actor_user_id) IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  RETURN public.resolve_message_attachment_media_before_product_read_access_gate(
    _actor_user_id,
    _attachment_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_message_attachment_media_for_server(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_message_attachment_media_for_server(UUID, UUID)
  TO service_role;

NOTIFY pgrst, 'reload schema';
