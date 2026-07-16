import { supabase } from "@/integrations/supabase/client";

export type UnreadCountRow = {
  conversation_id: string;
  unread_count: number;
  last_read_at: string | null;
};

export type ReadSummary = {
  client_last_read_at: string | null;
  operator_last_read_at: string | null;
  client_has_seen_latest_operator_message: boolean;
  operator_has_seen_latest_client_message: boolean;
};

export async function fetchUnreadCounts(conversationIds: string[]) {
  if (conversationIds.length === 0) return new Map<string, UnreadCountRow>();

  const { data, error } = await supabase.rpc("get_my_conversation_unread_counts", {
    _conversation_ids: conversationIds,
  });
  if (error) {
    logSupabaseError("get_my_conversation_unread_counts", error);
    return new Map<string, UnreadCountRow>();
  }

  return new Map(
    ((data ?? []) as UnreadCountRow[]).map((row) => [
      row.conversation_id,
      {
        conversation_id: row.conversation_id,
        unread_count: row.unread_count ?? 0,
        last_read_at: row.last_read_at ?? null,
      },
    ]),
  );
}

export async function fetchReadSummary(conversationId: string): Promise<ReadSummary | null> {
  const { data, error } = await supabase.rpc("get_conversation_read_summary", {
    _conversation_id: conversationId,
  });
  if (error) {
    logSupabaseError("get_conversation_read_summary", error);
    return null;
  }
  return (data ?? null) as ReadSummary | null;
}

export function logSupabaseError(context: string, error: unknown) {
  const value = error as {
    message?: string;
    details?: string;
    hint?: string;
    code?: string;
  };

  console.error(`[Supabase] ${context} failed`, {
    message: value?.message,
    details: value?.details,
    hint: value?.hint,
    code: value?.code,
    raw: error,
  });
}
