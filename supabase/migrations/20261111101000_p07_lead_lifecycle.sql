-- P07: one durable Lead per Client/character. A later Like records renewed
-- interest but never reopens a closed Lead or erases treatment history.

CREATE OR REPLACE FUNCTION private.capture_character_lead_from_like()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF NEW.liked_at IS NOT NULL
    AND (TG_OP = 'INSERT' OR OLD.liked_at IS NULL) THEN
    INSERT INTO public.client_character_leads AS lead (
      client_id,
      character_id,
      source,
      status,
      interest_active,
      created_at,
      last_liked_at,
      reopened_at,
      closed_at,
      updated_at,
      updated_by
    )
    VALUES (
      NEW.client_id,
      NEW.character_id,
      'discovery_like',
      'new',
      TRUE,
      NEW.liked_at,
      NEW.liked_at,
      NULL,
      NULL,
      NEW.liked_at,
      NEW.client_id
    )
    ON CONFLICT (client_id, character_id) DO UPDATE
    SET interest_active = TRUE,
        last_liked_at = GREATEST(lead.last_liked_at, EXCLUDED.last_liked_at),
        reopened_at = CASE
          WHEN lead.interest_active IS FALSE THEN EXCLUDED.last_liked_at
          ELSE lead.reopened_at
        END,
        -- Preserve status and closed_at. Staff may explicitly move an active,
        -- re-liked Lead through the authorized lifecycle RPC.
        updated_at = EXCLUDED.last_liked_at,
        updated_by = EXCLUDED.client_id;
  ELSIF TG_OP = 'UPDATE'
    AND OLD.liked_at IS NOT NULL
    AND NEW.liked_at IS NULL THEN
    UPDATE public.client_character_leads lead
    SET status = 'closed',
        interest_active = FALSE,
        closed_at = COALESCE(lead.closed_at, _now),
        updated_at = _now,
        updated_by = NEW.client_id
    WHERE lead.client_id = NEW.client_id
      AND lead.character_id = NEW.character_id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.capture_character_lead_from_like()
  FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
