-- WP04: complete the independent server-side profile/discovery contracts.
-- One canonical Lead is retained per client/character. A real unlike closes
-- the active interest without deleting history; a later real like reopens the
-- same row. Staff lifecycle updates never create outreach or NEW work.

INSERT INTO public.system_settings (key, value)
VALUES ('client_consent_policy_enabled', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE public.client_consent_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consent_key TEXT NOT NULL CHECK (consent_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  version TEXT NOT NULL CHECK (char_length(btrim(version)) BETWEEN 1 AND 80),
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  document_url TEXT NOT NULL CHECK (char_length(btrim(document_url)) BETWEEN 1 AND 1000),
  required BOOLEAN NOT NULL DEFAULT TRUE,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (retired_at IS NULL OR retired_at > activated_at),
  UNIQUE (consent_key, version)
);

CREATE UNIQUE INDEX client_consent_one_active_version_idx
  ON public.client_consent_documents(consent_key)
  WHERE retired_at IS NULL;

CREATE TABLE public.client_consent_acceptances (
  client_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES public.client_consent_documents(id) ON DELETE RESTRICT,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (client_id, document_id)
);

CREATE INDEX client_consent_acceptances_document_idx
  ON public.client_consent_acceptances(document_id, client_id);

ALTER TABLE public.client_consent_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_consent_acceptances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_consent_documents, public.client_consent_acceptances
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.client_consent_documents, public.client_consent_acceptances
  TO authenticated;

CREATE POLICY "Clients view active consent documents"
  ON public.client_consent_documents FOR SELECT TO authenticated
  USING (retired_at IS NULL OR public.is_admin());
CREATE POLICY "Clients view own consent acceptances"
  ON public.client_consent_acceptances FOR SELECT TO authenticated
  USING (client_id = (SELECT auth.uid()) OR public.is_admin());

CREATE OR REPLACE FUNCTION private.has_required_client_consents(_client_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.client_consent_documents document
    WHERE document.required IS TRUE
      AND document.retired_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.client_consent_acceptances acceptance
        WHERE acceptance.client_id = _client_id
          AND acceptance.document_id = document.id
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.get_client_consent_requirements()
RETURNS TABLE (
  id UUID,
  consent_key TEXT,
  version TEXT,
  title TEXT,
  document_url TEXT,
  required BOOLEAN,
  accepted_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _client UUID := auth.uid();
  _policy_enabled BOOLEAN := private.setting_bool('client_consent_policy_enabled', FALSE);
BEGIN
  IF _client IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT _policy_enabled THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.client_consent_documents document
    WHERE document.required IS TRUE AND document.retired_at IS NULL
  ) THEN
    RAISE EXCEPTION 'client_consent_policy_unconfigured';
  END IF;

  RETURN QUERY
  SELECT
    document.id,
    document.consent_key,
    document.version,
    document.title,
    document.document_url,
    document.required,
    acceptance.accepted_at
  FROM public.client_consent_documents document
  LEFT JOIN public.client_consent_acceptances acceptance
    ON acceptance.client_id = _client
   AND acceptance.document_id = document.id
  WHERE document.retired_at IS NULL
  ORDER BY document.required DESC, document.consent_key, document.version;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_client_consent(_document_id UUID)
RETURNS TABLE (document_id UUID, accepted_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _client UUID := auth.uid();
  _acceptance public.client_consent_acceptances%ROWTYPE;
BEGIN
  IF _client IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT private.setting_bool('client_consent_policy_enabled', FALSE) THEN
    RAISE EXCEPTION 'client_consent_policy_disabled';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.client_consent_documents document
    WHERE document.id = _document_id AND document.retired_at IS NULL
  ) THEN
    RAISE EXCEPTION 'client_consent_document_unavailable';
  END IF;

  INSERT INTO public.client_consent_acceptances (client_id, document_id)
  VALUES (_client, _document_id)
  ON CONFLICT (client_id, document_id) DO UPDATE
  SET accepted_at = client_consent_acceptances.accepted_at
  RETURNING * INTO _acceptance;

  document_id := _acceptance.document_id;
  accepted_at := _acceptance.accepted_at;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION private.has_required_client_consents(UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_client_consent_requirements() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.accept_client_consent(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_client_consent_requirements(),
  public.accept_client_consent(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION private.ensure_active_client(_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _mandatory_onboarding BOOLEAN := FALSE;
  _consent_policy_enabled BOOLEAN := FALSE;
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

  SELECT COALESCE((setting.value #>> '{}')::BOOLEAN, FALSE)
  INTO _mandatory_onboarding
  FROM public.system_settings setting
  WHERE setting.key = 'mandatory_onboarding_enabled';

  SELECT COALESCE((setting.value #>> '{}')::BOOLEAN, FALSE)
  INTO _consent_policy_enabled
  FROM public.system_settings setting
  WHERE setting.key = 'client_consent_policy_enabled';

  IF _consent_policy_enabled THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.client_consent_documents document
      WHERE document.required IS TRUE AND document.retired_at IS NULL
    ) THEN
      RAISE EXCEPTION 'client_consent_policy_unconfigured' USING ERRCODE = '42501';
    END IF;
    IF NOT private.has_required_client_consents(_user_id) THEN
      RAISE EXCEPTION 'client_consent_required' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF _mandatory_onboarding AND NOT EXISTS (
    SELECT 1
    FROM public.client_profiles profile
    WHERE profile.user_id = _user_id
      AND profile.onboarding_completed_at IS NOT NULL
      AND COALESCE(profile.computed_age, profile.age) BETWEEN 18 AND 120
      AND NULLIF(btrim(profile.first_name), '') IS NOT NULL
      AND NULLIF(btrim(profile.last_name), '') IS NOT NULL
      AND profile.city_id IS NOT NULL
      AND NULLIF(btrim(profile.bio), '') IS NOT NULL
      AND profile.relationship_status IS NOT NULL
      AND profile.smoking_status IS NOT NULL
      AND profile.preferred_min_age IS NOT NULL
      AND profile.preferred_max_age IS NOT NULL
      AND profile.preferred_distance_km IS NOT NULL
      AND jsonb_array_length(profile.content_preferences) > 0
      AND jsonb_array_length(profile.character_preferences) > 0
  ) THEN
    RAISE EXCEPTION 'client_onboarding_required' USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.ensure_active_client(UUID)
  FROM PUBLIC, anon, authenticated;

CREATE TABLE public.client_character_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  character_id UUID NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'discovery_like'
    CHECK (source = 'discovery_like'),
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'in_progress', 'closed')),
  interest_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_liked_at TIMESTAMPTZ NOT NULL,
  reopened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (client_id, character_id)
);

CREATE INDEX client_character_leads_character_created_idx
  ON public.client_character_leads(character_id, created_at DESC, id DESC);

ALTER TABLE public.client_character_leads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.client_character_leads FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.client_character_leads TO authenticated;

CREATE POLICY "Admins view all character leads"
  ON public.client_character_leads
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

CREATE POLICY "Assigned operators view character leads"
  ON public.client_character_leads
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.operators operator
      JOIN public.character_operator_assignments assignment
        ON assignment.operator_id = operator.id
      WHERE operator.user_id = (SELECT auth.uid())
        AND operator.is_active = TRUE
        AND assignment.character_id = client_character_leads.character_id
    )
  );

CREATE OR REPLACE FUNCTION private.capture_character_lead_from_like()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
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
    SET status = 'new',
        interest_active = TRUE,
        last_liked_at = GREATEST(lead.last_liked_at, EXCLUDED.last_liked_at),
        reopened_at = CASE
          WHEN lead.interest_active IS FALSE THEN EXCLUDED.last_liked_at
          ELSE lead.reopened_at
        END,
        closed_at = NULL,
        updated_at = EXCLUDED.last_liked_at,
        updated_by = EXCLUDED.client_id;
  ELSIF TG_OP = 'UPDATE'
    AND OLD.liked_at IS NOT NULL
    AND NEW.liked_at IS NULL THEN
    UPDATE public.client_character_leads lead
    SET status = 'closed',
        interest_active = FALSE,
        closed_at = clock_timestamp(),
        updated_at = clock_timestamp(),
        updated_by = NEW.client_id
    WHERE lead.client_id = NEW.client_id
      AND lead.character_id = NEW.character_id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.capture_character_lead_from_like()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS capture_character_lead_from_like
  ON public.client_character_preferences;
CREATE TRIGGER capture_character_lead_from_like
  AFTER INSERT OR UPDATE OF liked_at
  ON public.client_character_preferences
  FOR EACH ROW
  EXECUTE FUNCTION private.capture_character_lead_from_like();

INSERT INTO public.client_character_leads (
  client_id,
  character_id,
  source,
  status,
  interest_active,
  created_at,
  last_liked_at,
  updated_at,
  updated_by
)
SELECT
  preference.client_id,
  preference.character_id,
  'discovery_like',
  'new',
  TRUE,
  preference.liked_at,
  preference.liked_at,
  preference.liked_at,
  preference.client_id
FROM public.client_character_preferences preference
WHERE preference.liked_at IS NOT NULL
ON CONFLICT (client_id, character_id) DO UPDATE
SET last_liked_at = GREATEST(
  client_character_leads.last_liked_at,
  EXCLUDED.last_liked_at
),
    interest_active = TRUE,
    status = CASE
      WHEN client_character_leads.interest_active THEN client_character_leads.status
      ELSE 'new'
    END,
    reopened_at = CASE
      WHEN client_character_leads.interest_active THEN client_character_leads.reopened_at
      ELSE EXCLUDED.last_liked_at
    END,
    closed_at = CASE
      WHEN client_character_leads.interest_active THEN client_character_leads.closed_at
      ELSE NULL
    END,
    updated_at = GREATEST(client_character_leads.updated_at, EXCLUDED.updated_at),
    updated_by = EXCLUDED.updated_by;

CREATE OR REPLACE FUNCTION public.get_character_leads(
  _limit INTEGER DEFAULT 100
)
RETURNS TABLE (
  id UUID,
  client_id UUID,
  client_name TEXT,
  character_id UUID,
  character_name TEXT,
  source TEXT,
  status TEXT,
  interest_active BOOLEAN,
  created_at TIMESTAMPTZ,
  last_liked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _actor UUID := auth.uid();
  _operator_id UUID;
  _is_admin BOOLEAN := public.is_admin();
  _safe_limit INTEGER := LEAST(GREATEST(COALESCE(_limit, 100), 1), 200);
BEGIN
  IF _actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF NOT _is_admin THEN
    SELECT operator.id
    INTO _operator_id
    FROM public.operators operator
    WHERE operator.user_id = _actor
      AND operator.is_active = TRUE;

    IF _operator_id IS NULL THEN
      RAISE EXCEPTION 'operator_access_denied' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    lead.id,
    lead.client_id,
    COALESCE(NULLIF(btrim(profile.display_name), ''), 'לקוח'),
    lead.character_id,
    character.name,
    lead.source,
    lead.status,
    lead.interest_active,
    lead.created_at,
    lead.last_liked_at,
    lead.updated_at
  FROM public.client_character_leads lead
  JOIN public.characters character ON character.id = lead.character_id
  LEFT JOIN public.profiles profile ON profile.user_id = lead.client_id
  WHERE _is_admin
     OR EXISTS (
       SELECT 1
       FROM public.character_operator_assignments assignment
       WHERE assignment.operator_id = _operator_id
         AND assignment.character_id = lead.character_id
     )
  ORDER BY lead.last_liked_at DESC, lead.id DESC
  LIMIT _safe_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.get_character_leads(INTEGER)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_character_leads(INTEGER)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.update_character_lead_status(
  _lead_id UUID,
  _status TEXT
)
RETURNS TABLE (
  id UUID,
  status TEXT,
  interest_active BOOLEAN,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _actor UUID := auth.uid();
  _lead public.client_character_leads%ROWTYPE;
  _operator_id UUID;
BEGIN
  IF _actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF _status NOT IN ('new', 'in_progress', 'closed') THEN
    RAISE EXCEPTION 'invalid_lead_status';
  END IF;

  SELECT * INTO _lead
  FROM public.client_character_leads lead
  WHERE lead.id = _lead_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'lead_not_found';
  END IF;

  IF NOT public.is_admin() THEN
    SELECT operator.id INTO _operator_id
    FROM public.operators operator
    WHERE operator.user_id = _actor
      AND operator.is_active = TRUE;

    IF _operator_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.character_operator_assignments assignment
      WHERE assignment.operator_id = _operator_id
        AND assignment.character_id = _lead.character_id
    ) THEN
      RAISE EXCEPTION 'lead_update_denied' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF _status <> 'closed' AND _lead.interest_active IS FALSE THEN
    RAISE EXCEPTION 'lead_interest_inactive';
  END IF;

  UPDATE public.client_character_leads lead
  SET status = _status,
      closed_at = CASE WHEN _status = 'closed' THEN clock_timestamp() ELSE NULL END,
      updated_at = clock_timestamp(),
      updated_by = _actor
  WHERE lead.id = _lead_id
  RETURNING lead.id, lead.status, lead.interest_active, lead.updated_at
  INTO id, status, interest_active, updated_at;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _actor,
    'character_lead.status_changed',
    'client_character_lead',
    _lead_id::TEXT,
    jsonb_build_object('from', _lead.status, 'to', _status)
  );

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.update_character_lead_status(UUID, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_character_lead_status(UUID, TEXT)
  TO authenticated;

CREATE OR REPLACE FUNCTION private.discovery_distance_km(
  _origin_city_id UUID,
  _target_city_id UUID
)
RETURNS NUMERIC
LANGUAGE SQL
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN origin.latitude IS NULL
      OR origin.longitude IS NULL
      OR target.latitude IS NULL
      OR target.longitude IS NULL THEN NULL
    ELSE round((
      6371.0 * acos(
        LEAST(1.0, GREATEST(-1.0,
          cos(radians(origin.latitude::DOUBLE PRECISION))
          * cos(radians(target.latitude::DOUBLE PRECISION))
          * cos(radians(target.longitude::DOUBLE PRECISION - origin.longitude::DOUBLE PRECISION))
          + sin(radians(origin.latitude::DOUBLE PRECISION))
          * sin(radians(target.latitude::DOUBLE PRECISION))
        ))
      )
    )::NUMERIC, 1)
  END
  FROM public.discovery_cities origin
  JOIN public.discovery_cities target ON target.id = _target_city_id
  WHERE origin.id = _origin_city_id
    AND origin.is_active = TRUE
    AND target.is_active = TRUE;
$$;

REVOKE ALL ON FUNCTION private.discovery_distance_km(UUID, UUID)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.character_live_availability(
  _character_id UUID,
  _configured public.availability_status
)
RETURNS public.availability_status
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT CASE
    WHEN COALESCE(_configured, 'offline'::public.availability_status) = 'offline'::public.availability_status
      THEN 'offline'::public.availability_status
    WHEN EXISTS (
      SELECT 1
      FROM public.character_operator_assignments assignment
      JOIN public.operators operator ON operator.id = assignment.operator_id
      WHERE assignment.character_id = _character_id
        AND operator.is_active IS TRUE
        AND operator.deleted_at IS NULL
        AND operator.presence_status = 'online'
        AND operator.last_seen_at IS NOT NULL
        AND operator.last_seen_at >= clock_timestamp()
          - make_interval(mins => GREATEST(private.setting_int('operator_heartbeat_stale_minutes', 2), 1))
    ) THEN _configured
    ELSE 'offline'::public.availability_status
  END;
$$;

REVOKE ALL ON FUNCTION private.character_live_availability(UUID, public.availability_status)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.normalize_discovery_filters(_filters JSONB)
RETURNS TABLE (
  filter_hash TEXT,
  min_age INTEGER,
  max_age INTEGER,
  city_id UUID
)
LANGUAGE plpgsql
SET search_path = public, private
AS $$
DECLARE
  _input JSONB := COALESCE(_filters, '{}'::JSONB);
  _raw_min_age TEXT;
  _raw_max_age TEXT;
  _raw_city_id TEXT;
  _raw_interest TEXT;
  _raw_max_distance TEXT;
  _favorites_only BOOLEAN := FALSE;
  _recycled_only BOOLEAN := FALSE;
  _interest TEXT;
  _max_distance INTEGER;
  _canonical JSONB;
BEGIN
  IF jsonb_typeof(_input) <> 'object' THEN
    RAISE EXCEPTION 'invalid_discovery_filters';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(_input) AS key_name(key)
    WHERE key NOT IN (
      'min_age', 'max_age', 'city_id', 'max_distance_km',
      'favorites_only', 'recycled_only', 'interest'
    )
  ) THEN
    RAISE EXCEPTION 'unsupported_discovery_filter';
  END IF;

  _raw_min_age := _input ->> 'min_age';
  _raw_max_age := _input ->> 'max_age';
  _raw_city_id := _input ->> 'city_id';
  _raw_interest := _input ->> 'interest';
  _raw_max_distance := _input ->> 'max_distance_km';

  IF _raw_min_age IS NOT NULL THEN
    IF jsonb_typeof(_input -> 'min_age') <> 'number'
      OR _raw_min_age !~ '^[0-9]{1,3}$' THEN
      RAISE EXCEPTION 'invalid_discovery_min_age';
    END IF;
    min_age := _raw_min_age::INTEGER;
    IF min_age NOT BETWEEN 18 AND 120 THEN
      RAISE EXCEPTION 'discovery_min_age_out_of_range';
    END IF;
  END IF;

  IF _raw_max_age IS NOT NULL THEN
    IF jsonb_typeof(_input -> 'max_age') <> 'number'
      OR _raw_max_age !~ '^[0-9]{1,3}$' THEN
      RAISE EXCEPTION 'invalid_discovery_max_age';
    END IF;
    max_age := _raw_max_age::INTEGER;
    IF max_age NOT BETWEEN 18 AND 120 THEN
      RAISE EXCEPTION 'discovery_max_age_out_of_range';
    END IF;
  END IF;

  IF min_age IS NOT NULL AND max_age IS NOT NULL AND min_age > max_age THEN
    RAISE EXCEPTION 'invalid_discovery_age_range';
  END IF;

  IF _raw_city_id IS NOT NULL THEN
    _raw_city_id := lower(_raw_city_id);
    IF jsonb_typeof(_input -> 'city_id') <> 'string'
      OR _raw_city_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid_discovery_city';
    END IF;
    city_id := _raw_city_id::UUID;
    IF NOT EXISTS (
      SELECT 1 FROM public.discovery_cities city
      WHERE city.id = city_id AND city.is_active = TRUE
    ) THEN
      RAISE EXCEPTION 'invalid_discovery_city';
    END IF;
  END IF;

  IF _raw_max_distance IS NOT NULL THEN
    IF jsonb_typeof(_input -> 'max_distance_km') <> 'number'
      OR _raw_max_distance !~ '^[0-9]{1,4}$' THEN
      RAISE EXCEPTION 'invalid_discovery_distance';
    END IF;
    _max_distance := _raw_max_distance::INTEGER;
    IF _max_distance NOT BETWEEN 1 AND 1000 THEN
      RAISE EXCEPTION 'discovery_distance_out_of_range';
    END IF;
  END IF;

  IF _input ? 'favorites_only' THEN
    IF jsonb_typeof(_input -> 'favorites_only') <> 'boolean' THEN
      RAISE EXCEPTION 'invalid_discovery_favorites_only';
    END IF;
    _favorites_only := (_input ->> 'favorites_only')::BOOLEAN;
  END IF;

  IF _input ? 'recycled_only' THEN
    IF jsonb_typeof(_input -> 'recycled_only') <> 'boolean' THEN
      RAISE EXCEPTION 'invalid_discovery_recycled_only';
    END IF;
    _recycled_only := (_input ->> 'recycled_only')::BOOLEAN;
  END IF;

  IF _raw_interest IS NOT NULL THEN
    IF jsonb_typeof(_input -> 'interest') <> 'string' THEN
      RAISE EXCEPTION 'invalid_discovery_interest';
    END IF;
    _interest := lower(btrim(_raw_interest));
    IF _interest = '' OR char_length(_interest) > 80 THEN
      RAISE EXCEPTION 'invalid_discovery_interest';
    END IF;
  END IF;

  _canonical := jsonb_build_object(
    'v', 4,
    'min_age', min_age,
    'max_age', max_age,
    'city_id', city_id,
    'max_distance_km', _max_distance,
    'favorites_only', _favorites_only,
    'recycled_only', _recycled_only,
    'interest', _interest
  );

  filter_hash := 'v4:' || md5(_canonical::TEXT);
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_discovery_characters(
  _filters JSONB DEFAULT '{}'::JSONB
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  avatar_url TEXT,
  fictional_age INTEGER,
  short_description TEXT,
  category TEXT,
  interests TEXT[],
  availability_status public.availability_status,
  created_at TIMESTAMPTZ,
  cycle_id UUID,
  cycle_number INTEGER,
  is_liked BOOLEAN,
  is_favorite BOOLEAN,
  conversation_id UUID,
  is_recycled BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _client UUID := auth.uid();
  _favorites_only BOOLEAN;
  _recycled_only BOOLEAN;
  _interest TEXT;
  _max_distance INTEGER;
  _origin_city_id UUID;
  _candidate_distance NUMERIC;
  _selected_cycle_id UUID;
  _selected_character_id UUID;
BEGIN
  IF _client IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  PERFORM private.ensure_active_client(_client);
  PERFORM 1 FROM private.normalize_discovery_filters(_filters);

  _favorites_only := COALESCE((_filters ->> 'favorites_only')::BOOLEAN, FALSE);
  _recycled_only := COALESCE((_filters ->> 'recycled_only')::BOOLEAN, FALSE);
  _interest := NULLIF(lower(btrim(_filters ->> 'interest')), '');
  _max_distance := NULLIF(_filters ->> 'max_distance_km', '')::INTEGER;

  SELECT profile.city_id
  INTO _origin_city_id
  FROM public.client_profiles profile
  WHERE profile.user_id = _client;

  IF _max_distance IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.characters character
    LEFT JOIN public.client_character_preferences preference
      ON preference.client_id = _client
     AND preference.character_id = character.id
    WHERE character.is_active = TRUE
      AND character.is_visible = TRUE
      AND private.discovery_distance_km(_origin_city_id, character.discovery_city_id)
        <= _max_distance
      AND (NOT _favorites_only OR preference.is_favorite IS TRUE)
      AND (NOT _recycled_only OR COALESCE(preference.shown_count, 0) > 0)
      AND (_interest IS NULL OR EXISTS (
        SELECT 1
        FROM unnest(COALESCE(character.interests, ARRAY[]::TEXT[])) interest_name(value)
        WHERE lower(interest_name.value) = _interest
      ))
  ) THEN
    RETURN;
  END IF;

  LOOP
    SELECT base.*
    INTO id, name, avatar_url, fictional_age, short_description, category,
      interests, availability_status, created_at, cycle_id, cycle_number,
      is_liked, is_favorite, conversation_id, is_recycled
    FROM public.get_discovery_characters_base(_filters) base
    LIMIT 1;

    IF NOT FOUND THEN
      RETURN;
    END IF;

    SELECT private.discovery_distance_km(_origin_city_id, character.discovery_city_id)
    INTO _candidate_distance
    FROM public.characters character
    WHERE character.id = id;

    availability_status := private.character_live_availability(id, availability_status);

    IF (NOT _favorites_only OR is_favorite)
      AND (NOT _recycled_only OR is_recycled)
      AND (_interest IS NULL OR EXISTS (
        SELECT 1
        FROM unnest(COALESCE(interests, ARRAY[]::TEXT[])) interest_name(value)
        WHERE lower(interest_name.value) = _interest
      ))
      AND (_max_distance IS NULL OR _candidate_distance <= _max_distance) THEN
      RETURN NEXT;
      RETURN;
    END IF;

    _selected_cycle_id := cycle_id;
    _selected_character_id := id;

    UPDATE public.client_discovery_cycle_items item
    SET action = 'expired', acted_at = now()
    WHERE item.cycle_id = _selected_cycle_id
      AND item.character_id = _selected_character_id
      AND item.action IS NULL;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.start_or_get_conversation(_character_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _client UUID;
  _conversation_id UUID;
  _character_available BOOLEAN;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  _client := auth.uid();

  IF _client IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  PERFORM private.ensure_active_client(_client);

  SELECT character.is_active AND character.is_visible
  INTO _character_available
  FROM public.characters character
  WHERE character.id = _character_id;

  IF _character_available IS NOT TRUE THEN
    RAISE EXCEPTION 'character_not_available';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(_client::TEXT), hashtext(_character_id::TEXT));

  SELECT conversation.id
  INTO _conversation_id
  FROM public.conversations conversation
  WHERE conversation.client_id = _client
    AND conversation.character_id = _character_id
    AND conversation.status <> 'closed'::public.conversation_status
    AND conversation.client_hidden_at IS NULL
  FOR UPDATE;

  IF _conversation_id IS NOT NULL THEN
    RETURN _conversation_id;
  END IF;

  INSERT INTO public.conversations (
    client_id,
    character_id,
    assigned_operator_id,
    status,
    client_hidden_at
  )
  VALUES (
    _client,
    _character_id,
    NULL,
    'waiting'::public.conversation_status,
    NULL
  )
  ON CONFLICT (client_id, character_id)
  WHERE status <> 'closed'::public.conversation_status
    AND client_hidden_at IS NULL
  DO NOTHING
  RETURNING conversations.id INTO _conversation_id;

  IF _conversation_id IS NULL THEN
    SELECT conversation.id
    INTO _conversation_id
    FROM public.conversations conversation
    WHERE conversation.client_id = _client
      AND conversation.character_id = _character_id
      AND conversation.status <> 'closed'::public.conversation_status
      AND conversation.client_hidden_at IS NULL
    FOR UPDATE;
  END IF;

  IF _conversation_id IS NULL THEN
    RAISE EXCEPTION 'conversation_creation_conflict';
  END IF;

  RETURN _conversation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.start_or_get_conversation(UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_or_get_conversation(UUID)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
