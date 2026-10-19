BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;

CREATE OR REPLACE FUNCTION pg_temp.wp01_create_user(_id uuid, _email text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO auth.users (
    id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES (
    _id, 'authenticated', 'authenticated', _email, 'not-used-by-local-tests', clock_timestamp(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp()
  );
$$;

CREATE OR REPLACE FUNCTION pg_temp.wp01_conversation_state(_conversation_id uuid, _client_id uuid)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'messages', (SELECT count(*) FROM public.messages WHERE conversation_id = _conversation_id),
    'work_items', (SELECT count(*) FROM public.conversation_work_items WHERE conversation_id = _conversation_id),
    'cycles', (SELECT count(*) FROM public.conversation_handling_cycles WHERE conversation_id = _conversation_id),
    'issues', (SELECT count(*) FROM private.handling_reconciliation_issues WHERE conversation_id = _conversation_id),
    'ledger', (SELECT count(*) FROM public.credit_transactions WHERE user_id = _client_id),
    'notifications', (SELECT count(*) FROM public.notifications WHERE conversation_id = _conversation_id),
    'analytics', (SELECT count(*) FROM public.analytics_events WHERE conversation_id = _conversation_id),
    'next_sequence', (SELECT handling_next_sequence FROM public.conversations WHERE id = _conversation_id),
    'last_sequence', (SELECT last_handling_message_sequence FROM public.conversations WHERE id = _conversation_id),
    'needs_handling', (SELECT needs_handling FROM public.conversations WHERE id = _conversation_id),
    'pending_since', (SELECT pending_since FROM public.conversations WHERE id = _conversation_id)
  );
$$;

CREATE OR REPLACE FUNCTION pg_temp.wp01_resolution_state(_message_id UUID)
RETURNS JSONB
LANGUAGE sql
AS $$
  SELECT jsonb_build_object(
    'message', to_jsonb(message),
    'issue', to_jsonb(issue)
  )
  FROM public.messages message
  LEFT JOIN private.handling_reconciliation_issues issue
    ON issue.message_id = message.id
  WHERE message.id = _message_id;
$$;

CREATE OR REPLACE FUNCTION pg_temp.wp01_assert_semantic_corruption(
  _conversation_id UUID,
  _label TEXT
)
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN NEXT is(
    (
      SELECT reconciliation.semantic_consistent
      FROM private.get_handling_shadow_reconciliation() reconciliation
      WHERE reconciliation.conversation_id = _conversation_id
    ),
    FALSE,
    _label || ' is semantically inconsistent'
  );
  RETURN NEXT is(
    (
      SELECT reconciliation.shadow_consistent
      FROM private.get_handling_shadow_reconciliation() reconciliation
      WHERE reconciliation.conversation_id = _conversation_id
    ),
    FALSE,
    _label || ' fails reconciliation'
  );
  RETURN NEXT is(
    (SELECT readiness.shadow_consistent FROM private.get_handling_cutover_readiness() readiness),
    FALSE,
    _label || ' fails readiness'
  );
  RETURN NEXT ok(
    (
      SELECT readiness.inconsistent_conversations > 0
      FROM private.get_handling_cutover_readiness() readiness
    ),
    _label || ' increments the readiness inconsistency count'
  );
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.wp01_handling_writer_candidates()
RETURNS TABLE (
  routine_oid OID,
  signature TEXT,
  routine_schema TEXT,
  routine_name TEXT,
  discovery_reason TEXT
)
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE routines AS (
    SELECT
      procedure.oid,
      format(
        '%I.%I(%s)',
        namespace.nspname,
        procedure.proname,
        pg_get_function_identity_arguments(procedure.oid)
      ) AS signature,
      namespace.nspname AS routine_schema,
      procedure.proname AS routine_name,
      procedure.prosrc
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE procedure.prokind = 'f'
      AND (
        namespace.nspname IN ('public', 'private')
        OR namespace.nspname = pg_my_temp_schema()::regnamespace::TEXT
      )
  ),
  direct_writers AS (
    SELECT
      routine.*,
      ('direct target-table DML'::TEXT COLLATE "C") AS discovery_reason,
      0 AS depth
    FROM routines routine
    WHERE routine.prosrc ~* '(insert[[:space:]]+into|update|delete[[:space:]]+from)[[:space:]]+(public[.])?(conversations|messages|conversation_handling_cycles|conversation_work_items)([^a-z_]|$)'
  ),
  target_triggers AS (
    SELECT
      routine.*,
      ('trigger on target table'::TEXT COLLATE "C") AS discovery_reason,
      0 AS depth
    FROM routines routine
    JOIN pg_trigger trigger ON trigger.tgfoid = routine.oid
    WHERE trigger.tgrelid IN (
        'public.conversations'::regclass,
        'public.messages'::regclass,
        'public.conversation_handling_cycles'::regclass,
        'public.conversation_work_items'::regclass
      )
      AND NOT trigger.tgisinternal
  ),
  roots AS (
    SELECT * FROM direct_writers
    UNION
    SELECT * FROM target_triggers
  ),
  call_graph AS (
    SELECT * FROM roots

    UNION

    SELECT
      caller.*,
      (format('calls %s', callee.signature)::TEXT COLLATE "C") AS discovery_reason,
      callee.depth + 1
    FROM call_graph callee
    JOIN routines caller
      ON caller.oid <> callee.oid
     AND caller.prosrc ~ (
       '(^|[^a-zA-Z0-9_])'
       || callee.routine_schema
       || '[.]'
       || callee.routine_name
       || '[[:space:]]*[(]'
     )
    WHERE callee.depth < 8
  )
  SELECT DISTINCT ON (candidate.signature)
    candidate.oid,
    candidate.signature,
    candidate.routine_schema,
    candidate.routine_name,
    candidate.discovery_reason
  FROM call_graph candidate
  ORDER BY candidate.signature, candidate.depth, candidate.discovery_reason;
$$;

CREATE TEMP TABLE wp01_handling_writer_inventory (
  signature TEXT PRIMARY KEY,
  classification TEXT NOT NULL CHECK (
    classification IN ('relevant_writer', 'relevant_guard', 'cutover_safe_non_handling')
  ),
  justification TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO wp01_handling_writer_inventory (signature, classification, justification)
VALUES
  ('public.send_client_message(uuid, text)', 'relevant_writer', 'writes messages and handling projections'),
  ('public.send_operator_message(uuid, text)', 'relevant_writer', 'writes messages and handling projections'),
  ('public.send_operator_media_message(uuid, text, text)', 'relevant_writer', 'writes messages and attachments'),
  ('public.send_operator_locked_media_message(uuid, text)', 'relevant_writer', 'writes messages and locked-media attachments'),
  ('public.send_client_sticker_message(uuid, uuid, uuid)', 'relevant_writer', 'writes messages and sticker attempts'),
  ('public.send_operator_sticker_message(uuid, uuid, uuid)', 'relevant_writer', 'writes messages and sticker attempts'),
  ('public.send_admin_sticker_message(uuid, uuid, uuid)', 'relevant_writer', 'writes messages and sticker attempts'),
  ('public.send_admin_media_message(uuid, text)', 'relevant_writer', 'writes messages and media attachments'),
  ('public.start_operator_outreach(uuid, uuid, text, text)', 'relevant_writer', 'creates conversations and messages'),
  ('public.claim_new_conversation(uuid)', 'relevant_writer', 'writes work-item, conversation and cycle ownership'),
  ('public.release_operator_conversation(uuid, text)', 'relevant_writer', 'releases work-item, conversation and cycle ownership'),
  ('public.return_stale_work_items_to_new()', 'relevant_writer', 'delegates stale handling-state writes'),
  ('public.operator_heartbeat()', 'relevant_writer', 'delegates stale handling-state writes'),
  ('public.admin_set_conversation_status(uuid, public.conversation_status)', 'relevant_writer', 'changes conversation lifecycle'),
  ('public.admin_reassign_conversation(uuid, uuid)', 'relevant_writer', 'changes handling ownership'),
  ('public.archive_client_pii(uuid, text, text)', 'relevant_writer', 'closes conversations and handling state'),
  ('public.start_or_get_conversation(uuid)', 'relevant_writer', 'creates and locks conversation lifecycle rows'),
  ('public.hide_conversation_for_client(uuid)', 'relevant_writer', 'changes conversation visibility lifecycle'),
  ('public.handle_new_message()', 'relevant_writer', 'message trigger changes conversation lifecycle and legacy projections'),
  ('public.mark_conversation_read(uuid, text)', 'cutover_safe_non_handling', 'updates read-state, unread counters and is_read only'),
  ('private.create_operator_message_with_scoring(uuid, uuid, uuid, text, jsonb)', 'relevant_writer', 'writes staff messages and score projections'),
  ('private.send_sticker_message(uuid, uuid, uuid, text)', 'relevant_writer', 'writes messages, attempts and ledger effects'),
  ('private.return_stale_work_items_to_new()', 'relevant_writer', 'returns stale work items and closes cycles'),
  ('private.close_handling_cycle_on_staff_message()', 'relevant_writer', 'message trigger closes active cycles'),
  ('private.close_conversation_work_items()', 'relevant_writer', 'conversation trigger closes work items and cycles'),
  ('private.upsert_conversation_work_item_from_client_message()', 'relevant_writer', 'message trigger creates or updates NEW work items'),
  ('private.sync_client_hidden_at_from_deletion()', 'relevant_writer', 'deletion trigger changes conversation visibility lifecycle'),
  ('private.prepare_message_handling_shadow()', 'relevant_writer', 'message trigger writes handling metadata and projections'),
  ('private.record_message_handling_issue()', 'relevant_writer', 'message trigger records unresolved classification evidence'),
  ('private.enforce_handling_writer_barrier()', 'relevant_guard', 'statement trigger acquires the shared writer barrier'),
  ('private.initialize_conversation_handling_shadow_locked(uuid)', 'relevant_writer', 'initializes message and conversation shadow state'),
  ('private.recompute_conversation_handling_shadow_locked(uuid)', 'relevant_writer', 'recomputes conversation shadow projections'),
  ('private.backfill_handling_shadow_batch(integer)', 'relevant_writer', 'delegates shadow initialization in a bounded batch'),
  ('private.resolve_handling_reconciliation_issue(uuid, text, uuid, text)', 'relevant_writer', 'changes message classification from explicit evidence'),
  ('private.assert_operator_can_send_base(uuid)', 'relevant_guard', 'locks a conversation before send authorization'),
  ('private.assert_operator_can_send_conversation_message(uuid)', 'relevant_guard', 'locks active handling authority before send'),
  ('private.assert_operator_can_send_for_cycle(uuid, uuid)', 'relevant_guard', 'locks and validates the cycle authority token'),
  ('private.acquire_operator_send_authority(uuid, uuid)', 'relevant_guard', 'validates token authority or claims atomically before a send'),
  ('private.send_operator_message(uuid, text)', 'relevant_writer', 'private body for strict public text sends'),
  ('private.send_operator_media_message(uuid, text, text)', 'relevant_writer', 'private body for strict public media sends'),
  ('private.send_operator_locked_media_message(uuid, text)', 'relevant_writer', 'private body for strict public locked-media sends'),
  ('private.send_operator_sticker_message(uuid, uuid, uuid)', 'relevant_writer', 'private body for strict public Sticker sends'),
  ('public.send_operator_message(uuid, text, uuid)', 'relevant_writer', 'strict token public text wrapper'),
  ('public.send_operator_media_message(uuid, text, text, uuid)', 'relevant_writer', 'strict token public media wrapper'),
  ('public.send_operator_locked_media_message(uuid, text, uuid)', 'relevant_writer', 'strict token public locked-media wrapper'),
  ('public.send_operator_sticker_message(uuid, uuid, uuid, uuid)', 'relevant_writer', 'strict token public Sticker wrapper'),
  ('private.assert_operator_can_claim_conversation(uuid)', 'relevant_guard', 'guards claim before ownership writes'),
  ('public.set_updated_at()', 'cutover_safe_non_handling', 'touches updated_at only'),
  ('public.notify_on_new_message()', 'cutover_safe_non_handling', 'emits notifications without changing handling authority'),
  ('public.notify_analytics_conversation_started()', 'cutover_safe_non_handling', 'records conversation-start analytics only'),
  ('public.notify_analytics_message_sent()', 'cutover_safe_non_handling', 'records analytics without changing handling authority'),
  ('private.assert_message_attachment_delivery_mode()', 'cutover_safe_non_handling', 'validates attachment metadata only'),
  ('private.assert_message_sticker_marker()', 'cutover_safe_non_handling', 'validates sticker message markers only'),
  ('private.assert_message_gift_marker()', 'cutover_safe_non_handling', 'legacy validation trigger; Gifts remain removed'),
  ('private.emit_v2_33_new_available_on_work_item()', 'cutover_safe_non_handling', 'emits semantic-deduped notifications only'),
  ('private.record_v2_33_handling_cycle_started()', 'cutover_safe_non_handling', 'records analytics for an already-written cycle'),
  ('private.record_v2_33_handling_cycle_ended()', 'cutover_safe_non_handling', 'records analytics for an already-written cycle'),
  ('private.record_v2_33_outreach_replied()', 'cutover_safe_non_handling', 'records outreach analytics only');

SELECT no_plan();

SELECT is(
  COALESCE((
    SELECT string_agg(inventory.signature, ', ' ORDER BY inventory.signature)
    FROM wp01_handling_writer_inventory inventory
    LEFT JOIN pg_proc procedure ON procedure.oid = to_regprocedure(inventory.signature)
    WHERE inventory.classification IN ('relevant_writer', 'relevant_guard')
      AND (
        procedure.oid IS NULL
        OR procedure.prosrc !~ 'BEGIN[[:space:]]+PERFORM private\.acquire_handling_writer_barrier\(\);'
      )
  ), ''),
  '',
  'Every inventoried writer acquires the shared barrier as its first executable statement'
);

SELECT is(
  COALESCE((
    SELECT string_agg(candidate.signature, ', ' ORDER BY candidate.signature)
    FROM pg_temp.wp01_handling_writer_candidates() candidate
    LEFT JOIN wp01_handling_writer_inventory inventory
      ON to_regprocedure(inventory.signature) = candidate.routine_oid
    WHERE candidate.routine_schema IN ('public', 'private')
      AND inventory.signature IS NULL
  ), ''),
  '',
  'Every discovered handling writer is explicitly classified in the inventory'
);

SELECT ok(
  (
    SELECT procedure.prosrc ~ 'conversation_read_states'
      AND procedure.prosrc ~ 'client_unread_count'
      AND procedure.prosrc ~ 'is_read'
      AND procedure.prosrc !~ '(needs_handling|pending_since|handling_next_sequence|last_handling_message_sequence|conversation_handling_cycles|conversation_work_items)'
    FROM pg_proc procedure
    WHERE procedure.oid = 'public.mark_conversation_read(uuid,text)'::regprocedure
  ),
  'mark_conversation_read is technically limited to read-state projections'
);

CREATE OR REPLACE FUNCTION pg_temp.wp01_unclassified_writer_probe()
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.conversations
  SET updated_at = updated_at
  WHERE FALSE;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_temp.wp01_handling_writer_candidates() candidate
    LEFT JOIN wp01_handling_writer_inventory inventory
      ON to_regprocedure(inventory.signature) = candidate.routine_oid
    WHERE candidate.routine_name = 'wp01_unclassified_writer_probe'
      AND inventory.signature IS NULL
  ),
  'Writer discovery identifies an unclassified synthetic direct-DML candidate'
);

SELECT is(
  COALESCE((
    SELECT string_agg(format('%s.%s', namespace.nspname, class.relname), ', ' ORDER BY namespace.nspname, class.relname)
    FROM (VALUES
      ('public.messages'::regclass),
      ('public.conversation_handling_cycles'::regclass),
      ('public.conversation_work_items'::regclass),
      ('public.conversations'::regclass)
    ) expected(relation_id)
    JOIN pg_class class ON class.oid = expected.relation_id
    JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_trigger trigger
      WHERE trigger.tgrelid = expected.relation_id
        AND trigger.tgenabled = 'O'
        AND NOT trigger.tgisinternal
        AND (trigger.tgtype & 2) = 2
        AND (trigger.tgtype & 1) = 0
        AND pg_get_triggerdef(trigger.oid) LIKE '%private.enforce_handling_writer_barrier()%'
    )
  ), ''),
  '',
  'Messages, cycles, work items and conversations have active BEFORE STATEMENT barrier defense triggers'
);

SELECT is(
  has_table_privilege('authenticated', 'public.conversations', 'UPDATE'),
  false,
  'Authenticated has no table-wide conversation UPDATE privilege'
);
SELECT is(
  has_column_privilege('authenticated', 'public.conversations', 'status', 'UPDATE'),
  true,
  'Authenticated retains direct status UPDATE subject to RLS'
);
SELECT is(
  has_column_privilege('authenticated', 'public.conversations', 'needs_handling', 'UPDATE'),
  false,
  'Authenticated cannot directly update needs_handling'
);
SELECT is(
  has_column_privilege('authenticated', 'public.conversations', 'pending_since', 'UPDATE'),
  false,
  'Authenticated cannot directly update pending_since'
);
SELECT is(
  has_column_privilege('authenticated', 'public.conversations', 'handling_next_sequence', 'UPDATE'),
  false,
  'Authenticated cannot directly update handling_next_sequence'
);
SELECT is(
  COALESCE((
    SELECT string_agg(shadow_column.column_name, ', ' ORDER BY shadow_column.column_name)
    FROM (VALUES
      ('needs_handling'),
      ('pending_since'),
      ('last_business_message_at'),
      ('inactivity_expires_at'),
      ('handling_next_sequence'),
      ('last_handling_message_sequence'),
      ('handling_state_initialized'),
      ('handling_state_updated_at')
    ) shadow_column(column_name)
    WHERE has_column_privilege(
      'authenticated',
      'public.conversations',
      shadow_column.column_name,
      'UPDATE'
    )
  ), ''),
  '',
  'Authenticated has no direct UPDATE privilege on any handling shadow column'
);
SELECT is(
  has_column_privilege('anon', 'public.conversations', 'status', 'UPDATE'),
  false,
  'Anonymous users cannot directly update conversation status'
);

SELECT is(
  to_regprocedure('private.assert_operator_can_send_conversation_message(uuid,boolean)'),
  NULL::regprocedure,
  'The obsolete boolean compatibility overload is removed after caller verification'
);

SELECT is(
  (SELECT mode FROM private.handling_contract_runtime WHERE singleton),
  'legacy_shadow',
  'WP01 expand remains in legacy_shadow mode'
);
SELECT is(
  (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid = 'public.messages'::regclass AND tgname = 'close_handling_cycle_on_staff_message'),
  NULL::text,
  'WP01.4 removes automatic first-response cycle closure'
);
SELECT is(
  has_function_privilege('authenticated', 'private.assert_operator_can_claim_conversation(uuid)'::regprocedure, 'EXECUTE'),
  false,
  'Claim guard is owner-only'
);
SELECT is(
  has_function_privilege('authenticated', 'private.assert_operator_can_send_for_cycle(uuid,uuid)'::regprocedure, 'EXECUTE'),
  false,
  'Cycle-token send guard is owner-only'
);
SELECT ok(
  to_regclass('public.conversation_handling_cycles_one_active_conversation_idx') IS NOT NULL,
  'One active handling cycle per conversation is enforced'
);

SELECT pg_temp.wp01_create_user('00000000-0000-4000-8000-0000000a0101', 'wp01-client@example.invalid');
SELECT pg_temp.wp01_create_user('00000000-0000-4000-8000-0000000a0102', 'wp01-operator@example.invalid');
SELECT pg_temp.wp01_create_user('00000000-0000-4000-8000-0000000a0103', 'wp01-history-client@example.invalid');
SELECT pg_temp.wp01_create_user('00000000-0000-4000-8000-0000000a0104', 'wp01-other-operator@example.invalid');
SELECT pg_temp.wp01_create_user('00000000-0000-4000-8000-0000000a0105', 'wp01-claim-client@example.invalid');
SELECT pg_temp.wp01_create_user('00000000-0000-4000-8000-0000000a0106', 'wp01-empty-client@example.invalid');
SELECT pg_temp.wp01_create_user('00000000-0000-4000-8000-0000000a0107', 'wp01-none-client@example.invalid');
SELECT pg_temp.wp01_create_user('00000000-0000-4000-8000-0000000a0108', 'wp01-system-client@example.invalid');
SELECT pg_temp.wp01_create_user('00000000-0000-4000-8000-0000000a0109', 'wp01-order-client@example.invalid');
SELECT pg_temp.wp01_create_user('00000000-0000-4000-8000-0000000a0110', 'wp01-issue-client@example.invalid');

INSERT INTO public.user_roles (user_id, role)
VALUES
  ('00000000-0000-4000-8000-0000000a0102', 'operator'),
  ('00000000-0000-4000-8000-0000000a0104', 'operator');

INSERT INTO public.operators (
  id, user_id, full_name, is_active, availability_status, presence_status, last_seen_at
)
VALUES (
  '00000000-0000-4000-8000-0000000a1102',
  '00000000-0000-4000-8000-0000000a0102',
  'WP01 Operator',
  TRUE,
  'available',
  'online',
  clock_timestamp()
), (
  '00000000-0000-4000-8000-0000000a1104',
  '00000000-0000-4000-8000-0000000a0104',
  'WP01 Other Operator',
  TRUE,
  'available',
  'online',
  clock_timestamp()
);

INSERT INTO public.characters (id, name, is_active, is_visible, availability_status)
VALUES
  ('00000000-0000-4000-8000-0000000a2101', 'WP01 live character', TRUE, TRUE, 'available'),
  ('00000000-0000-4000-8000-0000000a2102', 'WP01 history character', TRUE, TRUE, 'available');

INSERT INTO public.character_operator_assignments (character_id, operator_id)
VALUES
  ('00000000-0000-4000-8000-0000000a2101', '00000000-0000-4000-8000-0000000a1102'),
  ('00000000-0000-4000-8000-0000000a2102', '00000000-0000-4000-8000-0000000a1102'),
  ('00000000-0000-4000-8000-0000000a2101', '00000000-0000-4000-8000-0000000a1104'),
  ('00000000-0000-4000-8000-0000000a2102', '00000000-0000-4000-8000-0000000a1104');

INSERT INTO public.conversations (id, client_id, character_id, assigned_operator_id, status)
VALUES (
  '00000000-0000-4000-8000-0000000a3101',
  '00000000-0000-4000-8000-0000000a0101',
  '00000000-0000-4000-8000-0000000a2101',
  '00000000-0000-4000-8000-0000000a1102',
  'open'
);

INSERT INTO public.messages (
  id, conversation_id, sender_type, sender_id, content, created_at
)
VALUES (
  '00000000-0000-4000-8000-0000000a4101',
  '00000000-0000-4000-8000-0000000a3101',
  'client',
  '00000000-0000-4000-8000-0000000a0101',
  'first client request',
  '2026-10-06 20:00:00+00'
);

SELECT is(
  (SELECT handling_effect FROM public.messages WHERE id = '00000000-0000-4000-8000-0000000a4101'),
  'client_request',
  'Client message is classified as a request'
);
SELECT is(
  (SELECT handling_sequence FROM public.messages WHERE id = '00000000-0000-4000-8000-0000000a4101'),
  1::bigint,
  'First message receives sequence 1'
);
SELECT is(
  (SELECT needs_handling FROM public.conversations WHERE id = '00000000-0000-4000-8000-0000000a3101'),
  true,
  'Client message sets shadow needs_handling'
);
SELECT is(
  (SELECT pending_since FROM public.conversations WHERE id = '00000000-0000-4000-8000-0000000a3101'),
  '2026-10-06 20:00:00+00'::timestamptz,
  'First client message starts pending_since'
);

INSERT INTO public.messages (
  id, conversation_id, sender_type, sender_id, content, created_at
)
VALUES (
  '00000000-0000-4000-8000-0000000a4102',
  '00000000-0000-4000-8000-0000000a3101',
  'client',
  '00000000-0000-4000-8000-0000000a0101',
  'second client request',
  '2026-10-06 20:01:00+00'
);

SELECT is(
  (SELECT handling_sequence FROM public.messages WHERE id = '00000000-0000-4000-8000-0000000a4102'),
  2::bigint,
  'Second message receives the next conversation sequence'
);
SELECT is(
  (SELECT pending_since FROM public.conversations WHERE id = '00000000-0000-4000-8000-0000000a3101'),
  '2026-10-06 20:00:00+00'::timestamptz,
  'Additional Client messages do not reset pending_since'
);
SELECT is(
  (SELECT inactivity_expires_at FROM public.conversations WHERE id = '00000000-0000-4000-8000-0000000a3101'),
  '2026-10-06 20:04:00+00'::timestamptz,
  'Latest successful business message advances the shadow 180-second expiry'
);

INSERT INTO public.conversation_work_items (
  id, conversation_id, client_id, character_id, status,
  responsible_operator_id, assigned_at, last_client_message_id, last_activity_at
)
VALUES (
  '00000000-0000-4000-8000-0000000a5101',
  '00000000-0000-4000-8000-0000000a3101',
  '00000000-0000-4000-8000-0000000a0101',
  '00000000-0000-4000-8000-0000000a2101',
  'assigned',
  '00000000-0000-4000-8000-0000000a1102',
  clock_timestamp(),
  '00000000-0000-4000-8000-0000000a4102',
  clock_timestamp()
)
ON CONFLICT (conversation_id) WHERE status IN ('new', 'assigned', 'in_progress')
DO UPDATE SET
  status = 'assigned',
  responsible_operator_id = EXCLUDED.responsible_operator_id,
  assigned_at = EXCLUDED.assigned_at;

INSERT INTO public.conversation_handling_cycles (
  id, conversation_id, work_item_id, operator_id, started_at
)
SELECT
  '00000000-0000-4000-8000-0000000a6101',
  '00000000-0000-4000-8000-0000000a3101',
  work_item.id,
  '00000000-0000-4000-8000-0000000a1102',
  '2026-10-06 20:01:30+00'
FROM public.conversation_work_items work_item
WHERE work_item.conversation_id = '00000000-0000-4000-8000-0000000a3101'
  AND work_item.status IN ('new', 'assigned', 'in_progress');

INSERT INTO public.conversation_handling_cycles (
  id, conversation_id, work_item_id, operator_id, started_at, ended_at, end_reason
)
VALUES
  (
    '00000000-0000-4000-8000-0000000a6099',
    '00000000-0000-4000-8000-0000000a3101',
    NULL,
    '00000000-0000-4000-8000-0000000a1102',
    '2026-10-06 19:00:00+00',
    '2026-10-06 19:30:00+00',
    'released'
  ),
  (
    '00000000-0000-4000-8000-0000000a6100',
    '00000000-0000-4000-8000-0000000a3101',
    NULL,
    '00000000-0000-4000-8000-0000000a1102',
    '2026-10-06 19:31:00+00',
    '2026-10-06 19:59:00+00',
    'reassigned'
  );

INSERT INTO public.conversation_locks (
  conversation_id, locked_by_operator_id, locked_by_user_id,
  locked_at, last_activity_at, expires_at
)
VALUES (
  '00000000-0000-4000-8000-0000000a3101',
  '00000000-0000-4000-8000-0000000a1104',
  '00000000-0000-4000-8000-0000000a0104',
  clock_timestamp(),
  clock_timestamp(),
  clock_timestamp() + interval '1 hour'
);

UPDATE public.system_settings
SET value = '"lock"'::jsonb
WHERE key = 'concurrency_mode';

SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000a0102';

SELECT is(
  (
    SELECT handling_cycle_id
    FROM private.assert_operator_can_send_for_cycle(
      '00000000-0000-4000-8000-0000000a3101',
      '00000000-0000-4000-8000-0000000a6101'
    )
  ),
  '00000000-0000-4000-8000-0000000a6101'::uuid,
  'Current cycle ID is accepted as the send authority token'
);
SELECT throws_like(
  $$SELECT * FROM private.assert_operator_can_send_for_cycle(
    '00000000-0000-4000-8000-0000000a3101'::uuid,
    NULL::uuid
  )$$,
  'handling_cycle_token_required',
  'Strict sends require a non-null cycle token'
);
SELECT throws_like(
  $$SELECT * FROM private.assert_operator_can_send_for_cycle(
    '00000000-0000-4000-8000-0000000a3101'::uuid,
    '00000000-0000-4000-8000-0000000a6099'::uuid
  )$$,
  'handling_cycle_token_invalid',
  'An ended historical cycle token is rejected'
);
SELECT throws_like(
  $$SELECT * FROM private.assert_operator_can_send_for_cycle(
    '00000000-0000-4000-8000-0000000a3101'::uuid,
    '00000000-0000-4000-8000-0000000a6100'::uuid
  )$$,
  'handling_cycle_token_invalid',
  'A stale previous cycle token is rejected'
);

INSERT INTO public.conversations (id, client_id, character_id, assigned_operator_id, status)
VALUES (
  '00000000-0000-4000-8000-0000000a3103',
  '00000000-0000-4000-8000-0000000a0103',
  '00000000-0000-4000-8000-0000000a2101',
  '00000000-0000-4000-8000-0000000a1104',
  'open'
);
INSERT INTO public.conversation_work_items (
  id, conversation_id, client_id, character_id, status,
  responsible_operator_id, assigned_at, last_activity_at
)
VALUES (
  '00000000-0000-4000-8000-0000000a5103',
  '00000000-0000-4000-8000-0000000a3103',
  '00000000-0000-4000-8000-0000000a0103',
  '00000000-0000-4000-8000-0000000a2101',
  'assigned',
  '00000000-0000-4000-8000-0000000a1104',
  clock_timestamp(),
  clock_timestamp()
);
INSERT INTO public.conversation_handling_cycles (
  id, conversation_id, work_item_id, operator_id
)
VALUES (
  '00000000-0000-4000-8000-0000000a6103',
  '00000000-0000-4000-8000-0000000a3103',
  '00000000-0000-4000-8000-0000000a5103',
  '00000000-0000-4000-8000-0000000a1104'
);
SELECT throws_like(
  $$SELECT * FROM private.assert_operator_can_send_for_cycle(
    '00000000-0000-4000-8000-0000000a3103'::uuid,
    '00000000-0000-4000-8000-0000000a6103'::uuid
  )$$,
  'handling_cycle_token_invalid',
  'A cycle token owned by another assigned Operator is rejected'
);
SELECT throws_like(
  $$SELECT * FROM private.assert_operator_can_send_for_cycle(
    '00000000-0000-4000-8000-0000000a3101'::uuid,
    '00000000-0000-4000-8000-0000000a6999'::uuid
  )$$,
  'handling_cycle_token_invalid',
  'Unknown cycle token is rejected'
);
SELECT throws_like(
  $$INSERT INTO public.conversation_handling_cycles (
      conversation_id, work_item_id, operator_id
    ) VALUES (
      '00000000-0000-4000-8000-0000000a3101'::uuid,
      NULL,
      '00000000-0000-4000-8000-0000000a1102'::uuid
    )$$,
  '%duplicate key value violates unique constraint "conversation_handling_cycles_one_active_conversation_idx"%',
  'A second active cycle for the conversation is rejected'
);

INSERT INTO public.conversations (id, client_id, character_id, status)
VALUES (
  '00000000-0000-4000-8000-0000000a3104',
  '00000000-0000-4000-8000-0000000a0105',
  '00000000-0000-4000-8000-0000000a2101',
  'open'
);
INSERT INTO public.conversation_work_items (
  id, conversation_id, client_id, character_id, status, last_activity_at
)
VALUES (
  '00000000-0000-4000-8000-0000000a5104',
  '00000000-0000-4000-8000-0000000a3104',
  '00000000-0000-4000-8000-0000000a0105',
  '00000000-0000-4000-8000-0000000a2101',
  'new',
  clock_timestamp()
);

CREATE TEMP TABLE wp01_claim_results (
  attempt TEXT PRIMARY KEY,
  result JSONB NOT NULL
) ON COMMIT DROP;

INSERT INTO wp01_claim_results (attempt, result)
SELECT 'first', public.claim_new_conversation('00000000-0000-4000-8000-0000000a5104');
INSERT INTO wp01_claim_results (attempt, result)
SELECT 'replay', public.claim_new_conversation('00000000-0000-4000-8000-0000000a5104');

SELECT ok(
  (SELECT result->>'cycle_id' FROM wp01_claim_results WHERE attempt = 'first') IS NOT NULL,
  'A new claim returns its active cycle_id'
);
SELECT is(
  (SELECT result->>'cycle_id' FROM wp01_claim_results WHERE attempt = 'replay'),
  (SELECT result->>'cycle_id' FROM wp01_claim_results WHERE attempt = 'first'),
  'A valid replay returns the same active cycle_id'
);
SELECT is(
  (SELECT count(*) FROM public.conversation_handling_cycles WHERE conversation_id = '00000000-0000-4000-8000-0000000a3104' AND ended_at IS NULL),
  1::bigint,
  'Claim and replay leave exactly one active cycle'
);

UPDATE public.conversation_handling_cycles
SET ended_at = clock_timestamp(), end_reason = 'released'
WHERE conversation_id = '00000000-0000-4000-8000-0000000a3104' AND ended_at IS NULL;
SELECT throws_like(
  $$SELECT public.claim_new_conversation('00000000-0000-4000-8000-0000000a5104'::uuid)$$,
  'conversation_claim_state_inconsistent',
  'Replay rejects an ended claim cycle'
);
UPDATE public.conversation_handling_cycles
SET ended_at = NULL, end_reason = NULL
WHERE conversation_id = '00000000-0000-4000-8000-0000000a3104';

INSERT INTO public.conversation_work_items (
  id, conversation_id, client_id, character_id, status, last_activity_at
)
VALUES (
  '00000000-0000-4000-8000-0000000a5199',
  '00000000-0000-4000-8000-0000000a3103',
  '00000000-0000-4000-8000-0000000a0103',
  '00000000-0000-4000-8000-0000000a2101',
  'closed',
  clock_timestamp()
);
UPDATE public.conversation_handling_cycles
SET work_item_id = '00000000-0000-4000-8000-0000000a5199'
WHERE conversation_id = '00000000-0000-4000-8000-0000000a3104' AND ended_at IS NULL;
SELECT throws_like(
  $$SELECT public.claim_new_conversation('00000000-0000-4000-8000-0000000a5104'::uuid)$$,
  'conversation_claim_state_inconsistent',
  'Replay rejects a cycle linked to a different work item'
);
UPDATE public.conversation_handling_cycles
SET work_item_id = '00000000-0000-4000-8000-0000000a5104'
WHERE conversation_id = '00000000-0000-4000-8000-0000000a3104' AND ended_at IS NULL;

DELETE FROM public.conversation_handling_cycles
WHERE conversation_id = '00000000-0000-4000-8000-0000000a3104';
SELECT throws_like(
  $$SELECT public.claim_new_conversation('00000000-0000-4000-8000-0000000a5104'::uuid)$$,
  'conversation_claim_state_inconsistent',
  'Replay rejects a missing active cycle'
);

DELETE FROM public.conversation_handling_cycles
WHERE conversation_id IN (
  '00000000-0000-4000-8000-0000000a3103',
  '00000000-0000-4000-8000-0000000a3104'
);
DELETE FROM public.conversation_work_items
WHERE conversation_id IN (
  '00000000-0000-4000-8000-0000000a3103',
  '00000000-0000-4000-8000-0000000a3104'
);
DELETE FROM public.conversations
WHERE id IN (
  '00000000-0000-4000-8000-0000000a3103',
  '00000000-0000-4000-8000-0000000a3104'
);

SELECT set_config(
  'wp01.contradictory_lock_before',
  (SELECT to_jsonb(legacy_lock)::text
   FROM public.conversation_locks legacy_lock
   WHERE legacy_lock.conversation_id = '00000000-0000-4000-8000-0000000a3101'),
  true
);
SELECT set_config(
  'wp01.other_operator_send_before',
  pg_temp.wp01_conversation_state(
    '00000000-0000-4000-8000-0000000a3101',
    '00000000-0000-4000-8000-0000000a0101'
  )::text,
  true
);
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000a0104';
SET LOCAL ROLE authenticated;
SELECT throws_like(
  $$SELECT public.send_operator_message(
    '00000000-0000-4000-8000-0000000a3101'::uuid,
    'other operator must not send',
    '00000000-0000-4000-8000-0000000a6101'::uuid
  )$$,
  'conversation_not_responsible_operator',
  'Another assigned Operator cannot send while the active cycle belongs to the owner'
);
RESET ROLE;
SELECT is(
  pg_temp.wp01_conversation_state(
    '00000000-0000-4000-8000-0000000a3101',
    '00000000-0000-4000-8000-0000000a0101'
  ),
  current_setting('wp01.other_operator_send_before')::jsonb,
  'Rejected active-cycle send creates no message, ledger, projection or audit side effect'
);

SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000a0102';
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$SELECT public.send_operator_message(
    '00000000-0000-4000-8000-0000000a3101'::uuid,
    'owner response',
    '00000000-0000-4000-8000-0000000a6101'::uuid
  )$$,
  'Cycle owner can send through the existing RPC'
);
RESET ROLE;

SELECT is(
  (SELECT handling_effect FROM public.messages WHERE content = 'owner response'),
  'staff_response',
  'Owner response is classified as staff_response'
);
SELECT is(
  (SELECT handling_cycle_id FROM public.messages WHERE content = 'owner response'),
  '00000000-0000-4000-8000-0000000a6101'::uuid,
  'Owner response records the active cycle token'
);
SELECT is(
  (SELECT handling_sequence FROM public.messages WHERE content = 'owner response'),
  3::bigint,
  'Owner response receives sequence 3'
);
SELECT is(
  (SELECT needs_handling FROM public.conversations WHERE id = '00000000-0000-4000-8000-0000000a3101'),
  false,
  'Owner response clears shadow needs_handling'
);
SELECT is(
  (SELECT pending_since FROM public.conversations WHERE id = '00000000-0000-4000-8000-0000000a3101'),
  NULL::timestamptz,
  'Owner response clears pending_since'
);
SELECT is(
  (SELECT count(*) FROM public.conversation_handling_cycles WHERE id = '00000000-0000-4000-8000-0000000a6101' AND ended_at IS NULL),
  1::bigint,
  'Cycle remains active after a strict response until explicit release'
);
SET LOCAL role authenticated;
SELECT lives_ok(
  $$SELECT public.release_operator_conversation(
    '00000000-0000-4000-8000-0000000a3101'::uuid,
    'released'
  )$$,
  'The cycle owner releases responsibility through the established RPC'
);
RESET ROLE;
SELECT is(
  (SELECT to_jsonb(legacy_lock)
   FROM public.conversation_locks legacy_lock
   WHERE legacy_lock.conversation_id = '00000000-0000-4000-8000-0000000a3101'),
  current_setting('wp01.contradictory_lock_before')::jsonb,
  'Active-cycle owner bypasses the contradictory legacy lock without mutating it'
);

SELECT set_config(
  'wp01.legacy_lock_rejection_before',
  pg_temp.wp01_conversation_state(
    '00000000-0000-4000-8000-0000000a3101',
    '00000000-0000-4000-8000-0000000a0101'
  )::text,
  true
);
SET LOCAL ROLE authenticated;
SELECT throws_like(
  $$SELECT public.send_operator_message(
    '00000000-0000-4000-8000-0000000a3101'::uuid,
    'legacy lock must still block',
    NULL::uuid
  )$$,
  'conversation_locked_by_other_operator',
  'Without an active cycle the contradictory legacy lock remains authoritative'
);
RESET ROLE;
SELECT is(
  pg_temp.wp01_conversation_state(
    '00000000-0000-4000-8000-0000000a3101',
    '00000000-0000-4000-8000-0000000a0101'
  ),
  current_setting('wp01.legacy_lock_rejection_before')::jsonb,
  'Rejected legacy-lock send has no side effect'
);

DELETE FROM public.conversation_locks
WHERE conversation_id = '00000000-0000-4000-8000-0000000a3101';
UPDATE public.system_settings
SET value = '"open"'::jsonb
WHERE key = 'concurrency_mode';

SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$SELECT public.send_operator_message(
    '00000000-0000-4000-8000-0000000a3101'::uuid,
    'atomic claim response',
    NULL::uuid
  )$$,
  'No active cycle atomically claims authority and sends'
);
RESET ROLE;
SELECT is(
  (SELECT handling_effect FROM public.messages WHERE content = 'atomic claim response'),
  'staff_response',
  'Atomic claim send is classified as staff_response'
);
SELECT ok(
  EXISTS (SELECT 1 FROM private.handling_send_authority_evidence evidence JOIN public.messages message ON message.id = evidence.message_id WHERE message.content = 'atomic claim response'),
  'Atomic claim send records strict authority evidence'
);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$SELECT public.release_operator_conversation(
    '00000000-0000-4000-8000-0000000a3101'::uuid,
    'released'
  )$$,
  'The atomic claim cycle is released through the established RPC'
);
RESET ROLE;
INSERT INTO public.characters (id, name, is_active, is_visible, availability_status)
VALUES ('00000000-0000-4000-8000-0000000a2199'::uuid, 'WP01 reconciliation character', TRUE, TRUE, 'available');
INSERT INTO public.character_operator_assignments (character_id, operator_id)
VALUES
  ('00000000-0000-4000-8000-0000000a2199'::uuid, '00000000-0000-4000-8000-0000000a1102'::uuid),
  ('00000000-0000-4000-8000-0000000a2199'::uuid, '00000000-0000-4000-8000-0000000a1104'::uuid);
INSERT INTO public.conversations (id, client_id, character_id, status)
SELECT
  '00000000-0000-4000-8000-0000000a3199'::uuid,
  conversation.client_id,
  '00000000-0000-4000-8000-0000000a2199'::uuid,
  conversation.status
FROM public.conversations conversation
WHERE conversation.id = '00000000-0000-4000-8000-0000000a3101'::uuid;
ALTER TABLE public.messages DISABLE TRIGGER prepare_message_handling_shadow;
ALTER TABLE public.messages DISABLE TRIGGER record_message_handling_issue;
INSERT INTO public.messages (
  id, conversation_id, sender_type, sender_id, operator_id, content, created_at,
  handling_effect, handling_classification_reason, handling_metadata_version, handling_classified_at
)
VALUES (
  '00000000-0000-4000-8000-0000000a4199'::uuid,
  '00000000-0000-4000-8000-0000000a3199'::uuid,
  'operator',
  '00000000-0000-4000-8000-0000000a0102'::uuid,
  '00000000-0000-4000-8000-0000000a1102'::uuid,
  'legacy no-cycle response',
  (SELECT strict_send_deployed_at - interval '1 second' FROM private.handling_contract_runtime WHERE singleton),
  'unclassified',
  'fallback_no_active_cycle',
  1,
  (SELECT strict_send_deployed_at - interval '1 second' FROM private.handling_contract_runtime WHERE singleton)
);
ALTER TABLE public.messages ENABLE TRIGGER prepare_message_handling_shadow;
ALTER TABLE public.messages ENABLE TRIGGER record_message_handling_issue;
INSERT INTO private.handling_reconciliation_issues (
  conversation_id, message_id, issue_kind, status, can_change_canonical_state, evidence
)
VALUES (
  '00000000-0000-4000-8000-0000000a3199'::uuid,
  '00000000-0000-4000-8000-0000000a4199'::uuid,
  'fallback_no_active_cycle',
  'unresolved',
  TRUE,
  '{"classification_source":"historical_fixture"}'::jsonb
);
SELECT is(
  (SELECT handling_effect FROM public.messages WHERE content = 'legacy no-cycle response'),
  'unclassified',
  'Historical no-cycle fixture remains unclassified for reconciliation coverage'
);
SELECT is(
  (SELECT status FROM private.handling_reconciliation_issues issue JOIN public.messages message ON message.id = issue.message_id WHERE message.content = 'legacy no-cycle response'),
  'unresolved',
  'Historical no-cycle fixture creates an unresolved reconciliation issue'
);
SELECT is(
  (SELECT unresolved_fallback_no_cycle_writes FROM private.get_handling_cutover_readiness()),
  1::bigint,
  'Readiness reports the unresolved historical fallback write'
);
SELECT is(
  (SELECT unresolved_state_changing_effects FROM private.get_handling_cutover_readiness()),
  1::bigint,
  'Readiness reports its unresolved historical state effect'
);
SELECT is(
  (SELECT post_deploy_business_writes_missing_metadata FROM private.get_handling_cutover_readiness()),
  0::bigint,
  'Every business write has required metadata'
);
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_cutover_readiness()),
  false,
  'Unresolved historical no-cycle write makes the shadow inconsistent'
);
SELECT is(
  (SELECT cutover_authorized FROM private.get_handling_cutover_readiness()),
  false,
  'WP01 never authorizes cutover'
);

INSERT INTO private.handling_reconciliation_issues (
  conversation_id, message_id, issue_kind, status, can_change_canonical_state, evidence
)
VALUES (
  '00000000-0000-4000-8000-0000000a3101',
  '00000000-0000-4000-8000-0000000a4101',
  'client_business_message',
  'unresolved',
  TRUE,
  '{"classification_source":"pgTAP_client_none_rejection"}'::jsonb
);
SELECT set_config(
  'wp01.client_none_before',
  pg_temp.wp01_resolution_state('00000000-0000-4000-8000-0000000a4101')::TEXT,
  TRUE
);
SELECT throws_ok(
  $$SELECT private.resolve_handling_reconciliation_issue(
    '00000000-0000-4000-8000-0000000a4101'::UUID,
    'none',
    NULL,
    'Invalid Client none probe'
  )$$,
  'P0001',
  'none_resolution_not_allowed_for_qualifying_message',
  'A valid Client request cannot be explicitly resolved to none'
);
SELECT is(
  pg_temp.wp01_resolution_state('00000000-0000-4000-8000-0000000a4101'),
  current_setting('wp01.client_none_before')::JSONB,
  'Rejected Client none resolution performs no mutation'
);
DELETE FROM private.handling_reconciliation_issues
WHERE message_id = '00000000-0000-4000-8000-0000000a4101';

INSERT INTO private.handling_reconciliation_issues (
  conversation_id, message_id, issue_kind, status, can_change_canonical_state, evidence
)
SELECT
  message.conversation_id,
  message.id,
  message.handling_classification_reason,
  'unresolved',
  TRUE,
  '{"classification_source":"pgTAP_staff_none_rejection"}'::jsonb
FROM public.messages message
WHERE message.content = 'owner response';
SELECT set_config(
  'wp01.staff_none_message_id',
  (SELECT id::TEXT FROM public.messages WHERE content = 'owner response'),
  TRUE
);
SELECT set_config(
  'wp01.staff_none_before',
  pg_temp.wp01_resolution_state(
    current_setting('wp01.staff_none_message_id')::UUID
  )::TEXT,
  TRUE
);
SELECT throws_ok(
  format(
    'SELECT private.resolve_handling_reconciliation_issue(%L::UUID, %L, NULL, %L)',
    current_setting('wp01.staff_none_message_id'),
    'none',
    'Invalid Staff none probe'
  ),
  'P0001',
  'none_resolution_not_allowed_for_qualifying_message',
  'A valid Staff response cannot be explicitly resolved to none'
);
SELECT is(
  pg_temp.wp01_resolution_state(
    current_setting('wp01.staff_none_message_id')::UUID
  ),
  current_setting('wp01.staff_none_before')::JSONB,
  'Rejected Staff none resolution performs no mutation'
);
DELETE FROM private.handling_reconciliation_issues
WHERE message_id = current_setting('wp01.staff_none_message_id')::UUID;

SELECT set_config(
  'wp01.no_cycle_message_id',
  (SELECT id::TEXT FROM public.messages WHERE content = 'legacy no-cycle response'),
  TRUE
);
INSERT INTO public.conversations (id, client_id, character_id, status)
SELECT
  '00000000-0000-4000-8000-0000000a3105',
  conversation.client_id,
  '00000000-0000-4000-8000-0000000a2102',
  conversation.status
FROM public.conversations conversation
WHERE conversation.id = '00000000-0000-4000-8000-0000000a3101';

UPDATE private.handling_reconciliation_issues
SET issue_kind = 'wrong_issue_kind'
WHERE message_id = current_setting('wp01.no_cycle_message_id')::UUID;
SELECT set_config(
  'wp01.wrong_kind_before',
  pg_temp.wp01_resolution_state(
    current_setting('wp01.no_cycle_message_id')::UUID
  )::TEXT,
  TRUE
);
SELECT throws_ok(
  format(
    'SELECT private.resolve_handling_reconciliation_issue(%L::UUID, %L, NULL, %L)',
    current_setting('wp01.no_cycle_message_id'),
    'none',
    'Wrong issue kind probe'
  ),
  'P0001',
  'handling_issue_kind_mismatch',
  'Resolver rejects a mismatched issue kind before mutation'
);
SELECT is(
  pg_temp.wp01_resolution_state(
    current_setting('wp01.no_cycle_message_id')::UUID
  ),
  current_setting('wp01.wrong_kind_before')::JSONB,
  'Wrong issue kind rejection preserves message and issue rows'
);
UPDATE private.handling_reconciliation_issues
SET issue_kind = 'fallback_no_active_cycle'
WHERE message_id = current_setting('wp01.no_cycle_message_id')::UUID;

UPDATE private.handling_reconciliation_issues
SET conversation_id = '00000000-0000-4000-8000-0000000a3105'
WHERE message_id = current_setting('wp01.no_cycle_message_id')::UUID;
SELECT set_config(
  'wp01.wrong_conversation_before',
  pg_temp.wp01_resolution_state(
    current_setting('wp01.no_cycle_message_id')::UUID
  )::TEXT,
  TRUE
);
SELECT throws_ok(
  format(
    'SELECT private.resolve_handling_reconciliation_issue(%L::UUID, %L, NULL, %L)',
    current_setting('wp01.no_cycle_message_id'),
    'none',
    'Wrong issue conversation probe'
  ),
  'P0001',
  'handling_issue_conversation_mismatch',
  'Resolver rejects a mismatched issue conversation before mutation'
);
SELECT is(
  pg_temp.wp01_resolution_state(
    current_setting('wp01.no_cycle_message_id')::UUID
  ),
  current_setting('wp01.wrong_conversation_before')::JSONB,
  'Wrong issue conversation rejection preserves message and issue rows'
);
UPDATE private.handling_reconciliation_issues
SET conversation_id = '00000000-0000-4000-8000-0000000a3199'
WHERE message_id = current_setting('wp01.no_cycle_message_id')::UUID;
DELETE FROM public.conversations
WHERE id = '00000000-0000-4000-8000-0000000a3105';

UPDATE private.handling_reconciliation_issues
SET can_change_canonical_state = FALSE
WHERE message_id = current_setting('wp01.no_cycle_message_id')::UUID;
SELECT set_config(
  'wp01.non_changing_before',
  pg_temp.wp01_resolution_state(
    current_setting('wp01.no_cycle_message_id')::UUID
  )::TEXT,
  TRUE
);
SELECT throws_ok(
  format(
    'SELECT private.resolve_handling_reconciliation_issue(%L::UUID, %L, NULL, %L)',
    current_setting('wp01.no_cycle_message_id'),
    'none',
    'Non-changing issue probe'
  ),
  'P0001',
  'handling_issue_not_state_changing',
  'Resolver rejects can_change=false before mutation'
);
SELECT is(
  pg_temp.wp01_resolution_state(
    current_setting('wp01.no_cycle_message_id')::UUID
  ),
  current_setting('wp01.non_changing_before')::JSONB,
  'can_change=false rejection preserves message and issue rows'
);
UPDATE private.handling_reconciliation_issues
SET can_change_canonical_state = TRUE
WHERE message_id = current_setting('wp01.no_cycle_message_id')::UUID;

SELECT throws_like(
  $$SELECT private.resolve_handling_reconciliation_issue(
    (SELECT id FROM public.messages WHERE content = 'legacy no-cycle response'),
    'client_request',
    NULL,
    'Invalid sender/effect probe'
  )$$,
  'client_request_sender_invalid',
  'Explicit repair cannot relabel an Operator write as a Client request'
);
SELECT lives_ok(
  $$SELECT private.resolve_handling_reconciliation_issue(
    (SELECT id FROM public.messages WHERE content = 'legacy no-cycle response'),
    'none',
    NULL,
    'Explicitly reviewed: no valid cycle evidence'
  )$$,
  'Explicit conservative repair resolves the no-cycle issue'
);
SELECT is(
  (SELECT handling_effect FROM public.messages WHERE content = 'legacy no-cycle response'),
  'none',
  'Resolved no-cycle message is explicitly non-qualifying'
);
SELECT is(
  (SELECT status FROM private.handling_reconciliation_issues issue JOIN public.messages message ON message.id = issue.message_id WHERE message.content = 'legacy no-cycle response'),
  'non_qualifying',
  'Audit history retains the conservative resolution'
);
SELECT is(
  (
    SELECT issue.issue_kind
    FROM private.handling_reconciliation_issues issue
    JOIN public.messages message ON message.id = issue.message_id
    WHERE message.content = 'legacy no-cycle response'
  ),
  'fallback_no_active_cycle',
  'Conservative resolution preserves the original issue kind'
);
SELECT is(
  (
    SELECT issue.evidence->>'original_issue_kind'
    FROM private.handling_reconciliation_issues issue
    JOIN public.messages message ON message.id = issue.message_id
    WHERE message.content = 'legacy no-cycle response'
  ),
  'fallback_no_active_cycle',
  'Conservative resolution records the original issue kind in evidence'
);
SELECT is(
  (
    SELECT issue.resolution
    FROM private.handling_reconciliation_issues issue
    JOIN public.messages message ON message.id = issue.message_id
    WHERE message.content = 'legacy no-cycle response'
  ),
  'Explicitly reviewed: no valid cycle evidence',
  'Conservative resolution retains the explicit reviewer evidence'
);
DELETE FROM private.handling_reconciliation_issues
WHERE message_id = current_setting('wp01.no_cycle_message_id')::uuid;
DELETE FROM public.messages
WHERE id = current_setting('wp01.no_cycle_message_id')::uuid;
DELETE FROM public.conversations
WHERE id = '00000000-0000-4000-8000-0000000a3199'::uuid;
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_cutover_readiness()),
  true,
  'Resolved metadata restores shadow consistency in this fixture'
);
SELECT is(
  (SELECT cutover_authorized FROM private.get_handling_cutover_readiness()),
  false,
  'A consistent shadow still does not authorize cutover in WP01'
);

INSERT INTO public.conversations (id, client_id, character_id, status)
SELECT
  '00000000-0000-4000-8000-0000000a3199'::uuid,
  conversation.client_id,
  '00000000-0000-4000-8000-0000000a2199'::uuid,
  conversation.status
FROM public.conversations conversation
WHERE conversation.id = '00000000-0000-4000-8000-0000000a3101'::uuid;
ALTER TABLE public.messages DISABLE TRIGGER prepare_message_handling_shadow;
ALTER TABLE public.messages DISABLE TRIGGER record_message_handling_issue;
INSERT INTO public.messages (
  id, conversation_id, sender_type, sender_id, operator_id, content, created_at,
  handling_effect, handling_classification_reason, handling_metadata_version, handling_classified_at
)
VALUES (
  '00000000-0000-4000-8000-0000000a4198'::uuid,
  '00000000-0000-4000-8000-0000000a3199'::uuid,
  'operator',
  '00000000-0000-4000-8000-0000000a0102'::uuid,
  '00000000-0000-4000-8000-0000000a1102'::uuid,
  'fallback staff repair',
  (SELECT strict_send_deployed_at - interval '2 seconds' FROM private.handling_contract_runtime WHERE singleton),
  'unclassified',
  'fallback_no_active_cycle',
  1,
  (SELECT strict_send_deployed_at - interval '2 seconds' FROM private.handling_contract_runtime WHERE singleton)
);
ALTER TABLE public.messages ENABLE TRIGGER prepare_message_handling_shadow;
ALTER TABLE public.messages ENABLE TRIGGER record_message_handling_issue;
INSERT INTO private.handling_reconciliation_issues (
  conversation_id, message_id, issue_kind, status, can_change_canonical_state, evidence
)
VALUES (
  '00000000-0000-4000-8000-0000000a3199'::uuid,
  '00000000-0000-4000-8000-0000000a4198'::uuid,
  'fallback_no_active_cycle',
  'unresolved',
  TRUE,
  '{"classification_source":"historical_staff_repair_fixture"}'::jsonb
);
SELECT set_config(
  'wp01.staff_repair_message_id',
  (SELECT id::TEXT FROM public.messages WHERE content = 'fallback staff repair'),
  TRUE
);
SELECT is(
  (
    SELECT handling_effect
    FROM public.messages
    WHERE id = current_setting('wp01.staff_repair_message_id')::UUID
  ),
  'unclassified',
  'The repair fixture starts as an unresolved fallback'
);
INSERT INTO public.conversation_handling_cycles (
  id, conversation_id, work_item_id, operator_id, started_at, ended_at, end_reason
)
SELECT
  '00000000-0000-4000-8000-0000000a6190',
  message.conversation_id,
  NULL,
  message.operator_id,
  message.created_at,
  message.created_at,
  'released'
FROM public.messages message
WHERE message.id = current_setting('wp01.staff_repair_message_id')::UUID;
SELECT lives_ok(
  $$SELECT private.resolve_handling_reconciliation_issue(
    current_setting('wp01.staff_repair_message_id')::UUID,
    'staff_response',
    '00000000-0000-4000-8000-0000000a6190'::UUID,
    'Historical cycle evidence verified'
  )$$,
  'A fallback can be repaired to staff_response with matching historical cycle evidence'
);
SELECT is(
  (
    SELECT jsonb_build_object(
      'effect', message.handling_effect,
      'cycle', message.handling_cycle_id,
      'reason', message.handling_classification_reason
    )
    FROM public.messages message
    WHERE message.id = current_setting('wp01.staff_repair_message_id')::UUID
  ),
  jsonb_build_object(
    'effect', 'staff_response',
    'cycle', '00000000-0000-4000-8000-0000000a6190'::UUID,
    'reason', 'explicit_reconciliation'
  ),
  'Staff repair records the verified cycle without rewriting its original issue'
);
SELECT is(
  (
    SELECT jsonb_build_object(
      'kind', issue.issue_kind,
      'status', issue.status,
      'resolution', issue.resolution,
      'original_kind', issue.evidence->>'original_issue_kind',
      'resolved_effect', issue.evidence->>'resolved_effect',
      'resolved_cycle', issue.evidence->>'resolved_cycle_id'
    )
    FROM private.handling_reconciliation_issues issue
    WHERE issue.message_id = current_setting('wp01.staff_repair_message_id')::UUID
  ),
  jsonb_build_object(
    'kind', 'fallback_no_active_cycle',
    'status', 'resolved',
    'resolution', 'Historical cycle evidence verified',
    'original_kind', 'fallback_no_active_cycle',
    'resolved_effect', 'staff_response',
    'resolved_cycle', '00000000-0000-4000-8000-0000000a6190'
  ),
  'Staff repair preserves audit identity and records explicit resolution evidence'
);
SELECT is(
  (
    SELECT semantic_consistent
    FROM private.get_handling_shadow_reconciliation()
    WHERE conversation_id = '00000000-0000-4000-8000-0000000a3199'
  ),
  TRUE,
  'Cycle-backed staff repair is semantically consistent'
);
DELETE FROM private.handling_reconciliation_issues
WHERE message_id = current_setting('wp01.staff_repair_message_id')::uuid;
DELETE FROM public.messages
WHERE id = current_setting('wp01.staff_repair_message_id')::uuid;
DELETE FROM public.conversation_handling_cycles
WHERE id = '00000000-0000-4000-8000-0000000a6190'::uuid;
DELETE FROM public.conversations
WHERE id = '00000000-0000-4000-8000-0000000a3199'::uuid;
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_cutover_readiness()),
  TRUE,
  'Cycle-backed staff repair clears readiness blockers without authorizing cutover'
);

INSERT INTO public.conversations (id, client_id, character_id, status)
VALUES (
  '00000000-0000-4000-8000-0000000a3102',
  '00000000-0000-4000-8000-0000000a0103',
  '00000000-0000-4000-8000-0000000a2102',
  'open'
);

ALTER TABLE public.messages DISABLE TRIGGER prepare_message_handling_shadow;
ALTER TABLE public.messages DISABLE TRIGGER record_message_handling_issue;

INSERT INTO public.messages (
  id, conversation_id, sender_type, sender_id, content, created_at
)
VALUES
  (
    '00000000-0000-4000-8000-0000000a4201',
    '00000000-0000-4000-8000-0000000a3102',
    'client',
    '00000000-0000-4000-8000-0000000a0103',
    'historical client request',
    '2026-01-01 12:00:00+00'
  ),
  (
    '00000000-0000-4000-8000-0000000a4202',
    '00000000-0000-4000-8000-0000000a3102',
    'operator',
    '00000000-0000-4000-8000-0000000a0102',
    'historical no-cycle operator write',
    '2026-01-01 12:01:00+00'
  );

ALTER TABLE public.messages ENABLE TRIGGER prepare_message_handling_shadow;
ALTER TABLE public.messages ENABLE TRIGGER record_message_handling_issue;

SELECT lives_ok(
  $$SELECT private.backfill_handling_shadow_batch(10)$$,
  'Resumable backfill initializes historical conversations'
);
SELECT is(
  (SELECT handling_sequence FROM public.messages WHERE id = '00000000-0000-4000-8000-0000000a4201'),
  1::bigint,
  'Historical backfill assigns deterministic sequence 1'
);
SELECT is(
  (SELECT handling_sequence FROM public.messages WHERE id = '00000000-0000-4000-8000-0000000a4202'),
  2::bigint,
  'Historical backfill assigns deterministic sequence 2'
);
SELECT is(
  (SELECT handling_effect FROM public.messages WHERE id = '00000000-0000-4000-8000-0000000a4201'),
  'client_request',
  'Historical Client message remains qualifying'
);
SELECT is(
  (SELECT handling_effect FROM public.messages WHERE id = '00000000-0000-4000-8000-0000000a4202'),
  'none',
  'Historical no-cycle Operator message is conservatively non-qualifying'
);
SELECT is(
  (SELECT status FROM private.handling_reconciliation_issues WHERE message_id = '00000000-0000-4000-8000-0000000a4202'),
  'non_qualifying',
  'Historical non-qualifying decision remains in the audit report'
);
SELECT is(
  (SELECT needs_handling FROM public.conversations WHERE id = '00000000-0000-4000-8000-0000000a3102'),
  true,
  'Conservative historical state remains pending after a no-cycle Operator write'
);
SELECT is(
  (SELECT uninitialized_conversations FROM private.get_handling_cutover_readiness()),
  0::bigint,
  'Backfill leaves no uninitialized conversation in the fixture'
);
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_cutover_readiness()),
  true,
  'Non-qualifying historical audit rows do not make the shadow inconsistent'
);
SELECT is(
  (SELECT cutover_authorized FROM private.get_handling_cutover_readiness()),
  false,
  'Historical consistency remains observational and cannot authorize cutover'
);

ALTER TABLE public.messages DISABLE TRIGGER prepare_message_handling_shadow;
INSERT INTO public.messages (
  id, conversation_id, sender_type, sender_id, content, created_at
)
VALUES (
  '00000000-0000-4000-8000-0000000a4203',
  '00000000-0000-4000-8000-0000000a3102',
  'client',
  '00000000-0000-4000-8000-0000000a0103',
  'missing metadata probe',
  clock_timestamp()
);
ALTER TABLE public.messages ENABLE TRIGGER prepare_message_handling_shadow;

SELECT is(
  (SELECT post_deploy_business_writes_missing_metadata FROM private.get_handling_cutover_readiness()),
  1::bigint,
  'Readiness detects a post-deployment business write without metadata'
);
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_cutover_readiness()),
  false,
  'A post-deployment business write without metadata makes the shadow inconsistent'
);
DELETE FROM public.messages WHERE id = '00000000-0000-4000-8000-0000000a4203';
SELECT is(
  (SELECT post_deploy_business_writes_missing_metadata FROM private.get_handling_cutover_readiness()),
  0::bigint,
  'Removing the test probe restores the missing-metadata count'
);

UPDATE public.conversations
SET needs_handling = FALSE,
    pending_since = NULL
WHERE id = '00000000-0000-4000-8000-0000000a3102';
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_cutover_readiness()),
  false,
  'Reconciliation detects a corrupted needs_handling projection'
);
UPDATE public.conversations
SET needs_handling = TRUE,
    pending_since = '2026-01-01 12:00:00+00'
WHERE id = '00000000-0000-4000-8000-0000000a3102';

UPDATE public.conversations
SET pending_since = '2026-01-01 11:59:00+00'
WHERE id = '00000000-0000-4000-8000-0000000a3102';
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_cutover_readiness()),
  false,
  'Reconciliation detects a corrupted pending_since projection'
);
UPDATE public.conversations
SET pending_since = '2026-01-01 12:00:00+00'
WHERE id = '00000000-0000-4000-8000-0000000a3102';

UPDATE public.conversations
SET inactivity_expires_at = '2026-01-01 12:04:00+00'
WHERE id = '00000000-0000-4000-8000-0000000a3102';
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_cutover_readiness()),
  false,
  'Reconciliation detects a corrupted rolling inactivity expiry'
);
UPDATE public.conversations
SET inactivity_expires_at = '2026-01-01 12:03:00+00'
WHERE id = '00000000-0000-4000-8000-0000000a3102';

UPDATE public.conversations
SET last_handling_message_sequence = 1
WHERE id = '00000000-0000-4000-8000-0000000a3102';
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_cutover_readiness()),
  false,
  'Reconciliation detects a corrupted last handling sequence'
);
UPDATE public.conversations
SET last_handling_message_sequence = 2
WHERE id = '00000000-0000-4000-8000-0000000a3102';

UPDATE public.conversations
SET handling_next_sequence = 2
WHERE id = '00000000-0000-4000-8000-0000000a3102';
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_cutover_readiness()),
  false,
  'Reconciliation detects a non-advancing next sequence'
);
UPDATE public.conversations
SET handling_next_sequence = 3
WHERE id = '00000000-0000-4000-8000-0000000a3102';

SELECT throws_like(
  $$UPDATE public.messages
    SET handling_sequence = 1
    WHERE id = '00000000-0000-4000-8000-0000000a4202'::uuid$$,
  '%duplicate key value violates unique constraint "messages_conversation_handling_sequence_idx"%',
  'Duplicate conversation handling sequence is rejected at the write boundary'
);

UPDATE public.messages
SET handling_sequence = 5
WHERE id = '00000000-0000-4000-8000-0000000a4202';
UPDATE public.conversations
SET handling_next_sequence = 6,
    last_handling_message_sequence = 5
WHERE id = '00000000-0000-4000-8000-0000000a3102';
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_cutover_readiness()),
  true,
  'Reconciliation accepts legal gaps when counters advance beyond the maximum sequence'
);
UPDATE public.messages
SET handling_sequence = 2
WHERE id = '00000000-0000-4000-8000-0000000a4202';
UPDATE public.conversations
SET handling_next_sequence = 3,
    last_handling_message_sequence = 2
WHERE id = '00000000-0000-4000-8000-0000000a3102';

SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_cutover_readiness()),
  true,
  'Restoring derived state and sequence metadata restores shadow consistency'
);
SELECT is(
  (SELECT cutover_authorized FROM private.get_handling_cutover_readiness()),
  false,
  'Restored consistency still cannot authorize cutover'
);

INSERT INTO public.conversations (id, client_id, character_id, status)
VALUES (
  '00000000-0000-4000-8000-0000000a3110',
  '00000000-0000-4000-8000-0000000a0106',
  '00000000-0000-4000-8000-0000000a2102',
  'open'
);
SELECT private.initialize_conversation_handling_shadow_locked(
  '00000000-0000-4000-8000-0000000a3110'
);
SELECT is(
  (SELECT expected_needs_handling FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3110'),
  false,
  'An empty initialized conversation expects needs_handling=false'
);
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3110'),
  true,
  'An empty initialized conversation is reconciliation-consistent'
);

INSERT INTO public.conversations (id, client_id, character_id, assigned_operator_id, status)
VALUES (
  '00000000-0000-4000-8000-0000000a3111',
  '00000000-0000-4000-8000-0000000a0107',
  '00000000-0000-4000-8000-0000000a2102',
  '00000000-0000-4000-8000-0000000a1102',
  'open'
);
ALTER TABLE public.messages DISABLE TRIGGER prepare_message_handling_shadow;
ALTER TABLE public.messages DISABLE TRIGGER record_message_handling_issue;
INSERT INTO public.messages (
  id, conversation_id, sender_type, sender_id, operator_id, content, created_at
)
VALUES (
  '00000000-0000-4000-8000-0000000a4311',
  '00000000-0000-4000-8000-0000000a3111',
  'operator',
  '00000000-0000-4000-8000-0000000a0102',
  '00000000-0000-4000-8000-0000000a1102',
  'historical none-only message',
  '2026-01-01 13:00:00+00'
);
ALTER TABLE public.messages ENABLE TRIGGER prepare_message_handling_shadow;
ALTER TABLE public.messages ENABLE TRIGGER record_message_handling_issue;
SELECT private.initialize_conversation_handling_shadow_locked(
  '00000000-0000-4000-8000-0000000a3111'
);
SELECT is(
  (SELECT handling_effect FROM public.messages WHERE id = '00000000-0000-4000-8000-0000000a4311'),
  'none',
  'Historical no-cycle Operator message produces a none-only conversation'
);
SELECT is(
  (SELECT expected_needs_handling FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3111'),
  false,
  'A none-only conversation expects needs_handling=false'
);
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3111'),
  true,
  'A none-only conversation is reconciliation-consistent'
);

INSERT INTO public.conversations (id, client_id, character_id, assigned_operator_id, status)
VALUES (
  '00000000-0000-4000-8000-0000000a3112',
  '00000000-0000-4000-8000-0000000a0108',
  '00000000-0000-4000-8000-0000000a2102',
  '00000000-0000-4000-8000-0000000a1102',
  'open'
);
INSERT INTO public.messages (
  id, conversation_id, sender_type, sender_id, operator_id, content, created_at
)
VALUES
  (
    '00000000-0000-4000-8000-0000000a4321',
    '00000000-0000-4000-8000-0000000a3112',
    'system',
    '00000000-0000-4000-8000-0000000a0108',
    NULL,
    'system without operator',
    '2026-10-06 22:00:00+00'
  ),
  (
    '00000000-0000-4000-8000-0000000a4322',
    '00000000-0000-4000-8000-0000000a3112',
    'system',
    '00000000-0000-4000-8000-0000000a0102',
    '00000000-0000-4000-8000-0000000a1102',
    'system with operator and no cycle',
    '2026-10-06 22:01:00+00'
  );
INSERT INTO public.conversation_work_items (
  id, conversation_id, client_id, character_id, status,
  responsible_operator_id, assigned_at, last_activity_at
)
VALUES (
  '00000000-0000-4000-8000-0000000a5112',
  '00000000-0000-4000-8000-0000000a3112',
  '00000000-0000-4000-8000-0000000a0108',
  '00000000-0000-4000-8000-0000000a2102',
  'assigned',
  '00000000-0000-4000-8000-0000000a1102',
  '2026-10-06 22:01:30+00',
  '2026-10-06 22:01:30+00'
);
INSERT INTO public.conversation_handling_cycles (
  id, conversation_id, work_item_id, operator_id, started_at
)
VALUES (
  '00000000-0000-4000-8000-0000000a6112',
  '00000000-0000-4000-8000-0000000a3112',
  '00000000-0000-4000-8000-0000000a5112',
  '00000000-0000-4000-8000-0000000a1102',
  '2026-10-06 22:01:30+00'
);
INSERT INTO public.messages (
  id, conversation_id, sender_type, sender_id, operator_id, content, created_at
)
VALUES (
  '00000000-0000-4000-8000-0000000a4323',
  '00000000-0000-4000-8000-0000000a3112',
  'system',
  '00000000-0000-4000-8000-0000000a0102',
  '00000000-0000-4000-8000-0000000a1102',
  'system with matching active cycle',
  '2026-10-06 22:02:00+00'
);
SELECT is(
  (SELECT count(*) FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-0000000a3112' AND handling_effect = 'none' AND handling_cycle_id IS NULL AND handling_classification_reason = 'system_non_business'),
  3::bigint,
  'System messages are always none without a cycle link, with or without operator context'
);
SELECT is(
  (SELECT count(*) FROM private.handling_reconciliation_issues WHERE conversation_id = '00000000-0000-4000-8000-0000000a3112'),
  0::bigint,
  'System messages never create reconciliation issues'
);
SELECT is(
  (SELECT jsonb_build_object('needs', needs_handling, 'pending', pending_since, 'last', last_business_message_at, 'expiry', inactivity_expires_at) FROM public.conversations WHERE id = '00000000-0000-4000-8000-0000000a3112'),
  jsonb_build_object('needs', false, 'pending', NULL, 'last', NULL, 'expiry', NULL),
  'System messages do not change business handling state'
);
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3112'),
  true,
  'A system-only conversation is reconciliation-consistent'
);

INSERT INTO public.conversations (id, client_id, character_id, status)
VALUES (
  '00000000-0000-4000-8000-0000000a3114',
  '00000000-0000-4000-8000-0000000a0109',
  '00000000-0000-4000-8000-0000000a2102',
  'open'
);
INSERT INTO public.messages (
  id, conversation_id, sender_type, sender_id, content, created_at
)
VALUES (
  '00000000-0000-4000-8000-0000000a4341',
  '00000000-0000-4000-8000-0000000a3114',
  'client',
  '00000000-0000-4000-8000-0000000a0109',
  'sequence first but timestamp later',
  '2026-10-06 14:00:00+00'
), (
  '00000000-0000-4000-8000-0000000a4342',
  '00000000-0000-4000-8000-0000000a3114',
  'client',
  '00000000-0000-4000-8000-0000000a0109',
  'sequence second but timestamp earlier',
  '2026-10-06 13:00:00+00'
);
SELECT is(
  (SELECT pending_since FROM public.conversations WHERE id = '00000000-0000-4000-8000-0000000a3114'),
  '2026-10-06 14:00:00+00'::timestamptz,
  'Pending start follows the first Client sequence, not the minimum timestamp'
);
SELECT is(
  (SELECT last_business_message_at FROM public.conversations WHERE id = '00000000-0000-4000-8000-0000000a3114'),
  '2026-10-06 13:00:00+00'::timestamptz,
  'Latest business event follows handling_sequence, not max(created_at)'
);
SELECT is(
  (SELECT inactivity_expires_at FROM public.conversations WHERE id = '00000000-0000-4000-8000-0000000a3114'),
  '2026-10-06 13:03:00+00'::timestamptz,
  'Rolling inactivity uses the event time of the highest business sequence'
);
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3114'),
  true,
  'Non-monotonic timestamps remain consistent under sequence ordering'
);

UPDATE public.messages
SET handling_effect = 'client_request',
    handling_cycle_id = NULL,
    handling_classification_reason = 'client_business_message'
WHERE id = '00000000-0000-4000-8000-0000000a4321';
SELECT * FROM pg_temp.wp01_assert_semantic_corruption(
  '00000000-0000-4000-8000-0000000a3112',
  'System message stored as client_request'
);
SELECT is(
  (SELECT expected_needs_handling FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3112'),
  false,
  'Corrupt System classification does not become expected business state'
);
UPDATE public.messages
SET handling_effect = 'none',
    handling_cycle_id = NULL,
    handling_classification_reason = 'system_non_business'
WHERE id = '00000000-0000-4000-8000-0000000a4321';

UPDATE public.messages
SET handling_effect = 'staff_response',
    handling_cycle_id = '00000000-0000-4000-8000-0000000a6112',
    handling_classification_reason = 'active_cycle_owner'
WHERE id = '00000000-0000-4000-8000-0000000a4323';
SELECT * FROM pg_temp.wp01_assert_semantic_corruption(
  '00000000-0000-4000-8000-0000000a3112',
  'System message stored as staff_response'
);
UPDATE public.messages
SET handling_effect = 'none',
    handling_cycle_id = NULL,
    handling_classification_reason = 'system_non_business'
WHERE id = '00000000-0000-4000-8000-0000000a4323';

UPDATE public.messages
SET handling_cycle_id = '00000000-0000-4000-8000-0000000a6112'
WHERE id = '00000000-0000-4000-8000-0000000a4322';
SELECT * FROM pg_temp.wp01_assert_semantic_corruption(
  '00000000-0000-4000-8000-0000000a3112',
  'System message carrying cycle evidence'
);
UPDATE public.messages
SET handling_cycle_id = NULL
WHERE id = '00000000-0000-4000-8000-0000000a4322';

INSERT INTO public.conversation_handling_cycles (
  id, conversation_id, work_item_id, operator_id, started_at, ended_at, end_reason
)
VALUES (
  '00000000-0000-4000-8000-0000000a6114',
  '00000000-0000-4000-8000-0000000a3114',
  NULL,
  '00000000-0000-4000-8000-0000000a1102',
  '2026-10-06 12:00:00+00',
  '2026-10-06 15:00:00+00',
  'released'
);

UPDATE public.messages
SET operator_id = '00000000-0000-4000-8000-0000000a1102',
    handling_effect = 'staff_response',
    handling_cycle_id = '00000000-0000-4000-8000-0000000a6114',
    handling_classification_reason = 'active_cycle_owner'
WHERE id = '00000000-0000-4000-8000-0000000a4342';
SELECT * FROM pg_temp.wp01_assert_semantic_corruption(
  '00000000-0000-4000-8000-0000000a3114',
  'Client message stored as staff_response'
);
SELECT is(
  (
    SELECT jsonb_build_object(
      'needs', expected_needs_handling,
      'pending', expected_pending_since,
      'last', expected_last_business_message_at
    )
    FROM private.get_handling_shadow_reconciliation()
    WHERE conversation_id = '00000000-0000-4000-8000-0000000a3114'
  ),
  jsonb_build_object(
    'needs', true,
    'pending', '2026-10-06 14:00:00+00'::timestamptz,
    'last', '2026-10-06 13:00:00+00'::timestamptz
  ),
  'Corrupt Client classification does not change the computed expected state'
);
UPDATE public.messages
SET operator_id = NULL,
    handling_effect = 'client_request',
    handling_cycle_id = NULL,
    handling_classification_reason = 'client_business_message'
WHERE id = '00000000-0000-4000-8000-0000000a4342';

UPDATE public.messages
SET handling_cycle_id = '00000000-0000-4000-8000-0000000a6114'
WHERE id = '00000000-0000-4000-8000-0000000a4342';
SELECT * FROM pg_temp.wp01_assert_semantic_corruption(
  '00000000-0000-4000-8000-0000000a3114',
  'Client message carrying cycle evidence'
);
UPDATE public.messages
SET handling_cycle_id = NULL
WHERE id = '00000000-0000-4000-8000-0000000a4342';

UPDATE public.messages
SET sender_id = '00000000-0000-4000-8000-0000000a0108'
WHERE id = '00000000-0000-4000-8000-0000000a4342';
SELECT * FROM pg_temp.wp01_assert_semantic_corruption(
  '00000000-0000-4000-8000-0000000a3114',
  'Client sender identity from another conversation owner'
);
SELECT is(
  (SELECT expected_last_business_message_at FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3114'),
  '2026-10-06 14:00:00+00'::timestamptz,
  'A foreign Client identity is excluded from the computed business fold'
);
UPDATE public.messages
SET sender_id = '00000000-0000-4000-8000-0000000a0109'
WHERE id = '00000000-0000-4000-8000-0000000a4342';

SELECT set_config(
  'wp01.owner_response_message_id',
  (SELECT id::TEXT FROM public.messages WHERE content = 'owner response'),
  true
);

UPDATE public.messages
SET handling_effect = 'client_request',
    handling_cycle_id = NULL,
    handling_classification_reason = 'client_business_message'
WHERE id = current_setting('wp01.owner_response_message_id')::UUID;
SELECT * FROM pg_temp.wp01_assert_semantic_corruption(
  '00000000-0000-4000-8000-0000000a3101',
  'Operator message stored as client_request'
);
UPDATE public.messages
SET handling_effect = 'staff_response',
    handling_cycle_id = '00000000-0000-4000-8000-0000000a6101',
    handling_classification_reason = 'active_cycle_owner'
WHERE id = current_setting('wp01.owner_response_message_id')::UUID;

UPDATE public.messages
SET handling_cycle_id = NULL
WHERE id = current_setting('wp01.owner_response_message_id')::UUID;
SELECT * FROM pg_temp.wp01_assert_semantic_corruption(
  '00000000-0000-4000-8000-0000000a3101',
  'staff_response without cycle evidence'
);
UPDATE public.messages
SET handling_cycle_id = '00000000-0000-4000-8000-0000000a6101'
WHERE id = current_setting('wp01.owner_response_message_id')::UUID;

UPDATE public.messages
SET handling_cycle_id = '00000000-0000-4000-8000-0000000a6100'
WHERE id = current_setting('wp01.owner_response_message_id')::UUID;
SELECT * FROM pg_temp.wp01_assert_semantic_corruption(
  '00000000-0000-4000-8000-0000000a3101',
  'staff_response with non-covering cycle evidence'
);
UPDATE public.messages
SET handling_cycle_id = '00000000-0000-4000-8000-0000000a6101'
WHERE id = current_setting('wp01.owner_response_message_id')::UUID;

UPDATE public.messages
SET operator_id = '00000000-0000-4000-8000-0000000a1104'
WHERE id = current_setting('wp01.owner_response_message_id')::UUID;
SELECT * FROM pg_temp.wp01_assert_semantic_corruption(
  '00000000-0000-4000-8000-0000000a3101',
  'staff_response with foreign operator evidence'
);
UPDATE public.messages
SET operator_id = '00000000-0000-4000-8000-0000000a1102'
WHERE id = current_setting('wp01.owner_response_message_id')::UUID;

UPDATE public.messages
SET handling_cycle_id = '00000000-0000-4000-8000-0000000a6112'
WHERE id = current_setting('wp01.owner_response_message_id')::UUID;
SELECT * FROM pg_temp.wp01_assert_semantic_corruption(
  '00000000-0000-4000-8000-0000000a3101',
  'staff_response with foreign conversation evidence'
);
UPDATE public.messages
SET handling_cycle_id = '00000000-0000-4000-8000-0000000a6101'
WHERE id = current_setting('wp01.owner_response_message_id')::UUID;

UPDATE public.messages
SET handling_classification_reason = 'fallback_no_active_cycle'
WHERE id = current_setting('wp01.owner_response_message_id')::UUID;
SELECT * FROM pg_temp.wp01_assert_semantic_corruption(
  '00000000-0000-4000-8000-0000000a3101',
  'staff_response with a reason that contradicts its evidence'
);
UPDATE public.messages
SET handling_classification_reason = 'active_cycle_owner'
WHERE id = current_setting('wp01.owner_response_message_id')::UUID;

UPDATE public.messages
SET sender_id = '00000000-0000-4000-8000-0000000a0104'
WHERE id = current_setting('wp01.owner_response_message_id')::UUID;
SELECT * FROM pg_temp.wp01_assert_semantic_corruption(
  '00000000-0000-4000-8000-0000000a3101',
  'Operator sender identity that contradicts operator_id'
);
UPDATE public.messages
SET sender_id = '00000000-0000-4000-8000-0000000a0102'
WHERE id = current_setting('wp01.owner_response_message_id')::UUID;

SELECT is(
  (SELECT semantic_consistent FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3101'),
  true,
  'Restoring Operator source evidence restores semantic consistency'
);

INSERT INTO public.conversations (id, client_id, character_id, assigned_operator_id, status)
VALUES (
  '00000000-0000-4000-8000-0000000a3115',
  '00000000-0000-4000-8000-0000000a0110',
  '00000000-0000-4000-8000-0000000a2102',
  '00000000-0000-4000-8000-0000000a1102',
  'open'
);
INSERT INTO public.messages (
  id, conversation_id, sender_type, sender_id, operator_id, content, created_at
)
VALUES (
  '00000000-0000-4000-8000-0000000a4351',
  '00000000-0000-4000-8000-0000000a3115',
  'admin',
  '00000000-0000-4000-8000-0000000a0102',
  '00000000-0000-4000-8000-0000000a1102',
  'admin ambiguity issue probe',
  '2026-10-06 15:00:00+00'
);
UPDATE public.messages
SET handling_effect = 'client_request',
    handling_cycle_id = NULL,
    handling_classification_reason = 'client_business_message'
WHERE id = '00000000-0000-4000-8000-0000000a4351';
SELECT * FROM pg_temp.wp01_assert_semantic_corruption(
  '00000000-0000-4000-8000-0000000a3115',
  'Admin message stored as client_request'
);
UPDATE public.messages
SET handling_effect = 'unclassified',
    handling_cycle_id = NULL,
    handling_classification_reason = 'admin_without_takeover_evidence'
WHERE id = '00000000-0000-4000-8000-0000000a4351';
SELECT is(
  (SELECT count(*)
   FROM private.handling_reconciliation_issues issue
   JOIN public.messages message ON message.id = issue.message_id
   WHERE message.id = '00000000-0000-4000-8000-0000000a4351'
     AND issue.conversation_id = message.conversation_id
     AND issue.issue_kind = message.handling_classification_reason
     AND issue.status = 'unresolved'
     AND issue.can_change_canonical_state IS TRUE),
  1::bigint,
  'Admin ambiguity starts with exactly one matching unresolved state-changing issue'
);
SELECT is(
  (SELECT metadata_complete FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3115'),
  true,
  'An exact matching Admin ambiguity issue completes reconciliation metadata'
);
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3115'),
  true,
  'An unclassified state-changing message is consistent while its unresolved issue exists'
);
SELECT is(
  (SELECT unresolved_fallback_no_cycle_writes FROM private.get_handling_cutover_readiness()),
  1::bigint,
  'A matching Admin ambiguity issue contributes one fallback readiness blocker'
);
SELECT is(
  (SELECT unresolved_state_changing_effects FROM private.get_handling_cutover_readiness()),
  1::bigint,
  'A matching Admin ambiguity issue contributes one state-changing readiness blocker'
);
SELECT is(
  (SELECT inconsistent_conversations FROM private.get_handling_cutover_readiness()),
  0::bigint,
  'The exact issue match keeps the Admin ambiguity reconciliation row consistent'
);

UPDATE private.handling_reconciliation_issues
SET issue_kind = 'wrong_admin_issue_kind'
WHERE message_id = '00000000-0000-4000-8000-0000000a4351';
SELECT is(
  (SELECT metadata_complete FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3115'),
  false,
  'A wrong issue kind does not complete unclassified message metadata'
);
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3115'),
  false,
  'A wrong issue kind makes the Admin ambiguity reconciliation row inconsistent'
);
SELECT is(
  (SELECT inconsistent_conversations FROM private.get_handling_cutover_readiness()),
  1::bigint,
  'Readiness counts the conversation with a mismatched issue as inconsistent'
);
SELECT is(
  (SELECT unresolved_fallback_no_cycle_writes FROM private.get_handling_cutover_readiness()),
  1::bigint,
  'A wrong issue kind cannot hide the fallback Admin ambiguity message'
);
SELECT is(
  (SELECT unresolved_state_changing_effects FROM private.get_handling_cutover_readiness()),
  1::bigint,
  'A wrong issue kind cannot hide the state-changing unclassified message'
);

UPDATE private.handling_reconciliation_issues
SET issue_kind = 'admin_without_takeover_evidence',
    status = 'resolved',
    resolved_at = clock_timestamp()
WHERE message_id = '00000000-0000-4000-8000-0000000a4351';
SELECT is(
  (SELECT metadata_complete FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3115'),
  false,
  'A resolved issue cannot complete metadata while its message remains unclassified'
);
SELECT is(
  (SELECT unresolved_fallback_no_cycle_writes FROM private.get_handling_cutover_readiness()),
  1::bigint,
  'A resolved issue cannot hide an unclassified fallback message'
);
SELECT is(
  (SELECT unresolved_state_changing_effects FROM private.get_handling_cutover_readiness()),
  1::bigint,
  'A resolved issue cannot hide an unclassified state-changing message'
);

UPDATE private.handling_reconciliation_issues
SET status = 'non_qualifying'
WHERE message_id = '00000000-0000-4000-8000-0000000a4351';
SELECT is(
  (SELECT metadata_complete FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3115'),
  false,
  'A non-qualifying issue cannot complete metadata while its message remains unclassified'
);

UPDATE private.handling_reconciliation_issues
SET status = 'unresolved',
    can_change_canonical_state = FALSE,
    resolved_at = NULL
WHERE message_id = '00000000-0000-4000-8000-0000000a4351';
SELECT is(
  (SELECT metadata_complete FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3115'),
  false,
  'An issue with can_change false cannot complete unclassified state-changing metadata'
);
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3115'),
  false,
  'An issue with can_change false leaves the reconciliation row inconsistent'
);
SELECT is(
  (SELECT unresolved_fallback_no_cycle_writes FROM private.get_handling_cutover_readiness()),
  1::bigint,
  'An issue with can_change false cannot hide an unclassified fallback message'
);
SELECT is(
  (SELECT unresolved_state_changing_effects FROM private.get_handling_cutover_readiness()),
  1::bigint,
  'An issue with can_change false cannot hide an unclassified state-changing message'
);

DELETE FROM private.handling_reconciliation_issues
WHERE message_id = '00000000-0000-4000-8000-0000000a4351';
SELECT is(
  (SELECT metadata_complete FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3115'),
  false,
  'A missing issue leaves unclassified message metadata incomplete'
);
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3115'),
  false,
  'An unclassified state-changing message without its matching issue is inconsistent'
);
SELECT is(
  (SELECT inconsistent_conversations FROM private.get_handling_cutover_readiness()),
  1::bigint,
  'Readiness counts the conversation with a missing issue as inconsistent'
);
SELECT is(
  (SELECT unresolved_fallback_no_cycle_writes FROM private.get_handling_cutover_readiness()),
  1::bigint,
  'A missing issue cannot reduce the fallback blocker count to zero'
);
SELECT is(
  (SELECT unresolved_state_changing_effects FROM private.get_handling_cutover_readiness()),
  1::bigint,
  'A missing issue cannot reduce the state-changing blocker count to zero'
);
INSERT INTO private.handling_reconciliation_issues (
  conversation_id, message_id, issue_kind, status, can_change_canonical_state, evidence
)
VALUES (
  '00000000-0000-4000-8000-0000000a3115',
  '00000000-0000-4000-8000-0000000a4351',
  'admin_without_takeover_evidence',
  'unresolved',
  TRUE,
  '{"classification_source":"pgTAP_issue_restore"}'::jsonb
);
SELECT is(
  (SELECT metadata_complete FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3115'),
  true,
  'Restoring the exact issue restores complete reconciliation metadata'
);
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3115'),
  true,
  'Restoring the exact unresolved issue restores reconciliation consistency'
);
SELECT is(
  (SELECT inconsistent_conversations FROM private.get_handling_cutover_readiness()),
  0::bigint,
  'Restoring the exact issue removes the reconciliation inconsistency count'
);
SELECT is(
  (SELECT unresolved_fallback_no_cycle_writes FROM private.get_handling_cutover_readiness()),
  1::bigint,
  'The restored unresolved Admin ambiguity remains a fallback blocker'
);
SELECT is(
  (SELECT unresolved_state_changing_effects FROM private.get_handling_cutover_readiness()),
  1::bigint,
  'The restored unresolved Admin ambiguity remains a state-changing blocker'
);
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_cutover_readiness()),
  false,
  'Readiness remains negative while the exact Admin ambiguity issue is unresolved'
);
SELECT private.resolve_handling_reconciliation_issue(
  '00000000-0000-4000-8000-0000000a4351',
  'none',
  NULL,
  'Synthetic ambiguity resolved after issue-link proof'
);
SELECT is(
  (SELECT handling_effect FROM public.messages WHERE id = '00000000-0000-4000-8000-0000000a4351'),
  'none',
  'Explicit resolution removes the Admin message from the unclassified set'
);
SELECT is(
  (SELECT status FROM private.handling_reconciliation_issues WHERE message_id = '00000000-0000-4000-8000-0000000a4351'),
  'non_qualifying',
  'Explicit none resolution retains the issue as non-qualifying audit history'
);
SELECT is(
  (SELECT resolved_at IS NOT NULL FROM private.handling_reconciliation_issues WHERE message_id = '00000000-0000-4000-8000-0000000a4351'),
  true,
  'Explicit resolution timestamps the resolved issue'
);
SELECT is(
  (SELECT unresolved_fallback_no_cycle_writes FROM private.get_handling_cutover_readiness()),
  0::bigint,
  'Explicit resolution clears the fallback blocker count'
);
SELECT is(
  (SELECT unresolved_state_changing_effects FROM private.get_handling_cutover_readiness()),
  0::bigint,
  'Explicit resolution clears the state-changing blocker count'
);
SELECT is(
  (SELECT inconsistent_conversations FROM private.get_handling_cutover_readiness()),
  0::bigint,
  'Explicit resolution leaves no inconsistent reconciliation row'
);
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3115'),
  true,
  'Explicit resolution leaves the Admin fixture reconciliation row consistent'
);
SELECT is(
  (SELECT semantic_consistent FROM private.get_handling_shadow_reconciliation() WHERE conversation_id = '00000000-0000-4000-8000-0000000a3115'),
  true,
  'Explicit none resolution remains semantically consistent with preserved audit evidence'
);
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_cutover_readiness()),
  true,
  'Explicit resolution restores readiness consistency without authorizing cutover'
);

INSERT INTO public.conversations (id, client_id, character_id, status)
VALUES (
  '00000000-0000-4000-8000-0000000a3105',
  '00000000-0000-4000-8000-0000000a0105',
  '00000000-0000-4000-8000-0000000a2102',
  'open'
);
INSERT INTO public.messages (
  id, conversation_id, sender_type, sender_id, content, created_at
)
VALUES (
  '00000000-0000-4000-8000-0000000a4205',
  '00000000-0000-4000-8000-0000000a3105',
  'client',
  '00000000-0000-4000-8000-0000000a0105',
  'closed semantic request',
  '2026-10-06 21:00:00+00'
);
UPDATE public.conversations
SET status = 'closed'
WHERE id = '00000000-0000-4000-8000-0000000a3105';
SELECT is(
  (SELECT needs_handling FROM public.conversations WHERE id = '00000000-0000-4000-8000-0000000a3105'),
  true,
  'Closing a conversation preserves the semantic handling state'
);
SELECT is(
  (SELECT count(*) FROM public.conversation_work_items WHERE conversation_id = '00000000-0000-4000-8000-0000000a3105' AND status IN ('new','assigned','in_progress')),
  0::bigint,
  'A closed conversation has no active NEW projection item'
);
SELECT is(
  (SELECT shadow_consistent FROM private.get_handling_cutover_readiness()),
  true,
  'Closed semantic state is consistent when no active NEW item remains'
);

UPDATE public.conversations
SET status = 'open'
WHERE id = '00000000-0000-4000-8000-0000000a3105';

CREATE OR REPLACE FUNCTION pg_temp.wp01_force_post_insert_failure()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wp01_forced_post_insert_failure';
END;
$$;
CREATE TRIGGER zz_wp01_force_post_insert_failure
AFTER INSERT ON public.messages
FOR EACH ROW
WHEN (NEW.content = 'wp01 forced rollback')
EXECUTE FUNCTION pg_temp.wp01_force_post_insert_failure();

INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
VALUES ('00000000-0000-4000-8000-0000000a0105', 100, 100, 0)
ON CONFLICT (user_id) DO UPDATE SET balance = GREATEST(public.credit_wallets.balance, 100);
SELECT set_config(
  'wp01.rollback_baseline',
  pg_temp.wp01_conversation_state(
    '00000000-0000-4000-8000-0000000a3105',
    '00000000-0000-4000-8000-0000000a0105'
  )::text,
  true
);
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-0000000a0105';
SET LOCAL ROLE authenticated;
SELECT throws_like(
  $$SELECT public.send_client_message(
    '00000000-0000-4000-8000-0000000a3105'::uuid,
    'wp01 forced rollback'
  )$$,
  'wp01_forced_post_insert_failure',
  'A forced post-insert failure aborts the live client send'
);
RESET ROLE;
SELECT is(
  pg_temp.wp01_conversation_state(
    '00000000-0000-4000-8000-0000000a3105',
    '00000000-0000-4000-8000-0000000a0105'
  ),
  current_setting('wp01.rollback_baseline')::jsonb,
  'Forced failure rolls back message, sequence, shadow, work-item, ledger and audit effects'
);

SELECT * FROM finish();
ROLLBACK;
