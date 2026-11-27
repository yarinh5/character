BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT no_plan();

SELECT has_function('public', 'before_user_created_hook', ARRAY['jsonb'],
  'Auth has an authoritative before-user-created hook');
SELECT has_function('public', 'create_registration_admission_for_server', ARRAY['text', 'boolean', 'boolean'],
  'The trusted boundary can issue a short-lived admission nonce');
SELECT has_function('public', 'admin_set_registration_state', ARRAY['boolean', 'text'],
  'Admins change registration state through an audited RPC');
SELECT ok(NOT has_function_privilege('anon',
  'public.create_registration_admission_for_server(text,boolean,boolean)', 'EXECUTE'),
  'Anonymous callers cannot issue admission nonces');

UPDATE public.system_settings SET value = 'false'::jsonb WHERE key = 'allow_new_registrations';
SELECT is(
  public.before_user_created_hook(jsonb_build_object('user', jsonb_build_object(
    'id', '00000000-0000-4000-8000-000000076001',
    'email', 'paused@example.invalid',
    'app_metadata', '{}'::jsonb,
    'user_metadata', '{}'::jsonb
  ))) #>> '{error,message}',
  'registration_paused',
  'a paused gate rejects direct Auth creation before user insertion'
);
UPDATE public.system_settings SET value = 'true'::jsonb WHERE key = 'allow_new_registrations';

INSERT INTO auth.users(
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('00000000-0000-4000-8000-000000076001', 'authenticated', 'authenticated',
   'p06-unverified@example.invalid', 'x', NULL, '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000076002', 'authenticated', 'authenticated',
   'p06-eligible@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000076003', 'authenticated', 'authenticated',
   'p06-legacy@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000076004', 'authenticated', 'authenticated',
   'p06-admin@example.invalid', 'x', now(), '{"registration_origin":"admin_provisioned"}', '{}', now(), now());

INSERT INTO private.registration_eligibility(user_id, policy_version, age_declared_at)
VALUES
  ('00000000-0000-4000-8000-000000076001', 'p06a-v1', now()),
  ('00000000-0000-4000-8000-000000076002', 'p06a-v1', now())
ON CONFLICT (user_id) DO UPDATE SET age_declared_at = EXCLUDED.age_declared_at;

UPDATE public.client_profiles SET computed_age = 22, onboarding_completed_at = now()
WHERE user_id IN (
  '00000000-0000-4000-8000-000000076001',
  '00000000-0000-4000-8000-000000076002'
);

SELECT is((SELECT activated_at FROM private.registration_eligibility
  WHERE user_id = '00000000-0000-4000-8000-000000076001'), NULL::timestamptz,
  'an unverified email cannot activate an otherwise age-eligible account');
SELECT is((SELECT count(*) FROM public.credit_transactions
  WHERE user_id = '00000000-0000-4000-8000-000000076001' AND type = 'signup_bonus'), 0::bigint,
  'an unverified account receives no signup bonus');
SELECT ok((SELECT activated_at IS NOT NULL FROM private.registration_eligibility
  WHERE user_id = '00000000-0000-4000-8000-000000076002'),
  'a verified email plus a completed 18+ profile activates eligibility');
SELECT is((SELECT count(*) FROM public.credit_transactions
  WHERE user_id = '00000000-0000-4000-8000-000000076002' AND type = 'signup_bonus'), 1::bigint,
  'the eligible account receives one signup bonus');
SELECT lives_ok(
  $$SELECT private.activate_p06a_client_if_eligible('00000000-0000-4000-8000-000000076002')$$,
  'repeating activation is idempotent');
SELECT lives_ok(
  $$SELECT private.grant_signup_credits_for_user('00000000-0000-4000-8000-000000076002')$$,
  'repeating the grant helper is idempotent');
SELECT is((SELECT count(*) FROM public.credit_transactions
  WHERE user_id = '00000000-0000-4000-8000-000000076002' AND type = 'signup_bonus'), 1::bigint,
  'activation and grant retries do not duplicate the ledger entry');
SELECT is((SELECT count(*) FROM private.registration_eligibility
  WHERE user_id = '00000000-0000-4000-8000-000000076003'), 0::bigint,
  'legacy accounts are not backfilled into the P06-A policy');
SELECT is((SELECT count(*) FROM public.credit_transactions
  WHERE user_id = '00000000-0000-4000-8000-000000076003' AND type = 'signup_bonus'), 0::bigint,
  'the migration does not grant a legacy bonus automatically');

INSERT INTO public.user_roles(user_id, role)
VALUES ('00000000-0000-4000-8000-000000076004', 'admin')
ON CONFLICT (user_id, role) DO NOTHING;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000076004';
SELECT lives_ok(
  $$SELECT public.admin_set_registration_state(false, 'planned incident gate test')$$,
  'an authenticated Admin can pause registration with a reason');
RESET ROLE;
SELECT ok(EXISTS (SELECT 1 FROM public.audit_logs
  WHERE action = 'registration.admission.changed'
    AND metadata ->> 'reason' = 'planned incident gate test'),
  'the registration state change is audited');

SELECT * FROM finish();
ROLLBACK;
