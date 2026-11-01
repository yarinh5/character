import type { ComponentType, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Reply<T> = { data: T; error: unknown; count?: number | null };
type QueryOperation = { name: string; args: unknown[] };

const snapshotRow = {
  generated_at: "2026-11-01T12:00:00.000Z",
  activity_window_started_at: "2026-10-31T12:00:00.000Z",
  new_total: 4,
  new_normal_count: 2,
  new_warning_count: 1,
  new_critical_count: 1,
  new_oldest_wait_seconds: 120,
  new_returned_count: 1,
  active_operator_count: 3,
  online_operator_count: 2,
  offline_operator_count: 1,
  active_handling_cycle_count: 2,
  outreach_sent_count: 7,
  outreach_replied_count: 5,
  open_client_report_count: 1,
  open_operator_report_count: 2,
  active_operator_client_block_count: 1,
  archived_client_count: 3,
  media_asset_total: 10,
  media_asset_available_count: 4,
  media_asset_reserved_count: 2,
  media_asset_sent_count: 2,
  media_asset_restored_count: 1,
  media_asset_disabled_count: 1,
  active_media_reservation_count: 2,
  active_media_tag_count: 3,
};

const dashboardAnalytics = {
  days: [{ date: "2026-11-01", conversations: 0, users: 0, messages: 0 }],
  avgResponseSec: 0,
  topOperators: [],
  topCharacters: [],
  totalCreditsSpent: 0,
  manualCreditsAdded: 0,
  clientMessages: 0,
  operatorMessages: 0,
  topOperatorsByAvailablePoints: [],
  lowBalanceUsers: [],
};

const recentConversation = {
  id: "conversation-a",
  status: "active",
  last_message_at: "2026-11-01T10:00:00Z",
  last_message_preview: "הודעה אחרונה",
  characters: { name: "מאיה", avatar_url: null },
  operators: { full_name: "עובד אלפא" },
};

const io = vi.hoisted(() => ({
  auth: {
    loading: false,
    role: "admin" as "admin" | "operator" | "client" | null,
    userId: "admin-a" as string | null,
    sessionUserId: "admin-a" as string | null,
  },
  readTable: vi.fn(),
  dashboardAnalytics: vi.fn(),
  snapshot: vi.fn(),
  channels: [] as Array<{
    name: string;
    callbacks: Array<() => void>;
    on: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  }>,
  removeChannel: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({
    children,
    to,
    params,
  }: {
    children: ReactNode;
    to: string;
    params?: Record<string, string>;
  }) => <a href={`${to}/${params?.conversationId ?? ""}`}>{children}</a>,
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (serverFn: unknown) => serverFn,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    loading: io.auth.loading,
    role: io.auth.role,
    user: io.auth.userId ? { id: io.auth.userId } : null,
    session: io.auth.sessionUserId ? { user: { id: io.auth.sessionUserId } } : null,
  }),
}));

vi.mock("@/lib/analytics.functions", () => ({
  adminAnalytics: io.dashboardAnalytics,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const operations: QueryOperation[] = [];
      let execution: Promise<unknown> | null = null;
      const execute = () => {
        execution ??= Promise.resolve().then(() => io.readTable(table, operations));
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
        gte: (...args: unknown[]) => {
          operations.push({ name: "gte", args });
          return query;
        },
        order: (...args: unknown[]) => {
          operations.push({ name: "order", args });
          return query;
        },
        limit: (...args: unknown[]) => {
          operations.push({ name: "limit", args });
          return query;
        },
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          execute().then(resolve, reject),
      };
      return query;
    },
    rpc: (name: string) => {
      if (name !== "get_admin_operations_snapshot") throw new Error(`Unexpected RPC: ${name}`);
      return io.snapshot();
    },
    channel: (name: string) => {
      const callbacks: Array<() => void> = [];
      const channel = {
        name,
        callbacks,
        on: vi.fn((_kind, _filter, callback: () => void) => {
          callbacks.push(callback);
          return channel;
        }),
        subscribe: vi.fn(() => channel),
      };
      io.channels.push(channel);
      return channel;
    },
    removeChannel: io.removeChannel,
  },
}));

import { Route } from "@/routes/admin.index";

const Page = (Route as unknown as { component: ComponentType }).component;

function defaultTableReply(table: string): Reply<unknown> {
  if (table === "user_roles") return { data: null, error: null, count: 12 };
  if (table === "profiles") return { data: null, error: null, count: 2 };
  if (table === "characters") return { data: null, error: null, count: 5 };
  if (table === "conversations") return { data: [recentConversation], error: null };
  throw new Error(`Unexpected table: ${table}`);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
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
  const rerenderAuth = () =>
    view.rerender(
      <QueryClientProvider client={client}>
        <Page />
      </QueryClientProvider>,
    );
  return { ...view, client, rerenderAuth };
}

beforeEach(() => {
  io.auth.loading = false;
  io.auth.role = "admin";
  io.auth.userId = "admin-a";
  io.auth.sessionUserId = "admin-a";
  io.readTable.mockReset().mockImplementation(defaultTableReply);
  io.dashboardAnalytics.mockReset().mockResolvedValue(dashboardAnalytics);
  io.snapshot.mockReset().mockResolvedValue({ data: [snapshotRow], error: null });
  io.channels.length = 0;
  io.removeChannel.mockReset().mockResolvedValue(undefined);
});

describe("admin dashboard read states", () => {
  it("waits for a matching initialized admin identity before reads and Realtime", async () => {
    io.auth.loading = true;
    const view = mount();
    expect(screen.getByRole("status")).toHaveTextContent("נדרש חיבור מנהל מאומת");
    expect(io.readTable).not.toHaveBeenCalled();
    expect(io.dashboardAnalytics).not.toHaveBeenCalled();
    expect(io.snapshot).not.toHaveBeenCalled();
    expect(io.channels).toHaveLength(0);

    io.auth.loading = false;
    io.auth.role = "operator";
    view.rerenderAuth();
    expect(io.readTable).not.toHaveBeenCalled();

    io.auth.role = "admin";
    io.auth.sessionUserId = "different-admin";
    view.rerenderAuth();
    expect(io.readTable).not.toHaveBeenCalled();

    io.auth.sessionUserId = "admin-a";
    view.rerenderAuth();
    expect(await screen.findByText("מאיה")).toBeInTheDocument();
    expect(io.channels).toHaveLength(1);
    expect(io.channels[0].name).toContain("admin-a");
  });

  it("keeps healthy sources visible when one admin-stats read fails and retries without fake zeroes", async () => {
    let profileAttempt = 0;
    io.readTable.mockImplementation((table: string, operations: QueryOperation[]) => {
      if (table === "user_roles") {
        expect(operations).toContainEqual({ name: "eq", args: ["role", "client"] });
      }
      if (table === "profiles" && profileAttempt++ === 0) {
        expect(operations.some((operation) => operation.name === "gte")).toBe(true);
        return { data: null, error: new Error("private profile failure"), count: null };
      }
      if (table === "characters") {
        expect(operations).toContainEqual({ name: "eq", args: ["is_active", true] });
      }
      if (table === "conversations") {
        expect(operations).toEqual(
          expect.arrayContaining([
            { name: "order", args: ["last_message_at", { ascending: false, nullsFirst: false }] },
            { name: "limit", args: [8] },
          ]),
        );
      }
      return defaultTableReply(table);
    });
    mount();

    const alert = await screen.findByRole("alert", { name: "שגיאת טעינת נתוני הדשבורד" });
    expect(alert).not.toHaveTextContent("private profile failure");
    expect(screen.getByText("קרדיטים שנצרכו")).toBeInTheDocument();
    expect(screen.getByText("מצב תפעולי")).toBeInTheDocument();
    expect(screen.queryByText("אין שיחות עדיין")).not.toBeInTheDocument();
    expect(screen.getByText("פרופילים שנוצרו היום").closest("div.rounded-xl")).toHaveTextContent(
      "—",
    );

    fireEvent.click(within(alert).getByRole("button", { name: "נסה לטעון שוב" }));
    expect(await screen.findByText("מאיה")).toBeInTheDocument();
    const profilesCard = screen.getByText("פרופילים שנוצרו היום").closest("div.rounded-xl");
    expect(profilesCard).not.toBeNull();
    expect(within(profilesCard as HTMLElement).getByText("2")).toBeInTheDocument();
  });

  it("keeps cached stats visible after a refresh failure and clears one warning after retry", async () => {
    let failProfiles = false;
    io.readTable.mockImplementation((table: string) => {
      if (table === "profiles" && failProfiles) {
        return { data: null, error: new Error("refresh failed"), count: null };
      }
      return defaultTableReply(table);
    });
    const { client } = mount();
    expect(await screen.findByText("מאיה")).toBeInTheDocument();

    failProfiles = true;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["admin-stats", "admin-a"] });
    });
    const warning = await screen.findByRole("alert", { name: "שגיאת רענון נתוני הדשבורד" });
    expect(screen.getByText("מאיה")).toBeInTheDocument();
    failProfiles = false;
    fireEvent.click(within(warning).getByRole("button", { name: "נסה לרענן שוב" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("alert", { name: "שגיאת רענון נתוני הדשבורד" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("separates analytics failure from stats and retries only analytics", async () => {
    io.dashboardAnalytics
      .mockRejectedValueOnce(new Error("private analytics failure"))
      .mockResolvedValueOnce(dashboardAnalytics);
    mount();
    expect(await screen.findByText("מאיה")).toBeInTheDocument();
    const alert = await screen.findByRole("alert", { name: "שגיאת טעינת מדדי האנליטיקה" });
    expect(alert).not.toHaveTextContent("private analytics failure");
    fireEvent.click(within(alert).getByRole("button", { name: "נסה לטעון אנליטיקה שוב" }));
    await waitFor(() => expect(io.dashboardAnalytics).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("לקוחות עם יתרה נמוכה")).toBeInTheDocument();
  });

  it("rejects malformed dashboard analytics without replacing verified stats", async () => {
    io.dashboardAnalytics.mockResolvedValueOnce({
      ...dashboardAnalytics,
      totalCreditsSpent: Number.NaN,
    });
    mount();
    expect(await screen.findByText("מאיה")).toBeInTheDocument();
    expect(
      await screen.findByRole("alert", { name: "שגיאת טעינת מדדי האנליטיקה" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("NaN")).not.toBeInTheDocument();
  });

  it("does not show admin A cache or late completions after admin B takes over", async () => {
    const lateA = deferred<Reply<unknown>>();
    let clientsRead = 0;
    io.readTable.mockImplementation((table: string) => {
      if (table === "user_roles" && clientsRead++ === 0) return lateA.promise;
      if (table === "conversations") {
        return {
          data: [
            {
              ...recentConversation,
              id: "conversation-b",
              characters: { name: "נועה", avatar_url: null },
            },
          ],
          error: null,
        };
      }
      return defaultTableReply(table);
    });
    const view = mount();
    await waitFor(() => expect(io.readTable).toHaveBeenCalled());
    io.auth.userId = io.auth.sessionUserId = "admin-b";
    view.rerenderAuth();
    expect(await screen.findByText("נועה")).toBeInTheDocument();
    expect(screen.queryByText("מאיה")).not.toBeInTheDocument();
    const readsBeforeStaleCallback = io.readTable.mock.calls.length;
    io.channels[0].callbacks.forEach((callback) => callback());
    await act(async () => Promise.resolve());
    expect(io.readTable).toHaveBeenCalledTimes(readsBeforeStaleCallback);
    await act(async () => lateA.resolve({ data: null, error: null, count: 99 }));
    expect(screen.queryByText("99")).not.toBeInTheDocument();
    expect(io.removeChannel).toHaveBeenCalled();

    io.auth.userId = io.auth.sessionUserId = null;
    view.rerenderAuth();
    expect(screen.getByRole("status")).toHaveTextContent("נדרש חיבור מנהל מאומת");
    expect(screen.queryByText("נועה")).not.toBeInTheDocument();
  });

  it("shows verified zeroes without positive chart activity and uses source-accurate labels", async () => {
    io.readTable.mockImplementation((table: string) => {
      if (table === "conversations") return { data: [], error: null };
      return { data: null, error: null, count: 0 };
    });
    mount();
    expect(await screen.findByText("אין שיחות עדיין")).toBeInTheDocument();
    expect(screen.getByText("פרופילים שנוצרו היום")).toBeInTheDocument();
    expect(screen.getByText("יתרות קרדיט היסטוריות לעובדים")).toBeInTheDocument();
    const zeroDay = screen.getByTitle("2026-11-01: 0 הודעות").firstElementChild;
    expect(zeroDay).toHaveStyle({ height: "0%" });
  });
});
