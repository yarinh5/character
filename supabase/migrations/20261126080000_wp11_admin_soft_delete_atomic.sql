CREATE FUNCTION public.admin_soft_delete_user(_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _deleted_at timestamptz;
  _pii_archived_at timestamptz;
  _was_deleted boolean;
BEGIN
  IF _actor_id IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'target_user_required';
  END IF;
  IF _user_id = _actor_id THEN
    RAISE EXCEPTION 'cannot_delete_own_account';
  END IF;

  SELECT profile.deleted_at, profile.pii_archived_at
  INTO _deleted_at, _pii_archived_at
  FROM public.profiles AS profile
  WHERE profile.user_id = _user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target_profile_not_found';
  END IF;
  IF _pii_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'pii_archived_target_forbidden';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = 'admin'::public.app_role
  ) THEN
    RAISE EXCEPTION 'admin_account_requires_separate_deprovisioning';
  END IF;

  _was_deleted := _deleted_at IS NOT NULL;
  _deleted_at := COALESCE(_deleted_at, clock_timestamp());

  UPDATE public.profiles
  SET status = 'blocked',
      display_name = 'משתמש מחוק',
      email = 'deleted+' || replace(_user_id::text, '-', '') || '@deleted.local',
      deleted_at = _deleted_at
  WHERE user_id = _user_id;

  UPDATE public.operators
  SET is_active = false,
      availability_status = 'offline'::public.availability_status,
      deleted_at = COALESCE(deleted_at, _deleted_at)
  WHERE user_id = _user_id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_actor_id, 'user.soft_deleted', 'user', _user_id::text,
    jsonb_build_object('archived_at', _deleted_at, 'repeated', _was_deleted));

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_soft_delete_user(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_soft_delete_user(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
