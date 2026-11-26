BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT no_plan();

CREATE OR REPLACE FUNCTION pg_temp.wp02_create_user(_id uuid, _email text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO auth.users (
    id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES (
    _id, 'authenticated', 'authenticated', _email, 'offline-test', clock_timestamp(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    clock_timestamp(), clock_timestamp()
  );
$$;

SELECT pg_temp.wp02_create_user('00000000-0000-4000-8000-000000020001', 'wp02-operator@example.invalid');
SELECT pg_temp.wp02_create_user('00000000-0000-4000-8000-000000020002', 'wp02-admin@example.invalid');
SELECT pg_temp.wp02_create_user('00000000-0000-4000-8000-000000020011', 'wp02-client-1@example.invalid');
SELECT pg_temp.wp02_create_user('00000000-0000-4000-8000-000000020012', 'wp02-client-2@example.invalid');
SELECT pg_temp.wp02_create_user('00000000-0000-4000-8000-000000020013', 'wp02-client-3@example.invalid');
SELECT pg_temp.wp02_create_user('00000000-0000-4000-8000-000000020014', 'wp02-client-4@example.invalid');
SELECT pg_temp.wp02_create_user('00000000-0000-4000-8000-000000020015', 'wp02-client-5@example.invalid');
SELECT pg_temp.wp02_create_user('00000000-0000-4000-8000-000000020016', 'wp02-client-6@example.invalid');

INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-4000-8000-000000020001', 'operator'),
  ('00000000-0000-4000-8000-000000020002', 'admin');

INSERT INTO public.operators (
  id, user_id, full_name, is_active, availability_status, presence_status, last_seen_at
) VALUES (
  '00000000-0000-4000-8000-000000020101',
  '00000000-0000-4000-8000-000000020001',
  'WP02 operator', TRUE, 'available', 'online', clock_timestamp()
);

INSERT INTO public.characters (id, name, is_active, is_visible, availability_status)
VALUES ('00000000-0000-4000-8000-000000020201', 'WP02 character', TRUE, TRUE, 'available');

INSERT INTO public.character_operator_assignments (character_id, operator_id)
VALUES ('00000000-0000-4000-8000-000000020201', '00000000-0000-4000-8000-000000020101');

INSERT INTO public.conversations (id, client_id, character_id, status)
SELECT
  ('00000000-0000-4000-8000-' || lpad((20300 + ordinal)::text, 12, '0'))::uuid,
  client_id,
  '00000000-0000-4000-8000-000000020201'::uuid,
  'open'::public.conversation_status
FROM unnest(ARRAY[
  '00000000-0000-4000-8000-000000020011'::uuid,
  '00000000-0000-4000-8000-000000020012'::uuid,
  '00000000-0000-4000-8000-000000020013'::uuid,
  '00000000-0000-4000-8000-000000020014'::uuid,
  '00000000-0000-4000-8000-000000020015'::uuid,
  '00000000-0000-4000-8000-000000020016'::uuid
]) WITH ORDINALITY AS clients(client_id, ordinal);

INSERT INTO public.messages (id, conversation_id, sender_type, sender_id, content, created_at)
SELECT
  ('00000000-0000-4000-8000-' || lpad((20400 + ordinal)::text, 12, '0'))::uuid,
  conversation.id,
  'client'::public.sender_type,
  conversation.client_id,
  'WP02 request ' || ordinal,
  clock_timestamp() - make_interval(secs => 70 - ordinal)
FROM (
  SELECT conversation.*, row_number() OVER (ORDER BY conversation.id)::integer AS ordinal
  FROM public.conversations conversation
  WHERE conversation.character_id = '00000000-0000-4000-8000-000000020201'
) conversation;

SELECT is(
  private.allocate_new_conversations(50),
  5,
  'Automatic allocation stops at the operator capacity of five'
);

SELECT is(
  (
    SELECT count(*) FROM public.conversation_handling_cycles cycle
    WHERE cycle.operator_id = '00000000-0000-4000-8000-000000020101'
      AND cycle.ended_at IS NULL
  ),
  5::bigint,
  'Exactly five active cycles are owned by the eligible operator'
);

SELECT is(
  (
    SELECT count(*) FROM public.conversation_work_items work_item
    WHERE work_item.character_id = '00000000-0000-4000-8000-000000020201'
      AND work_item.status = 'new'
  ),
  1::bigint,
  'The sixth request remains pending without an eligible operator below capacity'
);

SELECT is(
  (
    SELECT conversation.pending_since
    FROM public.conversations conversation
    JOIN public.conversation_work_items work_item ON work_item.conversation_id = conversation.id
    WHERE work_item.status = 'new'
  ),
  (
    SELECT min(message.created_at)
    FROM public.messages message
    JOIN public.conversation_work_items work_item ON work_item.last_client_message_id = message.id
    WHERE work_item.status = 'new'
  ),
  'A capacity wait preserves the canonical pending_since value'
);

-- A successful owner response clears needs_handling but leaves the cycle active.
SELECT set_config('wp02.owner_cycle', (
  SELECT cycle.id::text FROM public.conversation_handling_cycles cycle
  WHERE cycle.operator_id = '00000000-0000-4000-8000-000000020101'
    AND cycle.ended_at IS NULL
  ORDER BY cycle.started_at, cycle.id LIMIT 1
), true);
SELECT set_config('wp02.owner_conversation', (
  SELECT conversation_id::text FROM public.conversation_handling_cycles
  WHERE id = current_setting('wp02.owner_cycle')::uuid
), true);
SELECT ok(
  NULLIF(current_setting('wp02.owner_cycle'), '') IS NOT NULL
  AND NULLIF(current_setting('wp02.owner_conversation'), '') IS NOT NULL,
  'The selected owner cycle and conversation exist before the authenticated send'
);
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000020001';
SET LOCAL ROLE authenticated;
SELECT public.send_operator_message(
  current_setting('wp02.owner_conversation')::uuid,
  'WP02 owner response',
  current_setting('wp02.owner_cycle')::uuid
);
RESET ROLE;

SELECT is(
  (
    SELECT conversation.needs_handling
    FROM public.conversations conversation
    JOIN public.messages message ON message.conversation_id = conversation.id
    WHERE message.content = 'WP02 owner response'
  ),
  false,
  'The owner response clears needs_handling without ending the cycle'
);

SET LOCAL ROLE authenticated;
SELECT public.release_operator_conversation(
  (SELECT conversation_id FROM public.messages WHERE content = 'WP02 owner response'),
  'released'
);
RESET ROLE;

SELECT is(
  (
    SELECT count(*)
    FROM public.conversation_work_items work_item
    JOIN public.messages message ON message.conversation_id = work_item.conversation_id
    WHERE message.content = 'WP02 owner response' AND work_item.status = 'new'
  ),
  0::bigint,
  'Release with needs_handling false does not return the conversation to NEW'
);

-- A later Client message creates a new pending item and a release before response requeues it once.
INSERT INTO public.messages (conversation_id, sender_type, sender_id, content)
SELECT conversation.id, 'client', conversation.client_id, 'WP02 later client request'
FROM public.conversations conversation
JOIN public.messages message ON message.conversation_id = conversation.id
WHERE message.content = 'WP02 owner response';

-- Claim this request explicitly: automatic allocation correctly prefers the older sixth request.
SELECT set_config('wp02.later_work_item', (
  SELECT work_item.id::text FROM public.conversation_work_items work_item
  JOIN public.messages message ON message.id = work_item.last_client_message_id
    AND message.conversation_id = work_item.conversation_id
  WHERE message.content = 'WP02 later client request'
), true);
SELECT is((
  SELECT count(*) FROM public.conversation_work_items work_item
  JOIN public.conversations conversation ON conversation.id = work_item.conversation_id
  JOIN public.messages message ON message.id = work_item.last_client_message_id
  WHERE work_item.id = current_setting('wp02.later_work_item')::uuid
    AND work_item.status = 'new' AND work_item.responsible_operator_id IS NULL
    AND conversation.needs_handling IS TRUE AND conversation.pending_since = message.created_at
    AND conversation.inactivity_expires_at = message.created_at + interval '180 seconds'
    AND conversation.inactivity_expires_at > clock_timestamp()
    AND conversation.assigned_operator_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.conversation_handling_cycles active
                    WHERE active.conversation_id = conversation.id AND active.ended_at IS NULL)
), 1::bigint, 'The canonical later Client request is eligible before explicit claim');
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$SELECT public.claim_new_conversation(current_setting('wp02.later_work_item')::uuid)$$,
  'The newly pending conversation is explicitly claimed once capacity is available'
);
RESET ROLE;
SELECT is((
  SELECT count(*) FROM public.conversation_handling_cycles cycle
  JOIN public.conversation_work_items work_item ON work_item.id = cycle.work_item_id
  JOIN public.conversations conversation ON conversation.id = cycle.conversation_id
  WHERE cycle.work_item_id = current_setting('wp02.later_work_item')::uuid
    AND cycle.ended_at IS NULL
    AND cycle.operator_id = '00000000-0000-4000-8000-000000020101'
    AND work_item.responsible_operator_id = cycle.operator_id
    AND conversation.assigned_operator_id = cycle.operator_id
), 1::bigint, 'The canonical later request has exactly one active owned cycle');
SET LOCAL ROLE authenticated;
SELECT set_config('wp02.later_release', public.release_operator_conversation(
  current_setting('wp02.owner_conversation')::uuid, 'released'
)::text, true);
RESET ROLE;
SELECT ok(
  (current_setting('wp02.later_release')::jsonb->>'released')::boolean IS TRUE
  AND (current_setting('wp02.later_release')::jsonb->>'requeued')::boolean IS TRUE,
  'The live pending release actually releases and requeues the claimed request'
);

SELECT is(
  (
    SELECT count(*) FROM public.conversation_work_items work_item
    JOIN public.messages message ON message.conversation_id = work_item.conversation_id
    WHERE message.content = 'WP02 later client request' AND work_item.status = 'new'
  ),
  1::bigint,
  'Release with needs_handling true returns exactly one work item to NEW'
);

SELECT throws_like(
  $$SELECT public.admin_reassign_conversation(
    (SELECT conversation_id FROM public.messages WHERE content = 'WP02 later client request'),
    '00000000-0000-4000-8000-000000020101'::uuid
  )$$,
  'admin_transfer_reason_required',
  'The legacy Admin transfer signature cannot bypass a documented reason'
);

RESET ROLE;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000020002';
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$SELECT public.admin_reassign_conversation(
    (SELECT conversation_id FROM public.messages WHERE content = 'WP02 later client request'),
    '00000000-0000-4000-8000-000000020101'::uuid,
    'בדיקת העברה מפורשת'
  )$$,
  'An Admin transfer with a reason creates a documented cycle'
);
RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_logs audit
    WHERE audit.action = 'conversation.reassigned'
      AND audit.metadata->>'reason' = 'בדיקת העברה מפורשת'
  ),
  'The transfer audit preserves the explicit reason'
);

UPDATE public.operators
SET is_active = false
WHERE id = '00000000-0000-4000-8000-000000020101';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000020002';
SET LOCAL ROLE authenticated;
SELECT throws_like(
  $$SELECT public.admin_reassign_conversation(
    (SELECT conversation_id FROM public.messages WHERE content = 'WP02 later client request'),
    '00000000-0000-4000-8000-000000020101'::uuid,
    'בדיקת אימות מחדש'
  )$$,
  'operator_not_active',
  'A same-operator transfer still revalidates the target operator under the canonical lock order'
);
RESET ROLE;
UPDATE public.operators
SET is_active = true
WHERE id = '00000000-0000-4000-8000-000000020101';

-- Timeout candidates are snapshots only. The release path must bind the
-- selected cycle and re-check both server-side expiry causes while locked.
SELECT set_config(
  'wp02.race_cycle',
  (SELECT cycle.id::text FROM public.conversation_handling_cycles cycle
   WHERE cycle.ended_at IS NULL ORDER BY cycle.id LIMIT 1),
  true
);
SELECT set_config(
  'wp02.race_conversation',
  (SELECT cycle.conversation_id::text FROM public.conversation_handling_cycles cycle
   WHERE cycle.id = current_setting('wp02.race_cycle')::uuid),
  true
);

UPDATE public.conversations
SET inactivity_expires_at = clock_timestamp() + interval '3 minutes'
WHERE id = current_setting('wp02.race_conversation')::uuid;
UPDATE public.operators
SET last_seen_at = clock_timestamp(), presence_status = 'online'
WHERE id = '00000000-0000-4000-8000-000000020101';
SELECT is(
  (private.finish_handling_cycle(
    current_setting('wp02.race_conversation')::uuid,
    '00000000-0000-4000-8000-000000020101',
    'timeout', clock_timestamp(), current_setting('wp02.race_cycle')::uuid
  )->>'released')::boolean,
  false,
  'A newly stored business message expiry prevents release of the selected cycle'
);

UPDATE public.operators
SET last_seen_at = clock_timestamp() - interval '10 minutes', presence_status = 'online'
WHERE id = '00000000-0000-4000-8000-000000020101';
-- Simulate the heartbeat winning the operator-row lock before stale release.
UPDATE public.operators
SET last_seen_at = clock_timestamp(), presence_status = 'online'
WHERE id = '00000000-0000-4000-8000-000000020101';
SELECT is(
  (private.finish_handling_cycle(
    current_setting('wp02.race_conversation')::uuid,
    '00000000-0000-4000-8000-000000020101',
    'timeout', clock_timestamp(), current_setting('wp02.race_cycle')::uuid
  )->>'released')::boolean,
  false,
  'A refreshed heartbeat prevents stale release and offline marking'
);
SELECT is(
  (SELECT presence_status FROM public.operators
   WHERE id = '00000000-0000-4000-8000-000000020101'),
  'online',
  'A refreshed heartbeat remains online after stale candidate revalidation'
);

SELECT set_config('wp02.old_cycle', current_setting('wp02.race_cycle'), true);
UPDATE public.conversation_handling_cycles
SET ended_at = clock_timestamp(), end_reason = 'reassigned'
WHERE id = current_setting('wp02.old_cycle')::uuid;
SELECT is(
  (private.finish_handling_cycle(
    current_setting('wp02.race_conversation')::uuid,
    '00000000-0000-4000-8000-000000020101',
    'timeout', clock_timestamp(), current_setting('wp02.old_cycle')::uuid
  )->>'released')::boolean,
  false,
  'A missing current cycle is not reported as released'
);
WITH inserted AS (
  INSERT INTO public.conversation_handling_cycles (
    conversation_id, work_item_id, operator_id, started_at
  )
  SELECT cycle.conversation_id, cycle.work_item_id, cycle.operator_id, clock_timestamp()
  FROM public.conversation_handling_cycles cycle
  WHERE cycle.id = current_setting('wp02.old_cycle')::uuid
  RETURNING id
)
SELECT set_config('wp02.race_cycle', (SELECT id::text FROM inserted), true);
WITH expiry_anchor AS MATERIALIZED (SELECT clock_timestamp() AS observed_at)
UPDATE public.conversations AS conversation
SET last_business_message_at = expiry_anchor.observed_at - interval '2 seconds',
    inactivity_expires_at = expiry_anchor.observed_at - interval '1 second'
FROM expiry_anchor
WHERE conversation.id = current_setting('wp02.race_conversation')::uuid;
SELECT is(
  (private.finish_handling_cycle(
    current_setting('wp02.race_conversation')::uuid,
    '00000000-0000-4000-8000-000000020101',
    'timeout', clock_timestamp(), current_setting('wp02.old_cycle')::uuid
  )->>'released')::boolean,
  false,
  'A stale candidate cannot end a replacement cycle owned by the same operator'
);
SELECT is(
  (SELECT count(*) FROM public.conversation_handling_cycles
   WHERE id = current_setting('wp02.race_cycle')::uuid AND ended_at IS NULL),
  1::bigint,
  'The replacement handling cycle remains active'
);
SELECT is(
  (private.finish_handling_cycle(
    current_setting('wp02.race_conversation')::uuid,
    '00000000-0000-4000-8000-000000020101',
    'timeout', clock_timestamp(), current_setting('wp02.race_cycle')::uuid
  )->>'released')::boolean,
  true,
  'A genuinely expired current cycle is released once'
);
SELECT is(
  (private.finish_handling_cycle(
    current_setting('wp02.race_conversation')::uuid,
    '00000000-0000-4000-8000-000000020101',
    'timeout', clock_timestamp(), current_setting('wp02.race_cycle')::uuid
  )->>'released')::boolean,
  false,
  'A completed timeout cycle cannot be ended twice'
);

-- Independent automatic resume: share only the seeded Client identities.
-- This character has one eligible operator and no pre-existing work.
SELECT pg_temp.wp02_create_user('00000000-0000-4000-8000-000000029001', 'wp02-resume@example.invalid');
INSERT INTO public.user_roles (user_id, role)
VALUES ('00000000-0000-4000-8000-000000029001', 'operator');
INSERT INTO public.operators (id, user_id, full_name, is_active, availability_status, presence_status, last_seen_at)
VALUES ('00000000-0000-4000-8000-000000029101', '00000000-0000-4000-8000-000000029001',
        'WP02 resume operator', true, 'available', 'online', clock_timestamp());
INSERT INTO public.characters (id, name, is_active, is_visible, availability_status)
VALUES ('00000000-0000-4000-8000-000000029201', 'WP02 resume character', true, true, 'available');
INSERT INTO public.character_operator_assignments (character_id, operator_id)
VALUES ('00000000-0000-4000-8000-000000029201', '00000000-0000-4000-8000-000000029101');

INSERT INTO public.conversations (client_id, character_id, status)
SELECT id, '00000000-0000-4000-8000-000000029201', 'open' FROM auth.users
WHERE id BETWEEN '00000000-0000-4000-8000-000000020011' AND '00000000-0000-4000-8000-000000020016';
INSERT INTO public.messages (conversation_id, sender_type, sender_id, content, created_at)
SELECT id, 'client', client_id, 'WP02 auto-resume initial request', clock_timestamp()
FROM public.conversations
WHERE character_id = '00000000-0000-4000-8000-000000029201'
  AND client_id <> '00000000-0000-4000-8000-000000020016';
-- The allocator scans the global queue; measure this operator's own capacity.
SELECT private.allocate_new_conversations(50);
CREATE TEMP VIEW wp02_resume_load AS
SELECT count(*) AS active FROM public.conversation_handling_cycles
WHERE operator_id = '00000000-0000-4000-8000-000000029101' AND ended_at IS NULL;
SELECT is((SELECT active FROM wp02_resume_load), 5::bigint,
  'The resume operator is at capacity before the waiting Client request arrives');

INSERT INTO public.messages (conversation_id, sender_type, sender_id, content, created_at)
SELECT id, 'client', client_id, 'WP02 auto-resume waiting request', clock_timestamp()
FROM public.conversations
WHERE character_id = '00000000-0000-4000-8000-000000029201'
  AND client_id = '00000000-0000-4000-8000-000000020016';
SELECT private.allocate_new_conversations(50);
CREATE TEMP TABLE wp02_resume_pending ON COMMIT DROP AS
SELECT conversation.id AS conversation_id, work_item.id AS work_item_id, message.id AS message_id
FROM public.conversations conversation
JOIN public.messages message ON message.conversation_id = conversation.id
JOIN public.conversation_work_items work_item ON work_item.conversation_id = conversation.id
  AND work_item.last_client_message_id = message.id
WHERE conversation.character_id = '00000000-0000-4000-8000-000000029201'
  AND message.content = 'WP02 auto-resume waiting request'
  AND work_item.status = 'new' AND work_item.responsible_operator_id IS NULL
  AND conversation.assigned_operator_id IS NULL AND conversation.needs_handling IS TRUE
  AND conversation.pending_since = message.created_at AND conversation.inactivity_expires_at > clock_timestamp()
  AND NOT EXISTS (SELECT 1 FROM public.conversation_handling_cycles cycle WHERE cycle.conversation_id = conversation.id);
SELECT is((SELECT count(*) FROM wp02_resume_pending), 1::bigint,
  'At capacity the actual waiting message has one unowned NEW item and no handling cycle');

-- Capture the serving owner's token before switching to the authenticated role.
SELECT set_config('wp02.resume_owner_cycle', cycle.id::text, true),
       set_config('wp02.resume_owner_conversation', cycle.conversation_id::text, true)
FROM public.conversation_handling_cycles cycle
WHERE cycle.operator_id = '00000000-0000-4000-8000-000000029101' AND cycle.ended_at IS NULL
ORDER BY cycle.started_at, cycle.id LIMIT 1;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000029001';
SET LOCAL ROLE authenticated;
SELECT public.send_operator_message(current_setting('wp02.resume_owner_conversation')::uuid,
  'WP02 auto-resume owner response', current_setting('wp02.resume_owner_cycle')::uuid);
SELECT set_config('wp02.resume_release', public.release_operator_conversation(
  current_setting('wp02.resume_owner_conversation')::uuid, 'released')::text, true);
RESET ROLE;
SELECT ok(current_setting('wp02.resume_release')::jsonb @> jsonb_build_object(
  'released', true, 'requeued', false, 'cycle_id', current_setting('wp02.resume_owner_cycle')),
  'The owner really released the answered cycle without creating another pending request');
SELECT is((SELECT active FROM wp02_resume_load), 4::bigint,
  'Exactly one operator slot is open before automatic allocation resumes');

SELECT is(private.allocate_new_conversations(50), 1, 'Automatic allocation resumes when the slot opens');
SELECT is((
  SELECT count(*) FROM wp02_resume_pending pending
  JOIN public.conversation_work_items work_item ON work_item.id = pending.work_item_id
    AND work_item.conversation_id = pending.conversation_id AND work_item.last_client_message_id = pending.message_id
  JOIN public.conversations conversation ON conversation.id = pending.conversation_id
  JOIN public.conversation_handling_cycles cycle ON cycle.conversation_id = conversation.id
    AND cycle.work_item_id = work_item.id
  WHERE work_item.status = 'assigned' AND cycle.ended_at IS NULL
    AND cycle.operator_id = '00000000-0000-4000-8000-000000029101'
    AND cycle.operator_id = work_item.responsible_operator_id AND conversation.assigned_operator_id = cycle.operator_id
), 1::bigint, 'The freed slot serves the same waiting item and message in one correctly owned active cycle');

SELECT is(private.allocate_new_conversations(50), 0, 'A repeat allocation finds no further assignment');
SELECT ok((SELECT active FROM wp02_resume_load) = 5 AND (
  SELECT (SELECT count(*) FROM public.conversation_work_items WHERE conversation_id = pending.conversation_id) = 1
     AND (SELECT count(*) FROM public.conversation_handling_cycles WHERE conversation_id = pending.conversation_id) = 1
  FROM wp02_resume_pending pending
), 'After retry the operator is full and the waiting conversation has no duplicate item or cycle');
SELECT is((
  SELECT count(*) FROM public.audit_logs audit
  JOIN wp02_resume_pending pending ON audit.entity_id = pending.conversation_id::text
  JOIN public.conversation_handling_cycles cycle ON cycle.conversation_id = pending.conversation_id
    AND cycle.work_item_id = pending.work_item_id AND cycle.ended_at IS NULL
  WHERE audit.action = 'conversation.auto_assigned' AND audit.entity_type = 'conversation' AND audit.actor_user_id IS NULL
    AND audit.metadata->>'cycle_id' = cycle.id::text AND audit.metadata->>'operator_id' = cycle.operator_id::text
    AND cycle.operator_id = '00000000-0000-4000-8000-000000029101'
), 1::bigint, 'Exactly one automatic audit names the waiting conversation, its live cycle and its operator');

SELECT * FROM finish();
ROLLBACK;
