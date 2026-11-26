CREATE FUNCTION public.admin_set_user_status(_user_id uuid, _status text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _deleted_at timestamptz;
  _pii_archived_at timestamptz;
BEGIN
  IF _actor_id IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'target_user_required';
  END IF;
  IF _user_id = _actor_id THEN
    RAISE EXCEPTION 'cannot_change_own_status';
  END IF;
  IF _status IS NULL OR _status NOT IN ('active', 'blocked') THEN
    RAISE EXCEPTION 'invalid_user_status';
  END IF;

  SELECT profile.deleted_at, profile.pii_archived_at
  INTO _deleted_at, _pii_archived_at
  FROM public.profiles AS profile
  WHERE profile.user_id = _user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target_profile_not_found';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = 'admin'::public.app_role
  ) THEN
    RAISE EXCEPTION 'admin_account_requires_separate_deprovisioning';
  END IF;
  IF _status = 'active' THEN
    IF _deleted_at IS NOT NULL OR _pii_archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'archived_user_cannot_be_reactivated';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.account_deletion_requests
      WHERE user_id = _user_id AND confirmed_at IS NOT NULL AND cancelled_at IS NULL
    ) THEN
      RAISE EXCEPTION 'confirmed_deletion_cannot_be_reactivated';
    END IF;
  END IF;

  UPDATE public.profiles SET status = _status WHERE user_id = _user_id;
  IF _status = 'blocked' THEN
    UPDATE public.operators
    SET is_active = false, availability_status = 'offline'::public.availability_status
    WHERE user_id = _user_id;
  END IF;
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_actor_id, 'user.status_changed', 'user', _user_id::text,
    pg_catalog.jsonb_build_object('status', _status));

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_user_status(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_user_status(uuid, text) TO authenticated;

CREATE FUNCTION public.admin_update_user_db(
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
    (_current_status <> 'active' OR _status = 'blocked') THEN
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

REVOKE ALL ON FUNCTION public.admin_update_user_db(uuid, text, text, text, public.app_role)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_user_db(uuid, text, text, text, public.app_role)
  TO authenticated;

CREATE FUNCTION public.guard_blocked_privileged_role_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _status text;
  _deleted_at timestamptz;
  _pii_archived_at timestamptz;
BEGIN
  SELECT status, deleted_at, pii_archived_at
  INTO _status, _deleted_at, _pii_archived_at
  FROM public.profiles WHERE user_id = NEW.user_id FOR UPDATE;
  IF NOT FOUND OR _status <> 'active' OR _deleted_at IS NOT NULL OR _pii_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'blocked_privileged_role_forbidden';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_blocked_privileged_role_assignment
BEFORE INSERT OR UPDATE OF role ON public.user_roles
FOR EACH ROW WHEN (NEW.role IN ('admin'::public.app_role, 'operator'::public.app_role))
EXECUTE FUNCTION public.guard_blocked_privileged_role_assignment();

NOTIFY pgrst, 'reload schema';
