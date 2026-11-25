-- WP05: canonical media assets, many-to-many catalog assignments and
-- asset+client delivery history. P01 viewing windows are intentionally unchanged.

CREATE TABLE public.character_media_asset_characters (
  media_asset_id uuid NOT NULL REFERENCES public.character_media_assets(id) ON DELETE CASCADE,
  character_id uuid NOT NULL REFERENCES public.characters(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (media_asset_id, character_id)
);

CREATE TABLE public.character_media_asset_tags (
  media_asset_id uuid NOT NULL REFERENCES public.character_media_assets(id) ON DELETE CASCADE,
  media_tag_id uuid NOT NULL REFERENCES public.media_tags(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (media_asset_id, media_tag_id)
);

ALTER TABLE public.character_media_assets
  ADD COLUMN is_global boolean NOT NULL DEFAULT false;

ALTER TABLE public.character_media_reservations
  ADD COLUMN client_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  ADD COLUMN handling_cycle_id uuid REFERENCES public.conversation_handling_cycles(id) ON DELETE RESTRICT;

UPDATE public.character_media_reservations reservation
SET client_id = conversation.client_id
FROM public.conversations conversation
WHERE conversation.id = reservation.conversation_id
  AND reservation.client_id IS NULL;

UPDATE public.character_media_reservations reservation
SET handling_cycle_id = (
  SELECT cycle.id
  FROM public.conversation_handling_cycles cycle
  WHERE cycle.conversation_id = reservation.conversation_id
    AND cycle.ended_at IS NULL
  ORDER BY cycle.started_at DESC, cycle.id DESC
  LIMIT 1
)
WHERE reservation.handling_cycle_id IS NULL
  AND reservation.state = 'active'
  AND EXISTS (
    SELECT 1
    FROM public.conversation_handling_cycles cycle
    WHERE cycle.conversation_id = reservation.conversation_id
      AND cycle.ended_at IS NULL
  );

ALTER TABLE public.character_media_reservations
  ALTER COLUMN client_id SET NOT NULL;

CREATE TABLE public.character_media_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_asset_id uuid NOT NULL REFERENCES public.character_media_assets(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  message_attachment_id uuid UNIQUE REFERENCES public.message_attachments(id) ON DELETE SET NULL,
  reservation_id uuid UNIQUE REFERENCES public.character_media_reservations(id) ON DELETE SET NULL,
  delivered_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  delivered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (media_asset_id, client_id)
);

CREATE TABLE private.character_media_backfill_conflicts (
  message_attachment_id uuid PRIMARY KEY,
  media_asset_id uuid NOT NULL,
  client_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('duplicate_asset_client_delivery')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON TABLE private.character_media_backfill_conflicts
  FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.character_media_asset_characters (
  media_asset_id, character_id, created_at, created_by_user_id
)
SELECT asset.id, asset.character_id, asset.created_at, asset.created_by_user_id
FROM public.character_media_assets asset
ON CONFLICT DO NOTHING;

INSERT INTO public.character_media_asset_tags (
  media_asset_id, media_tag_id, created_at, created_by_user_id
)
SELECT asset.id, asset.media_tag_id, asset.created_at, asset.created_by_user_id
FROM public.character_media_assets asset
ON CONFLICT DO NOTHING;

WITH historical AS (
  SELECT
    attachment.id AS attachment_id,
    attachment.media_asset_id,
    conversation.client_id,
    message.conversation_id,
    attachment.reservation_id,
    message.sender_id,
    attachment.created_at,
    row_number() OVER (
      PARTITION BY attachment.media_asset_id, conversation.client_id
      ORDER BY attachment.created_at, attachment.id
    ) AS delivery_number
  FROM public.message_attachments attachment
  JOIN public.messages message ON message.id = attachment.message_id
  JOIN public.conversations conversation ON conversation.id = message.conversation_id
)
INSERT INTO public.character_media_deliveries (
  media_asset_id,
  client_id,
  conversation_id,
  message_attachment_id,
  reservation_id,
  delivered_by_user_id,
  delivered_at,
  metadata
)
SELECT
  media_asset_id,
  client_id,
  conversation_id,
  attachment_id,
  reservation_id,
  sender_id,
  created_at,
  jsonb_build_object('source', 'wp05_historical_attachment_backfill')
FROM historical
WHERE delivery_number = 1
ON CONFLICT (media_asset_id, client_id) DO NOTHING;

WITH historical AS (
  SELECT
    attachment.id AS attachment_id,
    attachment.media_asset_id,
    conversation.client_id,
    row_number() OVER (
      PARTITION BY attachment.media_asset_id, conversation.client_id
      ORDER BY attachment.created_at, attachment.id
    ) AS delivery_number
  FROM public.message_attachments attachment
  JOIN public.messages message ON message.id = attachment.message_id
  JOIN public.conversations conversation ON conversation.id = message.conversation_id
)
INSERT INTO private.character_media_backfill_conflicts (
  message_attachment_id, media_asset_id, client_id, reason
)
SELECT attachment_id, media_asset_id, client_id, 'duplicate_asset_client_delivery'
FROM historical
WHERE delivery_number > 1
ON CONFLICT DO NOTHING;

-- Asset state is catalog state from this migration onward. Delivery and active
-- reservation state live in their own tables and never consume an asset globally.
UPDATE public.character_media_assets
SET status = 'restored', updated_at = clock_timestamp()
WHERE status IN ('reserved', 'sent');

DROP INDEX IF EXISTS public.character_media_reservations_one_active_asset_idx;
CREATE UNIQUE INDEX character_media_reservations_one_active_asset_client_idx
  ON public.character_media_reservations (media_asset_id, client_id)
  WHERE state = 'active';

CREATE INDEX character_media_asset_characters_character_idx
  ON public.character_media_asset_characters (character_id, media_asset_id);
CREATE INDEX character_media_asset_tags_tag_idx
  ON public.character_media_asset_tags (media_tag_id, media_asset_id);
CREATE INDEX character_media_deliveries_client_idx
  ON public.character_media_deliveries (client_id, delivered_at DESC);
CREATE INDEX character_media_deliveries_asset_idx
  ON public.character_media_deliveries (media_asset_id, delivered_at DESC);

ALTER TABLE public.character_media_asset_characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.character_media_asset_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.character_media_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.character_media_asset_characters FROM anon, authenticated;
REVOKE ALL ON public.character_media_asset_tags FROM anon, authenticated;
REVOKE ALL ON public.character_media_deliveries FROM anon, authenticated;

CREATE POLICY "Admins view media character assignments"
  ON public.character_media_asset_characters FOR SELECT TO authenticated
  USING (public.is_admin());
CREATE POLICY "Admins view media tag assignments"
  ON public.character_media_asset_tags FOR SELECT TO authenticated
  USING (public.is_admin());
CREATE POLICY "Admins view media deliveries"
  ON public.character_media_deliveries FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE TABLE public.media_catalog_versions (
  scope_key text PRIMARY KEY,
  character_id uuid REFERENCES public.characters(id) ON DELETE CASCADE,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (scope_key = 'global' AND character_id IS NULL)
    OR (scope_key = 'character:' || character_id::text)
  )
);

INSERT INTO public.media_catalog_versions (scope_key, character_id)
SELECT 'character:' || character.id::text, character.id
FROM public.characters character
ON CONFLICT (scope_key) DO NOTHING;
INSERT INTO public.media_catalog_versions (scope_key, character_id)
VALUES ('global', NULL)
ON CONFLICT (scope_key) DO NOTHING;

ALTER TABLE public.media_catalog_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.media_catalog_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.media_catalog_versions TO authenticated;
CREATE POLICY "Authorized staff view media catalog versions"
  ON public.media_catalog_versions FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.operators operator
      LEFT JOIN public.character_operator_assignments assignment
        ON assignment.operator_id = operator.id
      WHERE operator.user_id = (SELECT auth.uid())
        AND operator.is_active = TRUE
        AND (media_catalog_versions.character_id IS NULL
          OR assignment.character_id = media_catalog_versions.character_id)
    )
  );

CREATE OR REPLACE FUNCTION private.bump_media_catalog_version(_character_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  INSERT INTO public.media_catalog_versions (scope_key, character_id, version, updated_at)
  VALUES (
    CASE WHEN _character_id IS NULL THEN 'global' ELSE 'character:' || _character_id::text END,
    _character_id,
    1,
    clock_timestamp()
  )
  ON CONFLICT (scope_key) DO UPDATE
  SET version = media_catalog_versions.version + 1,
      updated_at = EXCLUDED.updated_at;
END;
$$;

CREATE OR REPLACE FUNCTION private.bump_media_catalog_from_asset()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _asset_id uuid := COALESCE(NEW.id, OLD.id);
  _character_id uuid;
BEGIN
  IF COALESCE(NEW.is_global, OLD.is_global, FALSE) THEN
    PERFORM private.bump_media_catalog_version(NULL);
  END IF;
  FOR _character_id IN
    SELECT assignment.character_id
    FROM public.character_media_asset_characters assignment
    WHERE assignment.media_asset_id = _asset_id
  LOOP
    PERFORM private.bump_media_catalog_version(_character_id);
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION private.bump_media_catalog_from_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.bump_media_catalog_version(COALESCE(NEW.character_id, OLD.character_id));
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION private.bump_media_catalog_from_tag_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _asset_id uuid := COALESCE(NEW.media_asset_id, OLD.media_asset_id);
  _character_id uuid;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.character_media_assets asset
    WHERE asset.id = _asset_id AND asset.is_global = TRUE
  ) THEN
    PERFORM private.bump_media_catalog_version(NULL);
  END IF;
  FOR _character_id IN
    SELECT assignment.character_id
    FROM public.character_media_asset_characters assignment
    WHERE assignment.media_asset_id = _asset_id
  LOOP
    PERFORM private.bump_media_catalog_version(_character_id);
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION private.bump_media_catalog_from_reservation_or_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _conversation_id uuid := COALESCE(NEW.conversation_id, OLD.conversation_id);
  _character_id uuid;
BEGIN
  SELECT conversation.character_id INTO _character_id
  FROM public.conversations conversation
  WHERE conversation.id = _conversation_id;
  IF _character_id IS NOT NULL THEN
    PERFORM private.bump_media_catalog_version(_character_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER bump_media_catalog_asset
  AFTER INSERT OR UPDATE OF status, ingest_status, is_global, display_name, disabled_at
  ON public.character_media_assets
  FOR EACH ROW EXECUTE FUNCTION private.bump_media_catalog_from_asset();
CREATE TRIGGER bump_media_catalog_character_assignment
  AFTER INSERT OR DELETE ON public.character_media_asset_characters
  FOR EACH ROW EXECUTE FUNCTION private.bump_media_catalog_from_assignment();
CREATE TRIGGER bump_media_catalog_tag_assignment
  AFTER INSERT OR DELETE ON public.character_media_asset_tags
  FOR EACH ROW EXECUTE FUNCTION private.bump_media_catalog_from_tag_assignment();
CREATE TRIGGER bump_media_catalog_reservation
  AFTER INSERT OR UPDATE OF state ON public.character_media_reservations
  FOR EACH ROW EXECUTE FUNCTION private.bump_media_catalog_from_reservation_or_delivery();
CREATE TRIGGER bump_media_catalog_delivery
  AFTER INSERT ON public.character_media_deliveries
  FOR EACH ROW EXECUTE FUNCTION private.bump_media_catalog_from_reservation_or_delivery();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
    AND NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'media_catalog_versions'
    ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.media_catalog_versions;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.bump_media_catalog_version(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.bump_media_catalog_from_asset() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.bump_media_catalog_from_assignment() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.bump_media_catalog_from_tag_assignment() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.bump_media_catalog_from_reservation_or_delivery() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.expire_character_media_reservations(
  _character_id uuid DEFAULT NULL,
  _asset_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _reservation record;
  _expired_count integer := 0;
BEGIN
  FOR _reservation IN
    SELECT reservation.id, reservation.media_asset_id
    FROM public.character_media_reservations reservation
    WHERE reservation.state = 'active'
      AND (
        reservation.expires_at <= clock_timestamp()
        OR (
          reservation.handling_cycle_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.conversation_handling_cycles cycle
            WHERE cycle.id = reservation.handling_cycle_id
              AND cycle.ended_at IS NULL
          )
        )
      )
      AND (_asset_id IS NULL OR reservation.media_asset_id = _asset_id)
      AND (
        _character_id IS NULL
        OR EXISTS (
          SELECT 1 FROM public.character_media_asset_characters assignment
          WHERE assignment.media_asset_id = reservation.media_asset_id
            AND assignment.character_id = _character_id
        )
      )
    FOR UPDATE OF reservation SKIP LOCKED
  LOOP
    UPDATE public.character_media_reservations
    SET state = 'expired', ended_at = clock_timestamp(), ended_reason = 'expired'
    WHERE id = _reservation.id AND state = 'active';

    INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
    VALUES (
      NULL,
      'character_media_reservation.expired',
      'character_media_reservation',
      _reservation.id::text,
      jsonb_build_object('media_asset_id', _reservation.media_asset_id)
    );
    _expired_count := _expired_count + 1;
  END LOOP;
  RETURN _expired_count;
END;
$$;

CREATE OR REPLACE FUNCTION private.reserve_character_media_for_delivery(
  _conversation_id uuid,
  _asset_id uuid,
  _intended_access_mode text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _guard record;
  _conversation public.conversations%ROWTYPE;
  _asset public.character_media_assets%ROWTYPE;
  _reservation public.character_media_reservations%ROWTYPE;
  _cycle_id uuid;
  _expires_at timestamptz := clock_timestamp() + interval '5 minutes';
BEGIN
  IF _intended_access_mode NOT IN ('standard', 'locked') THEN
    RAISE EXCEPTION 'invalid_media_access_mode';
  END IF;
  SELECT * INTO _guard
  FROM private.assert_operator_can_manage_conversation_media(_conversation_id);
  SELECT * INTO _conversation
  FROM public.conversations conversation
  WHERE conversation.id = _conversation_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_not_found'; END IF;
  SELECT cycle.id INTO _cycle_id
  FROM public.conversation_handling_cycles cycle
  WHERE cycle.conversation_id = _conversation.id
    AND cycle.operator_id = _guard.operator_id
    AND cycle.ended_at IS NULL
  FOR UPDATE;
  IF _cycle_id IS NULL THEN RAISE EXCEPTION 'active_handling_cycle_required'; END IF;

  PERFORM private.expire_character_media_reservations(NULL, _asset_id);
  SELECT * INTO _asset
  FROM public.character_media_assets asset
  WHERE asset.id = _asset_id
    AND (
      asset.is_global
      OR EXISTS (
        SELECT 1 FROM public.character_media_asset_characters assignment
        WHERE assignment.media_asset_id = asset.id
          AND assignment.character_id = _guard.character_id
      )
    )
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'media_asset_not_found'; END IF;
  IF _asset.ingest_status <> 'ready' THEN RAISE EXCEPTION 'media_asset_not_ready'; END IF;
  IF _asset.status NOT IN ('available', 'restored') THEN
    RAISE EXCEPTION 'media_asset_not_reservable';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.character_media_deliveries delivery
    WHERE delivery.media_asset_id = _asset.id
      AND delivery.client_id = _conversation.client_id
  ) THEN
    RAISE EXCEPTION 'media_asset_already_delivered_to_client';
  END IF;
  IF _intended_access_mode = 'standard' AND _asset.locked_price_credits IS NOT NULL THEN
    RAISE EXCEPTION 'media_asset_requires_locked_delivery';
  END IF;
  IF _intended_access_mode = 'locked' AND (
    NOT private.setting_bool('locked_images_enabled', false)
    OR _asset.locked_price_credits IS NULL
    OR _asset.locked_derivative_status <> 'ready'
  ) THEN
    RAISE EXCEPTION 'locked_media_asset_not_ready';
  END IF;

  SELECT * INTO _reservation
  FROM public.character_media_reservations reservation
  WHERE reservation.media_asset_id = _asset.id
    AND reservation.client_id = _conversation.client_id
    AND reservation.state = 'active'
  FOR UPDATE;
  IF FOUND THEN
    IF _reservation.operator_id = _guard.operator_id
      AND _reservation.conversation_id = _conversation.id
      AND _reservation.handling_cycle_id = _cycle_id
      AND _reservation.intended_access_mode = _intended_access_mode THEN
      RETURN jsonb_build_object(
        'reservation_id', _reservation.id,
        'asset_id', _asset.id,
        'expires_at', _reservation.expires_at,
        'status', 'reserved',
        'intended_access_mode', _reservation.intended_access_mode,
        'already_reserved', true
      );
    END IF;
    RAISE EXCEPTION 'media_asset_reserved_for_client';
  END IF;

  INSERT INTO public.character_media_reservations (
    media_asset_id, conversation_id, client_id, operator_id, reserved_by_user_id,
    handling_cycle_id, previous_asset_status, intended_access_mode, expires_at
  ) VALUES (
    _asset.id, _conversation.id, _conversation.client_id, _guard.operator_id, _guard.user_id,
    _cycle_id, _asset.status, _intended_access_mode, _expires_at
  ) RETURNING * INTO _reservation;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _guard.user_id,
    'character_media_asset.reserved',
    'character_media_reservation',
    _reservation.id::text,
    jsonb_build_object(
      'media_asset_id', _asset.id,
      'client_id', _conversation.client_id,
      'conversation_id', _conversation.id,
      'handling_cycle_id', _cycle_id,
      'expires_at', _expires_at,
      'intended_access_mode', _intended_access_mode
    )
  );
  RETURN jsonb_build_object(
    'reservation_id', _reservation.id,
    'asset_id', _asset.id,
    'expires_at', _expires_at,
    'status', 'reserved',
    'intended_access_mode', _intended_access_mode,
    'already_reserved', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_character_media_reservation(_reservation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _reservation public.character_media_reservations%ROWTYPE;
  _conversation_id uuid;
  _asset_id uuid;
  _guard record;
  _is_admin boolean := public.is_admin();
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT reservation.conversation_id, reservation.media_asset_id
  INTO _conversation_id, _asset_id
  FROM public.character_media_reservations reservation
  WHERE reservation.id = _reservation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'media_reservation_not_found'; END IF;
  IF _is_admin THEN
    PERFORM 1 FROM public.conversations conversation
    WHERE conversation.id = _conversation_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'conversation_not_found'; END IF;
  ELSE
    SELECT * INTO _guard
    FROM private.assert_operator_can_send_conversation_message(_conversation_id);
  END IF;
  PERFORM private.expire_character_media_reservations(NULL, _asset_id);
  SELECT * INTO _reservation
  FROM public.character_media_reservations reservation
  WHERE reservation.id = _reservation_id
  FOR UPDATE;
  IF NOT FOUND
    OR _reservation.conversation_id IS DISTINCT FROM _conversation_id
    OR _reservation.media_asset_id IS DISTINCT FROM _asset_id THEN
    RAISE EXCEPTION 'media_reservation_changed';
  END IF;
  IF NOT _is_admin AND _guard.operator_id <> _reservation.operator_id THEN
    RAISE EXCEPTION 'media_reservation_not_owned';
  END IF;
  IF _reservation.state <> 'active' THEN
    RETURN jsonb_build_object('reservation_id', _reservation.id, 'state', _reservation.state);
  END IF;
  UPDATE public.character_media_reservations
  SET state = 'released', ended_at = clock_timestamp(),
      ended_by_user_id = _user_id, ended_reason = 'released'
  WHERE id = _reservation.id;
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _user_id,
    'character_media_reservation.released',
    'character_media_reservation',
    _reservation.id::text,
    jsonb_build_object('media_asset_id', _reservation.media_asset_id, 'client_id', _reservation.client_id)
  );
  RETURN jsonb_build_object(
    'reservation_id', _reservation.id,
    'asset_id', _reservation.media_asset_id,
    'status', _reservation.previous_asset_status,
    'state', 'released'
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.record_character_media_delivery(
  _reservation public.character_media_reservations,
  _attachment public.message_attachments,
  _actor_user_id uuid
)
RETURNS public.character_media_deliveries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _conversation public.conversations%ROWTYPE;
  _delivery public.character_media_deliveries%ROWTYPE;
BEGIN
  SELECT * INTO _conversation
  FROM public.conversations conversation
  WHERE conversation.id = _reservation.conversation_id
  FOR UPDATE;
  IF NOT FOUND OR _conversation.client_id IS DISTINCT FROM _reservation.client_id THEN
    RAISE EXCEPTION 'media_reservation_client_mismatch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.character_media_deliveries delivery
    WHERE delivery.media_asset_id = _reservation.media_asset_id
      AND delivery.client_id = _reservation.client_id
  ) THEN
    RAISE EXCEPTION 'media_asset_already_delivered_to_client';
  END IF;
  INSERT INTO public.character_media_deliveries (
    media_asset_id, client_id, conversation_id, message_attachment_id,
    reservation_id, delivered_by_user_id, delivered_at
  ) VALUES (
    _reservation.media_asset_id, _reservation.client_id, _reservation.conversation_id,
    _attachment.id, _reservation.id, _actor_user_id, _attachment.created_at
  ) RETURNING * INTO _delivery;
  RETURN _delivery;
END;
$$;

CREATE OR REPLACE FUNCTION private.send_operator_media_message(
  _reservation_id uuid,
  _caption text DEFAULT NULL,
  _view_mode text DEFAULT 'permanent'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _caption_clean text := NULLIF(btrim(COALESCE(_caption, '')), '');
  _view_mode_clean text := lower(btrim(COALESCE(_view_mode, 'permanent')));
  _reservation public.character_media_reservations%ROWTYPE;
  _conversation_id uuid;
  _asset_id uuid;
  _asset public.character_media_assets%ROWTYPE;
  _guard record;
  _message_result record;
  _attachment public.message_attachments%ROWTYPE;
  _message jsonb;
  _active_cycle_id uuid;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF _caption_clean IS NOT NULL AND char_length(_caption_clean) > 1000 THEN
    RAISE EXCEPTION 'invalid_media_caption';
  END IF;
  IF _view_mode_clean NOT IN ('permanent', 'view_once', 'paid_open') THEN
    RAISE EXCEPTION 'invalid_media_view_mode';
  END IF;
  SELECT reservation.conversation_id, reservation.media_asset_id
  INTO _conversation_id, _asset_id
  FROM public.character_media_reservations reservation
  WHERE reservation.id = _reservation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'media_reservation_not_found'; END IF;
  SELECT * INTO _guard
  FROM private.assert_operator_can_send_conversation_message(_conversation_id);
  PERFORM private.expire_character_media_reservations(NULL, _asset_id);
  SELECT * INTO _asset
  FROM public.character_media_assets asset
  WHERE asset.id = _asset_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'media_asset_not_found'; END IF;
  SELECT * INTO _reservation
  FROM public.character_media_reservations reservation
  WHERE reservation.id = _reservation_id
  FOR UPDATE;
  IF NOT FOUND
    OR _reservation.conversation_id IS DISTINCT FROM _conversation_id
    OR _reservation.media_asset_id IS DISTINCT FROM _asset_id THEN
    RAISE EXCEPTION 'media_reservation_changed';
  END IF;
  SELECT cycle.id INTO _active_cycle_id
  FROM public.conversation_handling_cycles cycle
  WHERE cycle.conversation_id = _conversation_id
    AND cycle.operator_id = _guard.operator_id
    AND cycle.ended_at IS NULL
  FOR UPDATE;
  IF _active_cycle_id IS NULL
    OR _reservation.handling_cycle_id IS DISTINCT FROM _active_cycle_id THEN
    RAISE EXCEPTION 'media_reservation_handling_cycle_expired';
  END IF;
  IF _reservation.operator_id <> _guard.operator_id THEN
    RAISE EXCEPTION 'media_reservation_not_owned';
  END IF;
  IF _reservation.state = 'consumed' THEN
    SELECT to_jsonb(message) INTO _message
    FROM public.message_attachments attachment
    JOIN public.messages message ON message.id = attachment.message_id
    WHERE attachment.reservation_id = _reservation.id
      AND attachment.view_mode = _view_mode_clean;
    IF NOT FOUND THEN RAISE EXCEPTION 'media_reservation_view_mode_conflict'; END IF;
    RETURN jsonb_build_object('message', _message, 'already_sent', true, 'concurrency_mode', _guard.concurrency_mode);
  END IF;
  IF _reservation.state = 'released' THEN RAISE EXCEPTION 'media_reservation_released';
  ELSIF _reservation.state = 'expired' THEN RAISE EXCEPTION 'media_reservation_expired';
  ELSIF _reservation.state <> 'active' THEN RAISE EXCEPTION 'media_reservation_not_active';
  END IF;
  IF _asset.status NOT IN ('available', 'restored') OR _asset.ingest_status <> 'ready' THEN
    RAISE EXCEPTION 'media_asset_not_ready';
  END IF;
  IF _view_mode_clean IN ('view_once', 'paid_open')
    AND _reservation.intended_access_mode <> 'standard' THEN
    RAISE EXCEPTION 'view_mode_requires_standard_media';
  END IF;
  IF _view_mode_clean = 'paid_open' AND COALESCE(_asset.paid_open_price_credits, 0) <= 0 THEN
    RAISE EXCEPTION 'paid_open_requires_positive_price';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.character_media_deliveries delivery
    WHERE delivery.media_asset_id = _asset.id AND delivery.client_id = _reservation.client_id
  ) THEN RAISE EXCEPTION 'media_asset_already_delivered_to_client'; END IF;

  SELECT * INTO _message_result
  FROM private.create_operator_message_with_scoring(
    _reservation.conversation_id,
    _guard.operator_id,
    _guard.user_id,
    COALESCE(_caption_clean, '[image]'),
    jsonb_build_object('source', 'send_operator_media_message', 'attachment_kind', 'image', 'view_mode', _view_mode_clean)
  );
  INSERT INTO public.message_attachments (
    message_id, media_asset_id, reservation_id, kind, position, caption,
    view_mode, price_credits_snapshot
  ) VALUES (
    _message_result.message_id, _asset.id, _reservation.id, 'image', 0, _caption_clean,
    _view_mode_clean,
    CASE WHEN _view_mode_clean = 'paid_open' THEN _asset.paid_open_price_credits ELSE NULL END
  ) RETURNING * INTO _attachment;
  PERFORM private.record_character_media_delivery(_reservation, _attachment, _guard.user_id);
  UPDATE public.character_media_reservations
  SET state = 'consumed', ended_at = clock_timestamp(),
      ended_by_user_id = _guard.user_id, ended_reason = 'sent'
  WHERE id = _reservation.id;
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES
    (_guard.user_id, 'character_media_reservation.consumed', 'character_media_reservation', _reservation.id::text,
      jsonb_build_object('media_asset_id', _asset.id, 'client_id', _reservation.client_id, 'message_id', _message_result.message_id, 'view_mode', _view_mode_clean)),
    (_guard.user_id, 'message_attachment.created', 'message_attachment', _attachment.id::text,
      jsonb_build_object('message_id', _message_result.message_id, 'kind', 'image', 'view_mode', _view_mode_clean));
  RETURN jsonb_build_object(
    'message', _message_result.message,
    'attachment', jsonb_build_object(
      'id', _attachment.id, 'message_id', _attachment.message_id, 'kind', _attachment.kind,
      'position', _attachment.position, 'caption', _attachment.caption,
      'metadata', _attachment.metadata, 'view_mode', _attachment.view_mode,
      'created_at', _attachment.created_at
    ),
    'already_sent', false,
    'score_awarded', _message_result.score_awarded,
    'streak_position', _message_result.streak_position,
    'consecutive_message_limit', _message_result.consecutive_message_limit,
    'monthly_points', _message_result.monthly_points,
    'scoring_enabled', _message_result.scoring_enabled,
    'concurrency_mode', _guard.concurrency_mode
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.send_operator_locked_media_message(
  _reservation_id uuid,
  _caption text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _caption_clean text := NULLIF(btrim(COALESCE(_caption, '')), '');
  _reservation public.character_media_reservations%ROWTYPE;
  _conversation_id uuid;
  _asset_id uuid;
  _asset public.character_media_assets%ROWTYPE;
  _guard record;
  _message_result record;
  _attachment public.message_attachments%ROWTYPE;
  _message jsonb;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF NOT private.setting_bool('locked_images_enabled', false) THEN
    RAISE EXCEPTION 'locked_images_disabled';
  END IF;
  IF _caption_clean IS NOT NULL AND char_length(_caption_clean) > 1000 THEN
    RAISE EXCEPTION 'invalid_media_caption';
  END IF;
  SELECT reservation.conversation_id, reservation.media_asset_id
  INTO _conversation_id, _asset_id
  FROM public.character_media_reservations reservation
  WHERE reservation.id = _reservation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'media_reservation_not_found'; END IF;
  SELECT * INTO _guard
  FROM private.assert_operator_can_send_conversation_message(_conversation_id);
  PERFORM private.expire_character_media_reservations(NULL, _asset_id);
  SELECT * INTO _asset
  FROM public.character_media_assets asset
  WHERE asset.id = _asset_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'media_asset_not_found'; END IF;
  SELECT * INTO _reservation
  FROM public.character_media_reservations reservation
  WHERE reservation.id = _reservation_id
  FOR UPDATE;
  IF NOT FOUND
    OR _reservation.conversation_id IS DISTINCT FROM _conversation_id
    OR _reservation.media_asset_id IS DISTINCT FROM _asset_id THEN
    RAISE EXCEPTION 'media_reservation_changed';
  END IF;
  IF _reservation.operator_id <> _guard.operator_id THEN
    RAISE EXCEPTION 'media_reservation_not_owned';
  END IF;
  IF _reservation.intended_access_mode <> 'locked' THEN
    RAISE EXCEPTION 'media_reservation_access_mode_mismatch';
  END IF;
  IF _reservation.state = 'consumed' THEN
    SELECT to_jsonb(message) INTO _message
    FROM public.message_attachments attachment
    JOIN public.messages message ON message.id = attachment.message_id
    WHERE attachment.reservation_id = _reservation.id AND attachment.access_mode = 'locked';
    IF NOT FOUND THEN RAISE EXCEPTION 'media_reservation_consumed_with_different_access_mode'; END IF;
    RETURN jsonb_build_object('message', _message, 'already_sent', true, 'concurrency_mode', _guard.concurrency_mode);
  END IF;
  IF _reservation.state = 'released' THEN RAISE EXCEPTION 'media_reservation_released';
  ELSIF _reservation.state = 'expired' THEN RAISE EXCEPTION 'media_reservation_expired';
  ELSIF _reservation.state <> 'active' THEN RAISE EXCEPTION 'media_reservation_not_active';
  END IF;
  IF _asset.status NOT IN ('available', 'restored')
    OR _asset.ingest_status <> 'ready'
    OR _asset.locked_price_credits IS NULL
    OR _asset.locked_derivative_status <> 'ready' THEN
    RAISE EXCEPTION 'locked_media_asset_not_ready';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.character_media_deliveries delivery
    WHERE delivery.media_asset_id = _asset.id AND delivery.client_id = _reservation.client_id
  ) THEN RAISE EXCEPTION 'media_asset_already_delivered_to_client'; END IF;

  SELECT * INTO _message_result
  FROM private.create_operator_message_with_scoring(
    _reservation.conversation_id,
    _guard.operator_id,
    _guard.user_id,
    COALESCE(_caption_clean, '[image]'),
    jsonb_build_object('source', 'send_operator_locked_media_message', 'attachment_kind', 'image', 'access_mode', 'locked')
  );
  INSERT INTO public.message_attachments (
    message_id, media_asset_id, reservation_id, kind, position, caption,
    access_mode, price_credits_snapshot
  ) VALUES (
    _message_result.message_id, _asset.id, _reservation.id, 'image', 0,
    _caption_clean, 'locked', _asset.locked_price_credits
  ) RETURNING * INTO _attachment;
  PERFORM private.record_character_media_delivery(_reservation, _attachment, _guard.user_id);
  UPDATE public.character_media_reservations
  SET state = 'consumed', ended_at = clock_timestamp(),
      ended_by_user_id = _guard.user_id, ended_reason = 'sent'
  WHERE id = _reservation.id;
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES
    (_guard.user_id, 'character_media_reservation.consumed', 'character_media_reservation', _reservation.id::text,
      jsonb_build_object('media_asset_id', _asset.id, 'client_id', _reservation.client_id, 'message_id', _message_result.message_id, 'access_mode', 'locked')),
    (_guard.user_id, 'message_attachment.created', 'message_attachment', _attachment.id::text,
      jsonb_build_object('message_id', _message_result.message_id, 'kind', 'image', 'access_mode', 'locked'));
  RETURN jsonb_build_object(
    'message', _message_result.message,
    'already_sent', false,
    'score_awarded', _message_result.score_awarded,
    'streak_position', _message_result.streak_position,
    'consecutive_message_limit', _message_result.consecutive_message_limit,
    'monthly_points', _message_result.monthly_points,
    'scoring_enabled', _message_result.scoring_enabled,
    'concurrency_mode', _guard.concurrency_mode
  );
END;
$$;

DROP FUNCTION public.get_operator_media_catalog(uuid);
CREATE FUNCTION public.get_operator_media_catalog(_conversation_id uuid)
RETURNS TABLE (
  id uuid, display_name text, status text, ingest_status text, content_type text,
  byte_size bigint, width integer, height integer, is_reservable boolean,
  is_locked_reservable boolean, locked_derivative_status text, locked_price_credits integer,
  paid_open_price_credits integer, locked_images_enabled boolean, is_reserved_by_me boolean,
  my_reservation_id uuid, my_reservation_expires_at timestamptz,
  my_reservation_access_mode text, media_tag_id uuid, media_tag_name text,
  media_tags jsonb, character_ids uuid[], is_global boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _guard record;
  _conversation public.conversations%ROWTYPE;
  _locked_images_enabled boolean := private.setting_bool('locked_images_enabled', false);
BEGIN
  SELECT * INTO _guard FROM private.assert_operator_can_view_conversation_media(_conversation_id);
  SELECT * INTO _conversation FROM public.conversations conversation WHERE conversation.id = _conversation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_not_found'; END IF;
  PERFORM private.expire_character_media_reservations(_guard.character_id, NULL);
  RETURN QUERY
  SELECT
    asset.id, asset.display_name, asset.status, asset.ingest_status, asset.content_type,
    asset.byte_size, asset.width, asset.height,
    (asset.status IN ('available', 'restored') AND asset.ingest_status = 'ready'
      AND asset.locked_price_credits IS NULL AND reservation.id IS NULL),
    (_locked_images_enabled AND asset.status IN ('available', 'restored')
      AND asset.ingest_status = 'ready' AND asset.locked_price_credits IS NOT NULL
      AND asset.locked_derivative_status = 'ready' AND reservation.id IS NULL),
    asset.locked_derivative_status, asset.locked_price_credits,
    asset.paid_open_price_credits, _locked_images_enabled,
    COALESCE(reservation.operator_id = _guard.operator_id, false),
    CASE WHEN reservation.operator_id = _guard.operator_id THEN reservation.id END,
    CASE WHEN reservation.operator_id = _guard.operator_id THEN reservation.expires_at END,
    CASE WHEN reservation.operator_id = _guard.operator_id THEN reservation.intended_access_mode END,
    asset.media_tag_id, primary_tag.name,
    COALESCE(tags.items, '[]'::jsonb),
    COALESCE(characters.ids, '{}'::uuid[]),
    asset.is_global
  FROM public.character_media_assets asset
  JOIN public.media_tags primary_tag ON primary_tag.id = asset.media_tag_id
  LEFT JOIN public.character_media_reservations reservation
    ON reservation.media_asset_id = asset.id
   AND reservation.client_id = _conversation.client_id
   AND reservation.state = 'active'
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'id', tag.id,
      'name', tag.name,
      'character_id', tag.character_id
    )
      ORDER BY tag.name, tag.id) AS items
    FROM public.character_media_asset_tags assignment
    JOIN public.media_tags tag ON tag.id = assignment.media_tag_id
    WHERE assignment.media_asset_id = asset.id
  ) tags ON true
  LEFT JOIN LATERAL (
    SELECT array_agg(assignment.character_id ORDER BY assignment.character_id) AS ids
    FROM public.character_media_asset_characters assignment
    WHERE assignment.media_asset_id = asset.id
  ) characters ON true
  WHERE (asset.is_global OR EXISTS (
      SELECT 1 FROM public.character_media_asset_characters assignment
      WHERE assignment.media_asset_id = asset.id
        AND assignment.character_id = _guard.character_id
    ))
    AND NOT EXISTS (
      SELECT 1 FROM public.character_media_deliveries delivery
      WHERE delivery.media_asset_id = asset.id
        AND delivery.client_id = _conversation.client_id
    )
  ORDER BY primary_tag.sort_order, primary_tag.name, asset.created_at DESC, asset.id DESC;
END;
$$;

DROP FUNCTION public.get_admin_media_catalog(uuid);
CREATE FUNCTION public.get_admin_media_catalog(_conversation_id uuid)
RETURNS TABLE (
  id uuid, display_name text, status text, ingest_status text, content_type text,
  byte_size bigint, width integer, height integer, is_reservable boolean,
  is_locked_reservable boolean, locked_derivative_status text, locked_price_credits integer,
  paid_open_price_credits integer, locked_images_enabled boolean, is_reserved_by_me boolean,
  my_reservation_id uuid, my_reservation_expires_at timestamptz,
  my_reservation_access_mode text, media_tag_id uuid, media_tag_name text,
  media_tags jsonb, character_ids uuid[], is_global boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM private.assert_admin_operator_identity_for_conversation(_conversation_id);
  RETURN QUERY SELECT * FROM public.get_operator_media_catalog(_conversation_id);
END;
$$;

DROP FUNCTION public.get_admin_character_media_assets(uuid);
CREATE FUNCTION public.get_admin_character_media_assets(_character_id uuid)
RETURNS TABLE (
  id uuid, display_name text, content_type text, byte_size bigint, width integer,
  height integer, status text, ingest_status text, preview_available boolean,
  locked_derivative_status text, locked_derivatives_generated_at timestamptz,
  locked_derivative_error_code text, locked_price_credits integer,
  paid_open_price_credits integer, locked_preview_available boolean,
  created_at timestamptz, updated_at timestamptz, disabled_at timestamptz,
  disabled_reason text, processing_started_at timestamptz, processing_attempts integer,
  processing_error_code text, media_tag_id uuid, media_tag_name text,
  media_tags jsonb, character_ids uuid[], is_global boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'admin_required'; END IF;
  RETURN QUERY
  SELECT
    asset.id, asset.display_name, asset.content_type, asset.byte_size, asset.width,
    asset.height, asset.status, asset.ingest_status,
    (asset.ingest_status = 'ready' AND asset.preview_generated_at IS NOT NULL),
    asset.locked_derivative_status, asset.locked_derivatives_generated_at,
    asset.locked_derivative_error_code, asset.locked_price_credits,
    asset.paid_open_price_credits, (asset.locked_derivative_status = 'ready'),
    asset.created_at, asset.updated_at, asset.disabled_at, asset.disabled_reason,
    asset.processing_started_at, asset.processing_attempts, asset.processing_error_code,
    asset.media_tag_id, primary_tag.name,
    COALESCE(tags.items, '[]'::jsonb),
    COALESCE(characters.ids, '{}'::uuid[]),
    asset.is_global
  FROM public.character_media_assets asset
  JOIN public.media_tags primary_tag ON primary_tag.id = asset.media_tag_id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'id', tag.id,
      'name', tag.name,
      'character_id', tag.character_id
    )
      ORDER BY tag.name, tag.id) AS items
    FROM public.character_media_asset_tags assignment
    JOIN public.media_tags tag ON tag.id = assignment.media_tag_id
    WHERE assignment.media_asset_id = asset.id
  ) tags ON true
  LEFT JOIN LATERAL (
    SELECT array_agg(assignment.character_id ORDER BY assignment.character_id) AS ids
    FROM public.character_media_asset_characters assignment
    WHERE assignment.media_asset_id = asset.id
  ) characters ON true
  WHERE asset.is_global OR EXISTS (
    SELECT 1 FROM public.character_media_asset_characters assignment
    WHERE assignment.media_asset_id = asset.id AND assignment.character_id = _character_id
  )
  ORDER BY asset.created_at DESC, asset.id DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_character_media_upload_intent_for_server(
  _actor_user_id uuid,
  _character_id uuid,
  _content_type text,
  _display_name text DEFAULT NULL
)
RETURNS TABLE (asset_id uuid, source_path text, content_type text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _asset public.character_media_assets%ROWTYPE;
  _default_tag_id uuid;
  _extension text;
BEGIN
  IF auth.role() <> 'service_role' OR _actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles role
    WHERE role.user_id = _actor_user_id AND role.role = 'admin'
  ) THEN RAISE EXCEPTION 'admin_required'; END IF;
  IF _content_type NOT IN ('image/jpeg', 'image/png', 'image/webp') THEN
    RAISE EXCEPTION 'unsupported_media_content_type';
  END IF;
  PERFORM 1 FROM public.characters character WHERE character.id = _character_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'character_not_found'; END IF;
  SELECT tag.id INTO _default_tag_id FROM public.media_tags tag
  WHERE tag.character_id = _character_id AND tag.is_default
  ORDER BY tag.created_at, tag.id LIMIT 1;
  IF _default_tag_id IS NULL THEN RAISE EXCEPTION 'default_media_tag_required'; END IF;
  _extension := CASE _content_type WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/png' THEN 'png' ELSE 'webp' END;
  INSERT INTO public.character_media_assets (
    character_id, media_tag_id, source_path, preview_path, content_type,
    display_name, created_by_user_id, updated_by_user_id
  ) VALUES (
    _character_id, _default_tag_id,
    format('assets/%s/source.%s', gen_random_uuid(), _extension), NULL,
    _content_type, NULLIF(btrim(_display_name), ''), _actor_user_id, _actor_user_id
  ) RETURNING * INTO _asset;
  UPDATE public.character_media_assets
  SET source_path = format('assets/%s/source.%s', _asset.id, _extension),
      preview_path = format('assets/%s/preview.webp', _asset.id)
  WHERE id = _asset.id RETURNING * INTO _asset;
  INSERT INTO public.character_media_asset_characters
    (media_asset_id, character_id, created_by_user_id)
  VALUES (_asset.id, _character_id, _actor_user_id);
  INSERT INTO public.character_media_asset_tags
    (media_asset_id, media_tag_id, created_by_user_id)
  VALUES (_asset.id, _default_tag_id, _actor_user_id);
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _actor_user_id,
    'character_media_asset.upload_intent_created',
    'character_media_asset',
    _asset.id::text,
    jsonb_build_object('character_id', _character_id, 'content_type', _content_type)
  );
  RETURN QUERY SELECT _asset.id, _asset.source_path, _asset.content_type;
END;
$$;

CREATE OR REPLACE FUNCTION public.assign_admin_media_asset_tag(
  _asset_id uuid,
  _media_tag_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _admin_id uuid := auth.uid();
  _asset public.character_media_assets%ROWTYPE;
  _tag public.media_tags%ROWTYPE;
BEGIN
  IF _admin_id IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'admin_required'; END IF;
  SELECT * INTO _asset FROM public.character_media_assets WHERE id = _asset_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'character_media_asset_not_found'; END IF;
  SELECT * INTO _tag FROM public.media_tags WHERE id = _media_tag_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'media_tag_not_found'; END IF;
  IF _tag.character_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.character_media_asset_characters assignment
    WHERE assignment.media_asset_id = _asset.id
      AND assignment.character_id = _tag.character_id
  ) THEN RAISE EXCEPTION 'media_tag_character_mismatch'; END IF;
  INSERT INTO public.character_media_asset_tags
    (media_asset_id, media_tag_id, created_by_user_id)
  VALUES (_asset.id, _tag.id, _admin_id)
  ON CONFLICT DO NOTHING;
  UPDATE public.character_media_assets
  SET media_tag_id = _tag.id, updated_by_user_id = _admin_id
  WHERE id = _asset.id;
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _admin_id,
    'character_media_asset.tag_assigned',
    'character_media_asset',
    _asset.id::text,
    jsonb_build_object('character_id', _tag.character_id, 'media_tag_id', _tag.id)
  );
  RETURN jsonb_build_object('asset_id', _asset.id, 'media_tag_id', _tag.id, 'media_tag_name', _tag.name);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_admin_media_tags(_character_id uuid)
RETURNS TABLE (
  id uuid,
  name text,
  sort_order integer,
  is_default boolean,
  asset_count bigint,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'admin_required'; END IF;
  RETURN QUERY
  SELECT
    tag.id,
    tag.name,
    tag.sort_order,
    tag.is_default,
    count(assignment.media_asset_id),
    tag.created_at,
    tag.updated_at
  FROM public.media_tags tag
  LEFT JOIN public.character_media_asset_tags assignment ON assignment.media_tag_id = tag.id
  WHERE tag.character_id = _character_id
  GROUP BY tag.id
  ORDER BY tag.is_default DESC, tag.sort_order, tag.name, tag.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_admin_media_tag(_tag_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _admin_id uuid := auth.uid();
  _tag public.media_tags%ROWTYPE;
BEGIN
  IF _admin_id IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'admin_required'; END IF;
  SELECT * INTO _tag FROM public.media_tags WHERE id = _tag_id FOR UPDATE;
  IF NOT FOUND OR _tag.character_id IS NULL THEN RAISE EXCEPTION 'media_tag_not_found'; END IF;
  IF _tag.is_default THEN RAISE EXCEPTION 'default_media_tag_cannot_be_deleted'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.character_media_asset_tags assignment
    WHERE assignment.media_tag_id = _tag.id
  ) OR EXISTS (
    SELECT 1 FROM public.character_media_assets asset
    WHERE asset.media_tag_id = _tag.id
  ) THEN RAISE EXCEPTION 'media_tag_in_use'; END IF;
  DELETE FROM public.media_tags WHERE id = _tag.id;
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _admin_id,
    'media_tag.deleted',
    'media_tag',
    _tag.id::text,
    jsonb_build_object('character_id', _tag.character_id, 'name', _tag.name)
  );
  RETURN jsonb_build_object('id', _tag.id, 'deleted', true);
END;
$$;

CREATE FUNCTION public.set_admin_media_asset_assignments(
  _asset_id uuid,
  _character_ids uuid[],
  _media_tag_ids uuid[],
  _is_global boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _admin_id uuid := auth.uid();
  _asset public.character_media_assets%ROWTYPE;
  _character_ids_normalized uuid[];
  _media_tag_ids_normalized uuid[];
  _primary_character_id uuid;
  _primary_tag_id uuid;
BEGIN
  IF _admin_id IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'admin_required'; END IF;
  SELECT * INTO _asset FROM public.character_media_assets WHERE id = _asset_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'character_media_asset_not_found'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(COALESCE(_character_ids, '{}'::uuid[])) value WHERE value IS NULL)
    OR EXISTS (SELECT 1 FROM unnest(COALESCE(_media_tag_ids, '{}'::uuid[])) value WHERE value IS NULL) THEN
    RAISE EXCEPTION 'media_asset_assignment_invalid';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT value ORDER BY value), '{}'::uuid[])
  INTO _character_ids_normalized
  FROM unnest(COALESCE(_character_ids, '{}'::uuid[])) value;
  SELECT COALESCE(array_agg(DISTINCT value ORDER BY value), '{}'::uuid[])
  INTO _media_tag_ids_normalized
  FROM unnest(COALESCE(_media_tag_ids, '{}'::uuid[])) value;
  IF NOT COALESCE(_is_global, false) AND cardinality(_character_ids_normalized) = 0 THEN
    RAISE EXCEPTION 'media_asset_assignment_required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(_character_ids_normalized) requested(id)
    LEFT JOIN public.characters character ON character.id = requested.id
    WHERE character.id IS NULL
  ) THEN RAISE EXCEPTION 'character_not_found'; END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(_media_tag_ids_normalized) requested(id)
    LEFT JOIN public.media_tags tag ON tag.id = requested.id
    WHERE tag.id IS NULL OR tag.character_id IS NULL
      OR NOT tag.character_id = ANY(_character_ids_normalized)
  ) THEN RAISE EXCEPTION 'media_tag_character_mismatch'; END IF;
  IF cardinality(_media_tag_ids_normalized) > 0 THEN
    _primary_tag_id := CASE
      WHEN _asset.media_tag_id = ANY(_media_tag_ids_normalized) THEN _asset.media_tag_id
      ELSE _media_tag_ids_normalized[1]
    END;
    SELECT tag.character_id INTO _primary_character_id
    FROM public.media_tags tag WHERE tag.id = _primary_tag_id;
  ELSIF cardinality(_character_ids_normalized) = 0
    OR _asset.character_id = ANY(_character_ids_normalized) THEN
    _primary_character_id := _asset.character_id;
    _primary_tag_id := _asset.media_tag_id;
  ELSE
    _primary_character_id := _character_ids_normalized[1];
    SELECT tag.id INTO _primary_tag_id
    FROM public.media_tags tag
    WHERE tag.character_id = _primary_character_id AND tag.is_default
    ORDER BY tag.created_at, tag.id
    LIMIT 1;
    IF _primary_tag_id IS NULL THEN RAISE EXCEPTION 'default_media_tag_required'; END IF;
  END IF;
  DELETE FROM public.character_media_asset_tags WHERE media_asset_id = _asset.id;
  DELETE FROM public.character_media_asset_characters WHERE media_asset_id = _asset.id;
  INSERT INTO public.character_media_asset_characters
    (media_asset_id, character_id, created_by_user_id)
  SELECT _asset.id, requested.id, _admin_id
  FROM unnest(_character_ids_normalized) requested(id)
  ON CONFLICT DO NOTHING;
  INSERT INTO public.character_media_asset_tags
    (media_asset_id, media_tag_id, created_by_user_id)
  SELECT _asset.id, requested.id, _admin_id
  FROM unnest(_media_tag_ids_normalized) requested(id)
  ON CONFLICT DO NOTHING;
  UPDATE public.character_media_assets
  SET character_id = _primary_character_id,
      media_tag_id = _primary_tag_id,
      is_global = COALESCE(_is_global, false),
      updated_by_user_id = _admin_id
  WHERE id = _asset.id;
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _admin_id,
    'character_media_asset.assignments_updated',
    'character_media_asset',
    _asset.id::text,
    jsonb_build_object(
      'previous_character_id', _asset.character_id,
      'previous_media_tag_id', _asset.media_tag_id,
      'previous_is_global', _asset.is_global,
      'character_ids', _character_ids_normalized,
      'media_tag_ids', _media_tag_ids_normalized,
      'is_global', COALESCE(_is_global, false)
    )
  );
  RETURN jsonb_build_object(
    'asset_id', _asset.id,
    'character_ids', _character_ids_normalized,
    'media_tag_ids', _media_tag_ids_normalized,
    'is_global', COALESCE(_is_global, false)
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_media_asset_hard_delete_unused(_asset_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.message_attachments WHERE media_asset_id = _asset_id)
    OR EXISTS (SELECT 1 FROM public.character_media_reservations WHERE media_asset_id = _asset_id)
    OR EXISTS (SELECT 1 FROM public.character_media_deliveries WHERE media_asset_id = _asset_id) THEN
    RAISE EXCEPTION 'media_asset_in_use';
  END IF;
  IF EXISTS (SELECT 1 FROM public.character_media_assets WHERE id = _asset_id AND is_global)
    OR 1 < (SELECT count(*) FROM public.character_media_asset_characters WHERE media_asset_id = _asset_id) THEN
    RAISE EXCEPTION 'media_asset_shared';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.record_character_media_delivery(public.character_media_reservations, public.message_attachments, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_admin_media_asset_assignments(uuid, uuid[], uuid[], boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_operator_media_catalog(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_admin_media_catalog(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_admin_character_media_assets(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_admin_media_asset_assignments(uuid, uuid[], uuid[], boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_operator_media_catalog(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_media_catalog(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_character_media_assets(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
