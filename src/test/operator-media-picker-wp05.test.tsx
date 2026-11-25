import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OperatorMediaPicker } from "@/components/operator/OperatorMediaPicker";
import { toast } from "sonner";

const rpc = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/useMediaViewUrl", () => ({
  useMediaViewUrl: () => ({
    status: "idle",
    url: null,
    retryAfterImageError: vi.fn(),
  }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const conversationA = "00000000-0000-4000-8000-000000000101";
const conversationB = "00000000-0000-4000-8000-000000000102";

function asset(
  id: string,
  name: string,
  mediaTags: Array<{ id: string; name: string; character_id: string }>,
) {
  return {
    byte_size: 1024,
    character_ids: ["character-a"],
    content_type: "image/webp",
    display_name: name,
    height: 512,
    id,
    ingest_status: "ready",
    is_global: false,
    is_locked_reservable: false,
    is_reservable: true,
    is_reserved_by_me: false,
    locked_derivative_status: "ready",
    locked_images_enabled: false,
    locked_price_credits: null,
    media_tag_id: mediaTags[0]?.id ?? "legacy-tag",
    media_tag_name: mediaTags[0]?.name ?? "Legacy",
    media_tags: mediaTags,
    my_reservation_access_mode: null,
    my_reservation_expires_at: null,
    my_reservation_id: null,
    paid_open_price_credits: null,
    status: "available",
    width: 512,
  };
}

const portrait = asset("asset-portrait", "Portrait", [
  { id: "tag-shared", name: "Shared", character_id: "character-a" },
  { id: "tag-portrait", name: "Portraits", character_id: "character-a" },
]);
const landscape = asset("asset-landscape", "Landscape", [
  { id: "tag-shared", name: "Shared", character_id: "character-a" },
  { id: "tag-landscape", name: "Landscapes", character_id: "character-a" },
]);

function picker(props: Partial<React.ComponentProps<typeof OperatorMediaPicker>> = {}) {
  return (
    <OperatorMediaPicker conversationId={conversationA} open onOpenChange={vi.fn()} {...props} />
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function findAssetButton(name: string) {
  const button = (await screen.findByText(name)).closest("button");
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

beforeEach(() => {
  rpc.mockReset();
  vi.mocked(toast.error).mockReset();
});

describe("WP05 operator media catalog", () => {
  it("filters assets through every canonical tag, including a shared tag", async () => {
    rpc.mockResolvedValue({ data: [portrait, landscape], error: null });
    render(picker());

    expect(await findAssetButton("Portrait")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Portraits" }));
    expect(screen.getByText("Portrait")).toBeInTheDocument();
    expect(screen.queryByText("Landscape")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Shared" }));
    expect(screen.getByText("Portrait")).toBeInTheDocument();
    expect(screen.getByText("Landscape")).toBeInTheDocument();
  });

  it("keeps cached catalog data visible when refresh fails and replaces it after retry", async () => {
    let reads = 0;
    rpc.mockImplementation(async (name: string) => {
      if (name !== "get_operator_media_catalog") throw new Error(`Unexpected RPC: ${name}`);
      reads += 1;
      if (reads === 1) return { data: [portrait], error: null };
      if (reads === 2) return { data: null, error: { message: "refresh_failed" } };
      return { data: [landscape], error: null };
    });
    const view = render(picker());
    expect(await findAssetButton("Portrait")).toBeInTheDocument();

    view.rerender(picker({ open: false }));
    view.rerender(picker({ open: true }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("הרשימה הקודמת נשארה זמינה");
    expect(screen.getByText("Portrait")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "נסה שוב" }));
    expect(await findAssetButton("Landscape")).toBeInTheDocument();
    expect(screen.queryByText("Portrait")).not.toBeInTheDocument();
  });

  it("removes an already-delivered asset after the next catalog refresh", async () => {
    rpc
      .mockResolvedValueOnce({ data: [portrait], error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    const view = render(picker());
    expect(await findAssetButton("Portrait")).toBeInTheDocument();
    view.rerender(picker({ open: false }));
    view.rerender(picker({ open: true }));
    expect(await screen.findByText("אין מדיה זמינה עבור הדמות בשלב זה.")).toBeInTheDocument();
    expect(screen.queryByText("Portrait")).not.toBeInTheDocument();
  });

  it("clears the old conversation immediately and ignores its late catalog completion", async () => {
    const oldRead = deferred<{ data: (typeof portrait)[]; error: null }>();
    rpc.mockImplementation((name: string, args: { _conversation_id: string }) => {
      if (name !== "get_operator_media_catalog") throw new Error(`Unexpected RPC: ${name}`);
      return args._conversation_id === conversationA
        ? oldRead.promise
        : Promise.resolve({ data: [landscape], error: null });
    });
    const view = render(picker());
    view.rerender(picker({ conversationId: conversationB, operatorSendGeneration: 1 }));
    expect(await findAssetButton("Landscape")).toBeInTheDocument();
    await act(async () => oldRead.resolve({ data: [portrait], error: null }));
    expect(screen.queryByText("Portrait")).not.toBeInTheDocument();
  });

  it("reports an asset already delivered to this client without selecting it", async () => {
    rpc.mockImplementation((name: string) => {
      if (name === "get_operator_media_catalog")
        return Promise.resolve({ data: [portrait], error: null });
      if (name === "reserve_character_media_for_delivery")
        return Promise.resolve({
          data: null,
          error: { message: "media_asset_already_delivered_to_client" },
        });
      throw new Error(`Unexpected RPC: ${name}`);
    });
    render(picker());
    fireEvent.click(await findAssetButton("Portrait"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("המדיה כבר נמסרה ללקוח הזה"));
    expect(screen.queryByText("שלח מדיה")).not.toBeInTheDocument();
  });
});
