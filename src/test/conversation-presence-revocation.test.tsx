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
  rpc: vi.fn(),
  realtimeCallback: null as null | (() => void),
  subscriptionCallback: null as null | ((status: string) => void),
}));

const channel = {
  on: vi.fn((_kind: string, _filter: unknown, callback: () => void) => {
    state.realtimeCallback = callback;
    return channel;
  }),
  subscribe: vi.fn((callback?: (status: string) => void) => {
    state.subscriptionCallback = callback ?? null;
    return channel;
  }),
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
    rpc: state.rpc,
  },
}));

import { useConversationPresence } from "@/lib/conversationPresence";

beforeEach(() => {
  state.rpc.mockReset();
  state.realtimeCallback = null;
  state.subscriptionCallback = null;
  channel.on.mockClear();
  channel.subscribe.mockClear();
});

describe("conversation presence request scope", () => {
  it("accepts a valid delayed refresh after ordinary rerenders", async () => {
    const refresh = deferred<{
      data: Array<{
        user_id: string;
        role: "operator";
        display_name: string;
        online_at: string;
        is_typing: boolean;
      }>;
      error: null;
    }>();
    state.rpc.mockImplementation((name: string) => {
      if (name === "set_conversation_presence") return Promise.resolve({ data: null, error: null });
      return refresh.promise;
    });

    const { result, rerender } = renderHook(
      ({ displayName }) =>
        useConversationPresence({
          conversationId: "conversation-a",
          userId: "user-a",
          role: "operator",
          displayName,
          accessGeneration: 7,
        }),
      { initialProps: { displayName: "Operator" } },
    );
    await waitFor(() =>
      expect(state.rpc).toHaveBeenCalledWith("get_conversation_presence", expect.any(Object)),
    );
    rerender({ displayName: "Operator typing" });
    await act(async () =>
      refresh.resolve({
        data: [
          {
            user_id: "user-b",
            role: "operator",
            display_name: "Peer",
            online_at: "2026-10-19T00:00:00Z",
            is_typing: true,
          },
        ],
        error: null,
      }),
    );

    expect(result.current.activeUsers).toEqual([
      expect.objectContaining({ userId: "user-b", displayName: "Peer" }),
    ]);
    expect(result.current.typingUsers).toHaveLength(1);
  });

  it("clears presence on channel failure and reconciles after subscribe", async () => {
    state.rpc.mockImplementation((name: string) => {
      if (name === "set_conversation_presence") return Promise.resolve({ data: null, error: null });
      return Promise.resolve({
        data: [
          {
            user_id: "user-b",
            role: "operator",
            display_name: "Peer",
            online_at: "2026-10-19T00:00:00Z",
            is_typing: false,
          },
        ],
        error: null,
      });
    });
    const { result } = renderHook(() =>
      useConversationPresence({
        conversationId: "conversation-a",
        userId: "user-a",
        role: "operator",
        displayName: "Operator",
        accessGeneration: 7,
      }),
    );
    await waitFor(() => expect(result.current.activeUsers).toHaveLength(1));

    act(() => state.subscriptionCallback?.("CHANNEL_ERROR"));
    expect(result.current.activeUsers).toEqual([]);
    act(() => state.subscriptionCallback?.("SUBSCRIBED"));
    await waitFor(() => expect(result.current.activeUsers).toHaveLength(1));
  });
});
