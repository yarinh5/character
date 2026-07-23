import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type OperatorOutreachResult = {
  conversation_id?: string;
  message_id?: string;
  status?: string;
  idempotent_replay?: boolean;
};

type OutreachArgs = {
  clientId: string;
  characterId: string;
  message: string;
};

function errorCode(error: unknown) {
  if (!error || typeof error !== "object") return "operator_outreach_failed";
  const candidate = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
  return [candidate.message, candidate.details, candidate.hint, candidate.code]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ") || "operator_outreach_failed";
}

export function operatorOutreachErrorMessage(code: string) {
  if (code.includes("outreach_rate_limited")) return "כבר נשלחה פנייה ללקוח הזה בשם דמות זו. אפשר לנסות שוב בעוד 24 שעות.";
  if (code.includes("operator_not_assigned_to_character")) return "אין לך שיוך לדמות שנבחרה.";
  if (code.includes("client_blocked_by_operator") || code.includes("client_blocked_for_operator")) return "לא ניתן לשלוח פנייה ללקוח הזה.";
  if (code.includes("outreach_pending_new_exists")) return "כבר ממתינה פנייה חדשה של הלקוח לדמות הזו.";
  if (code.includes("outreach_conversation_in_progress")) return "השיחה כבר בטיפול פעיל.";
  if (code.includes("outreach_idempotency_key_reused")) return "ניסיון השליחה אינו תקין. נסה לנסח הודעה חדשה.";
  if (code.includes("client_not_available") || code.includes("client_not_active")) return "הלקוח אינו זמין לפנייה כרגע.";
  return "לא ניתן לשלוח את הפנייה כרגע. נסה שוב.";
}

export function useOperatorOutreachSend() {
  const queryClient = useQueryClient();
  const [sendingTarget, setSendingTarget] = useState<string | null>(null);
  const attemptKeysRef = useRef(new Map<string, string>());

  const send = useCallback(async ({ clientId, characterId, message }: OutreachArgs) => {
    const target = `${clientId}:${characterId}`;
    if (sendingTarget) return { result: null, errorCode: "outreach_in_progress" };

    const normalizedMessage = message.trim();
    const attemptKey = `${target}:${normalizedMessage}`;
    const idempotencyKey = attemptKeysRef.current.get(attemptKey) ?? crypto.randomUUID();
    attemptKeysRef.current.set(attemptKey, idempotencyKey);
    setSendingTarget(target);

    try {
      const { data, error } = await supabase.rpc("start_operator_outreach", {
        _client_id: clientId,
        _character_id: characterId,
        _message: normalizedMessage,
        _idempotency_key: idempotencyKey,
      });
      if (error) return { result: null, errorCode: errorCode(error) };

      attemptKeysRef.current.delete(attemptKey);
      await queryClient.invalidateQueries({ queryKey: ["operator-online-candidates"] });
      return { result: (data ?? null) as OperatorOutreachResult | null, errorCode: null };
    } catch {
      return { result: null, errorCode: "operator_outreach_failed" };
    } finally {
      setSendingTarget(null);
    }
  }, [queryClient, sendingTarget]);

  return { send, sendingTarget };
}
