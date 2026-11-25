BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT no_plan();

SELECT has_column('public', 'support_tickets', 'first_response_target_at', 'ticket stores its first-response target');
SELECT has_column('public', 'support_tickets', 'first_human_response_at', 'ticket stores the first human response once');
SELECT has_column('public', 'support_tickets', 'first_response_within_target', 'ticket stores the authoritative outcome');
SELECT has_function(
  'public', 'admin_set_support_operations_config_v3',
  ARRAY['integer','text','uuid','uuid','text','text','text','jsonb','date[]'],
  'admin schedule update uses the version-guarded canonical RPC'
);

-- Opening is inclusive and closing is exclusive. A request inside a window
-- targets the end of the next support day; outside targets the nearest one.
SELECT is(
  private.calculate_support_first_response_target(
    '2026-11-16 10:00:00+00', 'UTC',
    '[{"weekday":1,"start":"09:00","end":"17:00"},{"weekday":2,"start":"09:00","end":"17:00"}]', ARRAY[]::date[]
  ),
  '2026-11-17 17:00:00+00'::timestamptz,
  'inside support hours targets the end of the next support day'
);
SELECT is(
  private.calculate_support_first_response_target(
    '2026-11-16 08:59:59+00', 'UTC',
    '[{"weekday":1,"start":"09:00","end":"17:00"}]', ARRAY[]::date[]
  ),
  '2026-11-16 17:00:00+00'::timestamptz,
  'before opening targets the end of the nearest support day'
);
SELECT is(
  private.calculate_support_first_response_target(
    '2026-11-16 09:00:00+00', 'UTC',
    '[{"weekday":1,"start":"09:00","end":"17:00"},{"weekday":2,"start":"09:00","end":"17:00"}]', ARRAY[]::date[]
  ),
  '2026-11-17 17:00:00+00'::timestamptz,
  'the exact opening instant is inside the support window'
);
SELECT is(
  private.calculate_support_first_response_target(
    '2026-11-16 17:00:00+00', 'UTC',
    '[{"weekday":1,"start":"09:00","end":"17:00"},{"weekday":2,"start":"09:00","end":"17:00"}]', ARRAY[]::date[]
  ),
  '2026-11-17 17:00:00+00'::timestamptz,
  'the exact closing instant is outside the support window'
);
SELECT is(
  private.calculate_support_first_response_target(
    '2026-11-14 12:00:00+00', 'UTC',
    '[{"weekday":1,"start":"09:00","end":"17:00"}]', ARRAY[]::date[]
  ),
  '2026-11-16 17:00:00+00'::timestamptz,
  'a weekend request targets the next configured support day'
);
SELECT is(
  private.calculate_support_first_response_target(
    '2026-11-14 12:00:00+00', 'UTC',
    '[{"weekday":1,"start":"09:00","end":"17:00"},{"weekday":2,"start":"09:00","end":"17:00"}]', ARRAY['2026-11-16']::date[]
  ),
  '2026-11-17 17:00:00+00'::timestamptz,
  'an explicit closure date is skipped without an automatic holiday calendar'
);
SELECT is(
  private.calculate_support_first_response_target(
    '2026-03-08 07:30:00+00', 'America/New_York',
    '[{"weekday":0,"start":"09:00","end":"17:00"}]', ARRAY[]::date[]
  ),
  '2026-03-08 21:00:00+00'::timestamptz,
  'timezone conversion follows the PostgreSQL daylight-saving rules'
);
SELECT is(
  private.calculate_support_first_response_target(
    '2026-11-17 01:00:00+00', 'UTC',
    '[{"weekday":1,"start":"22:00","end":"02:00"}]', ARRAY[]::date[]
  ),
  '2026-11-24 02:00:00+00'::timestamptz,
  'a cross-midnight window belongs to its opening weekday and is not double-counted'
);
SELECT is(
  private.calculate_support_first_response_target(
    '2026-11-16 12:30:00+00', 'UTC',
    '[{"weekday":1,"start":"09:00","end":"12:00"},{"weekday":1,"start":"13:00","end":"17:00"}]', ARRAY[]::date[]
  ),
  '2026-11-16 17:00:00+00'::timestamptz,
  'between windows, the nearest day ends at the final configured close'
);
SELECT is(
  private.calculate_support_first_response_target(
    '2026-11-16 10:00:00+00', NULL, NULL, NULL
  ),
  NULL::timestamptz,
  'missing schedule configuration does not invent a deadline'
);

INSERT INTO auth.users(id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) VALUES
 ('00000000-0000-4000-8000-000000086201','authenticated','authenticated','support-sla-client@example.invalid','x',now(),'{}','{}',now(),now()),
 ('00000000-0000-4000-8000-000000086202','authenticated','authenticated','support-sla-admin@example.invalid','x',now(),'{}','{}',now(),now());
INSERT INTO public.user_roles(user_id, role) VALUES
 ('00000000-0000-4000-8000-000000086201','client'),
 ('00000000-0000-4000-8000-000000086202','admin')
ON CONFLICT DO NOTHING;

-- The stored legacy schedule and the SLA windows describe the same hours.
UPDATE private.support_operations_config
SET support_timezone = 'UTC',
    support_weekdays = ARRAY[0,1,2,3,4,5,6]::smallint[],
    support_day_start = TIME '00:00',
    support_day_end = TIME '23:59',
    support_windows = '[{"weekday":0,"start":"00:00","end":"23:59"},{"weekday":1,"start":"00:00","end":"23:59"},{"weekday":2,"start":"00:00","end":"23:59"},{"weekday":3,"start":"00:00","end":"23:59"},{"weekday":4,"start":"00:00","end":"23:59"},{"weekday":5,"start":"00:00","end":"23:59"},{"weekday":6,"start":"00:00","end":"23:59"}]',
    support_closure_dates = ARRAY[]::date[],
    support_schedule_version = 7
WHERE singleton;

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000086201';
SELECT lives_ok(
  $$SELECT public.create_support_ticket('בדיקת יעד מענה','technical','תיאור פנייה לבדיקת יעד המענה הראשון','00000000-0000-4000-8000-000000086211')$$,
  'client creates a ticket with a server-authoritative timestamp'
);
SELECT ok(
  (SELECT first_response_target_at IS NOT NULL
     AND first_response_schedule_version = 7
     AND first_response_timezone = 'UTC'
   FROM public.support_tickets WHERE client_id = auth.uid()),
  'ticket stores the deadline and the schedule snapshot used to calculate it'
);
CREATE TEMP TABLE first_response_snapshot AS
SELECT id, first_response_target_at, first_response_schedule_version, first_response_timezone
FROM public.support_tickets WHERE client_id = auth.uid();
RESET ROLE;

UPDATE private.support_operations_config
SET support_timezone = 'Asia/Jerusalem', support_schedule_version = 8
WHERE singleton;

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000086201';
SELECT lives_ok(
  $$SELECT public.create_support_ticket('ignored retry','technical','retry payload cannot move an existing target','00000000-0000-4000-8000-000000086211')$$,
  'ticket retry remains idempotent after a schedule change'
);
SELECT ok(
  (SELECT (ticket.first_response_target_at, ticket.first_response_schedule_version, ticket.first_response_timezone)
       IS NOT DISTINCT FROM (snapshot.first_response_target_at, snapshot.first_response_schedule_version, snapshot.first_response_timezone)
   FROM public.support_tickets ticket CROSS JOIN first_response_snapshot snapshot
   WHERE ticket.id = snapshot.id),
  'a later schedule change does not move an existing ticket target'
);
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000086202';
SELECT lives_ok(format(
  $q$SELECT public.admin_add_support_ticket_message(%L,'הערה פנימית','internal','00000000-0000-4000-8000-000000086212')$q$,
  (SELECT id FROM public.support_tickets LIMIT 1)
), 'an internal note is stored without becoming a first human response');
SELECT ok(
  (SELECT first_human_response_at IS NULL AND first_response_within_target IS NULL FROM public.support_tickets LIMIT 1),
  'internal notes, assignment and status changes do not satisfy the target'
);
SELECT lives_ok(format(
  $q$SELECT public.admin_add_support_ticket_message(%L,'תשובה אנושית ראשונה','client','00000000-0000-4000-8000-000000086213')$q$,
  (SELECT id FROM public.support_tickets LIMIT 1)
), 'the first client-visible human response is stored');
CREATE TEMP TABLE first_human_response_snapshot AS
SELECT first_human_response_at, first_response_within_target FROM public.support_tickets LIMIT 1;
SELECT lives_ok(format(
  $q$SELECT public.admin_add_support_ticket_message(%L,'retry ignored','client','00000000-0000-4000-8000-000000086213')$q$,
  (SELECT id FROM public.support_tickets LIMIT 1)
), 'a response retry is idempotent');
SELECT lives_ok(format(
  $q$SELECT public.admin_add_support_ticket_message(%L,'תשובה מאוחרת יותר','client','00000000-0000-4000-8000-000000086214')$q$,
  (SELECT id FROM public.support_tickets LIMIT 1)
), 'a later response is stored without replacing the first one');
SELECT ok(
  (SELECT (ticket.first_human_response_at, ticket.first_response_within_target)
       IS NOT DISTINCT FROM (snapshot.first_human_response_at, snapshot.first_response_within_target)
   FROM public.support_tickets ticket CROSS JOIN first_human_response_snapshot snapshot LIMIT 1),
  'retry and later replies do not rewrite the first-response timestamp or outcome'
);
RESET ROLE;

INSERT INTO public.support_tickets (
  client_id, subject, category, description, idempotency_key, status,
  first_response_target_at, first_response_schedule_version, first_response_timezone
) VALUES (
  '00000000-0000-4000-8000-000000086201', 'נסגר ללא תשובה', 'other',
  'פנייה שנסגרה ללא תשובה אנושית ללקוח', '00000000-0000-4000-8000-000000086215', 'closed',
  clock_timestamp() - interval '1 day', 8, 'Asia/Jerusalem'
);
SELECT ok(
  (SELECT first_human_response_at IS NULL AND first_response_within_target IS NULL
   FROM public.support_tickets WHERE idempotency_key = '00000000-0000-4000-8000-000000086215'),
  'closing without a response is not recorded as meeting the target'
);

SELECT * FROM finish();
ROLLBACK;
