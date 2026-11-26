BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT no_plan();

SELECT has_table('public', 'client_character_leads', 'WP04 canonical Lead table exists');
SELECT has_table('public', 'client_consent_documents', 'Versioned consent documents table exists');
SELECT has_table('public', 'client_consent_acceptances', 'Versioned consent acceptance table exists');
SELECT has_function(
  'public',
  'get_client_consent_requirements',
  ARRAY[]::text[],
  'Consent requirements RPC is installed'
);
SELECT has_function(
  'public',
  'accept_client_consent',
  ARRAY['uuid'],
  'Consent acceptance RPC is installed'
);
SELECT has_index(
  'public',
  'client_character_leads',
  'client_character_leads_client_id_character_id_key',
  'A client and character have one canonical Lead'
);

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('00000000-0000-4000-8000-000000040001', 'authenticated', 'authenticated', 'wp04-client@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000040002', 'authenticated', 'authenticated', 'wp04-operator@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000040003', 'authenticated', 'authenticated', 'wp04-other-operator@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000040005', 'authenticated', 'authenticated', 'wp04-other-client@example.invalid', 'x', now(), '{}', '{}', now(), now());

INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-4000-8000-000000040002', 'operator'),
  ('00000000-0000-4000-8000-000000040003', 'operator');
UPDATE public.profiles
SET display_name = CASE user_id
  WHEN '00000000-0000-4000-8000-000000040001'::uuid THEN 'WP04 client'
  WHEN '00000000-0000-4000-8000-000000040002'::uuid THEN 'WP04 operator'
  WHEN '00000000-0000-4000-8000-000000040003'::uuid THEN 'WP04 other operator'
END
WHERE user_id IN (
  '00000000-0000-4000-8000-000000040001',
  '00000000-0000-4000-8000-000000040002',
  '00000000-0000-4000-8000-000000040003'
);

SELECT is(
  (
    SELECT count(*)
    FROM public.profiles profile
    JOIN (VALUES
      ('00000000-0000-4000-8000-000000040001'::uuid, 'WP04 client'::text),
      ('00000000-0000-4000-8000-000000040002'::uuid, 'WP04 operator'::text),
      ('00000000-0000-4000-8000-000000040003'::uuid, 'WP04 other operator'::text)
    ) expected(user_id, display_name)
      ON expected.user_id = profile.user_id
     AND expected.display_name = profile.display_name
  ),
  3::bigint,
  'The Auth trigger created and the fixture labeled all three profiles'
);
SELECT is(
  (SELECT array_agg(role ORDER BY role::text) FROM public.user_roles
   WHERE user_id = '00000000-0000-4000-8000-000000040001'),
  ARRAY['client'::public.app_role],
  'The client has exactly the default client role'
);
SELECT is(
  (SELECT array_agg(role ORDER BY role::text) FROM public.user_roles
   WHERE user_id = '00000000-0000-4000-8000-000000040002'),
  ARRAY['client'::public.app_role, 'operator'::public.app_role],
  'The assigned operator has exactly client and operator roles'
);
SELECT is(
  (SELECT array_agg(role ORDER BY role::text) FROM public.user_roles
   WHERE user_id = '00000000-0000-4000-8000-000000040003'),
  ARRAY['client'::public.app_role, 'operator'::public.app_role],
  'The other operator has exactly client and operator roles'
);

INSERT INTO public.discovery_cities (id, slug, display_name_he, latitude, longitude) VALUES
  ('00000000-0000-4000-8000-000000040101', 'wp04-origin', 'עיר מקור', 32.085300, 34.781800),
  ('00000000-0000-4000-8000-000000040102', 'wp04-near', 'עיר קרובה', 32.109333, 34.855499),
  ('00000000-0000-4000-8000-000000040103', 'wp04-unknown', 'עיר ללא מיקום', NULL, NULL);

UPDATE public.client_profiles
SET city_id = '00000000-0000-4000-8000-000000040101',
    age = 30,
    interests = ARRAY['music']
WHERE user_id = '00000000-0000-4000-8000-000000040001';
SELECT is(
  (SELECT count(*) FROM public.client_profiles
   WHERE user_id = '00000000-0000-4000-8000-000000040001'
     AND city_id = '00000000-0000-4000-8000-000000040101'
     AND age = 30
     AND interests = ARRAY['music']::text[]),
  1::bigint,
  'The fixture populated the trigger-created client profile'
);

INSERT INTO public.operators (id, user_id, full_name, is_active) VALUES
  ('00000000-0000-4000-8000-000000040201', '00000000-0000-4000-8000-000000040002', 'Assigned', TRUE),
  ('00000000-0000-4000-8000-000000040202', '00000000-0000-4000-8000-000000040003', 'Other', TRUE);
INSERT INTO public.characters (id, name, discovery_city_id, is_active, is_visible) VALUES
  ('00000000-0000-4000-8000-000000040301', 'WP04 character', '00000000-0000-4000-8000-000000040102', TRUE, TRUE),
  ('00000000-0000-4000-8000-000000040302', 'WP04 no-coordinate character', '00000000-0000-4000-8000-000000040103', TRUE, TRUE);
INSERT INTO public.character_operator_assignments (character_id, operator_id)
VALUES ('00000000-0000-4000-8000-000000040301', '00000000-0000-4000-8000-000000040201');

SELECT is(
  private.character_live_availability(
    '00000000-0000-4000-8000-000000040301',
    'available'::public.availability_status
  ),
  'offline'::public.availability_status,
  'A character without a fresh connected assigned operator is offline'
);
UPDATE public.operators
SET presence_status = 'online', last_seen_at = clock_timestamp()
WHERE id = '00000000-0000-4000-8000-000000040201';
SELECT is(
  private.character_live_availability(
    '00000000-0000-4000-8000-000000040301',
    'available'::public.availability_status
  ),
  'available'::public.availability_status,
  'A fresh connected assigned operator preserves configured availability'
);
UPDATE public.operators
SET last_seen_at = clock_timestamp() - interval '10 minutes'
WHERE id = '00000000-0000-4000-8000-000000040201';
SELECT is(
  private.character_live_availability(
    '00000000-0000-4000-8000-000000040301',
    'available'::public.availability_status
  ),
  'offline'::public.availability_status,
  'A stale assigned operator cannot make a character appear online'
);
UPDATE public.operators
SET presence_status = 'online', last_seen_at = clock_timestamp()
WHERE id = '00000000-0000-4000-8000-000000040201';

INSERT INTO public.client_character_preferences (client_id, character_id, liked_at)
VALUES ('00000000-0000-4000-8000-000000040001', '00000000-0000-4000-8000-000000040301', clock_timestamp());

SELECT is(
  (SELECT count(*) FROM public.client_character_leads
   WHERE client_id = '00000000-0000-4000-8000-000000040001'
     AND character_id = '00000000-0000-4000-8000-000000040301'),
  1::bigint,
  'A Like creates one Lead'
);

UPDATE public.client_character_preferences
SET liked_at = liked_at + interval '1 second'
WHERE client_id = '00000000-0000-4000-8000-000000040001'
  AND character_id = '00000000-0000-4000-8000-000000040301';
SELECT is(
  (SELECT count(*) FROM public.client_character_leads
   WHERE client_id = '00000000-0000-4000-8000-000000040001'
     AND character_id = '00000000-0000-4000-8000-000000040301'),
  1::bigint,
  'Retry or later timestamp does not duplicate the canonical Lead'
);

SELECT ok(
  private.discovery_distance_km(
    '00000000-0000-4000-8000-000000040101',
    '00000000-0000-4000-8000-000000040102'
  ) BETWEEN 1 AND 20,
  'Distance is calculated from stored city coordinates'
);
SELECT is(
  private.discovery_distance_km(
    '00000000-0000-4000-8000-000000040101',
    '00000000-0000-4000-8000-000000040103'
  ),
  NULL::numeric,
  'Missing coordinates never become a false zero distance'
);

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000040002';
SELECT is((SELECT count(*) FROM public.get_character_leads(100)), 1::bigint, 'Assigned operator sees the Lead');
SELECT set_config(
  'wp04.lead_id',
  (SELECT id::text FROM public.client_character_leads
   WHERE client_id = '00000000-0000-4000-8000-000000040001'
     AND character_id = '00000000-0000-4000-8000-000000040301'),
  true
);
SELECT is(
  (
    SELECT status
    FROM public.update_character_lead_status(
      current_setting('wp04.lead_id')::uuid,
      'in_progress'
    )
  ),
  'in_progress',
  'Assigned operator can move an active Lead into progress'
);
SELECT set_config(
  'wp04.before_denial',
  (SELECT to_jsonb(lead)::text FROM public.client_character_leads lead
   WHERE lead.id = current_setting('wp04.lead_id')::uuid),
  true
);
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000040003';
SELECT is((SELECT count(*) FROM public.get_character_leads(100)), 0::bigint, 'Unassigned operator cannot see the Lead');
SELECT is(
  (SELECT count(*) FROM public.client_character_leads
   WHERE id = current_setting('wp04.lead_id')::uuid),
  0::bigint,
  'RLS hides even the known Lead ID from the unassigned operator'
);
SELECT throws_ok(
  $$SELECT public.update_character_lead_status(current_setting('wp04.lead_id')::uuid, 'closed')$$,
  '42501', 'lead_update_denied',
  'Unassigned operator cannot change the Lead lifecycle'
);
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000040002';
SELECT is(
  (SELECT to_jsonb(lead) FROM public.client_character_leads lead
   WHERE lead.id = current_setting('wp04.lead_id')::uuid),
  current_setting('wp04.before_denial')::jsonb,
  'The denied update leaves the assigned operator observing the original Lead unchanged'
);

SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000040001';
SELECT is(
  (
    SELECT count(*)
    FROM public.get_discovery_characters(
      '{"favorites_only": false, "recycled_only": false}'::jsonb
    )
  ),
  1::bigint,
  'Discovery resolves a character without an ambiguous return-column reference'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.remove_character_like(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.remove_character_like(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.remove_character_like(uuid,uuid)', 'EXECUTE')
  AND to_regprocedure('public.remove_character_like(uuid)') IS NULL,
  'Only authenticated API callers may execute Remove Like'
);
SELECT throws_ok(
  $$UPDATE public.client_character_preferences SET liked_at = NULL WHERE false$$,
  '42501', 'permission denied for table client_character_preferences',
  'The client has no direct preference update grant'
);
SELECT set_config('wp04.target', '00000000-0000-4000-8000-000000040301', true);
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000040005';
SELECT is(
  (SELECT array_agg(role ORDER BY role::text) FROM public.user_roles WHERE user_id = auth.uid()),
  ARRAY['client'::public.app_role], 'The isolation witness has exactly the client role'
);
SELECT is(
  public.remove_character_like(current_setting('wp04.target')::uuid, auth.uid()),
  jsonb_build_object('character_id', current_setting('wp04.target'), 'is_liked', false, 'idempotent', true),
  'Another client cannot detect or remove the first client''s Like'
);
SELECT is(
  (SELECT count(*) FROM public.client_character_preferences WHERE character_id = current_setting('wp04.target')::uuid),
  0::bigint, 'The no-op neither inserts a preference nor exposes the other client''s row'
);
SELECT is(
  (SELECT (public.set_character_swipe(card.id, card.cycle_id, f.value, 'like')->>'first_like')::boolean
   FROM (VALUES ('{"city_id":"00000000-0000-4000-8000-000000040102"}'::jsonb)) f(value)
   CROSS JOIN LATERAL public.get_discovery_characters(f.value) card
   WHERE card.id = current_setting('wp04.target')::uuid),
  TRUE, 'The second client now has an independent Like on the same character'
);
SELECT set_config('wp04.other_preference', (SELECT to_jsonb(p)::text FROM public.client_character_preferences p
  WHERE client_id = auth.uid() AND character_id = current_setting('wp04.target')::uuid), true);
SELECT throws_ok(
  $$SELECT public.remove_character_like(current_setting('wp04.target')::uuid, '00000000-0000-4000-8000-000000040001')$$,
  '42501', 'client_identity_changed', 'A delayed first-client intention cannot clear the new session owner''s Like'
);
SELECT is((SELECT to_jsonb(p) FROM public.client_character_preferences p
  WHERE client_id = auth.uid() AND character_id = current_setting('wp04.target')::uuid),
  current_setting('wp04.other_preference')::jsonb, 'The subject mismatch changes no preference');
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000040002';
SELECT set_config('wp04.other_lead', (SELECT to_jsonb(l)::text FROM public.client_character_leads l
  WHERE client_id = '00000000-0000-4000-8000-000000040005' AND character_id = current_setting('wp04.target')::uuid), true);

SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000040001';
SELECT is(
  (public.set_character_favorite(current_setting('wp04.target')::uuid, true)->>'is_favorite')::boolean,
  TRUE, 'Unlike is exercised with a real saved favorite'
);
SELECT set_config('wp04.liked_card',
  (SELECT card.id::text FROM public.get_discovery_characters('{"city_id":"00000000-0000-4000-8000-000000040102"}') card
   WHERE card.id = current_setting('wp04.target')::uuid AND card.is_liked AND card.is_favorite), true);
SELECT is(current_setting('wp04.liked_card'), current_setting('wp04.target'),
  'Discovery actually returns the liked card that offers Remove Like');
SELECT set_config('wp04.preference', (SELECT to_jsonb(p)::text FROM public.client_character_preferences p
  WHERE client_id = auth.uid() AND character_id = current_setting('wp04.target')::uuid), true);
-- Model a visibility change between rendering the liked card and activating Remove.
RESET ROLE;
CREATE TEMP VIEW wp04_cycle_history AS
SELECT jsonb_agg(jsonb_build_array(to_jsonb(c), to_jsonb(i)) ORDER BY c.id, i.character_id) AS history
FROM public.client_discovery_cycles c
LEFT JOIN public.client_discovery_cycle_items i ON i.cycle_id = c.id
WHERE c.client_id = '00000000-0000-4000-8000-000000040001';
SELECT set_config('wp04.cycles', (SELECT history::text FROM wp04_cycle_history), true);
UPDATE public.characters SET is_visible = false WHERE id = current_setting('wp04.target')::uuid;
SELECT is((SELECT is_visible FROM public.characters WHERE id = current_setting('wp04.target')::uuid),
  false, 'The previously displayed character is now hidden');
SET LOCAL ROLE authenticated;
SELECT ok(current_user = 'authenticated' AND auth.uid() = '00000000-0000-4000-8000-000000040001'::uuid,
  'Remove Like runs as the authenticated client, not the fixture owner');
SELECT is(
  public.remove_character_like(current_setting('wp04.liked_card')::uuid, '00000000-0000-4000-8000-000000040001'),
  jsonb_build_object('character_id', current_setting('wp04.target'), 'is_liked', false, 'idempotent', false),
  'The client can withdraw its own Like even after the character becomes hidden'
);
SELECT is(
  (SELECT to_jsonb(p) - 'updated_at' FROM public.client_character_preferences p
   WHERE client_id = auth.uid() AND character_id = current_setting('wp04.target')::uuid),
  (current_setting('wp04.preference')::jsonb - 'updated_at') || '{"liked_at":null}'::jsonb,
  'Favorite, favorite time, creation, last seen and shown count are preserved'
);
SELECT set_config('wp04.removed_tuple', (SELECT p.ctid::text FROM public.client_character_preferences p
  WHERE client_id = auth.uid() AND character_id = current_setting('wp04.target')::uuid), true);
SELECT is(
  public.remove_character_like(current_setting('wp04.target')::uuid, auth.uid()),
  jsonb_build_object('character_id', current_setting('wp04.target'), 'is_liked', false, 'idempotent', true),
  'Duplicate removal reports already removed'
);
SELECT is(
  (SELECT p.ctid::text FROM public.client_character_preferences p
   WHERE client_id = auth.uid() AND character_id = current_setting('wp04.target')::uuid),
  current_setting('wp04.removed_tuple'), 'Retry does not even rewrite the preference tuple'
);
SELECT is(
  public.remove_character_like('00000000-0000-4000-8000-000000040399', auth.uid()),
  '{"character_id":"00000000-0000-4000-8000-000000040399","is_liked":false,"idempotent":true}'::jsonb,
  'A nonexistent target returns the same no-mark result and echoes only the supplied ID'
);
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000040005';
SELECT is(
  (SELECT to_jsonb(p) FROM public.client_character_preferences p
   WHERE client_id = auth.uid() AND character_id = current_setting('wp04.target')::uuid),
  current_setting('wp04.other_preference')::jsonb, 'The other client retains its entire liked preference'
);
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000040002';
SELECT is(
  (SELECT to_jsonb(l) FROM public.client_character_leads l
   WHERE client_id = '00000000-0000-4000-8000-000000040005' AND character_id = current_setting('wp04.target')::uuid),
  current_setting('wp04.other_lead')::jsonb, 'The other client''s Lead is unchanged'
);
SELECT is(
  (SELECT status FROM public.client_character_leads
   WHERE id = current_setting('wp04.lead_id')::uuid),
  'closed',
  'Unlike closes the Lead while retaining its history'
);
SELECT ok(
  (SELECT NOT interest_active AND closed_at IS NOT NULL FROM public.client_character_leads
   WHERE id = current_setting('wp04.lead_id')::uuid),
  'The unlike trigger clears current interest and records a close timestamp'
);
SELECT set_config(
  'wp07.closed_at',
  (SELECT closed_at::text FROM public.client_character_leads
   WHERE id = current_setting('wp04.lead_id')::uuid),
  true
);
SELECT throws_ok(
  $$SELECT public.update_character_lead_status(current_setting('wp04.lead_id')::uuid, 'in_progress')$$,
  'P0001', 'lead_interest_inactive',
  'Even the assigned operator cannot resume treatment while interest is inactive'
);
RESET ROLE;
SELECT is((SELECT history FROM wp04_cycle_history), current_setting('wp04.cycles')::jsonb,
  'Withdrawal and retry did not consume a card or rewrite the client swipe ledger');
SELECT is((SELECT count(*) FROM public.conversations
  WHERE client_id = '00000000-0000-4000-8000-000000040001'), 0::bigint,
  'No conversation was created by withdrawal');
UPDATE public.characters SET is_visible = true WHERE id = current_setting('wp04.target')::uuid;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000040001';
SELECT ok(
  (SELECT liked_at IS NULL FROM public.client_character_preferences
   WHERE client_id = '00000000-0000-4000-8000-000000040001'
     AND character_id = '00000000-0000-4000-8000-000000040301'),
  'The original preference still exists without a Like'
);
SELECT is(
  (SELECT (public.set_character_swipe(card.id, card.cycle_id, filters.value, 'like')->>'first_like')::boolean
   FROM (VALUES ('{"city_id":"00000000-0000-4000-8000-000000040102"}'::jsonb)) filters(value)
   CROSS JOIN LATERAL public.get_discovery_characters(filters.value) card
   WHERE card.id = '00000000-0000-4000-8000-000000040301' AND card.is_liked IS FALSE),
  TRUE,
  'The client records a fresh Like for that character in its current discovery cycle'
);
SELECT ok(
  (SELECT liked_at IS NOT NULL FROM public.client_character_preferences
   WHERE client_id = '00000000-0000-4000-8000-000000040001'
     AND character_id = '00000000-0000-4000-8000-000000040301'),
  'The Like sets liked_at on the same preference'
);
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000040002';
SELECT is(
  (SELECT status FROM public.client_character_leads
   WHERE id = current_setting('wp04.lead_id')::uuid),
  'closed',
  'A later true Like does not reopen a closed Lead automatically'
);
SELECT ok(
  (SELECT interest_active FROM public.client_character_leads
   WHERE id = current_setting('wp04.lead_id')::uuid),
  'A later true Like records renewed current interest'
);
SELECT is(
  (SELECT closed_at::text FROM public.client_character_leads
   WHERE id = current_setting('wp04.lead_id')::uuid),
  current_setting('wp07.closed_at'),
  'A later true Like preserves the original close audit timestamp'
);
SELECT is(
  (SELECT count(*) FROM public.client_character_leads
   WHERE client_id = '00000000-0000-4000-8000-000000040001'
     AND character_id = '00000000-0000-4000-8000-000000040301'),
  1::bigint,
  'Renewed interest preserves one canonical Lead row'
);
SELECT is(
  (
    SELECT status
    FROM public.update_character_lead_status(
      current_setting('wp04.lead_id')::uuid,
      'in_progress'
    )
  ),
  'in_progress',
  'An assigned operator may explicitly resume an active re-liked Lead'
);
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000040001';
SELECT is((SELECT count(*) FROM public.get_client_consent_requirements()), 0::bigint,
  'With policy off the reader returns no requirements');
SELECT lives_ok(
  $$SELECT public.start_or_get_conversation('00000000-0000-4000-8000-000000040301')$$,
  'Client can create a canonical conversation'
);
RESET ROLE;
SELECT is(
  (SELECT assigned_operator_id FROM public.conversations
   WHERE client_id = '00000000-0000-4000-8000-000000040001'
     AND character_id = '00000000-0000-4000-8000-000000040301'),
  NULL::uuid,
  'Opening a conversation does not bypass WP02 allocation'
);

-- AC11: exercise the same open, send, hide and reopen RPCs as the client.
UPDATE public.system_settings SET value = 'true'::jsonb WHERE key = 'credits_enabled';
UPDATE public.system_settings SET value = '10'::jsonb WHERE key = 'client_text_credit_price';
INSERT INTO public.credit_wallets (user_id, balance)
VALUES ('00000000-0000-4000-8000-000000040001', 20)
ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance;
SELECT set_config('wp04.ac11_conversation', id::text, true)
FROM public.conversations
WHERE client_id = '00000000-0000-4000-8000-000000040001'
  AND character_id = '00000000-0000-4000-8000-000000040301';
SET LOCAL ROLE authenticated;
SELECT set_config('wp04.ac11_message',
  public.send_client_message(current_setting('wp04.ac11_conversation')::uuid,
    'AC11 synthetic original text') -> 'message' ->> 'id', true);
RESET ROLE;
SELECT set_config('wp04.ac11_charge', id::text, true)
FROM public.credit_transactions
WHERE message_id = current_setting('wp04.ac11_message')::uuid AND type = 'message_spend';
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$SELECT public.hide_conversation_for_client(current_setting('wp04.ac11_conversation')::uuid)$$,
  'Client hides their own conversation'
);
RESET ROLE;
SELECT isnt((SELECT client_hidden_at FROM public.conversations
  WHERE id = current_setting('wp04.ac11_conversation')::uuid), NULL::timestamptz,
  'Hide sets the client visibility marker');
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$SELECT public.send_client_message(current_setting('wp04.ac11_conversation')::uuid, 'Hidden text')$$,
  'P0001', 'conversation_deleted_for_client', 'A hidden conversation cannot send before reopening'
);
SELECT is(public.start_or_get_conversation('00000000-0000-4000-8000-000000040301'),
  current_setting('wp04.ac11_conversation')::uuid, 'Reopening returns the original conversation');
SELECT is(public.start_or_get_conversation('00000000-0000-4000-8000-000000040301'),
  current_setting('wp04.ac11_conversation')::uuid, 'Repeating open returns the same conversation');
SELECT is((SELECT content FROM public.messages
  WHERE conversation_id = current_setting('wp04.ac11_conversation')::uuid
    AND id = current_setting('wp04.ac11_message')::uuid),
  'AC11 synthetic original text', 'The client can read the original message after reopening');
RESET ROLE;
SELECT is((SELECT count(*) FROM public.conversations
  WHERE client_id = '00000000-0000-4000-8000-000000040001'
    AND character_id = '00000000-0000-4000-8000-000000040301'),
  1::bigint, 'Hide and reopen do not create a parallel conversation');
SELECT is((SELECT count(*) FROM public.client_conversation_deletions
  WHERE conversation_id = current_setting('wp04.ac11_conversation')::uuid),
  0::bigint, 'Reopening clears the legacy hide marker too');
SELECT is((SELECT balance FROM public.credit_wallets
  WHERE user_id = '00000000-0000-4000-8000-000000040001'),
  10, 'Hide and reopen do not change the balance after the original send');
SELECT is((SELECT array_agg(id) FROM public.credit_transactions
  WHERE user_id = '00000000-0000-4000-8000-000000040001' AND type = 'message_spend'),
  ARRAY[current_setting('wp04.ac11_charge')::uuid], 'The original charge is neither replaced nor duplicated');

-- A status override cannot turn an administrative deletion block into a personal hide.
INSERT INTO public.conversations (id, client_id, character_id, status)
VALUES ('00000000-0000-4000-8000-000000040391', '00000000-0000-4000-8000-000000040001',
  '00000000-0000-4000-8000-000000040302', 'waiting');
INSERT INTO public.conversation_deletion_requests (conversation_id, requested_by, idempotency_key, reason, status)
VALUES ('00000000-0000-4000-8000-000000040391', '00000000-0000-4000-8000-000000040002',
  '00000000-0000-4000-8000-000000040392', 'AC11 synthetic block', 'access_blocked');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.start_or_get_conversation('00000000-0000-4000-8000-000000040302')$$,
  '42501', 'conversation_access_denied', 'A visible status override cannot return a deletion-blocked conversation');
SELECT public.hide_conversation_for_client('00000000-0000-4000-8000-000000040391');
SELECT throws_ok($$SELECT public.start_or_get_conversation('00000000-0000-4000-8000-000000040302')$$,
  '42501', 'conversation_access_denied', 'A hidden status override cannot resume a deletion-blocked conversation');
RESET ROLE;
SELECT is((SELECT count(*) FROM public.client_conversation_deletions
  WHERE conversation_id = '00000000-0000-4000-8000-000000040391'),
  1::bigint, 'A deletion-blocked conversation keeps its hide marker');

SELECT is(
  (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'client_consent_policy_enabled'),
  'false',
  'Consent enforcement remains disabled until approved legal content is configured'
);
SELECT is(private.has_required_client_consents('00000000-0000-4000-8000-000000040001'), TRUE,
  'No acceptance is missing on an empty set; configuration is checked by the caller');
UPDATE public.system_settings SET value = 'true'::jsonb
WHERE key = 'client_consent_policy_enabled';
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000040001';
SELECT throws_like(
  $$SELECT * FROM public.get_client_consent_requirements()$$,
  '%client_consent_policy_unconfigured%',
  'Consent enforcement fails closed when no approved required document is configured'
);
SELECT throws_ok(
  $$SELECT public.start_or_get_conversation('00000000-0000-4000-8000-000000040301')$$,
  '42501', 'client_consent_policy_unconfigured',
  'The business gate distinguishes empty configuration from a missing acceptance'
);
SELECT throws_ok(
  $$SELECT public.remove_character_like(current_setting('wp04.target')::uuid, auth.uid())$$,
  '42501', 'client_consent_policy_unconfigured',
  'Remove Like uses the same fail-closed eligibility gate'
);
RESET ROLE;
-- Transaction-only fixtures: no legal content or real approval.
INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000040004', 'authenticated', 'authenticated',
  'wp04-synthetic-approver@example.invalid', '{}', '{}', now(), now());
INSERT INTO public.user_roles (user_id, role)
VALUES ('00000000-0000-4000-8000-000000040004', 'admin');
INSERT INTO public.client_consent_documents (
  id, consent_key, version, title, document_url, required,
  lifecycle_status, approved_at, approved_by, approval_reference
)
SELECT doc.id::uuid, doc.key, '2026-11-05-approved', doc.title,
  'https://example.invalid/' || doc.key || '/2026-11-05-approved', doc.required,
  'active', now(), '00000000-0000-4000-8000-000000040004'::uuid, 'SYNTHETIC-WP04-TEST-ONLY'
FROM (VALUES
  ('00000000-0000-4000-8000-000000040901', 'terms', 'Approved terms', TRUE),
  ('00000000-0000-4000-8000-000000040902', 'test_second', 'Second test requirement', TRUE),
  ('00000000-0000-4000-8000-000000040903', 'test_optional', 'Optional test document', FALSE)
) AS doc(id, key, title, required);

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000040001';
SELECT is(
  (SELECT count(*) FROM public.get_client_consent_requirements()
   WHERE id = '00000000-0000-4000-8000-000000040901'
     AND required IS TRUE
     AND accepted_at IS NULL),
  1::bigint,
  'The client sees the configured version as an unmet requirement'
);
SELECT throws_like(
  $$SELECT public.start_or_get_conversation('00000000-0000-4000-8000-000000040301')$$,
  '%client_consent_required%',
  'The server gate blocks a client before required consent is accepted'
);
RESET ROLE;
INSERT INTO public.client_consent_acceptances (client_id, document_id) VALUES
  ('00000000-0000-4000-8000-000000040001', '00000000-0000-4000-8000-000000040902'),
  ('00000000-0000-4000-8000-000000040002', '00000000-0000-4000-8000-000000040901');
SELECT is(private.has_required_client_consents('00000000-0000-4000-8000-000000040001'), FALSE,
  'Another client accepting the remaining version does not complete this set');
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$SELECT public.start_or_get_conversation('00000000-0000-4000-8000-000000040301')$$,
  '42501', 'client_consent_required',
  'A configured but partially accepted set has the missing-acceptance error'
);
SELECT is(
  (SELECT document_id FROM public.accept_client_consent(
    '00000000-0000-4000-8000-000000040901'
  )),
  '00000000-0000-4000-8000-000000040901'::uuid,
  'The client records the exact configured consent version'
);
SELECT lives_ok(
  $$SELECT public.accept_client_consent('00000000-0000-4000-8000-000000040901')$$,
  'Consent acceptance is idempotent for the same client and document version'
);
SELECT lives_ok(
  $$SELECT public.start_or_get_conversation('00000000-0000-4000-8000-000000040301')$$,
  'The server gate allows the same client after required consent is recorded'
);
RESET ROLE;
SELECT is(private.has_required_client_consents('00000000-0000-4000-8000-000000040001'), TRUE,
  'All required versions are accepted; the optional version is unnecessary');

-- AC10: keep the original transaction, client history and caller permissions.
SELECT set_config('wp04.ac10_timeout', current_setting('statement_timeout'), true);
SELECT set_config('statement_timeout', LEAST(NULLIF(setting::int, 0), 2000)::text, true)
FROM pg_settings WHERE name = 'statement_timeout';

UPDATE public.characters SET fictional_age = 32, interests = ARRAY['Wp04-Music']
WHERE id = '00000000-0000-4000-8000-000000040301';
UPDATE public.characters SET fictional_age = 32, interests = ARRAY['wp04-quiet']
WHERE id = '00000000-0000-4000-8000-000000040302';
INSERT INTO public.characters (id, name, discovery_city_id, fictional_age, interests, is_active, is_visible) VALUES
  ('00000000-0000-4000-8000-000000040311', 'AC10 unseen', '00000000-0000-4000-8000-000000040102', 42, ARRAY['wp04-fresh'], TRUE, TRUE),
  ('00000000-0000-4000-8000-000000040312', 'AC10 hidden', '00000000-0000-4000-8000-000000040102', 32, ARRAY['wp04-unavailable'], TRUE, FALSE),
  ('00000000-0000-4000-8000-000000040313', 'AC10 inactive', '00000000-0000-4000-8000-000000040102', 32, ARRAY['wp04-unavailable'], FALSE, TRUE);

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000040001';
SELECT set_config('wp04.ac10_filters',
  '{"city_id":"00000000-0000-4000-8000-000000040102","min_age":32,"max_age":32,"max_distance_km":20,"interest":"  WP04-MUSIC  ","favorites_only":true,"recycled_only":true}', true);
SELECT set_config('wp04.ac10_first', COALESCE((
  SELECT to_jsonb(card) FROM public.get_discovery_characters(current_setting('wp04.ac10_filters')::jsonb) card
), '{}'::jsonb)::text, true);
SELECT ok(current_setting('wp04.ac10_first')::jsonb @> jsonb_build_object(
  'id', current_setting('wp04.target'), 'is_recycled', true, 'is_favorite', true, 'is_liked', true),
  'All seven filters return the previously seen favorite at the inclusive age bounds');
SELECT is(public.set_character_swipe(current_setting('wp04.target')::uuid,
  (current_setting('wp04.ac10_first')::jsonb->>'cycle_id')::uuid,
  current_setting('wp04.ac10_filters')::jsonb, 'pass')->>'action', 'pass',
  'The eligible card can be consumed with its own filter snapshot');
SELECT ok((SELECT card.id = current_setting('wp04.target')::uuid AND card.is_recycled AND card.is_favorite
    AND card.cycle_id <> (current_setting('wp04.ac10_first')::jsonb->>'cycle_id')::uuid
    AND card.cycle_number = (current_setting('wp04.ac10_first')::jsonb->>'cycle_number')::int + 1
  FROM public.get_discovery_characters(current_setting('wp04.ac10_filters')::jsonb) card),
  'True exhaustion advances exactly one cycle and returns the eligible recycled card');
SELECT is((SELECT card.id FROM public.get_discovery_characters(
  '{"city_id":"00000000-0000-4000-8000-000000040103","interest":"wp04-quiet"}') card),
  '00000000-0000-4000-8000-000000040302'::uuid, 'Without a radius, unknown coordinates do not exclude a match');
SELECT is(public.set_character_favorite(current_setting('wp04.target')::uuid, false)->>'is_favorite', 'false',
  'Removing the only eligible favorite leaves an existing pending card for the empty-read check');
RESET ROLE;

SELECT set_config('wp04.ac10_cycles', (SELECT history::text FROM wp04_cycle_history), true);
CREATE TEMP VIEW wp04_ac10_preferences AS
SELECT jsonb_agg(to_jsonb(p) ORDER BY p.character_id) AS rows
FROM public.client_character_preferences p WHERE p.client_id = '00000000-0000-4000-8000-000000040001';
SELECT set_config('wp04.ac10_preferences', (SELECT rows::text FROM wp04_ac10_preferences), true);
-- Fail on the first attempted new cycle, without waiting for the time limit on regression.
CREATE FUNCTION pg_temp.wp04_ac10_unexpected_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'unexpected cycle creation during AC10 empty read';
END;
$$;
CREATE TRIGGER wp04_ac10_unexpected_cycle BEFORE INSERT ON public.client_discovery_cycles
FOR EACH ROW WHEN (NEW.client_id = '00000000-0000-4000-8000-000000040001'::uuid)
EXECUTE FUNCTION pg_temp.wp04_ac10_unexpected_cycle();

SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*) FROM public.get_discovery_characters(current_setting('wp04.ac10_filters')::jsonb)),
  0::bigint, 'The pending card no longer satisfies all seven filters');
SELECT is((SELECT count(*) FROM public.get_discovery_characters(
  '{"city_id":"00000000-0000-4000-8000-000000040102","interest":"wp04-unavailable"}')),
  0::bigint, 'Without distance, hidden and inactive interest matches still mean empty');
SELECT is((SELECT count(*) FROM public.get_discovery_characters(
  '{"city_id":"00000000-0000-4000-8000-000000040102","interest":"wp04-fresh","recycled_only":true}')),
  0::bigint, 'A never-shown match cannot manufacture its own recycled history');
SELECT is((SELECT count(*) FROM public.get_discovery_characters(
  '{"city_id":"00000000-0000-4000-8000-000000040103","interest":"wp04-music","max_distance_km":20}')),
  0::bigint, 'A nearby interest match in a different city does not qualify');
SELECT is((SELECT count(*) FROM public.get_discovery_characters(
  '{"city_id":"00000000-0000-4000-8000-000000040102","min_age":42,"interest":"wp04-music","max_distance_km":20}')),
  0::bigint, 'An in-radius interest match below the minimum age does not qualify');
SELECT is((SELECT count(*) FROM public.get_discovery_characters(
  '{"city_id":"00000000-0000-4000-8000-000000040102","max_age":32,"interest":"wp04-fresh","max_distance_km":20}')),
  0::bigint, 'An in-radius interest match above the maximum age does not qualify');
SELECT is((SELECT count(*) FROM public.get_discovery_characters(
  '{"city_id":"00000000-0000-4000-8000-000000040103","interest":"wp04-quiet","max_distance_km":20}')),
  0::bigint, 'With a radius, unknown coordinates exclude the otherwise eligible card');
SELECT is((SELECT count(*) FROM public.get_discovery_characters(
  '{"city_id":"00000000-0000-4000-8000-000000040103","min_age":99}')),
  0::bigint, 'An empty base age and city combination needs no cycle either');
RESET ROLE;
DROP TRIGGER wp04_ac10_unexpected_cycle ON public.client_discovery_cycles;
SELECT is((SELECT history FROM wp04_cycle_history), current_setting('wp04.ac10_cycles')::jsonb,
  'Empty reads preserve every cycle and item, including the pending card and all actions');
SELECT is((SELECT rows FROM wp04_ac10_preferences), current_setting('wp04.ac10_preferences')::jsonb,
  'Empty reads preserve every preference, including shown counts and last-seen times');
SELECT set_config('statement_timeout', current_setting('wp04.ac10_timeout'), true);
-- End AC10 empty-filter cases.

UPDATE public.system_settings SET value = 'true'::jsonb WHERE key = 'mandatory_onboarding_enabled';
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000040001';
SELECT throws_like(
  $$SELECT public.start_or_get_conversation('00000000-0000-4000-8000-000000040301')$$,
  '%client_onboarding_required%',
  'Enabled onboarding gate blocks an incomplete legacy profile at the server boundary'
);

SELECT * FROM finish();
ROLLBACK;
