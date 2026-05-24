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

type SystemSettingValue = string | number | boolean | null;

function parseSlaMinutes(value: SystemSettingValue | Record<string, unknown> | unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(1, value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Math.max(1, Number(value));
  return 15;
}

function shouldFallbackFromRpcError(error: { code?: string; message?: string }) {
  return (
    error.code === "PGRST202" ||
    error.message?.includes("get_sla_risk_conversations") ||
    error.message?.includes("schema cache")
  );
}

export async function fetchSlaRiskConversations(limit = 10, notify = false) {
  const { data, error } = await (supabase as any).rpc("get_sla_risk_conversations", {
    _limit: limit,
    _notify: notify,
  });

  if (error) {
    logSupabaseError("get_sla_risk_conversations", error);
    if (!shouldFallbackFromRpcError(error)) {
      return [] as SlaRiskConversation[];
    }

    console.info("[SLA fallback] RPC unavailable, calculating SLA risk client-side", {
      code: error.code,
      message: error.message,
    });
    return fetchSlaRiskConversationsFallback(limit);
  }

  return (data ?? []) as SlaRiskConversation[];
}

async function fetchSlaRiskConversationsFallback(limit: number) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [] as SlaRiskConversation[];

  const { data: setting, error: settingError } = await supabase
    .from("system_settings" as any)
    .select("value")
    .eq("key", "conversation_waiting_sla_minutes")
    .maybeSingle();
  if (settingError) logSupabaseError("sla fallback setting", settingError);
  const slaMinutes = parseSlaMinutes((setting as any)?.value);

  const { data: roleRows, error: roleError } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id);
  if (roleError) {
    logSupabaseError("sla fallback role", roleError);
    return [] as SlaRiskConversation[];
  }

  const roles = (roleRows ?? []).map((row) => row.role);
  const role = roles.includes("admin") ? "admin" : roles.includes("operator") ? "operator" : roles[0];
  console.info("[SLA fallback] viewer context", {
    userId: user.id,
    roles,
    resolvedRole: role,
    slaMinutes,
  });
  if (role !== "admin" && role !== "operator") return [] as SlaRiskConversation[];

  let assignedCharacterIds: string[] | null = null;
  if (role === "operator") {
    const { data: operator, error: operatorError } = await supabase
      .from("operators")
      .select("id")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .maybeSingle();
    if (operatorError) {
      logSupabaseError("sla fallback operator", operatorError);
      return [] as SlaRiskConversation[];
    }
    if (!operator?.id) return [] as SlaRiskConversation[];

    const { data: assignments, error: assignmentsError } = await supabase
      .from("character_operator_assignments")
      .select("character_id")
      .eq("operator_id", operator.id);
    if (assignmentsError) {
      logSupabaseError("sla fallback assignments", assignmentsError);
      return [] as SlaRiskConversation[];
    }

    assignedCharacterIds = (assignments ?? []).map((assignment) => assignment.character_id);
    console.info("[SLA fallback] operator assignments", {
      operatorId: operator.id,
      assignedCharacterCount: assignedCharacterIds.length,
    });
    if (assignedCharacterIds.length === 0) return [] as SlaRiskConversation[];
  }

  let conversationsQuery = supabase
    .from("conversations")
    .select("id, character_id, client_id, status, last_message_at, last_message_preview, characters(name, avatar_url)")
    .neq("status", "closed")
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(500);

  if (assignedCharacterIds) {
    conversationsQuery = conversationsQuery.in("character_id", assignedCharacterIds);
  }

  const { data: conversations, error: conversationsError } = await conversationsQuery;
  if (conversationsError) {
    logSupabaseError("sla fallback conversations", conversationsError);
    return [] as SlaRiskConversation[];
  }

  const conversationIds = (conversations ?? []).map((conversation) => conversation.id);
  console.info("[SLA fallback] candidate conversations", {
    conversationCount: conversationIds.length,
    role,
    assignedCharacterCount: assignedCharacterIds?.length ?? null,
  });
  if (conversationIds.length === 0) return [] as SlaRiskConversation[];

  const { data: messages, error: messagesError } = await supabase
    .from("messages")
    .select("conversation_id, sender_type, created_at")
    .in("conversation_id", conversationIds)
    .order("created_at", { ascending: false });
  if (messagesError) {
    logSupabaseError("sla fallback messages", messagesError);
    return [] as SlaRiskConversation[];
  }

  const latestByConversation = new Map<string, { sender_type: string; created_at: string }>();
  for (const message of messages ?? []) {
    if (!latestByConversation.has(message.conversation_id)) {
      latestByConversation.set(message.conversation_id, message);
    }
  }

  const clientIds = Array.from(new Set((conversations ?? []).map((conversation) => conversation.client_id)));
  let profileMap = new Map<string, { display_name: string | null }>();
  if (clientIds.length > 0) {
    const { data: profiles, error: profilesError } = await supabase
      .from("profiles")
      .select("user_id, display_name")
      .in("user_id", clientIds);
    if (profilesError) {
      logSupabaseError("sla fallback profiles", profilesError);
    } else {
      profileMap = new Map((profiles ?? []).map((profile) => [profile.user_id, { display_name: profile.display_name }]));
    }
  }

  const now = Date.now();
  const rejected: Array<{ id: string; reason: string; status?: string; senderType?: string; minutesWaiting?: number }> = [];
  const risks = (conversations ?? [])
    .map((conversation: any) => {
      const latest = latestByConversation.get(conversation.id);
      if (!latest) {
        rejected.push({ id: conversation.id, status: conversation.status, reason: "no latest message" });
        return null;
      }
      if (latest.sender_type !== "client") {
        rejected.push({
          id: conversation.id,
          status: conversation.status,
          senderType: latest.sender_type,
          reason: "latest sender is not client",
        });
        return null;
      }
      const minutesWaiting = Math.floor((now - new Date(latest.created_at).getTime()) / 60000);
      if (minutesWaiting < slaMinutes) {
        rejected.push({
          id: conversation.id,
          status: conversation.status,
          senderType: latest.sender_type,
          minutesWaiting,
          reason: "below SLA threshold",
        });
        return null;
      }

      return {
        conversation_id: conversation.id,
        character_id: conversation.character_id,
        character_name: conversation.characters?.name ?? null,
        character_avatar_url: conversation.characters?.avatar_url ?? null,
        client_id: conversation.client_id,
        client_display_name: profileMap.get(conversation.client_id)?.display_name ?? null,
        status: conversation.status,
        last_client_message_at: latest.created_at,
        minutes_waiting: minutesWaiting,
        last_message_preview: conversation.last_message_preview,
      } satisfies SlaRiskConversation;
    })
    .filter((conversation): conversation is SlaRiskConversation => conversation !== null)
    .sort((a, b) => new Date(a.last_client_message_at).getTime() - new Date(b.last_client_message_at).getTime())
    .slice(0, Math.max(1, Math.min(limit, 100)));

  console.info("[SLA fallback] result", {
    riskCount: risks.length,
    rejectedCount: rejected.length,
    rejectedSamples: rejected.slice(0, 20),
  });

  return risks;
}
