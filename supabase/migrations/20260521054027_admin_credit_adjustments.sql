-- Admin Credits & Packages: atomic manual wallet adjustments.
-- UI package/settings management uses existing admin RLS policies.

CREATE OR REPLACE FUNCTION public.admin_adjust_client_credits(
  _user_id UUID,
  _amount INTEGER,
  _reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  _balance_before INTEGER;
  _balance_after INTEGER;
  _transaction_id UUID;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_only';
  END IF;

  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'user_required';
  END IF;

  IF _amount IS NULL OR _amount = 0 THEN
    RAISE EXCEPTION 'amount_must_be_non_zero';
  END IF;

  IF _reason IS NULL OR char_length(btrim(_reason)) < 3 THEN
    RAISE EXCEPTION 'reason_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = 'client'
  ) THEN
    RAISE EXCEPTION 'client_not_found';
  END IF;

  INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
  VALUES (_user_id, 0, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT balance
  INTO _balance_before
  FROM public.credit_wallets
  WHERE user_id = _user_id
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
  WHERE user_id = _user_id;

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
    _user_id,
    _amount,
    _balance_after,
    'admin_adjustment',
    btrim(_reason),
    auth.uid(),
    jsonb_build_object(
      'source', 'admin_credit_ui',
      'balance_before', _balance_before
    )
  )
  RETURNING id INTO _transaction_id;

  RETURN jsonb_build_object(
    'transaction_id', _transaction_id,
    'user_id', _user_id,
    'amount', _amount,
    'balance_before', _balance_before,
    'balance_after', _balance_after
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_adjust_client_credits(UUID, INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_adjust_client_credits(UUID, INTEGER, TEXT) TO authenticated;
