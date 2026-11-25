import type { ComponentType, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PostgrestClient } from "@supabase/postgrest-js";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { Route } from "@/routes/app.conversations";

const io = vi.hoisted(() => ({
  viewer: "alice" as string | null,
  session: "alice" as string | null,
  role: "client",
  loading: false,
  from: vi.fn(),
  rpc: vi.fn(),
  channel: vi.fn(),
  removeChannel: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: io }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: io.viewer && { id: io.viewer },
    session: io.session && { user: { id: io.session } },
    role: io.role,
    loading: io.loading,
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({
    to,
    params,
    children,
  }: {
    to: string;
    params?: Record<string, string>;
    children: ReactNode;
  }) => <a href={to.replace(/\$(\w+)/g, (_, key) => params![key])}>{children}</a>,
}));
const Page = (Route as unknown as { component: ComponentType }).component;
const character = (id: string) => ({ id, name: id, avatar_url: null });
const like = (id: string, owner = "alice", liked_at: string | null = "2026-01-02") => ({
  client_id: owner,
  character_id: id,
  characters: { ...character(id), is_active: true, is_visible: true },
  liked_at,
  is_favorite: false,
});
const chat = (id: string, who: string, owner = "alice") => ({
  id,
  client_id: owner,
  character_id: who,
  characters: character(who),
  last_message_preview: "existing message " + id,
  last_message_at: null,
  status: "closed",
  client_unread_count: 99,
  client_hidden_at: null as string | null,
});
const chats = "conversations";
const marks = "client_character_preferences";
let conversations: ReturnType<typeof chat>[];
let preferences: ReturnType<typeof like>[];
let fail: string;
let requests: URL[];
let hold: ((table: string, owner: string | null) => Promise<void>) | undefined;
let subscriptions: { table: string; filter?: string; run: () => void }[];
beforeEach(() => {
  Object.assign(io, { viewer: "alice", session: "alice", role: "client", loading: false });
  conversations = [];
  preferences = [];
  subscriptions = [];
  requests = [];
  hold = undefined;
  fail = "";
  const rest = new PostgrestClient("https://fixture.invalid/rest/v1", {
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      const table = url.pathname.split("/").at(-1)!;
      const owner = url.searchParams.get("client_id");
      const q = url.searchParams;
      const rows =
        table === chats
          ? conversations.filter(
              (row) => q.get("client_hidden_at") !== "is.null" || row.client_hidden_at === null,
            )
          : preferences.filter(
              (row) =>
                (q.get("liked_at") !== "not.is.null" || row.liked_at !== null) &&
                (q.get("characters.is_active") !== "eq.true" || row.characters.is_active) &&
                (q.get("characters.is_visible") !== "eq.true" || row.characters.is_visible),
            );
      const data = rows.filter((r) => !owner || owner === "eq." + r.client_id);
      await hold?.(table, owner);
      return Response.json(fail === table ? { message: "denied", code: "42501" } : data, {
        status: fail === table ? 403 : 200,
      });
    },
  });
  io.from.mockImplementation((table: string) => {
    if (table !== chats && table !== marks) throw new Error("Unexpected table: " + table);
    return rest.from(table);
  });
  io.rpc.mockImplementation((fn, { _conversation_ids: ids }: { _conversation_ids: string[] }) => {
    if (fn !== "get_my_conversation_unread_counts") throw new Error("Unexpected RPC: " + fn);
    return { data: ids.map((id) => ({ conversation_id: id, unread_count: 3 })), error: null };
  });
  io.channel.mockImplementation(() => {
    const channel = {
      on: (_: string, filter: { table: string; filter?: string }, run: () => void) => {
        subscriptions.push({ ...filter, run });
        return channel;
      },
      subscribe: () => channel,
    };
    return channel;
  });
});
function show() {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(["conversations", "client"], [chat("legacy", "PreviousAccount")]);
  const tree = () => (
    <QueryClientProvider client={cache}>
      <Page />
    </QueryClientProvider>
  );
  const view = render(tree());
  return { cache, refresh: () => view.rerender(tree()) };
}
const hrefs = () => screen.queryAllByRole("link").map((a) => a.getAttribute("href"));

it("shows a Like-only profile without opening a chat or looking up hidden history", async () => {
  // There is no visible conversation. Whether one ever existed is unknowable here.
  preferences = [like("Dana"), like("Foreign", "bob")];
  show();
  const link = await screen.findByRole("link", { name: /Dana/ });
  expect(link).toHaveAttribute("href", "/app/characters/Dana");
  expect(link).toHaveTextContent("פרופיל");
  expect(link.closest('[dir="rtl"]')).not.toBeNull();
  expect(hrefs()).toEqual(["/app/characters/Dana"]);
  expect(requests.map((u) => u.pathname.split("/").at(-1)).sort()).toEqual([marks, chats].sort());
  for (const url of requests) expect(url.searchParams.get("client_id")).toBe("eq.alice");
  const mark = requests.find((url) => url.pathname.endsWith(marks))!.searchParams;
  expect(mark.get("liked_at")).toBe("not.is.null");
  expect(mark.has("is_favorite")).toBe(false);
  expect(mark.get("characters.is_active")).toBe("eq.true");
  expect(mark.get("characters.is_visible")).toBe("eq.true");
  expect(mark.get("select")).toContain("characters!inner(");
  const visible = requests.find((url) => url.pathname.endsWith(chats))!.searchParams;
  expect(visible.get("client_hidden_at")).toBe("is.null");
  expect(visible.get("select")).not.toContain("client_hidden_at");
  expect(io.rpc).not.toHaveBeenCalled();
});

it("ignores favorites without a Like, withdrawn Likes, inactive/invisible characters and hidden chat metadata", async () => {
  const inactive = like("Inactive");
  inactive.characters.is_active = false;
  const invisible = like("Invisible");
  invisible.characters.is_visible = false;
  preferences = [
    { ...like("FavoriteOnly", "alice", null), is_favorite: true },
    like("Withdrawn", "alice", null),
    inactive,
    invisible,
    like("Liked"),
  ];
  conversations = [{ ...chat("hidden", "Liked"), client_hidden_at: "2026-01-03" }];
  show();
  await screen.findByRole("link", { name: /Liked/ });
  expect(hrefs()).toEqual(["/app/characters/Liked"]);
  expect(screen.queryByText("existing message hidden")).toBeNull();
  expect(io.rpc).not.toHaveBeenCalled();
});

it("rejects an inconsistent character join without linking the wrong profile", async () => {
  preferences = [{ ...like("Original"), characters: like("Wrong").characters }];
  show();
  await screen.findByRole("alert");
  expect(hrefs()).toEqual([]);
});

it("keeps all real visible chats, their ordering and unread; only unmatched marks get a profile", async () => {
  conversations = [
    chat("c2", "Dana"),
    chat("c1", "Dana"),
    chat("c3", "NoLike"),
    chat("foreign", "Foreign", "bob"),
  ];
  preferences = [like("Dana"), like("Lia"), like("Lia")];
  show();
  await screen.findByRole("link", { name: /Lia/ });
  expect(hrefs()).toEqual(["/app/chat/c2", "/app/chat/c1", "/app/chat/c3", "/app/characters/Lia"]);
  expect(screen.getByText("existing message c1")).toBeVisible();
  expect(screen.getAllByText("3")).toHaveLength(3);
  expect(io.rpc.mock.calls).toEqual([
    ["get_my_conversation_unread_counts", { _conversation_ids: ["c2", "c1", "c3"] }],
  ]);
  expect(requests.find((u) => u.pathname.endsWith(chats))!.searchParams.get("order")).toContain(
    "last_message_at.desc",
  );
});

it("shows the existing empty state only after both reads return empty", async () => {
  let release!: () => void;
  hold = (table) =>
    table === marks
      ? new Promise((done) => {
          release = done;
        })
      : Promise.resolve();
  show();
  await waitFor(() => expect(release).toBeTypeOf("function"));
  expect(screen.queryByText("עדיין אין לך שיחות")).toBeNull();
  await act(async () => release());
  expect(await screen.findByText("עדיין אין לך שיחות")).toBeVisible();
});

it.each([chats, marks])(
  "handles a failed %s read without inventing rows or claiming empty",
  async (table) => {
    conversations = [chat("c1", "Dana")];
    preferences = [like("Dana")];
    fail = table;
    show();
    await screen.findByRole("alert");
    expect(screen.queryByText("עדיין אין לך שיחות")).toBeNull();
    expect(hrefs()).toEqual(table === chats ? [] : ["/app/chat/c1"]);
  },
);

it("refetches visible conversations on owner-scoped notifications and deduplicates again", async () => {
  preferences = [like("Dana")];
  show();
  await screen.findByRole("link", { name: /Dana/ });
  expect(subscriptions.find((s) => s.table === chats)?.filter).toBe("client_id=eq.alice");
  expect(subscriptions.find((s) => s.table === "conversation_read_states")?.filter).toBe(
    "user_id=eq.alice",
  );
  conversations = [chat("c1", "Dana")];
  await act(async () => subscriptions.find((s) => s.table === chats)!.run());
  await waitFor(() => expect(hrefs()).toEqual(["/app/chat/c1"]));
  conversations = []; // Hide/delete: the server no longer returns that chat.
  await act(async () => subscriptions.find((s) => s.table === chats)!.run());
  await waitFor(() => expect(hrefs()).toEqual(["/app/characters/Dana"]));
  expect(screen.queryByText("existing message c1")).toBeNull();
});

it("does not publish a superseded first read after a hide notification", async () => {
  conversations = [chat("hidden", "Dana")];
  preferences = [like("Dana")];
  let release!: () => void;
  hold = (table) =>
    table === chats
      ? new Promise((done) => {
          release = done;
        })
      : Promise.resolve();
  show();
  await waitFor(() => expect(release).toBeTypeOf("function"));
  hold = undefined;
  conversations = [];
  act(() => {
    void subscriptions.find((s) => s.table === chats)!.run();
  });
  await act(async () => release());
  await waitFor(() => expect(hrefs()).toEqual(["/app/characters/Dana"]));
  expect(io.rpc).not.toHaveBeenCalled();
});

it("drops previous-account rows immediately, ignores a late response, and detaches on logout", async () => {
  conversations = [chat("a", "AliceChat")];
  preferences = [like("AliceProfile"), like("BobProfile", "bob")];
  const view = show();
  await screen.findByRole("link", { name: /AliceProfile/ });
  const old = subscriptions.find((s) => s.table === chats)!;
  let release!: () => void;
  hold = (table, owner) =>
    table === chats && owner === "eq.alice"
      ? new Promise((done) => {
          release = done;
        })
      : Promise.resolve();
  act(() => {
    void old.run();
  });
  await waitFor(() => expect(release).toBeTypeOf("function"));
  io.viewer = io.session = "bob";
  view.refresh();
  expect(hrefs().join(" ")).not.toMatch(/Alice|chat\/a/);
  await screen.findByRole("link", { name: /BobProfile/ });
  await act(async () => release());
  expect(hrefs()).toEqual(["/app/characters/BobProfile"]);
  const before = requests.length;
  await act(async () => old.run());
  expect(requests).toHaveLength(before);
  io.viewer = io.session = null;
  view.refresh();
  expect(hrefs()).toEqual([]);
  expect(io.removeChannel).toHaveBeenCalledTimes(2);
});

it.each(["signed out", "loading", "operator", "session mismatch"])(
  "does no reads/subscriptions for %s",
  async (state) => {
    if (state === "signed out") io.viewer = io.session = null;
    if (state === "loading") io.loading = true;
    if (state === "operator") io.role = "operator";
    if (state === "session mismatch") io.session = "bob";
    show();
    expect(io.from).not.toHaveBeenCalled();
    expect(io.channel).not.toHaveBeenCalled();
    expect(hrefs()).toEqual([]);
  },
);
