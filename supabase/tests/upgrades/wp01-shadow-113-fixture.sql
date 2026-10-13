BEGIN;

INSERT INTO auth.users (
  id,
  aud,
  role,
  email,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
SELECT
  fixture.id,
  'authenticated',
  'authenticated',
  fixture.email,
  clock_timestamp(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  clock_timestamp(),
  clock_timestamp()
FROM (
  VALUES
    ('00000000-0000-4000-8000-0000000b0001'::uuid, 'wp01-upgrade-client-1@example.invalid'),
    ('00000000-0000-4000-8000-0000000b0002'::uuid, 'wp01-upgrade-client-2@example.invalid'),
    ('00000000-0000-4000-8000-0000000b0003'::uuid, 'wp01-upgrade-client-3@example.invalid'),
    ('00000000-0000-4000-8000-0000000b0004'::uuid, 'wp01-upgrade-client-4@example.invalid'),
    ('00000000-0000-4000-8000-0000000b0005'::uuid, 'wp01-upgrade-client-5@example.invalid'),
    ('00000000-0000-4000-8000-0000000b0006'::uuid, 'wp01-upgrade-client-6@example.invalid'),
    ('00000000-0000-4000-8000-0000000b0011'::uuid, 'wp01-upgrade-operator@example.invalid'),
    ('00000000-0000-4000-8000-0000000b0012'::uuid, 'wp01-upgrade-admin@example.invalid')
) AS fixture(id, email);

INSERT INTO public.user_roles (user_id, role)
VALUES
  ('00000000-0000-4000-8000-0000000b0011', 'operator'),
  ('00000000-0000-4000-8000-0000000b0012', 'operator'),
  ('00000000-0000-4000-8000-0000000b0012', 'admin');

INSERT INTO public.operators (
  id,
  user_id,
  full_name,
  is_active,
  availability_status,
  presence_status,
  last_seen_at
)
VALUES
  (
    '00000000-0000-4000-8000-0000000b0021',
    '00000000-0000-4000-8000-0000000b0011',
    'WP01 upgrade operator',
    true,
    'available',
    'online',
    clock_timestamp()
  ),
  (
    '00000000-0000-4000-8000-0000000b0022',
    '00000000-0000-4000-8000-0000000b0012',
    'WP01 upgrade admin worker',
    true,
    'available',
    'online',
    clock_timestamp()
  );

INSERT INTO public.characters (id, name, is_active, is_visible, availability_status)
VALUES (
  '00000000-0000-4000-8000-0000000b0031',
  'WP01 upgrade character',
  true,
  true,
  'available'
);

INSERT INTO public.character_operator_assignments (character_id, operator_id)
VALUES
  ('00000000-0000-4000-8000-0000000b0031', '00000000-0000-4000-8000-0000000b0021'),
  ('00000000-0000-4000-8000-0000000b0031', '00000000-0000-4000-8000-0000000b0022');

INSERT INTO public.conversations (id, client_id, character_id, assigned_operator_id, status)
SELECT
  fixture.conversation_id,
  fixture.client_id,
  '00000000-0000-4000-8000-0000000b0031',
  fixture.operator_id,
  fixture.status::public.conversation_status
FROM (
  VALUES
    ('00000000-0000-4000-8000-0000000b0101'::uuid, '00000000-0000-4000-8000-0000000b0001'::uuid, NULL::uuid, 'open'),
    ('00000000-0000-4000-8000-0000000b0102'::uuid, '00000000-0000-4000-8000-0000000b0002'::uuid, '00000000-0000-4000-8000-0000000b0021'::uuid, 'open'),
    ('00000000-0000-4000-8000-0000000b0103'::uuid, '00000000-0000-4000-8000-0000000b0003'::uuid, '00000000-0000-4000-8000-0000000b0021'::uuid, 'open'),
    ('00000000-0000-4000-8000-0000000b0104'::uuid, '00000000-0000-4000-8000-0000000b0004'::uuid, NULL::uuid, 'closed'),
    ('00000000-0000-4000-8000-0000000b0105'::uuid, '00000000-0000-4000-8000-0000000b0005'::uuid, '00000000-0000-4000-8000-0000000b0021'::uuid, 'open'),
    ('00000000-0000-4000-8000-0000000b0106'::uuid, '00000000-0000-4000-8000-0000000b0006'::uuid, '00000000-0000-4000-8000-0000000b0022'::uuid, 'open')
) AS fixture(conversation_id, client_id, operator_id, status);

INSERT INTO public.conversation_work_items (
  id,
  conversation_id,
  client_id,
  character_id,
  status,
  responsible_operator_id,
  assigned_at,
  last_activity_at
)
VALUES (
  '00000000-0000-4000-8000-0000000b0405',
  '00000000-0000-4000-8000-0000000b0105',
  '00000000-0000-4000-8000-0000000b0005',
  '00000000-0000-4000-8000-0000000b0031',
  'assigned',
  '00000000-0000-4000-8000-0000000b0021',
  '2026-10-01T12:00:00Z',
  '2026-10-01T12:00:00Z'
);

INSERT INTO public.conversation_handling_cycles (
  id,
  conversation_id,
  work_item_id,
  operator_id,
  started_at,
  ended_at,
  end_reason
)
VALUES
  (
    '00000000-0000-4000-8000-0000000b0201',
    '00000000-0000-4000-8000-0000000b0102',
    NULL,
    '00000000-0000-4000-8000-0000000b0021',
    '2026-10-01T10:00:00Z',
    '2026-10-01T10:10:00Z',
    'answered'
  ),
  (
    '00000000-0000-4000-8000-0000000b0202',
    '00000000-0000-4000-8000-0000000b0105',
    '00000000-0000-4000-8000-0000000b0405',
    '00000000-0000-4000-8000-0000000b0021',
    '2026-10-01T12:00:00Z',
    NULL,
    NULL
  );

INSERT INTO public.messages (
  id,
  conversation_id,
  sender_type,
  sender_id,
  operator_id,
  content,
  created_at
)
VALUES
  ('00000000-0000-4000-8000-0000000b0301', '00000000-0000-4000-8000-0000000b0101', 'client', '00000000-0000-4000-8000-0000000b0001', NULL, 'wp01 upgrade client only', '2026-10-01T09:00:00Z'),
  ('00000000-0000-4000-8000-0000000b0302', '00000000-0000-4000-8000-0000000b0102', 'client', '00000000-0000-4000-8000-0000000b0002', NULL, 'wp01 upgrade client before response', '2026-10-01T10:01:00Z'),
  ('00000000-0000-4000-8000-0000000b0303', '00000000-0000-4000-8000-0000000b0102', 'operator', '00000000-0000-4000-8000-0000000b0011', '00000000-0000-4000-8000-0000000b0021', 'wp01 upgrade qualifying response', '2026-10-01T10:05:00Z'),
  ('00000000-0000-4000-8000-0000000b0304', '00000000-0000-4000-8000-0000000b0103', 'operator', '00000000-0000-4000-8000-0000000b0011', '00000000-0000-4000-8000-0000000b0021', 'wp01 upgrade historical no cycle', '2026-10-01T11:00:00Z'),
  ('00000000-0000-4000-8000-0000000b0305', '00000000-0000-4000-8000-0000000b0104', 'client', '00000000-0000-4000-8000-0000000b0004', NULL, 'wp01 upgrade closed client request', '2026-10-01T11:30:00Z'),
  ('00000000-0000-4000-8000-0000000b0306', '00000000-0000-4000-8000-0000000b0105', 'client', '00000000-0000-4000-8000-0000000b0005', NULL, 'wp01 upgrade active cycle request', '2026-10-01T12:01:00Z'),
  ('00000000-0000-4000-8000-0000000b0307', '00000000-0000-4000-8000-0000000b0106', 'admin', '00000000-0000-4000-8000-0000000b0012', '00000000-0000-4000-8000-0000000b0022', 'wp01 upgrade admin ambiguity', '2026-10-01T13:00:00Z');

UPDATE public.conversations
SET status = 'closed'
WHERE id = '00000000-0000-4000-8000-0000000b0104';

COMMIT;
