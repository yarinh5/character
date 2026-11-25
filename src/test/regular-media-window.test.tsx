import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageAttachment } from "@/components/chat/MessageAttachment";
import type { MessageAttachmentAccess } from "@/hooks/useMessageAttachmentAccessMap";

const rpc = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));
vi.mock("@/hooks/useMessageAttachmentUrl", () => ({
  useMessageAttachmentUrl: () => ({
    status: "ready",
    url: "blob:regular-media",
    refresh: vi.fn(),
    retryAfterImageError: vi.fn(),
  }),
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

const attachment = {
  id: "00000000-0000-4000-8000-000000000801",
  message_id: "00000000-0000-4000-8000-000000000802",
  kind: "image",
  position: 0,
  caption: null,
  metadata: {},
  created_at: "2026-11-05T00:00:00.000Z",
};

const activeRegularWindow: MessageAttachmentAccess = {
  access_mode: "standard",
  render_state: "view_once_active",
  price_credits_snapshot: null,
  is_unlocked: null,
  session_expires_at: "2026-11-05T00:01:00.000Z",
  view_mode: "view_once",
  required_gift_id: null,
  required_gift_name: null,
  required_gift_price_credits: null,
  available_purchase_id: null,
};

const availableRegularWindow: MessageAttachmentAccess = {
  ...activeRegularWindow,
  render_state: "view_once_available",
  session_expires_at: null,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-05T00:00:00.000Z"));
  rpc.mockReset().mockResolvedValue({ data: null, error: null });
  toastError.mockReset();
});

afterEach(() => vi.useRealTimers());

describe("regular media 60-second policy UI", () => {
  it("keeps a server-authorized active window visible past the legacy seven seconds", async () => {
    const refreshAccess = vi.fn().mockResolvedValue(null);
    render(
      <MessageAttachment
        attachment={attachment}
        access={activeRegularWindow}
        accessStatus="ready"
        refreshAccess={refreshAccess}
      />,
    );

    expect(screen.getByRole("img", { name: "תמונה שנשלחה בצ'אט" })).toBeInTheDocument();
    expect(screen.getByText("התמונה זמינה למשך חלון הצפייה")).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(7_000));
    expect(rpc).not.toHaveBeenCalledWith("complete_free_view_once_attachment", expect.anything());

    await act(async () => vi.advanceTimersByTime(53_000));
    expect(rpc).toHaveBeenCalledWith("complete_free_view_once_attachment", {
      _attachment_id: attachment.id,
    });
    expect(refreshAccess).toHaveBeenCalledTimes(1);
  });

  it("releases a rejected view-once open for retry with the same idempotency key", async () => {
    const refreshAccess = vi.fn().mockResolvedValue(activeRegularWindow);
    rpc
      .mockRejectedValueOnce(new Error("transport unavailable"))
      .mockResolvedValueOnce({ data: null, error: null });
    render(
      <MessageAttachment
        attachment={attachment}
        access={availableRegularWindow}
        accessStatus="ready"
        refreshAccess={refreshAccess}
      />,
    );

    const open = screen.getByRole("button", { name: "פתח תמונה" });
    await act(async () => {
      fireEvent.click(open);
      await Promise.resolve();
    });
    expect(toastError).toHaveBeenCalledWith("לא ניתן לפתוח את התמונה כרגע.");
    expect(open).toBeEnabled();

    await act(async () => {
      fireEvent.click(open);
      await Promise.resolve();
    });
    expect(refreshAccess).toHaveBeenCalled();
    const openCalls = rpc.mock.calls.filter(([name]) => name === "open_free_view_once_attachment");
    expect(openCalls).toHaveLength(2);
    expect(openCalls[0][1]._idempotency_key).toBe(openCalls[1][1]._idempotency_key);
  });
});
