import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  userId: "user-a" as string | undefined,
  accessCallback: null as null | (() => void),
  subscriptionCallback: null as null | ((status: string) => void),
  contextAllowed: true,
  contextFieldsAvailable: true,
  contextCall: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: unknown }) => options,
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: state.userId ? { id: state.userId } : null }),
}));

vi.mock("@/components/operator/OperatorLayout", () => ({
  ConversationStatusBadge: () => <span>פתוחה</span>,
  useOperator: () => ({
    isAdmin: false,
    operator: { id: "operator-a" },
    walletBalance: 0,
  }),
}));

vi.mock("@/lib/readStates", () => ({
  fetchUnreadCounts: vi.fn(async () => new Map()),
  logSupabaseError: vi.fn(),
}));

vi.mock("@/lib/slaMonitoring", () => ({
  fetchSlaRiskConversations: vi.fn(async () => []),
}));

type Result = { data: unknown; error: null };
type Query = {
  eq: (...args: unknown[]) => Query;
  in: (...args: unknown[]) => Query;
  limit: (...args: unknown[]) => Query;
  order: (...args: unknown[]) => Query;
  select: (...args: unknown[]) => Query;
  then: <TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) => PromiseLike<TResult1 | TResult2>;
};

function resultFor(table: string): Result {
  if (table === "character_operator_assignments") {
    return { data: [{ character_id: "character-a" }], error: null };
  }
  if (table === "conversations") {
    return {
      data: [
        {
          id: "conversation-a",
          status: "open",
          last_message_at: "2026-10-19T00:00:00Z",
          last_message_preview: "Sensitive preview",
          operator_unread_count: 0,
          client_id: "client-a",
          characters: { id: "character-a", name: "Character A", avatar_url: null },
        },
      ],
      error: null,
    };
  }
  if (table === "profiles") {
    return {
      data: [{ user_id: "client-a", display_name: "Sensitive Client", avatar_url: null }],
      error: null,
    };
  }
  return { data: [], error: null };
}

function queryFor(table: string): Query {
  const query = {} as Query;
  Object.assign(query, {
    eq: () => query,
    in: () => query,
    limit: () => query,
    order: () => query,
    select: () => query,
    then: <TResult1 = Result, TResult2 = never>(
      resolve?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
      reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => Promise.resolve(resultFor(table)).then(resolve, reject),
  });
  return query;
}

const channel = {
  on: vi.fn((_kind: string, filter: { table?: string }, callback: () => void) => {
    if (filter.table === "user_conversation_access_versions") state.accessCallback = callback;
    return channel;
  }),
  subscribe: vi.fn((callback?: (status: string) => void) => {
    state.subscriptionCallback = callback ?? null;
    return channel;
  }),
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    channel: vi.fn(() => channel),
    from: vi.fn((table: string) => queryFor(table)),
    rpc: state.contextCall,
    removeChannel: vi.fn(),
  },
}));

import { OperatorConversationsPage } from "@/routes/operator.conversations";

beforeEach(() => {
  state.userId = "user-a";
  state.accessCallback = null;
  state.subscriptionCallback = null;
  state.contextAllowed = true;
  state.contextFieldsAvailable = true;
  state.contextCall.mockReset().mockImplementation(async () => ({
    data: state.contextAllowed
      ? [
          {
            conversation_id: "conversation-a",
            client_age: state.contextFieldsAvailable ? 29 : null,
            client_city: state.contextFieldsAvailable ? "Sensitive City" : null,
            under_other_operator: false,
          },
        ]
      : [],
    error: null,
  }));
  channel.on.mockClear();
  channel.subscribe.mockClear();
});

describe("operator conversation list access lifecycle", () => {
  it("hides the whole row if authority is lost between list and context reads", async () => {
    state.contextAllowed = false;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <OperatorConversationsPage />
      </QueryClientProvider>,
    );
    act(() => state.subscriptionCallback?.("SUBSCRIBED"));
    expect(await screen.findByText("אין שיחות")).toBeInTheDocument();
    expect(screen.queryByText("Sensitive preview")).not.toBeInTheDocument();
    expect(state.contextCall).toHaveBeenCalledWith("get_operator_online_context", {
      _conversation_ids: ["conversation-a"],
    });
  });

  it("clears cached age and city when the access version changes", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <OperatorConversationsPage />
      </QueryClientProvider>,
    );
    act(() => state.subscriptionCallback?.("SUBSCRIBED"));
    await screen.findByText("Sensitive City");
    expect(screen.getByText("גיל 29")).toBeInTheDocument();

    state.contextFieldsAvailable = false;
    act(() => state.accessCallback?.());
    expect(screen.queryByText("Sensitive City")).not.toBeInTheDocument();
    await screen.findByText("Sensitive Client");
    expect(screen.queryByText("גיל 29")).not.toBeInTheDocument();
    const cache = queryClient.getQueriesData({ queryKey: ["operator-conversations", "user-a"] });
    expect(JSON.stringify(cache)).not.toContain("Sensitive City");
  });

  it("gates the user-bound cache on subscription health and clears it on failure/logout", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <OperatorConversationsPage />
      </QueryClientProvider>,
    );
    expect(screen.queryByText("Sensitive Client")).not.toBeInTheDocument();

    act(() => state.subscriptionCallback?.("SUBSCRIBED"));
    await screen.findByText("Sensitive Client");
    expect(
      queryClient.getQueryCache().findAll({ queryKey: ["operator-conversations", "user-a"] }),
    ).not.toHaveLength(0);

    act(() => state.subscriptionCallback?.("CHANNEL_ERROR"));
    await waitFor(() => expect(screen.queryByText("Sensitive Client")).not.toBeInTheDocument());
    expect(screen.getByText(/החיבור המאובטח נותק/)).toBeInTheDocument();
    expect(
      queryClient
        .getQueryCache()
        .findAll({ queryKey: ["operator-conversations", "user-a"] })
        .every((query) => query.state.data === undefined),
    ).toBe(true);

    state.userId = undefined;
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <OperatorConversationsPage />
      </QueryClientProvider>,
    );
    expect(
      queryClient
        .getQueryCache()
        .findAll({ queryKey: ["operator-conversations", "user-a"] })
        .every((query) => query.state.data === undefined),
    ).toBe(true);
  });
});
