-- Credit eligible operator text messages without changing client-message or sticker payouts.
-- The existing helper owns the per-operator, per-client-message streak cap. This wrapper
-- mirrors only eligible text-message scores into the credit wallet and ledger.

ALTER TABLE public.credit_transactions
  DROP CONSTRAINT IF EXISTS credit_transactions_type_check;

ALTER TABLE public.credit_transactions
  ADD CONSTRAINT credit_transactions_type_check
  CHECK (type = ANY (ARRAY[
    'signup_bonus'::TEXT,
    'message_spend'::TEXT,
    'message_payout'::TEXT,
    'operator_message_payout'::TEXT,
    'admin_adjustment'::TEXT,
    'package_purchase'::TEXT,
    'reset_grant'::TEXT,
    'migration_backfill'::TEXT,
    'locked_image_unlock'::TEXT,
    'locked_image_refund'::TEXT,
    'sticker_spend'::TEXT,
    'sticker_payout'::TEXT,
    'sticker_refund'::TEXT
  ]));

CREATE UNIQUE INDEX credit_transactions_one_operator_message_payout_idx
  ON public.credit_transactions (message_id)
  WHERE type = 'operator_message_payout';

CREATE OR REPLACE FUNCTION public.send_operator_message(
  _conversation_id UUID,
  _content TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _content_clean TEXT := btrim(COALESCE(_content, ''));
  _guard RECORD;
  _message_result RECORD;
  _credit_awarded INTEGER := 0;
  _balance_after INTEGER;
  _is_admin BOOLEAN := public.is_admin();
BEGIN
  IF char_length(_content_clean) = 0 OR char_length(_content_clean) > 2000 THEN
    RAISE EXCEPTION 'invalid_message_content';
  END IF;

  SELECT * INTO _guard
  FROM private.assert_operator_can_send_conversation_message(_conversation_id);

  SELECT * INTO _message_result
  FROM private.create_operator_message_with_scoring(
    _conversation_id,
    _guard.operator_id,
    _guard.user_id,
    _content_clean,
    jsonb_build_object('source', 'send_operator_message')
  );

  -- Admins may send through the operator identity for attribution, but never earn credits.
  IF _message_result.score_awarded > 0 AND _is_admin IS NOT TRUE THEN
    INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
    VALUES (_guard.user_id, 0, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;

    IF NOT EXISTS (
      SELECT 1
      FROM public.credit_transactions transaction
      WHERE transaction.message_id = _message_result.message_id
        AND transaction.type = 'operator_message_payout'
    ) THEN
      UPDATE public.credit_wallets
      SET
        balance = balance + 1,
        lifetime_earned = lifetime_earned + 1
      WHERE user_id = _guard.user_id
      RETURNING balance INTO _balance_after;

      INSERT INTO public.credit_transactions (
        user_id,
        amount,
        balance_after,
        type,
        reason,
        message_id,
        metadata
      )
      VALUES (
        _guard.user_id,
        1,
        _balance_after,
        'operator_message_payout',
        'Operator message payout',
        _message_result.message_id,
        jsonb_build_object(
          'conversation_id', _conversation_id,
          'operator_id', _guard.operator_id,
          'source', 'send_operator_message'
        )
      );

      _credit_awarded := 1;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'message', _message_result.message,
    'score_awarded', _message_result.score_awarded,
    'credit_awarded', _credit_awarded,
    'streak_position', _message_result.streak_position,
    'consecutive_message_limit', _message_result.consecutive_message_limit,
    'monthly_points', _message_result.monthly_points,
    'scoring_enabled', _message_result.scoring_enabled,
    'concurrency_mode', _guard.concurrency_mode
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.send_operator_message(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_operator_message(UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
