BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT plan(17);

SELECT has_function(
  'public', 'claim_client_profile_image_cleanup_for_server', ARRAY['integer'],
  'Profile image cleanup uses a bounded server claim'
);
SELECT has_function(
  'public', 'authorize_client_profile_image_cleanup_for_server', ARRAY['uuid', 'uuid'],
  'Profile removal is re-authorized against current references before Storage I/O'
);
SELECT has_function(
  'public', 'complete_client_profile_image_cleanup_for_server', ARRAY['uuid', 'uuid'],
  'Profile cleanup completion is fenced by its claim token'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.claim_client_profile_image_cleanup_for_server(integer)',
    'EXECUTE'
  ),
  'Clients cannot claim profile image cleanup work'
);

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000130001', 'authenticated', 'authenticated',
  'wp06b-client@example.invalid', 'x', now(), '{}', '{}', now(), now()
);
-- Label the profile already created by the auth insert trigger.
UPDATE public.profiles
SET display_name = 'WP06-B client'
WHERE user_id = '00000000-0000-4000-8000-000000130001';
INSERT INTO public.characters (id, name)
VALUES ('00000000-0000-4000-8000-000000130201', 'WP06-B character');
INSERT INTO public.conversations (id, client_id, character_id)
VALUES (
  '00000000-0000-4000-8000-000000130301',
  '00000000-0000-4000-8000-000000130001',
  '00000000-0000-4000-8000-000000130201'
);
INSERT INTO storage.objects (id, bucket_id, name, owner_id, metadata) VALUES
  ('00000000-0000-4000-8000-000000130401', 'user-avatars',
   '00000000-0000-4000-8000-000000130001/removed.webp',
   '00000000-0000-4000-8000-000000130001',
   '{"mimetype":"image/webp","size":1024}'::jsonb),
  ('00000000-0000-4000-8000-000000130402', 'user-avatars',
   '00000000-0000-4000-8000-000000130001/active.webp',
   '00000000-0000-4000-8000-000000130001',
   '{"mimetype":"image/webp","size":1024}'::jsonb),
  ('00000000-0000-4000-8000-000000130403', 'user-avatars',
   '00000000-0000-4000-8000-000000130001/retry.webp',
   '00000000-0000-4000-8000-000000130001',
   '{"mimetype":"image/webp","size":1024}'::jsonb);

-- Each image save RPC normally commits its avatar projection before the next RPC.
SET CONSTRAINTS public.sync_client_profile_avatar IMMEDIATE;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000130001';
SELECT lives_ok(
  $$SELECT * FROM public.update_client_profile_images(
    ARRAY['https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000130001/removed.webp'],
    'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000130001/removed.webp'
  )$$,
  'The owned profile image is installed through the canonical update contract'
);
SELECT lives_ok(
  $$SELECT * FROM public.update_client_profile_images('{}'::text[], NULL)$$,
  'Removing the profile reference enqueues rather than deleting Storage bytes'
);
RESET ROLE;

-- Capture private fixture state before entering the worker role.
DO $$
DECLARE
  _queue_id uuid;
  _status text;
BEGIN
  SELECT id, status INTO STRICT _queue_id, _status
  FROM private.client_profile_image_cleanup_queue
  WHERE owner_user_id = '00000000-0000-4000-8000-000000130001'
    AND bucket_id = 'user-avatars'
    AND object_path = '00000000-0000-4000-8000-000000130001/removed.webp';
  IF _status IS DISTINCT FROM 'pending_reference_check' THEN
    RAISE EXCEPTION 'WP06B removed.webp: expected pending_reference_check, got %', _status;
  END IF;
  PERFORM set_config('wp06b.profile_queue_id', _queue_id::text, true);
END;
$$;
SET LOCAL ROLE service_role;
SET LOCAL "request.jwt.claim.role" = 'service_role';
DO $$
DECLARE
  _token uuid;
BEGIN
  SELECT claim_token INTO STRICT _token
  FROM public.claim_client_profile_image_cleanup_for_server(25)
  WHERE queue_id = current_setting('wp06b.profile_queue_id')::uuid
    AND claim_token IS NOT NULL;
  PERFORM set_config('wp06b.profile_token', _token::text, true);
END;
$$;
SELECT is(
  public.authorize_client_profile_image_cleanup_for_server(
    current_setting('wp06b.profile_queue_id')::uuid,
    current_setting('wp06b.profile_token')::uuid
  ),
  'delete',
  'An unreferenced, canonically owned Storage object is authorized for removal'
);
SELECT throws_like(
  format(
    'SELECT public.complete_client_profile_image_cleanup_for_server(%L::uuid,%L::uuid)',
    current_setting('wp06b.profile_queue_id'), current_setting('wp06b.profile_token')
  ),
  'profile_image_storage_object_still_present',
  'A successful remove call alone cannot mark a still-present object deleted'
);
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000130001';
SELECT throws_like(
  $$SELECT * FROM public.update_client_profile_images(
    ARRAY['https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000130001/removed.webp'],
    'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000130001/removed.webp'
  )$$,
  '%profile_image_cleanup_in_progress%',
  'A re-add cannot race after the worker has acquired the deletion claim'
);
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000130001';
SELECT lives_ok(
  $$SELECT * FROM public.update_client_profile_images(
    ARRAY['https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000130001/active.webp'],
    'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000130001/active.webp'
  )$$,
  'A second owned image becomes active'
);
RESET ROLE;
INSERT INTO private.client_profile_image_cleanup_queue (
  owner_user_id, object_path, source_url
) VALUES (
  '00000000-0000-4000-8000-000000130001',
  '00000000-0000-4000-8000-000000130001/active.webp',
  'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000130001/active.webp'
);
SET LOCAL ROLE service_role;
SET LOCAL "request.jwt.claim.role" = 'service_role';
SELECT is(
  (SELECT count(*) FROM public.claim_client_profile_image_cleanup_for_server(25)
   WHERE owner_user_id = '00000000-0000-4000-8000-000000130001'
     AND bucket_id = 'user-avatars'
     AND object_path = '00000000-0000-4000-8000-000000130001/active.webp'),
  0::bigint,
  'An active profile or avatar reference is never returned to the Storage worker'
);
RESET ROLE;
SELECT is(
  (SELECT status FROM private.client_profile_image_cleanup_queue
   WHERE owner_user_id = '00000000-0000-4000-8000-000000130001'
     AND bucket_id = 'user-avatars'
     AND object_path = '00000000-0000-4000-8000-000000130001/active.webp'),
  'retained',
  'The active reference is retained with durable queue state'
);

-- A stale worker cannot complete a replacement claim.
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000130001';
SELECT lives_ok(
  $$SELECT * FROM public.update_client_profile_images(
    ARRAY['https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000130001/retry.webp'],
    'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000130001/retry.webp'
  )$$,
  'The retry fixture becomes active'
);
SELECT lives_ok(
  $$SELECT * FROM public.update_client_profile_images('{}'::text[], NULL)$$,
  'The retry fixture is queued after removal'
);
RESET ROLE;
DO $$
DECLARE
  _queue_id uuid;
  _status text;
BEGIN
  SELECT id, status INTO STRICT _queue_id, _status
  FROM private.client_profile_image_cleanup_queue
  WHERE owner_user_id = '00000000-0000-4000-8000-000000130001'
    AND bucket_id = 'user-avatars'
    AND object_path = '00000000-0000-4000-8000-000000130001/retry.webp';
  IF _status IS DISTINCT FROM 'pending_reference_check' THEN
    RAISE EXCEPTION 'WP06B retry.webp: expected pending_reference_check, got %', _status;
  END IF;
  PERFORM set_config('wp06b.retry_queue_id', _queue_id::text, true);
END;
$$;
SET LOCAL ROLE service_role;
SET LOCAL "request.jwt.claim.role" = 'service_role';
DO $$
DECLARE
  _token uuid;
BEGIN
  SELECT claim_token INTO STRICT _token
  FROM public.claim_client_profile_image_cleanup_for_server(25)
  WHERE queue_id = current_setting('wp06b.retry_queue_id')::uuid
    AND claim_token IS NOT NULL;
  PERFORM set_config('wp06b.old_token', _token::text, true);
END;
$$;
RESET ROLE;
UPDATE private.client_profile_image_cleanup_queue
SET claim_expires_at = clock_timestamp() - interval '1 second'
WHERE id = current_setting('wp06b.retry_queue_id')::uuid;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  _token uuid;
BEGIN
  SELECT claim_token INTO STRICT _token
  FROM public.claim_client_profile_image_cleanup_for_server(25)
  WHERE queue_id = current_setting('wp06b.retry_queue_id')::uuid
    AND claim_token IS NOT NULL;
  PERFORM set_config('wp06b.new_token', _token::text, true);
END;
$$;
SELECT isnt(
  current_setting('wp06b.old_token'),
  current_setting('wp06b.new_token'),
  'A reclaimed lease receives a new fencing token'
);
SELECT throws_like(
  format(
    'SELECT public.complete_client_profile_image_cleanup_for_server(%L::uuid,%L::uuid)',
    current_setting('wp06b.retry_queue_id'), current_setting('wp06b.old_token')
  ),
  'profile_image_cleanup_claim_not_found',
  'The old worker cannot complete the replacement claim'
);
RESET ROLE;

-- The client-media completion boundary independently verifies physical absence.
INSERT INTO public.client_media_uploads (
  id, client_id, conversation_id, source_path, preview_path, content_type, upload_expires_at
) VALUES (
  '00000000-0000-4000-8000-000000130601',
  '00000000-0000-4000-8000-000000130001',
  '00000000-0000-4000-8000-000000130301',
  'clients/00000000-0000-4000-8000-000000130001/conversations/00000000-0000-4000-8000-000000130301/uploads/00000000-0000-4000-8000-000000130601/source.webp',
  'clients/00000000-0000-4000-8000-000000130001/conversations/00000000-0000-4000-8000-000000130301/uploads/00000000-0000-4000-8000-000000130601/preview.webp',
  'image/webp',
  clock_timestamp() - interval '1 minute'
);
INSERT INTO storage.objects (id, bucket_id, name, owner_id, metadata) VALUES (
  '00000000-0000-4000-8000-000000130602', 'client-media',
  'clients/00000000-0000-4000-8000-000000130001/conversations/00000000-0000-4000-8000-000000130301/uploads/00000000-0000-4000-8000-000000130601/source.webp',
  '00000000-0000-4000-8000-000000130001',
  '{"mimetype":"image/webp","size":1024}'::jsonb
);
SET LOCAL ROLE service_role;
SET LOCAL "request.jwt.claim.role" = 'service_role';
DO $$
DECLARE
  _token uuid;
BEGIN
  SELECT claim_token INTO STRICT _token
  FROM public.claim_expired_client_media_cleanup_for_server(25)
  WHERE upload_id = '00000000-0000-4000-8000-000000130601'
    AND claim_token IS NOT NULL;
  PERFORM set_config('wp06b.client_token', _token::text, true);
END;
$$;
SELECT throws_like(
  format(
    'SELECT public.complete_client_media_cleanup_for_server(%L::uuid,%L::uuid)',
    '00000000-0000-4000-8000-000000130601', current_setting('wp06b.client_token')
  ),
  'client_media_storage_object_still_present',
  'Expired or abandoned client media is not marked deleted while a recorded object remains'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
