BEGIN;
SET LOCAL session_replication_role = replica;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM load_v3_2.fixture_runs
    WHERE run_id = 'load_v3_2_20260731_pilot_01'
      AND target_project_ref = 'micmgokyckvfpewxgrzf'
      AND status = 'core_seeded'
  ) THEN
    RAISE EXCEPTION 'load_fixture_core_guard_failed';
  END IF;
END;
$$;

WITH message_shape AS (
  SELECT
    sequence,
    ((sequence - 1) / 20) + 1 AS conversation_sequence,
    ((sequence - 1) % 20) + 1 AS message_position
  FROM generate_series(1, 200000) AS sequence
), resolved AS (
  SELECT
    *,
    ((conversation_sequence - 1) % 1000) + 1 AS client_sequence,
    ((conversation_sequence - 1) % 25) + 1 AS operator_sequence,
    CASE
      WHEN conversation_sequence <= 250 AND message_position = 20 THEN 'client'::public.sender_type
      WHEN message_position % 2 = 1 THEN 'client'::public.sender_type
      ELSE 'operator'::public.sender_type
    END AS sender_type
  FROM message_shape
)
INSERT INTO public.messages (
  id, conversation_id, sender_type, sender_id, operator_id,
  content, is_read, created_at
)
SELECT
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'message', sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'conversation', conversation_sequence),
  sender_type,
  CASE
    WHEN sender_type = 'client'::public.sender_type
      THEN load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', client_sequence)
    ELSE load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', 1000 + operator_sequence)
  END,
  CASE
    WHEN sender_type = 'operator'::public.sender_type
      THEN load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'operator', operator_sequence)
    ELSE NULL
  END,
  format('Load fixture message %s in conversation %s', message_position, conversation_sequence),
  message_position <= 15,
  '2026-07-01T12:07:36Z'::timestamptz
    + make_interval(secs => conversation_sequence * 120 + message_position * 3)
FROM resolved;

UPDATE public.conversations conversation
SET
  last_message_at = message.created_at,
  last_message_preview = message.content,
  operator_unread_count = CASE WHEN sequence <= 250 THEN 1 ELSE 0 END,
  client_unread_count = CASE WHEN sequence <= 250 THEN 0 ELSE 1 END,
  updated_at = message.created_at
FROM generate_series(1, 10000) AS sequence
JOIN public.messages message
  ON message.id = load_v3_2.fixture_id(
    'load_v3_2_20260731_pilot_01', 'message', ((sequence - 1) * 20) + 20
  )
WHERE conversation.id = load_v3_2.fixture_id(
  'load_v3_2_20260731_pilot_01', 'conversation', sequence
);

INSERT INTO public.conversation_work_items (
  id, conversation_id, client_id, character_id, last_client_message_id,
  status, responsible_operator_id, assigned_at,
  last_activity_at, created_at, updated_at
)
SELECT
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'work_item', sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'conversation', sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', ((sequence - 1) % 1000) + 1),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'character', ((sequence - 1) % 100) + 1),
  load_v3_2.fixture_id(
    'load_v3_2_20260731_pilot_01',
    'message',
    ((sequence - 1) * 20) + CASE WHEN sequence <= 250 THEN 20 ELSE 19 END
  ),
  CASE WHEN sequence <= 250 THEN 'new' ELSE 'in_progress' END,
  CASE WHEN sequence <= 250 THEN NULL ELSE load_v3_2.fixture_id(
    'load_v3_2_20260731_pilot_01', 'operator', ((sequence - 1) % 25) + 1
  ) END,
  CASE WHEN sequence <= 250 THEN NULL ELSE '2026-07-31T12:00:00Z'::timestamptz END,
  '2026-07-31T12:00:00Z'::timestamptz - make_interval(secs => sequence * 8),
  '2026-07-31T11:00:00Z'::timestamptz,
  '2026-07-31T12:00:00Z'::timestamptz - make_interval(secs => sequence * 8)
FROM generate_series(1, 325) AS sequence;

INSERT INTO public.conversation_handling_cycles (
  id, work_item_id, conversation_id, operator_id, started_at, created_at
)
SELECT
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'handling_cycle', sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'work_item', 250 + sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'conversation', 250 + sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'operator', ((249 + sequence) % 25) + 1),
  '2026-07-31T12:00:00Z'::timestamptz - make_interval(secs => sequence * 10),
  '2026-07-31T12:00:00Z'::timestamptz - make_interval(secs => sequence * 10)
FROM generate_series(1, 75) AS sequence;

INSERT INTO public.notifications (
  id, user_id, type, title, body, conversation_id, metadata, is_read, created_at
)
SELECT
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'notification', sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', ((sequence - 1) % 1025) + 1),
  'load_baseline',
  'Synthetic load notification',
  NULL,
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'conversation', ((sequence - 1) % 10000) + 1),
  jsonb_build_object('load_run_id', 'load_v3_2_20260731_pilot_01', 'sequence', sequence),
  sequence % 3 = 0,
  '2026-07-01T12:07:36Z'::timestamptz + make_interval(secs => sequence * 20)
FROM generate_series(1, 25000) AS sequence;

INSERT INTO public.analytics_events (
  id, event_name, actor_user_id, role, conversation_id,
  character_id, operator_id, metadata, created_at
)
SELECT
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'analytics_event', sequence),
  'load_baseline_event',
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', ((sequence - 1) % 1000) + 1),
  'client'::public.app_role,
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'conversation', ((sequence - 1) % 10000) + 1),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'character', ((sequence - 1) % 100) + 1),
  NULL,
  jsonb_build_object('load_run_id', 'load_v3_2_20260731_pilot_01', 'sequence', sequence),
  '2026-07-01T12:07:36Z'::timestamptz + make_interval(secs => sequence * 5)
FROM generate_series(1, 100000) AS sequence;

INSERT INTO load_v3_2.fixture_manifest (run_id, entity_type, ids, row_count)
SELECT 'load_v3_2_20260731_pilot_01', entity_type, ids, cardinality(ids)
FROM (
  VALUES
    ('messages', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'message', s) FROM generate_series(1, 200000) s)),
    ('conversation_work_items', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'work_item', s) FROM generate_series(1, 325) s)),
    ('conversation_handling_cycles', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'handling_cycle', s) FROM generate_series(1, 75) s)),
    ('notifications', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'notification', s) FROM generate_series(1, 25000) s)),
    ('analytics_events', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'analytics_event', s) FROM generate_series(1, 100000) s))
) AS manifest(entity_type, ids)
ON CONFLICT (run_id, entity_type) DO UPDATE
SET ids = EXCLUDED.ids, row_count = EXCLUDED.row_count;

UPDATE load_v3_2.fixture_runs
SET status = 'activity_seeded'
WHERE run_id = 'load_v3_2_20260731_pilot_01';

COMMIT;
