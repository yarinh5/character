BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;

SELECT plan(10);

SET LOCAL ROLE anon;
SET LOCAL "request.jwt.claim.role" = 'anon';
SET LOCAL "request.jwt.claim.sub" = '';

SELECT is(current_user::text, 'anon'::text, 'Media ACL checks run as anon');
SELECT ok(auth.uid() IS NULL, 'Anonymous JWT has no auth.uid');
SELECT ok(
  NOT has_function_privilege(current_user, 'public.get_operator_media_catalog(uuid)'::regprocedure, 'EXECUTE'),
  'Anonymous role cannot execute the Operator media catalog'
);
SELECT ok(
  NOT has_function_privilege(current_user, 'public.reserve_character_media_asset(uuid,uuid)'::regprocedure, 'EXECUTE'),
  'Anonymous role cannot execute the standard media reservation RPC'
);
SELECT ok(
  NOT has_function_privilege(current_user, 'public.reserve_character_media_for_delivery(uuid,uuid,text)'::regprocedure, 'EXECUTE'),
  'Anonymous role cannot execute the delivery-mode media reservation RPC'
);
SELECT ok(
  NOT has_function_privilege(current_user, 'public.get_message_attachment_access(uuid[])'::regprocedure, 'EXECUTE'),
  'Anonymous role cannot inspect message attachment access'
);
SELECT ok(
  NOT has_function_privilege(current_user, 'public.open_free_view_once_attachment(uuid,uuid)'::regprocedure, 'EXECUTE'),
  'Anonymous role cannot open a View Once attachment'
);
SELECT ok(
  NOT has_function_privilege(current_user, 'public.complete_free_view_once_attachment(uuid)'::regprocedure, 'EXECUTE'),
  'Anonymous role cannot complete a View Once attachment'
);

RESET ROLE;

SELECT is(
  (SELECT public FROM storage.buckets WHERE id = 'character-media'),
  false,
  'Character media bucket remains private'
);
SELECT is(
  (
    SELECT count(*)
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND roles && ARRAY['anon'::name, 'authenticated'::name]
      AND (COALESCE(qual, '') ILIKE '%character-media%' OR COALESCE(with_check, '') ILIKE '%character-media%')
  ),
  0::bigint,
  'No anon or authenticated Storage policy grants direct character-media access'
);

SELECT * FROM finish();
ROLLBACK;
