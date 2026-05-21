-- Phase 1D: tighten message writes.
-- Messages should now be created only through send_client_message/send_operator_message RPCs.
-- SELECT policies are intentionally left unchanged.

DROP POLICY IF EXISTS "Clients send messages in own conversations" ON public.messages;
DROP POLICY IF EXISTS "Operators send messages in assigned conversations" ON public.messages;
DROP POLICY IF EXISTS "Admins send messages" ON public.messages;
