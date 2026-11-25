BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT no_plan();

SELECT has_function(
  'public', 'update_client_profile_images', ARRAY['text[]', 'text'],
  'Profile image ordering and primary selection use one server RPC'
);
SELECT has_table(
  'private', 'client_profile_image_cleanup_queue',
  'Removed owned images are retained for trusted reference-checked cleanup'
);
SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.update_client_profile_images(text[],text)',
    'EXECUTE'
  ),
  'Authenticated clients can reach the ownership-enforcing image RPC'
);
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.update_client_profile_images(text[],text)',
    'EXECUTE'
  ),
  'Anonymous callers cannot update profile images'
);

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('00000000-0000-4000-8000-000000120001', 'authenticated', 'authenticated', 'profile-images@example.invalid', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000120002', 'authenticated', 'authenticated', 'other-images@example.invalid', 'x', now(), '{}', '{}', now(), now());
-- Label the profiles already created by the auth insert trigger.
UPDATE public.profiles AS profile
SET display_name = fixture.display_name
FROM (VALUES
  ('00000000-0000-4000-8000-000000120001'::uuid, 'Profile images'),
  ('00000000-0000-4000-8000-000000120002'::uuid, 'Other profile')
) AS fixture(user_id, display_name)
WHERE profile.user_id = fixture.user_id;

INSERT INTO storage.objects (id, bucket_id, name, owner_id, metadata)
SELECT
  gen_random_uuid(),
  'user-avatars',
  '00000000-0000-4000-8000-000000120001/avatar-' || number::TEXT || '.webp',
  '00000000-0000-4000-8000-000000120001',
  jsonb_build_object('mimetype', 'image/webp', 'size', 1024)
FROM generate_series(1, 8) number;
INSERT INTO storage.objects (id, bucket_id, name, owner_id, metadata) VALUES (
  gen_random_uuid(),
  'user-avatars',
  '00000000-0000-4000-8000-000000120002/other.webp',
  '00000000-0000-4000-8000-000000120002',
  jsonb_build_object('mimetype', 'image/webp', 'size', 1024)
);
INSERT INTO storage.objects (id, bucket_id, name, owner_id, metadata) VALUES (
  gen_random_uuid(),
  'user-avatars',
  '00000000-0000-4000-8000-000000120001/spoofed-owner.webp',
  '00000000-0000-4000-8000-000000120002',
  jsonb_build_object('mimetype', 'image/webp', 'size', 1024)
);

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000120001';
SELECT lives_ok(
  $$SELECT * FROM public.update_client_profile_images(
    ARRAY[
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-1.webp',
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-2.webp'
    ],
    'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-2.webp'
  )$$,
  'A Client stores ordered owned images and an explicit primary atomically'
);
SELECT is(
  (SELECT profile_image_url FROM public.client_profiles
   WHERE user_id = '00000000-0000-4000-8000-000000120001'),
  'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-2.webp',
  'The selected primary is stored without changing the explicit order'
);
SELECT throws_like(
  $$SELECT * FROM public.update_client_profile_images(
    ARRAY[
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120002/other.webp'
    ],
    'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120002/other.webp'
  )$$,
  '%profile_image_not_owned%',
  'A Client cannot reference another user folder even when the object exists'
);
SELECT throws_like(
  $$SELECT * FROM public.update_client_profile_images(
    ARRAY[
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/spoofed-owner.webp'
    ],
    'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/spoofed-owner.webp'
  )$$,
  '%profile_image_not_owned%',
  'A matching URL folder is insufficient when the Storage object owner differs'
);
SELECT throws_like(
  $$SELECT * FROM public.update_client_profile_images(
    ARRAY[
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-1.webp',
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-2.webp',
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-3.webp',
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-4.webp',
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-5.webp',
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-6.webp',
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-7.webp'
    ],
    'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-1.webp'
  )$$,
  '%profile_image_limit_exceeded%',
  'A current profile cannot add a seventh image'
);
RESET ROLE;

-- Simulate a pre-existing legacy row without weakening the production guard.
ALTER TABLE public.client_profiles DISABLE TRIGGER validate_client_profile_images;
UPDATE public.client_profiles
SET profile_image_urls = ARRAY[
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-1.webp',
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-2.webp',
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-3.webp',
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-4.webp',
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-5.webp',
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-6.webp',
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-7.webp'
    ],
    profile_image_url = 'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-1.webp'
WHERE user_id = '00000000-0000-4000-8000-000000120001';
ALTER TABLE public.client_profiles ENABLE TRIGGER validate_client_profile_images;

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000120001';
SELECT lives_ok(
  $$SELECT * FROM public.update_client_profile_images(
    ARRAY[
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-2.webp',
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-1.webp',
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-3.webp',
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-4.webp',
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-5.webp',
      'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-6.webp'
    ],
    'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-2.webp'
  )$$,
  'A legacy profile may reorder, choose a primary and remove images down to the limit'
);
RESET ROLE;

SELECT is(
  (SELECT avatar_url FROM public.profiles
   WHERE user_id = '00000000-0000-4000-8000-000000120001'),
  'https://project.invalid/storage/v1/object/public/user-avatars/00000000-0000-4000-8000-000000120001/avatar-2.webp',
  'The public avatar projection follows the committed primary image'
);
SELECT is(
  (SELECT count(*) FROM private.client_profile_image_cleanup_queue
   WHERE owner_user_id = '00000000-0000-4000-8000-000000120001'
     AND object_path LIKE '%/avatar-7.webp'
     AND status = 'pending_reference_check'),
  1::bigint,
  'A removed owned object is retained for reference-checked cleanup rather than deleted by URL'
);

SELECT * FROM finish();
ROLLBACK;
