import { supabase } from "@/integrations/supabase/client";
import { logSupabaseError } from "@/lib/readStates";

export type SlaRiskConversation = {
  conversation_id: string;
  character_id: string;
  character_name: string | null;
  character_avatar_url: string | null;
  client_id: string;
  client_display_name: string | null;
  status: string;
  last_client_message_at: string;
  minutes_waiting: number;
  last_message_preview: string | null;
};

export async function fetchSlaRiskConversations(limit = 10, notify = false) {
  const { data, error } = await (supabase as any).rpc("get_sla_risk_conversations", {
    _limit: limit,
    _notify: notify,
  });

  if (error) {
    logSupabaseError("get_sla_risk_conversations", error);
    return [] as SlaRiskConversation[];
  }

  return (data ?? []) as SlaRiskConversation[];
}
