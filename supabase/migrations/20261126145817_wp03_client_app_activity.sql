CREATE TABLE private.client_app_activity (
  client_id UUID PRIMARY KEY REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  last_seen_at TIMESTAMPTZ NOT NULL,
  recovery_epoch TIMESTAMPTZ
);

ALTER TABLE private.client_app_activity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.client_app_activity FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.record_client_app_activity()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  _client_id UUID := auth.uid();
  _seen_at TIMESTAMPTZ;
  _recovery_epoch TIMESTAMPTZ;
  _within_cooldown BOOLEAN;
BEGIN
  IF _client_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF public.is_operator() OR public.is_admin() THEN
    RAISE EXCEPTION 'client_context_required' USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM private.client_app_activity activity
    WHERE activity.client_id = _client_id AND activity.last_seen_at > clock_timestamp() - interval '45 seconds'
  ) INTO _within_cooldown;
  IF NOT _within_cooldown THEN
    -- Serialize writes with profile invalidation, but allow concurrent heartbeats.
    PERFORM 1 FROM public.profiles p WHERE p.user_id = _client_id FOR SHARE;
  END IF;
  PERFORM private.ensure_active_client(_client_id);
  IF _within_cooldown THEN
    RETURN;
  END IF;

  -- Capture the open epoch with the sample. A later reopen cannot reuse it.
  SELECT clock_timestamp(), control.updated_at INTO _seen_at, _recovery_epoch
  FROM private.restore_recovery_control control
  WHERE control.singleton AND control.access_state = 'open';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'system_recovery_blocked' USING ERRCODE = '42501';
  END IF;

  -- Recheck the cooldown under the conflict lock in case another heartbeat won the race.
  INSERT INTO private.client_app_activity AS activity (client_id, last_seen_at, recovery_epoch)
  VALUES (_client_id, _seen_at, _recovery_epoch)
  ON CONFLICT (client_id) DO UPDATE
  SET last_seen_at = EXCLUDED.last_seen_at, recovery_epoch = EXCLUDED.recovery_epoch
  WHERE activity.last_seen_at <= EXCLUDED.last_seen_at - interval '45 seconds';
END;
$$;

REVOKE ALL ON FUNCTION public.record_client_app_activity() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_client_app_activity() TO authenticated;

CREATE FUNCTION private.invalidate_client_app_activity_after_profile_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.pii_archived_at IS NOT NULL OR NEW.status = 'archived' THEN
    DELETE FROM private.client_app_activity WHERE client_id = NEW.user_id;
  ELSE
    -- A reversible block discards the sample without resetting the write cooldown.
    UPDATE private.client_app_activity SET recovery_epoch = NULL
    WHERE client_id = NEW.user_id AND recovery_epoch IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.invalidate_client_app_activity_after_profile_change()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER invalidate_client_app_activity_after_profile_change
  AFTER UPDATE OF status, deleted_at, pii_archived_at ON public.profiles
  FOR EACH ROW WHEN (
    (COALESCE(NEW.status, 'active') <> 'active' OR NEW.deleted_at IS NOT NULL OR NEW.pii_archived_at IS NOT NULL)
    AND (OLD.status IS DISTINCT FROM NEW.status OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
      OR OLD.pii_archived_at IS DISTINCT FROM NEW.pii_archived_at)
  )
  EXECUTE FUNCTION private.invalidate_client_app_activity_after_profile_change();

-- Keep the original authorization, projection and batch checks in one place.
ALTER FUNCTION public.get_operator_online_context(UUID[]) SET SCHEMA private;
REVOKE ALL ON FUNCTION private.get_operator_online_context(UUID[])
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_operator_online_context(_conversation_ids UUID[])
RETURNS TABLE (
  conversation_id UUID,
  client_age INTEGER,
  client_city TEXT,
  under_other_operator BOOLEAN,
  client_online BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT context.conversation_id, context.client_age, context.client_city, context.under_other_operator,
         activity.last_seen_at > statement_timestamp() - interval '2 minutes'
  FROM private.get_operator_online_context(_conversation_ids) AS context
  LEFT JOIN public.conversations c ON c.id = context.conversation_id
  LEFT JOIN public.profiles p ON p.user_id = c.client_id
    AND COALESCE(p.status, 'active') = 'active' AND p.deleted_at IS NULL
    AND p.pii_archived_at IS NULL
  LEFT JOIN private.restore_recovery_control control ON control.singleton AND control.access_state = 'open'
  LEFT JOIN private.client_app_activity activity ON activity.client_id = p.user_id
    AND activity.recovery_epoch = control.updated_at
    AND NOT private.account_deletion_blocks_business_activity(p.user_id);
$$;

REVOKE ALL ON FUNCTION public.get_operator_online_context(UUID[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_operator_online_context(UUID[]) TO authenticated;
