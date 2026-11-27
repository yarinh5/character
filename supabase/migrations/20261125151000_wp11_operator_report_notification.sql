-- R10: send the existing in-app report notification to admins for operator reports.
CREATE FUNCTION private.notify_admin_on_operator_client_report()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _admin_id UUID;
BEGIN
  FOR _admin_id IN
    SELECT user_id FROM public.user_roles WHERE role = 'admin'
  LOOP
    PERFORM public.create_notification(
      _admin_id,
      'new_report',
      'דיווח עובד חדש',
      'דיווח עובד חדש ממתין לטיפול',
      '/admin/reports',
      NULL,
      jsonb_build_object(
        'report_id', NEW.id,
        'dedupe_key', 'operator-client-report:' || NEW.id::TEXT
      ),
      0
    );
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.notify_admin_on_operator_client_report() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER notify_admin_on_operator_client_report_insert
AFTER INSERT ON public.operator_client_reports
FOR EACH ROW EXECUTE FUNCTION private.notify_admin_on_operator_client_report();
