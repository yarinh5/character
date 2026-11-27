-- WP10/WP11: resumable deletion preparation and the independent seven-minute
-- operational wait metric. Destructive deletion remains disabled until an
-- approved retention policy explicitly activates it.

INSERT INTO public.system_settings (key, value)
VALUES
  ('account_deletion_retention_policy_approved', 'false'::jsonb),
  ('operational_wait_alert_seconds', '420'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE public.account_deletion_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  idempotency_key UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_verification'
    CHECK (status IN (
      'awaiting_verification', 'verified', 'blocked_retention', 'processing',
      'completed', 'failed', 'cancelled'
    )),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  verification_expires_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failure_code TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, idempotency_key)
);

CREATE UNIQUE INDEX account_deletion_one_active_request_idx
  ON public.account_deletion_requests(user_id)
  WHERE status IN ('awaiting_verification', 'verified', 'blocked_retention', 'processing');

CREATE TABLE private.account_deletion_verifications (
  request_id UUID PRIMARY KEY REFERENCES public.account_deletion_requests(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL CHECK (char_length(token_hash) = 64),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE private.account_deletion_steps (
  request_id UUID NOT NULL REFERENCES public.account_deletion_requests(id) ON DELETE CASCADE,
  step_name TEXT NOT NULL CHECK (step_name IN ('database', 'storage', 'auth')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'blocked_retention')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failure_code TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (request_id, step_name)
);

CREATE TABLE private.conversation_deletion_steps (
  request_id UUID NOT NULL,
  step_name TEXT NOT NULL CHECK (step_name IN ('database_content', 'storage', 'finalize')),
  status TEXT NOT NULL DEFAULT 'blocked_retention'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'blocked_retention')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failure_code TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (request_id, step_name)
);

CREATE TABLE public.conversation_deletion_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE RESTRICT,
  requested_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  idempotency_key UUID NOT NULL,
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  status TEXT NOT NULL DEFAULT 'blocked_retention'
    CHECK (status IN ('blocked_retention', 'verified', 'processing', 'completed', 'failed', 'cancelled')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  failure_code TEXT,
  UNIQUE (requested_by, idempotency_key)
);

ALTER TABLE private.conversation_deletion_steps
  ADD CONSTRAINT conversation_deletion_steps_request_id_fkey
  FOREIGN KEY (request_id) REFERENCES public.conversation_deletion_requests(id) ON DELETE CASCADE;

ALTER TABLE public.account_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_deletion_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_deletion_requests, public.conversation_deletion_requests
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.account_deletion_requests, public.conversation_deletion_requests
  TO authenticated;

CREATE POLICY "Users view own account deletion requests"
  ON public.account_deletion_requests FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
CREATE POLICY "Admins view account deletion requests"
  ON public.account_deletion_requests FOR SELECT TO authenticated
  USING (public.is_admin());
CREATE POLICY "Users view own conversation deletion requests"
  ON public.conversation_deletion_requests FOR SELECT TO authenticated
  USING (requested_by = (SELECT auth.uid()));
CREATE POLICY "Admins view conversation deletion requests"
  ON public.conversation_deletion_requests FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE OR REPLACE FUNCTION public.request_account_deletion(_idempotency_key UUID)
RETURNS TABLE (id UUID, status TEXT, requested_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user UUID := auth.uid();
  _request public.account_deletion_requests%ROWTYPE;
BEGIN
  IF _user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF _idempotency_key IS NULL THEN RAISE EXCEPTION 'idempotency_key_required'; END IF;

  INSERT INTO public.account_deletion_requests (user_id, idempotency_key)
  VALUES (_user, _idempotency_key)
  ON CONFLICT (user_id, idempotency_key) DO NOTHING
  RETURNING * INTO _request;

  IF _request.id IS NULL THEN
    SELECT * INTO _request FROM public.account_deletion_requests request
    WHERE request.user_id = _user AND request.idempotency_key = _idempotency_key;
  END IF;

  id := _request.id;
  status := _request.status;
  requested_at := _request.requested_at;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_account_deletion_verification_for_server(
  _request_id UUID,
  _token_hash TEXT,
  _expires_at TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF _token_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_token_hash'; END IF;
  IF _expires_at <= clock_timestamp() OR _expires_at > clock_timestamp() + interval '24 hours' THEN
    RAISE EXCEPTION 'invalid_verification_expiry';
  END IF;

  PERFORM 1 FROM public.account_deletion_requests request
  WHERE request.id = _request_id AND request.status = 'awaiting_verification'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'deletion_request_not_verifiable'; END IF;

  INSERT INTO private.account_deletion_verifications (request_id, token_hash, expires_at)
  VALUES (_request_id, _token_hash, _expires_at)
  ON CONFLICT (request_id) DO UPDATE
  SET token_hash = EXCLUDED.token_hash,
      expires_at = EXCLUDED.expires_at,
      consumed_at = NULL,
      created_at = clock_timestamp();

  UPDATE public.account_deletion_requests
  SET verification_expires_at = _expires_at, updated_at = clock_timestamp()
  WHERE account_deletion_requests.id = _request_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.verify_account_deletion_for_server(
  _request_id UUID,
  _token_hash TEXT
)
RETURNS TABLE (id UUID, status TEXT, verified_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _verification private.account_deletion_verifications%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;

  SELECT * INTO _verification
  FROM private.account_deletion_verifications verification
  WHERE verification.request_id = _request_id
  FOR UPDATE;
  IF NOT FOUND OR _verification.consumed_at IS NOT NULL
    OR _verification.expires_at <= clock_timestamp()
    OR _verification.token_hash IS DISTINCT FROM _token_hash THEN
    RAISE EXCEPTION 'deletion_verification_invalid_or_expired';
  END IF;

  UPDATE private.account_deletion_verifications
  SET consumed_at = clock_timestamp()
  WHERE request_id = _request_id;

  UPDATE public.account_deletion_requests request
  SET status = 'verified', verified_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE request.id = _request_id AND request.status = 'awaiting_verification'
  RETURNING request.id, request.status, request.verified_at
  INTO id, status, verified_at;
  IF id IS NULL THEN RAISE EXCEPTION 'deletion_request_not_verifiable'; END IF;

  INSERT INTO private.account_deletion_steps (request_id, step_name)
  VALUES (_request_id, 'database'), (_request_id, 'storage'), (_request_id, 'auth')
  ON CONFLICT (request_id, step_name) DO NOTHING;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_account_deletion_step_for_server(_request_id UUID)
RETURNS TABLE (request_id UUID, step_name TEXT, attempt_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _retention_approved BOOLEAN := private.setting_bool('account_deletion_retention_policy_approved', FALSE);
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF NOT _retention_approved THEN
    UPDATE public.account_deletion_requests request
    SET status = 'blocked_retention', updated_at = clock_timestamp()
    WHERE request.id = _request_id AND request.status IN ('verified', 'blocked_retention');
    UPDATE private.account_deletion_steps step
    SET status = 'blocked_retention', updated_at = clock_timestamp()
    WHERE step.request_id = _request_id AND step.status = 'pending';
    RETURN;
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT step.request_id, step.step_name
    FROM private.account_deletion_steps step
    WHERE step.request_id = _request_id
      AND step.status IN ('pending', 'failed')
      AND NOT EXISTS (
        SELECT 1 FROM private.account_deletion_steps predecessor
        WHERE predecessor.request_id = step.request_id
          AND CASE step.step_name
            WHEN 'storage' THEN predecessor.step_name = 'database'
            WHEN 'auth' THEN predecessor.step_name IN ('database', 'storage')
            ELSE FALSE
          END
          AND predecessor.status <> 'completed'
      )
    ORDER BY CASE step.step_name WHEN 'database' THEN 1 WHEN 'storage' THEN 2 ELSE 3 END
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE private.account_deletion_steps step
  SET status = 'processing',
      attempt_count = step.attempt_count + 1,
      claimed_at = clock_timestamp(),
      failure_code = NULL,
      updated_at = clock_timestamp()
  FROM candidate
  WHERE step.request_id = candidate.request_id AND step.step_name = candidate.step_name
  RETURNING step.request_id, step.step_name, step.attempt_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_account_deletion_step_for_server(
  _request_id UUID,
  _step_name TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _remaining INTEGER;
  _status TEXT;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;

  UPDATE private.account_deletion_steps step
  SET status = 'completed', completed_at = clock_timestamp(), failure_code = NULL,
      updated_at = clock_timestamp()
  WHERE step.request_id = _request_id
    AND step.step_name = _step_name
    AND step.status = 'processing';
  IF NOT FOUND THEN RAISE EXCEPTION 'deletion_step_not_processing'; END IF;

  SELECT count(*) INTO _remaining
  FROM private.account_deletion_steps step
  WHERE step.request_id = _request_id AND step.status <> 'completed';

  IF _remaining = 0 THEN
    UPDATE public.account_deletion_requests request
    SET status = 'completed', completed_at = clock_timestamp(), failure_code = NULL,
        updated_at = clock_timestamp()
    WHERE request.id = _request_id
    RETURNING request.status INTO _status;
  ELSE
    UPDATE public.account_deletion_requests request
    SET status = 'processing', failure_code = NULL, updated_at = clock_timestamp()
    WHERE request.id = _request_id
    RETURNING request.status INTO _status;
  END IF;
  RETURN _status;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_account_deletion_step_for_server(
  _request_id UUID,
  _step_name TEXT,
  _failure_code TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF _failure_code IS NULL OR char_length(_failure_code) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'invalid_failure_code';
  END IF;

  UPDATE private.account_deletion_steps step
  SET status = 'failed', failure_code = _failure_code, updated_at = clock_timestamp()
  WHERE step.request_id = _request_id
    AND step.step_name = _step_name
    AND step.status = 'processing';
  IF NOT FOUND THEN RAISE EXCEPTION 'deletion_step_not_processing'; END IF;

  UPDATE public.account_deletion_requests request
  SET status = 'failed', failure_code = _failure_code, updated_at = clock_timestamp()
  WHERE request.id = _request_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.request_conversation_deletion(
  _conversation_id UUID,
  _reason TEXT,
  _idempotency_key UUID,
  _confirmed BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (id UUID, status TEXT, requested_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _actor UUID := auth.uid();
  _request public.conversation_deletion_requests%ROWTYPE;
BEGIN
  IF _actor IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'admin_only' USING ERRCODE = '42501'; END IF;
  IF _confirmed IS NOT TRUE THEN RAISE EXCEPTION 'explicit_confirmation_required'; END IF;
  IF _conversation_id IS NULL OR _idempotency_key IS NULL THEN RAISE EXCEPTION 'invalid_deletion_request'; END IF;
  IF _reason IS NULL OR char_length(btrim(_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'deletion_reason_required';
  END IF;
  PERFORM 1 FROM public.conversations conversation WHERE conversation.id = _conversation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_not_found'; END IF;

  INSERT INTO public.conversation_deletion_requests (
    conversation_id, requested_by, idempotency_key, reason
  ) VALUES (_conversation_id, _actor, _idempotency_key, btrim(_reason))
  ON CONFLICT (requested_by, idempotency_key) DO NOTHING
  RETURNING * INTO _request;

  IF _request.id IS NULL THEN
    SELECT * INTO _request
    FROM public.conversation_deletion_requests request
    WHERE request.requested_by = _actor AND request.idempotency_key = _idempotency_key;
    IF _request.conversation_id IS DISTINCT FROM _conversation_id
      OR _request.reason IS DISTINCT FROM btrim(_reason) THEN
      RAISE EXCEPTION 'idempotency_key_reused';
    END IF;
  ELSE
    INSERT INTO private.conversation_deletion_steps (request_id, step_name)
    VALUES (_request.id, 'database_content'), (_request.id, 'storage'), (_request.id, 'finalize');
    INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
    VALUES (
      _actor, 'conversation_deletion_requested', 'conversation', _conversation_id,
      jsonb_build_object('request_id', _request.id, 'reason', btrim(_reason), 'status', _request.status)
    );
  END IF;

  id := _request.id;
  status := _request.status;
  requested_at := _request.requested_at;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_conversation_deletion_step_for_server(_request_id UUID)
RETURNS TABLE (request_id UUID, step_name TEXT, attempt_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _retention_approved BOOLEAN := private.setting_bool('account_deletion_retention_policy_approved', FALSE);
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF NOT _retention_approved THEN RETURN; END IF;

  UPDATE private.conversation_deletion_steps step
  SET status = 'pending', updated_at = clock_timestamp()
  WHERE step.request_id = _request_id AND step.status = 'blocked_retention';
  UPDATE public.conversation_deletion_requests request
  SET status = 'verified', failure_code = NULL
  WHERE request.id = _request_id AND request.status = 'blocked_retention';

  RETURN QUERY
  WITH candidate AS (
    SELECT step.request_id, step.step_name
    FROM private.conversation_deletion_steps step
    WHERE step.request_id = _request_id
      AND step.status IN ('pending', 'failed')
      AND NOT EXISTS (
        SELECT 1 FROM private.conversation_deletion_steps predecessor
        WHERE predecessor.request_id = step.request_id
          AND CASE step.step_name
            WHEN 'storage' THEN predecessor.step_name = 'database_content'
            WHEN 'finalize' THEN predecessor.step_name IN ('database_content', 'storage')
            ELSE FALSE
          END
          AND predecessor.status <> 'completed'
      )
    ORDER BY CASE step.step_name WHEN 'database_content' THEN 1 WHEN 'storage' THEN 2 ELSE 3 END
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE private.conversation_deletion_steps step
  SET status = 'processing', attempt_count = step.attempt_count + 1,
      claimed_at = clock_timestamp(), failure_code = NULL, updated_at = clock_timestamp()
  FROM candidate
  WHERE step.request_id = candidate.request_id AND step.step_name = candidate.step_name
  RETURNING step.request_id, step.step_name, step.attempt_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_conversation_deletion_step_for_server(
  _request_id UUID,
  _step_name TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _remaining INTEGER;
  _status TEXT;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  UPDATE private.conversation_deletion_steps step
  SET status = 'completed', completed_at = clock_timestamp(), failure_code = NULL,
      updated_at = clock_timestamp()
  WHERE step.request_id = _request_id
    AND step.step_name = _step_name
    AND step.status = 'processing';
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_deletion_step_not_processing'; END IF;

  SELECT count(*) INTO _remaining
  FROM private.conversation_deletion_steps step
  WHERE step.request_id = _request_id AND step.status <> 'completed';
  UPDATE public.conversation_deletion_requests request
  SET status = CASE WHEN _remaining = 0 THEN 'completed' ELSE 'processing' END,
      completed_at = CASE WHEN _remaining = 0 THEN clock_timestamp() ELSE NULL END,
      failure_code = NULL
  WHERE request.id = _request_id
  RETURNING request.status INTO _status;
  RETURN _status;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_conversation_deletion_step_for_server(
  _request_id UUID,
  _step_name TEXT,
  _failure_code TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF _failure_code IS NULL OR char_length(_failure_code) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'invalid_failure_code';
  END IF;
  UPDATE private.conversation_deletion_steps step
  SET status = 'failed', failure_code = _failure_code, updated_at = clock_timestamp()
  WHERE step.request_id = _request_id
    AND step.step_name = _step_name
    AND step.status = 'processing';
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_deletion_step_not_processing'; END IF;
  UPDATE public.conversation_deletion_requests request
  SET status = 'failed', failure_code = _failure_code
  WHERE request.id = _request_id;
END;
$$;

REVOKE ALL ON TABLE private.account_deletion_verifications, private.account_deletion_steps,
  private.conversation_deletion_steps
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.request_account_deletion(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_account_deletion(UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.prepare_account_deletion_verification_for_server(UUID, TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_account_deletion_for_server(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_account_deletion_step_for_server(UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_account_deletion_step_for_server(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_account_deletion_step_for_server(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_conversation_deletion(UUID, TEXT, UUID, BOOLEAN)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.claim_conversation_deletion_step_for_server(UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_conversation_deletion_step_for_server(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_conversation_deletion_step_for_server(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_conversation_deletion(UUID, TEXT, UUID, BOOLEAN)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_account_deletion_verification_for_server(UUID, TEXT, TIMESTAMPTZ),
  public.verify_account_deletion_for_server(UUID, TEXT),
  public.claim_account_deletion_step_for_server(UUID),
  public.complete_account_deletion_step_for_server(UUID, TEXT),
  public.fail_account_deletion_step_for_server(UUID, TEXT, TEXT),
  public.claim_conversation_deletion_step_for_server(UUID),
  public.complete_conversation_deletion_step_for_server(UUID, TEXT),
  public.fail_conversation_deletion_step_for_server(UUID, TEXT, TEXT)
  TO service_role;

-- Seven-minute wait cycles are independent of the 180-second handling lease.
CREATE TABLE private.conversation_operational_wait_cycles (
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  pending_since TIMESTAMPTZ NOT NULL,
  responded_at TIMESTAMPTZ,
  alerted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (conversation_id, pending_since)
);

CREATE OR REPLACE FUNCTION private.sync_operational_wait_cycle()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF NEW.needs_handling IS TRUE AND NEW.pending_since IS NOT NULL THEN
    INSERT INTO private.conversation_operational_wait_cycles (conversation_id, pending_since)
    VALUES (NEW.id, NEW.pending_since)
    ON CONFLICT (conversation_id, pending_since) DO NOTHING;
  END IF;

  IF OLD.needs_handling IS TRUE AND OLD.pending_since IS NOT NULL
    AND (NEW.needs_handling IS NOT TRUE OR NEW.pending_since IS DISTINCT FROM OLD.pending_since) THEN
    UPDATE private.conversation_operational_wait_cycles cycle
    SET responded_at = COALESCE(cycle.responded_at, clock_timestamp())
    WHERE cycle.conversation_id = NEW.id
      AND cycle.pending_since = OLD.pending_since;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_operational_wait_cycle ON public.conversations;
CREATE TRIGGER sync_operational_wait_cycle
  AFTER UPDATE OF needs_handling, pending_since ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION private.sync_operational_wait_cycle();

INSERT INTO private.conversation_operational_wait_cycles (conversation_id, pending_since)
SELECT conversation.id, conversation.pending_since
FROM public.conversations conversation
WHERE conversation.needs_handling IS TRUE AND conversation.pending_since IS NOT NULL
ON CONFLICT (conversation_id, pending_since) DO NOTHING;

CREATE OR REPLACE FUNCTION public.emit_operational_wait_alerts(_limit INTEGER DEFAULT 100)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _threshold INTEGER := GREATEST(private.setting_int('operational_wait_alert_seconds', 420), 60);
  _count INTEGER := 0;
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_or_service_role_required' USING ERRCODE = '42501';
  END IF;

  WITH candidates AS (
    SELECT cycle.conversation_id, cycle.pending_since
    FROM private.conversation_operational_wait_cycles cycle
    JOIN public.conversations conversation
      ON conversation.id = cycle.conversation_id
     AND conversation.needs_handling IS TRUE
     AND conversation.pending_since = cycle.pending_since
    WHERE cycle.responded_at IS NULL
      AND cycle.alerted_at IS NULL
      AND clock_timestamp() - cycle.pending_since >= make_interval(secs => _threshold)
    ORDER BY cycle.pending_since, cycle.conversation_id
    LIMIT LEAST(GREATEST(COALESCE(_limit, 100), 1), 500)
    FOR UPDATE OF cycle SKIP LOCKED
  ), marked AS (
    UPDATE private.conversation_operational_wait_cycles cycle
    SET alerted_at = clock_timestamp()
    FROM candidates
    WHERE cycle.conversation_id = candidates.conversation_id
      AND cycle.pending_since = candidates.pending_since
    RETURNING cycle.conversation_id, cycle.pending_since
  ), admin_notifications AS (
    INSERT INTO public.notifications (user_id, type, title, body, link, conversation_id, metadata)
    SELECT
      role.user_id,
      'operational_wait_alert',
      'שיחה ממתינה למענה',
      'חלפו שבע דקות ללא מענה עסקי של בעל הטיפול',
      '/admin/conversations/' || marked.conversation_id::TEXT,
      marked.conversation_id,
      jsonb_build_object('pending_since', marked.pending_since, 'threshold_seconds', _threshold)
    FROM marked
    CROSS JOIN public.user_roles role
    WHERE role.role = 'admin'::public.app_role
    RETURNING 1
  )
  SELECT count(DISTINCT conversation_id)::INTEGER INTO _count FROM marked;

  RETURN _count;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_admin_operational_wait_summary()
RETURNS TABLE (
  waiting_count BIGINT,
  over_target_count BIGINT,
  oldest_wait_seconds INTEGER,
  target_seconds INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _threshold INTEGER := GREATEST(private.setting_int('operational_wait_alert_seconds', 420), 60);
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'admin_only' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT
    count(*)::BIGINT,
    count(*) FILTER (WHERE clock_timestamp() - conversation.pending_since >= make_interval(secs => _threshold))::BIGINT,
    COALESCE(max(floor(extract(epoch FROM (clock_timestamp() - conversation.pending_since)))::INTEGER), 0),
    _threshold
  FROM public.conversations conversation
  WHERE conversation.needs_handling IS TRUE
    AND conversation.pending_since IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_admin_completion_exceptions()
RETURNS TABLE (
  allocation_issue_count BIGINT,
  gift_reward_failure_count BIGINT,
  gift_unallocated_event_count BIGINT,
  media_cleanup_failure_count BIGINT,
  account_deletion_blocked_count BIGINT,
  account_deletion_failure_count BIGINT,
  conversation_deletion_blocked_count BIGINT,
  conversation_deletion_failure_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'admin_only' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT
    (SELECT count(*) FROM private.handling_reconciliation_issues issue
     WHERE issue.status = 'unresolved'),
    (SELECT count(*) FROM private.gift_reward_events event WHERE event.status = 'failed'),
    (SELECT count(*) FROM private.gift_reward_events event
     WHERE event.status = 'distributed' AND event.unallocated_points > 0),
    (SELECT count(*) FROM public.client_media_uploads upload WHERE upload.status = 'cleanup_failed'),
    (SELECT count(*) FROM public.account_deletion_requests request
     WHERE request.status = 'blocked_retention'),
    (SELECT count(*) FROM public.account_deletion_requests request WHERE request.status = 'failed'),
    (SELECT count(*) FROM public.conversation_deletion_requests request
     WHERE request.status = 'blocked_retention'),
    (SELECT count(*) FROM public.conversation_deletion_requests request WHERE request.status = 'failed');
END;
$$;

REVOKE ALL ON TABLE private.conversation_operational_wait_cycles
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.sync_operational_wait_cycle() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.emit_operational_wait_alerts(INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.emit_operational_wait_alerts(INTEGER) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_admin_operational_wait_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_operational_wait_summary() TO authenticated;
REVOKE ALL ON FUNCTION public.get_admin_completion_exceptions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_completion_exceptions() TO authenticated;

NOTIFY pgrst, 'reload schema';
