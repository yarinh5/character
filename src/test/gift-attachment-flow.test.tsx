import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageAttachment } from "@/components/chat/MessageAttachment";
import { OperatorMediaPicker } from "@/components/operator/OperatorMediaPicker";
import type { MessageAttachmentAccess } from "@/hooks/useMessageAttachmentAccessMap";

const rpc = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/useMessageAttachmentUrl", () => ({
  useMessageAttachmentUrl: () => ({
    status: "idle",
    url: null,
    refresh: vi.fn(),
    retryAfterImageError: vi.fn(),
  }),
}));
vi.mock("@/hooks/useMediaViewUrl", () => ({
  useMediaViewUrl: () => ({
    status: "ready",
    url: "blob:preview",
    retryAfterImageError: vi.fn(),
  }),
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

const attachment = {
  id: "00000000-0000-4000-8000-000000000701",
  message_id: "00000000-0000-4000-8000-000000000702",
  kind: "image",
  position: 0,
  caption: null,
  metadata: {},
  created_at: "2026-11-05T00:00:00.000Z",
};

const giftRequired: MessageAttachmentAccess = {
  access_mode: "standard",
  render_state: "gift_purchase_required",
  price_credits_snapshot: 100,
  is_unlocked: null,
  session_expires_at: null,
  view_mode: "paid_open",
  required_gift_id: "00000000-0000-4000-8000-000000000703",
  required_gift_name: "לב",
  required_gift_price_credits: 100,
  available_purchase_id: null,
};

const giftPurchased: MessageAttachmentAccess = {
  ...giftRequired,
  render_state: "gift_purchased",
  available_purchase_id: "00000000-0000-4000-8000-000000000704",
};

function pickerAsset() {
  return {
    byte_size: 1024,
    character_ids: ["character-a"],
    content_type: "image/webp",
    display_name: "Gift image",
    height: 512,
    id: "00000000-0000-4000-8000-000000000705",
    ingest_status: "ready",
    is_global: false,
    is_locked_reservable: false,
    is_reservable: true,
    is_reserved_by_me: false,
    locked_derivative_status: "ready",
    locked_images_enabled: false,
    locked_price_credits: null,
    media_tag_id: "tag-a",
    media_tag_name: "General",
    media_tags: [{ id: "tag-a", name: "General", character_id: "character-a" }],
    my_reservation_access_mode: null,
    my_reservation_expires_at: null,
    my_reservation_id: null,
    paid_open_price_credits: null,
    status: "available",
    width: 512,
  };
}

beforeEach(() => {
  rpc.mockReset();
  toastError.mockReset();
});

describe("WP07 Gift attachment flow", () => {
  it("keeps Gift purchase and the 60-second opening as separate idempotent operations", async () => {
    const refreshAccess = vi.fn().mockResolvedValue(giftPurchased);
    const onBalanceChange = vi.fn();
    rpc.mockResolvedValueOnce({
      data: { purchase_id: giftPurchased.available_purchase_id, balance: 50 },
      error: null,
    });

    const view = render(
      <MessageAttachment
        attachment={attachment}
        access={giftRequired}
        accessStatus="ready"
        refreshAccess={refreshAccess}
        onBalanceChange={onBalanceChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "רכוש מתנה" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "רכוש מתנה" })).at(-1)!);
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("purchase_attachment_gift", {
        _attachment_id: attachment.id,
        _gift_id: giftRequired.required_gift_id,
        _idempotency_key: expect.any(String),
      }),
    );
    expect(rpc).not.toHaveBeenCalledWith("open_attachment_gift_purchase", expect.anything());
    await waitFor(() => expect(onBalanceChange).toHaveBeenCalledExactlyOnceWith(50));

    view.rerender(
      <MessageAttachment
        attachment={attachment}
        access={giftPurchased}
        accessStatus="ready"
        refreshAccess={refreshAccess}
        onBalanceChange={onBalanceChange}
      />,
    );
    rpc.mockResolvedValueOnce({
      data: { session_id: "session-a", expires_at: "2026-11-05T00:01:00.000Z" },
      error: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "פתח ל-60 שניות" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "פתח תמונה" })).at(-1)!);
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("open_attachment_gift_purchase", {
        _attachment_id: attachment.id,
        _purchase_id: giftPurchased.available_purchase_id,
        _idempotency_key: expect.any(String),
      }),
    );

    const calls = rpc.mock.calls.filter(
      ([name]) => name === "purchase_attachment_gift" || name === "open_attachment_gift_purchase",
    );
    expect(calls).toHaveLength(2);
    expect(calls[0][1]._idempotency_key).not.toBe(calls[1][1]._idempotency_key);
    expect(onBalanceChange).toHaveBeenCalledTimes(1);
  });

  it.each(["Escape", "Cancel"])(
    "restores the actual trigger on %s without purchasing",
    async (action) => {
      const user = userEvent.setup();
      render(
        <MessageAttachment
          attachment={attachment}
          access={giftRequired}
          accessStatus="ready"
          refreshAccess={vi.fn()}
        />,
      );
      const trigger = screen.getByRole("button", { name: "רכוש מתנה" });
      trigger.focus();
      await user.keyboard("{Enter}");
      const cancel = await screen.findByRole("button", { name: "ביטול" });
      expect(cancel).toHaveFocus();
      await user.keyboard(action === "Escape" ? "{Escape}" : "{Enter}");
      await waitFor(() => expect(trigger).toHaveFocus());
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("releases a rejected Gift purchase for an explicit retry with the same idempotency key", async () => {
    const refreshAccess = vi.fn().mockResolvedValue(giftPurchased);
    rpc.mockRejectedValueOnce(new Error("transport unavailable")).mockResolvedValueOnce({
      data: { purchase_id: giftPurchased.available_purchase_id, balance: 50 },
      error: null,
    });

    render(
      <MessageAttachment
        attachment={attachment}
        access={giftRequired}
        accessStatus="ready"
        refreshAccess={refreshAccess}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "רכוש מתנה" }));
    const confirm = (await screen.findAllByRole("button", { name: "רכוש מתנה" })).at(-1)!;
    fireEvent.click(confirm);

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("רכישת המתנה לא הושלמה."));
    const retry = screen.getByRole("button", { name: "רכוש מתנה" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    fireEvent.click((await screen.findAllByRole("button", { name: "רכוש מתנה" })).at(-1)!);

    await waitFor(() => expect(refreshAccess).toHaveBeenCalled());
    const purchaseCalls = rpc.mock.calls.filter(([name]) => name === "purchase_attachment_gift");
    expect(purchaseCalls).toHaveLength(2);
    expect(purchaseCalls[0][1]._idempotency_key).toBe(purchaseCalls[1][1]._idempotency_key);
  });

  it("binds the selected Gift to the reserved attachment send", async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === "get_operator_media_catalog") return { data: [pickerAsset()], error: null };
      if (name === "reserve_character_media_for_delivery") {
        return {
          data: {
            reservation_id: "00000000-0000-4000-8000-000000000706",
            expires_at: "2099-01-01T00:00:00.000Z",
            intended_access_mode: "standard",
          },
          error: null,
        };
      }
      if (name === "get_conversation_gifts") {
        return {
          data: [{ gift_id: giftRequired.required_gift_id, name: "לב", price_credits: 100 }],
          error: null,
        };
      }
      if (name === "send_operator_gift_media_message") {
        return {
          data: { message: { id: attachment.message_id }, already_sent: false },
          error: null,
        };
      }
      if (name === "release_character_media_reservation") {
        return { data: { released: true }, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    render(
      <OperatorMediaPicker
        conversationId="00000000-0000-4000-8000-000000000707"
        expectedCycleId="00000000-0000-4000-8000-000000000708"
        open
        onOpenChange={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Gift image/ }));
    fireEvent.click(await screen.findByRole("button", { name: "במתנה" }));
    fireEvent.change(await screen.findByLabelText("מתנה נדרשת לפתיחה"), {
      target: { value: giftRequired.required_gift_id },
    });
    fireEvent.click(screen.getByRole("button", { name: "שלח מדיה" }));

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("send_operator_gift_media_message", {
        _caption: "",
        _expected_cycle_id: "00000000-0000-4000-8000-000000000708",
        _gift_id: giftRequired.required_gift_id,
        _reservation_id: "00000000-0000-4000-8000-000000000706",
      }),
    );
  });
});
