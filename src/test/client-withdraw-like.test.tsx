import type { ComponentType } from "react";
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/app.characters";

const io = vi.hoisted(() => ({
  client: "client-a",
  rpc: vi.fn(),
  error: vi.fn(),
  navigate: vi.fn(),
  view: vi.fn(),
  getSession: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  maybeSingle: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  useRouterState: () => "/app/characters",
  useNavigate: () => io.navigate,
  Outlet: () => null,
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    role: "client",
    loading: false,
    user: { id: io.client },
    session: { user: { id: io.client } },
  }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: io.rpc,
    auth: { getSession: io.getSession },
    from: io.from,
  },
}));
vi.mock("@/lib/analyticsEvents", () => ({ trackAnalyticsEvent: io.view }));
vi.mock("sonner", () => ({ toast: { error: io.error } }));
vi.mock("@/components/discovery/DiscoveryFilters", () => ({ DiscoveryFilters: () => null }));

const Page = (Route as unknown as { component: ComponentType }).component;
const filters = { favorites_only: false, recycled_only: false };
const card = {
  id: "character-a",
  name: "Dana",
  cycle_id: "cycle-2",
  cycle_number: 2,
  is_recycled: true,
  is_liked: true,
  is_favorite: true,
  interests: [],
};
const key = ["discovery-card", "client-a", JSON.stringify(filters)];
const result = (idempotent: boolean) => ({
  data: { character_id: card.id, is_liked: false, idempotent },
  error: null,
});
const remove = "הסר לייק";
const payload = { _character_id: card.id, _expected_subject: "client-a" };
const session = (id: string) => ({ data: { session: { user: { id } } }, error: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const writes = () => io.rpc.mock.calls.filter(([name]) => name !== "get_discovery_characters");
function page(cache: QueryClient) {
  return (
    <QueryClientProvider client={cache}>
      <Page />
    </QueryClientProvider>
  );
}
function show() {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(page(cache));
  return cache;
}
beforeEach(() => {
  io.client = "client-a";
  io.getSession.mockReset().mockImplementation(() => Promise.resolve(session(io.client)));
  io.from.mockReturnValue(io);
  io.select.mockReturnValue(io);
  io.eq.mockReturnValue(io);
  io.maybeSingle.mockReset().mockResolvedValue({ data: null, error: null });
  io.rpc.mockReset().mockImplementation((name) => {
    if (name === "get_discovery_characters") return { data: [card], error: null };
    throw new Error("unexpected RPC: " + name);
  });
});

describe("client withdraws a saved Like on discovery", () => {
  it.each([false, true])(
    "accepts confirmed removal (already removed: %s) without consuming the card",
    async (duplicate) => {
      const cache = show();
      const button = await screen.findByRole("button", { name: remove });
      const before = cache.getQueryData<object>(key)!;
      const ownOtherFilter = ["discovery-card", "client-a", "other-filter"];
      const otherClient = ["discovery-card", "client-b", key[2]];
      const otherCharacter = ["discovery-card", "client-a", "third-filter"];
      cache.setQueryData(ownOtherFilter, before);
      cache.setQueryData(otherClient, before);
      cache.setQueryData(otherCharacter, { ...before, id: "different" });
      cache.setQueryData(["favorites", "client-a", 0], []);
      cache.setQueryData(["favorites", "client-b", 0], []);
      const ownLikes = ["client-liked-profiles", "client-a"];
      const otherLikes = ["client-liked-profiles", "client-b"];
      cache.setQueryData(ownLikes, [card]);
      cache.setQueryData(otherLikes, []);
      io.rpc.mockResolvedValueOnce(result(duplicate));
      button.focus();
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(screen.queryByRole("button", { name: remove })).toBeNull());
      expect(writes()).toEqual([["remove_character_like", payload]]);
      expect(cache.getQueryData(key)).toEqual({ ...before, is_liked: false });
      expect(cache.getQueryData(ownOtherFilter)).toEqual({ ...before, is_liked: false });
      expect(cache.getQueryData(otherClient)).toEqual(before);
      expect(cache.getQueryData(otherCharacter)).toEqual({ ...before, id: "different" });
      expect(cache.getQueryState(["favorites", "client-a", 0])?.isInvalidated).toBe(true);
      expect(cache.getQueryState(["favorites", "client-b", 0])?.isInvalidated).toBe(false);
      expect(cache.getQueryState(ownLikes)?.isInvalidated).toBe(true);
      expect(cache.getQueryState(otherLikes)?.isInvalidated).toBe(false);
      cache.setQueryData(ownLikes, []);
      expect(screen.getByRole("button", { name: "הסר ממועדפים" })).toBeEnabled();
      expect(io.navigate).not.toHaveBeenCalled();
      expect(io.view).toHaveBeenCalledTimes(1);
      io.rpc.mockResolvedValueOnce({ data: { first_like: true }, error: null });
      await userEvent.click(screen.getByRole("button", { name: "אהבתי" }));
      expect(writes()[1]).toEqual([
        "set_character_swipe",
        {
          _character_id: card.id,
          _cycle_id: card.cycle_id,
          _filters: filters,
          _swipe: "like",
        },
      ]);
      await waitFor(() => expect(cache.getQueryState(ownLikes)?.isInvalidated).toBe(true));
      expect(cache.getQueryState(otherLikes)?.isInvalidated).toBe(false);
    },
  );

  it("keeps the last confirmed state on an explicit server denial without reconciliation", async () => {
    const cache = show();
    const button = await screen.findByRole("button", { name: remove });
    const before = cache.getQueryData(key);
    io.rpc.mockResolvedValueOnce({ data: null, error: { code: "42501", message: "denied" } });
    await userEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("לא הצלחנו להסיר");
    expect(io.from).not.toHaveBeenCalled();
    expect(cache.getQueryData(key)).toEqual(before);
    expect(button).toBeEnabled();
    expect(writes()).toHaveLength(1);
  });

  it.each(["malformed", "lost reply", "transport response", "read failed"])(
    "reconciles %s with one own preference read, never another write",
    async (mode) => {
      const cache = show();
      const button = await screen.findByRole("button", { name: remove });
      if (mode === "lost reply") io.rpc.mockRejectedValueOnce(new TypeError("failed to fetch"));
      else if (mode === "transport response")
        io.rpc.mockResolvedValueOnce({ data: null, status: 0, error: { message: "network" } });
      else
        io.rpc.mockResolvedValueOnce({
          data: { ...result(false).data, character_id: "wrong" },
          error: null,
        });
      if (mode === "read failed")
        io.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "unavailable" } });
      else
        io.maybeSingle.mockResolvedValueOnce({
          data: { client_id: "client-a", character_id: card.id, liked_at: null },
          error: null,
        });
      await userEvent.click(button);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        mode === "read failed" ? "או לרענן" : "נבדק מחדש",
      );
      expect(io.from.mock.calls).toEqual([["client_character_preferences"]]);
      expect(io.eq.mock.calls).toEqual([
        ["client_id", "client-a"],
        ["character_id", card.id],
      ]);
      expect(io.maybeSingle).toHaveBeenCalledTimes(1);
      expect(cache.getQueryData(key)).toMatchObject({ is_liked: mode === "read failed" });
      expect(writes()).toEqual([["remove_character_like", payload]]);
    },
  );

  it("drops an intention when the active session changes before dispatch", async () => {
    show();
    const gate = deferred<ReturnType<typeof session>>();
    io.getSession.mockReturnValueOnce(gate.promise);
    await userEvent.click(await screen.findByRole("button", { name: remove }));
    await act(async () => gate.resolve(session("client-b")));
    expect(writes()).toEqual([]);
    expect(io.from).not.toHaveBeenCalled();
  });

  it("does not queue an offline intention for later replay", async () => {
    show();
    const button = await screen.findByRole("button", { name: remove });
    try {
      onlineManager.setOnline(false);
      await userEvent.click(button);
      await act(async () => onlineManager.setOnline(true));
      expect(writes()).toEqual([]);
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("does not publish an uncertain reply's late preference read to a new session", async () => {
    const cache = new QueryClient();
    const view = render(page(cache));
    const button = await screen.findByRole("button", { name: remove });
    const read = deferred<{ data: null; error: null }>();
    io.rpc.mockRejectedValueOnce(new TypeError("lost reply"));
    io.maybeSingle.mockReturnValueOnce(read.promise);
    await userEvent.click(button);
    await waitFor(() => expect(io.maybeSingle).toHaveBeenCalledTimes(1));
    io.client = "client-b";
    view.rerender(page(cache));
    await act(async () => read.resolve({ data: null, error: null }));
    expect(cache.getQueryData(key)).toMatchObject({ is_liked: true });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(io.error).not.toHaveBeenCalled();
    expect(writes()).toEqual([["remove_character_like", payload]]);
  });

  it.each(["switch", "unmount", "switch and return"])(
    "ignores late completions after %s",
    async (change) => {
      const cache = new QueryClient();
      const view = render(page(cache));
      const button = await screen.findByRole("button", { name: remove });
      const reply = deferred<ReturnType<typeof result>>();
      io.rpc.mockReturnValueOnce(reply.promise);
      await userEvent.click(button);
      await waitFor(() => expect(writes()).toHaveLength(1));
      if (change === "unmount") view.unmount();
      else {
        io.client = "client-b";
        view.rerender(page(cache));
        await screen.findByRole("button", { name: remove });
        if (change === "switch and return") {
          io.client = "client-a";
          view.rerender(page(cache));
        }
      }
      await act(async () => reply.resolve(result(false)));
      expect(cache.getQueryData(key)).toMatchObject({ is_liked: true });
      expect(io.error).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("discards an in-flight first read on another filter and refreshes its active observer", async () => {
    const cache = show();
    const button = await screen.findByRole("button", { name: remove });
    const alt = ["discovery-card", "client-a", "new-filter"];
    const late = deferred<typeof card>();
    const read = vi
      .fn()
      .mockReturnValueOnce(late.promise)
      .mockResolvedValue({ ...card, is_liked: false });
    const stop = new QueryObserver(cache, { queryKey: alt, queryFn: read }).subscribe(() => {});
    try {
      expect(cache.getQueryData(alt)).toBeUndefined();
      io.rpc.mockResolvedValueOnce(result(false));
      await userEvent.click(button);
      await act(async () => late.resolve(card));
      await waitFor(() => expect(cache.getQueryData(alt)).toMatchObject({ is_liked: false }));
      expect(read).toHaveBeenCalledTimes(2);
      expect(writes()).toEqual([["remove_character_like", payload]]);
    } finally {
      stop();
    }
  });

  it("coalesces same-tick activation and disables card actions while pending", async () => {
    show();
    const button = await screen.findByRole("button", { name: remove });
    let complete!: (value: ReturnType<typeof result>) => void;
    io.rpc.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    act(() => {
      button.click();
      button.click();
    });
    await waitFor(() => expect(button).toBeDisabled());
    expect(screen.getByRole("button", { name: "אהבת" })).toBeDisabled();
    expect(writes()).toHaveLength(1);
    await act(async () => {
      complete(result(false));
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: remove })).toBeNull());
  });

  it.each(["button", "right swipe"])("still sends Like on a liked card via %s", async (method) => {
    show();
    const button = await screen.findByRole("button", { name: "אהבת" });
    io.rpc.mockResolvedValueOnce({ data: { is_liked: true, first_like: false }, error: null });
    if (method === "button") await userEvent.click(button);
    else {
      const surface = screen.getByRole("heading", { name: card.name }).closest(".touch-pan-y")!;
      Object.defineProperty(surface, "setPointerCapture", { value: vi.fn() });
      fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 10 });
      fireEvent.pointerUp(surface, { pointerId: 1, clientX: 130 });
    }
    await waitFor(() =>
      expect(writes()).toEqual([
        [
          "set_character_swipe",
          {
            _character_id: card.id,
            _cycle_id: card.cycle_id,
            _filters: filters,
            _swipe: "like",
          },
        ],
      ]),
    );
  });
});
