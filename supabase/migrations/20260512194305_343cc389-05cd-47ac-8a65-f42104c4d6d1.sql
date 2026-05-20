
-- ============================================
-- 1. ENUMS
-- ============================================
CREATE TYPE public.app_role AS ENUM ('client', 'operator', 'admin');
CREATE TYPE public.availability_status AS ENUM ('available', 'busy', 'offline');
CREATE TYPE public.conversation_status AS ENUM ('open', 'waiting', 'answered', 'closed', 'reported');
CREATE TYPE public.sender_type AS ENUM ('client', 'operator', 'admin');
CREATE TYPE public.report_status AS ENUM ('open', 'reviewed', 'resolved', 'dismissed');

-- ============================================
-- 2. TABLES
-- ============================================

-- Profiles (basic user info)
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  email TEXT,
  avatar_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User roles (separate table to prevent privilege escalation)
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

-- Client profiles
CREATE TABLE public.client_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  age INT,
  gender TEXT,
  interests TEXT[] DEFAULT '{}',
  conversation_preferences TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Operators
CREATE TABLE public.operators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  availability_status availability_status NOT NULL DEFAULT 'available',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Characters
CREATE TABLE public.characters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  fictional_age INT,
  short_description TEXT,
  full_description TEXT,
  personality TEXT,
  interests TEXT[] DEFAULT '{}',
  category TEXT,
  avatar_url TEXT,
  gallery_images TEXT[] DEFAULT '{}',
  availability_status availability_status NOT NULL DEFAULT 'available',
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_visible BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Character <-> Operator assignments
CREATE TABLE public.character_operator_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id UUID NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  operator_id UUID NOT NULL REFERENCES public.operators(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (character_id, operator_id)
);

-- Conversations
CREATE TABLE public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  character_id UUID NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  assigned_operator_id UUID REFERENCES public.operators(id) ON DELETE SET NULL,
  status conversation_status NOT NULL DEFAULT 'open',
  last_message_at TIMESTAMPTZ,
  last_message_preview TEXT,
  client_unread_count INT NOT NULL DEFAULT 0,
  operator_unread_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversations_client ON public.conversations(client_id);
CREATE INDEX idx_conversations_operator ON public.conversations(assigned_operator_id);
CREATE INDEX idx_conversations_character ON public.conversations(character_id);
CREATE INDEX idx_conversations_status ON public.conversations(status);

-- Messages
CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_type sender_type NOT NULL,
  sender_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  content TEXT NOT NULL CHECK (char_length(content) > 0 AND char_length(content) <= 2000),
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_conversation ON public.messages(conversation_id, created_at);

-- Internal notes
CREATE TABLE public.internal_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  operator_id UUID REFERENCES public.operators(id) ON DELETE SET NULL,
  note TEXT NOT NULL CHECK (char_length(note) > 0 AND char_length(note) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_internal_notes_conversation ON public.internal_notes(conversation_id);

-- Reports
CREATE TABLE public.reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  details TEXT,
  status report_status NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- System settings
CREATE TABLE public.system_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  value JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- 3. HELPER FUNCTIONS (SECURITY DEFINER)
-- ============================================

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  );
$$;

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS app_role
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.user_roles
  WHERE user_id = auth.uid()
  ORDER BY CASE role
    WHEN 'admin' THEN 1
    WHEN 'operator' THEN 2
    WHEN 'client' THEN 3
  END
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT public.has_role(auth.uid(), 'admin'); $$;

CREATE OR REPLACE FUNCTION public.is_operator()
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT public.has_role(auth.uid(), 'operator'); $$;

CREATE OR REPLACE FUNCTION public.get_my_operator_id()
RETURNS UUID
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT id FROM public.operators WHERE user_id = auth.uid() LIMIT 1; $$;

CREATE OR REPLACE FUNCTION public.is_conversation_client(_conversation_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversations
    WHERE id = _conversation_id AND client_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_conversation_operator(_conversation_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversations c
    JOIN public.operators o ON o.id = c.assigned_operator_id
    WHERE c.id = _conversation_id AND o.user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.operator_can_access_character(_character_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.character_operator_assignments coa
    JOIN public.operators o ON o.id = coa.operator_id
    WHERE coa.character_id = _character_id AND o.user_id = auth.uid()
  );
$$;

-- ============================================
-- 4. TRIGGERS
-- ============================================

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER set_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER set_client_profiles_updated_at BEFORE UPDATE ON public.client_profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER set_operators_updated_at BEFORE UPDATE ON public.operators FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER set_characters_updated_at BEFORE UPDATE ON public.characters FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER set_conversations_updated_at BEFORE UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER set_reports_updated_at BEFORE UPDATE ON public.reports FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- handle_new_user — create profile + default client role on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1))
  );

  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'client');

  INSERT INTO public.client_profiles (user_id) VALUES (NEW.id);

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- After insert message — update conversation
CREATE OR REPLACE FUNCTION public.handle_new_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sender_type = 'client' THEN
    UPDATE public.conversations
    SET last_message_at = NEW.created_at,
        last_message_preview = LEFT(NEW.content, 200),
        operator_unread_count = operator_unread_count + 1,
        status = CASE WHEN status = 'closed' THEN 'open' ELSE 'waiting' END,
        updated_at = now()
    WHERE id = NEW.conversation_id;
  ELSIF NEW.sender_type = 'operator' THEN
    UPDATE public.conversations
    SET last_message_at = NEW.created_at,
        last_message_preview = LEFT(NEW.content, 200),
        client_unread_count = client_unread_count + 1,
        status = 'answered',
        updated_at = now()
    WHERE id = NEW.conversation_id;
  ELSE
    UPDATE public.conversations
    SET last_message_at = NEW.created_at,
        last_message_preview = LEFT(NEW.content, 200),
        updated_at = now()
    WHERE id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_message_created
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_message();

-- ============================================
-- 5. RPC: start_or_get_conversation
-- ============================================
CREATE OR REPLACE FUNCTION public.start_or_get_conversation(_character_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _client UUID := auth.uid();
  _conv_id UUID;
  _operator UUID;
  _char_active BOOLEAN;
BEGIN
  IF _client IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT (is_active AND is_visible) INTO _char_active FROM public.characters WHERE id = _character_id;
  IF _char_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Character not available';
  END IF;

  -- Existing open conversation?
  SELECT id INTO _conv_id
  FROM public.conversations
  WHERE client_id = _client AND character_id = _character_id
    AND status <> 'closed'
  ORDER BY created_at DESC LIMIT 1;

  IF _conv_id IS NOT NULL THEN
    RETURN _conv_id;
  END IF;

  -- Find operator with fewest open conversations
  SELECT o.id INTO _operator
  FROM public.operators o
  JOIN public.character_operator_assignments coa ON coa.operator_id = o.id
  WHERE coa.character_id = _character_id AND o.is_active = true
  ORDER BY o.availability_status = 'available' DESC,
           (SELECT COUNT(*) FROM public.conversations c
              WHERE c.assigned_operator_id = o.id AND c.status <> 'closed') ASC
  LIMIT 1;

  INSERT INTO public.conversations (client_id, character_id, assigned_operator_id, status)
  VALUES (_client, _character_id, _operator, CASE WHEN _operator IS NULL THEN 'waiting'::conversation_status ELSE 'open'::conversation_status END)
  RETURNING id INTO _conv_id;

  RETURN _conv_id;
END;
$$;

-- Mark messages read
CREATE OR REPLACE FUNCTION public.mark_conversation_read(_conversation_id UUID, _as TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _as = 'client' AND public.is_conversation_client(_conversation_id) THEN
    UPDATE public.conversations SET client_unread_count = 0 WHERE id = _conversation_id;
    UPDATE public.messages SET is_read = true
      WHERE conversation_id = _conversation_id AND sender_type <> 'client';
  ELSIF _as = 'operator' AND (public.is_conversation_operator(_conversation_id) OR public.is_admin()) THEN
    UPDATE public.conversations SET operator_unread_count = 0 WHERE id = _conversation_id;
    UPDATE public.messages SET is_read = true
      WHERE conversation_id = _conversation_id AND sender_type = 'client';
  END IF;
END;
$$;

-- ============================================
-- 6. ENABLE RLS
-- ============================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.character_operator_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.internal_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

-- ============================================
-- 7. RLS POLICIES
-- ============================================

-- profiles
CREATE POLICY "Users view own profile" ON public.profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Admins view all profiles" ON public.profiles FOR SELECT USING (public.is_admin());
CREATE POLICY "Admins update all profiles" ON public.profiles FOR UPDATE USING (public.is_admin());
CREATE POLICY "Admins insert profiles" ON public.profiles FOR INSERT WITH CHECK (public.is_admin());
CREATE POLICY "Operators view client profiles in their conversations" ON public.profiles FOR SELECT
  USING (public.is_operator() AND EXISTS (
    SELECT 1 FROM public.conversations c
    JOIN public.operators o ON o.id = c.assigned_operator_id
    WHERE c.client_id = profiles.user_id AND o.user_id = auth.uid()
  ));

-- user_roles (only admins manage; users see own roles)
CREATE POLICY "Users see own roles" ON public.user_roles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Admins manage roles" ON public.user_roles FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- client_profiles
CREATE POLICY "Clients view own client_profile" ON public.client_profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Clients update own client_profile" ON public.client_profiles FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Clients insert own client_profile" ON public.client_profiles FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Admins view all client_profiles" ON public.client_profiles FOR SELECT USING (public.is_admin());
CREATE POLICY "Operators view client_profile for own conversations" ON public.client_profiles FOR SELECT
  USING (public.is_operator() AND EXISTS (
    SELECT 1 FROM public.conversations c
    JOIN public.operators o ON o.id = c.assigned_operator_id
    WHERE c.client_id = client_profiles.user_id AND o.user_id = auth.uid()
  ));

-- operators
CREATE POLICY "Operators view self" ON public.operators FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Operators update self" ON public.operators FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Admins manage operators" ON public.operators FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- characters
CREATE POLICY "Public view active characters" ON public.characters FOR SELECT USING (is_active = true AND is_visible = true);
CREATE POLICY "Operators view assigned characters" ON public.characters FOR SELECT
  USING (public.is_operator() AND public.operator_can_access_character(id));
CREATE POLICY "Admins manage characters" ON public.characters FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- character_operator_assignments
CREATE POLICY "Operators view own assignments" ON public.character_operator_assignments FOR SELECT
  USING (operator_id = public.get_my_operator_id());
CREATE POLICY "Admins manage assignments" ON public.character_operator_assignments FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- conversations
CREATE POLICY "Clients view own conversations" ON public.conversations FOR SELECT USING (auth.uid() = client_id);
CREATE POLICY "Operators view assigned conversations" ON public.conversations FOR SELECT
  USING (assigned_operator_id = public.get_my_operator_id());
CREATE POLICY "Operators update assigned conversations" ON public.conversations FOR UPDATE
  USING (assigned_operator_id = public.get_my_operator_id());
CREATE POLICY "Admins manage conversations" ON public.conversations FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());
-- Note: clients create conversations only via start_or_get_conversation RPC (SECURITY DEFINER)

-- messages
CREATE POLICY "Clients view messages in own conversations" ON public.messages FOR SELECT
  USING (public.is_conversation_client(conversation_id));
CREATE POLICY "Operators view messages in assigned conversations" ON public.messages FOR SELECT
  USING (public.is_conversation_operator(conversation_id));
CREATE POLICY "Admins view all messages" ON public.messages FOR SELECT USING (public.is_admin());

CREATE POLICY "Clients send messages in own conversations" ON public.messages FOR INSERT
  WITH CHECK (
    sender_type = 'client'
    AND sender_id = auth.uid()
    AND public.is_conversation_client(conversation_id)
  );
CREATE POLICY "Operators send messages in assigned conversations" ON public.messages FOR INSERT
  WITH CHECK (
    sender_type = 'operator'
    AND sender_id = auth.uid()
    AND public.is_conversation_operator(conversation_id)
  );
CREATE POLICY "Admins send messages" ON public.messages FOR INSERT
  WITH CHECK (public.is_admin() AND sender_id = auth.uid());

-- internal_notes
CREATE POLICY "Operators view notes in assigned conversations" ON public.internal_notes FOR SELECT
  USING (public.is_conversation_operator(conversation_id));
CREATE POLICY "Operators insert notes in assigned conversations" ON public.internal_notes FOR INSERT
  WITH CHECK (public.is_conversation_operator(conversation_id) AND operator_id = public.get_my_operator_id());
CREATE POLICY "Admins view all notes" ON public.internal_notes FOR SELECT USING (public.is_admin());

-- reports
CREATE POLICY "Clients create own reports" ON public.reports FOR INSERT WITH CHECK (auth.uid() = reporter_id);
CREATE POLICY "Clients view own reports" ON public.reports FOR SELECT USING (auth.uid() = reporter_id);
CREATE POLICY "Admins manage reports" ON public.reports FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- system_settings
CREATE POLICY "Public read settings" ON public.system_settings FOR SELECT USING (true);
CREATE POLICY "Admins manage settings" ON public.system_settings FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ============================================
-- 8. STORAGE BUCKETS
-- ============================================
INSERT INTO storage.buckets (id, name, public) VALUES ('character-avatars', 'character-avatars', true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('user-avatars', 'user-avatars', true)
ON CONFLICT (id) DO NOTHING;

-- character-avatars: public read, admin write
CREATE POLICY "Public read character avatars" ON storage.objects FOR SELECT USING (bucket_id = 'character-avatars');
CREATE POLICY "Admins write character avatars" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'character-avatars' AND public.is_admin());
CREATE POLICY "Admins update character avatars" ON storage.objects FOR UPDATE
  USING (bucket_id = 'character-avatars' AND public.is_admin());
CREATE POLICY "Admins delete character avatars" ON storage.objects FOR DELETE
  USING (bucket_id = 'character-avatars' AND public.is_admin());

-- user-avatars: public read, user writes own folder
CREATE POLICY "Public read user avatars" ON storage.objects FOR SELECT USING (bucket_id = 'user-avatars');
CREATE POLICY "Users upload own avatar" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'user-avatars' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users update own avatar" ON storage.objects FOR UPDATE
  USING (bucket_id = 'user-avatars' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users delete own avatar" ON storage.objects FOR DELETE
  USING (bucket_id = 'user-avatars' AND auth.uid()::text = (storage.foldername(name))[1]);

-- ============================================
-- 9. REALTIME
-- ============================================
ALTER TABLE public.conversations REPLICA IDENTITY FULL;
ALTER TABLE public.messages REPLICA IDENTITY FULL;
ALTER TABLE public.internal_notes REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.internal_notes;

-- ============================================
-- 10. SEED settings
-- ============================================
INSERT INTO public.system_settings (key, value) VALUES
  ('minimum_age', '18'::jsonb),
  ('require_age_confirmation', 'true'::jsonb),
  ('site_name', '"Character Chat OS"'::jsonb)
ON CONFLICT (key) DO NOTHING;
