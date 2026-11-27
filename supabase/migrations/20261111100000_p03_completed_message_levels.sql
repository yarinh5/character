-- P03: count each completed business Client message exactly once.
-- Existing text/image writers are transactional and already fence by message_id.
-- This forward migration closes the Gift transition gap without changing levels,
-- points, rewards, notifications, or the bounded Admin backfill contract.

DROP TRIGGER IF EXISTS count_client_gift_level ON public.gift_attachment_purchases;
CREATE TRIGGER count_client_gift_level
  AFTER UPDATE OF gift_message_id, status ON public.gift_attachment_purchases
  FOR EACH ROW
  WHEN (
    NEW.status IN ('purchased', 'opened')
    AND NEW.gift_message_id IS NOT NULL
    AND (
      OLD.gift_message_id IS DISTINCT FROM NEW.gift_message_id
      OR (
        OLD.status NOT IN ('purchased', 'opened')
        AND NEW.status = 'purchased'
      )
    )
  )
  EXECUTE FUNCTION private.count_client_gift_level();

NOTIFY pgrst, 'reload schema';
