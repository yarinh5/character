import type { ComponentType, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Reply = { data: unknown; error: unknown; status?: number };
type Operation = { name: string; args: unknown[] };

const ids = {
  clientA: "00000000-0000-4000-8000-000000000001",
  clientB: "00000000-0000-4000-8000-000000000002",
  characterA: "00000000-0000-4000-8000-000000000101",
  characterB: "00000000-0000-4000-8000-000000000102",
  conversation: "00000000-0000-4000-8000-000000000201",
};

const preference = {
  character_id: ids.characterA,
  favorited_at: "2026-11-01T10:00:00Z",
  liked_at: null,
  characters: {
    id: ids.characterA,
    name: "מאיה",
    avatar_url: null,
    fictional_age: 29,
    short_description: "תיאור קצר",
    category: "חברות",
    interests: ["מוזיקה"],
    availability_status: "available",
  },
};

const io = vi.hoisted(() => ({
  auth: {
    loading: false,
    role: "client" as "client" | "operator" | "admin" | null,
    userId: "00000000-0000-4000-8000-000000000001" as string | null,
    sessionUserId: "00000000-0000-4000-8000-000000000001" as string | null,
  },
  read: vi.fn<(table: string, operations: Operation[]) => Promise<Reply>>(),
  favoriteWrite: vi.fn<() => Promise<Reply>>(),
  conversationWrite: vi.fn<() => Promise<Reply>>(),
  navigate: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  useNavigate: () => io.navigate,
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: Record<string, string>;
  }) => (
    <a href={params?.characterId ? `/app/characters/${params.characterId}` : to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    loading: io.auth.loading,
    role: io.auth.role,
    user: io.auth.userId ? { id: io.auth.userId } : null,
    session: io.auth.sessionUserId ? { user: { id: io.auth.sessionUserId } } : null,
  }),
}));

vi.mock("sonner", () => ({ toast: { error: io.error } }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const operations: Operation[] = [];
      let execution: Promise<Reply> | null = null;
      const execute = () => {
        execution ??= Promise.resolve().then(() => io.read(table, operations));
        return execution;
      };
      const query = {
        select: (...args: unknown[]) => {
          operations.push({ name: "select", args });
          return query;
        },
        eq: (...args: unknown[]) => {
          operations.push({ name: "eq", args });
          return query;
        },
        order: (...args: unknown[]) => {
          operations.push({ name: "order", args });
          return query;
        },
        in: (...args: unknown[]) => {
          operations.push({ name: "in", args });
          return query;
        },
        is: (...args: unknown[]) => {
          operations.push({ name: "is", args });
          return query;
        },
        neq: (...args: unknown[]) => {
          operations.push({ name: "neq", args });
          return query;
        },
        then: (resolve: (value: Reply) => unknown, reject: (reason: unknown) => unknown) =>
          execute().then(resolve, reject),
      };
      return query;
    },
    rpc: (name: string) => {
      if (name === "set_character_favorite") return io.favoriteWrite();
      if (name === "start_or_get_conversation") return io.conversationWrite();
      throw new Error(`Unexpected RPC: ${name}`);
    },
  },
}));

import { Route } from "@/routes/app.favorites";

const Page = (Route as unknown as { component: ComponentType }).component;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function defaultRead(table: string, operations: Operation[]): Promise<Reply> {
  if (table === "client_character_preferences") {
    expect(operations).toContainEqual({ name: "eq", args: ["is_favorite", true] });
    expect(operations).toContainEqual({ name: "eq", args: ["characters.is_active", true] });
    expect(operations).toContainEqual({ name: "eq", args: ["characters.is_visible", true] });
    return Promise.resolve({ data: [preference], error: null });
  }
  if (table === "conversations") {
    expect(operations).toContainEqual({ name: "is", args: ["client_hidden_at", null] });
    expect(operations).toContainEqual({ name: "neq", args: ["status", "closed"] });
    return Promise.resolve({
      data: [{ id: ids.conversation, character_id: ids.characterA }],
      error: null,
    });
  }
  throw new Error(`Unexpected table: ${table}`);
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } },
  });
}

function mount(client = makeClient()) {
  const view = render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  );
  return {
    ...view,
    client,
    rerenderPage: () =>
      view.rerender(
        <QueryClientProvider client={client}>
          <Page />
        </QueryClientProvider>,
      ),
  };
}

beforeEach(() => {
  Object.assign(io.auth, {
    loading: false,
    role: "client",
    userId: ids.clientA,
    sessionUserId: ids.clientA,
  });
  io.read.mockReset().mockImplementation(defaultRead);
  io.favoriteWrite.mockReset().mockResolvedValue({
    data: { character_id: ids.characterA, is_favorite: false, idempotent: false },
    error: null,
  });
  io.conversationWrite.mockReset().mockResolvedValue({ data: ids.conversation, error: null });
  io.navigate.mockReset().mockResolvedValue(undefined);
  io.error.mockReset();
});

describe("client favorites workflow", () => {
  it("waits for matching client identity and does not show another identity's cache", async () => {
    io.auth.loading = true;
    const client = makeClient();
    client.setQueryData(
      ["favorites", ids.clientA],
      [{ ...preference.characters, conversation_id: null }],
    );
    const view = mount(client);
    expect(io.read).not.toHaveBeenCalled();
    expect(screen.queryByText("מאיה")).not.toBeInTheDocument();

    io.auth.loading = false;
    io.auth.sessionUserId = ids.clientB;
    view.rerenderPage();
    expect(io.read).not.toHaveBeenCalled();

    io.auth.sessionUserId = ids.clientA;
    view.rerenderPage();
    expect(await screen.findByRole("heading", { name: "מאיה" })).toBeInTheDocument();
  });

  it("links image and name to the existing profile without nesting action buttons", async () => {
    mount();
    await screen.findByRole("heading", { name: "מאיה" });
    const link = screen.getByRole("link", { name: "מאיה" });
    expect(link).toHaveAttribute("href", `/app/characters/${ids.characterA}`);
    expect(screen.getByRole("button", { name: "הסר ממועדפים" }).closest("a")).toBeNull();
    expect(screen.getByRole("button", { name: "המשך שיחה" }).closest("a")).toBeNull();
  });

  it("treats malformed rows as an error instead of an empty list", async () => {
    io.read.mockImplementation((table, operations) =>
      table === "client_character_preferences"
        ? Promise.resolve({
            data: [{ ...preference, characters: { ...preference.characters, interests: 4 } }],
            error: null,
          })
        : defaultRead(table, operations),
    );
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("טעינת המועדפים נכשלה");
    expect(screen.queryByText("אין דמויות במועדפים עדיין")).not.toBeInTheDocument();
  });

  it("stops conversation enrichment when identity changes after the preference read", async () => {
    const preferences = deferred<Reply>();
    io.read.mockImplementation((table, operations) =>
      table === "client_character_preferences"
        ? preferences.promise
        : defaultRead(table, operations),
    );
    const view = mount();
    io.auth.userId = io.auth.sessionUserId = null;
    view.rerenderPage();
    await act(async () => preferences.resolve({ data: [preference], error: null }));
    expect(io.read.mock.calls.some(([table]) => table === "conversations")).toBe(false);
    expect(screen.queryByText("מאיה")).not.toBeInTheDocument();
  });

  it("keeps cached favorites through refresh failure and retries only the read", async () => {
    let preferenceReads = 0;
    io.read.mockImplementation((table, operations) => {
      if (table !== "client_character_preferences") return defaultRead(table, operations);
      preferenceReads += 1;
      return Promise.resolve(
        preferenceReads === 2
          ? { data: null, error: { message: "refresh failed" } }
          : { data: [preference], error: null },
      );
    });
    const view = mount();
    await screen.findByRole("heading", { name: "מאיה" });
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ["favorites", ids.clientA] });
    });
    expect(screen.getByRole("heading", { name: "מאיה" })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("רענון המועדפים נכשל");
    fireEvent.click(screen.getByRole("button", { name: "נסה שוב" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(io.favoriteWrite).not.toHaveBeenCalled();
  });

  it("serializes removal, accepts idempotent response and does not resend after refresh failure", async () => {
    const write = deferred<Reply>();
    io.favoriteWrite.mockReturnValue(write.promise);
    let preferenceReads = 0;
    io.read.mockImplementation((table, operations) => {
      if (table !== "client_character_preferences") return defaultRead(table, operations);
      preferenceReads += 1;
      return Promise.resolve(
        preferenceReads === 1
          ? { data: [preference], error: null }
          : { data: null, error: { message: "post-mutation refresh failed" } },
      );
    });
    mount();
    const remove = await screen.findByRole("button", { name: "הסר ממועדפים" });
    fireEvent.click(remove);
    fireEvent.click(remove);
    await waitFor(() => expect(io.favoriteWrite).toHaveBeenCalledTimes(1));
    await act(async () =>
      write.resolve({
        data: { character_id: ids.characterA, is_favorite: false, idempotent: true },
        error: null,
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "המועדף עודכן, אך רענון הרשימה נכשל",
    );
    fireEvent.click(screen.getByRole("button", { name: "נסה שוב" }));
    expect(io.favoriteWrite).toHaveBeenCalledTimes(1);
  });

  it("reconciles an ambiguous removal with a read and never retries the write", async () => {
    io.favoriteWrite.mockResolvedValueOnce({
      data: null,
      error: { message: "Failed to fetch" },
      status: 0,
    });
    let preferenceReads = 0;
    io.read.mockImplementation((table, operations) => {
      if (table !== "client_character_preferences") return defaultRead(table, operations);
      preferenceReads += 1;
      return Promise.resolve({ data: preferenceReads === 1 ? [preference] : [], error: null });
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "הסר ממועדפים" }));
    expect(await screen.findByText("אין דמויות במועדפים עדיין")).toBeInTheDocument();
    expect(io.favoriteWrite).toHaveBeenCalledTimes(1);
    expect(io.error).not.toHaveBeenCalledWith(expect.stringContaining("הצלחה"));
  });

  it("rolls back an explicit failed removal only into the captured identity cache", async () => {
    io.favoriteWrite.mockResolvedValueOnce({
      data: null,
      error: { message: "permission denied", code: "42501" },
      status: 403,
    });
    const view = mount();
    fireEvent.click(await screen.findByRole("button", { name: "הסר ממועדפים" }));
    await waitFor(() => expect(io.error).toHaveBeenCalled());
    expect(screen.getByRole("heading", { name: "מאיה" })).toBeInTheDocument();

    const cacheA = view.client.getQueryData<Array<{ id: string }>>(["favorites", ids.clientA, 0]);
    expect(cacheA?.map((item) => item.id)).toEqual([ids.characterA]);
    expect(view.client.getQueryData(["favorites", ids.clientB, 0])).toBeUndefined();
  });

  it("does not roll back or toast an old removal after logout", async () => {
    const pending = deferred<Reply>();
    io.favoriteWrite.mockReturnValue(pending.promise);
    const view = mount();
    fireEvent.click(await screen.findByRole("button", { name: "הסר ממועדפים" }));
    await waitFor(() => expect(io.favoriteWrite).toHaveBeenCalledTimes(1));
    expect(view.client.getQueryData<Array<{ id: string }>>(["favorites", ids.clientA, 0])).toEqual(
      [],
    );

    io.auth.userId = io.auth.sessionUserId = null;
    view.rerenderPage();
    await act(async () =>
      pending.resolve({ data: null, error: { message: "late failure" }, status: 500 }),
    );

    expect(view.client.getQueryData<Array<{ id: string }>>(["favorites", ids.clientA, 0])).toEqual(
      [],
    );
    expect(io.error).not.toHaveBeenCalled();
  });

  it("validates conversation ids, blocks same-tick double click and ignores late completion after logout", async () => {
    const pending = deferred<Reply>();
    io.conversationWrite.mockReturnValue(pending.promise);
    const view = mount();
    const start = await screen.findByRole("button", { name: "המשך שיחה" });
    fireEvent.click(start);
    fireEvent.click(start);
    expect(io.conversationWrite).toHaveBeenCalledTimes(1);
    io.auth.userId = io.auth.sessionUserId = null;
    view.rerenderPage();
    await act(async () => pending.resolve({ data: ids.conversation, error: null }));
    expect(io.navigate).not.toHaveBeenCalled();
    expect(io.error).not.toHaveBeenCalled();

    Object.assign(io.auth, { userId: ids.clientA, sessionUserId: ids.clientA });
    io.conversationWrite.mockResolvedValueOnce({ data: 42, error: null });
    view.rerenderPage();
    fireEvent.click(await screen.findByRole("button", { name: "המשך שיחה" }));
    await waitFor(() => expect(io.error).toHaveBeenCalled());
    expect(io.navigate).not.toHaveBeenCalled();
  });
});
