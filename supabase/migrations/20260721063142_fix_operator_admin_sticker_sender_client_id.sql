DO $$
DECLARE
  _definition TEXT;
BEGIN
  SELECT pg_get_functiondef('private.send_sticker_message(uuid,uuid,uuid,text)'::regprocedure)
  INTO _definition;

  IF position($needle$
  _operator_id UUID;
  _client_guard RECORD;
$needle$ IN _definition) = 0 THEN
    RAISE EXCEPTION 'operator_admin_sticker_sender_declaration_shape_changed';
  END IF;

  IF position($needle$
  IF _actor_kind = 'client' THEN
    SELECT * INTO _client_guard
    FROM private.assert_client_can_send_sticker_message(_conversation_id);
  ELSIF _actor_kind = 'operator' THEN
$needle$ IN _definition) = 0 THEN
    RAISE EXCEPTION 'operator_admin_sticker_sender_client_guard_shape_changed';
  END IF;

  IF position($needle$
    CASE WHEN _actor_kind = 'client' AND _sticker.price_credits > 0 THEN _client_guard.user_id ELSE NULL END,
$needle$ IN _definition) = 0 THEN
    RAISE EXCEPTION 'operator_admin_sticker_sender_message_sticker_shape_changed';
  END IF;

  _definition := replace(
    _definition,
    $needle$
  _operator_id UUID;
  _client_guard RECORD;
$needle$,
    $replacement$
  _operator_id UUID;
  _client_guard RECORD;
  _client_id UUID;
$replacement$
  );

  _definition := replace(
    _definition,
    $needle$
  IF _actor_kind = 'client' THEN
    SELECT * INTO _client_guard
    FROM private.assert_client_can_send_sticker_message(_conversation_id);
  ELSIF _actor_kind = 'operator' THEN
$needle$,
    $replacement$
  IF _actor_kind = 'client' THEN
    SELECT * INTO _client_guard
    FROM private.assert_client_can_send_sticker_message(_conversation_id);
    _client_id := _client_guard.user_id;
  ELSIF _actor_kind = 'operator' THEN
$replacement$
  );

  _definition := replace(
    _definition,
    $needle$
    CASE WHEN _actor_kind = 'client' AND _sticker.price_credits > 0 THEN _client_guard.user_id ELSE NULL END,
$needle$,
    $replacement$
    CASE WHEN _actor_kind = 'client' AND _sticker.price_credits > 0 THEN _client_id ELSE NULL END,
$replacement$
  );

  EXECUTE _definition;
END;
$$;

NOTIFY pgrst, 'reload schema';
