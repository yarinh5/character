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
    expect(screen.queryByRole("img", { name: "תמונה שנשלחה בצ'אט" })).not.toBeInTheDocument();
  });

  it("executes the lazy completion request at the server deadline", async () => {
    const execute = vi.fn();
    rpc.mockImplementationOnce(() => ({
      then: (resolve: (value: { data: { completed: boolean }; error: null }) => unknown) => {
        execute();
        return Promise.resolve({ data: { completed: true }, error: null }).then(resolve);
      },
    }));
    render(
      <MessageAttachment
        attachment={attachment}
        access={activeRegularWindow}
        accessStatus="ready"
        refreshAccess={vi.fn().mockResolvedValue(null)}
      />,
    );

    await act(async () => vi.advanceTimersByTime(60_000));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("completes an active window when the parent replaces the refresh callback", async () => {
    const refreshAccess = vi.fn().mockResolvedValue(null);
    const view = render(
      <MessageAttachment
        attachment={attachment}
        access={activeRegularWindow}
        accessStatus="ready"
        refreshAccess={() => refreshAccess()}
      />,
    );

    for (let second = 0; second < 60; second += 1) {
      await act(async () => vi.advanceTimersByTime(1_000));
      if (second < 59) {
        view.rerender(
          <MessageAttachment
            attachment={attachment}
            access={activeRegularWindow}
            accessStatus="ready"
            refreshAccess={() => refreshAccess()}
          />,
        );
      }
    }

    expect(rpc).toHaveBeenCalledWith("complete_free_view_once_attachment", {
      _attachment_id: attachment.id,
    });
    expect(refreshAccess).toHaveBeenCalledTimes(1);
  });

  it("completes when access changes to seen at the server deadline", async () => {
    const refreshAccess = vi.fn().mockResolvedValue(null);
    const view = render(
      <MessageAttachment
        attachment={attachment}
        access={activeRegularWindow}
        accessStatus="ready"
        refreshAccess={() => refreshAccess()}
      />,
    );

    await act(async () => vi.advanceTimersByTime(59_999));
    view.rerender(
      <MessageAttachment
        attachment={attachment}
        access={{ ...activeRegularWindow, render_state: "view_once_seen" }}
        accessStatus="ready"
        refreshAccess={() => refreshAccess()}
      />,
    );
    await act(async () => vi.advanceTimersByTime(1));

    expect(rpc).toHaveBeenCalledWith("complete_free_view_once_attachment", {
      _attachment_id: attachment.id,
    });
    expect(refreshAccess).toHaveBeenCalledTimes(1);
  });

  it.each([null, "not-a-date", "2026-11-04T23:59:59.000Z"])(
    "does not display an active view-once image with expiry %s",
    (session_expires_at) => {
      render(
        <MessageAttachment
          attachment={attachment}
          access={{ ...activeRegularWindow, session_expires_at }}
          accessStatus="ready"
          refreshAccess={vi.fn().mockResolvedValue(null)}
        />,
      );

      expect(screen.queryByRole("img", { name: "תמונה שנשלחה בצ'אט" })).not.toBeInTheDocument();
    },
  );

  it("hides a legacy seven-second window when its server expiry passes", async () => {
    render(
      <MessageAttachment
        attachment={attachment}
        access={{ ...activeRegularWindow, session_expires_at: "2026-11-05T00:00:07.000Z" }}
        accessStatus="ready"
        refreshAccess={vi.fn().mockResolvedValue(null)}
      />,
    );

    expect(screen.getByRole("img", { name: "תמונה שנשלחה בצ'אט" })).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(7_000));
    expect(screen.queryByRole("img", { name: "תמונה שנשלחה בצ'אט" })).not.toBeInTheDocument();
  });

  it("does not reveal an opened image before access refresh supplies its server expiry", async () => {
    const refreshAccess = vi.fn().mockResolvedValue(null);
    render(
      <MessageAttachment
        attachment={attachment}
        access={availableRegularWindow}
        accessStatus="ready"
        refreshAccess={refreshAccess}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "פתח תמונה" }));
      await Promise.resolve();
    });
    expect(refreshAccess).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("img", { name: "תמונה שנשלחה בצ'אט" })).not.toBeInTheDocument();
  });

  it("keeps staff view-once access visible without a client expiry", () => {
    render(
      <MessageAttachment
        attachment={attachment}
        access={{
          ...activeRegularWindow,
          render_state: "view_once_staff",
          session_expires_at: null,
        }}
        accessStatus="ready"
        refreshAccess={vi.fn().mockResolvedValue(null)}
      />,
    );

    expect(screen.getByRole("img", { name: "תמונה שנשלחה בצ'אט" })).toBeInTheDocument();
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
