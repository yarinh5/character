DO $$
DECLARE
  _definition TEXT;
BEGIN
  SELECT pg_get_functiondef('private.send_sticker_message(uuid,uuid,uuid,text)'::regprocedure)
  INTO _definition;

  IF position($needle$
  _operator_guard RECORD;
  _client_guard RECORD;
$needle$ IN _definition) = 0 THEN
    RAISE EXCEPTION 'client_sticker_sender_declaration_shape_changed';
  END IF;

  IF position($needle$
  ELSIF _actor_kind = 'operator' THEN
    SELECT * INTO _operator_guard
    FROM private.assert_operator_can_send_conversation_message(_conversation_id);
  ELSIF _actor_kind = 'admin' THEN
    SELECT * INTO _operator_guard
    FROM private.assert_admin_can_send_conversation_message(_conversation_id);
$needle$ IN _definition) = 0 THEN
    RAISE EXCEPTION 'client_sticker_sender_guard_shape_changed';
  END IF;

  IF position($needle$
    CASE WHEN _actor_kind = 'client' THEN NULL ELSE _operator_guard.operator_id END,
$needle$ IN _definition) = 0 THEN
    RAISE EXCEPTION 'client_sticker_sender_message_shape_changed';
  END IF;

  _definition := replace(
    _definition,
    $needle$
  _operator_guard RECORD;
  _client_guard RECORD;
$needle$,
    $replacement$
  _operator_guard RECORD;
  _operator_id UUID;
  _client_guard RECORD;
$replacement$
  );

  _definition := replace(
    _definition,
    $needle$
  ELSIF _actor_kind = 'operator' THEN
    SELECT * INTO _operator_guard
    FROM private.assert_operator_can_send_conversation_message(_conversation_id);
  ELSIF _actor_kind = 'admin' THEN
    SELECT * INTO _operator_guard
    FROM private.assert_admin_can_send_conversation_message(_conversation_id);
$needle$,
    $replacement$
  ELSIF _actor_kind = 'operator' THEN
    SELECT * INTO _operator_guard
    FROM private.assert_operator_can_send_conversation_message(_conversation_id);
    _operator_id := _operator_guard.operator_id;
  ELSIF _actor_kind = 'admin' THEN
    SELECT * INTO _operator_guard
    FROM private.assert_admin_can_send_conversation_message(_conversation_id);
    _operator_id := _operator_guard.operator_id;
$replacement$
  );

  _definition := replace(
    _definition,
    $needle$
    CASE WHEN _actor_kind = 'client' THEN NULL ELSE _operator_guard.operator_id END,
$needle$,
    $replacement$
    _operator_id,
$replacement$
  );

  EXECUTE _definition;
END;
$$;

NOTIFY pgrst, 'reload schema';
