-- Phase 2F: Production/scale hardening.
-- Safe covering indexes for foreign keys reported by Supabase advisors.
-- No business logic, RLS, grants, or RPC behavior changes.

CREATE INDEX IF NOT EXISTS idx_conversation_locks_locked_by_user_id
  ON public.conversation_locks(locked_by_user_id);

CREATE INDEX IF NOT EXISTS idx_conversation_locks_released_by_user_id
  ON public.conversation_locks(released_by_user_id)
  WHERE released_by_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_read_states_last_read_message_id
  ON public.conversation_read_states(last_read_message_id)
  WHERE last_read_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_credit_transactions_created_by
  ON public.credit_transactions(created_by)
  WHERE created_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customer_info_entries_created_by_user_id
  ON public.customer_info_entries(created_by_user_id);

CREATE INDEX IF NOT EXISTS idx_internal_notes_operator_id
  ON public.internal_notes(operator_id)
  WHERE operator_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_sender_id
  ON public.messages(sender_id);

CREATE INDEX IF NOT EXISTS idx_notifications_conversation_id
  ON public.notifications(conversation_id)
  WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operator_score_events_user_id
  ON public.operator_score_events(user_id);

CREATE INDEX IF NOT EXISTS idx_reports_conversation_id
  ON public.reports(conversation_id)
  WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reports_reporter_id
  ON public.reports(reporter_id);

CREATE INDEX IF NOT EXISTS idx_user_active_conversations_conversation_id
  ON public.user_active_conversations(conversation_id);
