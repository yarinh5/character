-- WP11: bounded admin history for operator-submitted client reports.
CREATE INDEX operator_client_reports_created_id_idx
  ON public.operator_client_reports (created_at DESC, id DESC);

CREATE FUNCTION public.get_admin_operator_client_reports_page(
  _before_created_at TIMESTAMPTZ DEFAULT NULL,
  _before_id UUID DEFAULT NULL,
  _page_size INTEGER DEFAULT 101
)
RETURNS TABLE (
  id UUID,
  operator_id UUID,
  operator_name TEXT,
  client_id UUID,
  client_display_name TEXT,
  conversation_id UUID,
  reason TEXT,
  notes TEXT,
  source TEXT,
  created_at TIMESTAMPTZ,
  status TEXT,
  resolution_note TEXT,
  global_action_note TEXT,
  version INTEGER,
  updated_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID,
  updated_by UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;
  IF (_before_created_at IS NULL) <> (_before_id IS NULL) THEN
    RAISE EXCEPTION 'invalid_report_cursor';
  END IF;
  IF _page_size IS NULL OR _page_size < 1 OR _page_size > 101 THEN
    RAISE EXCEPTION 'invalid_page_size';
  END IF;

  RETURN QUERY
  SELECT
    report.id,
    report.operator_id,
    operator.full_name,
    report.client_id,
    profile.display_name,
    report.conversation_id,
    report.reason,
    report.notes,
    report.source,
    report.created_at,
    report.status,
    report.resolution_note,
    report.global_action_note,
    report.version,
    report.updated_at,
    report.resolved_at,
    report.resolved_by,
    report.updated_by
  FROM public.operator_client_reports report
  JOIN public.operators operator ON operator.id = report.operator_id
  LEFT JOIN public.profiles profile ON profile.user_id = report.client_id
  WHERE _before_created_at IS NULL
    OR (report.created_at, report.id) < (_before_created_at, _before_id)
  ORDER BY report.created_at DESC, report.id DESC
  LIMIT _page_size;
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_operator_client_reports_page(TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_operator_client_reports_page(TIMESTAMPTZ, UUID, INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';
