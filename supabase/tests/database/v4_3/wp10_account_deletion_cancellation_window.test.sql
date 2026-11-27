BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT plan(8);

INSERT INTO auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
VALUES ('00000000-0000-4000-8000-000000100701', 'authenticated', 'authenticated',
  'wp10-cancellation-window@example.invalid', now(), '{}', '{}');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000100701';
SELECT is(
  (SELECT status FROM public.request_account_deletion('00000000-0000-4000-8000-000000100702')),
  'awaiting_verification', 'A signed-in user can request email verification'
);
RESET ROLE;

SET LOCAL ROLE service_role;
SET LOCAL "request.jwt.claim.role" = 'service_role';
SELECT public.prepare_account_deletion_verification_for_server(
  (SELECT id FROM public.account_deletion_requests
   WHERE user_id = '00000000-0000-4000-8000-000000100701'),
  repeat('a', 64), clock_timestamp() + interval '10 minutes'
);
SELECT is(
  (SELECT status FROM public.verify_account_deletion_for_server(
    (SELECT id FROM public.account_deletion_requests
     WHERE user_id = '00000000-0000-4000-8000-000000100701'),
    repeat('a', 64), '00000000-0000-4000-8000-000000100701')),
  'cancellation_window', 'Email proof opens the cancellation window'
);
SELECT is(
  (SELECT step_name FROM public.claim_account_deletion_step_for_server(
    (SELECT id FROM public.account_deletion_requests
     WHERE user_id = '00000000-0000-4000-8000-000000100701'))),
  'session_revocation', 'Only session revocation is claimable before the deadline'
);
RESET ROLE;
SELECT is(
  public.complete_account_deletion_step_for_server(
    (SELECT id FROM public.account_deletion_requests
     WHERE user_id = '00000000-0000-4000-8000-000000100701'),
    'session_revocation',
    (SELECT claim_token FROM private.account_deletion_steps
     WHERE request_id = (SELECT id FROM public.account_deletion_requests
       WHERE user_id = '00000000-0000-4000-8000-000000100701')
       AND step_name = 'session_revocation'),
    '{"operation":"synthetic_provider_revocation","provider_confirmed":true}'::jsonb
  ),
  'cancellation_window', 'Session revocation completion preserves the seven-day window'
);
SELECT ok(
  (SELECT cancellation_deadline > clock_timestamp() AND irreversible_started_at IS NULL
   FROM public.account_deletion_requests
   WHERE user_id = '00000000-0000-4000-8000-000000100701'),
  'The irreversible path remains closed inside the window'
);
SELECT lives_ok(
  $$SELECT public.prepare_account_deletion_cancellation_for_server(
    (SELECT id FROM public.account_deletion_requests
     WHERE user_id = '00000000-0000-4000-8000-000000100701'),
    '00000000-0000-4000-8000-000000100701', repeat('b', 64),
    clock_timestamp() + interval '10 minutes')$$,
  'A fresh email cancellation proof can be prepared after session revocation'
);
SELECT is(
  (SELECT status FROM public.cancel_account_deletion_for_server(
    (SELECT id FROM public.account_deletion_requests
     WHERE user_id = '00000000-0000-4000-8000-000000100701'),
    '00000000-0000-4000-8000-000000100701', repeat('b', 64))),
  'cancelled', 'The verified owner can cancel before the deadline'
);
SELECT is(
  (SELECT status FROM public.profiles WHERE user_id = '00000000-0000-4000-8000-000000100701'),
  'active', 'Cancellation restores the active profile'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
