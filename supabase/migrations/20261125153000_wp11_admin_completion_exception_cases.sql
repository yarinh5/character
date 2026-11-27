-- Admin-only, bounded case drilldown for the eight completion exceptions.
CREATE FUNCTION public.get_admin_completion_exception_cases(
  _kind TEXT DEFAULT NULL,
  _before_occurred_at TIMESTAMPTZ DEFAULT NULL,
  _before_kind TEXT DEFAULT NULL,
  _before_id UUID DEFAULT NULL,
  _page_size INTEGER DEFAULT 101
)
RETURNS TABLE (
  kind TEXT,
  id UUID,
  occurred_at TIMESTAMPTZ,
  code TEXT,
  subject_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
  END IF;
  IF _kind IS NOT NULL AND _kind NOT IN (
    'allocation', 'gift_failed', 'gift_unallocated', 'media_cleanup',
    'account_deletion_blocked', 'account_deletion_failed',
    'conversation_deletion_blocked', 'conversation_deletion_failed'
  ) THEN
    RAISE EXCEPTION 'invalid_exception_kind';
  END IF;
  IF (num_nonnulls(_before_occurred_at, _before_kind, _before_id) NOT IN (0, 3)) THEN
    RAISE EXCEPTION 'invalid_exception_cursor';
  END IF;
  IF _page_size IS NULL OR _page_size < 1 OR _page_size > 101 THEN
    RAISE EXCEPTION 'invalid_page_size';
  END IF;

  RETURN QUERY
  WITH cases AS (
    SELECT 'allocation'::TEXT AS kind, issue.id, issue.created_at AS occurred_at,
      issue.issue_kind AS code, issue.conversation_id AS subject_id
    FROM private.handling_reconciliation_issues issue
    WHERE issue.status = 'unresolved'
    UNION ALL
    SELECT 'gift_failed'::TEXT, event.id, event.created_at,
      event.failure_code, purchase.conversation_id
    FROM private.gift_reward_events event
    JOIN public.gift_attachment_purchases purchase ON purchase.id = event.purchase_id
    WHERE event.status = 'failed'
    UNION ALL
    SELECT 'gift_unallocated'::TEXT, event.id, event.created_at,
      NULL::TEXT, purchase.conversation_id
    FROM private.gift_reward_events event
    JOIN public.gift_attachment_purchases purchase ON purchase.id = event.purchase_id
    WHERE event.status = 'distributed' AND event.unallocated_points > 0
    UNION ALL
    SELECT 'media_cleanup'::TEXT, upload.id, upload.created_at,
      upload.cleanup_error_code, upload.conversation_id
    FROM public.client_media_uploads upload
    WHERE upload.status = 'cleanup_failed'
    UNION ALL
    SELECT 'account_deletion_blocked'::TEXT, request.id, request.requested_at,
      request.failure_code, request.user_id
    FROM public.account_deletion_requests request
    WHERE request.status = 'blocked_retention'
    UNION ALL
    SELECT 'account_deletion_failed'::TEXT, request.id, request.requested_at,
      request.failure_code, request.user_id
    FROM public.account_deletion_requests request
    WHERE request.status = 'failed'
    UNION ALL
    SELECT 'conversation_deletion_blocked'::TEXT, request.id, request.requested_at,
      request.failure_code, request.conversation_id
    FROM public.conversation_deletion_requests request
    WHERE request.status = 'blocked_retention'
    UNION ALL
    SELECT 'conversation_deletion_failed'::TEXT, request.id, request.requested_at,
      request.failure_code, request.conversation_id
    FROM public.conversation_deletion_requests request
    WHERE request.status = 'failed'
  )
  SELECT cases.kind, cases.id, cases.occurred_at, cases.code, cases.subject_id
  FROM cases
  WHERE (_kind IS NULL OR cases.kind = _kind)
    AND (_before_occurred_at IS NULL OR
      (cases.occurred_at, cases.kind, cases.id) <
      (_before_occurred_at, _before_kind, _before_id))
  ORDER BY cases.occurred_at DESC, cases.kind DESC, cases.id DESC
  LIMIT _page_size;
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_completion_exception_cases(TEXT, TIMESTAMPTZ, TEXT, UUID, INTEGER)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_completion_exception_cases(TEXT, TIMESTAMPTZ, TEXT, UUID, INTEGER)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
