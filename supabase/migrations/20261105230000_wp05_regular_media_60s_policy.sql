-- P01 approved policy: new standard view-once attachments use a 60-second
-- window from the first authorized open. Legacy rows keep the seven-second
-- contract through their existing view_policy_version.

INSERT INTO public.system_settings (key, value)
VALUES
  ('regular_media_60s_policy_enabled', 'true'::jsonb),
  ('regular_media_policy_version', '"regular_60s_v1"'::jsonb)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.message_attachments
  ADD COLUMN view_policy_version TEXT NOT NULL DEFAULT 'legacy'
    CHECK (view_policy_version IN ('legacy', 'regular_60s_v1'));

CREATE OR REPLACE FUNCTION private.bind_regular_media_policy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF NEW.view_mode = 'view_once'
    AND private.setting_bool('regular_media_60s_policy_enabled', FALSE) THEN
    NEW.view_policy_version := 'regular_60s_v1';
  ELSE
    NEW.view_policy_version := 'legacy';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bind_regular_media_policy ON public.message_attachments;
CREATE TRIGGER bind_regular_media_policy
  BEFORE INSERT ON public.message_attachments
  FOR EACH ROW EXECUTE FUNCTION private.bind_regular_media_policy();

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
  _expires_at TIMESTAMPTZ;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  PERFORM private.ensure_active_client(_user_id);
  SELECT attachment.* INTO _attachment
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

  _expires_at := _attachment.view_once_opened_at + CASE
    WHEN _attachment.view_policy_version = 'regular_60s_v1' THEN interval '60 seconds'
    ELSE interval '7 seconds'
  END;
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _user_id, 'message_attachment.view_once_opened', 'message_attachment', _attachment.id::TEXT,
    jsonb_build_object(
      'idempotency_key_present', _idempotency_key IS NOT NULL,
      'view_policy_version', _attachment.view_policy_version,
      'expires_at', _expires_at
    )
  );
  RETURN jsonb_build_object(
    'attachment_id', _attachment.id,
    'render_state', 'view_once_opened',
    'view_policy_version', _attachment.view_policy_version,
    'expires_at', _expires_at
  );
END;
$$;

DROP FUNCTION public.get_message_attachment_access(UUID[]);
CREATE FUNCTION public.get_message_attachment_access(_attachment_ids UUID[])
RETURNS TABLE (
  attachment_id UUID, access_mode TEXT, render_state TEXT,
  price_credits_snapshot INTEGER, is_unlocked BOOLEAN, view_mode TEXT,
  session_expires_at TIMESTAMPTZ, required_gift_id UUID,
  required_gift_name TEXT, required_gift_price_credits INTEGER,
  available_purchase_id UUID
)
LANGUAGE plpgsql SECURITY DEFINER
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
  SELECT attachment.id, attachment.access_mode,
    CASE
      WHEN attachment.view_mode = 'client_24h' AND attachment.access_expires_at > clock_timestamp() THEN 'client_24h_available'
      WHEN attachment.view_mode = 'client_24h' THEN 'client_24h_expired'
      WHEN attachment.view_mode = 'paid_open' AND attachment.required_gift_id IS NOT NULL
        AND conversation.client_id = _user_id AND gift_session.id IS NOT NULL THEN 'paid_open_active'
      WHEN attachment.view_mode = 'paid_open' AND attachment.required_gift_id IS NOT NULL
        AND conversation.client_id = _user_id AND gift_purchase.id IS NOT NULL THEN 'gift_purchased'
      WHEN attachment.view_mode = 'paid_open' AND attachment.required_gift_id IS NOT NULL
        AND conversation.client_id = _user_id THEN 'gift_purchase_required'
      WHEN attachment.view_mode = 'paid_open' AND conversation.client_id = _user_id
        AND legacy_session.id IS NOT NULL THEN 'paid_open_active'
      WHEN attachment.view_mode = 'paid_open' AND conversation.client_id = _user_id THEN 'paid_open_available'
      WHEN attachment.view_mode = 'paid_open' THEN 'paid_open_staff'
      WHEN attachment.view_mode = 'view_once' AND conversation.client_id = _user_id
        AND attachment.view_once_opened_at IS NULL THEN 'view_once_available'
      WHEN attachment.view_mode = 'view_once' AND conversation.client_id = _user_id
        AND attachment.view_once_completed_at IS NULL
        AND attachment.view_policy_version = 'regular_60s_v1'
        AND attachment.view_once_opened_at + interval '60 seconds' > clock_timestamp() THEN 'view_once_active'
      WHEN attachment.view_mode = 'view_once' AND conversation.client_id = _user_id THEN 'view_once_seen'
      WHEN attachment.view_mode = 'view_once' THEN 'view_once_staff'
      WHEN attachment.access_mode = 'standard' THEN 'standard'
      WHEN NOT _locked_images_enabled THEN 'disabled'
      WHEN conversation.client_id = _user_id AND EXISTS (
        SELECT 1 FROM public.message_attachment_unlocks unlock
        WHERE unlock.attachment_id = attachment.id AND unlock.client_id = _user_id AND unlock.revoked_at IS NULL
      ) THEN 'delivery'
      WHEN conversation.client_id = _user_id THEN 'teaser'
      ELSE 'delivery'
    END,
    CASE WHEN conversation.client_id = _user_id THEN attachment.price_credits_snapshot END,
    CASE WHEN conversation.client_id = _user_id AND attachment.access_mode = 'locked' THEN EXISTS (
      SELECT 1 FROM public.message_attachment_unlocks unlock
      WHERE unlock.attachment_id = attachment.id AND unlock.client_id = _user_id AND unlock.revoked_at IS NULL
    ) ELSE NULL END,
    attachment.view_mode,
    CASE
      WHEN attachment.view_mode = 'client_24h' THEN attachment.access_expires_at
      WHEN attachment.view_mode = 'view_once'
        AND attachment.view_policy_version = 'regular_60s_v1'
        AND attachment.view_once_opened_at IS NOT NULL
        THEN attachment.view_once_opened_at + interval '60 seconds'
      WHEN gift_session.id IS NOT NULL THEN gift_session.expires_at
      WHEN legacy_session.id IS NOT NULL THEN legacy_session.expires_at
    END,
    CASE WHEN conversation.client_id = _user_id THEN attachment.required_gift_id END,
    CASE WHEN conversation.client_id = _user_id THEN attachment.required_gift_name_snapshot END,
    CASE WHEN conversation.client_id = _user_id THEN attachment.required_gift_price_credits_snapshot END,
    CASE WHEN conversation.client_id = _user_id THEN gift_purchase.id END
  FROM public.message_attachments attachment
  JOIN public.messages message ON message.id = attachment.message_id
  JOIN public.conversations conversation ON conversation.id = message.conversation_id
  LEFT JOIN LATERAL (
    SELECT session.id, session.expires_at
    FROM private.gift_attachment_open_sessions session
    WHERE session.attachment_id = attachment.id AND session.client_id = _user_id
      AND session.completed_at IS NULL AND session.expires_at > clock_timestamp()
    ORDER BY session.opened_at DESC, session.id DESC LIMIT 1
  ) gift_session ON TRUE
  LEFT JOIN LATERAL (
    SELECT session.id, session.expires_at
    FROM private.message_attachment_open_sessions session
    WHERE session.attachment_id = attachment.id AND session.client_id = _user_id
      AND session.status = 'opened' AND session.completed_at IS NULL
      AND session.expires_at > clock_timestamp()
    ORDER BY session.opened_at DESC, session.id DESC LIMIT 1
  ) legacy_session ON TRUE
  LEFT JOIN LATERAL (
    SELECT purchase.id FROM public.gift_attachment_purchases purchase
    WHERE purchase.attachment_id = attachment.id AND purchase.client_id = _user_id
      AND purchase.status = 'purchased'
    ORDER BY purchase.created_at DESC, purchase.id DESC LIMIT 1
  ) gift_purchase ON TRUE
  WHERE attachment.id = ANY (_attachment_ids)
    AND (conversation.client_id = _user_id
      OR EXISTS (SELECT 1 FROM public.character_operator_assignments assignment
        JOIN public.operators operator ON operator.id = assignment.operator_id
        WHERE assignment.character_id = conversation.character_id
          AND operator.user_id = _user_id AND operator.is_active = TRUE)
      OR EXISTS (SELECT 1 FROM public.user_roles role WHERE role.user_id = _user_id AND role.role = 'admin'));
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_message_attachment_media_for_server(
  _actor_user_id UUID,
  _attachment_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _attachment public.message_attachments%ROWTYPE;
  _conversation public.conversations%ROWTYPE;
  _upload public.client_media_uploads%ROWTYPE;
  _asset public.character_media_assets%ROWTYPE;
  _session private.gift_attachment_open_sessions%ROWTYPE;
  _path TEXT;
  _ttl INTEGER;
  _is_staff BOOLEAN;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  SELECT attachment.* INTO _attachment FROM public.message_attachments attachment WHERE attachment.id = _attachment_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT conversation.* INTO _conversation
  FROM public.messages message JOIN public.conversations conversation ON conversation.id = message.conversation_id
  WHERE message.id = _attachment.message_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  _is_staff := EXISTS (SELECT 1 FROM public.user_roles role WHERE role.user_id = _actor_user_id AND role.role = 'admin')
    OR EXISTS (SELECT 1 FROM public.operators operator
      JOIN public.character_operator_assignments assignment ON assignment.operator_id = operator.id
      WHERE operator.user_id = _actor_user_id AND operator.is_active = TRUE
        AND assignment.character_id = _conversation.character_id);

  IF _attachment.client_upload_id IS NOT NULL THEN
    IF _attachment.access_expires_at <= clock_timestamp()
      OR (_conversation.client_id IS DISTINCT FROM _actor_user_id AND NOT _is_staff) THEN RETURN NULL; END IF;
    SELECT * INTO _upload FROM public.client_media_uploads upload WHERE upload.id = _attachment.client_upload_id;
    IF NOT FOUND OR _upload.status = 'deleted' THEN RETURN NULL; END IF;
    _ttl := LEAST(300, FLOOR(EXTRACT(EPOCH FROM (_attachment.access_expires_at - clock_timestamp())))::INTEGER);
    IF _ttl < 1 THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('bucket', _upload.bucket_id, 'path', COALESCE(_upload.preview_path, _upload.source_path), 'ttl_seconds', _ttl);
  END IF;

  IF _attachment.required_gift_id IS NOT NULL THEN
    SELECT * INTO _asset FROM public.character_media_assets asset WHERE asset.id = _attachment.media_asset_id;
    IF NOT FOUND OR _asset.ingest_status <> 'ready' OR _asset.status = 'disabled' THEN RETURN NULL; END IF;
    IF _is_staff THEN RETURN jsonb_build_object('bucket', _asset.bucket_id, 'path', _asset.preview_path, 'ttl_seconds', 60); END IF;
    IF _conversation.client_id IS DISTINCT FROM _actor_user_id THEN RETURN NULL; END IF;
    SELECT * INTO _session FROM private.gift_attachment_open_sessions session
    WHERE session.attachment_id = _attachment.id AND session.client_id = _actor_user_id
      AND session.completed_at IS NULL AND session.expires_at > clock_timestamp()
    ORDER BY session.opened_at DESC, session.id DESC LIMIT 1;
    IF NOT FOUND THEN RETURN NULL; END IF;
    _ttl := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (_session.expires_at - clock_timestamp())))::INTEGER);
    RETURN jsonb_build_object('bucket', _asset.bucket_id, 'path', _asset.preview_path, 'ttl_seconds', _ttl);
  END IF;

  IF _attachment.view_mode = 'view_once' AND _attachment.view_policy_version = 'regular_60s_v1' THEN
    SELECT * INTO _asset FROM public.character_media_assets asset WHERE asset.id = _attachment.media_asset_id;
    IF NOT FOUND OR _asset.ingest_status <> 'ready' OR _asset.status = 'disabled' THEN RETURN NULL; END IF;
    IF _is_staff THEN RETURN jsonb_build_object('bucket', _asset.bucket_id, 'path', _asset.preview_path, 'ttl_seconds', 60); END IF;
    IF _conversation.client_id IS DISTINCT FROM _actor_user_id
      OR _attachment.view_once_opened_at IS NULL
      OR _attachment.view_once_completed_at IS NOT NULL
      OR _attachment.view_once_opened_at + interval '60 seconds' <= clock_timestamp() THEN RETURN NULL; END IF;
    _ttl := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (
      _attachment.view_once_opened_at + interval '60 seconds' - clock_timestamp()
    )))::INTEGER);
    RETURN jsonb_build_object('bucket', _asset.bucket_id, 'path', _asset.preview_path, 'ttl_seconds', _ttl);
  END IF;

  _path := public.resolve_character_media_preview_path_for_server(_actor_user_id, 'message_attachment', _attachment_id);
  _ttl := public.get_message_attachment_view_url_ttl_for_server(_actor_user_id, _attachment_id);
  IF _path IS NULL OR _ttl IS NULL OR _ttl < 1 THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('bucket', 'character-media', 'path', _path, 'ttl_seconds', _ttl);
END;
$$;

REVOKE ALL ON FUNCTION private.bind_regular_media_policy() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.open_free_view_once_attachment(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_free_view_once_attachment(UUID, UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.get_message_attachment_access(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_message_attachment_access(UUID[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
