BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT plan(41);

SELECT has_table('public', 'client_media_uploads', 'WP06 client uploads have a durable lifecycle table');
SELECT has_column('public', 'message_attachments', 'client_upload_id', 'Attachments can reference a client upload');
SELECT has_column('public', 'message_attachments', 'access_expires_at', 'Client attachment access has a server timestamp');
SELECT has_function('public', 'create_client_media_upload_intent', ARRAY['uuid', 'text'], 'Upload intent RPC is installed');
SELECT has_function('public', 'claim_client_media_finalize_for_server', ARRAY['uuid', 'uuid'], 'Finalize claims are fenced before Storage I/O');
SELECT has_function('public', 'renew_client_media_finalize_claim_for_server', ARRAY['uuid', 'uuid'], 'Finalize claims can be renewed before derivative writes');
SELECT has_function('public', 'fail_client_media_finalize_for_server', ARRAY['uuid', 'uuid', 'text'], 'Failed finalize claims can be released safely');
SELECT has_function('public', 'mark_client_media_finalize_artifact_for_cleanup_for_server', ARRAY['uuid', 'uuid', 'text'], 'Late derivative artifacts can be durably requeued');
SELECT has_function('public', 'finalize_client_media_upload_for_server', ARRAY['uuid', 'uuid', 'text', 'text', 'bigint', 'uuid'], 'Finalize RPC requires the processing claim token');
SELECT has_function('public', 'claim_expired_client_media_cleanup_for_server', ARRAY['integer'], 'Cleanup claim RPC is installed');

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000060001', 'authenticated', 'authenticated',
  'wp06-client@example.invalid', 'x', now(), '{}', '{}', now(), now()
);
INSERT INTO public.characters (id, name)
VALUES ('00000000-0000-4000-8000-000000060201', 'WP06 character');
INSERT INTO public.conversations (id, client_id, character_id)
VALUES (
  '00000000-0000-4000-8000-000000060301',
  '00000000-0000-4000-8000-000000060001',
  '00000000-0000-4000-8000-000000060201'
);
INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned)
VALUES ('00000000-0000-4000-8000-000000060001', 20, 20);

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000060001';
SELECT set_config(
  'wp06.upload_id',
  (SELECT upload_id::text FROM public.create_client_media_upload_intent(
    '00000000-0000-4000-8000-000000060301', 'image/webp'
  )),
  true
);
SELECT throws_like(
  $$SELECT * FROM public.create_client_media_upload_intent(
    '00000000-0000-4000-8000-000000060301', 'image/svg+xml'
  )$$,
  'client_media_content_type_not_allowed',
  'Unsupported client media is rejected before finalize'
);
RESET ROLE;

SET LOCAL ROLE service_role;
SET LOCAL "request.jwt.claim.role" = 'service_role';
SELECT set_config(
  'wp06.finalize_claim_token',
  (SELECT claim_token::text FROM public.claim_client_media_finalize_for_server(
    '00000000-0000-4000-8000-000000060001', current_setting('wp06.upload_id')::uuid
  )),
  true
);
SELECT set_config(
  'wp06.finalize',
  public.finalize_client_media_upload_for_server(
    '00000000-0000-4000-8000-000000060001', current_setting('wp06.upload_id')::uuid,
    'wp06-finalize-1', 'image/webp', 2048, current_setting('wp06.finalize_claim_token')::uuid
  )::text,
  true
);
SELECT is(
  (public.finalize_client_media_upload_for_server(
    '00000000-0000-4000-8000-000000060001', current_setting('wp06.upload_id')::uuid,
    'wp06-finalize-1', 'image/webp', 2048
  )->>'already_finalized')::boolean,
  true,
  'Finalize retry returns the original result without a second write'
);
SELECT is(
  public.finalize_client_media_upload_for_server(
    '00000000-0000-4000-8000-000000060001', current_setting('wp06.upload_id')::uuid,
    'wp06-finalize-1', 'image/webp', 2048
  )->'message'->>'id',
  current_setting('wp06.finalize')::jsonb->'message'->>'id',
  'Finalize retry returns the original message contract after a lost response'
);
SELECT is(
  public.finalize_client_media_upload_for_server(
    '00000000-0000-4000-8000-000000060001', current_setting('wp06.upload_id')::uuid,
    'wp06-finalize-1', 'image/webp', 2048
  )->'attachment'->>'id',
  current_setting('wp06.finalize')::jsonb->'attachment'->>'id',
  'Finalize retry returns the original attachment contract after a lost response'
);
RESET ROLE;

SELECT is((SELECT balance FROM public.credit_wallets WHERE user_id = '00000000-0000-4000-8000-000000060001'), 10, 'Finalize charges exactly ten credits once');
SELECT results_eq(
  $$SELECT amount, reason, message_id, message_attachment_id
    FROM public.credit_transactions WHERE user_id = '00000000-0000-4000-8000-000000060001'$$,
  $$SELECT -10, 'Client image spend'::text,
      (current_setting('wp06.finalize')::jsonb->'message'->>'id')::uuid,
      (current_setting('wp06.finalize')::jsonb->'attachment'->>'id')::uuid$$,
  'Finalize creates exactly one linked credit transaction for the client'
);
SELECT results_eq(
  $$SELECT id, sender_type::text, sender_id, content
    FROM public.messages WHERE conversation_id = '00000000-0000-4000-8000-000000060301'$$,
  $$SELECT (current_setting('wp06.finalize')::jsonb->'message'->>'id')::uuid, 'client'::text,
      '00000000-0000-4000-8000-000000060001'::uuid, '[image]'::text$$,
  'Finalize creates exactly one client image message in the conversation'
);
SELECT ok(
  (current_setting('wp06.finalize')::jsonb->>'access_expires_at')::timestamptz
    <= (current_setting('wp06.finalize')::jsonb->'message'->>'created_at')::timestamptz + interval '24 hours',
  'The durable access deadline is bounded to 24 hours from the message'
);

SET LOCAL ROLE service_role;
SET LOCAL "request.jwt.claim.role" = 'service_role';
SELECT ok(
  (public.resolve_message_attachment_media_for_server(
    '00000000-0000-4000-8000-000000060001',
    (current_setting('wp06.finalize')::jsonb->'attachment'->>'id')::uuid
  )->>'ttl_seconds')::integer <= 300,
  'A signed URL request is capped below the remaining access window'
);
SELECT is(
  (SELECT count(*) FROM public.claim_expired_client_media_cleanup_for_server(25)
   WHERE upload_id = current_setting('wp06.upload_id')::uuid),
  0::bigint,
  'Finalized media is not claimed before its access window expires'
);
RESET ROLE;

UPDATE public.message_attachments
SET access_expires_at = clock_timestamp() - interval '1 second'
WHERE id = (current_setting('wp06.finalize')::jsonb->'attachment'->>'id')::uuid;
UPDATE public.client_media_uploads
SET access_expires_at = clock_timestamp() - interval '1 second',
    next_cleanup_at = clock_timestamp() - interval '1 second'
WHERE id = current_setting('wp06.upload_id')::uuid;

SET LOCAL ROLE service_role;
SET LOCAL "request.jwt.claim.role" = 'service_role';
SELECT is(
  public.resolve_message_attachment_media_for_server(
    '00000000-0000-4000-8000-000000060001',
    (current_setting('wp06.finalize')::jsonb->'attachment'->>'id')::uuid
  ),
  NULL::jsonb,
  'Expired client media cannot be resolved even before physical cleanup'
);
SELECT is(
  (SELECT count(*) FROM public.claim_expired_client_media_cleanup_for_server(25)
   WHERE upload_id = current_setting('wp06.upload_id')::uuid),
  1::bigint,
  'Expired media is claimed once for physical cleanup'
);
SELECT set_config(
  'wp06.claim_token',
  (SELECT cleanup_claim_token::text FROM public.client_media_uploads
   WHERE id = current_setting('wp06.upload_id')::uuid),
  true
);
SELECT lives_ok(
  format(
    'SELECT public.fail_client_media_cleanup_for_server(%L::uuid, %L::uuid, %L)',
    current_setting('wp06.upload_id'), current_setting('wp06.claim_token'), 'synthetic_storage_failure'
  ),
  'A Storage failure remains retryable and does not claim deletion'
);
RESET ROLE;

SELECT results_eq(
  $$SELECT status, cleanup_attempts, cleanup_error_code
    FROM public.client_media_uploads
    WHERE id = current_setting('wp06.upload_id')::uuid$$,
  $$VALUES ('cleanup_failed'::text, 1, 'synthetic_storage_failure'::text)$$,
  'Cleanup failure preserves explicit retry state and evidence'
);

SET LOCAL ROLE service_role;
SET LOCAL "request.jwt.claim.role" = 'service_role';
SELECT is(
  (SELECT count(*) FROM public.claim_expired_client_media_cleanup_for_server(25)
   WHERE upload_id = current_setting('wp06.upload_id')::uuid),
  0::bigint,
  'Failed finalized-media cleanup is not retried before next_cleanup_at'
);
UPDATE public.client_media_uploads
SET next_cleanup_at = clock_timestamp() - interval '1 second'
WHERE id = current_setting('wp06.upload_id')::uuid;
SELECT set_config(
  'wp06.sent_retry_token',
  (SELECT claim_token::text FROM public.claim_expired_client_media_cleanup_for_server(25)
   WHERE upload_id = current_setting('wp06.upload_id')::uuid),
  true
);
SELECT isnt(
  current_setting('wp06.sent_retry_token'),
  current_setting('wp06.claim_token'),
  'Failed finalized-media cleanup receives a new retry token when due'
);
SELECT lives_ok(
  format(
    'SELECT public.fail_client_media_cleanup_for_server(%L::uuid, %L::uuid, %L)',
    current_setting('wp06.upload_id'), current_setting('wp06.sent_retry_token'), 'synthetic_storage_failure_again'
  ),
  'Finalized-media cleanup remains retryable after its access window'
);
RESET ROLE;

-- An upload that never finalized is still durable cleanup work. A renewed
-- lease fences the interrupted worker, while repeated Storage removal remains
-- safe before the current worker persists completion.
INSERT INTO public.client_media_uploads (
  id, client_id, conversation_id, source_path, preview_path, content_type, upload_expires_at
) VALUES (
  '00000000-0000-4000-8000-000000060401',
  '00000000-0000-4000-8000-000000060001',
  '00000000-0000-4000-8000-000000060301',
  'clients/00000000-0000-4000-8000-000000060001/conversations/00000000-0000-4000-8000-000000060301/uploads/00000000-0000-4000-8000-000000060401/source.webp',
  'clients/00000000-0000-4000-8000-000000060001/conversations/00000000-0000-4000-8000-000000060301/uploads/00000000-0000-4000-8000-000000060401/preview.webp',
  'image/webp',
  clock_timestamp() - interval '1 minute'
);

SET LOCAL ROLE service_role;
SET LOCAL "request.jwt.claim.role" = 'service_role';
SELECT set_config(
  'wp06.abandoned_token',
  (SELECT claim_token::text FROM public.claim_expired_client_media_cleanup_for_server(25)
   WHERE upload_id = '00000000-0000-4000-8000-000000060401'),
  true
);
SELECT is(
  (SELECT status FROM public.client_media_uploads
   WHERE id = '00000000-0000-4000-8000-000000060401'),
  'cleanup_in_progress',
  'An expired pending upload is claimed for physical cleanup'
);
SELECT throws_like(
  $$SELECT public.finalize_client_media_upload_for_server(
    '00000000-0000-4000-8000-000000060001',
    '00000000-0000-4000-8000-000000060401',
    'late-finalize', 'image/webp', 100
  )$$,
  'client_media_upload_expired_or_changed',
  'Finalize cannot race past an abandoned-upload cleanup claim'
);
SELECT lives_ok(
  format(
    'SELECT public.fail_client_media_cleanup_for_server(%L::uuid, %L::uuid, %L)',
    '00000000-0000-4000-8000-000000060401', current_setting('wp06.abandoned_token'), 'synthetic_abandoned_cleanup_failure'
  ),
  'An abandoned-upload cleanup failure is recorded for bounded retry'
);
SELECT is(
  (SELECT count(*) FROM public.claim_expired_client_media_cleanup_for_server(25)
   WHERE upload_id = '00000000-0000-4000-8000-000000060401'),
  0::bigint,
  'An abandoned upload is not reclaimed before its cleanup backoff expires'
);
UPDATE public.client_media_uploads
SET next_cleanup_at = clock_timestamp() - interval '1 second'
WHERE id = '00000000-0000-4000-8000-000000060401';
SELECT set_config(
  'wp06.reclaimed_token',
  (SELECT claim_token::text FROM public.claim_expired_client_media_cleanup_for_server(25)
   WHERE upload_id = '00000000-0000-4000-8000-000000060401'),
  true
);
SELECT isnt(
  current_setting('wp06.reclaimed_token'),
  current_setting('wp06.abandoned_token'),
  'A stale cleanup lease is recovered with a new worker token'
);
SELECT throws_like(
  format(
    'SELECT public.complete_client_media_cleanup_for_server(%L::uuid, %L::uuid)',
    '00000000-0000-4000-8000-000000060401', current_setting('wp06.abandoned_token')
  ),
  'client_media_cleanup_claim_not_found',
  'An interrupted worker cannot complete a replacement claim'
);
SELECT lives_ok(
  format(
    'SELECT public.complete_client_media_cleanup_for_server(%L::uuid, %L::uuid)',
    '00000000-0000-4000-8000-000000060401', current_setting('wp06.reclaimed_token')
  ),
  'The current worker can persist completion after idempotent Storage removal'
);
SELECT is(
  (SELECT status FROM public.client_media_uploads
   WHERE id = '00000000-0000-4000-8000-000000060401'),
  'deleted',
  'Recovered cleanup records the abandoned upload as deleted'
);

-- Processing owns the Storage write lease. Cleanup may replace it only after
-- both the upload and processing lease expire; the old finalize token then
-- cannot commit and can durably requeue a derivative written after cleanup.
INSERT INTO public.client_media_uploads (
  id, client_id, conversation_id, source_path, preview_path, content_type, upload_expires_at
) VALUES (
  '00000000-0000-4000-8000-000000060402',
  '00000000-0000-4000-8000-000000060001',
  '00000000-0000-4000-8000-000000060301',
  'clients/00000000-0000-4000-8000-000000060001/conversations/00000000-0000-4000-8000-000000060301/uploads/00000000-0000-4000-8000-000000060402/source.webp',
  'clients/00000000-0000-4000-8000-000000060001/conversations/00000000-0000-4000-8000-000000060301/uploads/00000000-0000-4000-8000-000000060402/preview.webp',
  'image/webp',
  clock_timestamp() + interval '5 minutes'
);
SELECT set_config(
  'wp06.processing_token',
  (SELECT claim_token::text FROM public.claim_client_media_finalize_for_server(
    '00000000-0000-4000-8000-000000060001', '00000000-0000-4000-8000-000000060402'
  )),
  true
);
SELECT is(
  (SELECT count(*) FROM public.claim_expired_client_media_cleanup_for_server(25)
   WHERE upload_id = '00000000-0000-4000-8000-000000060402'),
  0::bigint,
  'Active finalize processing prevents cleanup from deleting Storage objects'
);
UPDATE public.client_media_uploads
SET upload_expires_at = clock_timestamp() - interval '1 second',
    finalize_claim_expires_at = clock_timestamp() - interval '1 second'
WHERE id = '00000000-0000-4000-8000-000000060402';
SELECT set_config(
  'wp06.processing_cleanup_token',
  (SELECT claim_token::text FROM public.claim_expired_client_media_cleanup_for_server(25)
   WHERE upload_id = '00000000-0000-4000-8000-000000060402'),
  true
);
SELECT isnt(
  current_setting('wp06.processing_cleanup_token'),
  current_setting('wp06.processing_token'),
  'Expired processing is claimed by cleanup with an independent worker token'
);
SELECT throws_like(
  format(
    'SELECT public.finalize_client_media_upload_for_server(%L::uuid,%L::uuid,%L,%L,%L,%L::uuid)',
    '00000000-0000-4000-8000-000000060001', '00000000-0000-4000-8000-000000060402',
    'late-processing', 'image/webp', 100, current_setting('wp06.processing_token')
  ),
  'client_media_upload_expired_or_changed',
  'A stale finalize worker cannot commit after cleanup replaces its lease'
);
SELECT lives_ok(
  format(
    'SELECT public.complete_client_media_cleanup_for_server(%L::uuid,%L::uuid)',
    '00000000-0000-4000-8000-000000060402', current_setting('wp06.processing_cleanup_token')
  ),
  'The current cleanup worker records physical deletion'
);
SELECT lives_ok(
  format(
    'SELECT public.mark_client_media_finalize_artifact_for_cleanup_for_server(%L::uuid,%L::uuid,%L)',
    '00000000-0000-4000-8000-000000060402', current_setting('wp06.processing_token'),
    'synthetic_late_preview'
  ),
  'A late preview recreated by the stale worker is durably requeued'
);
SELECT is(
  (SELECT status FROM public.client_media_uploads
   WHERE id = '00000000-0000-4000-8000-000000060402'),
  'cleanup_failed',
  'A recreated preview cannot remain hidden behind a deleted database row'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
