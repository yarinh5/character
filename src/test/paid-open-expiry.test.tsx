import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageAttachment } from "@/components/chat/MessageAttachment";
import type { MessageAttachmentAccess } from "@/hooks/useMessageAttachmentAccessMap";

const rpc = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));
vi.mock("@/hooks/useMessageAttachmentUrl", () => ({
  useMessageAttachmentUrl: () => ({
    status: "ready",
    url: "blob:paid-preview",
    refresh: vi.fn(),
    retryAfterImageError: vi.fn(),
  }),
}));

const attachment = {
  id: "00000000-0000-4000-8000-000000000731",
  message_id: "00000000-0000-4000-8000-000000000732",
  kind: "image",
  position: 0,
  caption: null,
  metadata: {},
  created_at: "2026-11-27T10:00:00.000Z",
};

const activeAccess: MessageAttachmentAccess = {
  access_mode: "standard",
  render_state: "paid_open_active",
  price_credits_snapshot: 7,
  is_unlocked: null,
  session_expires_at: "2026-11-27T10:00:01.000Z",
  view_mode: "paid_open",
  required_gift_id: null,
  required_gift_name: null,
  required_gift_price_credits: null,
  available_purchase_id: null,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-27T10:00:00.000Z"));
  rpc.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("paid image local expiry", () => {
  it("executes the lazy session completion request after a paid open", async () => {
    const execute = vi.fn();
    const refreshAccess = vi.fn().mockResolvedValue(activeAccess);
    rpc.mockResolvedValueOnce({ data: { session_id: "paid-session-1" }, error: null });
    const view = render(
      <MessageAttachment
        attachment={attachment}
        access={{ ...activeAccess, render_state: "paid_open_available" }}
        accessStatus="ready"
        refreshAccess={refreshAccess}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "פתח תמונה" }));
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", { name: "פתח תמונה" }),
      );
      await Promise.resolve();
    });
    rpc.mockImplementationOnce(() => ({
      then: (resolve: (value: { data: null; error: null }) => unknown) => {
        execute();
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    }));
    view.rerender(
      <MessageAttachment
        attachment={attachment}
        access={activeAccess}
        accessStatus="ready"
        refreshAccess={refreshAccess}
      />,
    );

    await act(async () => vi.advanceTimersByTime(1_000));
    expect(rpc).toHaveBeenCalledWith("complete_paid_message_attachment_session", {
      _session_id: "paid-session-1",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("hides loaded bytes at expiry even when access refresh leaves the old state", () => {
    const refreshAccess = vi.fn().mockResolvedValue(null);
    const view = render(
      <MessageAttachment
        attachment={attachment}
        access={activeAccess}
        accessStatus="ready"
        refreshAccess={refreshAccess}
      />,
    );
    expect(screen.getByRole("img", { name: "תמונה שנשלחה בצ'אט" })).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1_000));
    expect(refreshAccess).toHaveBeenCalledOnce();
    expect(screen.queryByRole("img", { name: "תמונה שנשלחה בצ'אט" })).not.toBeInTheDocument();

    view.rerender(
      <MessageAttachment
        attachment={attachment}
        access={{ ...activeAccess, session_expires_at: "2026-11-27T10:00:03.000Z" }}
        accessStatus="ready"
        refreshAccess={refreshAccess}
      />,
    );
    expect(screen.getByRole("img", { name: "תמונה שנשלחה בצ'אט" })).toBeInTheDocument();
  });

  it.each([null, "not-a-date", "2026-11-27T09:59:59.000Z"])(
    "does not render a paid image with expiry %s",
    (session_expires_at) => {
      render(
        <MessageAttachment
          attachment={attachment}
          access={{ ...activeAccess, session_expires_at }}
          accessStatus="ready"
          refreshAccess={vi.fn().mockResolvedValue(null)}
        />,
      );
      expect(screen.queryByRole("img", { name: "תמונה שנשלחה בצ'אט" })).not.toBeInTheDocument();
    },
  );

  it("keeps authorized staff viewing independent of the client session deadline", () => {
    render(
      <MessageAttachment
        attachment={attachment}
        access={{ ...activeAccess, render_state: "paid_open_staff", session_expires_at: null }}
        accessStatus="ready"
        refreshAccess={vi.fn().mockResolvedValue(null)}
      />,
    );
    expect(screen.getByRole("img", { name: "תמונה שנשלחה בצ'אט" })).toBeInTheDocument();
  });
});
