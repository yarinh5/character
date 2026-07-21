DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.gift_collections)
     OR EXISTS (SELECT 1 FROM public.gifts)
     OR EXISTS (SELECT 1 FROM public.message_gifts)
     OR EXISTS (SELECT 1 FROM private.gift_send_attempts)
     OR EXISTS (SELECT 1 FROM private.conversation_gift_rate_limits)
     OR EXISTS (SELECT 1 FROM public.credit_transactions WHERE type IN ('gift_spend', 'gift_refund', 'gift_compensation'))
     OR EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'gift-media') THEN
    RAISE EXCEPTION 'gift_removal_precondition_failed';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS message_gifts_marker_guard ON public.message_gifts;

DO $$
DECLARE
  _function_oid OID;
BEGIN
  FOR _function_oid IN
    SELECT p.oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE (n.nspname = 'public' AND p.proname = ANY (ARRAY[
      'admin_create_gift_collection',
      'admin_update_gift',
      'admin_update_gift_collection',
      'begin_gift_hard_delete_for_server',
      'begin_gift_processing_for_server',
      'complete_gift_hard_delete_for_server',
      'complete_gift_processing_for_server',
      'compensate_client_gift',
      'create_gift_upload_intent_for_server',
      'fail_gift_processing_for_server',
      'get_admin_gift_catalog',
      'get_conversation_gifts',
      'refund_client_gift',
      'resolve_admin_gift_object_path_for_server',
      'send_client_gift',
      'set_admin_gift_active'
    ]))
    OR (n.nspname = 'private' AND p.proname = ANY (ARRAY[
      'assert_client_can_send_gift_message',
      'assert_gift_server_admin',
      'assert_message_gift_marker',
      'consume_client_gift_rate_limit'
    ]))
  LOOP
    EXECUTE format('DROP FUNCTION %s', _function_oid::REGPROCEDURE);
  END LOOP;
END;
$$;

DROP TABLE private.gift_send_attempts;
DROP TABLE private.conversation_gift_rate_limits;
DROP TABLE public.message_gifts;
DROP TABLE public.gifts;
DROP TABLE public.gift_collections;

DELETE FROM public.system_settings WHERE key = 'gifts_enabled';

ALTER TABLE public.credit_transactions
  DROP CONSTRAINT IF EXISTS credit_transactions_type_check;

ALTER TABLE public.credit_transactions
  ADD CONSTRAINT credit_transactions_type_check
  CHECK (type = ANY (ARRAY[
    'signup_bonus'::TEXT,
    'message_spend'::TEXT,
    'admin_adjustment'::TEXT,
    'package_purchase'::TEXT,
    'reset_grant'::TEXT,
    'migration_backfill'::TEXT,
    'locked_image_unlock'::TEXT,
    'locked_image_refund'::TEXT,
    'sticker_spend'::TEXT,
    'sticker_payout'::TEXT,
    'sticker_refund'::TEXT
  ]));

NOTIFY pgrst, 'reload schema';
