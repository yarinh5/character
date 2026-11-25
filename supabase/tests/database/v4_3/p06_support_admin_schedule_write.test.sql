BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT plan(8);

INSERT INTO auth.users(
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000086301', 'authenticated', 'authenticated',
  'schedule-write-admin@example.invalid', 'synthetic', now(), '{}', '{}', now(), now()
);
INSERT INTO public.user_roles (user_id, role)
VALUES ('00000000-0000-4000-8000-000000086301', 'admin');
INSERT INTO auth.users(
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000086302', 'authenticated', 'authenticated',
  'schedule-write-client@example.invalid', 'synthetic', now(), '{}', '{}', now(), now()
);
SELECT set_config('p06_schedule.expected_version', version::text, true)
FROM private.support_operations_config WHERE singleton;

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000086301';
SELECT lives_ok(
  $$SELECT public.admin_set_support_operations_config_v3(
    current_setting('p06_schedule.expected_version')::integer,
    NULL, NULL, NULL, NULL, NULL, 'UTC',
    '[{"weekday":1,"start":"09:00","end":"12:00"},{"weekday":1,"start":"13:00","end":"17:00"}]'::jsonb,
    ARRAY[]::date[]
  )$$,
  'Admin can save valid split support hours through the versioned production RPC'
);
SELECT throws_ok(
  $$SELECT public.admin_set_support_operations_config_v3(
    current_setting('p06_schedule.expected_version')::integer - 1,
    NULL, NULL, NULL, NULL, NULL, 'UTC',
    '[{"weekday":1,"start":"09:00","end":"17:00"}]'::jsonb,
    ARRAY[]::date[]
  )$$,
  'P0001', 'expected_version_mismatch', 'Admin cannot save with a stale config version'
);

SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000086302';
SELECT throws_ok(
  $$SELECT public.admin_set_support_operations_config_v3(
    (current_setting('p06_schedule.expected_version')::integer + 1),
    NULL, NULL, NULL, NULL, NULL, 'UTC',
    '[{"weekday":1,"start":"09:00","end":"17:00"}]'::jsonb,
    ARRAY[]::date[]
  )$$,
  'P0001', 'admin_required', 'Authenticated non-Admin cannot save support hours'
);
RESET ROLE;

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.admin_set_support_operations_config_v3(integer,text,uuid,uuid,text,text,text,jsonb,date[])'::regprocedure,
    'EXECUTE'
  ),
  'Anonymous role cannot execute the Admin schedule writer'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM private.support_operations_config
    WHERE singleton
      AND version = current_setting('p06_schedule.expected_version')::integer + 1
      AND support_timezone = 'UTC'
      AND support_windows = '[{"weekday":1,"start":"09:00","end":"12:00"},{"weekday":1,"start":"13:00","end":"17:00"}]'::jsonb
      AND support_closure_dates = ARRAY[]::date[]
      AND support_weekdays IS NULL AND support_day_start IS NULL AND support_day_end IS NULL
  ),
  'Only the successful Admin write persists, with split windows and no legacy hours'
);

-- Use the owner only to test the table checks directly, with the backfilled legacy shape.
SELECT lives_ok(
  $$UPDATE private.support_operations_config
    SET support_timezone = 'UTC', support_weekdays = ARRAY[1]::smallint[],
        support_day_start = '09:00'::time, support_day_end = '17:00'::time,
        support_windows = '[{"weekday":1,"start":"09:00","end":"17:00"}]'::jsonb,
        support_closure_dates = ARRAY[]::date[]
    WHERE singleton$$,
  'Complete backfilled legacy hours still satisfy both schedule checks'
);
SELECT throws_ok(
  $$UPDATE private.support_operations_config SET support_weekdays = NULL WHERE singleton$$,
  '23514', 'new row for relation "support_operations_config" violates check constraint "support_schedule_all_or_none"',
  'Valid windows do not allow a partial legacy schedule'
);
SELECT throws_ok(
  $$UPDATE private.support_operations_config SET support_closure_dates = NULL WHERE singleton$$,
  '23514', 'new row for relation "support_operations_config" violates check constraint "support_windows_shape"',
  'A configured schedule still requires its closure array'
);

SELECT * FROM finish();
ROLLBACK;
