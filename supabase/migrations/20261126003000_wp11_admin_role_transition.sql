CREATE FUNCTION public.admin_set_user_role(
  _user_id uuid,
  _new_role public.app_role
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _admin_id uuid := auth.uid();
  _display_name text;
  _email text;
BEGIN
  IF _admin_id IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'target_user_required';
  END IF;
  IF _new_role IS NULL THEN
    RAISE EXCEPTION 'role_required';
  END IF;
  IF _user_id = _admin_id THEN
    RAISE EXCEPTION 'cannot_change_own_role';
  END IF;

  SELECT profile.display_name, profile.email
  INTO _display_name, _email
  FROM public.profiles AS profile
  WHERE profile.user_id = _user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target_profile_not_found';
  END IF;

  DELETE FROM public.user_roles WHERE user_id = _user_id;
  INSERT INTO public.user_roles (user_id, role) VALUES (_user_id, _new_role);

  IF _new_role = 'operator'::public.app_role THEN
    INSERT INTO public.operators (user_id, full_name, is_active, availability_status)
    VALUES (_user_id, COALESCE(_display_name, _email, 'עובד'), true,
      'available'::public.availability_status)
    ON CONFLICT (user_id) DO UPDATE
      SET is_active = true,
          availability_status = 'available'::public.availability_status;
  ELSIF _new_role = 'client'::public.app_role THEN
    UPDATE public.operators
    SET is_active = false, availability_status = 'offline'::public.availability_status
    WHERE user_id = _user_id;
    INSERT INTO public.client_profiles (user_id)
    VALUES (_user_id)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_admin_id, 'user.role_changed', 'user', _user_id::text,
    pg_catalog.jsonb_build_object('role', _new_role));

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_user_role(uuid, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_user_role(uuid, public.app_role) TO authenticated;

NOTIFY pgrst, 'reload schema';
