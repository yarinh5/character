-- ONLINE projects only the fields needed by the assigned conversation list.
CREATE OR REPLACE FUNCTION public.get_operator_online_context(_conversation_ids UUID[])
RETURNS TABLE (
  conversation_id UUID,
  client_age INTEGER,
  client_city TEXT,
  under_other_operator BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _actor UUID := auth.uid();
  _operator_id UUID;
BEGIN
  IF _actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  PERFORM private.ensure_recovery_business_open();

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = _actor AND COALESCE(p.status, 'active') = 'active'
      AND p.deleted_at IS NULL AND p.pii_archived_at IS NULL
  ) OR private.account_deletion_blocks_business_activity(_actor) THEN
    RAISE EXCEPTION 'operator_profile_required' USING ERRCODE = '42501';
  END IF;

  SELECT o.id INTO _operator_id
  FROM public.operators o
  JOIN public.user_roles role ON role.user_id = o.user_id AND role.role = 'operator'
  WHERE o.user_id = _actor AND o.is_active AND o.deleted_at IS NULL;

  IF _operator_id IS NULL AND public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'operator_profile_required' USING ERRCODE = '42501';
  END IF;
  IF cardinality(_conversation_ids) > 300 THEN
    RAISE EXCEPTION 'too_many_online_conversation_ids' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT c.id,
         CASE WHEN COALESCE(cp.computed_age, cp.age) BETWEEN 18 AND 120
              THEN COALESCE(cp.computed_age, cp.age) END,
         city.display_name_he,
         _operator_id IS NOT NULL AND c.status <> 'closed' AND EXISTS (
           SELECT 1 FROM public.conversation_handling_cycles cycle
           WHERE cycle.conversation_id = c.id AND cycle.ended_at IS NULL
             AND cycle.operator_id <> _operator_id
         )
  FROM public.conversations c
  LEFT JOIN public.profiles p ON p.user_id = c.client_id
    AND COALESCE(p.status, 'active') = 'active' AND p.deleted_at IS NULL
    AND p.pii_archived_at IS NULL
    AND NOT private.account_deletion_blocks_business_activity(c.client_id)
  LEFT JOIN public.client_profiles cp ON cp.user_id = p.user_id
  LEFT JOIN public.discovery_cities city ON city.id = cp.city_id AND city.is_active IS TRUE
  WHERE c.id = ANY (_conversation_ids)
    AND private.can_user_read_conversation(c.id, _actor) IS TRUE
    AND NOT private.conversation_deletion_blocks_access(c.id);
END;
$$;

REVOKE ALL ON FUNCTION public.get_operator_online_context(UUID[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_operator_online_context(UUID[]) TO authenticated;

-- Signal only a version change. Profile, deletion and recovery details stay out of Realtime.
CREATE FUNCTION private.invalidate_online_context_after_profile_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _reader UUID;
BEGIN
  FOR _reader IN
    SELECT role.user_id
    FROM public.user_roles role
    WHERE role.user_id = NEW.user_id AND role.role IN ('operator', 'admin')
    UNION
    SELECT operator.user_id
    FROM public.conversations c
    JOIN public.character_operator_assignments assignment ON assignment.character_id = c.character_id
    JOIN public.operators operator ON operator.id = assignment.operator_id
    WHERE c.client_id = NEW.user_id AND operator.is_active AND operator.deleted_at IS NULL
    UNION
    SELECT role.user_id
    FROM public.user_roles role
    WHERE role.role = 'admin' AND EXISTS (
      SELECT 1 FROM public.conversations c WHERE c.client_id = NEW.user_id
    )
    ORDER BY 1
  LOOP
    PERFORM private.bump_conversation_access_version(_reader);
  END LOOP;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.invalidate_online_context_after_profile_change()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER invalidate_online_context_after_profile_change
  AFTER UPDATE OF status, deleted_at, pii_archived_at ON public.profiles
  FOR EACH ROW WHEN (
    OLD.status IS DISTINCT FROM NEW.status OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
    OR OLD.pii_archived_at IS DISTINCT FROM NEW.pii_archived_at
  )
  EXECUTE FUNCTION private.invalidate_online_context_after_profile_change();

CREATE FUNCTION private.invalidate_online_context_after_recovery_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _reader UUID;
BEGIN
  FOR _reader IN
    SELECT DISTINCT role.user_id FROM public.user_roles role
    WHERE role.role IN ('operator', 'admin') ORDER BY role.user_id
  LOOP
    PERFORM private.bump_conversation_access_version(_reader);
  END LOOP;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.invalidate_online_context_after_recovery_transition()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER invalidate_online_context_after_recovery_transition
  AFTER UPDATE OF access_state ON private.restore_recovery_control
  FOR EACH ROW WHEN (OLD.access_state IS DISTINCT FROM NEW.access_state)
  EXECUTE FUNCTION private.invalidate_online_context_after_recovery_transition();
