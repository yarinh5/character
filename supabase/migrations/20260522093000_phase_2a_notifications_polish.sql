-- Phase 2A: Notifications polish.
-- In-app notifications only. No email/push/SLA behavior is enabled here.

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES public.conversations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_notifications_dedupe
  ON public.notifications(user_id, type, conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.notification_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  in_app_enabled BOOLEAN NOT NULL DEFAULT true,
  email_enabled BOOLEAN NOT NULL DEFAULT false,
  new_message_enabled BOOLEAN NOT NULL DEFAULT true,
  new_report_enabled BOOLEAN NOT NULL DEFAULT true,
  credits_enabled BOOLEAN NOT NULL DEFAULT true,
  assignment_enabled BOOLEAN NOT NULL DEFAULT true,
  lock_enabled BOOLEAN NOT NULL DEFAULT true,
  system_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_active_conversations (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('client', 'operator', 'admin')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '45 seconds'),
  PRIMARY KEY (user_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_user_active_conversations_expires
  ON public.user_active_conversations(expires_at);

ALTER TABLE public.notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_active_conversations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.notification_settings FROM anon, authenticated;
REVOKE ALL ON public.user_active_conversations FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.notification_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_active_conversations TO authenticated;

DO $$ BEGIN
  CREATE POLICY "Users view own notification settings"
    ON public.notification_settings FOR SELECT
    USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users insert own notification settings"
    ON public.notification_settings FOR INSERT
    WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users update own notification settings"
    ON public.notification_settings FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Admins view all notification settings"
    ON public.notification_settings FOR SELECT
    USING (public.is_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users manage own active conversation"
    ON public.user_active_conversations FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Admins view active conversations"
    ON public.user_active_conversations FOR SELECT
    USING (public.is_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.touch_active_conversation(_conversation_id UUID, _role TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF _role NOT IN ('client', 'operator', 'admin') THEN
    RAISE EXCEPTION 'invalid_role';
  END IF;

  INSERT INTO public.user_active_conversations (user_id, conversation_id, role, last_seen_at, expires_at)
  VALUES (auth.uid(), _conversation_id, _role, clock_timestamp(), clock_timestamp() + interval '45 seconds')
  ON CONFLICT (user_id, conversation_id)
  DO UPDATE SET
    role = EXCLUDED.role,
    last_seen_at = EXCLUDED.last_seen_at,
    expires_at = EXCLUDED.expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.leave_active_conversation(_conversation_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  DELETE FROM public.user_active_conversations
  WHERE user_id = auth.uid()
    AND conversation_id = _conversation_id;
$$;

CREATE OR REPLACE FUNCTION private.notification_enabled(_user_id UUID, _type TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  _settings public.notification_settings%ROWTYPE;
BEGIN
  SELECT *
  INTO _settings
  FROM public.notification_settings
  WHERE user_id = _user_id;

  IF NOT FOUND THEN
    RETURN true;
  END IF;

  IF COALESCE(_settings.in_app_enabled, true) IS NOT TRUE THEN
    RETURN false;
  END IF;

  IF _type = 'new_message' THEN
    RETURN COALESCE(_settings.new_message_enabled, true);
  ELSIF _type = 'new_report' THEN
    RETURN COALESCE(_settings.new_report_enabled, true);
  ELSIF _type IN ('low_credits', 'credits_empty') THEN
    RETURN COALESCE(_settings.credits_enabled, true);
  ELSIF _type = 'character_assignment' THEN
    RETURN COALESCE(_settings.assignment_enabled, true);
  ELSIF _type = 'lock_released' THEN
    RETURN COALESCE(_settings.lock_enabled, true);
  ELSIF _type = 'system' THEN
    RETURN COALESCE(_settings.system_enabled, true);
  END IF;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_notification(
  _user_id UUID,
  _type TEXT,
  _title TEXT,
  _body TEXT DEFAULT NULL,
  _link TEXT DEFAULT NULL,
  _conversation_id UUID DEFAULT NULL,
  _metadata JSONB DEFAULT '{}'::jsonb,
  _dedupe_window_seconds INTEGER DEFAULT 120
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  _existing_id UUID;
  _new_id UUID;
  _window_seconds INTEGER := GREATEST(COALESCE(_dedupe_window_seconds, 120), 0);
BEGIN
  IF _user_id IS NULL OR _type IS NULL OR _title IS NULL THEN
    RETURN NULL;
  END IF;

  DELETE FROM public.user_active_conversations
  WHERE expires_at < clock_timestamp();

  IF _conversation_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.user_active_conversations active
    WHERE active.user_id = _user_id
      AND active.conversation_id = _conversation_id
      AND active.expires_at > clock_timestamp()
  ) THEN
    RETURN NULL;
  END IF;

  IF private.notification_enabled(_user_id, _type) IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  IF _window_seconds > 0 THEN
    SELECT id
    INTO _existing_id
    FROM public.notifications
    WHERE user_id = _user_id
      AND type = _type
      AND (
        (_conversation_id IS NULL AND conversation_id IS NULL)
        OR conversation_id = _conversation_id
      )
      AND created_at >= clock_timestamp() - make_interval(secs => _window_seconds)
    ORDER BY created_at DESC
    LIMIT 1;

    IF _existing_id IS NOT NULL THEN
      RETURN _existing_id;
    END IF;
  END IF;

  INSERT INTO public.notifications (user_id, type, title, body, link, conversation_id, metadata)
  VALUES (
    _user_id,
    _type,
    _title,
    NULLIF(_body, ''),
    NULLIF(_link, ''),
    _conversation_id,
    COALESCE(_metadata, '{}'::jsonb)
  )
  RETURNING id INTO _new_id;

  RETURN _new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_on_new_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  _client_user UUID;
  _character_id UUID;
  _operator RECORD;
BEGIN
  SELECT c.client_id, c.character_id
  INTO _client_user, _character_id
  FROM public.conversations c
  WHERE c.id = NEW.conversation_id;

  IF NEW.sender_type = 'client'::public.sender_type THEN
    FOR _operator IN
      SELECT DISTINCT o.user_id
      FROM public.character_operator_assignments coa
      JOIN public.operators o ON o.id = coa.operator_id
      WHERE coa.character_id = _character_id
        AND o.is_active = true
    LOOP
      IF _operator.user_id IS DISTINCT FROM NEW.sender_id THEN
        PERFORM public.create_notification(
          _operator.user_id,
          'new_message',
          'הודעה חדשה',
          LEFT(NEW.content, 120),
          '/operator/chat/' || NEW.conversation_id::text,
          NEW.conversation_id,
          jsonb_build_object('sender_type', NEW.sender_type, 'message_id', NEW.id),
          120
        );
      END IF;
    END LOOP;
  ELSIF NEW.sender_type = 'operator'::public.sender_type THEN
    IF _client_user IS NOT NULL THEN
      PERFORM public.create_notification(
        _client_user,
        'new_message',
        'הודעה חדשה',
        LEFT(NEW.content, 120),
        '/app/chat/' || NEW.conversation_id::text,
        NEW.conversation_id,
        jsonb_build_object('sender_type', NEW.sender_type, 'message_id', NEW.id, 'operator_id', NEW.operator_id),
        120
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_on_new_report()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  _admin RECORD;
BEGIN
  FOR _admin IN SELECT user_id FROM public.user_roles WHERE role = 'admin' LOOP
    PERFORM public.create_notification(
      _admin.user_id,
      'new_report',
      'דיווח חדש',
      COALESCE(NEW.reason, ''),
      '/admin/reports',
      NEW.conversation_id,
      jsonb_build_object('report_id', NEW.id),
      60
    );
  END LOOP;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_on_character_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  _operator_user UUID;
  _character_name TEXT;
BEGIN
  SELECT user_id INTO _operator_user
  FROM public.operators
  WHERE id = NEW.operator_id;

  SELECT name INTO _character_name
  FROM public.characters
  WHERE id = NEW.character_id;

  IF _operator_user IS NOT NULL THEN
    PERFORM public.create_notification(
      _operator_user,
      'character_assignment',
      'שיוך חדש לדמות',
      COALESCE(_character_name, 'דמות חדשה שויכה אליך'),
      '/operator/settings',
      NULL,
      jsonb_build_object('character_id', NEW.character_id, 'operator_id', NEW.operator_id),
      300
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_character_assignment ON public.character_operator_assignments;
CREATE TRIGGER trg_notify_character_assignment
  AFTER INSERT ON public.character_operator_assignments
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_character_assignment();

CREATE OR REPLACE FUNCTION public.notify_on_low_credits()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  _is_client BOOLEAN;
  _type TEXT;
  _title TEXT;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = NEW.user_id AND role = 'client'
  ) INTO _is_client;

  IF _is_client IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  IF NEW.balance = 0 AND OLD.balance IS DISTINCT FROM NEW.balance THEN
    _type := 'credits_empty';
    _title := 'הקרדיטים נגמרו';
  ELSIF NEW.balance BETWEEN 1 AND 2 AND (OLD.balance IS NULL OR OLD.balance > 2) THEN
    _type := 'low_credits';
    _title := 'יתרת קרדיטים נמוכה';
  ELSE
    RETURN NEW;
  END IF;

  PERFORM public.create_notification(
    NEW.user_id,
    _type,
    _title,
    'אפשר לצפות בחבילות כדי להמשיך לשלוח הודעות.',
    '/app/packages',
    NULL,
    jsonb_build_object('balance', NEW.balance),
    86400
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_low_credits ON public.credit_wallets;
CREATE TRIGGER trg_notify_low_credits
  AFTER UPDATE OF balance ON public.credit_wallets
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_low_credits();

CREATE OR REPLACE FUNCTION public.notify_on_lock_released()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
BEGIN
  IF NEW.released_at IS NOT NULL AND OLD.released_at IS NULL AND NEW.locked_by_user_id IS NOT NULL THEN
    PERFORM public.create_notification(
      NEW.locked_by_user_id,
      'lock_released',
      'נעילת שיחה שוחררה',
      'השיחה זמינה שוב לעבודה.',
      '/operator/chat/' || NEW.conversation_id::text,
      NEW.conversation_id,
      jsonb_build_object('release_reason', NEW.release_reason),
      120
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_lock_released ON public.conversation_locks;
CREATE TRIGGER trg_notify_lock_released
  AFTER UPDATE OF released_at ON public.conversation_locks
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_lock_released();

REVOKE EXECUTE ON FUNCTION private.notification_enabled(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.create_notification(UUID, TEXT, TEXT, TEXT, TEXT, UUID, JSONB, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_on_new_message() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_on_new_report() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_on_character_assignment() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_on_low_credits() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_on_lock_released() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.touch_active_conversation(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.leave_active_conversation(UUID) TO authenticated;
