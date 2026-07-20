import { useCallback, useEffect, useRef, useState } from "react";
import type { Database } from "@/integrations/supabase/types";
import { supabase } from "@/integrations/supabase/client";

export type ConversationSticker =
  Database["public"]["Functions"]["get_conversation_stickers"]["Returns"][number];

type CatalogStatus = "idle" | "loading" | "ready" | "disabled" | "error";

export function useConversationStickers(conversationId: string, enabled: boolean) {
  const [stickers, setStickers] = useState<ConversationSticker[]>([]);
  const [status, setStatus] = useState<CatalogStatus>(enabled ? "loading" : "idle");
  const requestVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setStatus("idle");
      return;
    }

    const requestVersion = ++requestVersionRef.current;
    setStatus("loading");
    const { data, error } = await supabase.rpc("get_conversation_stickers", {
      _conversation_id: conversationId,
    });
    if (requestVersion !== requestVersionRef.current) return;

    if (error) {
      setStickers([]);
      setStatus(error.message.includes("stickers_disabled") ? "disabled" : "error");
      return;
    }

    setStickers(data ?? []);
    setStatus("ready");
  }, [conversationId, enabled]);

  useEffect(() => {
    void refresh();
    return () => {
      requestVersionRef.current += 1;
    };
  }, [refresh]);

  return { stickers, status, refresh };
}
