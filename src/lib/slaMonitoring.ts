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

export async function fetchSlaRiskConversations(limit = 10): Promise<SlaRiskConversation[]> {
  const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 10;
  const boundedLimit = Math.max(1, Math.min(100, requestedLimit));
  try {
    const { data, error } = await supabase.rpc("get_sla_risk_conversations", {
      _limit: boundedLimit,
      _notify: false,
    });

    if (error) {
      logSupabaseError("get_sla_risk_conversations", error);
      return [];
    }

    return data ?? [];
  } catch (error) {
    logSupabaseError("get_sla_risk_conversations", error);
    return [];
  }
}
