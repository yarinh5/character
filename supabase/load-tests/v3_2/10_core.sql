BEGIN;
SET LOCAL session_replication_role = replica;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM load_v3_2.fixture_runs
    WHERE run_id = 'load_v3_2_20260731_pilot_01'
      AND target_project_ref = 'micmgokyckvfpewxgrzf'
      AND status = 'preparing'
  ) THEN
    RAISE EXCEPTION 'load_fixture_environment_guard_failed';
  END IF;
END;
$$;

WITH generated AS (
  SELECT
    sequence,
    load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', sequence) AS id,
    CASE WHEN sequence <= 1000 THEN 'client' ELSE 'operator' END AS actor_kind
  FROM generate_series(1, 1025) AS sequence
)
INSERT INTO auth.users (
  id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
SELECT
  id,
  'authenticated',
  'authenticated',
  format('load_v3_2_20260731_pilot_01_%s_%s@example.invalid', actor_kind, sequence),
  '2026-07-31T12:07:36Z'::timestamptz,
  jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
  jsonb_build_object('fixture', 'load_v3_2_20260731_pilot_01'),
  '2026-07-31T12:07:36Z'::timestamptz,
  '2026-07-31T12:07:36Z'::timestamptz
FROM generated;

INSERT INTO public.profiles (id, user_id, display_name, email, status, created_at, updated_at)
SELECT
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'profile', sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', sequence),
  format('Load V3 2 %s %s', CASE WHEN sequence <= 1000 THEN 'Client' ELSE 'Operator' END, sequence),
  format(
    'load_v3_2_20260731_pilot_01_%s_%s@example.invalid',
    CASE WHEN sequence <= 1000 THEN 'client' ELSE 'operator' END,
    sequence
  ),
  'active',
  '2026-07-31T12:07:36Z'::timestamptz,
  '2026-07-31T12:07:36Z'::timestamptz
FROM generate_series(1, 1025) AS sequence;

INSERT INTO public.user_roles (id, user_id, role, created_at)
SELECT
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user_role', sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', sequence),
  CASE WHEN sequence <= 1000 THEN 'client'::public.app_role ELSE 'operator'::public.app_role END,
  '2026-07-31T12:07:36Z'::timestamptz
FROM generate_series(1, 1025) AS sequence;

INSERT INTO public.client_profiles (
  id, user_id, first_name, last_name, computed_age, interests,
  onboarding_step, onboarding_completed_at, created_at, updated_at
)
SELECT
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'client_profile', sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', sequence),
  format('Load%s', sequence),
  'Client',
  18 + (sequence % 43),
  ARRAY[format('interest_%s', sequence % 20)],
  5,
  '2026-07-31T12:07:36Z'::timestamptz,
  '2026-07-31T12:07:36Z'::timestamptz,
  '2026-07-31T12:07:36Z'::timestamptz
FROM generate_series(1, 1000) AS sequence;

INSERT INTO public.operators (
  id, user_id, full_name, is_active, availability_status,
  last_seen_at, presence_status, created_at, updated_at
)
SELECT
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'operator', sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', 1000 + sequence),
  format('Load Operator %s', sequence),
  true,
  'available'::public.availability_status,
  '2026-07-31T12:07:36Z'::timestamptz,
  CASE WHEN sequence <= 20 THEN 'online' ELSE 'idle' END,
  '2026-07-31T12:07:36Z'::timestamptz,
  '2026-07-31T12:07:36Z'::timestamptz
FROM generate_series(1, 25) AS sequence;

INSERT INTO public.characters (
  id, name, short_description, category, fictional_age, interests,
  is_active, is_visible, availability_status, created_at, updated_at
)
SELECT
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'character', sequence),
  format('Load Character %s', sequence),
  'Synthetic load-test character',
  format('load_category_%s', sequence % 10),
  18 + (sequence % 43),
  ARRAY[format('interest_%s', sequence % 20)],
  true,
  true,
  'available'::public.availability_status,
  '2026-07-31T12:07:36Z'::timestamptz,
  '2026-07-31T12:07:36Z'::timestamptz
FROM generate_series(1, 100) AS sequence;

INSERT INTO public.character_operator_assignments (id, character_id, operator_id, created_at)
SELECT
  load_v3_2.fixture_id(
    'load_v3_2_20260731_pilot_01',
    'character_operator_assignment',
    ((character_sequence - 1) * 5) + slot + 1
  ),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'character', character_sequence),
  load_v3_2.fixture_id(
    'load_v3_2_20260731_pilot_01',
    'operator',
    ((character_sequence - 1 + slot) % 25) + 1
  ),
  '2026-07-31T12:07:36Z'::timestamptz
FROM generate_series(1, 100) AS character_sequence
CROSS JOIN generate_series(0, 4) AS slot;

INSERT INTO public.conversations (
  id, client_id, character_id, assigned_operator_id, status,
  created_at, updated_at, client_unread_count, operator_unread_count
)
SELECT
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'conversation', sequence),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', ((sequence - 1) / 10) + 1),
  load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'character', ((sequence - 1) % 100) + 1),
  CASE WHEN sequence <= 250 THEN NULL ELSE load_v3_2.fixture_id(
    'load_v3_2_20260731_pilot_01', 'operator', ((sequence - 1) % 25) + 1
  ) END,
  CASE WHEN sequence <= 250 THEN 'waiting'::public.conversation_status ELSE 'answered'::public.conversation_status END,
  '2026-07-01T12:07:36Z'::timestamptz + make_interval(secs => sequence * 120),
  '2026-07-01T12:07:36Z'::timestamptz + make_interval(secs => sequence * 120),
  0,
  0
FROM generate_series(1, 10000) AS sequence;

INSERT INTO load_v3_2.fixture_manifest (run_id, entity_type, ids, row_count)
SELECT 'load_v3_2_20260731_pilot_01', entity_type, ids, cardinality(ids)
FROM (
  VALUES
    ('auth_users', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', s) FROM generate_series(1, 1025) s)),
    ('profiles', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'profile', s) FROM generate_series(1, 1025) s)),
    ('user_roles', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user_role', s) FROM generate_series(1, 1025) s)),
    ('client_profiles', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'client_profile', s) FROM generate_series(1, 1000) s)),
    ('operators', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'operator', s) FROM generate_series(1, 25) s)),
    ('characters', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'character', s) FROM generate_series(1, 100) s)),
    ('character_operator_assignments', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'character_operator_assignment', s) FROM generate_series(1, 500) s)),
    ('conversations', ARRAY(SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'conversation', s) FROM generate_series(1, 10000) s))
) AS manifest(entity_type, ids)
ON CONFLICT (run_id, entity_type) DO UPDATE
SET ids = EXCLUDED.ids, row_count = EXCLUDED.row_count;

UPDATE load_v3_2.fixture_runs
SET status = 'core_seeded'
WHERE run_id = 'load_v3_2_20260731_pilot_01';

COMMIT;
