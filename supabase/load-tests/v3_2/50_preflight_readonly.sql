BEGIN TRANSACTION READ ONLY;

SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '1s';

-- This script is intentionally read-only. Run it only against the disposable
-- load project named in the fixture manifest, never against QA or production.
WITH constants AS (
  SELECT 'load_v3_2_20260731_pilot_01'::text AS run_id,
         'micmgokyckvfpewxgrzf'::text AS target_project_ref
),
run AS (
  SELECT r.*
  FROM load_v3_2.fixture_runs r
  JOIN constants c ON c.run_id = r.run_id
),
manifest AS (
  SELECT m.*
  FROM load_v3_2.fixture_manifest m
  JOIN constants c ON c.run_id = m.run_id
),
expected_actual AS (
  SELECT 'clients'::text AS check_name,
         (SELECT (expected_counts ->> 'clients')::bigint FROM run) AS expected_count,
         (SELECT count(*) FROM public.client_profiles p
          WHERE p.id IN (SELECT unnest(ids) FROM manifest WHERE entity_type = 'client_profiles')) AS actual_count
  UNION ALL SELECT 'operators',
         (SELECT (expected_counts ->> 'operators')::bigint FROM run),
         (SELECT count(*) FROM public.operators o WHERE o.id IN (SELECT unnest(ids) FROM manifest WHERE entity_type = 'operators'))
  UNION ALL SELECT 'characters',
         (SELECT (expected_counts ->> 'characters')::bigint FROM run),
         (SELECT count(*) FROM public.characters ch WHERE ch.id IN (SELECT unnest(ids) FROM manifest WHERE entity_type = 'characters'))
  UNION ALL SELECT 'character_operator_assignments',
         (SELECT (expected_counts ->> 'character_operator_assignments')::bigint FROM run),
         (SELECT count(*) FROM public.character_operator_assignments a WHERE a.id IN (SELECT unnest(ids) FROM manifest WHERE entity_type = 'character_operator_assignments'))
  UNION ALL SELECT 'conversations',
         (SELECT (expected_counts ->> 'conversations')::bigint FROM run),
         (SELECT count(*) FROM public.conversations c WHERE c.id IN (SELECT unnest(ids) FROM manifest WHERE entity_type = 'conversations'))
  UNION ALL SELECT 'messages',
         (SELECT (expected_counts ->> 'messages')::bigint FROM run),
         (SELECT count(*) FROM public.messages m WHERE m.id IN (SELECT unnest(ids) FROM manifest WHERE entity_type = 'messages'))
  UNION ALL SELECT 'new_work_items',
         (SELECT (expected_counts ->> 'new_work_items')::bigint FROM run),
         (SELECT count(*) FROM public.conversation_work_items wi
          WHERE wi.id IN (SELECT unnest(ids) FROM manifest WHERE entity_type = 'conversation_work_items')
            AND wi.status = 'new')
  UNION ALL SELECT 'active_handling_cycles',
         (SELECT (expected_counts ->> 'active_handling_cycles')::bigint FROM run),
         (SELECT count(*) FROM public.conversation_handling_cycles hc
          WHERE hc.id IN (SELECT unnest(ids) FROM manifest WHERE entity_type = 'conversation_handling_cycles')
            AND hc.ended_at IS NULL)
  UNION ALL SELECT 'notifications',
         (SELECT (expected_counts ->> 'notifications')::bigint FROM run),
         (SELECT count(*) FROM public.notifications n WHERE n.id IN (SELECT unnest(ids) FROM manifest WHERE entity_type = 'notifications'))
  UNION ALL SELECT 'analytics_events',
         (SELECT (expected_counts ->> 'analytics_events')::bigint FROM run),
         (SELECT count(*) FROM public.analytics_events ae WHERE ae.id IN (SELECT unnest(ids) FROM manifest WHERE entity_type = 'analytics_events'))
  UNION ALL SELECT 'media_tags',
         (SELECT (expected_counts ->> 'media_tags')::bigint FROM run),
         (SELECT count(*) FROM public.media_tags mt WHERE mt.id IN (SELECT unnest(ids) FROM manifest WHERE entity_type = 'media_tags'))
  UNION ALL SELECT 'media_assets',
         (SELECT (expected_counts ->> 'media_assets')::bigint FROM run),
         (SELECT count(*) FROM public.character_media_assets a WHERE a.id IN (SELECT unnest(ids) FROM manifest WHERE entity_type = 'media_assets'))
  UNION ALL SELECT 'media_reservations',
         (SELECT (expected_counts ->> 'media_reservations')::bigint FROM run),
         (SELECT count(*) FROM public.character_media_reservations r WHERE r.id IN (SELECT unnest(ids) FROM manifest WHERE entity_type = 'media_reservations'))
  UNION ALL SELECT 'message_attachments',
         (SELECT (expected_counts ->> 'message_attachments')::bigint FROM run),
         (SELECT count(*) FROM public.message_attachments a WHERE a.id IN (SELECT unnest(ids) FROM manifest WHERE entity_type = 'message_attachments'))
  UNION ALL SELECT 'sticker_collections',
         (SELECT (expected_counts ->> 'sticker_collections')::bigint FROM run),
         (SELECT count(*) FROM public.sticker_collections sc WHERE sc.id IN (SELECT unnest(ids) FROM manifest WHERE entity_type = 'sticker_collections'))
  UNION ALL SELECT 'stickers',
         (SELECT (expected_counts ->> 'stickers')::bigint FROM run),
         (SELECT count(*) FROM public.stickers s WHERE s.id IN (SELECT unnest(ids) FROM manifest WHERE entity_type = 'stickers'))
  UNION ALL SELECT 'wallets',
         (SELECT (expected_counts ->> 'wallets')::bigint FROM run),
         (SELECT count(*) FROM public.credit_wallets w WHERE w.user_id IN (SELECT unnest(ids) FROM manifest WHERE entity_type = 'credit_wallets'))
  UNION ALL SELECT 'credit_transactions',
         (SELECT (expected_counts ->> 'credit_transactions')::bigint FROM run),
         (SELECT count(*) FROM public.credit_transactions ct WHERE ct.id IN (SELECT unnest(ids) FROM manifest WHERE entity_type = 'credit_transactions'))
  UNION ALL SELECT 'outreach_attempts',
         (SELECT (expected_counts ->> 'outreach_attempts')::bigint FROM run),
         (SELECT count(*) FROM public.operator_outreach_attempts oa WHERE oa.id IN (SELECT unnest(ids) FROM manifest WHERE entity_type = 'outreach_attempts'))
  UNION ALL SELECT 'operator_client_blocks',
         (SELECT (expected_counts ->> 'operator_client_blocks')::bigint FROM run),
         (SELECT count(*) FROM public.operator_client_blocks b
          JOIN constants c ON true
          WHERE b.reason = c.run_id || ' synthetic block')
  UNION ALL SELECT 'operator_client_reports',
         (SELECT (expected_counts ->> 'operator_client_reports')::bigint FROM run),
         (SELECT count(*) FROM public.operator_client_reports r WHERE r.id IN (SELECT unnest(ids) FROM manifest WHERE entity_type = 'operator_client_reports'))
),
checks AS (
  SELECT 'run_exists'::text AS check_name,
         CASE WHEN EXISTS (SELECT 1 FROM run) THEN 'PASS' ELSE 'FAIL' END AS result,
         CASE WHEN EXISTS (SELECT 1 FROM run) THEN 'fixture run found' ELSE 'fixture run missing' END AS detail
  UNION ALL
  SELECT 'run_target',
         CASE WHEN EXISTS (SELECT 1 FROM run r JOIN constants c ON r.target_project_ref = c.target_project_ref) THEN 'PASS' ELSE 'FAIL' END,
         'target project ref matches manifest'
  UNION ALL
  SELECT 'run_status_ready',
         CASE WHEN EXISTS (SELECT 1 FROM run WHERE status = 'ready') THEN 'PASS' ELSE 'FAIL' END,
         COALESCE((SELECT status FROM run), 'run missing')
  UNION ALL
  SELECT 'storage_objects_total_zero',
         CASE WHEN (SELECT count(*) FROM storage.objects) = 0 THEN 'PASS' ELSE 'FAIL' END,
         'isolated project storage object count'
  UNION ALL
  SELECT 'storage_objects_namespace_zero',
         CASE WHEN (SELECT count(*) FROM storage.objects WHERE name LIKE (SELECT namespace || '/%' FROM run)) = 0 THEN 'PASS' ELSE 'FAIL' END,
         'fixture namespace storage object count'
  UNION ALL
  SELECT 'financial_product_transactions_zero',
         CASE WHEN NOT EXISTS (
           SELECT 1
           FROM public.credit_transactions ct
           JOIN manifest m ON m.entity_type = 'credit_transactions' AND ct.id = ANY (m.ids)
           WHERE ct.type IN (
             'message_spend', 'message_payout', 'operator_message_payout',
             'sticker_spend', 'sticker_payout',
             'locked_image_unlock', 'paid_image_open_spend', 'paid_image_open_payout'
           )
         ) THEN 'PASS' ELSE 'FAIL' END,
         'no fixture financial product transaction type'
  UNION ALL
  SELECT 'synthetic_ledger_only',
         CASE WHEN (SELECT count(*) FROM public.credit_transactions ct
                    JOIN manifest m ON m.entity_type = 'credit_transactions' AND ct.id = ANY (m.ids)
                    WHERE ct.amount = 0 AND ct.type = 'migration_backfill') = 50000
              THEN 'PASS' ELSE 'FAIL' END,
         'all fixture ledger rows are zero-value backfill rows'
  UNION ALL
  SELECT 'synthetic_emails_only',
         CASE WHEN NOT EXISTS (
           SELECT 1 FROM auth.users u
           JOIN manifest m ON m.entity_type = 'auth_users' AND u.id = ANY (m.ids)
           WHERE u.email IS NULL OR u.email NOT LIKE '%@example.invalid'
         ) THEN 'PASS' ELSE 'FAIL' END,
         'fixture identities use example.invalid only'
  UNION ALL
  SELECT 'gifts_absent',
         CASE WHEN to_regclass('public.gifts') IS NULL
                   AND to_regclass('public.gift_collections') IS NULL
                   AND to_regclass('public.message_gifts') IS NULL
                   AND to_regclass('private.gift_send_attempts') IS NULL
                   AND NOT EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'gifts_enabled')
                   AND NOT EXISTS (
                     SELECT 1 FROM pg_proc p
                     JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname IN ('public', 'private') AND p.proname ILIKE '%gift%'
                   )
              THEN 'PASS' ELSE 'FAIL' END,
         'no active Gift relation, function, or setting'
)
SELECT check_name, result, detail
FROM checks
UNION ALL
SELECT
  'count_' || check_name,
  CASE WHEN expected_count = actual_count THEN 'PASS' ELSE 'FAIL' END,
  format('expected=%s actual=%s', expected_count, actual_count)
FROM expected_actual
ORDER BY check_name;

ROLLBACK;
