-- Phase 2D: Analytics Events Foundation.
-- Append-only event collection for future analytics. No BI UI or core logic changes.

CREATE TABLE IF NOT EXISTS public.analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name TEXT NOT NULL CHECK (event_name ~ '^[a-z0-9_]+$'),
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  role public.app_role,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  character_id UUID REFERENCES public.characters(id) ON DELETE SET NULL,
  operator_id UUID REFERENCES public.operators(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_name_created
  ON public.analytics_events(event_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_events_actor_created
  ON public.analytics_events(actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_events_conversation_created
  ON public.analytics_events(conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_analytics_events_character_created
  ON public.analytics_events(character_id, created_at DESC)
  WHERE character_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_analytics_events_operator_created
  ON public.analytics_events(operator_id, created_at DESC)
  WHERE operator_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_first_message_once
  ON public.analytics_events(conversation_id, actor_user_id, event_name)
  WHERE event_name = 'first_message_sent'
    AND conversation_id IS NOT NULL
    AND actor_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_onboarding_once
  ON public.analytics_events(actor_user_id, event_name)
  WHERE event_name = 'onboarding_completed'
    AND actor_user_id IS NOT NULL;

ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.analytics_events FROM anon, authenticated;
GRANT SELECT ON public.analytics_events TO authenticated;

DO $$ BEGIN
  CREATE POLICY "Admins read analytics events"
    ON public.analytics_events FOR SELECT
    USING (public.is_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION private.analytics_role_for_user(_user_id UUID)
RETURNS public.app_role
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role
  FROM public.user_roles
  WHERE user_id = _user_id
  ORDER BY CASE role
    WHEN 'admin' THEN 1
    WHEN 'operator' THEN 2
    WHEN 'client' THEN 3
  END
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION private.create_analytics_event(
  _event_name TEXT,
  _actor_user_id UUID DEFAULT NULL,
  _role public.app_role DEFAULT NULL,
  _conversation_id UUID DEFAULT NULL,
  _character_id UUID DEFAULT NULL,
  _operator_id UUID DEFAULT NULL,
  _metadata JSONB DEFAULT '{}'::jsonb,
  _dedupe_seconds INTEGER DEFAULT 0
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  _existing_id UUID;
  _event_id UUID;
  _resolved_role public.app_role;
  _window_seconds INTEGER := GREATEST(COALESCE(_dedupe_seconds, 0), 0);
BEGIN
  IF _event_name IS NULL OR _event_name !~ '^[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'invalid_event_name';
  END IF;

  _resolved_role := COALESCE(_role, private.analytics_role_for_user(_actor_user_id));

  IF _window_seconds > 0 THEN
    SELECT id
    INTO _existing_id
    FROM public.analytics_events
    WHERE event_name = _event_name
      AND actor_user_id IS NOT DISTINCT FROM _actor_user_id
      AND conversation_id IS NOT DISTINCT FROM _conversation_id
      AND character_id IS NOT DISTINCT FROM _character_id
      AND operator_id IS NOT DISTINCT FROM _operator_id
      AND created_at >= clock_timestamp() - make_interval(secs => _window_seconds)
    ORDER BY created_at DESC
    LIMIT 1;

    IF _existing_id IS NOT NULL THEN
      RETURN _existing_id;
    END IF;
  END IF;

  INSERT INTO public.analytics_events (
    event_name,
    actor_user_id,
    role,
    conversation_id,
    character_id,
    operator_id,
    metadata,
    created_at
  )
  VALUES (
    _event_name,
    _actor_user_id,
    _resolved_role,
    _conversation_id,
    _character_id,
    _operator_id,
    COALESCE(_metadata, '{}'::jsonb),
    clock_timestamp()
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO _event_id;

  IF _event_id IS NULL THEN
    SELECT id
    INTO _event_id
    FROM public.analytics_events
    WHERE event_name = _event_name
      AND actor_user_id IS NOT DISTINCT FROM _actor_user_id
      AND conversation_id IS NOT DISTINCT FROM _conversation_id
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;

  RETURN _event_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.track_analytics_event(
  _event_name TEXT,
  _metadata JSONB DEFAULT '{}'::jsonb,
  _conversation_id UUID DEFAULT NULL,
  _character_id UUID DEFAULT NULL,
  _operator_id UUID DEFAULT NULL,
  _dedupe_seconds INTEGER DEFAULT 0
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _role public.app_role;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF _event_name NOT IN (
    'character_viewed',
    'insufficient_credits_shown',
    'packages_viewed'
  ) THEN
    RAISE EXCEPTION 'analytics_event_not_allowed';
  END IF;

  _role := private.analytics_role_for_user(_user_id);

  IF _conversation_id IS NOT NULL AND NOT (
    public.is_admin()
    OR public.is_conversation_client(_conversation_id)
    OR EXISTS (
      SELECT 1
      FROM public.conversations c
      JOIN public.character_operator_assignments coa ON coa.character_id = c.character_id
      JOIN public.operators o ON o.id = coa.operator_id
      WHERE c.id = _conversation_id
        AND o.user_id = _user_id
        AND o.is_active = true
    )
  ) THEN
    RAISE EXCEPTION 'analytics_context_denied';
  END IF;

  IF _character_id IS NOT NULL AND _conversation_id IS NULL AND NOT (
    public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.characters c
      WHERE c.id = _character_id
        AND c.is_active = true
        AND c.is_visible = true
    )
    OR EXISTS (
      SELECT 1
      FROM public.character_operator_assignments coa
      JOIN public.operators o ON o.id = coa.operator_id
      WHERE coa.character_id = _character_id
        AND o.user_id = _user_id
        AND o.is_active = true
    )
  ) THEN
    RAISE EXCEPTION 'analytics_context_denied';
  END IF;

  IF _operator_id IS NOT NULL AND NOT (
    public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.operators o
      WHERE o.id = _operator_id
        AND o.user_id = _user_id
    )
  ) THEN
    RAISE EXCEPTION 'analytics_context_denied';
  END IF;

  RETURN private.create_analytics_event(
    _event_name,
    _user_id,
    _role,
    _conversation_id,
    _character_id,
    _operator_id,
    _metadata,
    _dedupe_seconds
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_analytics_signup_completed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
BEGIN
  PERFORM private.create_analytics_event(
    'signup_completed',
    NEW.user_id,
    'client'::public.app_role,
    NULL,
    NULL,
    NULL,
    jsonb_build_object('profile_id', NEW.id),
    0
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_analytics_signup_completed ON public.profiles;
CREATE TRIGGER trg_analytics_signup_completed
  AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.notify_analytics_signup_completed();

CREATE OR REPLACE FUNCTION private.client_onboarding_complete(_profile public.client_profiles)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
SET search_path = public, private
AS $$
  SELECT
    _profile.age IS NOT NULL
    AND COALESCE(_profile.gender, '') <> ''
    AND COALESCE(array_length(_profile.interests, 1), 0) > 0;
$$;

CREATE OR REPLACE FUNCTION public.notify_analytics_onboarding_completed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
BEGIN
  IF private.client_onboarding_complete(NEW) THEN
    PERFORM private.create_analytics_event(
      'onboarding_completed',
      NEW.user_id,
      'client'::public.app_role,
      NULL,
      NULL,
      NULL,
      jsonb_build_object('client_profile_id', NEW.id),
      0
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_analytics_onboarding_completed ON public.client_profiles;
CREATE TRIGGER trg_analytics_onboarding_completed
  AFTER INSERT OR UPDATE ON public.client_profiles
  FOR EACH ROW EXECUTE FUNCTION public.notify_analytics_onboarding_completed();

CREATE OR REPLACE FUNCTION public.notify_analytics_conversation_started()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
BEGIN
  PERFORM private.create_analytics_event(
    'conversation_started',
    NEW.client_id,
    'client'::public.app_role,
    NEW.id,
    NEW.character_id,
    NEW.assigned_operator_id,
    jsonb_build_object('status', NEW.status, 'source', 'conversations_insert'),
    0
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_analytics_conversation_started ON public.conversations;
CREATE TRIGGER trg_analytics_conversation_started
  AFTER INSERT ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.notify_analytics_conversation_started();

CREATE OR REPLACE FUNCTION public.notify_analytics_message_sent()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  _conversation public.conversations%ROWTYPE;
  _client_message_count INTEGER;
BEGIN
  SELECT *
  INTO _conversation
  FROM public.conversations
  WHERE id = NEW.conversation_id;

  IF NEW.sender_type = 'client'::public.sender_type THEN
    PERFORM private.create_analytics_event(
      'client_message_sent',
      NEW.sender_id,
      'client'::public.app_role,
      NEW.conversation_id,
      _conversation.character_id,
      NULL,
      jsonb_build_object('message_id', NEW.id, 'content_length', char_length(NEW.content)),
      0
    );

    SELECT COUNT(*)::integer
    INTO _client_message_count
    FROM public.messages
    WHERE conversation_id = NEW.conversation_id
      AND sender_type = 'client'::public.sender_type;

    IF _client_message_count = 1 THEN
      PERFORM private.create_analytics_event(
        'first_message_sent',
        NEW.sender_id,
        'client'::public.app_role,
        NEW.conversation_id,
        _conversation.character_id,
        NULL,
        jsonb_build_object('message_id', NEW.id),
        0
      );
    END IF;
  ELSIF NEW.sender_type = 'operator'::public.sender_type THEN
    PERFORM private.create_analytics_event(
      'operator_message_sent',
      NEW.sender_id,
      COALESCE(private.analytics_role_for_user(NEW.sender_id), 'operator'::public.app_role),
      NEW.conversation_id,
      _conversation.character_id,
      NEW.operator_id,
      jsonb_build_object('message_id', NEW.id, 'content_length', char_length(NEW.content)),
      0
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_analytics_message_sent ON public.messages;
CREATE TRIGGER trg_analytics_message_sent
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.notify_analytics_message_sent();

CREATE OR REPLACE FUNCTION public.notify_analytics_report_created()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  _character_id UUID;
BEGIN
  SELECT character_id
  INTO _character_id
  FROM public.conversations
  WHERE id = NEW.conversation_id;

  PERFORM private.create_analytics_event(
    'report_created',
    NEW.reporter_id,
    private.analytics_role_for_user(NEW.reporter_id),
    NEW.conversation_id,
    _character_id,
    NULL,
    jsonb_build_object('report_id', NEW.id, 'reason', NEW.reason),
    0
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_analytics_report_created ON public.reports;
CREATE TRIGGER trg_analytics_report_created
  AFTER INSERT ON public.reports
  FOR EACH ROW EXECUTE FUNCTION public.notify_analytics_report_created();

CREATE OR REPLACE FUNCTION public.notify_analytics_low_credits()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
BEGIN
  IF NEW.balance BETWEEN 0 AND 2
    AND (OLD.balance IS NULL OR OLD.balance > 2 OR OLD.balance IS DISTINCT FROM NEW.balance) THEN
    PERFORM private.create_analytics_event(
      'low_credits_reached',
      NEW.user_id,
      'client'::public.app_role,
      NULL,
      NULL,
      NULL,
      jsonb_build_object('balance', NEW.balance),
      86400
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_analytics_low_credits ON public.credit_wallets;
CREATE TRIGGER trg_analytics_low_credits
  AFTER UPDATE OF balance ON public.credit_wallets
  FOR EACH ROW EXECUTE FUNCTION public.notify_analytics_low_credits();

CREATE OR REPLACE FUNCTION public.notify_analytics_lock_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  _character_id UUID;
BEGIN
  SELECT character_id
  INTO _character_id
  FROM public.conversations
  WHERE id = NEW.conversation_id;

  IF TG_OP = 'INSERT'
    OR (
      TG_OP = 'UPDATE'
      AND NEW.released_at IS NULL
      AND (
        OLD.released_at IS NOT NULL
        OR OLD.locked_by_operator_id IS DISTINCT FROM NEW.locked_by_operator_id
        OR OLD.locked_at IS DISTINCT FROM NEW.locked_at
      )
    ) THEN
    PERFORM private.create_analytics_event(
      'lock_acquired',
      NEW.locked_by_user_id,
      COALESCE(private.analytics_role_for_user(NEW.locked_by_user_id), 'operator'::public.app_role),
      NEW.conversation_id,
      _character_id,
      NEW.locked_by_operator_id,
      jsonb_build_object('expires_at', NEW.expires_at),
      30
    );
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.released_at IS NOT NULL AND OLD.released_at IS NULL THEN
    PERFORM private.create_analytics_event(
      'lock_released',
      NEW.released_by_user_id,
      private.analytics_role_for_user(NEW.released_by_user_id),
      NEW.conversation_id,
      _character_id,
      NEW.locked_by_operator_id,
      jsonb_build_object('release_reason', NEW.release_reason),
      0
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_analytics_lock_event ON public.conversation_locks;
CREATE TRIGGER trg_analytics_lock_event
  AFTER INSERT OR UPDATE ON public.conversation_locks
  FOR EACH ROW EXECUTE FUNCTION public.notify_analytics_lock_event();

REVOKE EXECUTE ON FUNCTION private.analytics_role_for_user(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.create_analytics_event(TEXT, UUID, public.app_role, UUID, UUID, UUID, JSONB, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.client_onboarding_complete(public.client_profiles) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_analytics_signup_completed() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_analytics_onboarding_completed() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_analytics_conversation_started() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_analytics_message_sent() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_analytics_report_created() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_analytics_low_credits() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_analytics_lock_event() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.track_analytics_event(TEXT, JSONB, UUID, UUID, UUID, INTEGER) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.track_analytics_event(TEXT, JSONB, UUID, UUID, UUID, INTEGER) TO authenticated;
