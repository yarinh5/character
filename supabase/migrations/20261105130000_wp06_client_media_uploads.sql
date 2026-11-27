-- WP06: client-owned chat images. Access expires independently of physical
-- cleanup; the latter is a durable, retryable job contract and is not run here.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'client-media',
  'client-media',
  FALSE,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET public = FALSE,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE TABLE public.client_media_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE RESTRICT,
  bucket_id TEXT NOT NULL DEFAULT 'client-media' CHECK (bucket_id = 'client-media'),
  source_path TEXT NOT NULL UNIQUE,
  preview_path TEXT,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size BIGINT CHECK (byte_size IS NULL OR byte_size BETWEEN 1 AND 10485760),
  status TEXT NOT NULL DEFAULT 'pending_upload'
    CHECK (status IN ('pending_upload', 'processing', 'finalized', 'cleanup_pending', 'cleanup_in_progress', 'deleted', 'cleanup_failed')),
  upload_expires_at TIMESTAMPTZ NOT NULL,
  finalized_at TIMESTAMPTZ,
  access_expires_at TIMESTAMPTZ,
  message_id UUID UNIQUE REFERENCES public.messages(id) ON DELETE RESTRICT,
  message_attachment_id UUID UNIQUE,
  idempotency_key TEXT,
  finalize_claimed_at TIMESTAMPTZ,
  finalize_claim_token UUID,
  finalize_claim_expires_at TIMESTAMPTZ,
  cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_attempts >= 0),
  next_cleanup_at TIMESTAMPTZ,
  cleanup_claimed_at TIMESTAMPTZ,
  cleanup_claim_token UUID,
  cleanup_claim_expires_at TIMESTAMPTZ,
  cleanup_error_code TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT client_media_uploads_finalize_shape_check CHECK (
    (status IN ('pending_upload', 'processing')
      AND finalized_at IS NULL AND access_expires_at IS NULL
      AND message_id IS NULL AND message_attachment_id IS NULL)
    OR
    (status IN ('cleanup_in_progress', 'cleanup_failed', 'deleted')
      AND finalized_at IS NULL AND access_expires_at IS NULL
      AND message_id IS NULL AND message_attachment_id IS NULL)
    OR
    (status <> 'pending_upload'
      AND finalized_at IS NOT NULL AND access_expires_at IS NOT NULL
      AND message_id IS NOT NULL AND message_attachment_id IS NOT NULL)
  ),
  CONSTRAINT client_media_uploads_idempotency_shape_check CHECK (
    (finalized_at IS NULL AND idempotency_key IS NULL)
    OR (finalized_at IS NOT NULL AND NULLIF(btrim(idempotency_key), '') IS NOT NULL)
  ),
  CONSTRAINT client_media_uploads_cleanup_claim_shape_check CHECK (
    (status = 'cleanup_in_progress'
      AND cleanup_claimed_at IS NOT NULL
      AND cleanup_claim_token IS NOT NULL
      AND cleanup_claim_expires_at IS NOT NULL)
    OR
    (status <> 'cleanup_in_progress'
      AND cleanup_claimed_at IS NULL
      AND cleanup_claim_token IS NULL
      AND cleanup_claim_expires_at IS NULL)
  ),
  CONSTRAINT client_media_uploads_finalize_claim_shape_check CHECK (
    (status = 'processing'
      AND finalize_claimed_at IS NOT NULL
      AND finalize_claim_token IS NOT NULL
      AND finalize_claim_expires_at IS NOT NULL)
    OR
    (status <> 'processing'
      AND (
        (finalize_claimed_at IS NULL
          AND finalize_claim_token IS NULL
          AND finalize_claim_expires_at IS NULL)
        OR
        (finalized_at IS NULL
          AND status IN ('cleanup_in_progress', 'cleanup_failed', 'deleted')
          AND finalize_claimed_at IS NOT NULL
          AND finalize_claim_token IS NOT NULL
          AND finalize_claim_expires_at IS NOT NULL)
      ))
  )
);

CREATE UNIQUE INDEX client_media_uploads_client_idempotency_key
  ON public.client_media_uploads(client_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX client_media_uploads_cleanup_due_idx
  ON public.client_media_uploads(next_cleanup_at, created_at)
  WHERE status IN ('cleanup_pending', 'cleanup_failed');
CREATE INDEX client_media_uploads_abandoned_upload_idx
  ON public.client_media_uploads(upload_expires_at, created_at)
  WHERE status = 'pending_upload';
CREATE INDEX client_media_uploads_stale_claim_idx
  ON public.client_media_uploads(cleanup_claim_expires_at, created_at)
  WHERE status = 'cleanup_in_progress';
CREATE INDEX client_media_uploads_stale_finalize_idx
  ON public.client_media_uploads(finalize_claim_expires_at, upload_expires_at)
  WHERE status = 'processing';

ALTER TABLE public.client_media_uploads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.client_media_uploads FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, conversation_id, content_type, status, access_expires_at, created_at)
  ON public.client_media_uploads TO authenticated;

CREATE POLICY "Clients view own media uploads"
  ON public.client_media_uploads
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = client_id);
CREATE POLICY "Admins view client media uploads"
  ON public.client_media_uploads
  FOR SELECT TO authenticated
  USING (public.is_admin());

ALTER TABLE public.message_attachments
  ALTER COLUMN media_asset_id DROP NOT NULL,
  ALTER COLUMN reservation_id DROP NOT NULL,
  ADD COLUMN client_upload_id UUID UNIQUE
    REFERENCES public.client_media_uploads(id) ON DELETE RESTRICT,
  ADD COLUMN access_expires_at TIMESTAMPTZ;

ALTER TABLE public.client_media_uploads
  ADD CONSTRAINT client_media_uploads_message_attachment_fkey
    FOREIGN KEY (message_attachment_id)
    REFERENCES public.message_attachments(id)
    ON DELETE RESTRICT;

ALTER TABLE public.message_attachments
  DROP CONSTRAINT IF EXISTS message_attachments_view_mode_check,
  DROP CONSTRAINT IF EXISTS message_attachments_view_once_state_check,
  DROP CONSTRAINT IF EXISTS message_attachments_view_mode_standard_only_check,
  DROP CONSTRAINT IF EXISTS message_attachments_locked_price_snapshot_check,
  ADD CONSTRAINT message_attachments_view_mode_check
    CHECK (view_mode IN ('permanent', 'view_once', 'paid_open', 'client_24h')),
  ADD CONSTRAINT message_attachments_view_once_state_check
    CHECK (
      (view_mode = 'view_once' AND (view_once_completed_at IS NULL OR view_once_opened_at IS NOT NULL))
      OR (view_mode <> 'view_once' AND view_once_opened_at IS NULL AND view_once_completed_at IS NULL)
    ),
  ADD CONSTRAINT message_attachments_view_mode_standard_only_check
    CHECK (view_mode = 'permanent' OR access_mode = 'standard'),
  ADD CONSTRAINT message_attachments_locked_price_snapshot_check
    CHECK (
      (access_mode = 'locked' AND view_mode = 'permanent' AND price_credits_snapshot > 0)
      OR (access_mode = 'standard' AND view_mode IN ('permanent', 'view_once', 'client_24h') AND price_credits_snapshot IS NULL)
      OR (access_mode = 'standard' AND view_mode = 'paid_open' AND price_credits_snapshot > 0)
    ),
  ADD CONSTRAINT message_attachments_source_shape_check
    CHECK (
      (client_upload_id IS NULL AND media_asset_id IS NOT NULL AND reservation_id IS NOT NULL AND access_expires_at IS NULL)
      OR
      (client_upload_id IS NOT NULL AND media_asset_id IS NULL AND reservation_id IS NULL
        AND view_mode = 'client_24h' AND access_expires_at IS NOT NULL)
    );

CREATE OR REPLACE FUNCTION public.create_client_media_upload_intent(
  _conversation_id UUID,
  _content_type TEXT
)
RETURNS TABLE (
  upload_id UUID,
  source_path TEXT,
  upload_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _client UUID := auth.uid();
  _conversation public.conversations%ROWTYPE;
  _upload_id UUID := gen_random_uuid();
  _content_type_clean TEXT := lower(btrim(COALESCE(_content_type, '')));
  _extension TEXT;
BEGIN
  IF _client IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  PERFORM private.ensure_active_client(_client);
  IF _content_type_clean NOT IN ('image/jpeg', 'image/png', 'image/webp') THEN
    RAISE EXCEPTION 'client_media_content_type_not_allowed';
  END IF;

  SELECT * INTO _conversation
  FROM public.conversations conversation
  WHERE conversation.id = _conversation_id
  FOR KEY SHARE;
  IF NOT FOUND OR _conversation.client_id IS DISTINCT FROM _client
    OR _conversation.status = 'closed'::public.conversation_status
    OR _conversation.client_hidden_at IS NOT NULL THEN
    RAISE EXCEPTION 'conversation_access_denied';
  END IF;

  _extension := CASE _content_type_clean
    WHEN 'image/jpeg' THEN 'jpg'
    WHEN 'image/png' THEN 'png'
    ELSE 'webp'
  END;

  INSERT INTO public.client_media_uploads (
    id, client_id, conversation_id, source_path, preview_path, content_type, upload_expires_at
  ) VALUES (
    _upload_id,
    _client,
    _conversation_id,
    format('clients/%s/conversations/%s/uploads/%s/source.%s', _client, _conversation_id, _upload_id, _extension),
    format('clients/%s/conversations/%s/uploads/%s/preview.webp', _client, _conversation_id, _upload_id),
    _content_type_clean,
    clock_timestamp() + interval '30 minutes'
  )
  RETURNING id, client_media_uploads.source_path, client_media_uploads.upload_expires_at
  INTO upload_id, source_path, upload_expires_at;

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_client_media_finalize_for_server(
  _actor_user_id UUID,
  _upload_id UUID
)
RETURNS TABLE (
  upload_id UUID,
  bucket_id TEXT,
  source_path TEXT,
  preview_path TEXT,
  content_type TEXT,
  status TEXT,
  claim_token UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _upload public.client_media_uploads%ROWTYPE;
  _claimed_at timestamptz := clock_timestamp();
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;

  SELECT * INTO _upload
  FROM public.client_media_uploads upload
  WHERE upload.id = _upload_id
  FOR UPDATE;
  IF NOT FOUND OR _upload.client_id IS DISTINCT FROM _actor_user_id THEN
    RAISE EXCEPTION 'client_media_upload_not_available';
  END IF;

  IF _upload.finalized_at IS NOT NULL THEN
    RETURN QUERY SELECT _upload.id, _upload.bucket_id, _upload.source_path,
      _upload.preview_path, _upload.content_type, _upload.status, NULL::uuid;
    RETURN;
  END IF;

  IF _upload.status <> 'pending_upload'
     OR _upload.upload_expires_at <= _claimed_at THEN
    RAISE EXCEPTION 'client_media_upload_expired_or_changed';
  END IF;

  UPDATE public.client_media_uploads upload
  SET status = 'processing',
      finalize_claimed_at = _claimed_at,
      finalize_claim_token = gen_random_uuid(),
      finalize_claim_expires_at = _claimed_at + interval '5 minutes',
      updated_at = _claimed_at
  WHERE upload.id = _upload.id
  RETURNING upload.* INTO _upload;

  RETURN QUERY SELECT _upload.id, _upload.bucket_id, _upload.source_path,
    _upload.preview_path, _upload.content_type, _upload.status, _upload.finalize_claim_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_client_media_finalize_claim_for_server(
  _upload_id UUID,
  _claim_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _renewed boolean;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  UPDATE public.client_media_uploads upload
  SET finalize_claim_expires_at = clock_timestamp() + interval '5 minutes',
      updated_at = clock_timestamp()
  WHERE upload.id = _upload_id
    AND upload.status = 'processing'
    AND upload.finalize_claim_token = _claim_token
    AND upload.finalize_claim_expires_at > clock_timestamp();
  _renewed := FOUND;
  RETURN _renewed;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_client_media_finalize_for_server(
  _upload_id UUID,
  _claim_token UUID,
  _error_code TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  UPDATE public.client_media_uploads upload
  SET status = CASE WHEN upload.upload_expires_at > clock_timestamp()
                    THEN 'pending_upload' ELSE 'cleanup_failed' END,
      finalize_claimed_at = NULL,
      finalize_claim_token = NULL,
      finalize_claim_expires_at = NULL,
      cleanup_error_code = left(COALESCE(NULLIF(btrim(_error_code), ''), 'finalize_failed'), 120),
      next_cleanup_at = CASE WHEN upload.upload_expires_at > clock_timestamp()
                             THEN upload.next_cleanup_at ELSE clock_timestamp() END,
      updated_at = clock_timestamp()
  WHERE upload.id = _upload_id
    AND upload.status = 'processing'
    AND upload.finalize_claim_token = _claim_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'client_media_finalize_claim_not_found'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_client_media_finalize_artifact_for_cleanup_for_server(
  _upload_id UUID,
  _claim_token UUID,
  _error_code TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  UPDATE public.client_media_uploads upload
  SET status = 'cleanup_failed',
      deleted_at = NULL,
      cleanup_claimed_at = NULL,
      cleanup_claim_token = NULL,
      cleanup_claim_expires_at = NULL,
      cleanup_error_code = left(COALESCE(NULLIF(btrim(_error_code), ''), 'late_finalize_artifact'), 120),
      next_cleanup_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE upload.id = _upload_id
    AND upload.finalized_at IS NULL
    AND upload.finalize_claim_token = _claim_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'client_media_finalize_claim_not_found'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_client_media_upload_for_server(
  _actor_user_id UUID,
  _upload_id UUID,
  _idempotency_key TEXT,
  _content_type TEXT,
  _byte_size BIGINT,
  _finalize_claim_token UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _upload public.client_media_uploads%ROWTYPE;
  _conversation public.conversations%ROWTYPE;
  _message public.messages%ROWTYPE;
  _attachment public.message_attachments%ROWTYPE;
  _balance INTEGER;
  _credits_enabled BOOLEAN := private.setting_bool('credits_enabled', TRUE);
  _key TEXT := btrim(COALESCE(_idempotency_key, ''));
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF _actor_user_id IS NULL OR _upload_id IS NULL THEN RAISE EXCEPTION 'invalid_client_media_finalize'; END IF;
  IF char_length(_key) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'client_media_idempotency_key_required'; END IF;
  IF _content_type NOT IN ('image/jpeg', 'image/png', 'image/webp')
    OR _byte_size NOT BETWEEN 1 AND 10485760 THEN
    RAISE EXCEPTION 'client_media_validation_failed';
  END IF;

  SELECT * INTO _upload
  FROM public.client_media_uploads upload
  WHERE upload.id = _upload_id
  FOR UPDATE;
  IF NOT FOUND OR _upload.client_id IS DISTINCT FROM _actor_user_id THEN
    RAISE EXCEPTION 'client_media_upload_not_available';
  END IF;

  IF _upload.status <> 'processing' THEN
    IF _upload.finalized_at IS NULL
       OR _upload.message_id IS NULL
       OR _upload.message_attachment_id IS NULL THEN
      RAISE EXCEPTION 'client_media_upload_expired_or_changed';
    END IF;
    IF _upload.idempotency_key IS DISTINCT FROM _key THEN
      RAISE EXCEPTION 'client_media_idempotency_key_reused';
    END IF;
    SELECT * INTO _message
    FROM public.messages message
    WHERE message.id = _upload.message_id;
    SELECT * INTO _attachment
    FROM public.message_attachments attachment
    WHERE attachment.id = _upload.message_attachment_id
      AND attachment.message_id = _upload.message_id
      AND attachment.client_upload_id = _upload.id;
    IF _message.id IS NULL OR _attachment.id IS NULL THEN
      RAISE EXCEPTION 'client_media_finalize_state_invalid';
    END IF;
    SELECT wallet.balance INTO _balance
    FROM public.credit_wallets wallet
    WHERE wallet.user_id = _actor_user_id;
    RETURN jsonb_build_object(
      'message', to_jsonb(_message),
      'attachment', jsonb_build_object(
        'id', _attachment.id, 'message_id', _attachment.message_id, 'kind', _attachment.kind,
        'position', _attachment.position, 'caption', _attachment.caption,
        'metadata', _attachment.metadata, 'created_at', _attachment.created_at
      ),
      'access_expires_at', _upload.access_expires_at,
      'balance', COALESCE(_balance, 0),
      'already_finalized', TRUE
    );
  END IF;

  IF _upload.finalize_claim_token IS DISTINCT FROM _finalize_claim_token
    OR _upload.finalize_claim_expires_at <= clock_timestamp()
    OR _upload.content_type IS DISTINCT FROM _content_type THEN
    RAISE EXCEPTION 'client_media_upload_expired_or_changed';
  END IF;

  SELECT * INTO _conversation
  FROM public.conversations conversation
  WHERE conversation.id = _upload.conversation_id
  FOR UPDATE;
  IF NOT FOUND OR _conversation.client_id IS DISTINCT FROM _actor_user_id
    OR _conversation.status = 'closed'::public.conversation_status
    OR _conversation.client_hidden_at IS NOT NULL THEN
    RAISE EXCEPTION 'conversation_access_denied';
  END IF;

  INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
  VALUES (_actor_user_id, 0, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT wallet.balance INTO _balance
  FROM public.credit_wallets wallet
  WHERE wallet.user_id = _actor_user_id
  FOR UPDATE;
  IF _credits_enabled AND COALESCE(_balance, 0) < 10 THEN
    RAISE EXCEPTION 'insufficient_credits';
  END IF;

  INSERT INTO public.messages (conversation_id, sender_type, sender_id, content, created_at)
  VALUES (_conversation.id, 'client'::public.sender_type, _actor_user_id, '[image]', clock_timestamp())
  RETURNING * INTO _message;

  INSERT INTO public.message_attachments (
    message_id, client_upload_id, kind, position, caption, metadata,
    access_mode, view_mode, access_expires_at
  ) VALUES (
    _message.id, _upload.id, 'image', 0, NULL,
    jsonb_build_object('source', 'client_media_upload'),
    'standard', 'client_24h', _message.created_at + interval '24 hours'
  ) RETURNING * INTO _attachment;

  IF _credits_enabled THEN
    UPDATE public.credit_wallets
    SET balance = balance - 10,
        lifetime_spent = lifetime_spent + 10
    WHERE user_id = _actor_user_id
    RETURNING balance INTO _balance;
    INSERT INTO public.credit_transactions (
      user_id, amount, balance_after, type, reason, message_id, message_attachment_id, metadata
    ) VALUES (
      _actor_user_id, -10, _balance, 'message_spend', 'Client image spend',
      _message.id, _attachment.id,
      jsonb_build_object('conversation_id', _conversation.id, 'client_upload_id', _upload.id, 'unit_price', 10)
    );
  END IF;

  UPDATE public.client_media_uploads
  SET status = 'cleanup_pending',
      preview_path = COALESCE(
        preview_path,
        regexp_replace(source_path, '/source\.[^/]+$', '/preview.webp')
      ),
      byte_size = _byte_size,
      finalized_at = _message.created_at,
      access_expires_at = _attachment.access_expires_at,
      message_id = _message.id,
      message_attachment_id = _attachment.id,
      idempotency_key = _key,
      finalize_claimed_at = NULL,
      finalize_claim_token = NULL,
      finalize_claim_expires_at = NULL,
      next_cleanup_at = _attachment.access_expires_at,
      updated_at = clock_timestamp()
  WHERE id = _upload.id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _actor_user_id,
    'client_media.finalized',
    'client_media_upload',
    _upload.id::TEXT,
    jsonb_build_object('conversation_id', _conversation.id, 'message_id', _message.id, 'attachment_id', _attachment.id, 'access_expires_at', _attachment.access_expires_at)
  );

  RETURN jsonb_build_object(
    'message', to_jsonb(_message),
    'attachment', jsonb_build_object(
      'id', _attachment.id, 'message_id', _attachment.message_id, 'kind', _attachment.kind,
      'position', _attachment.position, 'caption', _attachment.caption,
      'metadata', _attachment.metadata, 'created_at', _attachment.created_at
    ),
    'access_expires_at', _attachment.access_expires_at,
    'balance', COALESCE(_balance, 0),
    'already_finalized', FALSE
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_message_attachment_media_for_server(
  _actor_user_id UUID,
  _attachment_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _attachment public.message_attachments%ROWTYPE;
  _conversation public.conversations%ROWTYPE;
  _upload public.client_media_uploads%ROWTYPE;
  _path TEXT;
  _ttl INTEGER;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  SELECT attachment.* INTO _attachment
  FROM public.message_attachments attachment
  WHERE attachment.id = _attachment_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT conversation.* INTO _conversation
  FROM public.messages message
  JOIN public.conversations conversation ON conversation.id = message.conversation_id
  WHERE message.id = _attachment.message_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF _attachment.client_upload_id IS NOT NULL THEN
    IF _attachment.access_expires_at <= clock_timestamp() THEN RETURN NULL; END IF;
    IF _conversation.client_id IS DISTINCT FROM _actor_user_id
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_roles role
        WHERE role.user_id = _actor_user_id
          AND role.role = 'admin'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.operators operator
        JOIN public.character_operator_assignments assignment ON assignment.operator_id = operator.id
        WHERE operator.user_id = _actor_user_id
          AND operator.is_active = TRUE
          AND assignment.character_id = _conversation.character_id
      ) THEN RETURN NULL;
    END IF;
    SELECT * INTO _upload FROM public.client_media_uploads upload
    WHERE upload.id = _attachment.client_upload_id;
    IF NOT FOUND OR _upload.status = 'deleted' THEN RETURN NULL; END IF;
    _ttl := LEAST(300, FLOOR(EXTRACT(EPOCH FROM (_attachment.access_expires_at - clock_timestamp())))::INTEGER);
    IF _ttl < 1 THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('bucket', _upload.bucket_id, 'path', COALESCE(_upload.preview_path, _upload.source_path), 'ttl_seconds', _ttl);
  END IF;

  _path := public.resolve_character_media_preview_path_for_server(_actor_user_id, 'message_attachment', _attachment_id);
  _ttl := public.get_message_attachment_view_url_ttl_for_server(_actor_user_id, _attachment_id);
  IF _path IS NULL OR _ttl IS NULL OR _ttl < 1 THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('bucket', 'character-media', 'path', _path, 'ttl_seconds', _ttl);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_message_attachment_access(_attachment_ids UUID[])
RETURNS TABLE (
  attachment_id UUID,
  access_mode TEXT,
  render_state TEXT,
  price_credits_snapshot INTEGER,
  is_unlocked BOOLEAN,
  view_mode TEXT,
  session_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _locked_images_enabled BOOLEAN := private.setting_bool('locked_images_enabled', FALSE);
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF _attachment_ids IS NULL OR cardinality(_attachment_ids) = 0 THEN RETURN; END IF;
  IF cardinality(_attachment_ids) > 100 THEN RAISE EXCEPTION 'too_many_attachment_ids'; END IF;

  RETURN QUERY
  SELECT
    attachment.id,
    attachment.access_mode,
    CASE
      WHEN attachment.view_mode = 'client_24h' AND attachment.access_expires_at > clock_timestamp()
        THEN 'client_24h_available'
      WHEN attachment.view_mode = 'client_24h' THEN 'client_24h_expired'
      WHEN attachment.view_mode = 'paid_open' AND conversation.client_id = _user_id AND paid_session.id IS NOT NULL
        THEN 'paid_open_active'
      WHEN attachment.view_mode = 'paid_open' AND conversation.client_id = _user_id THEN 'paid_open_available'
      WHEN attachment.view_mode = 'paid_open' THEN 'paid_open_staff'
      WHEN attachment.view_mode = 'view_once' AND conversation.client_id = _user_id
        AND attachment.view_once_opened_at IS NULL THEN 'view_once_available'
      WHEN attachment.view_mode = 'view_once' AND conversation.client_id = _user_id THEN 'view_once_seen'
      WHEN attachment.view_mode = 'view_once' THEN 'view_once_staff'
      WHEN attachment.access_mode = 'standard' THEN 'standard'
      WHEN NOT _locked_images_enabled THEN 'disabled'
      WHEN conversation.client_id = _user_id AND EXISTS (
        SELECT 1 FROM public.message_attachment_unlocks unlock
        WHERE unlock.attachment_id = attachment.id
          AND unlock.client_id = _user_id
          AND unlock.revoked_at IS NULL
      ) THEN 'delivery'
      WHEN conversation.client_id = _user_id THEN 'teaser'
      ELSE 'delivery'
    END,
    CASE
      WHEN conversation.client_id = _user_id AND attachment.access_mode = 'locked'
        THEN attachment.price_credits_snapshot
      WHEN conversation.client_id = _user_id AND attachment.view_mode = 'paid_open'
        THEN attachment.price_credits_snapshot
      ELSE NULL
    END,
    CASE
      WHEN conversation.client_id = _user_id AND attachment.access_mode = 'locked' THEN EXISTS (
        SELECT 1 FROM public.message_attachment_unlocks unlock
        WHERE unlock.attachment_id = attachment.id
          AND unlock.client_id = _user_id
          AND unlock.revoked_at IS NULL
      )
      ELSE NULL
    END,
    attachment.view_mode,
    CASE
      WHEN attachment.view_mode = 'client_24h' THEN attachment.access_expires_at
      WHEN conversation.client_id = _user_id AND attachment.view_mode = 'paid_open' THEN paid_session.expires_at
      ELSE NULL
    END
  FROM public.message_attachments attachment
  JOIN public.messages message ON message.id = attachment.message_id
  JOIN public.conversations conversation ON conversation.id = message.conversation_id
  LEFT JOIN LATERAL (
    SELECT session.id, session.expires_at
    FROM private.message_attachment_open_sessions session
    WHERE session.attachment_id = attachment.id
      AND session.client_id = _user_id
      AND session.status = 'opened'
      AND session.completed_at IS NULL
      AND session.expires_at > clock_timestamp()
    ORDER BY session.opened_at DESC, session.id DESC
    LIMIT 1
  ) paid_session ON TRUE
  WHERE attachment.id = ANY (_attachment_ids)
    AND (
      conversation.client_id = _user_id
      OR EXISTS (
        SELECT 1
        FROM public.character_operator_assignments assignment
        JOIN public.operators operator ON operator.id = assignment.operator_id
        WHERE assignment.character_id = conversation.character_id
          AND operator.user_id = _user_id
          AND operator.is_active = TRUE
      )
      OR EXISTS (
        SELECT 1 FROM public.user_roles role
        WHERE role.user_id = _user_id AND role.role = 'admin'
      )
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_expired_client_media_cleanup_for_server(_limit INTEGER DEFAULT 25)
RETURNS TABLE (upload_id UUID, bucket_id TEXT, source_path TEXT, preview_path TEXT, claim_token UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _claimed_at timestamptz := clock_timestamp();
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  RETURN QUERY
  WITH due AS (
    SELECT upload.id
    FROM public.client_media_uploads upload
    WHERE (
      (upload.status = 'pending_upload' AND upload.upload_expires_at <= _claimed_at)
      OR
      (upload.status = 'processing'
        AND upload.upload_expires_at <= _claimed_at
        AND upload.finalize_claim_expires_at <= _claimed_at)
      OR
      (upload.status = 'cleanup_pending'
        AND upload.finalized_at IS NOT NULL
        AND upload.access_expires_at <= _claimed_at
        AND upload.next_cleanup_at <= _claimed_at)
      OR
      (upload.status = 'cleanup_failed'
        AND upload.next_cleanup_at <= _claimed_at
        AND (
          (upload.finalized_at IS NULL
            AND upload.upload_expires_at <= _claimed_at)
          OR
          (upload.finalized_at IS NOT NULL
            AND upload.access_expires_at <= _claimed_at)
        ))
      OR
      (upload.status = 'cleanup_in_progress'
        AND upload.cleanup_claim_expires_at <= _claimed_at)
    )
    ORDER BY COALESCE(upload.next_cleanup_at, upload.cleanup_claim_expires_at, upload.upload_expires_at), upload.id
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(_limit, 25), 1), 100)
  ), claimed AS (
    UPDATE public.client_media_uploads upload
    SET status = 'cleanup_in_progress', cleanup_claimed_at = _claimed_at,
        cleanup_claim_token = gen_random_uuid(),
        cleanup_claim_expires_at = _claimed_at + interval '5 minutes',
        cleanup_attempts = cleanup_attempts + 1, updated_at = _claimed_at
    FROM due WHERE upload.id = due.id
    RETURNING upload.id, upload.bucket_id, upload.source_path, upload.preview_path, upload.cleanup_claim_token
  )
  SELECT claimed.id, claimed.bucket_id, claimed.source_path, claimed.preview_path, claimed.cleanup_claim_token FROM claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_client_media_cleanup_for_server(_upload_id UUID, _claim_token UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  UPDATE public.client_media_uploads
  SET status = 'deleted', deleted_at = clock_timestamp(), cleanup_error_code = NULL,
      cleanup_claimed_at = NULL, cleanup_claim_token = NULL,
      cleanup_claim_expires_at = NULL, updated_at = clock_timestamp()
  WHERE id = _upload_id AND status = 'cleanup_in_progress'
    AND cleanup_claim_token = _claim_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'client_media_cleanup_claim_not_found'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_client_media_cleanup_for_server(
  _upload_id UUID,
  _claim_token UUID,
  _error_code TEXT
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  UPDATE public.client_media_uploads
  SET status = 'cleanup_failed', cleanup_error_code = left(COALESCE(NULLIF(btrim(_error_code), ''), 'cleanup_failed'), 120),
      cleanup_claimed_at = NULL,
      cleanup_claim_token = NULL,
      cleanup_claim_expires_at = NULL,
      next_cleanup_at = clock_timestamp() + make_interval(mins => LEAST(1440, 5 * (2 ^ LEAST(cleanup_attempts, 8))::INTEGER)),
      updated_at = clock_timestamp()
  WHERE id = _upload_id AND status = 'cleanup_in_progress'
    AND cleanup_claim_token = _claim_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'client_media_cleanup_claim_not_found'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.create_client_media_upload_intent(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_client_media_upload_intent(UUID, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.claim_client_media_finalize_for_server(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_client_media_finalize_claim_for_server(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_client_media_finalize_for_server(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_client_media_finalize_artifact_for_cleanup_for_server(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_client_media_upload_for_server(UUID, UUID, TEXT, TEXT, BIGINT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_message_attachment_media_for_server(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_message_attachment_access(UUID[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.claim_expired_client_media_cleanup_for_server(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_client_media_cleanup_for_server(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_client_media_cleanup_for_server(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_client_media_finalize_for_server(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.renew_client_media_finalize_claim_for_server(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_client_media_finalize_for_server(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_client_media_finalize_artifact_for_cleanup_for_server(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_client_media_upload_for_server(UUID, UUID, TEXT, TEXT, BIGINT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_message_attachment_media_for_server(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_message_attachment_access(UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_expired_client_media_cleanup_for_server(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_client_media_cleanup_for_server(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_client_media_cleanup_for_server(UUID, UUID, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
