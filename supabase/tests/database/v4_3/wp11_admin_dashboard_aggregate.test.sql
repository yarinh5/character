BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT no_plan();

SELECT has_function(
  'public', 'get_admin_dashboard_analytics_for_server',
  ARRAY['timestamp with time zone', 'timestamp with time zone', 'date[]']
);
SELECT ok(
  NOT prosecdef AND provolatile = 's',
  'The dashboard aggregate is invoker-security and stable'
)
FROM pg_proc
WHERE oid = 'public.get_admin_dashboard_analytics_for_server(timestamptz,timestamptz,date[])'::regprocedure;
SELECT ok(
  NOT has_function_privilege(
    'public', 'public.get_admin_dashboard_analytics_for_server(timestamptz,timestamptz,date[])', 'EXECUTE'
  ),
  'PUBLIC cannot execute the dashboard aggregate'
);

SET LOCAL ROLE anon;
-- The pinned local backend lost its session on a denied invocation. Measure the
-- effective permission under the real roles without calling a forbidden RPC.
SELECT ok(
  current_user = 'anon' AND NOT has_function_privilege(
    current_user, 'public.get_admin_dashboard_analytics_for_server(timestamptz,timestamptz,date[])', 'EXECUTE'
  ),
  'Anon has no effective permission to execute the dashboard aggregate'
);
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT ok(
  current_user = 'authenticated' AND NOT has_function_privilege(
    current_user, 'public.get_admin_dashboard_analytics_for_server(timestamptz,timestamptz,date[])', 'EXECUTE'
  ),
  'Authenticated callers have no effective permission to execute the dashboard aggregate'
);
RESET ROLE;

INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-000000112001', 'authenticated', 'authenticated', 'wp11-dash-client@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000112002', 'authenticated', 'authenticated', 'wp11-dash-operator-a@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000112003', 'authenticated', 'authenticated', 'wp11-dash-operator-b@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000112004', 'authenticated', 'authenticated', 'wp11-dash-history@example.invalid', '{}', '{}');

UPDATE public.profiles SET created_at = '2026-03-19 22:00Z', display_name = NULL
WHERE user_id = '00000000-0000-4000-8000-000000112001';
UPDATE public.profiles SET created_at = '2026-03-19 21:59:59.999Z', display_name = 'Operator A profile'
WHERE user_id = '00000000-0000-4000-8000-000000112002';
UPDATE public.profiles SET created_at = '2026-03-19 21:59:59.999Z', display_name = 'Operator B profile'
WHERE user_id = '00000000-0000-4000-8000-000000112003';
UPDATE public.profiles SET created_at = '2026-03-19 21:59:59.999Z'
WHERE user_id = '00000000-0000-4000-8000-000000112004';

INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-4000-8000-000000112002', 'operator'),
  ('00000000-0000-4000-8000-000000112003', 'operator');
INSERT INTO public.operators (id, user_id, full_name, availability_status, is_active) VALUES
  ('00000000-0000-4000-8000-000000112101', '00000000-0000-4000-8000-000000112002', 'Operator A wallet', 'available', true),
  ('00000000-0000-4000-8000-000000112102', '00000000-0000-4000-8000-000000112003', 'Operator B wallet', 'offline', false);
INSERT INTO public.operator_point_wallets (operator_id, balance) VALUES
  ('00000000-0000-4000-8000-000000112101', 20),
  ('00000000-0000-4000-8000-000000112102', 20);
INSERT INTO public.credit_wallets (user_id, balance) VALUES
  ('00000000-0000-4000-8000-000000112001', 2),
  ('00000000-0000-4000-8000-000000112004', 5)
ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance;

INSERT INTO public.characters (id, name)
SELECT ('00000000-0000-4000-8000-00000011220' || n)::uuid, 'Dashboard character ' || n
FROM generate_series(1, 6) AS series(n);
INSERT INTO public.conversations (id, client_id, character_id, assigned_operator_id, created_at) VALUES
  ('00000000-0000-4000-8000-000000112301', '00000000-0000-4000-8000-000000112001',
   '00000000-0000-4000-8000-000000112201', '00000000-0000-4000-8000-000000112101', '2026-03-19 22:00Z'),
  ('00000000-0000-4000-8000-000000112302', '00000000-0000-4000-8000-000000112004',
   '00000000-0000-4000-8000-000000112201', '00000000-0000-4000-8000-000000112102', '2026-03-19 21:59:59.999Z');
INSERT INTO public.conversations (client_id, character_id, created_at)
SELECT '00000000-0000-4000-8000-000000112001',
  ('00000000-0000-4000-8000-00000011220' || n)::uuid, '2026-03-18 00:00Z'
FROM generate_series(2, 6) AS series(n);

-- Insert the tie in reverse id order. The three eligible responses are 4s, 0s and
-- 1s, including the two recent messages outside the final chart bucket.
WITH fixture(id, thread, sender, sender_id, operator_id, at) AS (
  VALUES
    (1, 1, 'client',   1, NULL, '2026-03-19 21:59:59.999Z'),
    (2, 1, 'operator', 2, 1,    '2026-03-19 22:00:00Z'),
    (3, 1, 'client',   1, NULL, '2026-03-20 00:00:00Z'),
    (4, 1, 'client',   1, NULL, '2026-03-20 00:00:04Z'),
    (5, 1, 'system',   NULL, NULL, '2026-03-20 00:00:05Z'),
    (6, 1, 'operator', 2, 1,    '2026-03-20 00:00:08Z'),
    (7, 1, 'operator', 2, 1,    '2026-03-20 00:00:09Z'),
    (9, 1, 'operator', 2, 1,    '2026-03-20 00:00:10Z'),
    (8, 1, 'client',   1, NULL, '2026-03-20 00:00:10Z'),
    (10, 2, 'client',   4, NULL, '2026-04-02 00:00:00Z'),
    (11, 2, 'operator', 3, 2,    '2026-04-02 00:00:01Z'),
    (12, 1, 'client',   1, NULL, '2026-04-02 00:00:10Z')
)
INSERT INTO public.messages (id, conversation_id, sender_type, sender_id, operator_id, content, created_at)
SELECT ('00000000-0000-4000-8000-0000001124' || lpad(id::text, 2, '0'))::uuid,
  ('00000000-0000-4000-8000-00000011230' || thread)::uuid, sender::public.sender_type,
  ('00000000-0000-4000-8000-00000011200' || sender_id)::uuid,
  ('00000000-0000-4000-8000-00000011210' || operator_id)::uuid, 'Dashboard fixture', at::timestamptz
FROM fixture;
INSERT INTO public.messages (conversation_id, sender_type, sender_id, operator_id, content, created_at)
SELECT '00000000-0000-4000-8000-000000112301', 'operator', '00000000-0000-4000-8000-000000112002',
  '00000000-0000-4000-8000-000000112101', 'Dashboard bulk fixture', '2026-03-20 02:00Z'
FROM generate_series(1, 10001);

INSERT INTO public.credit_transactions (user_id, amount, balance_after, type, created_at)
SELECT '00000000-0000-4000-8000-000000112001', ledger.amount, 2, ledger.type, '2026-03-18 00:00Z'
FROM generate_series(1, 10001)
CROSS JOIN (VALUES (-2, 'message_spend'), (3, 'admin_adjustment')) AS ledger(amount, type);
INSERT INTO public.credit_transactions (user_id, amount, balance_after, type) VALUES
  ('00000000-0000-4000-8000-000000112001', -5, 2, 'admin_adjustment'),
  ('00000000-0000-4000-8000-000000112001', 9, 2, 'package_purchase');

INSERT INTO public.operator_point_transactions (operator_id, amount, balance_after, event_type, reason, created_at)
SELECT '00000000-0000-4000-8000-000000112101', 1.5, 20, 'response_reward', 'Dashboard fixture', '2026-03-31 21:00Z'
FROM generate_series(1, 10001);
INSERT INTO public.operator_point_transactions (operator_id, amount, balance_after, event_type, reason, created_at) VALUES
  ('00000000-0000-4000-8000-000000112101', 777, 20, 'admin_adjustment', 'Dashboard before month', '2026-03-31 20:59:59.999Z'),
  ('00000000-0000-4000-8000-000000112101', -7, 20, 'correction', 'Dashboard debit', '2026-04-01 00:00Z'),
  ('00000000-0000-4000-8000-000000112101', 2.25, 20, 'admin_adjustment', 'Dashboard positive non-response', '2026-04-01 00:00Z');

CREATE TEMP TABLE wp11_dashboard_snapshot (payload jsonb NOT NULL) ON COMMIT DROP;
GRANT INSERT ON wp11_dashboard_snapshot TO service_role;
SET LOCAL TIME ZONE 'Asia/Jerusalem';
SET LOCAL ROLE service_role;
INSERT INTO wp11_dashboard_snapshot
SELECT public.get_admin_dashboard_analytics_for_server(
  '2026-03-19 22:00Z', '2026-03-31 21:00Z',
  ARRAY(SELECT date '2026-03-19' + n FROM generate_series(0, 13) AS days(n) ORDER BY n)
);
RESET ROLE;

SELECT is(payload -> 'totalCreditsSpent', '20007'::jsonb, 'All debits, including the negative adjustment, are summed')
FROM wp11_dashboard_snapshot;
SELECT is(payload -> 'manualCreditsAdded', '30003'::jsonb, 'Only positive manual additions are summed across all rows')
FROM wp11_dashboard_snapshot;
SELECT is(payload -> 'clientMessages', '6'::jsonb, 'All-time client count includes the message before the cutoff')
FROM wp11_dashboard_snapshot;
SELECT is(payload -> 'operatorMessages', '10006'::jsonb, 'All-time operator count is not truncated')
FROM wp11_dashboard_snapshot;
SELECT is(payload -> 'avgResponseSec', '2'::jsonb, 'Latest pending client to first operator, including timestamp ties')
FROM wp11_dashboard_snapshot;
SELECT is(
  payload -> 'days',
  (
    SELECT jsonb_agg(jsonb_build_object(
      'date', date '2026-03-19' + n,
      'conversations', CASE WHEN n = 0 THEN 1 ELSE 0 END,
      'users', CASE WHEN n = 0 THEN 1 ELSE 0 END,
      'messages', CASE n WHEN 0 THEN 1 WHEN 1 THEN 10008 ELSE 0 END
    ) ORDER BY n)
    FROM generate_series(0, 13) AS days(n)
  ),
  'Exactly 14 ordered UTC keys, inclusive JS cutoff, all sender types and explicit zero buckets'
) FROM wp11_dashboard_snapshot;
SELECT is(
  payload -> 'topOperators',
  '[{"name":"Operator A profile","count":10005},{"name":"Operator B profile","count":1}]'::jsonb,
  'Message rank uses the complete recent source and profile names'
) FROM wp11_dashboard_snapshot;
SELECT is(
  payload -> 'topCharacters',
  '[{"name":"Dashboard character 1","count":2},{"name":"Dashboard character 2","count":1},
    {"name":"Dashboard character 3","count":1},{"name":"Dashboard character 4","count":1},
    {"name":"Dashboard character 5","count":1}]'::jsonb,
  'Character rank uses all-time conversations, then limits to the existing top five'
) FROM wp11_dashboard_snapshot;
SELECT is(
  payload -> 'topOperatorsByAvailablePoints',
  '[{"id":"00000000-0000-4000-8000-000000112101","name":"Operator A wallet","availablePoints":20,
     "monthlyPayouts":15003.75,"messages":10001,"status":"available","isActive":true},
    {"id":"00000000-0000-4000-8000-000000112102","name":"Operator B wallet","availablePoints":20,
     "monthlyPayouts":0,"messages":0,"status":"offline","isActive":false}]'::jsonb,
  'Point balances are distinct from monthly positive points and reward count; payouts break balance ties'
) FROM wp11_dashboard_snapshot;
SELECT is(
  payload -> 'lowBalanceUsers',
  '[{"userId":"00000000-0000-4000-8000-000000112001","name":"wp11-dash-client@example.invalid",
     "email":"wp11-dash-client@example.invalid","balance":2}]'::jsonb,
  'Low-balance threshold, name fallback and existing PII shape are preserved'
) FROM wp11_dashboard_snapshot;

TRUNCATE wp11_dashboard_snapshot;
SET LOCAL ROLE service_role;
INSERT INTO wp11_dashboard_snapshot
SELECT public.get_admin_dashboard_analytics_for_server(
  '2026-03-19 22:00Z', '2026-03-31 21:00Z',
  ARRAY(SELECT date '2026-03-19' + greatest(n - 1, 0) FROM generate_series(0, 13) AS days(n) ORDER BY n)
);
RESET ROLE;
SELECT is(
  payload -> 'days' -> 1,
  '{"date":"2026-03-19","conversations":0,"users":0,"messages":0}'::jsonb,
  'Repeated JS day keys retain a second bucket without double counting'
) FROM wp11_dashboard_snapshot;

SELECT * FROM finish();
ROLLBACK;
