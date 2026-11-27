-- Canonical reservations do not change the asset's global status.
CREATE OR REPLACE FUNCTION public.resolve_character_media_preview_path_for_server(
  _actor_user_id UUID, _target_kind TEXT, _target_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
DECLARE
  _conversation_id UUID;
  _path TEXT;
BEGIN
  IF _target_kind = 'reserved_preview' THEN
    SELECT CASE reservation.intended_access_mode
      WHEN 'standard' THEN asset.preview_path
      WHEN 'locked' THEN asset.locked_teaser_path
    END INTO _path
    FROM public.character_media_reservations reservation
    JOIN public.character_media_assets asset ON asset.id = reservation.media_asset_id
    JOIN public.conversations conversation ON conversation.id = reservation.conversation_id
    JOIN public.conversation_handling_cycles cycle
      ON cycle.id = reservation.handling_cycle_id
      AND cycle.conversation_id = reservation.conversation_id
      AND cycle.operator_id = reservation.operator_id
    JOIN public.conversation_work_items work_item
      ON work_item.id = cycle.work_item_id
      AND work_item.conversation_id = reservation.conversation_id
      AND work_item.responsible_operator_id = reservation.operator_id
      AND work_item.status IN ('assigned', 'in_progress')
    JOIN public.operators operator ON operator.id = reservation.operator_id
    WHERE reservation.id = _target_id
      AND reservation.reserved_by_user_id = _actor_user_id
      AND operator.user_id = _actor_user_id
      AND operator.is_active AND operator.deleted_at IS NULL
      AND reservation.state = 'active' AND reservation.expires_at > clock_timestamp()
      AND cycle.ended_at IS NULL
      AND conversation.status <> 'closed' AND reservation.client_id = conversation.client_id
      AND conversation.assigned_operator_id = reservation.operator_id
      AND conversation.inactivity_expires_at > clock_timestamp()
      AND private.can_user_read_conversation(conversation.id, _actor_user_id)
      AND NOT private.conversation_deletion_blocks_access(conversation.id)
      AND asset.bucket_id = 'character-media' AND asset.ingest_status = 'ready'
      AND asset.status IN ('available', 'restored', 'reserved')
      AND (asset.is_global OR EXISTS (
        SELECT 1 FROM public.character_media_asset_characters assignment
        WHERE assignment.media_asset_id = asset.id AND assignment.character_id = conversation.character_id
      ))
      AND ((reservation.intended_access_mode = 'standard' AND asset.preview_generated_at IS NOT NULL)
        OR (reservation.intended_access_mode = 'locked'
          AND private.setting_bool('locked_images_enabled', false)
          AND asset.locked_derivative_status = 'ready'));
    RETURN _path;
  END IF;

  IF _target_kind = 'message_attachment' THEN
    SELECT m.conversation_id INTO _conversation_id
    FROM public.message_attachments a JOIN public.messages m ON m.id = a.message_id
    WHERE a.id = _target_id;
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
