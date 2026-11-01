import type { ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal(
  "ResizeObserver",
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

type TestChannel = {
  name: string;
  on: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
};

type TestOperator = {
  id: string;
  user_id: string;
  full_name: string;
  email: string;
  role: "admin" | "operator";
  is_active: boolean;
  availability_status: "available" | "busy" | "offline";
  created_at: string;
  deleted_at: string | null;
  chars: number;
  active: number;
  credit_balance: number;
};

const io = vi.hoisted(() => ({
  auth: {
    sessionUserId: "admin-a" as string | null,
    userId: "admin-a" as string | null,
    role: "admin" as "admin" | "operator" | "client" | null,
    loading: false,
  },
  listOperators: vi.fn(),
  updateOperator: vi.fn(),
  createOperator: vi.fn(),
  archiveOperator: vi.fn(),
  restoreOperator: vi.fn(),
  promoteOperator: vi.fn(),
  convertOperator: vi.fn(),
  createInvite: vi.fn(),
  resetPassword: vi.fn(),
  presence: vi.fn(),
  queue: vi.fn(),
  sla: vi.fn(),
  fetchPerformance: vi.fn(),
  channels: [] as TestChannel[],
  removeChannel: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (serverFn: unknown) => serverFn,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    session: io.auth.sessionUserId ? { user: { id: io.auth.sessionUserId } } : null,
    user: io.auth.userId ? { id: io.auth.userId } : null,
    role: io.auth.role,
    loading: io.auth.loading,
  }),
}));

vi.mock("@/lib/admin-operators.functions", () => ({
  adminListOperators: io.listOperators,
  adminUpdateOperator: io.updateOperator,
  adminCreateOperatorUser: io.createOperator,
  adminArchiveOperator: io.archiveOperator,
  adminRestoreOperator: io.restoreOperator,
  adminPromoteClientToOperator: io.promoteOperator,
  adminConvertOperatorToClient: io.convertOperator,
}));

vi.mock("@/lib/invites.functions", () => ({ adminCreateInvite: io.createInvite }));
vi.mock("@/lib/impersonation.functions", () => ({
  adminSendPasswordReset: io.resetPassword,
}));

vi.mock("@/lib/operatorPerformance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/operatorPerformance")>();
  return { ...actual, fetchOperatorPerformance: io.fetchPerformance };
});

vi.mock("sonner", () => ({
  toast: { success: io.toastSuccess, error: io.toastError },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (name: string) => {
      if (name === "get_admin_operator_presence_overview") return io.presence();
      if (name === "get_admin_new_queue_overview") return io.queue();
      if (name === "get_admin_new_sla_summary") return io.sla();
      throw new Error(`Unexpected RPC: ${name}`);
    },
    channel: (name: string) => {
      const channel = {
        name,
        on: vi.fn(),
        subscribe: vi.fn(),
      } as TestChannel;
      channel.on.mockReturnValue(channel);
      channel.subscribe.mockReturnValue(channel);
      io.channels.push(channel);
      return channel;
    },
    removeChannel: io.removeChannel,
    from: () => {
      throw new Error("Unexpected Supabase table read in this test");
    },
  },
}));

import { Route } from "@/routes/admin.operators";

const Page = (Route as unknown as { component: ComponentType }).component;

const operatorA: TestOperator = {
  id: "operator-a",
  user_id: "user-a",
  full_name: "עובד אלפא",
  email: "alpha@example.test",
  role: "operator" as const,
  is_active: true,
  availability_status: "available" as const,
  created_at: "2026-10-01T00:00:00Z",
  deleted_at: null,
  chars: 2,
  active: 1,
  credit_balance: 25,
};

const operatorB: TestOperator = {
  ...operatorA,
  id: "operator-b",
  user_id: "user-b",
  full_name: "עובד בטא",
  email: "beta@example.test",
  is_active: false,
  availability_status: "offline" as const,
  chars: 0,
  active: 0,
  credit_balance: 0,
};

const archivedOperator: TestOperator = {
  ...operatorA,
  id: "operator-archived",
  user_id: "user-archived",
  full_name: "עובד ארכיון",
  email: "archive@example.test",
  deleted_at: "2026-10-20T00:00:00Z",
};

const presenceA = {
  operator_id: operatorA.id,
  presence_status: "online" as const,
  last_seen_at: "2026-11-01T09:00:00Z",
  active_work_item_count: 2,
  eligible_new_queue_count: 3,
  stale_returned_count: 1,
  held_conversations: [],
};

const queueRows = [
  {
    character_id: "character-a",
    character_name: "מאיה",
    new_queue_count: 5,
    waiting_long_count: 2,
    returned_to_queue_count: 1,
  },
];

const slaRows = [
  {
    character_id: "character-a",
    character_name: "מאיה",
    total_new: 5,
    warning_count: 1,
    critical_count: 0,
    oldest_wait_seconds: 120,
    eligible_operator_count: 1,
  },
];

function makeSummary(operator: TestOperator = operatorA, overrides: Record<string, unknown> = {}) {
  const history = [{ month: "2026-10-01", monthLabel: "אוק׳ 26׳", points: 25, scoredMessages: 3 }];
  return {
    operator: {
      id: operator.id,
      full_name: operator.full_name,
      availability_status: operator.availability_status,
      is_active: operator.is_active,
    },
    currentMonthKey: "2026-10-01",
    availablePoints: operator.id === operatorA.id ? 25 : 73,
    currentPoints: 25,
    currentScoredMessages: 3,
    previousMonthPoints: 20,
    monthlyPointChange: 5,
    monthlyMessageChange: 1,
    avgResponseSec: 60,
    assignedCharacters: [],
    monthlyHistory: history,
    chartData: history.map(({ monthLabel, points, scoredMessages }) => ({
      month: monthLabel,
      points,
      scoredMessages,
    })),
    ...overrides,
  };
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

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Page />
    </QueryClientProvider>,
  );
  const rerender = () =>
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <Page />
      </QueryClientProvider>,
    );
  return { ...view, queryClient, rerender };
}

function operatorCard(name: string) {
  return screen.getByRole("article", { name });
}

beforeEach(() => {
  io.auth.sessionUserId = "admin-a";
  io.auth.userId = "admin-a";
  io.auth.role = "admin";
  io.auth.loading = false;
  io.listOperators
    .mockReset()
    .mockImplementation(({ data }: { data: { show_archived_only: boolean } }) =>
      Promise.resolve(data.show_archived_only ? [archivedOperator] : [operatorA, operatorB]),
    );
  io.updateOperator.mockReset().mockResolvedValue({});
  io.createOperator.mockReset().mockResolvedValue({});
  io.archiveOperator.mockReset().mockResolvedValue({});
  io.restoreOperator.mockReset().mockResolvedValue({});
  io.promoteOperator.mockReset().mockResolvedValue({});
  io.convertOperator.mockReset().mockResolvedValue({});
  io.createInvite.mockReset().mockResolvedValue({ token: "token" });
  io.resetPassword.mockReset().mockResolvedValue({});
  io.presence.mockReset().mockResolvedValue({ data: [presenceA], error: null });
  io.queue.mockReset().mockResolvedValue({ data: queueRows, error: null });
  io.sla.mockReset().mockResolvedValue({ data: slaRows, error: null });
  io.fetchPerformance
    .mockReset()
    .mockImplementation((operatorId: string) =>
      Promise.resolve(makeSummary(operatorId === operatorA.id ? operatorA : operatorB)),
    );
  io.channels.length = 0;
  io.removeChannel.mockReset().mockResolvedValue(undefined);
  io.toastSuccess.mockReset();
  io.toastError.mockReset();
});

describe("admin operator workspace", () => {
  it("waits for a matching initialized admin identity before starting reads or Realtime", async () => {
    io.auth.loading = true;
    const view = renderPage();

    expect(screen.getByRole("status")).toHaveTextContent("נדרש חיבור מנהל מאומת");
    expect(io.listOperators).not.toHaveBeenCalled();
    expect(io.presence).not.toHaveBeenCalled();
    expect(io.channels).toHaveLength(0);

    io.auth.loading = false;
    io.auth.role = "operator";
    view.rerender();
    expect(io.listOperators).not.toHaveBeenCalled();

    io.auth.role = "admin";
    io.auth.userId = "different-user";
    view.rerender();
    expect(io.listOperators).not.toHaveBeenCalled();

    io.auth.userId = "admin-a";
    view.rerender();
    expect(await screen.findByText(operatorA.full_name)).toBeInTheDocument();
    expect(io.listOperators).toHaveBeenCalledTimes(1);
    expect(io.channels).toHaveLength(1);
    expect(io.channels[0].name).toContain("admin-a");
  });

  it("searches the loaded list by name or email, filters activity, resets filters, and preserves archive mode", async () => {
    renderPage();
    await screen.findByText(operatorA.full_name);

    fireEvent.change(screen.getByRole("searchbox", { name: "חיפוש לפי שם או אימייל" }), {
      target: { value: "beta@example.test" },
    });
    expect(screen.queryByText(operatorA.full_name)).not.toBeInTheDocument();
    expect(screen.getByText(operatorB.full_name)).toBeInTheDocument();
    expect(screen.getByText("1 מתוך 2 עובדים ברשימה שנטענה")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "לא פעילים" }));
    expect(screen.getByText(operatorB.full_name)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "חיפוש לפי שם או אימייל" }), {
      target: { value: "לא קיים" },
    });
    expect(screen.getByText("לא נמצאו עובדים התואמים למסננים")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "איפוס מסננים" }));
    expect(screen.getByText(operatorA.full_name)).toBeInTheDocument();
    expect(screen.getByText(operatorB.full_name)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "הצג עובדים שנמחקו בלבד" }));
    expect(await screen.findByText(archivedOperator.full_name)).toBeInTheDocument();
    expect(io.listOperators).toHaveBeenLastCalledWith({ data: { show_archived_only: true } });
  });

  it("distinguishes a true empty list from filtered no-results", async () => {
    io.listOperators.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText("אין עובדים עדיין")).toBeInTheDocument();
    expect(screen.queryByText("לא נמצאו עובדים התואמים למסננים")).not.toBeInTheDocument();
  });

  it("shows an initial list error and retries the same identity-scoped read", async () => {
    io.listOperators
      .mockRejectedValueOnce(new Error("private list failure"))
      .mockResolvedValueOnce([operatorA]);
    renderPage();

    const alert = await screen.findByRole("alert", { name: "שגיאת טעינת רשימת העובדים" });
    expect(alert).not.toHaveTextContent("private list failure");
    fireEvent.click(within(alert).getByRole("button", { name: "נסה לטעון שוב" }));
    expect(await screen.findByText(operatorA.full_name)).toBeInTheDocument();
    expect(io.listOperators).toHaveBeenCalledTimes(2);
  });

  it("keeps cached operators visible across a failed refetch and clears the warning after recovery", async () => {
    io.listOperators
      .mockResolvedValueOnce([operatorA])
      .mockRejectedValueOnce(new Error("refresh detail"))
      .mockResolvedValueOnce([{ ...operatorA, full_name: "עובד אלפא מעודכן" }]);
    const { queryClient } = renderPage();
    await screen.findByText(operatorA.full_name);

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin-operators"] });
    });
    const alert = await screen.findByRole("alert", { name: "שגיאת רענון רשימת העובדים" });
    expect(screen.getByText(operatorA.full_name)).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "נסה לרענן שוב" }));

    expect(await screen.findByText("עובד אלפא מעודכן")).toBeInTheDocument();
    expect(
      screen.queryByRole("alert", { name: "שגיאת רענון רשימת העובדים" }),
    ).not.toBeInTheDocument();
  });

  it("keeps healthy monitoring sources visible when one RPC fails", async () => {
    io.presence.mockResolvedValue({ data: null, error: new Error("presence denied") });
    renderPage();

    expect(
      await screen.findByRole("alert", { name: "שגיאת טעינת נוכחות עובדים" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("פניות NEW: 5")).toBeInTheDocument();
    expect(screen.getByLabelText("אזהרת SLA: 1")).toBeInTheDocument();
    expect(screen.queryByText("presence denied")).not.toBeInTheDocument();
  });

  it("treats a missing presence row as unavailable instead of offline or zero", async () => {
    io.presence.mockResolvedValue({ data: [], error: null });
    renderPage();
    await screen.findByText(operatorA.full_name);

    const card = operatorCard(operatorA.full_name);
    expect(within(card).getByText("ניטור לא זמין")).toBeInTheDocument();
    expect(within(card).queryByText("מנותק")).not.toBeInTheDocument();
    expect(within(card).queryByText("0 בטיפול")).not.toBeInTheDocument();

    fireEvent.click(
      within(card).getByRole("button", { name: `ניטור עובד: ${operatorA.full_name}` }),
    );
    expect(await screen.findByText("נתוני נוכחות העובד אינם זמינים.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "נסה לטעון נוכחות שוב" })).toBeEnabled();
  });

  it("keeps cached presence visible after a background failure and retries only that source", async () => {
    io.presence
      .mockResolvedValueOnce({ data: [presenceA], error: null })
      .mockResolvedValueOnce({ data: null, error: new Error("refresh presence") })
      .mockResolvedValueOnce({
        data: [{ ...presenceA, active_work_item_count: 4 }],
        error: null,
      });
    const { queryClient } = renderPage();
    await screen.findByText(operatorA.full_name);

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin-operator-presence-overview"] });
    });
    const alert = await screen.findByRole("alert", { name: "שגיאת רענון נוכחות עובדים" });
    expect(within(operatorCard(operatorA.full_name)).getByText("2 בטיפול")).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "נסה לרענן נוכחות שוב" }));
    expect(
      await within(operatorCard(operatorA.full_name)).findByText("4 בטיפול"),
    ).toBeInTheDocument();
  });

  it("distinguishes missing, empty, and failed performance reads and supports retry", async () => {
    io.fetchPerformance
      .mockResolvedValueOnce(makeSummary(operatorA, { operator: null }))
      .mockRejectedValueOnce(new Error("private performance failure"))
      .mockResolvedValueOnce(
        makeSummary(operatorB, {
          availablePoints: 0,
          monthlyHistory: [],
          chartData: [],
        }),
      );
    renderPage();
    await screen.findByText(operatorA.full_name);

    fireEvent.click(
      within(operatorCard(operatorA.full_name)).getByRole("button", {
        name: `ביצועי עובד: ${operatorA.full_name}`,
      }),
    );
    expect(await screen.findByText("לא נמצאו נתוני עובד עבור העובד שנבחר.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "סגור" }));

    fireEvent.click(
      within(operatorCard(operatorB.full_name)).getByRole("button", {
        name: `ביצועי עובד: ${operatorB.full_name}`,
      }),
    );
    const alert = await screen.findByRole("alert", { name: "שגיאת טעינת ביצועי עובד" });
    expect(alert).not.toHaveTextContent("private performance failure");
    fireEvent.click(within(alert).getByRole("button", { name: "נסה לטעון שוב" }));
    expect(await screen.findByText("קרדיטים זמינים")).toBeInTheDocument();
    expect(screen.getAllByText("אין עדיין נתוני ביצועים")).toHaveLength(2);
  });

  it("does not show operator A while B is selected or after A resolves late", async () => {
    const responseA = deferred<ReturnType<typeof makeSummary>>();
    io.fetchPerformance.mockImplementation((operatorId: string) =>
      operatorId === operatorA.id
        ? responseA.promise
        : Promise.resolve(makeSummary(operatorB, { availablePoints: 73 })),
    );
    renderPage();
    await screen.findByText(operatorA.full_name);

    fireEvent.click(
      within(operatorCard(operatorA.full_name)).getByRole("button", {
        name: `ביצועי עובד: ${operatorA.full_name}`,
      }),
    );
    expect(screen.getByRole("status", { name: "טוען ביצועי עובד" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "סגור" }));
    fireEvent.click(
      within(operatorCard(operatorB.full_name)).getByRole("button", {
        name: `ביצועי עובד: ${operatorB.full_name}`,
      }),
    );
    expect(await screen.findByText("73")).toBeInTheDocument();

    await act(async () => responseA.resolve(makeSummary(operatorA, { availablePoints: 999 })));
    expect(screen.getByText("73")).toBeInTheDocument();
    expect(screen.queryByText("999")).not.toBeInTheDocument();
  });

  it("keeps cached performance visible after refresh failure and recovers with retry", async () => {
    io.fetchPerformance
      .mockResolvedValueOnce(makeSummary(operatorA, { availablePoints: 25 }))
      .mockRejectedValueOnce(new Error("refresh performance detail"))
      .mockResolvedValueOnce(makeSummary(operatorA, { availablePoints: 41 }));
    const { queryClient } = renderPage();
    await screen.findByText(operatorA.full_name);
    fireEvent.click(
      within(operatorCard(operatorA.full_name)).getByRole("button", {
        name: `ביצועי עובד: ${operatorA.full_name}`,
      }),
    );
    expect(await screen.findByText("קרדיטים זמינים")).toBeInTheDocument();
    expect(screen.getAllByText("25").length).toBeGreaterThan(0);

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin-operator-performance"] });
    });
    const alert = await screen.findByRole("alert", { name: "שגיאת רענון ביצועי עובד" });
    expect(screen.getAllByText("25").length).toBeGreaterThan(0);
    expect(alert).not.toHaveTextContent("refresh performance detail");
    fireEvent.click(within(alert).getByRole("button", { name: "נסה לרענן שוב" }));
    expect(await screen.findByText("41")).toBeInTheDocument();
  });

  it("hides old data and dialogs on logout, ignores late completion, and cleans Realtime", async () => {
    const latePresence = deferred<{ data: (typeof presenceA)[]; error: null }>();
    io.presence.mockReturnValueOnce(latePresence.promise);
    const view = renderPage();
    await screen.findByText(operatorA.full_name);
    const channel = io.channels[0];

    fireEvent.click(
      within(operatorCard(operatorA.full_name)).getByRole("button", {
        name: `ביצועי עובד: ${operatorA.full_name}`,
      }),
    );
    await screen.findByText(`ביצועי עובד - ${operatorA.full_name}`);
    io.auth.sessionUserId = null;
    io.auth.userId = null;
    io.auth.role = null;
    view.rerender();

    expect(screen.getByRole("status")).toHaveTextContent("נדרש חיבור מנהל מאומת");
    expect(screen.queryByText(operatorA.full_name)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(io.removeChannel).toHaveBeenCalledWith(channel);
    await act(async () => latePresence.resolve({ data: [presenceA], error: null }));
    expect(screen.queryByText("2 בטיפול")).not.toBeInTheDocument();
  });

  it("preserves Realtime tables, invalidation prefixes, and the active-toggle payload", async () => {
    const { queryClient } = renderPage();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await screen.findByText(operatorA.full_name);
    const channel = io.channels[0];

    expect(channel.on).toHaveBeenCalledWith(
      "postgres_changes",
      expect.objectContaining({ event: "*", schema: "public", table: "credit_wallets" }),
      expect.any(Function),
    );
    expect(channel.on).toHaveBeenCalledWith(
      "postgres_changes",
      expect.objectContaining({ table: "conversation_work_items" }),
      expect.any(Function),
    );
    const workItemCall = channel.on.mock.calls.find(
      (call) => call[1]?.table === "conversation_work_items",
    );
    (workItemCall?.[2] as () => void)();
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["admin-operator-presence-overview"],
      }),
    );

    fireEvent.click(within(operatorCard(operatorA.full_name)).getByRole("switch"));
    await waitFor(() =>
      expect(io.updateOperator).toHaveBeenCalledWith({
        data: {
          operator_id: operatorA.id,
          full_name: operatorA.full_name,
          is_active: false,
          availability_status: "offline",
        },
      }),
    );
  });
});
