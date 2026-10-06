-- The two-argument variant exists solely for SECURITY DEFINER claim flows.
-- Direct callers must never opt out of active-cycle ownership checks.
REVOKE ALL ON FUNCTION private.assert_operator_can_send_conversation_message(UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.assert_operator_can_send_conversation_message(UUID, BOOLEAN) FROM anon;
REVOKE ALL ON FUNCTION private.assert_operator_can_send_conversation_message(UUID, BOOLEAN) FROM authenticated;
REVOKE ALL ON FUNCTION private.assert_operator_can_send_conversation_message(UUID, BOOLEAN) FROM service_role;

NOTIFY pgrst, 'reload schema';
