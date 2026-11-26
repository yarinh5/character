-- Keep one notification producer. The older event remains an analytics fact
-- but must not bypass the new_report notification preference.
CREATE OR REPLACE FUNCTION private.record_v2_33_operator_report()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _operator_user_id UUID;
  _character_id UUID;
BEGIN
  SELECT operator.user_id INTO _operator_user_id
  FROM public.operators operator
  WHERE operator.id = NEW.operator_id;

  SELECT conversation.character_id INTO _character_id
  FROM public.conversations conversation
  WHERE conversation.id = NEW.conversation_id;

  PERFORM private.create_analytics_event(
    'operator_report_submitted',
    _operator_user_id,
    'operator'::public.app_role,
    NEW.conversation_id,
    _character_id,
    NEW.operator_id,
    jsonb_build_object('dedupe_key', format('operator_report_submitted:%s', NEW.id), 'operator_report_id', NEW.id)
  );

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.notify_admin_on_operator_client_report()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _admin_id UUID;
BEGIN
  FOR _admin_id IN
    SELECT admin_role.user_id
    FROM public.user_roles admin_role
    JOIN public.profiles profile ON profile.user_id = admin_role.user_id
    WHERE admin_role.role = 'admin'::public.app_role
      AND profile.status = 'active'
      AND profile.deleted_at IS NULL
  LOOP
    PERFORM public.create_notification(
      _admin_id,
      'new_report',
      'דיווח עובד חדש',
      'דיווח עובד חדש ממתין לטיפול',
      '/admin/reports',
      NULL,
      jsonb_build_object(
        'report_id', NEW.id,
        'dedupe_key', 'operator-client-report:' || NEW.id::TEXT
      ),
      0
    );
  END LOOP;

  RETURN NEW;
END;
$$;
