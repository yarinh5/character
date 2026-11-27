-- WP01.5: separate read authorization from handling ownership and provide a
-- transaction-bound, content-free invalidation signal for browser sessions.

CREATE TABLE public.user_conversation_access_versions (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.user_conversation_access_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_conversation_access_versions REPLICA IDENTITY FULL;
REVOKE ALL ON TABLE public.user_conversation_access_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.user_conversation_access_versions TO authenticated;

CREATE POLICY "Users read own conversation access version"
  ON public.user_conversation_access_versions FOR SELECT
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION private.bump_conversation_access_version(_user_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  INSERT INTO public.user_conversation_access_versions (user_id, version, updated_at)
  SELECT _user_id, 1, clock_timestamp()
  WHERE EXISTS (SELECT 1 FROM auth.users WHERE id = _user_id)
  ON CONFLICT (user_id) DO UPDATE
    SET version = public.user_conversation_access_versions.version + 1,
        updated_at = clock_timestamp();
$$;

REVOKE ALL ON FUNCTION private.bump_conversation_access_version(UUID)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.bump_assignment_access_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _old_user_id UUID;
  _new_user_id UUID;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT user_id INTO _old_user_id FROM public.operators WHERE id = OLD.operator_id;
    PERFORM private.bump_conversation_access_version(_old_user_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT user_id INTO _new_user_id FROM public.operators WHERE id = NEW.operator_id;
    IF _new_user_id IS DISTINCT FROM _old_user_id THEN
      PERFORM private.bump_conversation_access_version(_new_user_id);
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.bump_operator_access_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR OLD.user_id IS DISTINCT FROM NEW.user_id
     OR OLD.is_active IS DISTINCT FROM NEW.is_active
     OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at THEN
    IF TG_OP <> 'INSERT' THEN
      PERFORM private.bump_conversation_access_version(OLD.user_id);
    END IF;
    IF TG_OP = 'INSERT' OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      PERFORM private.bump_conversation_access_version(NEW.user_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.bump_role_access_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM private.bump_conversation_access_version(OLD.user_id);
  END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    PERFORM private.bump_conversation_access_version(NEW.user_id);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.bump_assignment_access_version(),
  private.bump_operator_access_version(), private.bump_role_access_version()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.lock_assignment_access_revoke()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  PERFORM 1 FROM public.conversations
  WHERE character_id IN (OLD.character_id, NEW.character_id)
  ORDER BY id FOR UPDATE;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.lock_operator_access_revoke()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF OLD.user_id IS DISTINCT FROM NEW.user_id
     OR OLD.is_active IS DISTINCT FROM NEW.is_active
     OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at THEN
    PERFORM 1
    FROM public.conversations c
    JOIN public.character_operator_assignments a ON a.character_id = c.character_id
    WHERE a.operator_id = OLD.id
    ORDER BY c.id FOR UPDATE OF c;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.lock_role_access_revoke()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  PERFORM 1
  FROM public.conversations c
  JOIN public.character_operator_assignments a ON a.character_id = c.character_id
  JOIN public.operators o ON o.id = a.operator_id
  WHERE o.user_id = OLD.user_id
  ORDER BY c.id FOR UPDATE OF c;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.lock_assignment_access_revoke(),
  private.lock_operator_access_revoke(), private.lock_role_access_revoke()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER lock_assignment_access_revoke
  BEFORE UPDATE OR DELETE ON public.character_operator_assignments
  FOR EACH ROW EXECUTE FUNCTION private.lock_assignment_access_revoke();
CREATE TRIGGER lock_operator_access_revoke
  BEFORE UPDATE OF user_id, is_active, deleted_at ON public.operators
  FOR EACH ROW EXECUTE FUNCTION private.lock_operator_access_revoke();
CREATE TRIGGER lock_role_access_revoke
  BEFORE UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION private.lock_role_access_revoke();

CREATE TRIGGER bump_assignment_access_version
  AFTER INSERT OR UPDATE OR DELETE ON public.character_operator_assignments
  FOR EACH ROW EXECUTE FUNCTION private.bump_assignment_access_version();
CREATE TRIGGER bump_operator_access_version
  AFTER INSERT OR UPDATE OF user_id, is_active, deleted_at ON public.operators
  FOR EACH ROW EXECUTE FUNCTION private.bump_operator_access_version();
CREATE TRIGGER bump_role_access_version
  AFTER INSERT OR UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION private.bump_role_access_version();

INSERT INTO public.user_conversation_access_versions (user_id)
SELECT DISTINCT user_id FROM public.operators
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION private.can_user_read_conversation(
  _conversation_id UUID,
  _user_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversations c WHERE c.id = _conversation_id AND c.client_id = _user_id
  ) OR EXISTS (
    SELECT 1 FROM public.user_roles ur WHERE ur.user_id = _user_id AND ur.role = 'admin'
  ) OR EXISTS (
    SELECT 1
    FROM public.conversations c
    JOIN public.character_operator_assignments coa ON coa.character_id = c.character_id
    JOIN public.operators o ON o.id = coa.operator_id
    WHERE c.id = _conversation_id
      AND o.user_id = _user_id
      AND o.is_active = true
      AND o.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = _user_id AND ur.role IN ('operator', 'admin')
      )
  );
$$;

REVOKE ALL ON FUNCTION private.can_user_read_conversation(UUID, UUID)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_conversation_operator(_conversation_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
  SELECT private.can_user_read_conversation(_conversation_id, auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.operators o
      WHERE o.user_id = auth.uid() AND o.is_active = true AND o.deleted_at IS NULL
    );
$$;

CREATE OR REPLACE FUNCTION public.can_read_current_conversation(_conversation_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
  SELECT private.can_user_read_conversation(_conversation_id, auth.uid());
$$;

REVOKE ALL ON FUNCTION public.can_read_current_conversation(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_read_current_conversation(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_conversation_read_access(_conversation_id UUID)
RETURNS TABLE (allowed BOOLEAN, access_version BIGINT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  RETURN QUERY
  SELECT private.can_user_read_conversation(_conversation_id, _user_id),
         COALESCE(v.version, 0)
  FROM (SELECT 1) seed
  LEFT JOIN public.user_conversation_access_versions v ON v.user_id = _user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_conversation_read_access(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_conversation_read_access(UUID) TO authenticated;

-- Writers lock the conversation first, then derive every authorization fact
-- from the locked snapshot. Revocation triggers take the same conversation lock.
CREATE OR REPLACE FUNCTION private.assert_operator_can_send_base(
  _conversation_id UUID
)
RETURNS TABLE (
  operator_id UUID,
  user_id UUID,
  concurrency_mode TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _operator_id UUID;
  _conversation public.conversations%ROWTYPE;
  _concurrency_mode TEXT;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF _user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO _conversation
  FROM public.conversations conversation
  WHERE conversation.id = _conversation_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_not_found'; END IF;

  _concurrency_mode := COALESCE(private.setting_text('concurrency_mode', 'open'), 'open');
  SELECT operator.id INTO _operator_id
  FROM public.operators operator
  WHERE operator.user_id = _user_id
    AND operator.is_active = true
    AND operator.deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = _user_id AND ur.role = 'operator'
    )
  ORDER BY operator.id
  LIMIT 1;
  IF _operator_id IS NULL THEN RAISE EXCEPTION 'operator_record_required'; END IF;
  IF _conversation.status = 'closed'::public.conversation_status THEN
    RAISE EXCEPTION 'conversation_closed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.character_operator_assignments assignment
    WHERE assignment.character_id = _conversation.character_id
      AND assignment.operator_id = _operator_id
  ) THEN
    RAISE EXCEPTION 'operator_not_assigned_to_character';
  END IF;

  RETURN QUERY SELECT _operator_id, _user_id, _concurrency_mode;
END;
$$;

REVOKE ALL ON FUNCTION private.assert_operator_can_send_base(UUID)
  FROM PUBLIC, anon, authenticated, service_role;

-- Presence and typing are persisted as minimal rows. Browsers may only mutate
-- their own row through the authorization-checking RPC below.
CREATE TABLE public.conversation_presence_states (
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('client', 'operator', 'admin')),
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  active_in_conversation BOOLEAN NOT NULL DEFAULT true,
  is_typing BOOLEAN NOT NULL DEFAULT false,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + interval '45 seconds'),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX conversation_presence_states_expiry_idx
  ON public.conversation_presence_states (expires_at);
ALTER TABLE public.conversation_presence_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_presence_states REPLICA IDENTITY FULL;
REVOKE ALL ON TABLE public.conversation_presence_states FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.conversation_presence_states TO authenticated;
CREATE POLICY "Authorized users read conversation presence"
  ON public.conversation_presence_states FOR SELECT
  USING (public.can_read_current_conversation(conversation_id));

CREATE OR REPLACE FUNCTION private.resolve_conversation_presence_identity(
  _conversation_id UUID,
  _user_id UUID
)
RETURNS TABLE (trusted_role TEXT, trusted_display_name TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _role TEXT;
  _display_name TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = _user_id AND ur.role = 'admin'
  ) THEN
    _role := 'admin';
    SELECT COALESCE(
      NULLIF(btrim(o.full_name), ''),
      NULLIF(btrim(p.display_name), ''),
      'מנהל'
    )
    INTO _display_name
    FROM (SELECT 1) seed
    LEFT JOIN public.operators o ON o.user_id = _user_id AND o.deleted_at IS NULL
    LEFT JOIN public.profiles p ON p.user_id = _user_id
    LIMIT 1;
  ELSIF EXISTS (
    SELECT 1
    FROM public.conversations c
    JOIN public.character_operator_assignments a ON a.character_id = c.character_id
    JOIN public.operators o ON o.id = a.operator_id
    JOIN public.user_roles ur ON ur.user_id = o.user_id AND ur.role = 'operator'
    WHERE c.id = _conversation_id
      AND o.user_id = _user_id
      AND o.is_active = true
      AND o.deleted_at IS NULL
  ) THEN
    _role := 'operator';
    SELECT COALESCE(NULLIF(btrim(o.full_name), ''), 'עובד')
    INTO _display_name
    FROM public.operators o
    WHERE o.user_id = _user_id AND o.is_active = true AND o.deleted_at IS NULL
    ORDER BY o.id
    LIMIT 1;
  ELSIF EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = _conversation_id AND c.client_id = _user_id
  ) THEN
    _role := 'client';
    SELECT COALESCE(NULLIF(btrim(p.display_name), ''), 'לקוח')
    INTO _display_name
    FROM public.profiles p
    WHERE p.user_id = _user_id;
    _display_name := COALESCE(_display_name, 'לקוח');
  ELSE
    RAISE EXCEPTION 'conversation_read_forbidden';
  END IF;

  RETURN QUERY SELECT _role, left(_display_name, 120);
END;
$$;

REVOKE ALL ON FUNCTION private.resolve_conversation_presence_identity(UUID, UUID)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_conversation_presence(
  _conversation_id UUID,
  _role TEXT,
  _display_name TEXT,
  _active BOOLEAN,
  _typing BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _trusted_role TEXT;
  _trusted_display_name TEXT;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF _active IS NOT TRUE THEN
    DELETE FROM public.conversation_presence_states
    WHERE conversation_id = _conversation_id AND user_id = _user_id;
    RETURN;
  END IF;
  IF private.can_user_read_conversation(_conversation_id, _user_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'conversation_read_forbidden';
  END IF;
  SELECT identity.trusted_role, identity.trusted_display_name
  INTO _trusted_role, _trusted_display_name
  FROM private.resolve_conversation_presence_identity(_conversation_id, _user_id) identity;
  IF _role IS DISTINCT FROM _trusted_role THEN
    RAISE EXCEPTION 'presence_identity_mismatch';
  END IF;
  INSERT INTO public.conversation_presence_states (
    conversation_id, user_id, role, display_name, active_in_conversation,
    is_typing, last_seen_at, expires_at
  ) VALUES (
    _conversation_id, _user_id, _trusted_role, _trusted_display_name,
    true, _typing, clock_timestamp(), clock_timestamp() + interval '45 seconds'
  )
  ON CONFLICT (conversation_id, user_id) DO UPDATE SET
    role = EXCLUDED.role, display_name = EXCLUDED.display_name,
    active_in_conversation = true, is_typing = EXCLUDED.is_typing,
    last_seen_at = EXCLUDED.last_seen_at, expires_at = EXCLUDED.expires_at;
END;
$$;

REVOKE ALL ON FUNCTION public.set_conversation_presence(UUID, TEXT, TEXT, BOOLEAN, BOOLEAN)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_conversation_presence(UUID, TEXT, TEXT, BOOLEAN, BOOLEAN)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.get_conversation_presence(_conversation_id UUID)
RETURNS TABLE (user_id UUID, role TEXT, display_name TEXT, online_at TIMESTAMPTZ, is_typing BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF private.can_user_read_conversation(_conversation_id, auth.uid()) IS NOT TRUE THEN
    RAISE EXCEPTION 'conversation_read_forbidden';
  END IF;
  RETURN QUERY
  SELECT p.user_id, p.role, p.display_name, p.last_seen_at, p.is_typing
  FROM public.conversation_presence_states p
  WHERE p.conversation_id = _conversation_id AND p.expires_at > clock_timestamp();
END;
$$;

REVOKE ALL ON FUNCTION public.get_conversation_presence(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_conversation_presence(UUID) TO authenticated;

-- The existing activity projection is also write-closed and re-authorized.
REVOKE INSERT, UPDATE, DELETE ON public.user_active_conversations FROM authenticated;
CREATE OR REPLACE FUNCTION public.touch_active_conversation(_conversation_id UUID, _role TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _trusted_role TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF private.can_user_read_conversation(_conversation_id, auth.uid()) IS NOT TRUE THEN
    RAISE EXCEPTION 'conversation_read_forbidden';
  END IF;
  SELECT identity.trusted_role INTO _trusted_role
  FROM private.resolve_conversation_presence_identity(_conversation_id, auth.uid()) identity;
  IF _role IS DISTINCT FROM _trusted_role THEN
    RAISE EXCEPTION 'active_conversation_identity_mismatch';
  END IF;
  INSERT INTO public.user_active_conversations (user_id, conversation_id, role, last_seen_at, expires_at)
  VALUES (auth.uid(), _conversation_id, _trusted_role, clock_timestamp(), clock_timestamp() + interval '45 seconds')
  ON CONFLICT (user_id, conversation_id) DO UPDATE SET
    role = EXCLUDED.role, last_seen_at = EXCLUDED.last_seen_at, expires_at = EXCLUDED.expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.leave_active_conversation(_conversation_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  DELETE FROM public.user_active_conversations
  WHERE user_id = auth.uid() AND conversation_id = _conversation_id;
$$;

REVOKE ALL ON FUNCTION public.touch_active_conversation(UUID, TEXT),
  public.leave_active_conversation(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.touch_active_conversation(UUID, TEXT),
  public.leave_active_conversation(UUID) TO authenticated;

-- CRM mutations require current handling ownership for operators. Admins retain
-- their established management contract without implicitly taking ownership.
CREATE OR REPLACE FUNCTION private.assert_conversation_content_writer(_conversation_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _operator_id UUID;
  _cycle_operator_id UUID;
  _conversation public.conversations%ROWTYPE;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO _conversation
  FROM public.conversations conversation
  WHERE conversation.id = _conversation_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_not_found'; END IF;

  IF public.is_admin() THEN RETURN NULL; END IF;
  SELECT id INTO _operator_id FROM public.operators
  WHERE user_id = auth.uid()
    AND is_active = true
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'operator'
    )
  ORDER BY id
  LIMIT 1;
  IF _operator_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.character_operator_assignments assignment
       WHERE assignment.character_id = _conversation.character_id
         AND assignment.operator_id = _operator_id
     ) THEN
    RAISE EXCEPTION 'conversation_write_forbidden';
  END IF;
  SELECT operator_id INTO _cycle_operator_id
  FROM public.conversation_handling_cycles
  WHERE conversation_id = _conversation_id AND ended_at IS NULL
  ORDER BY started_at DESC LIMIT 1 FOR UPDATE;
  IF _cycle_operator_id IS DISTINCT FROM _operator_id THEN
    RAISE EXCEPTION 'conversation_locked_by_other_operator';
  END IF;
  RETURN _operator_id;
END;
$$;

REVOKE ALL ON FUNCTION private.assert_conversation_content_writer(UUID)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.add_operator_internal_note(_conversation_id UUID, _note TEXT)
RETURNS public.internal_notes
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
DECLARE _operator_id UUID; _row public.internal_notes%ROWTYPE;
BEGIN
  _operator_id := private.assert_conversation_content_writer(_conversation_id);
  IF _operator_id IS NULL THEN SELECT id INTO _operator_id FROM public.operators WHERE user_id = auth.uid() LIMIT 1; END IF;
  IF _operator_id IS NULL OR NULLIF(btrim(_note), '') IS NULL THEN RAISE EXCEPTION 'invalid_note'; END IF;
  INSERT INTO public.internal_notes (conversation_id, operator_id, note)
  VALUES (_conversation_id, _operator_id, left(btrim(_note), 2000)) RETURNING * INTO _row;
  RETURN _row;
END;
$$;

CREATE OR REPLACE FUNCTION public.add_operator_customer_info(_conversation_id UUID, _content TEXT)
RETURNS public.customer_info_entries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
DECLARE _operator_id UUID; _client_id UUID; _row public.customer_info_entries%ROWTYPE;
BEGIN
  _operator_id := private.assert_conversation_content_writer(_conversation_id);
  IF _operator_id IS NULL THEN SELECT id INTO _operator_id FROM public.operators WHERE user_id = auth.uid() LIMIT 1; END IF;
  SELECT client_id INTO _client_id FROM public.conversations WHERE id = _conversation_id;
  IF _operator_id IS NULL OR _client_id IS NULL OR NULLIF(btrim(_content), '') IS NULL THEN RAISE EXCEPTION 'invalid_customer_info'; END IF;
  INSERT INTO public.customer_info_entries (client_id, conversation_id, operator_id, created_by_user_id, content)
  VALUES (_client_id, _conversation_id, _operator_id, auth.uid(), left(btrim(_content), 2000)) RETURNING * INTO _row;
  RETURN _row;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_operator_conversation_status(
  _conversation_id UUID,
  _status public.conversation_status
)
RETURNS public.conversations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
DECLARE _row public.conversations%ROWTYPE;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  PERFORM private.assert_conversation_content_writer(_conversation_id);
  UPDATE public.conversations SET status = _status, updated_at = clock_timestamp()
  WHERE id = _conversation_id RETURNING * INTO _row;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_not_found'; END IF;
  RETURN _row;
END;
$$;

REVOKE ALL ON FUNCTION public.add_operator_internal_note(UUID, TEXT),
  public.add_operator_customer_info(UUID, TEXT),
  public.update_operator_conversation_status(UUID, public.conversation_status)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_operator_internal_note(UUID, TEXT),
  public.add_operator_customer_info(UUID, TEXT),
  public.update_operator_conversation_status(UUID, public.conversation_status)
  TO authenticated;

DROP POLICY IF EXISTS "Operators insert notes in assigned conversations" ON public.internal_notes;
DROP POLICY IF EXISTS "Operators create customer info for assigned characters" ON public.customer_info_entries;
DROP POLICY IF EXISTS "Operators update assigned conversations" ON public.conversations;
REVOKE UPDATE (status) ON public.conversations FROM authenticated;

DROP POLICY IF EXISTS "Operators view customer info for assigned characters"
  ON public.customer_info_entries;
CREATE POLICY "Operators view customer info for assigned characters"
  ON public.customer_info_entries FOR SELECT
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.conversations c
      WHERE c.client_id = customer_info_entries.client_id
        AND (
          customer_info_entries.conversation_id IS NULL
          OR customer_info_entries.conversation_id = c.id
        )
        AND public.is_conversation_operator(c.id)
    )
  );

CREATE OR REPLACE FUNCTION public.get_operator_conversation_client_profile(
  _conversation_id UUID
)
RETURNS TABLE (
  age INTEGER,
  interests TEXT[],
  conversation_preferences TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF private.can_user_read_conversation(_conversation_id, auth.uid()) IS NOT TRUE THEN
    RAISE EXCEPTION 'conversation_read_forbidden' USING ERRCODE = '42501';
  END IF;
  IF public.is_admin() IS NOT TRUE AND NOT EXISTS (
    SELECT 1
    FROM public.operators o
    JOIN public.user_roles ur ON ur.user_id = o.user_id AND ur.role = 'operator'
    WHERE o.user_id = auth.uid()
      AND o.is_active = true
      AND o.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'operator_profile_required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT cp.age, cp.interests, cp.conversation_preferences
  FROM public.conversations c
  LEFT JOIN public.client_profiles cp ON cp.user_id = c.client_id
  WHERE c.id = _conversation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_operator_conversation_client_profile(UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_operator_conversation_client_profile(UUID)
  TO authenticated;

-- Wrap the established media resolvers so every new URL/access lookup first
-- passes the current read-authorization helper. The legacy functions retain
-- their detailed entitlement, view-once and paid-open checks behind the wrapper.
ALTER FUNCTION public.get_message_attachment_access(UUID[])
  RENAME TO get_message_attachment_access_before_wp01_5;
REVOKE ALL ON FUNCTION public.get_message_attachment_access_before_wp01_5(UUID[])
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.get_message_attachment_access(_attachment_ids UUID[])
RETURNS TABLE (
  attachment_id UUID, access_mode TEXT, render_state TEXT,
  price_credits_snapshot INTEGER, is_unlocked BOOLEAN,
  view_mode TEXT, session_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
DECLARE _allowed_ids UUID[];
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF _attachment_ids IS NULL OR cardinality(_attachment_ids) = 0 THEN RETURN; END IF;
  IF cardinality(_attachment_ids) > 100 THEN RAISE EXCEPTION 'too_many_attachment_ids'; END IF;
  SELECT COALESCE(array_agg(a.id), ARRAY[]::UUID[]) INTO _allowed_ids
  FROM public.message_attachments a
  JOIN public.messages m ON m.id = a.message_id
  WHERE a.id = ANY (_attachment_ids)
    AND private.can_user_read_conversation(m.conversation_id, auth.uid());
  RETURN QUERY SELECT * FROM public.get_message_attachment_access_before_wp01_5(_allowed_ids);
END;
$$;
REVOKE ALL ON FUNCTION public.get_message_attachment_access(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_message_attachment_access(UUID[]) TO authenticated;

ALTER FUNCTION public.resolve_character_media_preview_path_for_server(UUID, TEXT, UUID)
  RENAME TO resolve_character_media_preview_path_before_wp01_5;
REVOKE ALL ON FUNCTION public.resolve_character_media_preview_path_before_wp01_5(UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.resolve_character_media_preview_path_for_server(
  _actor_user_id UUID, _target_kind TEXT, _target_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
DECLARE _conversation_id UUID;
BEGIN
  IF _target_kind = 'message_attachment' THEN
    SELECT m.conversation_id INTO _conversation_id
    FROM public.message_attachments a JOIN public.messages m ON m.id = a.message_id
    WHERE a.id = _target_id;
  ELSIF _target_kind = 'reserved_preview' THEN
    SELECT conversation_id INTO _conversation_id
    FROM public.character_media_reservations WHERE id = _target_id;
  END IF;
  IF _conversation_id IS NOT NULL
     AND private.can_user_read_conversation(_conversation_id, _actor_user_id) IS NOT TRUE THEN
    RETURN NULL;
  END IF;
  RETURN public.resolve_character_media_preview_path_before_wp01_5(
    _actor_user_id, _target_kind, _target_id
  );
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_character_media_preview_path_for_server(UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_character_media_preview_path_for_server(UUID, TEXT, UUID)
  TO service_role;

ALTER FUNCTION public.resolve_sticker_object_path_for_server(UUID, UUID)
  RENAME TO resolve_sticker_object_path_before_wp01_5;
REVOKE ALL ON FUNCTION public.resolve_sticker_object_path_before_wp01_5(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.resolve_sticker_object_path_for_server(
  _actor_user_id UUID, _message_sticker_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
DECLARE _conversation_id UUID;
BEGIN
  SELECT m.conversation_id INTO _conversation_id
  FROM public.message_stickers ms JOIN public.messages m ON m.id = ms.message_id
  WHERE ms.id = _message_sticker_id;
  IF private.can_user_read_conversation(_conversation_id, _actor_user_id) IS NOT TRUE THEN
    RETURN NULL;
  END IF;
  RETURN public.resolve_sticker_object_path_before_wp01_5(_actor_user_id, _message_sticker_id);
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_sticker_object_path_for_server(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_sticker_object_path_for_server(UUID, UUID) TO service_role;

ALTER FUNCTION public.resolve_conversation_sticker_object_path_for_server(UUID, UUID, UUID)
  RENAME TO resolve_conversation_sticker_object_path_before_wp01_5;
REVOKE ALL ON FUNCTION public.resolve_conversation_sticker_object_path_before_wp01_5(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.resolve_conversation_sticker_object_path_for_server(
  _actor_user_id UUID, _conversation_id UUID, _sticker_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF private.can_user_read_conversation(_conversation_id, _actor_user_id) IS NOT TRUE THEN
    RETURN NULL;
  END IF;
  RETURN public.resolve_conversation_sticker_object_path_before_wp01_5(
    _actor_user_id, _conversation_id, _sticker_id
  );
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_conversation_sticker_object_path_for_server(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_conversation_sticker_object_path_for_server(UUID, UUID, UUID)
  TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      AND tablename = 'user_conversation_access_versions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_conversation_access_versions;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      AND tablename = 'conversation_presence_states'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.conversation_presence_states;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
