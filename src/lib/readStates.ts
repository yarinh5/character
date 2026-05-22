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

  const { data, error } = await (supabase as any).rpc("get_my_conversation_unread_counts", {
    _conversation_ids: conversationIds,
  });
  if (error) throw error;

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
  const { data, error } = await (supabase as any).rpc("get_conversation_read_summary", {
    _conversation_id: conversationId,
  });
  if (error) throw error;
  return (data ?? null) as ReadSummary | null;
}
