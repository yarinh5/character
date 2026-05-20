CREATE OR REPLACE FUNCTION public.handle_new_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sender_type = 'client' THEN
    UPDATE public.conversations
    SET last_message_at = NEW.created_at,
        last_message_preview = LEFT(NEW.content, 200),
        operator_unread_count = operator_unread_count + 1,
        status = CASE
          WHEN status = 'closed' THEN 'open'::public.conversation_status
          ELSE 'waiting'::public.conversation_status
        END,
        updated_at = now()
    WHERE id = NEW.conversation_id;
  ELSIF NEW.sender_type = 'operator' THEN
    UPDATE public.conversations
    SET last_message_at = NEW.created_at,
        last_message_preview = LEFT(NEW.content, 200),
        client_unread_count = client_unread_count + 1,
        status = 'answered'::public.conversation_status,
        updated_at = now()
    WHERE id = NEW.conversation_id;
  ELSE
    UPDATE public.conversations
    SET last_message_at = NEW.created_at,
        last_message_preview = LEFT(NEW.content, 200),
        updated_at = now()
    WHERE id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_message() FROM anon, authenticated, public;
