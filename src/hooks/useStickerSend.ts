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
  balance?: number | null;
  already_sent?: boolean;
  cycle_id?: string | null;
};

export type OperatorCycleContinuity = {
  conversationId: string;
  cycleId: string | null;
  version: number;
  refreshSequence: number;
};

export type OperatorCycleRefreshTicket = {
  conversationId: string;
  version: number;
  refreshSequence: number;
};

export type OperatorSendScope = {
  conversationId: string;
  generation: number;
};

export type OperatorSendTicket = OperatorSendScope & {
  requestId: number;
  expectedCycleId: string | null;
};

type OperatorCycleResult = {
  cycle_id?: unknown;
  state?: unknown;
};

export function buildOperatorMediaSendArgs({
  accessMode,
  caption,
  expectedCycleId,
  reservationId,
  viewMode,
}: {
  accessMode: "standard" | "locked";
  caption: string;
  expectedCycleId?: string | null;
  reservationId: string;
  viewMode: "permanent" | "view_once" | "paid_open";
}) {
  const strictArgs = {
    _reservation_id: reservationId,
    _caption: caption.trim(),
    _expected_cycle_id: expectedCycleId ?? null,
  };
  return accessMode === "locked" ? strictArgs : { ...strictArgs, _view_mode: viewMode };
}

export function createOperatorCycleContinuity(conversationId: string): OperatorCycleContinuity {
  return { conversationId, cycleId: null, version: 0, refreshSequence: 0 };
}

export function switchOperatorCycleConversation(
  current: OperatorCycleContinuity,
  conversationId: string,
): OperatorCycleContinuity {
  if (current.conversationId === conversationId) return current;
  return {
    conversationId,
    cycleId: null,
    version: current.version + 1,
    refreshSequence: current.refreshSequence + 1,
  };
}

export function selectOperatorCycleId(current: OperatorCycleContinuity, conversationId: string) {
  return current.conversationId === conversationId ? current.cycleId : null;
}

export function createOperatorSendTicket(
  scope: OperatorSendScope,
  requestId: number,
  expectedCycleId: string | null = null,
): OperatorSendTicket {
  return { ...scope, requestId, expectedCycleId };
}

export function isOperatorSendTicketCurrent(
  current: OperatorSendScope,
  ticket: OperatorSendTicket,
) {
  return (
    current.conversationId === ticket.conversationId && current.generation === ticket.generation
  );
}

export function useOperatorSendScope(conversationId: string) {
  const scopeRef = useRef<OperatorSendScope>({ conversationId, generation: 0 });
  const requestSequenceRef = useRef(0);
  const [, setRevision] = useState(0);

  if (scopeRef.current.conversationId !== conversationId) {
    scopeRef.current = {
      conversationId,
      generation: scopeRef.current.generation + 1,
    };
  }

  const beginRequest = useCallback(
    (expectedCycleId: string | null = null) =>
      createOperatorSendTicket(scopeRef.current, ++requestSequenceRef.current, expectedCycleId),
    [],
  );
  const isCurrent = useCallback(
    (ticket: OperatorSendTicket) => isOperatorSendTicketCurrent(scopeRef.current, ticket),
    [],
  );
  const completeRequest = useCallback((ticket: OperatorSendTicket, effect: () => void) => {
    if (!isOperatorSendTicketCurrent(scopeRef.current, ticket)) return false;
    effect();
    return true;
  }, []);
  const invalidate = useCallback(() => {
    scopeRef.current = {
      ...scopeRef.current,
      generation: scopeRef.current.generation + 1,
    };
    setRevision((current) => current + 1);
  }, []);

  return {
    conversationId: scopeRef.current.conversationId,
    generation: scopeRef.current.generation,
    beginRequest,
    completeRequest,
    invalidate,
    isCurrent,
  };
}

export function beginOperatorCycleRefresh(
  current: OperatorCycleContinuity,
  conversationId: string,
): { state: OperatorCycleContinuity; ticket: OperatorCycleRefreshTicket } {
  const switched = switchOperatorCycleConversation(current, conversationId);
  const state = { ...switched, refreshSequence: switched.refreshSequence + 1 };
  return {
    state,
    ticket: {
      conversationId,
      version: state.version,
      refreshSequence: state.refreshSequence,
    },
  };
}

export function applySuccessfulOperatorSend(
  current: OperatorCycleContinuity,
  scope: OperatorSendScope,
  ticket: OperatorSendTicket,
  result: OperatorCycleResult,
): OperatorCycleContinuity {
  if (
    current.conversationId !== ticket.conversationId ||
    !isOperatorSendTicketCurrent(scope, ticket) ||
    typeof result.cycle_id !== "string" ||
    (ticket.expectedCycleId !== null && ticket.expectedCycleId !== result.cycle_id) ||
    (current.cycleId !== null && current.cycleId !== result.cycle_id)
  ) {
    return current;
  }
  return { ...current, cycleId: result.cycle_id, version: current.version + 1 };
}

export function applyOperatorCycleRefresh(
  current: OperatorCycleContinuity,
  ticket: OperatorCycleRefreshTicket,
  result: OperatorCycleResult,
): OperatorCycleContinuity {
  if (
    current.conversationId !== ticket.conversationId ||
    current.version !== ticket.version ||
    current.refreshSequence !== ticket.refreshSequence
  ) {
    return current;
  }
  const cycleId =
    result.state === "mine" && typeof result.cycle_id === "string" ? result.cycle_id : null;
  return { ...current, cycleId, version: current.version + 1 };
}

export type ConversationResponsibility = "mine" | "available" | "other" | "closed";

// Keep refresh acceptance and send invalidation in the same ownership boundary.
export function useOperatorSendOwnership(
  conversationId: string,
  isAdmin: boolean,
  operatorId?: string,
) {
  const [responsibilitySnapshot, setResponsibilityState] = useState<{
    conversationId: string;
    state: ConversationResponsibility | null;
  }>(() => ({ conversationId, state: null }));
  const [cycleContinuity, setCycleContinuity] = useState(() =>
    createOperatorCycleContinuity(conversationId),
  );
  const sendScope = useOperatorSendScope(conversationId);
  const { invalidate } = sendScope;
  const responsibilityRef = useRef(responsibilitySnapshot);
  const setResponsibilitySnapshot = useCallback((next: typeof responsibilitySnapshot) => {
    responsibilityRef.current = next;
    setResponsibilityState(next);
  }, []);
  const activeConversationIdRef = useRef(conversationId);
  const cycleContinuityRef = useRef(cycleContinuity);
  activeConversationIdRef.current = conversationId;
  const updateCycleContinuity = useCallback((next: OperatorCycleContinuity) => {
    cycleContinuityRef.current = next;
    setCycleContinuity(next);
  }, []);

  useEffect(() => {
    const next = switchOperatorCycleConversation(cycleContinuityRef.current, conversationId);
    if (next !== cycleContinuityRef.current) updateCycleContinuity(next);
    if (responsibilityRef.current.conversationId !== conversationId) {
      setResponsibilitySnapshot({ conversationId, state: null });
    }
  }, [conversationId, setResponsibilitySnapshot, updateCycleContinuity]);

  const refreshResponsibility = useCallback(async () => {
    if (isAdmin || !operatorId) {
      setResponsibilitySnapshot({ conversationId, state: null });
      const current = switchOperatorCycleConversation(cycleContinuityRef.current, conversationId);
      updateCycleContinuity({ ...current, cycleId: null, version: current.version + 1 });
      return;
    }
    const refresh = beginOperatorCycleRefresh(cycleContinuityRef.current, conversationId);
    updateCycleContinuity(refresh.state);
    const { data, error } = await supabase.rpc("get_operator_conversation_responsibility", {
      _conversation_id: conversationId,
    });
    const state = data?.[0]?.state;
    if (
      !error &&
      (state === "mine" || state === "available" || state === "other" || state === "closed")
    ) {
      const current = switchOperatorCycleConversation(
        cycleContinuityRef.current,
        activeConversationIdRef.current,
      );
      const next = applyOperatorCycleRefresh(current, refresh.ticket, data?.[0] ?? {});
      if (next === current) return;
      const knownResponsibility =
        responsibilityRef.current.conversationId === conversationId
          ? responsibilityRef.current.state
          : null;
      const matchingAtomicClaimObservation =
        knownResponsibility === "available" &&
        state === "mine" &&
        current.cycleId === null &&
        next.cycleId !== null;
      if (
        !matchingAtomicClaimObservation &&
        ((knownResponsibility !== null && knownResponsibility !== state) ||
          (current.cycleId !== null && current.cycleId !== next.cycleId))
      ) {
        invalidate();
      }
      updateCycleContinuity(next);
      setResponsibilitySnapshot({ conversationId, state });
    }
  }, [
    conversationId,
    invalidate,
    isAdmin,
    operatorId,
    setResponsibilitySnapshot,
    updateCycleContinuity,
  ]);

  const applySuccessfulSendCycle = useCallback(
    (ticket: OperatorSendTicket, result: { cycle_id?: unknown }, effect?: () => void) => {
      if (!sendScope.isCurrent(ticket) || typeof result.cycle_id !== "string") return false;
      const current = switchOperatorCycleConversation(
        cycleContinuityRef.current,
        activeConversationIdRef.current,
      );
      const knownResponsibility =
        responsibilityRef.current.conversationId === ticket.conversationId
          ? responsibilityRef.current.state
          : null;
      if (
        current.conversationId !== ticket.conversationId ||
        knownResponsibility === "other" ||
        knownResponsibility === "closed" ||
        (ticket.expectedCycleId !== null && ticket.expectedCycleId !== result.cycle_id) ||
        (current.cycleId !== null && current.cycleId !== result.cycle_id)
      ) {
        return false;
      }

      const next = applySuccessfulOperatorSend(
        current,
        { conversationId: sendScope.conversationId, generation: sendScope.generation },
        ticket,
        result,
      );
      if (next !== current) updateCycleContinuity(next);
      if (knownResponsibility !== "mine") {
        setResponsibilitySnapshot({ conversationId: ticket.conversationId, state: "mine" });
      }
      effect?.();
      return true;
    },
    [sendScope, setResponsibilitySnapshot, updateCycleContinuity],
  );

  const releaseOwnership = () => {
    sendScope.invalidate();
    setResponsibilitySnapshot({ conversationId, state: "available" });
    const current = switchOperatorCycleConversation(cycleContinuityRef.current, conversationId);
    updateCycleContinuity({ ...current, cycleId: null, version: current.version + 1 });
  };

  return {
    sendScope,
    responsibility:
      responsibilitySnapshot.conversationId === conversationId
        ? responsibilitySnapshot.state
        : null,
    responsibilityCycleId: selectOperatorCycleId(cycleContinuity, conversationId),
    refreshResponsibility,
    applySuccessfulSendCycle,
    releaseOwnership,
  };
}

type StickerSendRole = "client" | "operator" | "admin";
const SERVER_COOLDOWN_MS = 2000;

function createIdempotencyKey() {
  return crypto.randomUUID();
}

function rpcErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return "sticker_send_failed";
  const candidate = error as {
    message?: unknown;
    details?: unknown;
    hint?: unknown;
    code?: unknown;
  };
  return (
    [candidate.message, candidate.details, candidate.hint, candidate.code]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" ") || "sticker_send_failed"
  );
}

export function useStickerSend(
  conversationId: string,
  role: StickerSendRole,
  expectedCycleId?: string | null,
  requestGeneration = 0,
) {
  const [sendingStickerId, setSendingStickerId] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const attemptKeysRef = useRef(new Map<string, string>());
  const requestSequenceRef = useRef(0);
  const activeRequestRef = useRef<number | null>(null);
  const requestContextRef = useRef({ conversationId, role, generation: requestGeneration });

  const nextRequestContext = { conversationId, role, generation: requestGeneration };
  if (
    requestContextRef.current.conversationId !== nextRequestContext.conversationId ||
    requestContextRef.current.role !== nextRequestContext.role ||
    requestContextRef.current.generation !== nextRequestContext.generation
  ) {
    requestContextRef.current = nextRequestContext;
    activeRequestRef.current = null;
  }

  useEffect(() => {
    attemptKeysRef.current.clear();
    setSendingStickerId(null);
  }, [conversationId, requestGeneration, role]);

  useEffect(() => {
    if (!cooldownUntil) return;
    const delay = Math.max(0, cooldownUntil - Date.now());
    const timeout = window.setTimeout(() => setClock(Date.now()), delay);
    return () => window.clearTimeout(timeout);
  }, [cooldownUntil]);

  const send = useCallback(
    async (
      stickerId: string,
    ): Promise<{ result: StickerSendResult | null; errorCode: string | null }> => {
      if (sendingStickerId || Date.now() < cooldownUntil) {
        return { result: null, errorCode: "sticker_rate_limited" };
      }

      const attemptKey = `${conversationId}:${role}:${stickerId}`;
      const idempotencyKey = attemptKeysRef.current.get(attemptKey) ?? createIdempotencyKey();
      attemptKeysRef.current.set(attemptKey, idempotencyKey);
      const requestId = ++requestSequenceRef.current;
      const requestContext = requestContextRef.current;
      activeRequestRef.current = requestId;
      setSendingStickerId(stickerId);

      const isCurrentRequest = () =>
        activeRequestRef.current === requestId &&
        requestContextRef.current.conversationId === requestContext.conversationId &&
        requestContextRef.current.role === requestContext.role &&
        requestContextRef.current.generation === requestContext.generation;

      try {
        const args = {
          _conversation_id: conversationId,
          _sticker_id: stickerId,
          _idempotency_key: idempotencyKey,
        };
        const { data, error } =
          role === "client"
            ? await supabase.rpc("send_client_sticker_message", args)
            : role === "admin"
              ? await supabase.rpc("send_admin_sticker_message", args)
              : await supabase.rpc("send_operator_sticker_message", {
                  ...args,
                  _expected_cycle_id: expectedCycleId ?? null,
                });

        if (!isCurrentRequest()) return { result: null, errorCode: null };

        if (error) {
          const errorCode = rpcErrorCode(error);
          if (errorCode.includes("sticker_rate_limited")) {
            setCooldownUntil(Date.now() + SERVER_COOLDOWN_MS);
          }
          return { result: null, errorCode };
        }

        attemptKeysRef.current.delete(attemptKey);
        setCooldownUntil(Date.now() + SERVER_COOLDOWN_MS);
        return { result: (data ?? null) as StickerSendResult | null, errorCode: null };
      } catch {
        if (!isCurrentRequest()) return { result: null, errorCode: null };
        return { result: null, errorCode: "sticker_send_failed" };
      } finally {
        if (isCurrentRequest()) {
          activeRequestRef.current = null;
          setSendingStickerId(null);
        }
      }
    },
    [conversationId, cooldownUntil, expectedCycleId, role, sendingStickerId],
  );

  return {
    send,
    sendingStickerId,
    isCoolingDown: clock < cooldownUntil,
  };
}
