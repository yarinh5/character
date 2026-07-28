import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type OperatorNewQueueItem = {
  work_item_id: string;
  conversation_id: string;
  character_id: string;
  status: string;
  queue_state: "new" | "returned";
  client_display_name: string | null;
  character_name: string;
  character_avatar_url: string | null;
  last_client_preview: string;
  last_activity_at: string;
  created_at: string;
  wait_seconds: number;
  sla_state: "normal" | "warning" | "critical";
};

export type OperatorNewSlaSummary = {
  total_new: number;
  warning_count: number;
  critical_count: number;
  oldest_wait_seconds: number;
};

const EMPTY_SLA_SUMMARY: OperatorNewSlaSummary = {
  total_new: 0,
  warning_count: 0,
  critical_count: 0,
  oldest_wait_seconds: 0,
};

type ClaimResult =
  | { ok: true; conversationId: string }
  | { ok: false; errorMessage: string };

export function operatorNewQueueClaimError(message: string) {
  if (message.includes("conversation_already_claimed")) return "השיחה כבר נלקחה על ידי עובד אחר.";
  if (message.includes("conversation_locked_by_other_operator")) return "השיחה נעולה כרגע על ידי עובד אחר.";
  if (message.includes("operator_not_assigned_to_character")) return "אין לך שיוך לדמות של השיחה הזו.";
  if (message.includes("conversation_closed")) return "השיחה כבר נסגרה.";
  return "לא ניתן לקחת את השיחה כרגע. נסה שוב.";
}

export function useOperatorNewSlaSummary(operatorId?: string | null) {
  const query = useQuery({
    queryKey: ["operator-new-sla-summary", operatorId],
    enabled: Boolean(operatorId),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_operator_new_sla_summary");
      if (error) throw error;
      return ((data ?? [EMPTY_SLA_SUMMARY])[0] ?? EMPTY_SLA_SUMMARY) as OperatorNewSlaSummary;
    },
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
  });

  return { ...query, summary: query.data ?? EMPTY_SLA_SUMMARY };
}

export function useOperatorNewQueue(operatorId?: string | null) {
  const queryClient = useQueryClient();
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const slaSummary = useOperatorNewSlaSummary(operatorId);

  const query = useQuery({
    queryKey: ["operator-new-queue", operatorId],
    enabled: Boolean(operatorId),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_operator_new_queue");
      if (error) throw error;
      return (data ?? []) as OperatorNewQueueItem[];
    },
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    if (!operatorId) return;

    const refreshQueue = () => {
      void queryClient.invalidateQueries({ queryKey: ["operator-new-queue", operatorId] });
      void queryClient.invalidateQueries({ queryKey: ["operator-new-sla-summary", operatorId] });
    };

    const channel = supabase
      .channel(`operator-new-sla-${operatorId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "conversation_work_items" }, refreshQueue)
      .on("postgres_changes", { event: "*", schema: "public", table: "conversation_handling_cycles" }, refreshQueue)
      .on("postgres_changes", { event: "*", schema: "public", table: "operator_client_blocks" }, refreshQueue)
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [operatorId, queryClient]);

  const claimConversation = async (workItemId: string): Promise<ClaimResult> => {
    if (claimingId) return { ok: false, errorMessage: "claim_in_progress" };

    setClaimingId(workItemId);
    try {
      const { data, error } = await supabase.rpc("claim_new_conversation", {
        _work_item_id: workItemId,
      });

      if (error) {
        await query.refetch();
        return { ok: false, errorMessage: error.message };
      }

      const result = data as { conversation_id?: string } | null;
      if (!result?.conversation_id) {
        await query.refetch();
        return { ok: false, errorMessage: "missing_claimed_conversation" };
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["operator-new-queue"] }),
        queryClient.invalidateQueries({ queryKey: ["operator-new-sla-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["operator-conversations"] }),
      ]);

      return { ok: true, conversationId: result.conversation_id };
    } finally {
      setClaimingId(null);
    }
  };

  return {
    ...query,
    items: query.data ?? [],
    slaSummary: slaSummary.summary,
    isSlaSummaryLoading: slaSummary.isLoading,
    claimingId,
    claimConversation,
  };
}
