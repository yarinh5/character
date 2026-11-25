import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const state = vi.hoisted(() => ({
  accessCallback: null as null | (() => void),
  subscriptionCallback: null as null | ((status: string) => void),
  rpc: vi.fn(),
  invoke: vi.fn(),
}));

const channel = {
  on: vi.fn((_kind: string, _filter: unknown, callback: () => void) => {
    state.accessCallback = callback;
    return channel;
  }),
  subscribe: vi.fn((callback?: (status: string) => void) => {
    state.subscriptionCallback = callback ?? null;
    return channel;
  }),
};

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "00000000-0000-4000-8000-000000000001" } }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
    rpc: state.rpc,
    functions: { invoke: state.invoke },
  },
}));

import { useConversationReadAccess } from "@/hooks/useConversationReadAccess";
import { useMediaViewUrl } from "@/hooks/useMediaViewUrl";

beforeEach(() => {
  state.accessCallback = null;
  state.subscriptionCallback = null;
  state.rpc.mockReset();
  state.invoke.mockReset();
  channel.on.mockClear();
  channel.subscribe.mockClear();
});

describe("conversation read access invalidation", () => {
  it("hides allowed content while a transaction-bound invalidation is revalidated", async () => {
    state.rpc
      .mockResolvedValueOnce({ data: [{ allowed: true, access_version: 1 }], error: null })
      .mockResolvedValueOnce({ data: [{ allowed: false, access_version: 2 }], error: null });
    const { result } = renderHook(() => useConversationReadAccess("conversation-a"));
    await waitFor(() => expect(result.current.state).toBe("allowed"));

    act(() => state.accessCallback?.());
    expect(result.current.state).toBe("checking");
    await waitFor(() => expect(result.current.state).toBe("denied"));
    expect(result.current.generation).toBeGreaterThan(1);
  });

  it("does not accept a late response from the previous conversation", async () => {
    const oldRequest = deferred<{ data: { allowed: boolean }[]; error: null }>();
    state.rpc
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce({ data: [{ allowed: true }], error: null });
    const { result, rerender } = renderHook(
      ({ conversationId }) => useConversationReadAccess(conversationId),
      { initialProps: { conversationId: "conversation-a" } },
    );
    rerender({ conversationId: "conversation-b" });
    await waitFor(() => expect(result.current.state).toBe("allowed"));
    await act(async () => oldRequest.resolve({ data: [{ allowed: false }], error: null }));
    expect(result.current.state).toBe("allowed");
  });

  it("fails closed when revalidation errors", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: "network" } });
    const { result } = renderHook(() => useConversationReadAccess("conversation-a"));
    await waitFor(() => expect(result.current.state).toBe("error"));
  });

  it("subscribes to inserts and updates, then reconciles the initial fetch gap", async () => {
    state.rpc
      .mockResolvedValueOnce({ data: [{ allowed: true, access_version: 1 }], error: null })
      .mockResolvedValueOnce({ data: [{ allowed: false, access_version: 2 }], error: null });
    const { result } = renderHook(() => useConversationReadAccess("conversation-a"));
    await waitFor(() => expect(result.current.state).toBe("allowed"));

    expect(channel.on).toHaveBeenCalledWith(
      "postgres_changes",
      expect.objectContaining({ event: "*", table: "user_conversation_access_versions" }),
      expect.any(Function),
    );
    act(() => state.subscriptionCallback?.("SUBSCRIBED"));
    await waitFor(() => expect(result.current.state).toBe("denied"));
  });

  it.each(["CHANNEL_ERROR", "CLOSED", "TIMED_OUT"])(
    "fails closed when the access channel reports %s",
    async (status) => {
      state.rpc.mockResolvedValue({
        data: [{ allowed: true, access_version: 1 }],
        error: null,
      });
      const { result } = renderHook(() => useConversationReadAccess("conversation-a"));
      await waitFor(() => expect(result.current.state).toBe("allowed"));

      act(() => state.subscriptionCallback?.(status));
      expect(result.current.state).toBe("error");
    },
  );

  it("invalidates cached content when reconnect discovers a missed access version", async () => {
    state.rpc
      .mockResolvedValueOnce({ data: [{ allowed: true, access_version: 10 }], error: null })
      .mockResolvedValueOnce({ data: [{ allowed: true, access_version: 12 }], error: null });
    const { result } = renderHook(() => useConversationReadAccess("conversation-a"));
    await waitFor(() => expect(result.current.state).toBe("allowed"));
    const initialGeneration = result.current.generation;

    act(() => state.subscriptionCallback?.("SUBSCRIBED"));
    await waitFor(() => expect(result.current.generation).toBeGreaterThan(initialGeneration));
    expect(result.current.state).toBe("allowed");
  });
});

describe("media URL access generation", () => {
  it("discards a late signed URL after access is revoked", async () => {
    const oldRequest = deferred<{ data: { url: string; expires_at: string }; error: null }>();
    state.invoke.mockReturnValueOnce(oldRequest.promise);
    const { result, rerender } = renderHook(
      ({ enabled, generation }) =>
        useMediaViewUrl("message_attachment", "attachment-a", undefined, enabled, generation),
      { initialProps: { enabled: true, generation: 1 } },
    );
    rerender({ enabled: false, generation: 2 });
    expect(result.current.url).toBeNull();
    await act(async () =>
      oldRequest.resolve({
        data: { url: "https://secret.test/signed", expires_at: "2030-01-01T00:00:00Z" },
        error: null,
      }),
    );
    expect(result.current.url).toBeNull();
    expect(result.current.status).toBe("idle");
  });
});
