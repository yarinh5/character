import { act, render, screen } from "@testing-library/react";
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
