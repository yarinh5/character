CREATE OR REPLACE FUNCTION public.admin_update_user_db(
  _user_id uuid,
  _display_name text DEFAULT NULL,
  _email text DEFAULT NULL,
  _status text DEFAULT NULL,
  _role public.app_role DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _current_status text;
  _changed_fields text[] := ARRAY[]::text[];
BEGIN
  IF _actor_id IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'target_user_required';
  END IF;
  IF _user_id = _actor_id AND (_status IS NOT NULL OR _role IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot_change_own_role_or_status';
  END IF;
  IF _display_name IS NOT NULL AND
    (char_length(btrim(_display_name)) NOT BETWEEN 1 AND 120 OR _display_name <> btrim(_display_name)) THEN
    RAISE EXCEPTION 'invalid_display_name';
  END IF;
  IF _email IS NOT NULL AND
    (char_length(_email) > 255 OR _email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') THEN
    RAISE EXCEPTION 'invalid_email';
  END IF;

  SELECT profile.status INTO _current_status
  FROM public.profiles AS profile
  WHERE profile.user_id = _user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target_profile_not_found';
  END IF;
  IF _role IN ('admin'::public.app_role, 'operator'::public.app_role) AND
    COALESCE(_status, _current_status) <> 'active' THEN
    RAISE EXCEPTION 'blocked_privileged_role_forbidden';
  END IF;

  IF _display_name IS NOT NULL OR _email IS NOT NULL THEN
    UPDATE public.profiles
    SET display_name = COALESCE(_display_name, display_name),
        email = COALESCE(_email, email)
    WHERE user_id = _user_id;
    IF _display_name IS NOT NULL THEN
      _changed_fields := pg_catalog.array_append(_changed_fields, 'display_name');
    END IF;
    IF _email IS NOT NULL THEN
      _changed_fields := pg_catalog.array_append(_changed_fields, 'email');
    END IF;
  END IF;
  IF _status IS NOT NULL THEN
    PERFORM public.admin_set_user_status(_user_id, _status);
  END IF;
  IF _role IS NOT NULL THEN
    PERFORM public.admin_set_user_role(_user_id, _role);
  END IF;
  IF pg_catalog.array_length(_changed_fields, 1) IS NOT NULL THEN
    INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
    VALUES (_actor_id, 'user.profile_updated', 'user', _user_id::text,
      pg_catalog.jsonb_build_object('fields', _changed_fields));
  END IF;

  RETURN true;
END;
$$;

NOTIFY pgrst, 'reload schema';
