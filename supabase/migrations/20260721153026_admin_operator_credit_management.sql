-- Admin-only operator wallet adjustments. Client adjustments keep their existing RPC.
CREATE OR REPLACE FUNCTION public.adjust_operator_credits(
  _operator_id UUID,
  _amount INTEGER,
  _reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _operator public.operators%ROWTYPE;
  _balance_before INTEGER;
  _balance_after INTEGER;
  _transaction_id UUID;
  _admin_id UUID := auth.uid();
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_only';
  END IF;

  IF _operator_id IS NULL THEN
    RAISE EXCEPTION 'operator_required';
  END IF;

  IF _amount IS NULL OR _amount = 0 THEN
    RAISE EXCEPTION 'amount_must_be_non_zero';
  END IF;

  IF _reason IS NULL OR char_length(btrim(_reason)) < 3 THEN
    RAISE EXCEPTION 'reason_required';
  END IF;

  SELECT *
  INTO _operator
  FROM public.operators
  WHERE id = _operator_id
    AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator_not_found';
  END IF;

  INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
  VALUES (_operator.user_id, 0, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT balance
  INTO _balance_before
  FROM public.credit_wallets
  WHERE user_id = _operator.user_id
  FOR UPDATE;

  _balance_after := _balance_before + _amount;

  IF _balance_after < 0 THEN
    RAISE EXCEPTION 'insufficient_credits_for_adjustment';
  END IF;

  UPDATE public.credit_wallets
  SET
    balance = _balance_after,
    lifetime_earned = lifetime_earned + GREATEST(_amount, 0),
    lifetime_spent = lifetime_spent + GREATEST(-_amount, 0)
  WHERE user_id = _operator.user_id;

  INSERT INTO public.credit_transactions (
    user_id,
    amount,
    balance_after,
    type,
    reason,
    created_by,
    metadata
  )
  VALUES (
    _operator.user_id,
    _amount,
    _balance_after,
    'admin_adjustment',
    btrim(_reason),
    _admin_id,
    jsonb_build_object(
      'operator_id', _operator.id,
      'adjusted_by_admin_id', _admin_id,
      'source', 'admin_operator_credit_adjustment',
      'balance_before', _balance_before
    )
  )
  RETURNING id INTO _transaction_id;

  INSERT INTO public.audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    metadata
  )
  VALUES (
    _admin_id,
    'operator_credits.adjusted',
    'operator',
    _operator.id::TEXT,
    jsonb_build_object(
      'operator_user_id', _operator.user_id,
      'amount', _amount,
      'balance_before', _balance_before,
      'balance_after', _balance_after,
      'reason', btrim(_reason),
      'transaction_id', _transaction_id,
      'source', 'admin_operator_credit_adjustment'
    )
  );

  RETURN jsonb_build_object(
    'transaction_id', _transaction_id,
    'operator_id', _operator.id,
    'user_id', _operator.user_id,
    'amount', _amount,
    'balance_before', _balance_before,
    'balance_after', _balance_after
  );
END;
$$;

REVOKE ALL ON FUNCTION public.adjust_operator_credits(UUID, INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adjust_operator_credits(UUID, INTEGER, TEXT) TO authenticated;

-- Wallet and ledger mutations must go through audited SECURITY DEFINER RPCs.
DROP POLICY IF EXISTS "Admins manage credit wallets" ON public.credit_wallets;
DROP POLICY IF EXISTS "Admins insert credit transactions" ON public.credit_transactions;
DROP POLICY IF EXISTS "Admins view all credit wallets" ON public.credit_wallets;

CREATE POLICY "Admins view all credit wallets"
  ON public.credit_wallets FOR SELECT
  TO authenticated
  USING (public.is_admin());

NOTIFY pgrst, 'reload schema';
