BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT no_plan();

SELECT has_function(
  'public',
  'get_admin_advanced_analytics_for_server',
  ARRAY['date', 'date'],
  'The bounded server analytics aggregate is installed'
);
-- PUBLIC is represented by grantee zero, not a role pgTAP can look up.
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(proc.proacl, pg_catalog.acldefault('f', proc.proowner))
    ) AS privilege
    WHERE proc.oid = 'public.get_admin_advanced_analytics_for_server(date,date)'::regprocedure
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  ),
  'PUBLIC cannot execute the privileged analytics aggregate'
);
SELECT function_privs_are(
  'public',
  'get_admin_advanced_analytics_for_server',
  ARRAY['date', 'date'],
  'anon',
  ARRAY[]::text[],
  'Anonymous clients cannot execute the privileged analytics aggregate'
);
SELECT function_privs_are(
  'public',
  'get_admin_advanced_analytics_for_server',
  ARRAY['date', 'date'],
  'authenticated',
  ARRAY[]::text[],
  'Authenticated clients cannot execute the privileged analytics aggregate'
);
SELECT function_privs_are(
  'public',
  'get_admin_advanced_analytics_for_server',
  ARRAY['date', 'date'],
  'service_role',
  ARRAY['EXECUTE'],
  'Only the server service role can execute the privileged analytics aggregate'
);

SELECT is(
  jsonb_array_length(
    public.get_admin_advanced_analytics_for_server('2026-01-01', '2026-06-29') -> 'days'
  ),
  180,
  'A 180-day inclusive range produces exactly 180 buckets'
);
SELECT throws_like(
  $$SELECT public.get_admin_advanced_analytics_for_server('2026-01-01', '2026-06-30')$$,
  '%invalid_analytics_date_range%',
  'A 181-day inclusive range is rejected instead of truncated'
);
SELECT throws_like(
  $$SELECT public.get_admin_advanced_analytics_for_server('2026-03-31', '2026-03-30')$$,
  '%invalid_analytics_date_range%',
  'A reversed range is rejected'
);

-- handle_new_user creates profiles, the client role, and client_profiles. The
-- fixture adds only the two operator roles and updates generated profile rows.
INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('00000000-0000-4000-8000-000000111001', 'authenticated', 'authenticated', 'wp11-client@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000111002', 'authenticated', 'authenticated', 'wp11-operator-a@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000111003', 'authenticated', 'authenticated', 'wp11-operator-b@example.invalid', 'x', now(), '{}', '{}', now(), now());

INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-4000-8000-000000111002', 'operator'),
  ('00000000-0000-4000-8000-000000111003', 'operator');

UPDATE public.profiles
SET display_name = CASE user_id
      WHEN '00000000-0000-4000-8000-000000111001' THEN 'WP11 Client'
      WHEN '00000000-0000-4000-8000-000000111002' THEN 'WP11 Operator A'
      WHEN '00000000-0000-4000-8000-000000111003' THEN 'WP11 Operator B'
    END,
    created_at = CASE user_id
      WHEN '00000000-0000-4000-8000-000000111001' THEN '2026-03-29T00:00:00.000Z'::timestamptz
      ELSE '2026-03-28T23:59:59.999Z'::timestamptz
    END
WHERE user_id IN (
  '00000000-0000-4000-8000-000000111001',
  '00000000-0000-4000-8000-000000111002',
  '00000000-0000-4000-8000-000000111003'
);
SELECT is(
  (SELECT count(*) FROM public.profiles WHERE user_id::text LIKE '00000000-0000-4000-8000-00000011100%'),
  3::bigint,
  'The user trigger created all three fixture profiles before they were updated'
);

INSERT INTO public.operators (id, user_id, full_name, is_active, availability_status) VALUES
  ('00000000-0000-4000-8000-000000111101', '00000000-0000-4000-8000-000000111002', 'WP11 Operator A', true, 'available'),
  ('00000000-0000-4000-8000-000000111102', '00000000-0000-4000-8000-000000111003', 'WP11 Operator B', true, 'available');

INSERT INTO public.characters (id, name) VALUES
  ('00000000-0000-4000-8000-000000111201', 'WP11 Character A'),
  ('00000000-0000-4000-8000-000000111202', 'WP11 Character B');

-- Write the older conversations and their messages before closing each pair.
-- A message trigger can reopen a closed conversation, so seeding both generations
-- before inserting the older messages violates the active-pair constraint.
INSERT INTO public.conversations (
  id, client_id, character_id, assigned_operator_id, status, created_at
) VALUES
  ('00000000-0000-4000-8000-000000111301', '00000000-0000-4000-8000-000000111001', '00000000-0000-4000-8000-000000111201', '00000000-0000-4000-8000-000000111101', 'open', '2026-03-29T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000111303', '00000000-0000-4000-8000-000000111001', '00000000-0000-4000-8000-000000111202', '00000000-0000-4000-8000-000000111102', 'open', '2026-03-31T23:59:59.999Z');

INSERT INTO public.messages (
  id, conversation_id, sender_type, sender_id, operator_id, content, created_at
) VALUES
  ('00000000-0000-4000-8000-000000111401', '00000000-0000-4000-8000-000000111301', 'client', '00000000-0000-4000-8000-000000111001', NULL, 'WP11 client boundary', '2026-03-29T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000111402', '00000000-0000-4000-8000-000000111301', 'operator', '00000000-0000-4000-8000-000000111002', '00000000-0000-4000-8000-000000111101', 'WP11 operator A one', '2026-03-29T01:00:00.000Z'),
  ('00000000-0000-4000-8000-000000111404', '00000000-0000-4000-8000-000000111303', 'operator', '00000000-0000-4000-8000-000000111003', '00000000-0000-4000-8000-000000111102', 'WP11 operator B', '2026-03-31T18:00:00.000Z');

UPDATE public.conversations SET status = 'closed'
WHERE id IN ('00000000-0000-4000-8000-000000111301', '00000000-0000-4000-8000-000000111303');

INSERT INTO public.conversations (
  id, client_id, character_id, assigned_operator_id, status, created_at
) VALUES
  ('00000000-0000-4000-8000-000000111302', '00000000-0000-4000-8000-000000111001', '00000000-0000-4000-8000-000000111201', '00000000-0000-4000-8000-000000111101', 'open', '2026-03-31T12:00:00.000Z'),
  ('00000000-0000-4000-8000-000000111304', '00000000-0000-4000-8000-000000111001', '00000000-0000-4000-8000-000000111202', '00000000-0000-4000-8000-000000111102', 'open', '2026-04-01T00:00:00.000Z');

INSERT INTO public.messages (
  id, conversation_id, sender_type, sender_id, operator_id, content, created_at
) VALUES
  ('00000000-0000-4000-8000-000000111403', '00000000-0000-4000-8000-000000111302', 'operator', '00000000-0000-4000-8000-000000111002', '00000000-0000-4000-8000-000000111101', 'WP11 operator A two', '2026-03-31T23:59:59.999Z'),
  ('00000000-0000-4000-8000-000000111405', '00000000-0000-4000-8000-000000111304', 'client', '00000000-0000-4000-8000-000000111001', NULL, 'WP11 excluded client', '2026-04-01T00:00:00.000Z');

-- Preserve the canonical event writers. Move only the events created by the
-- fixture's real conversation/message inserts into the deterministic window.
UPDATE public.analytics_events event
SET created_at = conversation.created_at
FROM public.conversations conversation
WHERE event.event_name = 'conversation_started'
  AND event.conversation_id = conversation.id
  AND conversation.id IN (
    '00000000-0000-4000-8000-000000111301',
    '00000000-0000-4000-8000-000000111302',
    '00000000-0000-4000-8000-000000111303'
  );
UPDATE public.analytics_events event
SET created_at = message.created_at
FROM public.messages message
WHERE event.event_name IN ('client_message_sent', 'operator_message_sent', 'first_message_sent')
  AND event.metadata ->> 'message_id' = message.id::text
  AND message.id IN (
    '00000000-0000-4000-8000-000000111401',
    '00000000-0000-4000-8000-000000111402',
    '00000000-0000-4000-8000-000000111403',
    '00000000-0000-4000-8000-000000111404'
  );

INSERT INTO public.analytics_events (
  event_name, actor_user_id, role, conversation_id, character_id, operator_id, created_at
) VALUES
  ('signup_completed', '00000000-0000-4000-8000-000000111001', 'client', NULL, NULL, NULL, '2026-03-29T02:00:00.000Z'),
  ('signup_completed', '00000000-0000-4000-8000-000000111002', 'operator', NULL, NULL, '00000000-0000-4000-8000-000000111101', '2026-03-31T02:00:00.000Z'),
  ('onboarding_completed', '00000000-0000-4000-8000-000000111001', 'client', NULL, NULL, NULL, '2026-03-29T02:10:00.000Z'),
  ('character_viewed', '00000000-0000-4000-8000-000000111001', 'client', NULL, '00000000-0000-4000-8000-000000111201', NULL, '2026-03-29T03:00:00.000Z'),
  ('character_viewed', '00000000-0000-4000-8000-000000111001', 'client', NULL, '00000000-0000-4000-8000-000000111201', NULL, '2026-03-29T03:01:00.000Z'),
  ('character_viewed', '00000000-0000-4000-8000-000000111001', 'client', NULL, '00000000-0000-4000-8000-000000111201', NULL, '2026-03-31T03:02:00.000Z'),
  ('character_viewed', '00000000-0000-4000-8000-000000111001', 'client', NULL, '00000000-0000-4000-8000-000000111202', NULL, '2026-03-31T03:03:00.000Z'),
  ('insufficient_credits_shown', '00000000-0000-4000-8000-000000111001', 'client', '00000000-0000-4000-8000-000000111301', '00000000-0000-4000-8000-000000111201', NULL, '2026-03-29T05:00:00.000Z'),
  ('insufficient_credits_shown', '00000000-0000-4000-8000-000000111001', 'client', '00000000-0000-4000-8000-000000111302', '00000000-0000-4000-8000-000000111201', NULL, '2026-03-31T05:00:00.000Z'),
  ('insufficient_credits_shown', '00000000-0000-4000-8000-000000111001', 'client', '00000000-0000-4000-8000-000000111303', '00000000-0000-4000-8000-000000111202', NULL, '2026-03-31T05:01:00.000Z'),
  ('packages_viewed', '00000000-0000-4000-8000-000000111001', 'client', NULL, NULL, NULL, '2026-04-01T00:00:00.000Z');

-- The expected 10,001 count is independent of implementation and proves that
-- the live aggregate cannot be accepted if a historical 10,000-row cap returns.
INSERT INTO public.analytics_events (event_name, role, created_at)
SELECT 'packages_viewed', 'client', '2026-03-29T06:00:00.000Z'::timestamptz
FROM generate_series(1, 10001);

INSERT INTO public.credit_transactions (
  id, user_id, amount, balance_after, type, reason, created_at
) VALUES
  ('00000000-0000-4000-8000-000000111501', '00000000-0000-4000-8000-000000111001', -7, 93, 'message_spend', 'WP11 in-range burn one', '2026-03-29T07:00:00.000Z'),
  ('00000000-0000-4000-8000-000000111502', '00000000-0000-4000-8000-000000111001', -13, 80, 'message_spend', 'WP11 in-range burn two', '2026-03-31T07:00:00.000Z'),
  ('00000000-0000-4000-8000-000000111503', '00000000-0000-4000-8000-000000111001', -99, 0, 'message_spend', 'WP11 excluded burn', '2026-04-01T00:00:00.000Z');

INSERT INTO public.operator_point_transactions (
  id, operator_id, amount, balance_after, event_type, reason, created_at
) VALUES
  ('00000000-0000-4000-8000-000000111601', '00000000-0000-4000-8000-000000111101', 20, 20, 'admin_adjustment', 'WP11 operator A', '2026-03-29T08:00:00.000Z'),
  ('00000000-0000-4000-8000-000000111602', '00000000-0000-4000-8000-000000111102', 10, 10, 'admin_adjustment', 'WP11 operator B', '2026-03-31T08:00:00.000Z'),
  ('00000000-0000-4000-8000-000000111603', '00000000-0000-4000-8000-000000111102', 1000, 1010, 'admin_adjustment', 'WP11 excluded points', '2026-04-01T00:00:00.000Z');

CREATE TEMP TABLE wp11_analytics_snapshots (
  timezone_name text PRIMARY KEY,
  payload jsonb NOT NULL
) ON COMMIT DROP;

SET LOCAL TIME ZONE 'UTC';
INSERT INTO wp11_analytics_snapshots VALUES (
  'UTC', public.get_admin_advanced_analytics_for_server('2026-03-29', '2026-03-31')
);
SET LOCAL TIME ZONE 'Asia/Jerusalem';
INSERT INTO wp11_analytics_snapshots VALUES (
  'Asia/Jerusalem', public.get_admin_advanced_analytics_for_server('2026-03-29', '2026-03-31')
);
SET LOCAL TIME ZONE 'America/Los_Angeles';
INSERT INTO wp11_analytics_snapshots VALUES (
  'America/Los_Angeles', public.get_admin_advanced_analytics_for_server('2026-03-29', '2026-03-31')
);

SELECT is(
  (SELECT payload FROM wp11_analytics_snapshots WHERE timezone_name = 'Asia/Jerusalem'),
  (SELECT payload FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC'),
  'The analytics result is unchanged in the Asia/Jerusalem session timezone'
);
SELECT is(
  (SELECT payload FROM wp11_analytics_snapshots WHERE timezone_name = 'America/Los_Angeles'),
  (SELECT payload FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC'),
  'The analytics result is unchanged in the America/Los_Angeles session timezone'
);

SELECT is(
  ((SELECT payload FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC') #>> '{kpis,newUsers}')::integer,
  1,
  'Only the profile at the inclusive UTC start boundary is counted'
);
SELECT is(
  ((SELECT payload FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC') #>> '{kpis,conversationsStarted}')::integer,
  3,
  'Only the three in-range conversations are counted'
);
SELECT is(
  ((SELECT payload FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC') #>> '{kpis,clientMessages}')::integer,
  1,
  'The message at the inclusive UTC start boundary is counted'
);
SELECT is(
  ((SELECT payload FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC') #>> '{kpis,operatorMessages}')::integer,
  3,
  'All in-range operator messages are counted'
);
SELECT is(
  ((SELECT payload FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC') #>> '{kpis,characterViews}')::integer,
  4,
  'Character view KPI matches the known fixture'
);
SELECT is(
  ((SELECT payload FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC') #>> '{kpis,packagesViewed}')::integer,
  10001,
  'The database aggregate includes all rows above the historical 10,000-row cap'
);
SELECT is(
  ((SELECT payload FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC') #>> '{kpis,insufficientCredits}')::integer,
  3,
  'Insufficient-credit events match the known fixture'
);
SELECT is(
  ((SELECT payload FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC') #>> '{kpis,creditsBurn}')::integer,
  20,
  'Credit burn sums absolute in-range debits and excludes the end boundary'
);

SELECT is(
  jsonb_array_length((SELECT payload -> 'days' FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC')),
  3,
  'The requested three-day range returns three ordered daily buckets'
);
SELECT is(
  (SELECT payload -> 'days' -> 0 FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC'),
  '{"date":"2026-03-29","signups":1,"conversations":1,"clientMessages":1,"operatorMessages":1,"events":10010}'::jsonb,
  'The inclusive first UTC day aggregates every known source independently'
);
SELECT is(
  (SELECT payload -> 'days' -> 1 FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC'),
  '{"date":"2026-03-30","signups":0,"conversations":0,"clientMessages":0,"operatorMessages":0,"events":0}'::jsonb,
  'A day without source rows is retained as an explicit zero bucket'
);
SELECT is(
  (SELECT payload -> 'days' -> 2 FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC'),
  '{"date":"2026-03-31","signups":0,"conversations":2,"clientMessages":0,"operatorMessages":2,"events":9}'::jsonb,
  'The inclusive final UTC day includes its last millisecond and known source totals'
);
SELECT is(
  ((SELECT payload FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC') #>> '{funnel,0,count}')::integer,
  2,
  'The signup funnel count matches the independent fixture'
);
SELECT is(
  ((SELECT payload FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC') #>> '{funnel,1,count}')::integer,
  1,
  'The onboarding funnel count matches the independent fixture'
);
SELECT is(
  ((SELECT payload FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC') #>> '{funnel,2,count}')::integer,
  4,
  'The character-view funnel count matches the independent fixture'
);
SELECT is(
  ((SELECT payload FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC') #>> '{funnel,3,count}')::integer,
  3,
  'Canonical conversation-created events populate the conversation funnel'
);
SELECT is(
  ((SELECT payload FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC') #>> '{funnel,4,count}')::integer,
  1,
  'The canonical first-message event populates the first-message funnel once'
);
SELECT is(
  ((SELECT payload FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC') #>> '{funnel,5,count}')::integer,
  10001,
  'The package-view funnel count includes more than 10,000 source rows'
);
SELECT is(
  (SELECT payload #>> '{topCharacters,0,id}' FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC'),
  '00000000-0000-4000-8000-000000111201',
  'Character ranking combines known conversation and view totals'
);
SELECT is(
  (SELECT payload #>> '{topCharacters,0,conversations}' FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC'),
  '2',
  'Top character conversation total is correct'
);
SELECT is(
  (SELECT payload #>> '{topCharacters,0,views}' FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC'),
  '3',
  'Top character view total is correct'
);
SELECT is(
  (SELECT payload #>> '{topOperators,0,id}' FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC'),
  '00000000-0000-4000-8000-000000111101',
  'Operator ranking combines known message and positive-point totals'
);
SELECT is(
  (SELECT payload #>> '{topOperators,0,messages}' FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC'),
  '2',
  'Top operator message total is correct'
);
SELECT is(
  (SELECT (payload #>> '{topOperators,0,points}')::numeric FROM wp11_analytics_snapshots WHERE timezone_name = 'UTC'),
  20::numeric,
  'Top operator point total is correct and excludes the end boundary'
);

SELECT * FROM finish();
ROLLBACK;
