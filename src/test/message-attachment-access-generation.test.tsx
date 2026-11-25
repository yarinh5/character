import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type RpcResult = { data: Array<Record<string, unknown>> | null; error: null | { message: string } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const state = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: state.rpc },
}));

import { useMessageAttachmentAccessMap } from "@/hooks/useMessageAttachmentAccessMap";

const giftAccess = {
  attachment_id: "attachment-a",
  access_mode: "standard",
  render_state: "gift_purchase_required",
  price_credits_snapshot: null,
  is_unlocked: null,
  session_expires_at: null,
  view_mode: "paid_open",
  required_gift_id: "gift-a",
  required_gift_name: "Gift A",
  required_gift_price_credits: 25,
  available_purchase_id: null,
};

describe("message attachment access generation", () => {
  beforeEach(() => state.rpc.mockReset());

  it("keeps Product Completion fields while discarding a late response after revocation", async () => {
    const first = deferred<RpcResult>();
    state.rpc
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ data: [giftAccess], error: null });

    const { result, rerender } = renderHook(
      ({ enabled, generation }) =>
        useMessageAttachmentAccessMap(["attachment-a"], enabled, generation),
      { initialProps: { enabled: true, generation: 1 } },
    );
    await waitFor(() => expect(state.rpc).toHaveBeenCalledTimes(1));

    rerender({ enabled: false, generation: 2 });
    await waitFor(() => expect(result.current.accessByAttachmentId).toEqual({}));
    await act(async () => first.resolve({ data: [giftAccess], error: null }));
    expect(result.current.accessByAttachmentId).toEqual({});

    rerender({ enabled: true, generation: 3 });
    await waitFor(() =>
      expect(result.current.accessByAttachmentId["attachment-a"]).toMatchObject({
        required_gift_id: "gift-a",
        required_gift_name: "Gift A",
        required_gift_price_credits: 25,
      }),
    );
  });

  it("fails closed when a refresh errors", async () => {
    state.rpc
      .mockResolvedValueOnce({ data: [giftAccess], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "read denied" } });

    const { result } = renderHook(() => useMessageAttachmentAccessMap(["attachment-a"], true, 1));
    await waitFor(() => expect(result.current.accessByAttachmentId["attachment-a"]).toBeDefined());

    await act(async () => {
      await result.current.refreshAttachment("attachment-a");
    });
    expect(result.current.accessByAttachmentId).toEqual({});
  });
});
