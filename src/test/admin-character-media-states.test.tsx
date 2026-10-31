import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CharacterMediaDialog } from "@/components/admin/CharacterMediaDialog";

type RpcReply = { data: unknown; error: unknown };

const io = vi.hoisted(() => ({
  rpc: vi.fn<(name: string, args?: Record<string, unknown>) => Promise<RpcReply>>(),
  invoke: vi.fn(),
  previewStates: new Map<
    string,
    { status: "idle" | "loading" | "ready" | "error"; url: string | null }
  >(),
  previewRefresh: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: io.rpc,
    functions: { invoke: io.invoke },
  },
}));

vi.mock("@/hooks/useMediaViewUrl", () => ({
  useMediaViewUrl: (kind: string, targetId?: string) => {
    const state =
      io.previewStates.get(`${kind}:${targetId}`) ??
      (targetId
        ? { status: "ready" as const, url: `https://example.test/${targetId}.webp` }
        : { status: "idle" as const, url: null });
    return {
      ...state,
      retryAfterImageError: vi.fn(),
      refresh: () => io.previewRefresh(kind, targetId),
    };
  },
}));

const tagOne = {
  asset_count: 2,
  created_at: "2026-01-01T00:00:00Z",
  id: "tag-one",
  is_default: true,
  name: "תגית אחת",
  sort_order: 0,
  updated_at: "2026-01-01T00:00:00Z",
};

const tagTwo = {
  ...tagOne,
  asset_count: 1,
  id: "tag-two",
  is_default: false,
  name: "תגית שתיים",
  sort_order: 1,
};

function mediaAsset(
  id: string,
  displayName: string | null,
  mediaTagId = "tag-one",
  overrides: Record<string, unknown> = {},
) {
  return {
    byte_size: 1024,
    content_type: "image/webp",
    created_at: "2026-01-01T00:00:00Z",
    disabled_at: null,
    disabled_reason: null,
    display_name: displayName,
    height: 512,
    id,
    ingest_status: "ready",
    locked_derivative_error_code: null,
    locked_derivative_status: "ready",
    locked_derivatives_generated_at: "2026-01-01T00:00:00Z",
    locked_preview_available: false,
    locked_price_credits: null,
    media_tag_id: mediaTagId,
    media_tag_name: mediaTagId === "tag-two" ? tagTwo.name : tagOne.name,
    paid_open_price_credits: null,
    preview_available: true,
    processing_attempts: 1,
    processing_error_code: null,
    processing_started_at: null,
    status: "active",
    updated_at: "2026-01-01T00:00:00Z",
    width: 512,
    ...overrides,
  };
}

const alpha = mediaAsset("asset-alpha", "Alpha Portrait");
const beta = mediaAsset("asset-beta", "Beta Portrait", "tag-two");
const unnamed = mediaAsset("asset-unnamed", null);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function isReadRpc(name: string) {
  return name === "get_admin_character_media_assets" || name === "get_admin_media_tags";
}

function mutationCalls() {
  return io.rpc.mock.calls.filter(([name]) => !isReadRpc(name));
}

function renderMedia(character = { id: "character-a", name: "דמות א" }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CharacterMediaDialog character={character} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  return { queryClient, ...view };
}

function setDefaultReads(assets: unknown[] = [alpha, beta, unnamed], tags = [tagOne, tagTwo]) {
  io.rpc.mockImplementation(async (name) => {
    if (name === "get_admin_character_media_assets") return { data: assets, error: null };
    if (name === "get_admin_media_tags") return { data: tags, error: null };
    return { data: null, error: null };
  });
}

async function loadedAsset(name = "Alpha Portrait") {
  return screen.findByText(name);
}

const scrollIntoView = HTMLElement.prototype.scrollIntoView;

beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterAll(() => {
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
});

beforeEach(() => {
  io.rpc.mockReset();
  io.invoke.mockReset();
  io.previewStates.clear();
  io.previewRefresh.mockReset();
  setDefaultReads();
});

describe("admin character media read states", () => {
  it("shows initial loading without an empty state, then shows the true empty state", async () => {
    const assetsRead = deferred<RpcReply>();
    const tagsRead = deferred<RpcReply>();
    io.rpc.mockImplementation((name) =>
      name === "get_admin_character_media_assets" ? assetsRead.promise : tagsRead.promise,
    );
    renderMedia();

    expect(screen.getByRole("status", { name: "טוען מדיה" })).toBeInTheDocument();
    expect(screen.queryByText("אין מדיה לדמות זו")).not.toBeInTheDocument();
    await act(async () => {
      assetsRead.resolve({ data: [], error: null });
      tagsRead.resolve({ data: [], error: null });
    });
    expect(await screen.findByText("אין מדיה לדמות זו")).toBeInTheDocument();
  });

  it("combines a trimmed case-insensitive name search with the existing tag filter and tolerates null names", async () => {
    renderMedia();
    await loadedAsset();

    fireEvent.change(screen.getByRole("searchbox", { name: "חיפוש מדיה לפי שם" }), {
      target: { value: "  ALPHA  " },
    });
    expect(screen.getByText("Alpha Portrait")).toBeInTheDocument();
    expect(screen.queryByText("Beta Portrait")).not.toBeInTheDocument();

    const tagFilter = screen.getByRole("combobox", { name: "סינון לפי תגית" });
    fireEvent.keyDown(tagFilter, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "תגית שתיים" }));
    expect(screen.queryByText("Alpha Portrait")).not.toBeInTheDocument();
    expect(screen.getByText("לא נמצאו נכסים התואמים למסננים.")).toBeInTheDocument();
    expect(mutationCalls()).toEqual([]);
  });

  it("resets only search and tag after no results", async () => {
    renderMedia();
    await loadedAsset();
    fireEvent.change(screen.getByRole("searchbox", { name: "חיפוש מדיה לפי שם" }), {
      target: { value: "missing" },
    });
    expect(await screen.findByText("לא נמצאו נכסים התואמים למסננים.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "איפוס מסננים" }));
    expect(screen.getByRole("searchbox", { name: "חיפוש מדיה לפי שם" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "סינון לפי תגית" })).toHaveTextContent("כל התגיות");
    expect(screen.getByText("Alpha Portrait")).toBeInTheDocument();
    expect(screen.getByText("Beta Portrait")).toBeInTheDocument();
  });

  it("keeps cached assets visible during refresh, reports failure, and retries the read", async () => {
    const nextAssets = deferred<RpcReply>();
    let assetReads = 0;
    io.rpc.mockImplementation((name) => {
      if (name === "get_admin_media_tags") return Promise.resolve({ data: [tagOne], error: null });
      assetReads += 1;
      if (assetReads === 1) return Promise.resolve({ data: [alpha], error: null });
      if (assetReads === 2) return nextAssets.promise;
      return Promise.resolve({ data: [beta], error: null });
    });
    const { queryClient } = renderMedia();
    await loadedAsset();
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ["admin-character-media", "character-a"] });
    });
    expect(await screen.findByRole("status", { name: "מרענן את רשימת המדיה" })).toBeInTheDocument();
    expect(screen.getByText("Alpha Portrait")).toBeInTheDocument();
    await act(async () => {
      nextAssets.resolve({ data: null, error: { message: "refresh failed" } });
    });
    expect(await screen.findByRole("alert", { name: "שגיאת טעינת מדיה" })).toHaveTextContent(
      "הנכסים המוצגים עשויים להיות לא מעודכנים",
    );
    expect(screen.getByText("Alpha Portrait")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "נסה לטעון מדיה שוב" }));
    expect(await screen.findByText("Beta Portrait")).toBeInTheDocument();
    expect(mutationCalls()).toEqual([]);
  });

  it("shows an assets failure, retries only the read, and recovers", async () => {
    let assetReads = 0;
    io.rpc.mockImplementation(async (name) => {
      if (name === "get_admin_media_tags") return { data: [tagOne], error: null };
      assetReads += 1;
      return assetReads === 1
        ? { data: null, error: { message: "assets failed" } }
        : { data: [alpha], error: null };
    });
    renderMedia();
    expect(await screen.findByRole("alert", { name: "שגיאת טעינת מדיה" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "נסה לטעון מדיה שוב" }));
    await loadedAsset();
    expect(assetReads).toBe(2);
    expect(mutationCalls()).toEqual([]);
    expect(io.invoke).not.toHaveBeenCalled();
  });

  it("does not treat a tags failure as an empty result and retries only the tags read", async () => {
    let tagReads = 0;
    io.rpc.mockImplementation(async (name) => {
      if (name === "get_admin_character_media_assets") return { data: [alpha], error: null };
      tagReads += 1;
      return tagReads === 1
        ? { data: null, error: { message: "tags failed" } }
        : { data: [tagOne], error: null };
    });
    renderMedia();
    expect(await screen.findByRole("alert", { name: "שגיאת טעינת תגיות" })).toBeInTheDocument();
    expect(screen.queryByText("אין תגיות מדיה לדמות זו.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "נסה לטעון תגיות שוב" }));
    expect(await screen.findByDisplayValue("תגית אחת")).toBeInTheDocument();
    expect(tagReads).toBe(2);
    expect(mutationCalls()).toEqual([]);
  });

  it("preserves tag drafts and selection when a cached tags refresh fails", async () => {
    const failedRefresh = deferred<RpcReply>();
    let tagReads = 0;
    io.rpc.mockImplementation((name) => {
      if (name === "get_admin_character_media_assets") {
        return Promise.resolve({ data: [alpha], error: null });
      }
      tagReads += 1;
      return tagReads === 1
        ? Promise.resolve({ data: [tagOne], error: null })
        : failedRefresh.promise;
    });
    const { queryClient } = renderMedia();
    const tagName = await screen.findByDisplayValue("תגית אחת");
    fireEvent.change(tagName, { target: { value: "טיוטה שלא תאבד" } });
    const tagFilter = screen.getByRole("combobox", { name: "סינון לפי תגית" });
    fireEvent.keyDown(tagFilter, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "תגית אחת" }));

    act(() => {
      void queryClient.invalidateQueries({
        queryKey: ["admin-character-media-tags", "character-a"],
      });
    });
    await act(async () => {
      failedRefresh.resolve({ data: null, error: { message: "refresh failed" } });
    });
    expect(await screen.findByRole("alert", { name: "שגיאת טעינת תגיות" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("טיוטה שלא תאבד")).toBeInTheDocument();
    expect(tagFilter).toHaveTextContent("תגית אחת");
  });

  it("shows a locked preview error and uses the existing refresh contract", async () => {
    const lockedAsset = mediaAsset("asset-locked", "Locked Portrait", "tag-one", {
      locked_preview_available: true,
    });
    setDefaultReads([lockedAsset], [tagOne]);
    io.previewStates.set("admin_locked_teaser_preview:asset-locked", {
      status: "error",
      url: null,
    });
    renderMedia();
    await loadedAsset("Locked Portrait");
    const previewError = screen.getByRole("alert", { name: "שגיאת תצוגה נעולה" });
    expect(previewError).toHaveTextContent("התצוגה הנעולה אינה זמינה");
    fireEvent.click(
      within(previewError).getByRole("button", { name: "נסה לטעון תצוגה נעולה שוב" }),
    );
    expect(io.previewRefresh).toHaveBeenCalledWith("admin_locked_teaser_preview", "asset-locked");
    expect(mutationCalls()).toEqual([]);
  });

  it("does not let a late read from the previous character replace the current view", async () => {
    const oldAssets = deferred<RpcReply>();
    const oldTags = deferred<RpcReply>();
    io.rpc.mockImplementation((name, args) => {
      const characterId = args?._character_id;
      if (characterId === "character-a") {
        return name === "get_admin_character_media_assets" ? oldAssets.promise : oldTags.promise;
      }
      return Promise.resolve(
        name === "get_admin_character_media_assets"
          ? { data: [mediaAsset("asset-b", "דמות ב בלבד")], error: null }
          : { data: [tagOne], error: null },
      );
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <CharacterMediaDialog character={{ id: "character-a", name: "דמות א" }} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <CharacterMediaDialog character={{ id: "character-b", name: "דמות ב" }} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("דמות ב בלבד")).toBeInTheDocument();
    await act(async () => {
      oldAssets.resolve({ data: [alpha], error: null });
      oldTags.resolve({ data: [tagTwo], error: null });
    });
    expect(screen.getByText("דמות ב בלבד")).toBeInTheDocument();
    expect(screen.queryByText("Alpha Portrait")).not.toBeInTheDocument();
  });

  it("starts with clean filters after the dialog closes and opens again", async () => {
    const first = renderMedia();
    await loadedAsset();
    fireEvent.change(screen.getByRole("searchbox", { name: "חיפוש מדיה לפי שם" }), {
      target: { value: "missing" },
    });
    expect(await screen.findByText("לא נמצאו נכסים התואמים למסננים.")).toBeInTheDocument();
    first.unmount();

    renderMedia();
    await loadedAsset();
    expect(screen.getByRole("searchbox", { name: "חיפוש מדיה לפי שם" })).toHaveValue("");
    expect(screen.queryByText("לא נמצאו נכסים התואמים למסננים.")).not.toBeInTheDocument();
  });

  it("preserves the existing disable action signature", async () => {
    setDefaultReads([alpha], [tagOne]);
    renderMedia();
    await loadedAsset();
    fireEvent.click(screen.getByRole("button", { name: "השבתה" }));
    await waitFor(() =>
      expect(io.rpc).toHaveBeenCalledWith("disable_character_media_asset", {
        _asset_id: "asset-alpha",
      }),
    );
  });
});
