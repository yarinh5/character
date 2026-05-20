
-- =========================
-- INVITES (operator invites)
-- =========================
CREATE TABLE IF NOT EXISTS public.invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  character_ids UUID[] NOT NULL DEFAULT '{}',
  token_hash TEXT NOT NULL UNIQUE,
  invited_by UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | revoked | expired
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days'),
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invites_email ON public.invites(email);
CREATE INDEX IF NOT EXISTS idx_invites_status ON public.invites(status);

ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage invites"
  ON public.invites FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE TRIGGER trg_invites_updated_at
  BEFORE UPDATE ON public.invites
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =========================
-- AUDIT LOGS
-- =========================
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON public.audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON public.audit_logs(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON public.audit_logs(action);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins view audit logs"
  ON public.audit_logs FOR SELECT
  USING (public.is_admin());

-- =========================
-- NOTIFICATIONS
-- =========================
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  type TEXT NOT NULL, -- new_conversation | new_message | new_report | invite_pending | system
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON public.notifications(user_id, is_read, created_at DESC);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own notifications"
  ON public.notifications FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users update own notifications"
  ON public.notifications FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Admins view all notifications"
  ON public.notifications FOR SELECT
  USING (public.is_admin());

-- Trigger: notify operator on new client message
CREATE OR REPLACE FUNCTION public.notify_on_new_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _op_user UUID;
  _client_user UUID;
BEGIN
  IF NEW.sender_type = 'client' THEN
    SELECT o.user_id INTO _op_user
    FROM conversations c
    JOIN operators o ON o.id = c.assigned_operator_id
    WHERE c.id = NEW.conversation_id;

    IF _op_user IS NOT NULL THEN
      INSERT INTO notifications(user_id, type, title, body, link)
      VALUES (_op_user, 'new_message', 'הודעה חדשה', LEFT(NEW.content, 120),
              '/operator/chat/' || NEW.conversation_id::text);
    END IF;
  ELSIF NEW.sender_type = 'operator' THEN
    SELECT c.client_id INTO _client_user FROM conversations c WHERE c.id = NEW.conversation_id;
    IF _client_user IS NOT NULL THEN
      INSERT INTO notifications(user_id, type, title, body, link)
      VALUES (_client_user, 'new_message', 'הודעה חדשה', LEFT(NEW.content, 120),
              '/app/chat/' || NEW.conversation_id::text);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_new_message ON public.messages;
CREATE TRIGGER trg_notify_new_message
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_new_message();

-- Trigger: notify all admins on new report
CREATE OR REPLACE FUNCTION public.notify_on_new_report()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _admin RECORD;
BEGIN
  FOR _admin IN SELECT user_id FROM user_roles WHERE role = 'admin' LOOP
    INSERT INTO notifications(user_id, type, title, body, link)
    VALUES (_admin.user_id, 'new_report', 'דיווח חדש',
            COALESCE(NEW.reason, ''), '/admin/reports');
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_new_report ON public.reports;
CREATE TRIGGER trg_notify_new_report
  AFTER INSERT ON public.reports
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_new_report();

-- =========================
-- STORAGE POLICIES
-- =========================
-- character-avatars (public bucket) — admins only write
DO $$ BEGIN
  CREATE POLICY "Public read character avatars"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'character-avatars');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Admins write character avatars"
    ON storage.objects FOR INSERT
    WITH CHECK (bucket_id = 'character-avatars' AND public.is_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Admins update character avatars"
    ON storage.objects FOR UPDATE
    USING (bucket_id = 'character-avatars' AND public.is_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Admins delete character avatars"
    ON storage.objects FOR DELETE
    USING (bucket_id = 'character-avatars' AND public.is_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- user-avatars (public bucket) — users own their folder by user_id
DO $$ BEGIN
  CREATE POLICY "Public read user avatars"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'user-avatars');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users upload own avatar"
    ON storage.objects FOR INSERT
    WITH CHECK (bucket_id = 'user-avatars' AND auth.uid()::text = (storage.foldername(name))[1]);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users update own avatar"
    ON storage.objects FOR UPDATE
    USING (bucket_id = 'user-avatars' AND auth.uid()::text = (storage.foldername(name))[1]);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users delete own avatar"
    ON storage.objects FOR DELETE
    USING (bucket_id = 'user-avatars' AND auth.uid()::text = (storage.foldername(name))[1]);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Enable realtime for notifications
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
