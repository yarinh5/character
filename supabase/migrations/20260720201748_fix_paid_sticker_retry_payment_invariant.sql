-- Operator/Admin sends retain the catalog price snapshot but intentionally have
-- no charge or payout. Their idempotent retry must therefore key off the
-- existence of a charge, not the snapshot price.
DO $$
DECLARE
  _definition TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'private.send_sticker_message(uuid,uuid,uuid,text)'::regprocedure
  )
  INTO _definition;

  IF position('IF _attempt.price_credits_snapshot > 0 THEN' IN _definition) = 0
    OR position($needle$'balance', CASE WHEN _actor_kind = 'client' AND _attempt.price_credits_snapshot > 0$needle$ IN _definition) = 0 THEN
    RAISE EXCEPTION 'paid_sticker_retry_function_shape_changed';
  END IF;

  _definition := replace(
    _definition,
    'IF _attempt.price_credits_snapshot > 0 THEN',
    'IF _attempt.charged_transaction_id IS NOT NULL THEN'
  );

  _definition := replace(
    _definition,
    $needle$'balance', CASE WHEN _actor_kind = 'client' AND _attempt.price_credits_snapshot > 0$needle$,
    $needle$'balance', CASE WHEN _actor_kind = 'client' AND _attempt.charged_transaction_id IS NOT NULL$needle$
  );

  EXECUTE _definition;
END;
$$;

NOTIFY pgrst, 'reload schema';
