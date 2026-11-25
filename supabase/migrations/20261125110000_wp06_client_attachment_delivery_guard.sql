-- The client-upload finalizer has no character reservation. Validate that source separately.
CREATE OR REPLACE FUNCTION private.assert_message_attachment_delivery_mode()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _reservation_mode TEXT;
  _locked_price INTEGER;
BEGIN
  IF NEW.client_upload_id IS NOT NULL THEN
    IF NEW.media_asset_id IS NOT NULL
      OR NEW.reservation_id IS NOT NULL
      OR NEW.access_mode IS DISTINCT FROM 'standard'
      OR NEW.view_mode IS DISTINCT FROM 'client_24h'
      OR NEW.kind IS DISTINCT FROM 'image'
      OR NEW.price_credits_snapshot IS NOT NULL
      OR NOT EXISTS (
        SELECT 1
        FROM public.client_media_uploads upload
        JOIN public.messages message ON message.id = NEW.message_id
          AND message.conversation_id = upload.conversation_id
        JOIN public.conversations conversation ON conversation.id = upload.conversation_id
        WHERE upload.id = NEW.client_upload_id
          AND upload.status = 'processing'
          AND message.sender_type = 'client'::public.sender_type
          AND message.sender_id = upload.client_id
          AND conversation.client_id = upload.client_id
          AND NEW.access_expires_at = message.created_at + interval '24 hours'
      ) THEN
      RAISE EXCEPTION 'client_media_attachment_source_mismatch';
    END IF;
    RETURN NEW;
  END IF;

  SELECT reservation.intended_access_mode, asset.locked_price_credits
  INTO _reservation_mode, _locked_price
  FROM public.character_media_reservations reservation
  JOIN public.character_media_assets asset ON asset.id = reservation.media_asset_id
  WHERE reservation.id = NEW.reservation_id
    AND reservation.media_asset_id = NEW.media_asset_id;

  IF NOT FOUND OR _reservation_mode <> NEW.access_mode THEN
    RAISE EXCEPTION 'media_reservation_access_mode_mismatch';
  END IF;

  IF NEW.access_mode = 'standard' AND _locked_price IS NOT NULL THEN
    RAISE EXCEPTION 'media_asset_requires_locked_delivery';
  END IF;

  RETURN NEW;
END;
$$;
