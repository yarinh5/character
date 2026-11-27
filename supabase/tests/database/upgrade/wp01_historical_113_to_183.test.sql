-- Run only on the admitted local database after the exact WP01 M113 fixture
-- has been committed and migrations M114-M183 have been applied. This test
-- requires the cold, uninitialized fixture state, and rolls back every
-- backfill observation made here.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;

SELECT plan(27);

SELECT is((SELECT count(*) FROM supabase_migrations.schema_migrations), 183::bigint,
  'The complete 183-migration chain is installed');
SELECT is((SELECT max(version) FROM supabase_migrations.schema_migrations),
  '20261126204500', 'The installed chain ends at the approved migration');
SELECT ok(
  to_regclass('private.handling_reconciliation_issues') IS NOT NULL
    AND to_regprocedure('private.backfill_handling_shadow_batch(integer)') IS NOT NULL
    AND to_regprocedure('private.get_handling_cutover_readiness()') IS NOT NULL
    AND EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'handling_effect'),
  'Historical reconciliation schema and RPCs exist');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.conversations'::regclass),
  'Conversation RLS remains enabled after upgrade');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.messages'::regclass),
  'Message RLS remains enabled after upgrade');
SELECT ok(NOT has_function_privilege('authenticated',
  'private.backfill_handling_shadow_batch(integer)', 'EXECUTE'),
  'Authenticated users cannot execute the private backfill');
SELECT ok(NOT has_function_privilege('authenticated',
  'private.get_handling_cutover_readiness()', 'EXECUTE'),
  'Authenticated users cannot execute private cutover readiness');
SELECT ok(has_function_privilege('authenticated',
  'public.send_operator_message(uuid,text,uuid)', 'EXECUTE'),
  'Authenticated users retain the token-bound send RPC grant');
SELECT ok(NOT has_function_privilege('anon',
  'public.send_operator_message(uuid,text,uuid)', 'EXECUTE'),
  'Anonymous users cannot execute the operator send RPC');

SELECT is((SELECT count(*) FROM auth.users WHERE email LIKE 'wp01-upgrade-%@example.invalid'),
  8::bigint, 'All eight historical fixture identities remain');
SELECT is((
  SELECT count(*) FROM public.conversations conversation
  -- The baseline message trigger changes these statuses during fixture load.
  JOIN (VALUES
    ('0101', '0001', NULL, 'waiting'),
    ('0102', '0002', '0021', 'answered'),
    ('0103', '0003', '0021', 'answered'),
    ('0104', '0004', NULL, 'closed'),
    ('0105', '0005', '0021', 'waiting'),
    ('0106', '0006', '0022', 'open')
  ) expected(conversation_suffix, client_suffix, operator_suffix, status)
    ON conversation.id::text = '00000000-0000-4000-8000-0000000b' || expected.conversation_suffix
   AND conversation.client_id::text = '00000000-0000-4000-8000-0000000b' || expected.client_suffix
   AND conversation.assigned_operator_id::text IS NOT DISTINCT FROM
     CASE WHEN expected.operator_suffix IS NULL THEN NULL
       ELSE '00000000-0000-4000-8000-0000000b' || expected.operator_suffix END
   AND conversation.status::text = expected.status
), 6::bigint, 'All six historical conversations retain client, owner and status');
SELECT is((
  SELECT count(*) FROM public.messages message
  JOIN (VALUES
    ('0301', 'client', 'wp01 upgrade client only', '2026-10-01T09:00:00Z'),
    ('0302', 'client', 'wp01 upgrade client before response', '2026-10-01T10:01:00Z'),
    ('0303', 'operator', 'wp01 upgrade qualifying response', '2026-10-01T10:05:00Z'),
    ('0304', 'operator', 'wp01 upgrade historical no cycle', '2026-10-01T11:00:00Z'),
    ('0305', 'client', 'wp01 upgrade closed client request', '2026-10-01T11:30:00Z'),
    ('0306', 'client', 'wp01 upgrade active cycle request', '2026-10-01T12:01:00Z'),
    ('0307', 'admin', 'wp01 upgrade admin ambiguity', '2026-10-01T13:00:00Z')
  ) expected(message_suffix, sender, content, created_at)
    ON message.id::text = '00000000-0000-4000-8000-0000000b' || expected.message_suffix
   AND message.sender_type::text = expected.sender
   AND message.content = expected.content
   AND message.created_at = expected.created_at::timestamptz
), 7::bigint, 'All seven historical messages retain sender, content and timestamp');
SELECT is((SELECT count(*) FROM public.conversation_handling_cycles
  WHERE id IN ('00000000-0000-4000-8000-0000000b0201',
               '00000000-0000-4000-8000-0000000b0202')),
  2::bigint, 'Both historical handling cycles remain');
SELECT is((SELECT count(*) FROM public.conversation_work_items
  WHERE conversation_id IN (
    '00000000-0000-4000-8000-0000000b0101',
    '00000000-0000-4000-8000-0000000b0102',
    '00000000-0000-4000-8000-0000000b0103',
    '00000000-0000-4000-8000-0000000b0104',
    '00000000-0000-4000-8000-0000000b0105',
    '00000000-0000-4000-8000-0000000b0106')),
  4::bigint, 'Four historical work items remain without duplication');

CREATE TEMP TABLE ac29_before_backfill ON COMMIT DROP AS
SELECT count(*)::integer AS uninitialized
FROM public.conversations
WHERE id IN (
  '00000000-0000-4000-8000-0000000b0101',
  '00000000-0000-4000-8000-0000000b0102',
  '00000000-0000-4000-8000-0000000b0103',
  '00000000-0000-4000-8000-0000000b0104',
  '00000000-0000-4000-8000-0000000b0105',
  '00000000-0000-4000-8000-0000000b0106')
  AND handling_state_initialized IS NOT TRUE;
SELECT is((SELECT uninitialized FROM ac29_before_backfill), 6,
  'All six historical conversations are uninitialized before the first backfill');

CREATE TEMP TABLE ac29_original_messages ON COMMIT DROP AS
SELECT coalesce(jsonb_agg(jsonb_build_object(
  'id', message.id, 'conversation_id', message.conversation_id,
  'sender_type', message.sender_type, 'sender_id', message.sender_id,
  'operator_id', message.operator_id, 'content', message.content,
  'created_at', message.created_at) ORDER BY message.id), '[]'::jsonb) AS rows
FROM public.messages message WHERE message.content LIKE 'wp01 upgrade %';

CREATE TEMP TABLE ac29_first_backfill ON COMMIT DROP AS
SELECT private.backfill_handling_shadow_batch(1000) AS result;
SELECT is((SELECT (result->>'initialized_count')::integer FROM ac29_first_backfill),
  (SELECT uninitialized FROM ac29_before_backfill),
  'First backfill initializes exactly the remaining fixture conversations');
SELECT is((SELECT (result->>'remaining_count')::integer FROM ac29_first_backfill),
  0, 'No historical conversation remains uninitialized');
SELECT is((SELECT rows FROM ac29_original_messages),
  (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', message.id, 'conversation_id', message.conversation_id,
    'sender_type', message.sender_type, 'sender_id', message.sender_id,
    'operator_id', message.operator_id, 'content', message.content,
    'created_at', message.created_at) ORDER BY message.id), '[]'::jsonb)
   FROM public.messages message WHERE message.content LIKE 'wp01 upgrade %'),
  'First backfill preserves all historical message identity, content and timestamps');
SELECT is((
  SELECT count(*) FROM public.conversations conversation
  JOIN (VALUES
    ('0101', TRUE,  '2026-10-01T09:00:00Z', 1, 2, '2026-10-01T09:00:00Z'),
    ('0102', FALSE, NULL,                   2, 3, '2026-10-01T10:05:00Z'),
    ('0103', FALSE, NULL,                   1, 2, NULL),
    ('0104', TRUE,  '2026-10-01T11:30:00Z', 1, 2, '2026-10-01T11:30:00Z'),
    ('0105', TRUE,  '2026-10-01T12:01:00Z', 1, 2, '2026-10-01T12:01:00Z'),
    ('0106', FALSE, NULL,                   1, 2, NULL)
  ) expected(suffix, needs, pending, last_sequence, next_sequence, business_at)
    ON conversation.id::text = '00000000-0000-4000-8000-0000000b' || expected.suffix
   AND conversation.handling_state_initialized IS TRUE
   AND conversation.needs_handling IS NOT DISTINCT FROM expected.needs
   AND conversation.pending_since IS NOT DISTINCT FROM expected.pending::timestamptz
   AND conversation.last_handling_message_sequence = expected.last_sequence
   AND conversation.handling_next_sequence = expected.next_sequence
   AND conversation.last_business_message_at IS NOT DISTINCT FROM expected.business_at::timestamptz
   AND conversation.inactivity_expires_at IS NOT DISTINCT FROM
     expected.business_at::timestamptz + interval '180 seconds'
), 6::bigint, 'First backfill derives each historical pending state, sequence and expiry');
SELECT is((
  SELECT count(*) FROM public.conversation_handling_cycles cycle
  JOIN (VALUES
    ('0201', '0102', '0021', FALSE),
    ('0202', '0105', '0021', TRUE)
  ) expected(cycle_suffix, conversation_suffix, operator_suffix, active)
    ON cycle.id::text = '00000000-0000-4000-8000-0000000b' || expected.cycle_suffix
   AND cycle.conversation_id::text = '00000000-0000-4000-8000-0000000b' || expected.conversation_suffix
   AND cycle.operator_id::text = '00000000-0000-4000-8000-0000000b' || expected.operator_suffix
   AND (cycle.ended_at IS NULL) = expected.active
), 2::bigint, 'First backfill preserves both historical cycle links and their active state');

CREATE TEMP TABLE ac29_message_snapshot ON COMMIT DROP AS
SELECT coalesce(jsonb_agg(to_jsonb(message) ORDER BY message.id), '[]'::jsonb) AS rows
FROM public.messages message WHERE message.content LIKE 'wp01 upgrade %';
CREATE TEMP TABLE ac29_second_backfill ON COMMIT DROP AS
SELECT private.backfill_handling_shadow_batch(1000) AS result;
SELECT ok((SELECT (result->>'initialized_count')::integer = 0
                 AND (result->>'remaining_count')::integer = 0
           FROM ac29_second_backfill),
  'Repeated backfill is a no-op for historical conversations');
SELECT is((SELECT rows FROM ac29_message_snapshot),
  (SELECT coalesce(jsonb_agg(to_jsonb(message) ORDER BY message.id), '[]'::jsonb)
   FROM public.messages message WHERE message.content LIKE 'wp01 upgrade %'),
  'Repeated backfill does not rewrite historical messages');
SELECT is((SELECT count(*) FROM private.handling_reconciliation_issues
  WHERE message_id = '00000000-0000-4000-8000-0000000b0307'
    AND status = 'unresolved' AND can_change_canonical_state),
  1::bigint, 'The single ambiguous Admin message remains unresolved');
SELECT ok((SELECT handling_effect = 'none' FROM public.messages
    WHERE id = '00000000-0000-4000-8000-0000000b0304')
  AND (SELECT handling_effect = 'unclassified' FROM public.messages
    WHERE id = '00000000-0000-4000-8000-0000000b0307'),
  'No-cycle Operator and ambiguous Admin histories keep distinct classifications');
SELECT ok((SELECT unresolved_fallback_no_cycle_writes = 1
    AND unresolved_state_changing_effects = 1
    AND shadow_consistent IS FALSE AND cutover_authorized IS FALSE
    FROM private.get_handling_cutover_readiness()),
  'Exactly one retained ambiguity blocks cutover without requiring global readiness zero');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000b0001', true);
SELECT is((SELECT count(*) FROM public.messages
  WHERE id = '00000000-0000-4000-8000-0000000b0301'),
  1::bigint, 'Historical Client owner can still read their message');
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000b0002', true);
SELECT is((SELECT count(*) FROM public.messages
  WHERE id = '00000000-0000-4000-8000-0000000b0301'),
  0::bigint, 'A different Client cannot read that historical message');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
