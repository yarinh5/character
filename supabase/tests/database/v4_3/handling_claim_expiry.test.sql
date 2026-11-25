BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT plan(30);

-- Future PostgreSQL acceptance coverage. Not executed by the Offline Node suite.
CREATE OR REPLACE FUNCTION pg_temp.claim_expiry_create_user(_id uuid, _email text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES (_id, 'authenticated', 'authenticated', _email, 'not-used-by-tests', clock_timestamp(),
          '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp());
$$;

CREATE OR REPLACE FUNCTION pg_temp.claim_expiry_state(_conversation_id uuid)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'conversation', (SELECT to_jsonb(c) FROM public.conversations c WHERE c.id = _conversation_id),
    'work_items', (SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY w.id), '[]'::jsonb) FROM public.conversation_work_items w WHERE w.conversation_id = _conversation_id),
    'cycles', (SELECT coalesce(jsonb_agg(to_jsonb(cycle) ORDER BY cycle.id), '[]'::jsonb) FROM public.conversation_handling_cycles cycle WHERE cycle.conversation_id = _conversation_id),
    'messages', (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id), '[]'::jsonb) FROM public.messages m WHERE m.conversation_id = _conversation_id),
    'authority', (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.message_id), '[]'::jsonb) FROM private.handling_send_authority_evidence e WHERE e.conversation_id = _conversation_id),
    'analytics', (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]'::jsonb) FROM public.analytics_events a WHERE a.conversation_id = _conversation_id),
    'audit', (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]'::jsonb) FROM public.audit_logs a WHERE a.entity_id = _conversation_id::text),
    'legacy_lock', (SELECT to_jsonb(l) FROM public.conversation_locks l WHERE l.conversation_id = _conversation_id)
  );
$$;

SELECT pg_temp.claim_expiry_create_user('00000000-0000-4000-8000-0000000e0101', 'claim-expiry-claimant@example.invalid');
SELECT pg_temp.claim_expiry_create_user('00000000-0000-4000-8000-0000000e0102', 'claim-expiry-foreign-holder@example.invalid');
SELECT pg_temp.claim_expiry_create_user('00000000-0000-4000-8000-0000000e0103', 'claim-expiry-admin@example.invalid');
SELECT pg_temp.claim_expiry_create_user('00000000-0000-4000-8000-0000000e0111', 'claim-expiry-client-1@example.invalid');
SELECT pg_temp.claim_expiry_create_user('00000000-0000-4000-8000-0000000e0112', 'claim-expiry-client-2@example.invalid');
SELECT pg_temp.claim_expiry_create_user('00000000-0000-4000-8000-0000000e0113', 'claim-expiry-client-3@example.invalid');
SELECT pg_temp.claim_expiry_create_user('00000000-0000-4000-8000-0000000e0114', 'claim-expiry-client-4@example.invalid');
SELECT pg_temp.claim_expiry_create_user('00000000-0000-4000-8000-0000000e0115', 'claim-expiry-client-5@example.invalid');
SELECT pg_temp.claim_expiry_create_user('00000000-0000-4000-8000-0000000e0116', 'claim-expiry-client-6@example.invalid');
SELECT pg_temp.claim_expiry_create_user('00000000-0000-4000-8000-0000000e0117', 'claim-expiry-client-7@example.invalid');
SELECT pg_temp.claim_expiry_create_user('00000000-0000-4000-8000-0000000e0118', 'claim-expiry-client-8@example.invalid');
SELECT pg_temp.claim_expiry_create_user('00000000-0000-4000-8000-0000000e0119', 'claim-expiry-client-9@example.invalid');
SELECT pg_temp.claim_expiry_create_user('00000000-0000-4000-8000-0000000e0120', 'claim-expiry-client-10@example.invalid');

INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-4000-8000-0000000e0101', 'operator'), ('00000000-0000-4000-8000-0000000e0102', 'operator'), ('00000000-0000-4000-8000-0000000e0103', 'admin');
INSERT INTO public.operators (id, user_id, full_name, is_active, availability_status, presence_status, last_seen_at) VALUES
  ('00000000-0000-4000-8000-0000000e1101', '00000000-0000-4000-8000-0000000e0101', 'Expiry claimant', TRUE, 'available', 'online', clock_timestamp()),
  ('00000000-0000-4000-8000-0000000e1102', '00000000-0000-4000-8000-0000000e0102', 'Expiry foreign holder', TRUE, 'busy', 'online', clock_timestamp());
INSERT INTO public.characters (id, name, is_active, is_visible, availability_status)
VALUES ('00000000-0000-4000-8000-0000000e2101', 'Claim expiry character', TRUE, TRUE, 'available');
INSERT INTO public.character_operator_assignments (character_id, operator_id) VALUES
  ('00000000-0000-4000-8000-0000000e2101', '00000000-0000-4000-8000-0000000e1101'), ('00000000-0000-4000-8000-0000000e2101', '00000000-0000-4000-8000-0000000e1102');
UPDATE public.system_settings SET value = '"lock"'::jsonb WHERE key = 'concurrency_mode';
CREATE TEMP TABLE claim_expiry_cases (
  route text, kind text, conversation_id uuid PRIMARY KEY, client_id uuid, message_id uuid, work_item_id uuid, lock_before jsonb
) ON COMMIT DROP;
INSERT INTO claim_expiry_cases (route, kind, conversation_id, client_id, message_id) VALUES
  ('explicit', 'missing', '00000000-0000-4000-8000-0000000e3101', '00000000-0000-4000-8000-0000000e0111', '00000000-0000-4000-8000-0000000e4101'),
  ('explicit', 'elapsed', '00000000-0000-4000-8000-0000000e3102', '00000000-0000-4000-8000-0000000e0112', '00000000-0000-4000-8000-0000000e4102'),
  ('explicit', 'boundary', '00000000-0000-4000-8000-0000000e3103', '00000000-0000-4000-8000-0000000e0113', '00000000-0000-4000-8000-0000000e4103'),
  ('explicit', 'future', '00000000-0000-4000-8000-0000000e3104', '00000000-0000-4000-8000-0000000e0114', '00000000-0000-4000-8000-0000000e4104'),
  ('explicit', 'nonpending', '00000000-0000-4000-8000-0000000e3105', '00000000-0000-4000-8000-0000000e0115', '00000000-0000-4000-8000-0000000e4105'),
  ('automatic', 'missing', '00000000-0000-4000-8000-0000000e3106', '00000000-0000-4000-8000-0000000e0116', '00000000-0000-4000-8000-0000000e4106'),
  ('automatic', 'elapsed', '00000000-0000-4000-8000-0000000e3107', '00000000-0000-4000-8000-0000000e0117', '00000000-0000-4000-8000-0000000e4107'),
  ('automatic', 'boundary', '00000000-0000-4000-8000-0000000e3108', '00000000-0000-4000-8000-0000000e0118', '00000000-0000-4000-8000-0000000e4108'),
  ('automatic', 'future', '00000000-0000-4000-8000-0000000e3109', '00000000-0000-4000-8000-0000000e0119', '00000000-0000-4000-8000-0000000e4109'),
  ('automatic', 'nonpending', '00000000-0000-4000-8000-0000000e3110', '00000000-0000-4000-8000-0000000e0120', '00000000-0000-4000-8000-0000000e4110');

INSERT INTO public.conversations (id, client_id, character_id, status)
SELECT conversation_id, client_id, '00000000-0000-4000-8000-0000000e2101', 'open' FROM claim_expiry_cases;
-- Positive preparation is exclusively the canonical Client projection.
INSERT INTO public.messages (id, conversation_id, sender_type, sender_id, content, created_at)
SELECT message_id, conversation_id, 'client'::public.sender_type, client_id, route || ' ' || kind,
       CASE kind WHEN 'elapsed' THEN clock_timestamp() - interval '181 seconds'
                 WHEN 'boundary' THEN clock_timestamp() - interval '180 seconds'
                 ELSE clock_timestamp() END
FROM claim_expiry_cases;
-- Fault injection for missing deadline and missing pending; never used to prepare success.
UPDATE public.conversations c SET inactivity_expires_at = NULL
FROM claim_expiry_cases e WHERE c.id = e.conversation_id AND e.kind = 'missing';
UPDATE public.conversations c SET needs_handling = FALSE, pending_since = NULL
FROM claim_expiry_cases e WHERE c.id = e.conversation_id AND e.kind = 'nonpending';
INSERT INTO public.conversation_locks (conversation_id, locked_by_operator_id, locked_by_user_id, locked_at, last_activity_at, expires_at)
SELECT conversation_id, '00000000-0000-4000-8000-0000000e1102', '00000000-0000-4000-8000-0000000e0102', clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 hour'
FROM claim_expiry_cases;
UPDATE claim_expiry_cases e
SET work_item_id = (SELECT w.id FROM public.conversation_work_items w WHERE w.conversation_id = e.conversation_id),
    lock_before = (SELECT to_jsonb(l) FROM public.conversation_locks l WHERE l.conversation_id = e.conversation_id);
SELECT is((
  SELECT count(*) FROM claim_expiry_cases e
  JOIN public.conversations c ON c.id = e.conversation_id
  JOIN public.conversation_work_items w ON w.id = e.work_item_id AND w.conversation_id = c.id
  JOIN public.messages m ON m.id = e.message_id AND m.id = w.last_client_message_id
  WHERE w.status = 'new' AND w.responsible_operator_id IS NULL AND w.assigned_at IS NULL
    AND c.assigned_operator_id IS NULL
    AND (SELECT count(*) FROM public.conversation_work_items active WHERE active.conversation_id = c.id AND active.status IN ('new','assigned','in_progress')) = 1
    AND NOT EXISTS (SELECT 1 FROM public.conversation_handling_cycles cycle WHERE cycle.conversation_id = c.id AND cycle.ended_at IS NULL)
    AND ((e.kind = 'nonpending' AND c.needs_handling IS FALSE AND c.pending_since IS NULL)
         OR (e.kind <> 'nonpending' AND c.needs_handling IS TRUE AND c.pending_since = m.created_at))
    AND c.last_business_message_at = m.created_at
    AND ((e.kind = 'missing' AND c.inactivity_expires_at IS NULL)
         OR (e.kind <> 'missing' AND c.inactivity_expires_at = m.created_at + interval '180 seconds'))
    AND (e.kind NOT IN ('elapsed','boundary') OR c.inactivity_expires_at <= clock_timestamp())
    AND (e.kind <> 'future' OR c.inactivity_expires_at > clock_timestamp())
), 10::bigint, 'Canonical cases distinguish missing, elapsed, boundary, future expiry and missing pending');

SELECT set_config('claim_expiry.item_id', (SELECT work_item_id::text FROM claim_expiry_cases WHERE conversation_id = '00000000-0000-4000-8000-0000000e3101'), true);
SELECT set_config('claim_expiry.before', pg_temp.claim_expiry_state('00000000-0000-4000-8000-0000000e3101')::text, true);
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000e0101';
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$SELECT public.claim_new_conversation(current_setting('claim_expiry.item_id')::uuid)$$,
  'P0001', 'conversation_claim_state_expired', 'explicit missing expiry'
);
RESET ROLE;
SELECT is(pg_temp.claim_expiry_state('00000000-0000-4000-8000-0000000e3101'), current_setting('claim_expiry.before')::jsonb,
          'explicit missing expiry has no claim side effects');

SELECT set_config('claim_expiry.item_id', (SELECT work_item_id::text FROM claim_expiry_cases WHERE conversation_id = '00000000-0000-4000-8000-0000000e3102'), true);
SELECT set_config('claim_expiry.before', pg_temp.claim_expiry_state('00000000-0000-4000-8000-0000000e3102')::text, true);
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000e0101';
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$SELECT public.claim_new_conversation(current_setting('claim_expiry.item_id')::uuid)$$,
  'P0001', 'conversation_claim_state_expired', 'explicit elapsed expiry'
);
RESET ROLE;
SELECT is(pg_temp.claim_expiry_state('00000000-0000-4000-8000-0000000e3102'), current_setting('claim_expiry.before')::jsonb,
          'explicit elapsed expiry has no claim side effects');

SELECT set_config('claim_expiry.item_id', (SELECT work_item_id::text FROM claim_expiry_cases WHERE conversation_id = '00000000-0000-4000-8000-0000000e3103'), true);
SELECT set_config('claim_expiry.before', pg_temp.claim_expiry_state('00000000-0000-4000-8000-0000000e3103')::text, true);
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000e0101';
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$SELECT public.claim_new_conversation(current_setting('claim_expiry.item_id')::uuid)$$,
  'P0001', 'conversation_claim_state_expired', 'explicit boundary expiry'
);
RESET ROLE;
SELECT is(pg_temp.claim_expiry_state('00000000-0000-4000-8000-0000000e3103'), current_setting('claim_expiry.before')::jsonb,
          'explicit boundary expiry has no claim side effects');

SELECT set_config('claim_expiry.item_id', (SELECT work_item_id::text FROM claim_expiry_cases WHERE conversation_id = '00000000-0000-4000-8000-0000000e3105'), true);
SELECT set_config('claim_expiry.before', pg_temp.claim_expiry_state('00000000-0000-4000-8000-0000000e3105')::text, true);
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000e0101';
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$SELECT public.claim_new_conversation(current_setting('claim_expiry.item_id')::uuid)$$,
  'P0001', 'conversation_already_claimed', 'explicit missing pending'
);
RESET ROLE;
SELECT is(pg_temp.claim_expiry_state('00000000-0000-4000-8000-0000000e3105'), current_setting('claim_expiry.before')::jsonb,
          'explicit missing pending has no claim side effects');

SELECT set_config('claim_expiry.item_id', (SELECT work_item_id::text FROM claim_expiry_cases WHERE conversation_id = '00000000-0000-4000-8000-0000000e3104'), true);
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000e0101';
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$SELECT set_config('claim_expiry.success', public.claim_new_conversation(current_setting('claim_expiry.item_id')::uuid)::text, true)$$,
  'eligible claim with foreign legacy lock'
);
RESET ROLE;
SELECT ok(
  (current_setting('claim_expiry.success')::jsonb->>'claimed')::boolean IS TRUE
  AND (current_setting('claim_expiry.success')::jsonb->>'already_claimed')::boolean IS FALSE,
  'Future expiry produces a new claim rather than a replay'
);
SELECT is((
  SELECT count(*) FROM public.conversation_handling_cycles cycle
  JOIN public.conversations c ON c.id = cycle.conversation_id
  JOIN public.conversation_work_items w ON w.id = cycle.work_item_id AND w.conversation_id = c.id
  WHERE c.id = '00000000-0000-4000-8000-0000000e3104' AND cycle.ended_at IS NULL AND cycle.operator_id = '00000000-0000-4000-8000-0000000e1101'
    AND cycle.id::text = current_setting('claim_expiry.success')::jsonb->>'cycle_id'
    AND w.id = current_setting('claim_expiry.item_id')::uuid AND w.status = 'assigned'
    AND w.responsible_operator_id = cycle.operator_id AND c.assigned_operator_id = cycle.operator_id
), 1::bigint, 'Future claim creates exactly one consistently linked active cycle');
SELECT is((SELECT to_jsonb(l) FROM public.conversation_locks l WHERE l.conversation_id = '00000000-0000-4000-8000-0000000e3104'),
          (SELECT lock_before FROM claim_expiry_cases WHERE conversation_id = '00000000-0000-4000-8000-0000000e3104'),
          'Future claim leaves foreign legacy lock unchanged');
SELECT set_config('claim_expiry.cycle_id', (SELECT id::text FROM public.conversation_handling_cycles WHERE conversation_id = '00000000-0000-4000-8000-0000000e3104' AND ended_at IS NULL), true);
SELECT set_config('claim_expiry.before', pg_temp.claim_expiry_state('00000000-0000-4000-8000-0000000e3104')::text, true);
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000e0102';
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$SELECT public.claim_new_conversation(current_setting('claim_expiry.item_id')::uuid)$$,
  'P0001', 'conversation_already_claimed', 'foreign cycle blocks claim'
);
RESET ROLE;
SELECT is(pg_temp.claim_expiry_state('00000000-0000-4000-8000-0000000e3104'), current_setting('claim_expiry.before')::jsonb,
          'Foreign owner rejection leaves state unchanged');

-- Replay fault injection does not represent a new Client activity.
UPDATE public.conversations SET inactivity_expires_at = NULL WHERE id = '00000000-0000-4000-8000-0000000e3104';
SELECT set_config('claim_expiry.before', pg_temp.claim_expiry_state('00000000-0000-4000-8000-0000000e3104')::text, true);
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000e0101';
SET LOCAL ROLE authenticated;
SELECT is(
  public.claim_new_conversation(current_setting('claim_expiry.item_id')::uuid),
  jsonb_build_object('claimed', true, 'already_claimed', true,
    'work_item_id', current_setting('claim_expiry.item_id')::uuid,
    'conversation_id', '00000000-0000-4000-8000-0000000e3104'::uuid, 'status', 'assigned',
    'cycle_id', current_setting('claim_expiry.cycle_id')::uuid),
  'NULL-expiry replay returns the original cycle'
);
RESET ROLE;
SELECT is(pg_temp.claim_expiry_state('00000000-0000-4000-8000-0000000e3104'), current_setting('claim_expiry.before')::jsonb,
          'NULL-expiry replay returns the original cycle without writes or expiry renewal');

WITH old_activity AS (SELECT clock_timestamp() - interval '181 seconds' AS at)
UPDATE public.conversations SET last_business_message_at = old_activity.at, inactivity_expires_at = old_activity.at + interval '180 seconds'
FROM old_activity WHERE id = '00000000-0000-4000-8000-0000000e3104';
SELECT set_config('claim_expiry.before', pg_temp.claim_expiry_state('00000000-0000-4000-8000-0000000e3104')::text, true);
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000e0101';
SET LOCAL ROLE authenticated;
SELECT is(
  public.claim_new_conversation(current_setting('claim_expiry.item_id')::uuid),
  jsonb_build_object('claimed', true, 'already_claimed', true,
    'work_item_id', current_setting('claim_expiry.item_id')::uuid,
    'conversation_id', '00000000-0000-4000-8000-0000000e3104'::uuid, 'status', 'assigned',
    'cycle_id', current_setting('claim_expiry.cycle_id')::uuid),
  'expired replay returns the original cycle'
);
RESET ROLE;
SELECT is(pg_temp.claim_expiry_state('00000000-0000-4000-8000-0000000e3104'), current_setting('claim_expiry.before')::jsonb,
          'expired replay returns the original cycle without writes or expiry renewal');

-- Snapshot every row before allocation; invalid rows must be untouched, not repaired.
CREATE TEMP TABLE claim_expiry_before ON COMMIT DROP AS
SELECT conversation_id, pg_temp.claim_expiry_state(conversation_id) AS state FROM claim_expiry_cases;
SELECT is(private.allocate_new_conversations(500), 1, 'Allocator accepts only the future NEW case');
SELECT is((SELECT count(*) FROM public.conversation_handling_cycles
           WHERE conversation_id = '00000000-0000-4000-8000-0000000e3109' AND operator_id = '00000000-0000-4000-8000-0000000e1101' AND ended_at IS NULL),
          1::bigint, 'Allocator creates one cycle for valid future expiry');
SELECT is((
  SELECT count(*) FROM claim_expiry_cases e JOIN claim_expiry_before b USING (conversation_id)
  WHERE e.route = 'automatic' AND e.kind <> 'future' AND pg_temp.claim_expiry_state(e.conversation_id) = b.state
), 4::bigint, 'allocator skips invalid rows without mutation');
SELECT is(pg_temp.claim_expiry_state('00000000-0000-4000-8000-0000000e3104'),
          (SELECT state FROM claim_expiry_before WHERE conversation_id = '00000000-0000-4000-8000-0000000e3104'),
          'Allocator does not replace an already active cycle even with elapsed expiry');
SELECT is((SELECT to_jsonb(l) FROM public.conversation_locks l WHERE l.conversation_id = '00000000-0000-4000-8000-0000000e3109'),
          (SELECT lock_before FROM claim_expiry_cases WHERE conversation_id = '00000000-0000-4000-8000-0000000e3109'),
          'Automatic allocation leaves valid foreign lock unchanged');
SELECT ok(
  NOT EXISTS (SELECT 1 FROM public.messages m JOIN claim_expiry_cases e ON e.conversation_id = m.conversation_id WHERE m.sender_type = 'operator')
  AND NOT EXISTS (SELECT 1 FROM private.handling_send_authority_evidence a JOIN claim_expiry_cases e ON e.conversation_id = a.conversation_id),
  'Claim-only scenarios do not manufacture messages or send-authority evidence'
);
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000e0103';
SET LOCAL ROLE authenticated;
SELECT lives_ok($$SELECT public.run_handling_allocation(500)$$, 'Admin wrapper performs its normal stale cleanup');
RESET ROLE;
SELECT ok(
  (SELECT count(*) FROM public.conversation_handling_cycles WHERE conversation_id = '00000000-0000-4000-8000-0000000e3104') = 1
  AND EXISTS (SELECT 1 FROM public.conversation_handling_cycles WHERE id = current_setting('claim_expiry.cycle_id')::uuid AND ended_at IS NOT NULL)
  AND EXISTS (SELECT 1 FROM public.conversations c JOIN public.conversation_work_items w ON w.conversation_id = c.id
              WHERE c.id = '00000000-0000-4000-8000-0000000e3104' AND c.assigned_operator_id IS NULL AND c.needs_handling IS TRUE
                AND w.status = 'new' AND w.responsible_operator_id IS NULL AND c.inactivity_expires_at <= clock_timestamp()),
  'admin cleanup does not reclaim expired NEW'
);
SELECT is((
  SELECT count(*) FROM claim_expiry_cases e JOIN claim_expiry_before b USING (conversation_id)
  WHERE e.route = 'automatic' AND e.kind <> 'future' AND pg_temp.claim_expiry_state(e.conversation_id) = b.state
), 4::bigint, 'Admin wrapper preserves invalid NEW rows independently of cleanup effects');
SELECT set_config('claim_expiry.before', pg_temp.claim_expiry_state('00000000-0000-4000-8000-0000000e3104')::text, true);
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000e0101';
SET LOCAL ROLE authenticated;
SELECT lives_ok($$SELECT public.operator_heartbeat()$$, 'Heartbeat wrapper runs without claiming elapsed work');
RESET ROLE;
SELECT is(pg_temp.claim_expiry_state('00000000-0000-4000-8000-0000000e3104'), current_setting('claim_expiry.before')::jsonb,
          'heartbeat does not reclaim expired NEW');
SELECT * FROM finish();
ROLLBACK;
