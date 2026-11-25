-- WP03 retired the legacy operator outreach action when ONLINE was folded into
-- the assigned-conversation flow. Keep the historical function for migration
-- compatibility and auditability, but remove every API-role execution path.
REVOKE ALL ON FUNCTION public.start_operator_outreach(uuid, uuid, text, text)
FROM PUBLIC, anon, authenticated, service_role;
