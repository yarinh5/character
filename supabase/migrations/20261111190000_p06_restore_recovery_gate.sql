-- P06/P04: fail-closed restore recovery gate. This migration prepares recovery controls only.
-- It does not execute a restore, alter balances, replay deletion, or release an external lock.

CREATE TABLE private.restore_recovery_events (
  id UUID PRIMARY KEY,
  external_lock_id TEXT NOT NULL UNIQUE CHECK (char_length(btrim(external_lock_id)) BETWEEN 8 AND 200),
  external_authority_id TEXT NOT NULL CHECK (char_length(btrim(external_authority_id)) BETWEEN 3 AND 200),
  source_snapshot_id TEXT NOT NULL CHECK (char_length(btrim(source_snapshot_id)) BETWEEN 3 AND 300),
  source_snapshot_at TIMESTAMPTZ NOT NULL,
  owner_admin_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'blocked' CHECK (status IN (
    'blocked', 'reconciling', 'deletions_pending', 'ready_for_approval',
    'approved_pending_external_release', 'reopened', 'failed'
  )),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  import_failure_code TEXT CHECK (import_failure_code IS NULL OR char_length(import_failure_code) BETWEEN 3 AND 120),
  approval_event_id UUID,
  approval_version INTEGER,
  approved_by UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  external_release_evidence_hash TEXT CHECK (
    external_release_evidence_hash IS NULL OR external_release_evidence_hash ~ '^[0-9a-f]{64}$'
  ),
  reopened_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((approval_event_id IS NULL) = (approval_version IS NULL)),
  CHECK ((approved_at IS NULL) = (approved_by IS NULL)),
  CHECK (reopened_at IS NULL OR status = 'reopened')
);

CREATE TABLE private.restore_recovery_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  access_state TEXT NOT NULL CHECK (access_state IN ('open', 'blocked')),
  current_event_id UUID REFERENCES private.restore_recovery_events(id) ON DELETE RESTRICT,
  recovery_deletion_replay_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((access_state = 'open' AND current_event_id IS NULL) OR (access_state = 'blocked' AND current_event_id IS NOT NULL))
);
INSERT INTO private.restore_recovery_control(singleton, access_state, current_event_id)
VALUES (TRUE, 'open', NULL);

CREATE TABLE private.restore_recovery_requirements (
  event_id UUID NOT NULL REFERENCES private.restore_recovery_events(id) ON DELETE CASCADE,
  requirement_name TEXT NOT NULL CHECK (requirement_name IN (
    'external_lock', 'ledger_reconciliation', 'deletion_replay', 'personal_data_review'
  )),
  status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'missing', 'gap', 'unknown', 'failed')),
  evidence_source TEXT,
  evidence_hash TEXT CHECK (evidence_hash IS NULL OR evidence_hash ~ '^[0-9a-f]{64}$'),
  evidence_recorded_at TIMESTAMPTZ,
  verified_by UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  reason_code TEXT CHECK (reason_code IS NULL OR char_length(reason_code) BETWEEN 3 AND 120),
  event_version INTEGER NOT NULL CHECK (event_version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (event_id, requirement_name)
);

CREATE TABLE private.restore_recovery_authority_manifests (
  event_id UUID NOT NULL REFERENCES private.restore_recovery_events(id) ON DELETE CASCADE,
  manifest_id TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  previous_manifest_hash TEXT CHECK (previous_manifest_hash IS NULL OR previous_manifest_hash ~ '^[0-9a-f]{64}$'),
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  coverage_through TIMESTAMPTZ NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL,
  deletion_coverage_complete BOOLEAN NOT NULL DEFAULT FALSE,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (event_id, manifest_id),
  UNIQUE (event_id, sequence),
  UNIQUE (event_id, manifest_hash)
);

CREATE TABLE private.restore_recovery_reconciliation_results (
  event_id UUID NOT NULL REFERENCES private.restore_recovery_events(id) ON DELETE CASCADE,
  manifest_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('credit_ledger', 'gift_purchases', 'credit_requests')),
  outcome TEXT NOT NULL CHECK (outcome IN ('matched', 'gap', 'unknown')),
  matched_count BIGINT NOT NULL CHECK (matched_count >= 0),
  gap_count BIGINT NOT NULL CHECK (gap_count >= 0),
  unknown_count BIGINT NOT NULL CHECK (unknown_count >= 0),
  evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (event_id, manifest_id, category),
  FOREIGN KEY (event_id, manifest_id)
    REFERENCES private.restore_recovery_authority_manifests(event_id, manifest_id) ON DELETE CASCADE,
  CHECK (outcome <> 'matched' OR (gap_count = 0 AND unknown_count = 0))
);

CREATE TABLE private.restore_recovery_deletion_replay (
  event_id UUID NOT NULL REFERENCES private.restore_recovery_events(id) ON DELETE CASCADE,
  manifest_id TEXT NOT NULL,
  request_kind TEXT NOT NULL CHECK (request_kind IN ('account', 'conversation')),
  request_id UUID NOT NULL,
  policy_version TEXT NOT NULL,
  authoritative_completed_at TIMESTAMPTZ NOT NULL,
  authoritative_evidence_hash TEXT NOT NULL CHECK (authoritative_evidence_hash ~ '^[0-9a-f]{64}$'),
  hold BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'processing', 'already_applied', 'replayed', 'held',
    'missing_source_reference', 'failed'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  claim_token UUID,
  lease_expires_at TIMESTAMPTZ,
  failure_code TEXT CHECK (failure_code IS NULL OR char_length(failure_code) BETWEEN 3 AND 120),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (event_id, request_kind, request_id),
  FOREIGN KEY (event_id, manifest_id)
    REFERENCES private.restore_recovery_authority_manifests(event_id, manifest_id) ON DELETE CASCADE,
  CHECK ((status = 'processing') = (claim_token IS NOT NULL)),
  CHECK ((status = 'processing') = (lease_expires_at IS NOT NULL))
);
CREATE INDEX restore_recovery_deletion_replay_claim_idx
  ON private.restore_recovery_deletion_replay(event_id, status, updated_at);

REVOKE ALL ON TABLE private.restore_recovery_events, private.restore_recovery_control,
  private.restore_recovery_requirements, private.restore_recovery_authority_manifests,
  private.restore_recovery_reconciliation_results, private.restore_recovery_deletion_replay
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.recovery_business_open()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = private, pg_temp
AS $$
  SELECT COALESCE((
    SELECT control.access_state = 'open' AND control.current_event_id IS NULL
    FROM private.restore_recovery_control control WHERE control.singleton
  ), FALSE);
$$;
REVOKE ALL ON FUNCTION private.recovery_business_open() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.recovery_business_open() TO authenticated;

CREATE OR REPLACE FUNCTION private.ensure_recovery_business_open()
RETURNS VOID
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = private, pg_temp
AS $$
BEGIN
  IF NOT private.recovery_business_open() THEN
    RAISE EXCEPTION 'system_recovery_blocked' USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION private.ensure_recovery_business_open() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_restore_recovery_access_state()
RETURNS TABLE (blocked BOOLEAN, event_id UUID, event_version INTEGER, status TEXT)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = private, pg_temp
AS $$
  SELECT control.access_state = 'blocked', event.id, event.version, event.status
  FROM private.restore_recovery_control control
  LEFT JOIN private.restore_recovery_events event ON event.id = control.current_event_id
  WHERE control.singleton;
$$;
REVOKE ALL ON FUNCTION public.get_restore_recovery_access_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_restore_recovery_access_state() TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_admin_restore_recovery_state()
RETURNS TABLE (
  event_id UUID, event_version INTEGER, status TEXT, external_lock_id TEXT,
  external_authority_id TEXT, source_snapshot_id TEXT, source_snapshot_at TIMESTAMPTZ,
  owner_admin_id UUID, requirement_name TEXT, requirement_status TEXT,
  evidence_source TEXT, evidence_recorded_at TIMESTAMPTZ, reason_code TEXT,
  approved_by UUID, approved_at TIMESTAMPTZ, reopened_at TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT event.id, event.version, event.status, event.external_lock_id,
    event.external_authority_id, event.source_snapshot_id, event.source_snapshot_at,
    event.owner_admin_id, requirement.requirement_name, requirement.status,
    requirement.evidence_source, requirement.evidence_recorded_at, requirement.reason_code,
    event.approved_by, event.approved_at, event.reopened_at
  FROM private.restore_recovery_control control
  JOIN private.restore_recovery_events event ON event.id = control.current_event_id
  LEFT JOIN private.restore_recovery_requirements requirement ON requirement.event_id = event.id
  WHERE control.singleton
  ORDER BY requirement.requirement_name;
END;
$$;
REVOKE ALL ON FUNCTION public.get_admin_restore_recovery_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_restore_recovery_state() TO authenticated;

CREATE OR REPLACE FUNCTION public.begin_restore_recovery_for_server(
  _event_id UUID, _external_lock_id TEXT, _external_authority_id TEXT,
  _source_snapshot_id TEXT, _source_snapshot_at TIMESTAMPTZ,
  _owner_admin_id UUID, _external_lock_evidence_hash TEXT
)
RETURNS TABLE (event_id UUID, event_version INTEGER, status TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _control private.restore_recovery_control%ROWTYPE; _event private.restore_recovery_events%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF _event_id IS NULL OR _source_snapshot_at IS NULL
    OR char_length(btrim(COALESCE(_external_lock_id, ''))) NOT BETWEEN 8 AND 200
    OR char_length(btrim(COALESCE(_external_authority_id, ''))) NOT BETWEEN 3 AND 200
    OR char_length(btrim(COALESCE(_source_snapshot_id, ''))) NOT BETWEEN 3 AND 300
    OR COALESCE(_external_lock_evidence_hash, '') !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'invalid_restore_recovery_identity'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles role
    WHERE role.user_id = _owner_admin_id AND role.role = 'admin'::public.app_role
  ) THEN RAISE EXCEPTION 'recovery_owner_must_be_admin'; END IF;

  SELECT * INTO STRICT _control FROM private.restore_recovery_control WHERE singleton FOR UPDATE;
  IF _control.current_event_id IS NOT NULL THEN
    SELECT * INTO STRICT _event FROM private.restore_recovery_events WHERE id = _control.current_event_id;
    IF _event.id = _event_id AND _event.external_lock_id = _external_lock_id
      AND _event.external_authority_id = _external_authority_id
      AND _event.source_snapshot_id = _source_snapshot_id
    THEN RETURN QUERY SELECT _event.id, _event.version, _event.status; RETURN;
    END IF;
    RAISE EXCEPTION 'restore_recovery_event_already_active';
  END IF;

  INSERT INTO private.restore_recovery_events(
    id, external_lock_id, external_authority_id, source_snapshot_id,
    source_snapshot_at, owner_admin_id, status
  ) VALUES (
    _event_id, btrim(_external_lock_id), btrim(_external_authority_id),
    btrim(_source_snapshot_id), _source_snapshot_at, _owner_admin_id, 'blocked'
  ) RETURNING * INTO _event;
  INSERT INTO private.restore_recovery_requirements(
    event_id, requirement_name, status, evidence_source, evidence_hash,
    evidence_recorded_at, event_version
  ) VALUES
    (_event_id, 'external_lock', 'verified', btrim(_external_authority_id),
      _external_lock_evidence_hash, clock_timestamp(), _event.version),
    (_event_id, 'ledger_reconciliation', 'pending', NULL, NULL, NULL, _event.version),
    (_event_id, 'deletion_replay', 'pending', NULL, NULL, NULL, _event.version),
    (_event_id, 'personal_data_review', 'pending', NULL, NULL, NULL, _event.version);
  UPDATE private.restore_recovery_control SET
    access_state = 'blocked', current_event_id = _event_id,
    recovery_deletion_replay_enabled = FALSE, updated_at = clock_timestamp()
  WHERE singleton;
  INSERT INTO public.audit_logs(actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (NULL, 'recovery.restore.blocked', 'restore_recovery_event', _event_id::TEXT,
    jsonb_build_object('owner_admin_id', _owner_admin_id, 'source_snapshot_id', _source_snapshot_id,
      'external_authority_id', _external_authority_id));
  INSERT INTO public.notifications(user_id, type, title, body)
  SELECT DISTINCT role.user_id, 'restore_recovery_blocked', 'המערכת חסומה לאחר שחזור',
    'נדרש להשלים reconciliation והחלת מחיקות לפני פתיחה.'
  FROM public.user_roles role WHERE role.role = 'admin'::public.app_role;
  RETURN QUERY SELECT _event.id, _event.version, _event.status;
END;
$$;

CREATE OR REPLACE FUNCTION public.import_restore_recovery_manifest_for_server(
  _event_id UUID, _event_version INTEGER, _manifest_id TEXT,
  _authority_id TEXT, _sequence BIGINT, _previous_manifest_hash TEXT,
  _manifest_hash TEXT, _coverage_through TIMESTAMPTZ, _generated_at TIMESTAMPTZ,
  _deletion_coverage_complete BOOLEAN
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path = private, pg_temp
AS $$
DECLARE _event private.restore_recovery_events%ROWTYPE; _previous private.restore_recovery_authority_manifests%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  SELECT * INTO STRICT _event FROM private.restore_recovery_events WHERE id = _event_id FOR UPDATE;
  IF _event.version <> _event_version OR _event.status IN ('reopened', 'approved_pending_external_release') THEN
    RAISE EXCEPTION 'restore_recovery_event_stale';
  END IF;
  IF _event.external_authority_id <> _authority_id OR _manifest_hash !~ '^[0-9a-f]{64}$'
    OR (_previous_manifest_hash IS NOT NULL AND _previous_manifest_hash !~ '^[0-9a-f]{64}$')
    OR _coverage_through IS NULL OR _generated_at IS NULL OR _generated_at > clock_timestamp() + interval '5 minutes'
  THEN RAISE EXCEPTION 'invalid_restore_authority_manifest'; END IF;
  SELECT * INTO _previous FROM private.restore_recovery_authority_manifests
  WHERE event_id = _event_id ORDER BY sequence DESC LIMIT 1;
  IF FOUND AND (_sequence <> _previous.sequence + 1 OR _previous_manifest_hash IS DISTINCT FROM _previous.manifest_hash) THEN
    RAISE EXCEPTION 'restore_authority_manifest_sequence_gap';
  ELSIF NOT FOUND AND (_sequence <> 1 OR _previous_manifest_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'restore_authority_manifest_initial_sequence_invalid';
  END IF;
  INSERT INTO private.restore_recovery_authority_manifests(
    event_id, manifest_id, authority_id, sequence, previous_manifest_hash,
    manifest_hash, coverage_through, generated_at, deletion_coverage_complete
  ) VALUES (_event_id, btrim(_manifest_id), _authority_id, _sequence,
    _previous_manifest_hash, _manifest_hash, _coverage_through, _generated_at,
    _deletion_coverage_complete)
  ON CONFLICT (event_id, manifest_id) DO NOTHING;
  IF NOT FOUND THEN
    PERFORM 1 FROM private.restore_recovery_authority_manifests manifest
    WHERE manifest.event_id = _event_id AND manifest.manifest_id = _manifest_id
      AND manifest.sequence = _sequence AND manifest.manifest_hash = _manifest_hash
      AND manifest.coverage_through = _coverage_through;
    IF NOT FOUND THEN RAISE EXCEPTION 'restore_authority_manifest_conflict'; END IF;
  END IF;
  UPDATE private.restore_recovery_events SET status = 'reconciling', updated_at = clock_timestamp()
  WHERE id = _event_id AND status IN ('blocked', 'failed');
  RETURN jsonb_build_object('imported', TRUE, 'manifest_id', _manifest_id, 'sequence', _sequence);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_restore_reconciliation_for_server(
  _event_id UUID, _event_version INTEGER, _manifest_id TEXT, _category TEXT,
  _outcome TEXT, _matched_count BIGINT, _gap_count BIGINT,
  _unknown_count BIGINT, _evidence_hash TEXT
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = private, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  PERFORM 1 FROM private.restore_recovery_events event
  WHERE event.id = _event_id AND event.version = _event_version
    AND event.status NOT IN ('reopened', 'approved_pending_external_release') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'restore_recovery_event_stale'; END IF;
  INSERT INTO private.restore_recovery_reconciliation_results(
    event_id, manifest_id, category, outcome, matched_count,
    gap_count, unknown_count, evidence_hash
  ) VALUES (_event_id, _manifest_id, _category, _outcome,
    _matched_count, _gap_count, _unknown_count, _evidence_hash)
  ON CONFLICT (event_id, manifest_id, category) DO UPDATE SET
    outcome = EXCLUDED.outcome, matched_count = EXCLUDED.matched_count,
    gap_count = EXCLUDED.gap_count, unknown_count = EXCLUDED.unknown_count,
    evidence_hash = EXCLUDED.evidence_hash, recorded_at = clock_timestamp();
END;
$$;

CREATE OR REPLACE FUNCTION public.stage_restore_deletion_replay_for_server(
  _event_id UUID, _event_version INTEGER, _manifest_id TEXT,
  _request_kind TEXT, _request_id UUID, _policy_version TEXT,
  _completed_at TIMESTAMPTZ, _evidence_hash TEXT, _hold BOOLEAN
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _status TEXT; _local private.deletion_completion_ledger%ROWTYPE; _request_exists BOOLEAN;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  PERFORM 1 FROM private.restore_recovery_events event
  WHERE event.id = _event_id AND event.version = _event_version
    AND event.status NOT IN ('reopened', 'approved_pending_external_release') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'restore_recovery_event_stale'; END IF;
  IF _request_kind NOT IN ('account', 'conversation') THEN RAISE EXCEPTION 'invalid_deletion_request_kind'; END IF;
  SELECT * INTO _local FROM private.deletion_completion_ledger ledger
  WHERE ledger.request_kind = _request_kind AND ledger.request_id = _request_id;
  IF FOUND AND _local.evidence_hash = _evidence_hash
    AND _local.active_system_completed_at >= _completed_at
  THEN _status := 'already_applied';
  ELSE
    SELECT CASE WHEN _request_kind = 'account'
      THEN EXISTS (SELECT 1 FROM public.account_deletion_requests request WHERE request.id = _request_id)
      ELSE EXISTS (SELECT 1 FROM public.conversation_deletion_requests request WHERE request.id = _request_id)
    END INTO _request_exists;
    _status := CASE WHEN _hold THEN 'held'
      WHEN NOT _request_exists THEN 'missing_source_reference'
      ELSE 'pending' END;
  END IF;
  INSERT INTO private.restore_recovery_deletion_replay(
    event_id, manifest_id, request_kind, request_id, policy_version,
    authoritative_completed_at, authoritative_evidence_hash, hold, status,
    completed_at
  ) VALUES (_event_id, _manifest_id, _request_kind, _request_id, _policy_version,
    _completed_at, _evidence_hash, _hold, _status,
    CASE WHEN _status = 'already_applied' THEN clock_timestamp() END)
  ON CONFLICT (event_id, request_kind, request_id) DO UPDATE SET
    manifest_id = EXCLUDED.manifest_id, policy_version = EXCLUDED.policy_version,
    authoritative_completed_at = EXCLUDED.authoritative_completed_at,
    authoritative_evidence_hash = EXCLUDED.authoritative_evidence_hash,
    hold = EXCLUDED.hold, status = CASE
      WHEN private.restore_recovery_deletion_replay.status IN ('replayed', 'already_applied')
        THEN private.restore_recovery_deletion_replay.status
      ELSE EXCLUDED.status END,
    updated_at = clock_timestamp();
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_restore_recovery_import_for_server(
  _event_id UUID, _event_version INTEGER
)
RETURNS TABLE (status TEXT, event_version INTEGER)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = private, pg_temp
AS $$
DECLARE _ledger_status TEXT; _deletion_status TEXT; _event private.restore_recovery_events%ROWTYPE;
  _manifest private.restore_recovery_authority_manifests%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  SELECT * INTO STRICT _event FROM private.restore_recovery_events WHERE id = _event_id FOR UPDATE;
  IF _event.version <> _event_version OR _event.status IN ('reopened', 'approved_pending_external_release') THEN
    RAISE EXCEPTION 'restore_recovery_event_stale';
  END IF;
  SELECT * INTO _manifest FROM private.restore_recovery_authority_manifests
  WHERE event_id = _event_id ORDER BY sequence DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'restore_authority_manifest_missing'; END IF;

  IF EXISTS (
    SELECT category FROM unnest(ARRAY['credit_ledger','gift_purchases','credit_requests']) category
    WHERE NOT EXISTS (
      SELECT 1 FROM private.restore_recovery_reconciliation_results result
      WHERE result.event_id = _event_id AND result.manifest_id = _manifest.manifest_id
        AND result.category = category
    )
  ) THEN _ledger_status := 'unknown';
  ELSIF EXISTS (
    SELECT 1 FROM private.restore_recovery_reconciliation_results result
    WHERE result.event_id = _event_id AND result.manifest_id = _manifest.manifest_id
      AND (result.outcome = 'gap' OR result.gap_count > 0)
  ) THEN _ledger_status := 'gap';
  ELSIF EXISTS (
    SELECT 1 FROM private.restore_recovery_reconciliation_results result
    WHERE result.event_id = _event_id AND result.manifest_id = _manifest.manifest_id
      AND (result.outcome = 'unknown' OR result.unknown_count > 0)
  ) THEN _ledger_status := 'unknown';
  ELSE _ledger_status := 'verified'; END IF;

  IF NOT _manifest.deletion_coverage_complete THEN _deletion_status := 'missing';
  ELSIF EXISTS (
    SELECT 1 FROM private.restore_recovery_deletion_replay replay
    WHERE replay.event_id = _event_id
      AND replay.status IN ('pending','processing','held','missing_source_reference','failed')
  ) THEN _deletion_status := 'pending';
  ELSE _deletion_status := 'verified'; END IF;

  UPDATE private.restore_recovery_requirements requirement SET
    status = CASE requirement.requirement_name
      WHEN 'ledger_reconciliation' THEN _ledger_status
      WHEN 'deletion_replay' THEN _deletion_status
      ELSE requirement.status END,
    evidence_source = CASE requirement.requirement_name
      WHEN 'ledger_reconciliation' THEN _manifest.manifest_id
      WHEN 'deletion_replay' THEN _manifest.manifest_id
      ELSE requirement.evidence_source END,
    evidence_hash = CASE WHEN requirement.requirement_name IN ('ledger_reconciliation','deletion_replay')
      THEN _manifest.manifest_hash ELSE requirement.evidence_hash END,
    evidence_recorded_at = CASE WHEN requirement.requirement_name IN ('ledger_reconciliation','deletion_replay')
      THEN clock_timestamp() ELSE requirement.evidence_recorded_at END,
    reason_code = CASE requirement.requirement_name
      WHEN 'ledger_reconciliation' THEN CASE _ledger_status WHEN 'verified' THEN NULL ELSE 'reconciliation_not_proven' END
      WHEN 'deletion_replay' THEN CASE _deletion_status WHEN 'verified' THEN NULL ELSE 'deletion_replay_not_proven' END
      ELSE requirement.reason_code END,
    updated_at = clock_timestamp()
  WHERE requirement.event_id = _event_id;
  UPDATE private.restore_recovery_events SET
    status = CASE WHEN _deletion_status = 'verified' THEN 'reconciling' ELSE 'deletions_pending' END,
    version = version + 1, import_failure_code = NULL, updated_at = clock_timestamp()
  WHERE id = _event_id RETURNING * INTO _event;
  UPDATE private.restore_recovery_requirements SET event_version = _event.version
  WHERE event_id = _event_id;
  RETURN QUERY SELECT 'blocked'::TEXT, _event.version;
END;
$$;

CREATE OR REPLACE FUNCTION public.authorize_restore_deletion_replay_for_server(
  _event_id UUID, _expected_version INTEGER, _authorization_evidence_hash TEXT
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = private, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF _authorization_evidence_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'recovery_replay_authorization_invalid';
  END IF;
  PERFORM 1 FROM private.restore_recovery_events event
  WHERE event.id = _event_id AND event.version = _expected_version
    AND event.status = 'deletions_pending' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'restore_recovery_event_stale'; END IF;
  UPDATE private.restore_recovery_control SET
    recovery_deletion_replay_enabled = TRUE, updated_at = clock_timestamp()
  WHERE singleton AND current_event_id = _event_id AND access_state = 'blocked';
  IF NOT FOUND THEN RAISE EXCEPTION 'restore_recovery_control_stale'; END IF;
  UPDATE private.restore_recovery_requirements SET
    evidence_source = 'separate_replay_authorization',
    evidence_hash = _authorization_evidence_hash,
    evidence_recorded_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE event_id = _event_id AND requirement_name = 'deletion_replay';
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_restore_deletion_replay_for_server(_event_id UUID)
RETURNS TABLE (
  event_id UUID, request_kind TEXT, request_id UUID, attempt_count INTEGER,
  claim_token UUID, lease_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = private, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM private.restore_recovery_control control
    WHERE control.singleton AND control.access_state = 'blocked'
      AND control.current_event_id = _event_id
      AND control.recovery_deletion_replay_enabled
  ) THEN RAISE EXCEPTION 'recovery_deletion_replay_disabled'; END IF;
  RETURN QUERY
  WITH candidate AS (
    SELECT replay.event_id, replay.request_kind, replay.request_id
    FROM private.restore_recovery_deletion_replay replay
    WHERE replay.event_id = _event_id AND replay.attempt_count < 5
      AND (replay.status IN ('pending', 'failed')
        OR (replay.status = 'processing' AND replay.lease_expires_at <= clock_timestamp()))
      AND NOT replay.hold
    ORDER BY replay.updated_at, replay.request_kind, replay.request_id
    LIMIT 1 FOR UPDATE SKIP LOCKED
  )
  UPDATE private.restore_recovery_deletion_replay replay SET
    status = 'processing', attempt_count = replay.attempt_count + 1,
    claim_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '5 minutes',
    failure_code = NULL, updated_at = clock_timestamp()
  FROM candidate
  WHERE replay.event_id = candidate.event_id AND replay.request_kind = candidate.request_kind
    AND replay.request_id = candidate.request_id
  RETURNING replay.event_id, replay.request_kind, replay.request_id,
    replay.attempt_count, replay.claim_token, replay.lease_expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_restore_deletion_replay_for_server(
  _event_id UUID, _request_kind TEXT, _request_id UUID, _claim_token UUID
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = private, pg_temp
AS $$
DECLARE _expected_hash TEXT; _local_hash TEXT;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  SELECT replay.authoritative_evidence_hash, ledger.evidence_hash
  INTO _expected_hash, _local_hash
  FROM private.restore_recovery_deletion_replay replay
  LEFT JOIN private.deletion_completion_ledger ledger
    ON ledger.request_kind = replay.request_kind AND ledger.request_id = replay.request_id
  WHERE replay.event_id = _event_id AND replay.request_kind = _request_kind
    AND replay.request_id = _request_id AND replay.status = 'processing'
    AND replay.claim_token = _claim_token AND replay.lease_expires_at > clock_timestamp()
  FOR UPDATE OF replay;
  IF _expected_hash IS NULL THEN RAISE EXCEPTION 'recovery_deletion_claim_stale'; END IF;
  IF _local_hash IS NULL OR _local_hash <> _expected_hash THEN
    RAISE EXCEPTION 'recovery_deletion_completion_unverified';
  END IF;
  UPDATE private.restore_recovery_deletion_replay SET
    status = 'replayed', completed_at = clock_timestamp(), claim_token = NULL,
    lease_expires_at = NULL, failure_code = NULL, updated_at = clock_timestamp()
  WHERE event_id = _event_id AND request_kind = _request_kind AND request_id = _request_id
    AND claim_token = _claim_token;
  IF NOT EXISTS (
    SELECT 1 FROM private.restore_recovery_deletion_replay replay
    WHERE replay.event_id = _event_id AND replay.status NOT IN ('replayed', 'already_applied')
  ) THEN
    UPDATE private.restore_recovery_requirements SET status = 'verified', reason_code = NULL,
      evidence_recorded_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE event_id = _event_id AND requirement_name = 'deletion_replay';
    UPDATE private.restore_recovery_control SET recovery_deletion_replay_enabled = FALSE,
      updated_at = clock_timestamp()
    WHERE singleton AND current_event_id = _event_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_restore_deletion_replay_for_server(
  _event_id UUID, _request_kind TEXT, _request_id UUID,
  _claim_token UUID, _failure_code TEXT
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = private, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF char_length(COALESCE(_failure_code, '')) NOT BETWEEN 3 AND 120 THEN
    RAISE EXCEPTION 'invalid_failure_code';
  END IF;
  UPDATE private.restore_recovery_deletion_replay replay SET
    status = 'failed', failure_code = _failure_code, claim_token = NULL,
    lease_expires_at = NULL, updated_at = clock_timestamp()
  WHERE replay.event_id = _event_id AND replay.request_kind = _request_kind
    AND replay.request_id = _request_id AND replay.status = 'processing'
    AND replay.claim_token = _claim_token AND replay.lease_expires_at > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'recovery_deletion_claim_stale'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_restore_recovery_import_for_server(
  _event_id UUID, _event_version INTEGER, _failure_code TEXT
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = private, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF char_length(COALESCE(_failure_code, '')) NOT BETWEEN 3 AND 120 THEN RAISE EXCEPTION 'invalid_failure_code'; END IF;
  UPDATE private.restore_recovery_events event SET
    status = 'failed', import_failure_code = _failure_code,
    version = version + 1, updated_at = clock_timestamp()
  WHERE event.id = _event_id AND event.version = _event_version
    AND event.status NOT IN ('reopened', 'approved_pending_external_release');
  IF NOT FOUND THEN RAISE EXCEPTION 'restore_recovery_event_stale'; END IF;
  UPDATE private.restore_recovery_requirements SET event_version = event_version + 1
  WHERE event_id = _event_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_verify_restore_personal_data(
  _event_id UUID, _expected_version INTEGER, _evidence_source TEXT,
  _evidence_hash TEXT, _reason TEXT
)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _admin UUID := auth.uid(); _event private.restore_recovery_events%ROWTYPE;
BEGIN
  IF _admin IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501'; END IF;
  IF _evidence_hash !~ '^[0-9a-f]{64}$' OR char_length(btrim(COALESCE(_evidence_source, ''))) NOT BETWEEN 3 AND 300
    OR char_length(btrim(COALESCE(_reason, ''))) NOT BETWEEN 3 AND 500
  THEN RAISE EXCEPTION 'invalid_recovery_evidence'; END IF;
  SELECT * INTO STRICT _event FROM private.restore_recovery_events WHERE id = _event_id FOR UPDATE;
  IF _event.version <> _expected_version OR _event.status IN ('reopened', 'approved_pending_external_release') THEN
    RAISE EXCEPTION 'restore_recovery_event_stale';
  END IF;
  UPDATE private.restore_recovery_requirements SET status = 'verified',
    evidence_source = btrim(_evidence_source), evidence_hash = _evidence_hash,
    evidence_recorded_at = clock_timestamp(), verified_by = _admin,
    reason_code = NULL, updated_at = clock_timestamp()
  WHERE event_id = _event_id AND requirement_name = 'personal_data_review';
  UPDATE private.restore_recovery_events SET version = version + 1, updated_at = clock_timestamp()
  WHERE id = _event_id RETURNING * INTO _event;
  UPDATE private.restore_recovery_requirements SET event_version = _event.version WHERE event_id = _event_id;
  IF NOT EXISTS (
    SELECT 1 FROM private.restore_recovery_requirements requirement
    WHERE requirement.event_id = _event_id AND requirement.status <> 'verified'
  ) THEN
    UPDATE private.restore_recovery_events SET status = 'ready_for_approval', updated_at = clock_timestamp()
    WHERE id = _event_id;
  END IF;
  INSERT INTO public.audit_logs(actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_admin, 'recovery.personal_data.verified', 'restore_recovery_event', _event_id::TEXT,
    jsonb_build_object('version', _event.version, 'source', btrim(_evidence_source), 'reason', btrim(_reason)));
  RETURN _event.version;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_approve_restore_recovery(
  _event_id UUID, _expected_version INTEGER, _reason TEXT
)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _admin UUID := auth.uid(); _event private.restore_recovery_events%ROWTYPE;
BEGIN
  IF _admin IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501'; END IF;
  IF char_length(btrim(COALESCE(_reason, ''))) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'recovery_approval_reason_required'; END IF;
  SELECT * INTO STRICT _event FROM private.restore_recovery_events WHERE id = _event_id FOR UPDATE;
  IF _event.version <> _expected_version OR _event.status IN ('reopened', 'approved_pending_external_release') THEN
    RAISE EXCEPTION 'restore_recovery_event_stale';
  END IF;
  IF _event.status <> 'ready_for_approval' OR EXISTS (
    SELECT 1 FROM private.restore_recovery_requirements requirement
    WHERE requirement.event_id = _event_id AND requirement.status <> 'verified'
  ) THEN RAISE EXCEPTION 'restore_recovery_requirements_incomplete'; END IF;
  UPDATE private.restore_recovery_events event SET
    status = 'approved_pending_external_release', approval_event_id = event.id,
    approval_version = event.version, approved_by = _admin,
    approved_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE event.id = _event_id RETURNING * INTO _event;
  INSERT INTO public.audit_logs(actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_admin, 'recovery.restore.approved', 'restore_recovery_event', _event_id::TEXT,
    jsonb_build_object('version', _event.version, 'reason', btrim(_reason),
      'external_release_pending', TRUE));
  RETURN _event.version;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_restore_recovery_release_for_server(
  _event_id UUID, _event_version INTEGER, _external_lock_id TEXT,
  _release_evidence_hash TEXT
)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _event private.restore_recovery_events%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  SELECT * INTO STRICT _event FROM private.restore_recovery_events WHERE id = _event_id FOR UPDATE;
  IF _event.version <> _event_version OR _event.status <> 'approved_pending_external_release'
    OR _event.external_lock_id <> _external_lock_id
    OR _event.approval_event_id <> _event.id OR _event.approval_version <> _event.version
    OR _release_evidence_hash !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'restore_recovery_release_not_authorized'; END IF;
  IF EXISTS (
    SELECT 1 FROM private.restore_recovery_requirements requirement
    WHERE requirement.event_id = _event_id AND requirement.status <> 'verified'
  ) THEN RAISE EXCEPTION 'restore_recovery_requirements_incomplete'; END IF;
  UPDATE private.restore_recovery_events SET status = 'reopened',
    external_release_evidence_hash = _release_evidence_hash,
    reopened_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE id = _event_id;
  UPDATE private.restore_recovery_control SET access_state = 'open', current_event_id = NULL,
    recovery_deletion_replay_enabled = FALSE, updated_at = clock_timestamp()
  WHERE singleton AND current_event_id = _event_id AND access_state = 'blocked';
  IF NOT FOUND THEN RAISE EXCEPTION 'restore_recovery_control_stale'; END IF;
  INSERT INTO public.audit_logs(actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_event.approved_by, 'recovery.restore.reopened', 'restore_recovery_event', _event_id::TEXT,
    jsonb_build_object('version', _event.version, 'external_authority_id', _event.external_authority_id));
  RETURN 'reopened';
END;
$$;

CREATE OR REPLACE FUNCTION private.block_business_mutation_during_recovery()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = private, pg_temp
AS $$
BEGIN
  PERFORM private.ensure_recovery_business_open();
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.block_business_mutation_during_recovery() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS recovery_block_credit_transactions ON public.credit_transactions;
CREATE TRIGGER recovery_block_credit_transactions
BEFORE INSERT OR UPDATE OR DELETE ON public.credit_transactions
FOR EACH ROW EXECUTE FUNCTION private.block_business_mutation_during_recovery();
DROP TRIGGER IF EXISTS recovery_block_credit_wallets ON public.credit_wallets;
CREATE TRIGGER recovery_block_credit_wallets
BEFORE INSERT OR UPDATE OR DELETE ON public.credit_wallets
FOR EACH ROW EXECUTE FUNCTION private.block_business_mutation_during_recovery();
DROP TRIGGER IF EXISTS recovery_block_messages ON public.messages;
CREATE TRIGGER recovery_block_messages BEFORE INSERT ON public.messages
FOR EACH ROW EXECUTE FUNCTION private.block_business_mutation_during_recovery();
DROP TRIGGER IF EXISTS recovery_block_gift_purchases ON public.gift_attachment_purchases;
CREATE TRIGGER recovery_block_gift_purchases BEFORE INSERT OR UPDATE ON public.gift_attachment_purchases
FOR EACH ROW EXECUTE FUNCTION private.block_business_mutation_during_recovery();
DROP TRIGGER IF EXISTS recovery_block_support_tickets ON public.support_tickets;
CREATE TRIGGER recovery_block_support_tickets BEFORE INSERT OR UPDATE ON public.support_tickets
FOR EACH ROW EXECUTE FUNCTION private.block_business_mutation_during_recovery();
DROP TRIGGER IF EXISTS recovery_block_support_messages ON public.support_ticket_messages;
CREATE TRIGGER recovery_block_support_messages BEFORE INSERT ON public.support_ticket_messages
FOR EACH ROW EXECUTE FUNCTION private.block_business_mutation_during_recovery();

CREATE OR REPLACE FUNCTION private.registration_admission_open()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT private.recovery_business_open() AND COALESCE((
    SELECT CASE WHEN jsonb_typeof(setting.value) = 'boolean'
      THEN (setting.value #>> '{}')::BOOLEAN ELSE FALSE END
    FROM public.system_settings setting WHERE setting.key = 'allow_new_registrations'
  ), FALSE);
$$;
REVOKE ALL ON FUNCTION private.registration_admission_open() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.ensure_active_client(_user_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _mandatory_onboarding BOOLEAN := FALSE; _consent_policy_enabled BOOLEAN := FALSE;
BEGIN
  PERFORM private.ensure_recovery_business_open();
  IF private.account_deletion_blocks_business_activity(_user_id) OR NOT EXISTS (
    SELECT 1 FROM public.user_roles role JOIN public.profiles profile ON profile.user_id = role.user_id
    WHERE role.user_id = _user_id AND role.role = 'client'::public.app_role
      AND COALESCE(profile.status, 'active') = 'active'
      AND profile.deleted_at IS NULL AND profile.pii_archived_at IS NULL
  ) THEN RAISE EXCEPTION 'client_account_inactive'; END IF;
  IF EXISTS (SELECT 1 FROM private.registration_eligibility WHERE user_id = _user_id)
    AND NOT EXISTS (SELECT 1 FROM private.registration_eligibility WHERE user_id = _user_id AND activated_at IS NOT NULL)
  THEN RAISE EXCEPTION 'client_registration_not_eligible' USING ERRCODE = '42501'; END IF;
  SELECT COALESCE((value #>> '{}')::BOOLEAN, FALSE) INTO _mandatory_onboarding
  FROM public.system_settings WHERE key = 'mandatory_onboarding_enabled';
  SELECT COALESCE((value #>> '{}')::BOOLEAN, FALSE) INTO _consent_policy_enabled
  FROM public.system_settings WHERE key = 'client_consent_policy_enabled';
  IF _consent_policy_enabled AND NOT private.has_required_client_consents(_user_id) THEN
    RAISE EXCEPTION 'client_consent_required' USING ERRCODE = '42501';
  END IF;
  IF _mandatory_onboarding AND NOT EXISTS (
    SELECT 1 FROM public.client_profiles profile WHERE profile.user_id = _user_id
      AND profile.onboarding_completed_at IS NOT NULL
      AND COALESCE(profile.computed_age, profile.age) BETWEEN 18 AND 120
      AND NULLIF(btrim(profile.first_name), '') IS NOT NULL
      AND NULLIF(btrim(profile.last_name), '') IS NOT NULL
      AND profile.city_id IS NOT NULL AND NULLIF(btrim(profile.bio), '') IS NOT NULL
      AND profile.relationship_status IS NOT NULL AND profile.smoking_status IS NOT NULL
      AND profile.preferred_min_age IS NOT NULL AND profile.preferred_max_age IS NOT NULL
      AND profile.preferred_distance_km IS NOT NULL
      AND jsonb_array_length(profile.content_preferences) > 0
      AND jsonb_array_length(profile.character_preferences) > 0
  ) THEN RAISE EXCEPTION 'client_onboarding_required' USING ERRCODE = '42501'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION private.ensure_active_client(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.ensure_active_client(UUID) TO service_role;

-- Restrictive policies add a fail-closed read/write condition without broadening any existing policy.
CREATE POLICY "Recovery gate profiles" ON public.profiles AS RESTRICTIVE FOR ALL TO authenticated
USING (private.recovery_business_open()) WITH CHECK (private.recovery_business_open());
CREATE POLICY "Recovery gate client profiles" ON public.client_profiles AS RESTRICTIVE FOR ALL TO authenticated
USING (private.recovery_business_open()) WITH CHECK (private.recovery_business_open());
CREATE POLICY "Recovery gate conversations" ON public.conversations AS RESTRICTIVE FOR ALL TO authenticated
USING (private.recovery_business_open()) WITH CHECK (private.recovery_business_open());
CREATE POLICY "Recovery gate messages" ON public.messages AS RESTRICTIVE FOR ALL TO authenticated
USING (private.recovery_business_open()) WITH CHECK (private.recovery_business_open());
CREATE POLICY "Recovery gate message attachments" ON public.message_attachments AS RESTRICTIVE FOR ALL TO authenticated
USING (private.recovery_business_open()) WITH CHECK (private.recovery_business_open());
CREATE POLICY "Recovery gate support tickets" ON public.support_tickets AS RESTRICTIVE FOR ALL TO authenticated
USING (private.recovery_business_open()) WITH CHECK (private.recovery_business_open());
CREATE POLICY "Recovery gate support messages" ON public.support_ticket_messages AS RESTRICTIVE FOR ALL TO authenticated
USING (private.recovery_business_open()) WITH CHECK (private.recovery_business_open());

REVOKE EXECUTE ON FUNCTION public.begin_restore_recovery_for_server(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.import_restore_recovery_manifest_for_server(UUID, INTEGER, TEXT, TEXT, BIGINT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_restore_reconciliation_for_server(UUID, INTEGER, TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.stage_restore_deletion_replay_for_server(UUID, INTEGER, TEXT, TEXT, UUID, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.finalize_restore_recovery_import_for_server(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_restore_recovery_import_for_server(UUID, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_restore_recovery_release_for_server(UUID, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.authorize_restore_deletion_replay_for_server(UUID, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_restore_deletion_replay_for_server(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_restore_deletion_replay_for_server(UUID, TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_restore_deletion_replay_for_server(UUID, TEXT, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_restore_recovery_for_server(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT),
  public.import_restore_recovery_manifest_for_server(UUID, INTEGER, TEXT, TEXT, BIGINT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN),
  public.record_restore_reconciliation_for_server(UUID, INTEGER, TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, TEXT),
  public.stage_restore_deletion_replay_for_server(UUID, INTEGER, TEXT, TEXT, UUID, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN),
  public.finalize_restore_recovery_import_for_server(UUID, INTEGER),
  public.fail_restore_recovery_import_for_server(UUID, INTEGER, TEXT),
  public.complete_restore_recovery_release_for_server(UUID, INTEGER, TEXT, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.authorize_restore_deletion_replay_for_server(UUID, INTEGER, TEXT),
  public.claim_restore_deletion_replay_for_server(UUID),
  public.complete_restore_deletion_replay_for_server(UUID, TEXT, UUID, UUID),
  public.fail_restore_deletion_replay_for_server(UUID, TEXT, UUID, UUID, TEXT)
  TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_verify_restore_personal_data(UUID, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_approve_restore_recovery(UUID, INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_verify_restore_personal_data(UUID, INTEGER, TEXT, TEXT, TEXT),
  public.admin_approve_restore_recovery(UUID, INTEGER, TEXT) TO authenticated;
