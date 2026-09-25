DROP TABLE IF EXISTS pg_temp.v3_2_benchmark_results;

-- Run in a fresh SQL Editor session after 50_preflight_readonly.sql passes.
-- The first sample is a fresh-session baseline, not a forced physical-cache
-- cold read. This script never clears PostgreSQL shared buffers.
CREATE TEMPORARY TABLE v3_2_benchmark_results (
  query_name TEXT NOT NULL,
  run_kind TEXT NOT NULL CHECK (run_kind IN ('cold', 'warm')),
  run_number INTEGER NOT NULL,
  planning_time_ms NUMERIC,
  execution_time_ms NUMERIC,
  actual_rows BIGINT,
  top_plan_node TEXT,
  plan_json JSONB NOT NULL,
  PRIMARY KEY (query_name, run_number)
) ON COMMIT PRESERVE ROWS;

BEGIN TRANSACTION READ ONLY;

SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';

-- No public RPC is used. Discovery and media catalog RPC contracts are
-- excluded because they are not safe to exercise in a read-only transaction.
-- Every measured statement below is an EXPLAIN of a direct SELECT only.
DO $benchmark$
DECLARE
  workload RECORD;
  sample_number INTEGER;
  plan JSONB;
BEGIN
  FOR workload IN
    SELECT *
    FROM (
      VALUES
        (
          'admin_sla_summary',
          $query$
            WITH visible AS (
              SELECT wi.character_id,
                     GREATEST(0, FLOOR(EXTRACT(EPOCH FROM clock_timestamp() - msg.created_at)))::INTEGER AS wait_seconds
              FROM public.conversation_work_items wi
              JOIN public.conversations conversation ON conversation.id = wi.conversation_id
              JOIN public.messages msg ON msg.id = wi.last_client_message_id
              JOIN public.profiles profile ON profile.user_id = wi.client_id
              WHERE wi.status = 'new'
                AND conversation.status <> 'closed'
                AND profile.status = 'active'
                AND profile.deleted_at IS NULL
                AND profile.pii_archived_at IS NULL
                AND msg.sender_type = 'client'
                AND NOT EXISTS (
                  SELECT 1
                  FROM public.conversation_handling_cycles cycle
                  WHERE cycle.work_item_id = wi.id
                    AND cycle.ended_at IS NULL
                )
            )
            SELECT character_id,
                   COUNT(*),
                   COUNT(*) FILTER (WHERE wait_seconds >= 300),
                   COUNT(*) FILTER (WHERE wait_seconds >= 900),
                   MAX(wait_seconds)
            FROM visible
            GROUP BY character_id
            ORDER BY MAX(wait_seconds) DESC
          $query$
        ),
        (
          'attachment_hydration',
          $query$
            WITH fixture AS (
              SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'message', 18) AS message_id
            )
            SELECT attachment.id,
                   attachment.access_mode,
                   attachment.view_mode,
                   asset.id AS media_asset_id,
                   asset.status
            FROM public.message_attachments attachment
            JOIN public.character_media_assets asset ON asset.id = attachment.media_asset_id
            CROSS JOIN fixture
            WHERE attachment.message_id = fixture.message_id
            ORDER BY attachment.position
          $query$
        ),
        (
          'chat_pagination',
          $query$
            WITH fixture AS (
              SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'conversation', 501) AS conversation_id
            )
            SELECT msg.id, msg.sender_type, msg.created_at
            FROM public.messages msg
            CROSS JOIN fixture
            WHERE msg.conversation_id = fixture.conversation_id
            ORDER BY msg.created_at DESC
            LIMIT 50
          $query$
        ),
        (
          'discovery_filters',
          $query$
            WITH fixture AS (
              SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', 1) AS client_id
            ), active_city AS (
              SELECT id
              FROM public.discovery_cities
              WHERE is_active = TRUE
              ORDER BY id
              LIMIT 1
            )
            SELECT character_record.id
            FROM public.characters character_record
            LEFT JOIN public.client_character_preferences preference
              ON preference.client_id = (SELECT client_id FROM fixture)
             AND preference.character_id = character_record.id
            WHERE character_record.is_active
              AND character_record.is_visible
              AND character_record.fictional_age BETWEEN 24 AND 40
              AND EXISTS (
                SELECT 1
                FROM unnest(COALESCE(character_record.interests, ARRAY[]::TEXT[])) interest
                WHERE lower(interest) = 'interest_1'
              )
              AND (
                NOT EXISTS (SELECT 1 FROM active_city)
                OR character_record.discovery_city_id = (SELECT id FROM active_city)
              )
              AND COALESCE(preference.is_favorite, FALSE) = FALSE
            ORDER BY character_record.created_at DESC, character_record.id DESC
            LIMIT 20
          $query$
        ),
        (
          'ledger_history',
          $query$
            WITH fixture AS (
              SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', 1) AS user_id
            )
            SELECT ledger.id, ledger.type, ledger.amount, ledger.created_at
            FROM public.credit_transactions ledger
            CROSS JOIN fixture
            WHERE ledger.user_id = fixture.user_id
            ORDER BY ledger.created_at DESC
            LIMIT 50
          $query$
        ),
        (
          'new_queue',
          $query$
            WITH fixture AS (
              SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'operator', 1) AS operator_id
            )
            SELECT wi.id, wi.conversation_id, wi.last_activity_at
            FROM public.conversation_work_items wi
            JOIN public.conversations conversation ON conversation.id = wi.conversation_id
            JOIN public.messages msg ON msg.id = wi.last_client_message_id
            JOIN public.profiles profile ON profile.user_id = wi.client_id
            CROSS JOIN fixture
            WHERE wi.status = 'new'
              AND conversation.status <> 'closed'
              AND profile.status = 'active'
              AND profile.deleted_at IS NULL
              AND profile.pii_archived_at IS NULL
              AND msg.sender_type = 'client'
              AND NOT EXISTS (
                SELECT 1
                FROM public.conversation_handling_cycles cycle
                WHERE cycle.work_item_id = wi.id
                  AND cycle.ended_at IS NULL
              )
              AND EXISTS (
                SELECT 1
                FROM public.character_operator_assignments assignment
                WHERE assignment.character_id = wi.character_id
                  AND assignment.operator_id = fixture.operator_id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM public.operator_client_blocks block
                WHERE block.operator_id = fixture.operator_id
                  AND block.client_id = wi.client_id
              )
            ORDER BY wi.last_activity_at DESC, wi.created_at DESC
          $query$
        ),
        (
          'notifications_unread',
          $query$
            WITH fixture AS (
              SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', 1) AS user_id
            )
            SELECT notification.id, notification.type, notification.created_at
            FROM public.notifications notification
            CROSS JOIN fixture
            WHERE notification.user_id = fixture.user_id
              AND notification.is_read = FALSE
            ORDER BY notification.created_at DESC
            LIMIT 50
          $query$
        ),
        (
          'online_candidates',
          $query$
            WITH fixture AS (
              SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'operator', 1) AS operator_id
            )
            SELECT profile.user_id,
                   EXISTS (
                     SELECT 1
                     FROM public.conversations conversation
                     JOIN public.character_operator_assignments assignment
                       ON assignment.character_id = conversation.character_id
                     WHERE conversation.client_id = profile.user_id
                       AND conversation.status <> 'closed'
                       AND assignment.operator_id = fixture.operator_id
                   ) AS has_existing_conversation,
                   (
                     SELECT COUNT(*)
                     FROM public.character_operator_assignments assignment
                     WHERE assignment.operator_id = fixture.operator_id
                   ) AS character_option_count
            FROM public.profiles profile
            JOIN public.user_roles user_role
              ON user_role.user_id = profile.user_id
             AND user_role.role = 'client'
            CROSS JOIN fixture
            WHERE profile.status = 'active'
              AND profile.deleted_at IS NULL
              AND profile.pii_archived_at IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM public.operator_client_blocks block
                WHERE block.operator_id = fixture.operator_id
                  AND block.client_id = profile.user_id
              )
            ORDER BY profile.user_id
            LIMIT 50
          $query$
        ),
        (
          'operator_media_catalog',
          $query$
            WITH fixture AS (
              SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'character', 1) AS character_id,
                     load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'media_tag', 1) AS media_tag_id
            )
            SELECT asset.id, asset.status, asset.ingest_status, tag.name
            FROM public.character_media_assets asset
            JOIN public.media_tags tag ON tag.id = asset.media_tag_id
            CROSS JOIN fixture
            WHERE asset.character_id = fixture.character_id
              AND asset.media_tag_id = fixture.media_tag_id
              AND asset.status IN ('available', 'restored')
              AND asset.ingest_status = 'ready'
            ORDER BY tag.sort_order, tag.name, asset.created_at DESC, asset.id DESC
          $query$
        ),
        (
          'operator_sla_summary',
          $query$
            WITH fixture AS (
              SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'operator', 1) AS operator_id
            ), visible AS (
              SELECT GREATEST(0, FLOOR(EXTRACT(EPOCH FROM clock_timestamp() - msg.created_at)))::INTEGER AS wait_seconds
              FROM public.conversation_work_items wi
              JOIN public.conversations conversation ON conversation.id = wi.conversation_id
              JOIN public.messages msg ON msg.id = wi.last_client_message_id
              JOIN public.profiles profile ON profile.user_id = wi.client_id
              CROSS JOIN fixture
              WHERE wi.status = 'new'
                AND conversation.status <> 'closed'
                AND profile.status = 'active'
                AND profile.deleted_at IS NULL
                AND profile.pii_archived_at IS NULL
                AND msg.sender_type = 'client'
                AND NOT EXISTS (
                  SELECT 1
                  FROM public.conversation_handling_cycles cycle
                  WHERE cycle.work_item_id = wi.id
                    AND cycle.ended_at IS NULL
                )
                AND EXISTS (
                  SELECT 1
                  FROM public.character_operator_assignments assignment
                  WHERE assignment.character_id = wi.character_id
                    AND assignment.operator_id = fixture.operator_id
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM public.operator_client_blocks block
                  WHERE block.operator_id = fixture.operator_id
                    AND block.client_id = wi.client_id
                )
            )
            SELECT COUNT(*),
                   COUNT(*) FILTER (WHERE wait_seconds >= 300),
                   COUNT(*) FILTER (WHERE wait_seconds >= 900),
                   COALESCE(MAX(wait_seconds), 0)
            FROM visible
          $query$
        ),
        (
          'wallet_balance',
          $query$
            WITH fixture AS (
              SELECT load_v3_2.fixture_id('load_v3_2_20260731_pilot_01', 'user', 1) AS user_id
            )
            SELECT wallet.user_id, wallet.balance, wallet.updated_at
            FROM public.credit_wallets wallet
            CROSS JOIN fixture
            WHERE wallet.user_id = fixture.user_id
          $query$
        )
    ) AS workloads(query_name, query_sql)
    ORDER BY query_name
  LOOP
    FOR sample_number IN 0..5 LOOP
      EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' || workload.query_sql
      INTO plan;

      INSERT INTO pg_temp.v3_2_benchmark_results (
        query_name,
        run_kind,
        run_number,
        planning_time_ms,
        execution_time_ms,
        actual_rows,
        top_plan_node,
        plan_json
      )
      VALUES (
        workload.query_name,
        CASE WHEN sample_number = 0 THEN 'cold' ELSE 'warm' END,
        sample_number,
        (plan -> 0 ->> 'Planning Time')::NUMERIC,
        (plan -> 0 ->> 'Execution Time')::NUMERIC,
        COALESCE((plan -> 0 -> 'Plan' ->> 'Actual Rows')::BIGINT, 0),
        plan -> 0 -> 'Plan' ->> 'Node Type',
        plan
      );
    END LOOP;
  END LOOP;
END;
$benchmark$;

COMMIT;

SELECT
  query_name,
  run_kind,
  run_number,
  planning_time_ms,
  execution_time_ms,
  actual_rows,
  top_plan_node,
  plan_json
FROM pg_temp.v3_2_benchmark_results
ORDER BY query_name, run_number;
