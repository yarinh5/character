-- Apply with recovery writers disabled and drained before validating old evidence.
ALTER TABLE private.restore_recovery_events
  ADD CONSTRAINT restore_recovery_snapshot_time_finite CHECK (isfinite(source_snapshot_at));

-- Do not silently repair recovery evidence that was accepted by older code.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT manifest.*,
        lag(manifest.coverage_through) OVER (
          PARTITION BY manifest.event_id ORDER BY manifest.sequence
        ) AS previous_coverage
      FROM private.restore_recovery_authority_manifests manifest
    ) history
    JOIN private.restore_recovery_events event ON event.id = history.event_id
    WHERE NOT isfinite(event.source_snapshot_at)
      OR NOT isfinite(history.coverage_through)
      OR NOT isfinite(history.generated_at)
      OR history.coverage_through > history.generated_at
      OR (history.deletion_coverage_complete AND history.coverage_through < event.source_snapshot_at)
      OR history.coverage_through < history.previous_coverage
  ) THEN
    RAISE EXCEPTION 'invalid_restore_authority_manifest_coverage_history' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM private.restore_recovery_events event
    LEFT JOIN LATERAL (
      SELECT manifest_id, manifest_hash FROM private.restore_recovery_authority_manifests
      WHERE event_id = event.id ORDER BY sequence DESC LIMIT 1
    ) latest ON TRUE
    WHERE event.status IN ('ready_for_approval', 'approved_pending_external_release')
      AND 2 <> (
        SELECT count(*) FROM private.restore_recovery_requirements requirement
        WHERE requirement.event_id = event.id
          AND requirement.requirement_name IN ('ledger_reconciliation', 'deletion_replay')
          AND requirement.status = 'verified'
          AND requirement.evidence_source = latest.manifest_id
          AND requirement.evidence_hash = latest.manifest_hash
      )
  ) THEN
    RAISE EXCEPTION 'stale_restore_authority_manifest_approval_history' USING ERRCODE = '22023';
  END IF;
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
  IF NOT isfinite(_event.source_snapshot_at)
    OR NOT isfinite(_coverage_through)
    OR NOT isfinite(_generated_at)
    OR _coverage_through > _generated_at
    OR (_deletion_coverage_complete AND _coverage_through < _event.source_snapshot_at)
    OR _coverage_through < _previous.coverage_through
  THEN
    RAISE EXCEPTION 'invalid_restore_authority_manifest_coverage' USING ERRCODE = '22023';
  END IF;
  INSERT INTO private.restore_recovery_authority_manifests(
    event_id, manifest_id, authority_id, sequence, previous_manifest_hash,
    manifest_hash, coverage_through, generated_at, deletion_coverage_complete
  ) VALUES (_event_id, btrim(_manifest_id), _authority_id, _sequence,
    _previous_manifest_hash, _manifest_hash, _coverage_through, _generated_at,
    _deletion_coverage_complete)
  ON CONFLICT (event_id, manifest_id) DO NOTHING;
  IF FOUND THEN
    -- Keep the current version for the import RPCs; invalidate readiness before they run.
    UPDATE private.restore_recovery_requirements SET
      status = 'pending', evidence_source = NULL, evidence_hash = NULL,
      evidence_recorded_at = NULL, verified_by = NULL, reason_code = NULL,
      updated_at = clock_timestamp()
    WHERE event_id = _event_id AND requirement_name <> 'external_lock';
    UPDATE private.restore_recovery_events SET status = 'reconciling', updated_at = clock_timestamp()
    WHERE id = _event_id;
    UPDATE private.restore_recovery_control SET
      recovery_deletion_replay_enabled = FALSE, updated_at = clock_timestamp()
    WHERE singleton AND current_event_id = _event_id AND recovery_deletion_replay_enabled;
  ELSE
    PERFORM 1 FROM private.restore_recovery_authority_manifests manifest
    WHERE manifest.event_id = _event_id AND manifest.manifest_id = _manifest_id
      AND manifest.sequence = _sequence AND manifest.manifest_hash = _manifest_hash
      AND manifest.coverage_through = _coverage_through;
    IF NOT FOUND THEN RAISE EXCEPTION 'restore_authority_manifest_conflict'; END IF;
  END IF;
  RETURN jsonb_build_object('imported', TRUE, 'manifest_id', _manifest_id, 'sequence', _sequence);
END;
$$;
