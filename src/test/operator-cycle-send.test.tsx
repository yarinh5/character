import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyOperatorCycleRefresh,
  applySuccessfulOperatorSend,
  beginOperatorCycleRefresh,
  buildOperatorMediaSendArgs,
  createOperatorSendTicket,
  createOperatorCycleContinuity,
  isOperatorSendTicketCurrent,
  selectOperatorCycleId,
  switchOperatorCycleConversation,
  useOperatorSendScope,
  useOperatorSendOwnership,
  type OperatorSendTicket,
} from "@/hooks/useStickerSend";
import { StickerPicker } from "@/components/chat/StickerPicker";
import { OperatorMediaPicker } from "@/components/operator/OperatorMediaPicker";
import { toast } from "sonner";
import { fixtureEventRowBelongsToOwnership } from "../../supabase/tests/http/v4_3_http_fixtures";

const rpcMock = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: rpcMock },
}));

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/useStickerViewUrl", () => ({
  useConversationStickerViewUrl: () => ({ status: "ready", url: "https://example.test/sticker" }),
}));
vi.mock("@/hooks/useConversationStickers", () => ({
  useConversationStickers: () => ({
    status: "ready",
    stickers: [
      {
        sticker_id: "00000000-0000-4000-8000-000000000301",
        name: "בדיקה",
        collection_name: "אוסף",
        price_credits: 0,
      },
    ],
    refresh: vi.fn(),
  }),
}));
vi.mock("@/hooks/useMediaViewUrl", () => ({
  useMediaViewUrl: (_purpose: string, reservationId?: string) =>
    reservationId
      ? { status: "ready", url: "https://example.test/media", retryAfterImageError: vi.fn() }
      : { status: "idle", url: null, retryAfterImageError: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const conversationA = "00000000-0000-4000-8000-000000000001";
const conversationB = "00000000-0000-4000-8000-000000000002";
const cycleA = "00000000-0000-4000-8000-000000000101";
const cycleB = "00000000-0000-4000-8000-000000000102";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function useDeferredCompletionHarness(conversationId: string) {
  const scope = useOperatorSendScope(conversationId);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<string[]>([]);
  const [continuity, setContinuity] = useState(() => createOperatorCycleContinuity(conversationId));
  const [responsibility, setResponsibility] = useState<"mine" | "available">("available");

  const start = (completion: Promise<{ message: string; cycle_id: string }>) => {
    const ticket = scope.beginRequest();
    void completion.then((result) => {
      scope.completeRequest(ticket, () => {
        setMessages((current) => [...current, result.message]);
        setDraft("");
        setContinuity((current) =>
          applySuccessfulOperatorSend(
            switchOperatorCycleConversation(current, ticket.conversationId),
            { conversationId: scope.conversationId, generation: scope.generation },
            ticket,
            result,
          ),
        );
        setResponsibility("mine");
      });
    });
    return ticket;
  };

  return {
    ...scope,
    cycleId: selectOperatorCycleId(continuity, conversationId),
    draft,
    messages,
    responsibility,
    setDraft,
    start,
  };
}

const mediaAsset = {
  id: "00000000-0000-4000-8000-000000000401",
  display_name: "מדיית בדיקה",
  byte_size: 1024,
  content_type: "image/png",
  is_reservable: true,
  is_locked_reservable: false,
  is_reserved_by_me: false,
  my_reservation_id: null,
  my_reservation_expires_at: null,
  my_reservation_access_mode: null,
  paid_open_price_credits: null,
  locked_price_credits: null,
  locked_images_enabled: false,
  status: "ready",
};

beforeEach(() => {
  rpcMock.mockReset();
});

describe("operator media strict-send arguments", () => {
  it.each([
    ["standard", "permanent"],
    ["locked", "permanent"],
  ] as const)("keeps an empty _caption for %s media", (accessMode, viewMode) => {
    const args = buildOperatorMediaSendArgs({
      accessMode,
      caption: "   ",
      expectedCycleId: null,
      reservationId: "00000000-0000-4000-8000-000000000201",
      viewMode,
    });

    expect(args).toHaveProperty("_caption", "");
    expect(args).toHaveProperty("_expected_cycle_id", null);
  });
});

describe("operator cycle continuity without Realtime", () => {
  it.each(["text", "media", "sticker"])("uses the returned cycle for the next %s send", () => {
    const initial = createOperatorCycleContinuity(conversationA);
    const scope = { conversationId: conversationA, generation: 0 };
    const ticket = createOperatorSendTicket(scope, 1);
    expect(selectOperatorCycleId(initial, conversationA)).toBeNull();
    const afterFirstSend = applySuccessfulOperatorSend(initial, scope, ticket, {
      cycle_id: cycleA,
    });
    expect(selectOperatorCycleId(afterFirstSend, conversationA)).toBe(cycleA);
  });

  it("preserves continuity for media-first and sticker-first sequences", () => {
    const scopeA = { conversationId: conversationA, generation: 0 };
    const scopeB = { conversationId: conversationB, generation: 1 };
    const mediaFirst = applySuccessfulOperatorSend(
      createOperatorCycleContinuity(conversationA),
      scopeA,
      createOperatorSendTicket(scopeA, 1),
      { cycle_id: cycleA },
    );
    expect(selectOperatorCycleId(mediaFirst, conversationA)).toBe(cycleA);
    const stickerFirst = applySuccessfulOperatorSend(
      createOperatorCycleContinuity(conversationB),
      scopeB,
      createOperatorSendTicket(scopeB, 1),
      { cycle_id: cycleB },
    );
    expect(selectOperatorCycleId(stickerFirst, conversationB)).toBe(cycleB);
  });

  it("ignores a late send result from the previous conversation", () => {
    const switched = switchOperatorCycleConversation(
      createOperatorCycleContinuity(conversationA),
      conversationB,
    );
    const oldScope = { conversationId: conversationA, generation: 0 };
    const currentScope = { conversationId: conversationB, generation: 1 };
    const afterLateResult = applySuccessfulOperatorSend(
      switched,
      currentScope,
      createOperatorSendTicket(oldScope, 1),
      {
        cycle_id: cycleA,
      },
    );
    expect(afterLateResult).toBe(switched);
    expect(selectOperatorCycleId(afterLateResult, conversationB)).toBeNull();
  });

  it("does not revalidate an old A request after A to B to A", () => {
    const oldScope = { conversationId: conversationA, generation: 0 };
    const currentScope = { conversationId: conversationA, generation: 2 };
    const initial = createOperatorCycleContinuity(conversationA);
    const oldTicket = createOperatorSendTicket(oldScope, 1);

    expect(isOperatorSendTicketCurrent(currentScope, oldTicket)).toBe(false);
    expect(
      applySuccessfulOperatorSend(initial, currentScope, oldTicket, { cycle_id: cycleA }),
    ).toBe(initial);
  });

  it("does not let an older refresh overwrite a newer send token", () => {
    const initial = createOperatorCycleContinuity(conversationA);
    const refresh = beginOperatorCycleRefresh(initial, conversationA);
    const scope = { conversationId: conversationA, generation: 0 };
    const afterSend = applySuccessfulOperatorSend(
      refresh.state,
      scope,
      createOperatorSendTicket(scope, 1),
      {
        cycle_id: cycleB,
      },
    );
    const afterStaleRefresh = applyOperatorCycleRefresh(afterSend, refresh.ticket, {
      state: "mine",
      cycle_id: cycleA,
    });
    expect(afterStaleRefresh).toBe(afterSend);
    expect(selectOperatorCycleId(afterStaleRefresh, conversationA)).toBe(cycleB);
  });

  it("does not create a token from a result without a cycle_id", () => {
    const initial = createOperatorCycleContinuity(conversationA);
    const scope = { conversationId: conversationA, generation: 0 };
    expect(
      applySuccessfulOperatorSend(initial, scope, createOperatorSendTicket(scope, 1), {}),
    ).toBe(initial);
  });
});

describe("operator send completion scope with deferred promises", () => {
  it("keeps an A text completion out of B and preserves B's draft", async () => {
    const oldSend = deferred<{ message: string; cycle_id: string }>();
    const { result, rerender } = renderHook(
      ({ conversationId }) => useDeferredCompletionHarness(conversationId),
      { initialProps: { conversationId: conversationA } },
    );

    act(() => {
      result.current.start(oldSend.promise);
    });
    rerender({ conversationId: conversationB });
    act(() => result.current.setDraft("טיוטה של B"));
    await act(async () => oldSend.resolve({ message: "הודעת A", cycle_id: cycleA }));

    expect(result.current.messages).toEqual([]);
    expect(result.current.draft).toBe("טיוטה של B");
    expect(result.current.cycleId).toBeNull();
    expect(result.current.responsibility).toBe("available");
  });

  it("rejects an old A completion after A to B to A without rejecting the current A send", async () => {
    const oldSend = deferred<{ message: string; cycle_id: string }>();
    const currentSend = deferred<{ message: string; cycle_id: string }>();
    const { result, rerender } = renderHook(
      ({ conversationId }) => useDeferredCompletionHarness(conversationId),
      { initialProps: { conversationId: conversationA } },
    );

    act(() => result.current.start(oldSend.promise));
    rerender({ conversationId: conversationB });
    rerender({ conversationId: conversationA });
    act(() => result.current.start(currentSend.promise));
    await act(async () => currentSend.resolve({ message: "A חדש", cycle_id: cycleB }));
    await act(async () => oldSend.resolve({ message: "A ישן", cycle_id: cycleA }));

    expect(result.current.messages).toEqual(["A חדש"]);
    expect(result.current.cycleId).toBe(cycleB);
    expect(result.current.responsibility).toBe("mine");
  });

  it("does not restore ownership after the current scope is explicitly invalidated", async () => {
    const oldSend = deferred<{ message: string; cycle_id: string }>();
    const { result } = renderHook(() => useDeferredCompletionHarness(conversationA));

    act(() => result.current.start(oldSend.promise));
    act(() => result.current.invalidate());
    await act(async () => oldSend.resolve({ message: "ישן", cycle_id: cycleA }));

    expect(result.current.messages).toEqual([]);
    expect(result.current.cycleId).toBeNull();
    expect(result.current.responsibility).toBe("available");
  });
});

describe("responsibility refresh invalidates the product send scope", () => {
  it("accepts an atomic claim completion when refresh already observed the same cycle", async () => {
    rpcMock.mockResolvedValueOnce({ data: [{ state: "available", cycle_id: null }], error: null });
    const { result } = renderHook(() => useOperatorSendOwnership(conversationA, false, "operator"));
    await act(async () => {
      await result.current.refreshResponsibility();
    });

    const ticket = result.current.sendScope.beginRequest();
    const completeSend = result.current.applySuccessfulSendCycle;
    const send = deferred<{ cycle_id: string }>();
    const completion = send.promise.then((payload) => completeSend(ticket, payload));
    rpcMock.mockResolvedValueOnce({ data: [{ state: "mine", cycle_id: cycleA }], error: null });

    await act(async () => {
      await result.current.refreshResponsibility();
    });
    expect(result.current.responsibility).toBe("mine");
    expect(result.current.responsibilityCycleId).toBe(cycleA);

    await act(async () => {
      send.resolve({ cycle_id: cycleA });
      await completion;
    });

    expect(await completion).toBe(true);
    expect(result.current.responsibility).toBe("mine");
    expect(result.current.responsibilityCycleId).toBe(cycleA);
  });

  it.each(["text", "media", "sticker"])(
    "runs the current %s UI completion once after a matching atomic-claim observation",
    async () => {
      rpcMock.mockResolvedValueOnce({
        data: [{ state: "available", cycle_id: null }],
        error: null,
      });
      const { result } = renderHook(() =>
        useOperatorSendOwnership(conversationA, false, "operator"),
      );
      await act(async () => {
        await result.current.refreshResponsibility();
      });
      const ticket = result.current.sendScope.beginRequest(result.current.responsibilityCycleId);
      const completionEffect = vi.fn();
      rpcMock.mockResolvedValueOnce({ data: [{ state: "mine", cycle_id: cycleA }], error: null });

      await act(async () => {
        await result.current.refreshResponsibility();
      });
      act(() => {
        expect(
          result.current.applySuccessfulSendCycle(ticket, { cycle_id: cycleA }, completionEffect),
        ).toBe(true);
      });

      expect(completionEffect).toHaveBeenCalledTimes(1);
      expect(result.current.responsibilityCycleId).toBe(cycleA);
    },
  );

  it("keeps a send-first C1 completion across a later matching refresh without repeating UI effects", async () => {
    rpcMock.mockResolvedValueOnce({ data: [{ state: "available", cycle_id: null }], error: null });
    const { result } = renderHook(() => useOperatorSendOwnership(conversationA, false, "operator"));
    await act(async () => {
      await result.current.refreshResponsibility();
    });
    const ticket = result.current.sendScope.beginRequest(result.current.responsibilityCycleId);
    const completionEffect = vi.fn();

    act(() => {
      expect(
        result.current.applySuccessfulSendCycle(ticket, { cycle_id: cycleA }, completionEffect),
      ).toBe(true);
    });
    rpcMock.mockResolvedValueOnce({ data: [{ state: "mine", cycle_id: cycleA }], error: null });
    await act(async () => {
      await result.current.refreshResponsibility();
    });

    expect(completionEffect).toHaveBeenCalledTimes(1);
    expect(result.current.responsibility).toBe("mine");
    expect(result.current.responsibilityCycleId).toBe(cycleA);
    expect(result.current.sendScope.isCurrent(ticket)).toBe(true);
  });

  it("rejects C1 UI effects when an atomic-claim observation established C2", async () => {
    rpcMock.mockResolvedValueOnce({ data: [{ state: "available", cycle_id: null }], error: null });
    const { result } = renderHook(() => useOperatorSendOwnership(conversationA, false, "operator"));
    await act(async () => {
      await result.current.refreshResponsibility();
    });
    const ticket = result.current.sendScope.beginRequest(result.current.responsibilityCycleId);
    const completionEffect = vi.fn();
    rpcMock.mockResolvedValueOnce({ data: [{ state: "mine", cycle_id: cycleB }], error: null });
    await act(async () => {
      await result.current.refreshResponsibility();
    });

    expect(
      result.current.applySuccessfulSendCycle(ticket, { cycle_id: cycleA }, completionEffect),
    ).toBe(false);
    expect(completionEffect).not.toHaveBeenCalled();
    expect(result.current.responsibility).toBe("mine");
    expect(result.current.responsibilityCycleId).toBe(cycleB);
  });

  it.each(["release", "loss"] as const)(
    "rejects a matching C1 response after ownership %s following observation",
    async (transition) => {
      rpcMock.mockResolvedValueOnce({
        data: [{ state: "available", cycle_id: null }],
        error: null,
      });
      const { result } = renderHook(() =>
        useOperatorSendOwnership(conversationA, false, "operator"),
      );
      await act(async () => {
        await result.current.refreshResponsibility();
      });
      const ticket = result.current.sendScope.beginRequest(result.current.responsibilityCycleId);
      rpcMock.mockResolvedValueOnce({ data: [{ state: "mine", cycle_id: cycleA }], error: null });
      await act(async () => {
        await result.current.refreshResponsibility();
      });
      if (transition === "release") {
        act(() => result.current.releaseOwnership());
      } else {
        rpcMock.mockResolvedValueOnce({ data: [{ state: "other", cycle_id: null }], error: null });
        await act(async () => {
          await result.current.refreshResponsibility();
        });
      }
      const completionEffect = vi.fn();

      expect(
        result.current.applySuccessfulSendCycle(ticket, { cycle_id: cycleA }, completionEffect),
      ).toBe(false);
      expect(completionEffect).not.toHaveBeenCalled();
      expect(result.current.responsibility).toBe(transition === "release" ? "available" : "other");
      expect(result.current.responsibilityCycleId).toBeNull();
    },
  );

  it.each([
    ["other", null],
    ["available", null],
    ["closed", null],
    ["mine", cycleB],
  ] as const)(
    "rejects a pending C1 send after refresh changes ownership to %s/%s",
    async (state, cycleId) => {
      rpcMock.mockResolvedValueOnce({ data: [{ state: "mine", cycle_id: cycleA }], error: null });
      const { result } = renderHook(() =>
        useOperatorSendOwnership(conversationA, false, "operator"),
      );
      await act(async () => {
        await result.current.refreshResponsibility();
      });
      const ticket = result.current.sendScope.beginRequest(result.current.responsibilityCycleId);
      const completeSend = result.current.applySuccessfulSendCycle;
      const send = deferred<{ cycle_id: string }>();
      const completion = send.promise.then((payload) => completeSend(ticket, payload));
      const refresh = deferred<{
        data: { state: string; cycle_id: string | null }[];
        error: null;
      }>();
      rpcMock.mockReturnValueOnce(refresh.promise);
      let refreshing!: Promise<void>;
      act(() => {
        refreshing = result.current.refreshResponsibility();
      });
      await act(async () => {
        refresh.resolve({ data: [{ state, cycle_id: cycleId }], error: null });
        await refreshing;
      });
      expect(result.current.responsibility).toBe(state);
      expect(result.current.responsibilityCycleId).toBe(cycleId);
      await act(async () => {
        send.resolve({ cycle_id: cycleA });
        await completion;
      });
      expect(await completion).toBe(false);
      expect(result.current.responsibility).toBe(state);
      expect(result.current.responsibilityCycleId).toBe(cycleId);
      expect(result.current.sendScope.generation).toBeGreaterThan(ticket.generation);
    },
  );

  it.each(["mine", "available"] as const)(
    "accepts a current send across unchanged %s refresh",
    async (state) => {
      const row = { state, cycle_id: state === "mine" ? cycleA : null };
      rpcMock.mockResolvedValueOnce({ data: [row], error: null });
      const { result } = renderHook(() =>
        useOperatorSendOwnership(conversationA, false, "operator"),
      );
      await act(async () => {
        await result.current.refreshResponsibility();
      });
      const ticket = result.current.sendScope.beginRequest(result.current.responsibilityCycleId);
      const completeSend = result.current.applySuccessfulSendCycle;
      const send = deferred<{ cycle_id: string }>();
      const completion = send.promise.then((payload) => completeSend(ticket, payload));
      const refresh = deferred<{ data: (typeof row)[]; error: null }>();
      rpcMock.mockReturnValueOnce(refresh.promise);
      let refreshing!: Promise<void>;
      act(() => {
        refreshing = result.current.refreshResponsibility();
      });
      await act(async () => {
        refresh.resolve({ data: [row], error: null });
        await refreshing;
      });
      expect(result.current.sendScope.generation).toBe(ticket.generation);
      await act(async () => {
        send.resolve({ cycle_id: state === "mine" ? cycleA : cycleB });
        await completion;
      });
      expect(await completion).toBe(true);
      expect(result.current.responsibilityCycleId).toBe(state === "mine" ? cycleA : cycleB);
      expect(result.current.responsibility).toBe("mine");
    },
  );

  it("ignores a stale loss-of-ownership refresh after a successful send", async () => {
    rpcMock.mockResolvedValueOnce({ data: [{ state: "mine", cycle_id: cycleA }], error: null });
    const { result } = renderHook(() => useOperatorSendOwnership(conversationA, false, "operator"));
    await act(async () => {
      await result.current.refreshResponsibility();
    });
    const refresh = deferred<{ data: { state: string; cycle_id: null }[]; error: null }>();
    rpcMock.mockReturnValueOnce(refresh.promise);
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = result.current.refreshResponsibility();
    });
    const ticket = result.current.sendScope.beginRequest(result.current.responsibilityCycleId);
    act(() => {
      result.current.applySuccessfulSendCycle(ticket, { cycle_id: cycleA });
    });
    await act(async () => {
      refresh.resolve({ data: [{ state: "available", cycle_id: null }], error: null });
      await refreshing;
    });
    expect(result.current.responsibility).toBe("mine");
    expect(result.current.responsibilityCycleId).toBe(cycleA);
    expect(result.current.sendScope.isCurrent(ticket)).toBe(true);
  });

  it.each([
    ["missing cycle", {}],
    ["cycle contradicting the original request", { cycle_id: cycleB }],
  ] as const)("rejects %s without running UI completion", async (_label, response) => {
    rpcMock.mockResolvedValueOnce({ data: [{ state: "mine", cycle_id: cycleA }], error: null });
    const { result } = renderHook(() => useOperatorSendOwnership(conversationA, false, "operator"));
    await act(async () => {
      await result.current.refreshResponsibility();
    });
    const ticket = result.current.sendScope.beginRequest(result.current.responsibilityCycleId);
    const completionEffect = vi.fn();

    expect(result.current.applySuccessfulSendCycle(ticket, response, completionEffect)).toBe(false);
    expect(completionEffect).not.toHaveBeenCalled();
    expect(result.current.responsibility).toBe("mine");
    expect(result.current.responsibilityCycleId).toBe(cycleA);
  });
});

describe("ownership orchestration regression", () => {
  it.each(["conversation revisit", "explicit release"] as const)(
    "rejects a late send after %s",
    async (transition) => {
      const { result, rerender } = renderHook(
        ({ conversationId }) => useOperatorSendOwnership(conversationId, false, "operator"),
        { initialProps: { conversationId: conversationA } },
      );
      const ticket = result.current.sendScope.beginRequest();
      const completeSend = result.current.applySuccessfulSendCycle;
      const send = deferred<{ cycle_id: string }>();
      const completion = send.promise.then((payload) => completeSend(ticket, payload));
      if (transition === "conversation revisit") {
        rerender({ conversationId: conversationB });
        rerender({ conversationId: conversationA });
        const currentTicket = result.current.sendScope.beginRequest();
        act(() => {
          result.current.applySuccessfulSendCycle(currentTicket, { cycle_id: cycleB });
        });
      } else {
        act(() => result.current.releaseOwnership());
      }
      await act(async () => {
        send.resolve({ cycle_id: cycleA });
        await completion;
      });
      expect(await completion).toBe(false);
      expect(result.current.responsibility).toBe(
        transition === "explicit release" ? "available" : "mine",
      );
      expect(result.current.responsibilityCycleId).toBe(
        transition === "explicit release" ? null : cycleB,
      );
    },
  );

  it("does not invalidate a send on a failed responsibility refresh", async () => {
    rpcMock.mockResolvedValueOnce({ data: [{ state: "mine", cycle_id: cycleA }], error: null });
    const { result } = renderHook(() => useOperatorSendOwnership(conversationA, false, "operator"));
    await act(async () => {
      await result.current.refreshResponsibility();
    });
    const ticket = result.current.sendScope.beginRequest(result.current.responsibilityCycleId);
    const failedRefresh = deferred<{ data: null; error: { message: string } }>();
    rpcMock.mockReturnValueOnce(failedRefresh.promise);
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = result.current.refreshResponsibility();
    });
    await act(async () => {
      failedRefresh.resolve({ data: null, error: { message: "refresh_failed" } });
      await refreshing;
    });
    expect(result.current.sendScope.isCurrent(ticket)).toBe(true);
    expect(result.current.responsibilityCycleId).toBe(cycleA);
    act(() => {
      expect(result.current.applySuccessfulSendCycle(ticket, { cycle_id: cycleA })).toBe(true);
    });
    expect(result.current.responsibilityCycleId).toBe(cycleA);
  });
});

describe("pending media reservations across conversations", () => {
  it.each([
    ["operator", "success", false],
    ["operator", "success", true],
    ["operator", "failure", false],
    ["operator", "cleanup failure", true],
    ["admin", "success", false],
  ] as const)("isolates %s A reserve %s (B resolved first: %s)", async (actor, outcome, bFirst) => {
    type ReserveResult = {
      data: { reservation_id: string; expires_at: string; intended_access_mode: string } | null;
      error: { message: string } | null;
    };
    const reserveA = deferred<ReserveResult>();
    const reserveB = deferred<ReserveResult>();
    const releaseA = deferred<{
      data: { released: boolean } | null;
      error: { message: string } | null;
    }>();
    const cleanupErrorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reserveRpc =
      actor === "admin"
        ? "reserve_admin_character_media_asset"
        : "reserve_character_media_for_delivery";
    const releaseRpc =
      actor === "admin"
        ? "release_admin_character_media_reservation"
        : "release_character_media_reservation";
    rpcMock.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === "get_operator_media_catalog" || name === "get_admin_media_catalog") {
        return Promise.resolve({
          data: [
            {
              ...mediaAsset,
              display_name: args._conversation_id === conversationA ? "מדיית A" : "מדיית B",
            },
          ],
          error: null,
        });
      }
      if (name === reserveRpc)
        return args._conversation_id === conversationA ? reserveA.promise : reserveB.promise;
      if (name === releaseRpc)
        return args._reservation_id === "reservation-A"
          ? releaseA.promise
          : Promise.resolve({ data: { released: true }, error: null });
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const onOpenChange = vi.fn();
    const props = { actor, open: true, onOpenChange, operatorSendGeneration: 0 };
    const { rerender } = render(<OperatorMediaPicker {...props} conversationId={conversationA} />);
    fireEvent.click(await screen.findByRole("button", { name: /מדיית A/ }));
    expect(rpcMock).toHaveBeenCalledWith(
      reserveRpc,
      expect.objectContaining({ _conversation_id: conversationA }),
    );
    rerender(
      <OperatorMediaPicker {...props} conversationId={conversationB} operatorSendGeneration={1} />,
    );
    const bButton = await screen.findByRole("button", { name: /מדיית B/ });
    expect(bButton).toBeEnabled();
    fireEvent.click(bButton);
    expect(rpcMock).toHaveBeenCalledWith(
      reserveRpc,
      expect.objectContaining({ _conversation_id: conversationB }),
    );
    expect(screen.getByRole("button", { name: /מדיית B/ })).toBeDisabled();
    const success = (id: string): ReserveResult => ({
      data: {
        reservation_id: id,
        expires_at: "2099-01-01T00:00:00.000Z",
        intended_access_mode: "standard",
      },
      error: null,
    });
    if (bFirst) await act(async () => reserveB.resolve(success("reservation-B")));
    await act(async () =>
      reserveA.resolve(
        outcome !== "failure"
          ? success("reservation-A")
          : { data: null, error: { message: "reserve_failed" } },
      ),
    );
    if (!bFirst) {
      expect(screen.getByRole("button", { name: /מדיית B/ })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: /מדיית B/ }));
      expect(rpcMock.mock.calls.filter(([name]) => name === reserveRpc)).toHaveLength(2);
    }
    if (outcome !== "failure") {
      expect(rpcMock).toHaveBeenCalledWith(releaseRpc, { _reservation_id: "reservation-A" });
    } else {
      expect(rpcMock.mock.calls.filter(([name]) => name === releaseRpc)).toHaveLength(0);
      expect(toast.error).not.toHaveBeenCalled();
    }
    if (!bFirst) await act(async () => reserveB.resolve(success("reservation-B")));
    expect(screen.getByRole("button", { name: "ביטול בחירת המדיה" })).toBeEnabled();
    expect(screen.getByText("מדיית B")).toBeInTheDocument();
    await act(async () =>
      releaseA.resolve(
        outcome === "cleanup failure"
          ? { data: null, error: { message: "cleanup_failed" } }
          : { data: { released: true }, error: null },
      ),
    );
    if (outcome === "cleanup failure") {
      expect(cleanupErrorLog).toHaveBeenCalledWith("Media reservation release failed", {
        message: "cleanup_failed",
      });
      expect(toast.error).not.toHaveBeenCalled();
    } else {
      expect(cleanupErrorLog).not.toHaveBeenCalled();
    }
    expect(rpcMock.mock.calls.filter(([name]) => name === releaseRpc)).toHaveLength(
      outcome === "failure" ? 0 : 1,
    );
    expect(screen.getByRole("button", { name: "ביטול בחירת המדיה" })).toBeEnabled();
    expect(rpcMock).not.toHaveBeenCalledWith(releaseRpc, { _reservation_id: "reservation-B" });
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("picker completion isolation", () => {
  it("does not close a new sticker picker or report an A result after switching to B", async () => {
    const oldSend = deferred<{ data: { cycle_id: string }; error: null }>();
    rpcMock.mockImplementation((name: string) => {
      if (name === "send_operator_sticker_message") return oldSend.promise;
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const onOpenChange = vi.fn();
    const onSent = vi.fn(
      (_result: unknown, _conversationId: string, _ticket?: OperatorSendTicket) => true,
    );
    const { rerender } = render(
      <StickerPicker
        conversationId={conversationA}
        open
        onOpenChange={onOpenChange}
        role="operator"
        expectedCycleId={null}
        operatorSendGeneration={0}
        onSent={onSent}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /שליחת סטיקר אוסף: בדיקה/ }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    rerender(
      <StickerPicker
        conversationId={conversationB}
        open
        onOpenChange={onOpenChange}
        role="operator"
        expectedCycleId={cycleB}
        operatorSendGeneration={1}
        onSent={onSent}
      />,
    );
    await act(async () => oldSend.resolve({ data: { cycle_id: cycleA }, error: null }));

    expect(onSent).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("passes a current sticker generation and expected cycle without changing client/admin APIs", async () => {
    rpcMock.mockResolvedValue({ data: { cycle_id: cycleA }, error: null });
    const onOpenChange = vi.fn();
    const onSent = vi.fn(
      (_result: unknown, _conversationId: string, _ticket?: OperatorSendTicket) => true,
    );
    render(
      <StickerPicker
        conversationId={conversationA}
        open
        onOpenChange={onOpenChange}
        role="operator"
        expectedCycleId={cycleB}
        operatorSendGeneration={7}
        onSent={onSent}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /שליחת סטיקר אוסף: בדיקה/ }));

    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(rpcMock).toHaveBeenCalledWith(
      "send_operator_sticker_message",
      expect.objectContaining({ _conversation_id: conversationA, _expected_cycle_id: cycleB }),
    );
    expect(onSent.mock.calls[0][2]).toMatchObject({
      conversationId: conversationA,
      generation: 7,
      expectedCycleId: cycleB,
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not publish a cycle or close the sticker picker after a failed send", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "send_denied" } });
    const onOpenChange = vi.fn();
    const onSent = vi.fn();
    render(
      <StickerPicker
        conversationId={conversationA}
        open
        onOpenChange={onOpenChange}
        role="operator"
        expectedCycleId={cycleB}
        operatorSendGeneration={7}
        onSent={onSent}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /שליחת סטיקר אוסף: בדיקה/ }));

    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    expect(onSent).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("keeps the current sticker picker open when ownership reconciliation rejects completion", async () => {
    rpcMock.mockResolvedValue({ data: { cycle_id: cycleA }, error: null });
    const onOpenChange = vi.fn();
    const onSent = vi.fn(() => false);
    render(
      <StickerPicker
        conversationId={conversationA}
        open
        onOpenChange={onOpenChange}
        role="operator"
        expectedCycleId={null}
        operatorSendGeneration={4}
        onSent={onSent}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /שליחת סטיקר אוסף: בדיקה/ }));

    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("keeps the client sticker RPC free of operator cycle authority", async () => {
    rpcMock.mockResolvedValue({ data: { message: { id: "client-message" } }, error: null });
    const onSent = vi.fn(
      (_result: unknown, _conversationId: string, _ticket?: OperatorSendTicket) => true,
    );
    render(
      <StickerPicker
        conversationId={conversationA}
        open
        onOpenChange={vi.fn()}
        role="client"
        onSent={onSent}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /שליחת סטיקר אוסף: בדיקה/ }));

    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(rpcMock).toHaveBeenCalledWith(
      "send_client_sticker_message",
      expect.not.objectContaining({ _expected_cycle_id: expect.anything() }),
    );
  });

  it("does not let an old media completion close B or clear B's reservation", async () => {
    const oldSend = deferred<{ data: { cycle_id: string }; error: null }>();
    rpcMock.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === "get_operator_media_catalog") {
        const isB = args._conversation_id === conversationB;
        return Promise.resolve({
          data: [
            {
              ...mediaAsset,
              id: isB ? "00000000-0000-4000-8000-000000000402" : mediaAsset.id,
              display_name: isB ? "מדיית B" : "מדיית A",
            },
          ],
          error: null,
        });
      }
      if (name === "reserve_character_media_for_delivery") {
        const isB = args._conversation_id === conversationB;
        return Promise.resolve({
          data: {
            reservation_id: isB
              ? "00000000-0000-4000-8000-000000000502"
              : "00000000-0000-4000-8000-000000000501",
            expires_at: "2099-01-01T00:00:00.000Z",
            intended_access_mode: "standard",
          },
          error: null,
        });
      }
      if (name === "send_operator_media_message") return oldSend.promise;
      if (name === "release_character_media_reservation") {
        return Promise.resolve({ data: { released: true }, error: null });
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const onOpenChange = vi.fn();
    const onSent = vi.fn();
    const { rerender } = render(
      <OperatorMediaPicker
        conversationId={conversationA}
        expectedCycleId={null}
        operatorSendGeneration={0}
        open
        onOpenChange={onOpenChange}
        onSent={onSent}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /מדיית A/ }));
    fireEvent.click(await screen.findByRole("button", { name: /שלח מדיה/ }));
    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith("send_operator_media_message", expect.any(Object)),
    );

    rerender(
      <OperatorMediaPicker
        conversationId={conversationB}
        expectedCycleId={cycleB}
        operatorSendGeneration={1}
        open
        onOpenChange={onOpenChange}
        onSent={onSent}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /מדיית B/ }));
    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith(
        "reserve_character_media_for_delivery",
        expect.objectContaining({ _conversation_id: conversationB }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "ביטול בחירת המדיה" })).toBeEnabled(),
    );

    await act(async () => oldSend.resolve({ data: { cycle_id: cycleA }, error: null }));

    expect(onSent).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByText("מדיית B")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ביטול בחירת המדיה" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /שלח מדיה/ })).toBeEnabled();
  });

  it("passes the current media generation, empty caption, and expected cycle", async () => {
    rpcMock.mockImplementation((name: string) => {
      if (name === "get_operator_media_catalog") {
        return Promise.resolve({ data: [mediaAsset], error: null });
      }
      if (name === "reserve_character_media_for_delivery") {
        return Promise.resolve({
          data: {
            reservation_id: "00000000-0000-4000-8000-000000000501",
            expires_at: "2099-01-01T00:00:00.000Z",
            intended_access_mode: "standard",
          },
          error: null,
        });
      }
      if (name === "send_operator_media_message") {
        return Promise.resolve({ data: { cycle_id: cycleB }, error: null });
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const onOpenChange = vi.fn();
    const onSent = vi.fn(
      (_result: unknown, _conversationId: string, _ticket?: OperatorSendTicket) => true,
    );
    render(
      <OperatorMediaPicker
        conversationId={conversationA}
        expectedCycleId={cycleB}
        operatorSendGeneration={9}
        open
        onOpenChange={onOpenChange}
        onSent={onSent}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /מדיית בדיקה/ }));
    fireEvent.click(await screen.findByRole("button", { name: /שלח מדיה/ }));

    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(rpcMock).toHaveBeenCalledWith(
      "send_operator_media_message",
      expect.objectContaining({ _caption: "", _expected_cycle_id: cycleB }),
    );
    expect(onSent.mock.calls[0][2]).toMatchObject({
      conversationId: conversationA,
      generation: 9,
      expectedCycleId: cycleB,
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the current media reservation and picker when ownership reconciliation rejects completion", async () => {
    rpcMock.mockImplementation((name: string) => {
      if (name === "get_operator_media_catalog") {
        return Promise.resolve({ data: [mediaAsset], error: null });
      }
      if (name === "reserve_character_media_for_delivery") {
        return Promise.resolve({
          data: {
            reservation_id: "00000000-0000-4000-8000-000000000504",
            expires_at: "2099-01-01T00:00:00.000Z",
            intended_access_mode: "standard",
          },
          error: null,
        });
      }
      if (name === "send_operator_media_message") {
        return Promise.resolve({ data: { cycle_id: cycleA }, error: null });
      }
      if (name === "release_character_media_reservation") {
        return Promise.resolve({ data: { released: true }, error: null });
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const onOpenChange = vi.fn();
    const onSent = vi.fn(() => false);
    render(
      <OperatorMediaPicker
        conversationId={conversationA}
        expectedCycleId={null}
        operatorSendGeneration={5}
        open
        onOpenChange={onOpenChange}
        onSent={onSent}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /מדיית בדיקה/ }));
    fireEvent.click(await screen.findByRole("button", { name: /שלח מדיה/ }));

    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("button", { name: "ביטול בחירת המדיה" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /שלח מדיה/ })).toBeEnabled();
  });

  it("preserves the admin media flow without adding operator cycle arguments", async () => {
    rpcMock.mockImplementation((name: string) => {
      if (name === "get_admin_media_catalog") {
        return Promise.resolve({ data: [mediaAsset], error: null });
      }
      if (name === "reserve_admin_character_media_asset") {
        return Promise.resolve({
          data: {
            reservation_id: "00000000-0000-4000-8000-000000000503",
            expires_at: "2099-01-01T00:00:00.000Z",
          },
          error: null,
        });
      }
      if (name === "send_admin_media_message") {
        return Promise.resolve({ data: { already_sent: false }, error: null });
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const onOpenChange = vi.fn();
    render(
      <OperatorMediaPicker
        actor="admin"
        conversationId={conversationA}
        open
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /מדיית בדיקה/ }));
    fireEvent.click(await screen.findByRole("button", { name: /שלח מדיה/ }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(rpcMock).toHaveBeenCalledWith(
      "send_admin_media_message",
      expect.not.objectContaining({ _expected_cycle_id: expect.anything() }),
    );
  });
});

describe("operator read-only picker guards", () => {
  it("does not send a sticker when the operator lost responsibility while the picker stayed open", async () => {
    rpcMock.mockResolvedValue({ data: { cycle_id: cycleA }, error: null });
    render(
      <StickerPicker
        conversationId={conversationA}
        open
        onOpenChange={vi.fn()}
        role="operator"
        readOnly
        onSent={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /שליחת סטיקר/ }));

    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("does not reserve media when the operator lost responsibility while the picker stayed open", async () => {
    rpcMock.mockImplementation((name: string) => {
      if (name === "get_operator_media_catalog") {
        return Promise.resolve({ data: [mediaAsset], error: null });
      }
      if (name === "reserve_character_media_for_delivery") {
        return Promise.resolve({ data: null, error: null });
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    render(
      <OperatorMediaPicker conversationId={conversationA} open readOnly onOpenChange={vi.fn()} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /מדיית בדיקה/ }));

    expect(rpcMock).not.toHaveBeenCalledWith(
      "reserve_character_media_for_delivery",
      expect.any(Object),
    );
  });

  it("rejects a pending sticker completion after the open picker becomes read-only", async () => {
    const pendingSend = deferred<{ data: { cycle_id: string }; error: null }>();
    rpcMock.mockReturnValue(pendingSend.promise);
    const onOpenChange = vi.fn();
    const onSent = vi.fn(() => true);
    const { rerender } = render(
      <StickerPicker
        conversationId={conversationA}
        open
        onOpenChange={onOpenChange}
        role="operator"
        readOnly={false}
        onSent={onSent}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /שליחת סטיקר/ }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));

    rerender(
      <StickerPicker
        conversationId={conversationA}
        open
        onOpenChange={onOpenChange}
        role="operator"
        readOnly
        onSent={onSent}
      />,
    );
    await act(async () => pendingSend.resolve({ data: { cycle_id: cycleA }, error: null }));

    expect(onSent).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("cleans only a late reservation after the open media picker becomes read-only", async () => {
    const pendingReserve = deferred<{
      data: { reservation_id: string; expires_at: string; intended_access_mode: string };
      error: null;
    }>();
    rpcMock.mockImplementation((name: string) => {
      if (name === "get_operator_media_catalog") {
        return Promise.resolve({ data: [mediaAsset], error: null });
      }
      if (name === "reserve_character_media_for_delivery") return pendingReserve.promise;
      if (name === "release_character_media_reservation") {
        return Promise.resolve({ data: { released: true }, error: null });
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const { rerender } = render(
      <OperatorMediaPicker
        conversationId={conversationA}
        open
        readOnly={false}
        onOpenChange={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /מדיית בדיקה/ }));
    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith(
        "reserve_character_media_for_delivery",
        expect.any(Object),
      ),
    );

    rerender(
      <OperatorMediaPicker conversationId={conversationA} open readOnly onOpenChange={vi.fn()} />,
    );
    await act(async () =>
      pendingReserve.resolve({
        data: {
          reservation_id: "00000000-0000-4000-8000-000000000599",
          expires_at: "2099-01-01T00:00:00.000Z",
          intended_access_mode: "standard",
        },
        error: null,
      }),
    );

    expect(rpcMock).toHaveBeenCalledWith("release_character_media_reservation", {
      _reservation_id: "00000000-0000-4000-8000-000000000599",
    });
    expect(screen.queryByRole("button", { name: /שלח מדיה/ })).not.toBeInTheDocument();
  });
});

describe("HTTP fixture event ownership", () => {
  it("matches owned identifiers retained inside metadata after SET NULL", () => {
    expect(
      fixtureEventRowBelongsToOwnership(
        { metadata: { dedupe_key: `new_available:${conversationA}:operator` } },
        [conversationA],
      ),
    ).toBe(true);
  });

  it("preserves a non-owned sentinel", () => {
    expect(
      fixtureEventRowBelongsToOwnership(
        { id: "00000000-0000-4000-8000-000000009999", metadata: { sentinel: true } },
        [conversationA, conversationB],
      ),
    ).toBe(false);
  });
});
