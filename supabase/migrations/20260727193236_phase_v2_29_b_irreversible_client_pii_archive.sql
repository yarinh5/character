-- V2-29-B: irreversible client PII archive. Financial, moderation, and chat records remain intact.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS pii_archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pii_archived_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pii_archive_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_pii_archive_reason_check'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_pii_archive_reason_check
      CHECK (pii_archive_reason IS NULL OR char_length(btrim(pii_archive_reason)) BETWEEN 3 AND 500);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.ensure_active_client(_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_roles role
    JOIN public.profiles profile ON profile.user_id = role.user_id
    WHERE role.user_id = _user_id
      AND role.role = 'client'::public.app_role
      AND COALESCE(profile.status, 'active') = 'active'
      AND profile.deleted_at IS NULL
      AND profile.pii_archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'client_account_inactive';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.archive_client_pii(
  _client_id UUID,
  _reason TEXT,
  _confirm TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _actor_id UUID := auth.uid();
  _profile public.profiles%ROWTYPE;
  _reason_clean TEXT := btrim(COALESCE(_reason, ''));
  _archived_at TIMESTAMPTZ;
BEGIN
  IF _actor_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_required';
  END IF;
  IF _client_id IS NULL THEN
    RAISE EXCEPTION 'client_not_found';
  END IF;
  IF _client_id = _actor_id THEN
    RAISE EXCEPTION 'cannot_archive_own_account';
  END IF;
  IF _confirm <> 'ARCHIVE_CLIENT_PII' THEN
    RAISE EXCEPTION 'pii_archive_confirmation_required';
  END IF;
  IF char_length(_reason_clean) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'invalid_pii_archive_reason';
  END IF;

  SELECT * INTO _profile
  FROM public.profiles profile
  WHERE profile.user_id = _client_id
  FOR UPDATE;

  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM public.user_roles role
    WHERE role.user_id = _client_id
      AND role.role IN ('admin'::public.app_role, 'operator'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'client_not_found';
  END IF;

  IF _profile.pii_archived_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'archived', TRUE,
      'idempotent_replay', TRUE,
      'archived_at', _profile.pii_archived_at
    );
  END IF;

  UPDATE public.profiles
  SET display_name = 'לקוח בארכיון',
      email = NULL,
      avatar_url = NULL,
      status = 'archived',
      deleted_at = COALESCE(deleted_at, clock_timestamp()),
      pii_archived_at = clock_timestamp(),
      pii_archived_by = _actor_id,
      pii_archive_reason = _reason_clean,
      updated_at = clock_timestamp()
  WHERE user_id = _client_id
  RETURNING pii_archived_at INTO _archived_at;

  UPDATE public.client_profiles
  SET age = NULL,
      gender = NULL,
      interests = ARRAY[]::TEXT[],
      conversation_preferences = NULL,
      first_name = NULL,
      last_name = NULL,
      date_of_birth = NULL,
      computed_age = NULL,
      city_id = NULL,
      bio = NULL,
      relationship_status = NULL,
      smoking_status = NULL,
      preferred_min_age = NULL,
      preferred_max_age = NULL,
      preferred_distance_km = NULL,
      content_preferences = '[]'::JSONB,
      character_preferences = '[]'::JSONB,
      profile_image_url = NULL,
      profile_image_urls = ARRAY[]::TEXT[],
      updated_at = clock_timestamp()
  WHERE user_id = _client_id;

  UPDATE public.conversation_handling_cycles cycle
  SET ended_at = clock_timestamp(),
      end_reason = 'closed'
  FROM public.conversations conversation
  WHERE cycle.conversation_id = conversation.id
    AND conversation.client_id = _client_id
    AND cycle.ended_at IS NULL;

  UPDATE public.conversation_work_items
  SET status = 'closed',
      responsible_operator_id = NULL,
      assigned_at = NULL,
      updated_at = clock_timestamp()
  WHERE client_id = _client_id
    AND status IN ('new', 'assigned', 'in_progress');

  DELETE FROM public.client_character_preferences WHERE client_id = _client_id;
  DELETE FROM public.client_discovery_cycles WHERE client_id = _client_id;
  DELETE FROM public.client_conversation_deletions WHERE client_id = _client_id;
  DELETE FROM public.conversation_read_states WHERE user_id = _client_id;
  DELETE FROM public.user_active_conversations WHERE user_id = _client_id;
  DELETE FROM public.notifications WHERE user_id = _client_id;
  DELETE FROM public.notification_settings WHERE user_id = _client_id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _actor_id,
    'client.pii_archived',
    'user',
    _client_id::TEXT,
    jsonb_build_object('reason', _reason_clean, 'auth_user_preserved', TRUE, 'pii_redacted', TRUE)
  );

  RETURN jsonb_build_object(
    'archived', TRUE,
    'idempotent_replay', FALSE,
    'archived_at', _archived_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.send_client_sticker_message(
  _conversation_id UUID,
  _sticker_id UUID,
  _idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _client_id UUID := auth.uid();
BEGIN
  IF _client_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  PERFORM private.ensure_active_client(_client_id);
  RETURN private.send_sticker_message(_conversation_id, _sticker_id, _idempotency_key, 'client');
END;
$$;

CREATE OR REPLACE FUNCTION public.open_free_view_once_attachment(
  _attachment_id UUID,
  _idempotency_key UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _attachment public.message_attachments%ROWTYPE;
  _client_id UUID;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  PERFORM private.ensure_active_client(_user_id);
  SELECT attachment.*
  INTO _attachment
  FROM public.message_attachments attachment
  WHERE attachment.id = _attachment_id
  FOR UPDATE OF attachment;
  IF NOT FOUND THEN RAISE EXCEPTION 'message_attachment_not_available'; END IF;
  SELECT conversation.client_id INTO _client_id
  FROM public.messages message
  JOIN public.conversations conversation ON conversation.id = message.conversation_id
  WHERE message.id = _attachment.message_id;
  IF _client_id <> _user_id THEN RAISE EXCEPTION 'message_attachment_not_available'; END IF;
  IF _attachment.view_mode <> 'view_once' THEN RAISE EXCEPTION 'attachment_not_view_once'; END IF;
  IF _attachment.view_once_opened_at IS NOT NULL THEN RAISE EXCEPTION 'view_once_already_opened'; END IF;
  UPDATE public.message_attachments
  SET view_once_opened_at = clock_timestamp()
  WHERE id = _attachment.id
  RETURNING view_once_opened_at INTO _attachment.view_once_opened_at;
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_user_id, 'message_attachment.view_once_opened', 'message_attachment', _attachment.id::TEXT,
    jsonb_build_object('idempotency_key_present', _idempotency_key IS NOT NULL));
  RETURN jsonb_build_object('attachment_id', _attachment.id, 'render_state', 'view_once_opened');
END;
$$;

CREATE OR REPLACE FUNCTION public.save_client_onboarding_step(_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _client_id UUID := auth.uid();
BEGIN
  IF _client_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  PERFORM private.ensure_active_client(_client_id);
  RETURN private.apply_client_onboarding_payload(_payload, FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_client_onboarding(_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _client_id UUID := auth.uid();
BEGIN
  IF _client_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  PERFORM private.ensure_active_client(_client_id);
  RETURN private.apply_client_onboarding_payload(_payload, TRUE);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_operator_new_queue()
RETURNS TABLE (
  work_item_id UUID,
  conversation_id UUID,
  character_id UUID,
  status TEXT,
  queue_state TEXT,
  client_display_name TEXT,
  character_name TEXT,
  character_avatar_url TEXT,
  last_client_preview TEXT,
  last_activity_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _operator_id UUID;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT operator.id INTO _operator_id
  FROM public.operators operator
  WHERE operator.user_id = _user_id
    AND operator.is_active = TRUE
    AND operator.deleted_at IS NULL
  LIMIT 1;
  IF _operator_id IS NULL THEN RAISE EXCEPTION 'operator_record_required'; END IF;

  RETURN QUERY
  SELECT
    work_item.id,
    work_item.conversation_id,
    work_item.character_id,
    work_item.status,
    CASE
      WHEN last_cycle.end_reason IN ('released', 'reassigned', 'timeout')
        AND client_message.created_at <= last_cycle.ended_at THEN 'returned'
      ELSE 'new'
    END,
    profile.display_name,
    character.name,
    character.avatar_url,
    COALESCE(client_message.content, conversation.last_message_preview, ''),
    work_item.last_activity_at,
    work_item.created_at
  FROM public.conversation_work_items work_item
  JOIN public.conversations conversation ON conversation.id = work_item.conversation_id
  JOIN public.characters character ON character.id = work_item.character_id
  JOIN public.messages client_message ON client_message.id = work_item.last_client_message_id
  JOIN public.profiles profile ON profile.user_id = work_item.client_id
  LEFT JOIN LATERAL (
    SELECT cycle.end_reason, cycle.ended_at
    FROM public.conversation_handling_cycles cycle
    WHERE cycle.work_item_id = work_item.id AND cycle.ended_at IS NOT NULL
    ORDER BY cycle.ended_at DESC
    LIMIT 1
  ) last_cycle ON TRUE
  WHERE work_item.status = 'new'
    AND conversation.status <> 'closed'::public.conversation_status
    AND profile.status = 'active'
    AND profile.deleted_at IS NULL
    AND profile.pii_archived_at IS NULL
    AND client_message.sender_type = 'client'::public.sender_type
    AND NOT EXISTS (
      SELECT 1 FROM public.conversation_handling_cycles cycle
      WHERE cycle.work_item_id = work_item.id AND cycle.ended_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM public.character_operator_assignments assignment
      WHERE assignment.character_id = work_item.character_id
        AND assignment.operator_id = _operator_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.operator_client_blocks block
      WHERE block.operator_id = _operator_id AND block.client_id = work_item.client_id
    )
  ORDER BY work_item.last_activity_at DESC, work_item.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_message_attachment_view_url_ttl_for_server(
  _actor_user_id UUID,
  _attachment_id UUID
)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT CASE
    WHEN conversation.client_id = _actor_user_id
      AND NOT EXISTS (
        SELECT 1 FROM public.profiles profile
        WHERE profile.user_id = _actor_user_id
          AND profile.status = 'active'
          AND profile.deleted_at IS NULL
          AND profile.pii_archived_at IS NULL
      ) THEN NULL
    WHEN conversation.client_id = _actor_user_id AND attachment.view_mode = 'paid_open'
      AND EXISTS (
        SELECT 1 FROM private.message_attachment_open_sessions session
        WHERE session.attachment_id = attachment.id AND session.client_id = _actor_user_id
          AND session.status = 'opened' AND session.completed_at IS NULL AND session.expires_at > clock_timestamp()
      )
      THEN GREATEST(1, CEIL(EXTRACT(EPOCH FROM ((
        SELECT session.expires_at FROM private.message_attachment_open_sessions session
        WHERE session.attachment_id = attachment.id AND session.client_id = _actor_user_id
          AND session.status = 'opened' AND session.completed_at IS NULL AND session.expires_at > clock_timestamp()
        ORDER BY session.opened_at DESC, session.id DESC LIMIT 1
      ) - clock_timestamp())))::INTEGER)
    WHEN conversation.client_id = _actor_user_id AND attachment.view_mode = 'paid_open' THEN NULL
    WHEN conversation.client_id = _actor_user_id AND attachment.view_mode = 'view_once'
      AND attachment.view_once_opened_at IS NOT NULL AND attachment.view_once_completed_at IS NULL
      AND attachment.view_once_opened_at + interval '7 seconds' > clock_timestamp()
      THEN GREATEST(1, CEIL(EXTRACT(EPOCH FROM (attachment.view_once_opened_at + interval '7 seconds' - clock_timestamp())))::INTEGER)
    WHEN conversation.client_id = _actor_user_id AND attachment.view_mode = 'view_once' THEN NULL
    ELSE 60
  END
  FROM public.message_attachments attachment
  JOIN public.messages message ON message.id = attachment.message_id
  JOIN public.conversations conversation ON conversation.id = message.conversation_id
  WHERE attachment.id = _attachment_id;
$$;

DROP POLICY IF EXISTS "Users update own profile" ON public.profiles;
CREATE POLICY "Users update own active profile"
ON public.profiles FOR UPDATE TO public
USING (
  auth.uid() = user_id
  AND status = 'active'
  AND deleted_at IS NULL
  AND pii_archived_at IS NULL
)
WITH CHECK (
  auth.uid() = user_id
  AND status = 'active'
  AND deleted_at IS NULL
  AND pii_archived_at IS NULL
);

DROP POLICY IF EXISTS "Clients insert own client_profile" ON public.client_profiles;
CREATE POLICY "Clients insert own active client_profile"
ON public.client_profiles FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1 FROM public.profiles profile
    WHERE profile.user_id = client_profiles.user_id
      AND profile.status = 'active'
      AND profile.deleted_at IS NULL
      AND profile.pii_archived_at IS NULL
  )
);

DROP POLICY IF EXISTS "Clients update own client_profile" ON public.client_profiles;
CREATE POLICY "Clients update own active client_profile"
ON public.client_profiles FOR UPDATE TO authenticated
USING (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1 FROM public.profiles profile
    WHERE profile.user_id = client_profiles.user_id
      AND profile.status = 'active'
      AND profile.deleted_at IS NULL
      AND profile.pii_archived_at IS NULL
  )
)
WITH CHECK (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1 FROM public.profiles profile
    WHERE profile.user_id = client_profiles.user_id
      AND profile.status = 'active'
      AND profile.deleted_at IS NULL
      AND profile.pii_archived_at IS NULL
  )
);

REVOKE ALL ON FUNCTION private.ensure_active_client(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.ensure_active_client(UUID) TO service_role;
REVOKE ALL ON FUNCTION public.archive_client_pii(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.archive_client_pii(UUID, TEXT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.send_client_sticker_message(UUID, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_client_sticker_message(UUID, UUID, UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.open_free_view_once_attachment(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_free_view_once_attachment(UUID, UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.save_client_onboarding_step(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.complete_client_onboarding(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_client_onboarding_step(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_client_onboarding(JSONB) TO authenticated;
REVOKE ALL ON FUNCTION public.get_operator_new_queue() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_operator_new_queue() TO authenticated;

NOTIFY pgrst, 'reload schema';
