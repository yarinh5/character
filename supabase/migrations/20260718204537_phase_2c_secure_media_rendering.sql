-- Phase 2C: resolve private preview paths for the trusted media URL delivery path.
-- This function is intentionally callable only by service_role from the Edge Function.

CREATE OR REPLACE FUNCTION public.resolve_character_media_preview_path_for_server(
  _actor_user_id UUID,
  _target_kind TEXT,
  _target_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _preview_path TEXT;
  _concurrency_mode TEXT;
BEGIN
  IF _actor_user_id IS NULL OR _target_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF _target_kind = 'message_attachment' THEN
    SELECT asset.preview_path
    INTO _preview_path
    FROM public.message_attachments attachment
    JOIN public.messages message ON message.id = attachment.message_id
    JOIN public.conversations conversation ON conversation.id = message.conversation_id
    JOIN public.character_media_assets asset ON asset.id = attachment.media_asset_id
    WHERE attachment.id = _target_id
      AND asset.bucket_id = 'character-media'
      AND asset.preview_path IS NOT NULL
      AND (
        conversation.client_id = _actor_user_id
        OR EXISTS (
          SELECT 1
          FROM public.character_operator_assignments assignment
          JOIN public.operators operator ON operator.id = assignment.operator_id
          WHERE assignment.character_id = conversation.character_id
            AND operator.user_id = _actor_user_id
            AND operator.is_active = TRUE
        )
        OR EXISTS (
          SELECT 1
          FROM public.user_roles role
          WHERE role.user_id = _actor_user_id
            AND role.role = 'admin'
        )
      );

    RETURN _preview_path;
  END IF;

  IF _target_kind = 'reserved_preview' THEN
    SELECT setting.value
    INTO _concurrency_mode
    FROM public.system_settings setting
    WHERE setting.key = 'concurrency_mode';

    SELECT asset.preview_path
    INTO _preview_path
    FROM public.character_media_reservations reservation
    JOIN public.character_media_assets asset ON asset.id = reservation.media_asset_id
    JOIN public.conversations conversation ON conversation.id = reservation.conversation_id
    WHERE reservation.id = _target_id
      AND reservation.state = 'active'
      AND reservation.expires_at > clock_timestamp()
      AND conversation.status <> 'closed'
      AND asset.bucket_id = 'character-media'
      AND asset.preview_path IS NOT NULL
      AND (
        EXISTS (
          SELECT 1
          FROM public.user_roles role
          WHERE role.user_id = _actor_user_id
            AND role.role = 'admin'
        )
        OR EXISTS (
          SELECT 1
          FROM public.operators operator
          JOIN public.character_operator_assignments assignment
            ON assignment.operator_id = operator.id
           AND assignment.character_id = conversation.character_id
          WHERE operator.id = reservation.operator_id
            AND operator.user_id = _actor_user_id
            AND operator.is_active = TRUE
            AND reservation.reserved_by_user_id = _actor_user_id
        )
      )
      AND (
        COALESCE(_concurrency_mode, 'open') <> 'lock'
        OR NOT EXISTS (
          SELECT 1
          FROM public.conversation_locks conversation_lock
          WHERE conversation_lock.conversation_id = conversation.id
            AND conversation_lock.released_at IS NULL
            AND conversation_lock.expires_at > clock_timestamp()
            AND conversation_lock.locked_by_operator_id <> reservation.operator_id
        )
      );

    RETURN _preview_path;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_character_media_preview_path_for_server(UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_character_media_preview_path_for_server(UUID, TEXT, UUID)
  TO service_role;
