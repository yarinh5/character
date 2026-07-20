import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type StickerMessage = {
  id: string;
  conversation_id: string;
  sender_type: "client" | "operator" | "admin" | "system";
  sender_id: string | null;
  content: string;
  created_at: string;
  is_read: boolean;
};

export type StickerMessageHydration = {
  id: string;
  message_id: string;
  sticker_id: string;
  sticker_name_snapshot: string;
  collection_name_snapshot: string;
  created_at: string;
};

export type StickerSendResult = {
  message?: StickerMessage;
  message_sticker?: StickerMessageHydration;
  already_sent?: boolean;
};

type StickerSendRole = "client" | "operator";
const SERVER_COOLDOWN_MS = 2000;

function createIdempotencyKey() {
  return crypto.randomUUID();
}

export function useStickerSend(conversationId: string, role: StickerSendRole) {
  const [sendingStickerId, setSendingStickerId] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const attemptKeysRef = useRef(new Map<string, string>());

  useEffect(() => {
    attemptKeysRef.current.clear();
  }, [conversationId, role]);

  useEffect(() => {
    if (!cooldownUntil) return;
    const delay = Math.max(0, cooldownUntil - Date.now());
    const timeout = window.setTimeout(() => setClock(Date.now()), delay);
    return () => window.clearTimeout(timeout);
  }, [cooldownUntil]);

  const send = useCallback(
    async (stickerId: string): Promise<{ result: StickerSendResult | null; errorCode: string | null }> => {
      if (sendingStickerId || Date.now() < cooldownUntil) {
        return { result: null, errorCode: "sticker_rate_limited" };
      }

      const attemptKey = `${conversationId}:${role}:${stickerId}`;
      const idempotencyKey = attemptKeysRef.current.get(attemptKey) ?? createIdempotencyKey();
      attemptKeysRef.current.set(attemptKey, idempotencyKey);
      setSendingStickerId(stickerId);

      try {
        const { data, error } = await supabase.rpc(
          role === "client" ? "send_client_sticker_message" : "send_operator_sticker_message",
          {
            _conversation_id: conversationId,
            _sticker_id: stickerId,
            _idempotency_key: idempotencyKey,
          },
        );

        if (error) {
          const errorCode = error.message || "sticker_send_failed";
          if (errorCode.includes("sticker_rate_limited")) {
            setCooldownUntil(Date.now() + SERVER_COOLDOWN_MS);
          }
          return { result: null, errorCode };
        }

        attemptKeysRef.current.delete(attemptKey);
        setCooldownUntil(Date.now() + SERVER_COOLDOWN_MS);
        return { result: (data ?? null) as StickerSendResult | null, errorCode: null };
      } catch {
        return { result: null, errorCode: "sticker_send_failed" };
      } finally {
        setSendingStickerId(null);
      }
    },
    [conversationId, cooldownUntil, role, sendingStickerId],
  );

  return {
    send,
    sendingStickerId,
    isCoolingDown: clock < cooldownUntil,
  };
}
