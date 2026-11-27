import { useSyncExternalStore } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Reply = { data: unknown; error: unknown };
const io = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  sessionId: "admin-a" as string | null,
  userId: "admin-a" as string | null,
  role: "admin",
  loading: false,
  reports: vi.fn<(args: { filter: string | null; start: number; end: number }) => Promise<Reply>>(),
  profiles: vi.fn<() => Promise<Reply>>(),
  workers: vi.fn<(args: unknown) => Promise<Reply>>(),
  update: vi.fn<(args: { _report_id: string; _status: string }) => Promise<Reply>>(),
  workerUpdate:
    vi.fn<
      (args: {
        _report_id: string;
        _expected_version: number;
        _status: string;
        _resolution_note: string;
        _global_action_note: string | null;
      }) => Promise<Reply>
    >(),
  block: vi.fn(),
  audit: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => {
    useSyncExternalStore(
      (notify) => {
        io.listeners.add(notify);
        return () => {
          io.listeners.delete(notify);
        };
      },
      () => [io.sessionId, io.userId, io.role].join(":"),
    );
    return {
      session: io.sessionId ? { user: { id: io.sessionId } } : null,
      user: io.userId ? { id: io.userId } : null,
      role: io.role,
      loading: io.loading,
    };
  },
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/admin-clients.functions", () => ({ adminSetClientStatus: io.block }));
vi.mock("@/lib/audit.functions", () => ({ adminListAuditLogs: io.audit }));
vi.mock("sonner", () => ({ toast: { success: io.success, error: io.error } }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => {
        if (table === "reports") {
          let filter: string | null = null;
          const builder = {
            order: () => builder,
            or: (value: string) => {
              filter = value;
              return builder;
            },
            range: (start: number, end: number) => io.reports({ filter, start, end }),
          };
          return builder;
        }
        return {
          in: () => {
            if (table !== "profiles") throw new Error("unexpected read");
            return io.profiles();
          },
        };
      },
    }),
    rpc: (name: string, args: { _report_id: string; _status: string }) => {
      if (name === "get_admin_operator_client_reports_page") return io.workers(args);
      if (name === "admin_update_report_status") return io.update(args);
      if (name === "admin_update_operator_client_report")
        return io.workerUpdate(args as Parameters<typeof io.workerUpdate>[0]);
      throw new Error("unexpected RPC");
    },
  },
}));
import { Route } from "@/routes/admin.reports";
import { Route as AuditRoute } from "@/routes/admin.audit-logs";

const a = {
  id: "report-a",
  reason: "סיבה א",
  details: "פירוט ארוך\nשורה נוספת",
  status: "open",
  reporter_id: "reporter-a",
  conversation_id: "conversation-a",
  conversations: { characters: { name: "דמות א" } },
  created_at: "2026-10-01T10:00:00Z",
};
const b = { ...a, id: "report-b", reason: "סיבה ב", reporter_id: "reporter-b" };
const worker = {
  id: "worker-report",
  reason: "דיווח עובד",
  notes: "תוכן עובד",
  operator_name: "עובד א",
  client_display_name: "לקוח יעד",
  client_id: "target",
  source: "chat",
  conversation_id: null,
  created_at: a.created_at,
  status: "open",
  resolution_note: null,
  global_action_note: null,
  version: 1,
  updated_at: a.created_at,
  resolved_at: null,
  resolved_by: null,
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (v: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function mount() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const root = createRootRoute({ component: Outlet });
  const reports = createRoute({
    getParentRoute: () => root,
    path: "/admin/reports",
    component: Route.options.component,
  });
  const audit = createRoute({
    getParentRoute: () => root,
    path: "/admin/audit-logs",
    component: AuditRoute.options.component,
  });
  const router = createRouter({
    routeTree: root.addChildren([reports, audit]),
    history: createMemoryHistory({ initialEntries: ["/admin/reports"] }),
  });
  const element = () => (
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  const view = render(element());
  return {
    qc,
    router,
    ...view,
    rerenderAuth: () =>
      act(() => {
        io.listeners.forEach((notify) => notify());
      }),
  };
}
async function open(reason = a.reason) {
  fireEvent.click(await screen.findByRole("button", { name: "פרטי דיווח " + reason }));
  await screen.findByRole("dialog");
}
async function select(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}
beforeAll(() => {
  window.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});
beforeEach(() => {
  vi.clearAllMocks();
  io.sessionId = io.userId = "admin-a";
  io.role = "admin";
  io.loading = false;
  io.reports.mockReset().mockResolvedValue({ data: [a, b], error: null });
  io.profiles.mockReset().mockResolvedValue({
    data: [
      { user_id: "reporter-a", display_name: "מדווח א", email: "a@example.test" },
      { user_id: "reporter-b", display_name: "מדווח ב", email: null },
    ],
    error: null,
  });
  io.workers.mockReset().mockResolvedValue({ data: [worker], error: null });
  io.update.mockReset().mockImplementation(async (args) => ({
    data: { report_id: args._report_id, status: args._status },
    error: null,
  }));
  io.workerUpdate.mockReset().mockImplementation(async (args) => ({
    data: { report_id: args._report_id, status: args._status, version: args._expected_version + 1 },
    error: null,
  }));
  io.block.mockReset().mockResolvedValue({ ok: true });
  io.audit.mockReset().mockResolvedValue({
    items: [
      {
        id: "event-a",
        action: "report.status_changed",
        entity_type: "report",
        entity_id: a.id,
        actor: null,
        metadata: { previous_status: "open", status: "resolved" },
        created_at: a.created_at,
      },
    ],
    nextCursor: null,
  });
});

describe("reports workspace", () => {
  it("offers a continuation for client and operator reports beyond the first page", async () => {
    const clientPage = Array.from({ length: 101 }, (_, index) => ({
      ...a,
      id: `00000000-0000-4000-8000-${String(101 - index).padStart(12, "0")}`,
      reason: `דיווח לקוח ${index}`,
    }));
    const workerPage = Array.from({ length: 101 }, (_, index) => ({
      ...worker,
      id: `00000000-0000-4000-8001-${String(101 - index).padStart(12, "0")}`,
      reason: `דיווח עובד ${index}`,
    }));
    io.reports
      .mockResolvedValueOnce({ data: clientPage, error: null })
      .mockResolvedValueOnce({ data: [clientPage[100]], error: null });
    io.workers
      .mockResolvedValueOnce({ data: workerPage, error: null })
      .mockResolvedValueOnce({ data: [workerPage[100]], error: null });

    mount();
    const clients = await screen.findByRole("region", { name: "דיווחי לקוחות" });
    const operators = screen.getByRole("region", { name: "דיווחי עובדים" });
    expect(await within(clients).findByText("דיווח לקוח 0")).toBeInTheDocument();
    expect(await within(operators).findByText("דיווח עובד 0")).toBeInTheDocument();
    expect(within(clients).queryByText("דיווח לקוח 100")).not.toBeInTheDocument();
    expect(within(operators).queryByText("דיווח עובד 100")).not.toBeInTheDocument();
    await userEvent.click(within(clients).getByRole("button", { name: "טען עוד דיווחי לקוחות" }));
    await userEvent.click(within(operators).getByRole("button", { name: "טען עוד דיווחי עובדים" }));
    expect(await within(clients).findByText("דיווח לקוח 100")).toBeInTheDocument();
    expect(await within(operators).findByText("דיווח עובד 100")).toBeInTheDocument();
    expect(io.reports.mock.calls[1][0]).toEqual({
      filter: `created_at.lt.${a.created_at},and(created_at.eq.${a.created_at},id.lt.${clientPage[99].id})`,
      start: 0,
      end: 100,
    });
    expect(io.workers.mock.calls[1][0]).toEqual({
      _before_created_at: a.created_at,
      _before_id: workerPage[99].id,
      _page_size: 101,
    });
    expect(within(clients).getAllByText("דיווח לקוח 100")).toHaveLength(1);
    expect(within(operators).getAllByText("דיווח עובד 100")).toHaveLength(1);
  });

  it("keeps loaded reports and retries the same cursor after a later page fails", async () => {
    const firstPage = Array.from({ length: 101 }, (_, index) => ({
      ...a,
      id: `00000000-0000-4000-8000-${String(101 - index).padStart(12, "0")}`,
      reason: `דיווח לקוח ${index}`,
    }));
    io.reports
      .mockResolvedValueOnce({ data: firstPage, error: null })
      .mockRejectedValueOnce(new Error("page unavailable"))
      .mockResolvedValueOnce({ data: [firstPage[100]], error: null });
    mount();
    const clients = await screen.findByRole("region", { name: "דיווחי לקוחות" });
    expect(await within(clients).findByText("דיווח לקוח 0")).toBeInTheDocument();
    await userEvent.click(within(clients).getByRole("button", { name: "טען עוד דיווחי לקוחות" }));
    expect(await within(clients).findByRole("alert")).toHaveTextContent("רענון דיווחי לקוחות נכשל");
    expect(within(clients).getByText("דיווח לקוח 0")).toBeInTheDocument();
    expect(within(clients).queryByText("דיווח לקוח 100")).not.toBeInTheDocument();
    await userEvent.click(within(clients).getByRole("button", { name: "טען עוד דיווחי לקוחות" }));
    expect(await within(clients).findByText("דיווח לקוח 100")).toBeInTheDocument();
    expect(io.reports.mock.calls[1][0].filter).toBe(io.reports.mock.calls[2][0].filter);
  });

  it("supports keyboard cancellation and restores focus to the detail trigger", async () => {
    mount();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "חסום מדווח" }));
    expect(screen.getByRole("button", { name: "ביטול חסימה" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("group", { name: "אישור חסימת מדווח" })).not.toBeInTheDocument();
    expect(io.block).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "פרטי דיווח " + a.reason })).toHaveFocus(),
    );
  });
  it("keeps worker data during refresh, exposes failure, and recovers to empty", async () => {
    const pending = deferred<Reply>();
    io.workers
      .mockResolvedValueOnce({ data: [worker], error: null })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ data: [], error: null });
    mount();
    await screen.findByText(worker.reason);
    fireEvent.click(screen.getByRole("button", { name: "רענון: דיווחי עובדים" }));
    expect(await screen.findByText("מרענן דיווחי עובדים…")).toBeInTheDocument();
    expect(screen.getByText(worker.reason)).toBeInTheDocument();
    await act(async () => pending.reject(new Error("private")));
    expect(await screen.findByRole("alert")).toHaveTextContent("רענון דיווחי עובדים נכשל");
    expect(screen.getByText(worker.reason)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "נסה שוב: דיווחי עובדים" }));
    expect(await screen.findByText("אין דיווחי עובדים")).toBeInTheDocument();
  });

  it("filters client status and worker source independently", async () => {
    io.reports.mockResolvedValue({ data: [a, { ...b, status: "resolved" }], error: null });
    io.workers.mockResolvedValue({
      data: [worker, { ...worker, id: "worker-2", reason: "דיווח נוסף", source: "profile" }],
      error: null,
    });
    mount();
    await screen.findByText(a.reason);
    expect(screen.queryByText(b.reason)).not.toBeInTheDocument();
    await select("מסנן סטטוס", "טופל");
    expect(screen.getByText(b.reason)).toBeInTheDocument();
    expect(screen.queryByText(a.reason)).not.toBeInTheDocument();
    await select("מקור דיווח עובד", "profile");
    expect(screen.getByText("דיווח נוסף")).toBeInTheDocument();
    expect(screen.queryByText(worker.reason)).not.toBeInTheDocument();
    expect(io.update).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"])("suppresses late block %s after logout", async (outcome) => {
    const pending = deferred<{ ok: boolean }>();
    io.block.mockReturnValueOnce(pending.promise);
    const view = mount();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "חסום מדווח" }));
    fireEvent.click(screen.getByRole("button", { name: "אישור חסימת המדווח" }));
    io.sessionId = null;
    view.rerenderAuth();
    await screen.findByText("נדרש חיבור מנהל מאומת.");
    await act(async () => {
      if (outcome === "resolve") pending.resolve({ ok: true });
      else pending.reject(new Error("private"));
    });
    expect(io.success).not.toHaveBeenCalled();
    expect(io.error).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not link to a missing conversation even with a stale conversation ID", async () => {
    io.reports.mockResolvedValue({ data: [{ ...a, conversations: null }], error: null });
    mount();
    await open();
    expect(within(screen.getByRole("dialog")).getByText("שיחה אינה זמינה")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).queryByRole("link")).not.toBeInTheDocument();
  });

  it("completes loading, search, detail, confirmed status, refresh and audit navigation", async () => {
    const read = deferred<Reply>();
    io.reports.mockReturnValueOnce(read.promise);
    mount();
    expect(await screen.findByRole("status", { name: "טוען דיווחי לקוחות" })).toBeInTheDocument();
    await act(async () => read.resolve({ data: [a, b], error: null }));
    fireEvent.change(screen.getByRole("textbox", { name: "חיפוש בדיווחי לקוחות" }), {
      target: { value: a.reason },
    });
    await open();
    expect(screen.getByText(a.details, { normalizer: (value) => value })).toHaveClass(
      "whitespace-pre-wrap",
    );
    expect(screen.getByRole("link", { name: "מעבר לשיחה" })).toHaveAttribute(
      "href",
      "/admin/conversations/conversation-a",
    );
    await select("סטטוס הדיווח", "טופל");
    fireEvent.click(screen.getByRole("button", { name: "עדכון סטטוס" }));
    await waitFor(() => expect(io.success).toHaveBeenCalledWith("דיווח עודכן"));
    expect(io.update).toHaveBeenCalledWith({ _report_id: a.id, _status: "resolved" });
    await waitFor(() => expect(io.reports).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "סגירת פרטי הדיווח" }));
    fireEvent.click(screen.getByRole("link", { name: "עיון ביומן הפעולות" }));
    expect(
      await screen.findByText("שינוי סטטוס דיווח", { selector: "div.font-medium" }),
    ).toBeInTheDocument();
    expect(screen.getByText("סטטוס קודם")).toBeInTheDocument();
    expect(screen.getByText("report report-a")).toBeInTheDocument();
  });

  it.each(["reports", "workers"] as const)(
    "keeps the other source when %s fails and retries",
    async (key) => {
      io[key].mockRejectedValueOnce(new Error("private backend"));
      mount();
      expect(await screen.findByRole("alert")).not.toHaveTextContent("private backend");
      const other = key === "reports" ? "דיווחי עובדים" : "דיווחי לקוחות";
      expect(
        within(screen.getByRole("region", { name: other })).getByText(
          key === "reports" ? worker.reason : a.reason,
        ),
      ).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", {
          name: "נסה שוב: " + (key === "reports" ? "דיווחי לקוחות" : "דיווחי עובדים"),
        }),
      );
      await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    },
  );

  it("distinguishes profile enrichment failure from an absent profile and retries", async () => {
    io.profiles
      .mockResolvedValueOnce({ data: null, error: { message: "private" } })
      .mockResolvedValueOnce({ data: [], error: null });
    mount();
    await open();
    expect(
      await within(screen.getByRole("dialog")).findByText("לא ניתן לאמת פרטי מדווח", {
        exact: false,
        selector: "p",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "חסום מדווח" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "סגירת פרטי הדיווח" }));
    fireEvent.click(screen.getByRole("button", { name: "נסה שוב: פרטי מדווחים" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    await open();
    expect(screen.getByText(/מדווח: פרופיל המדווח אינו קיים/)).toBeInTheDocument();
  });

  it("preserves cached lists on refresh failure and distinguishes empty and no results", async () => {
    mount();
    await screen.findByText(a.reason);
    io.reports.mockRejectedValueOnce(new Error("private"));
    fireEvent.click(screen.getByRole("button", { name: "רענון: דיווחי לקוחות" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("המידע השמור לא עודכן");
    expect(screen.getByText(a.reason)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "חיפוש בדיווחי לקוחות" }), {
      target: { value: "לא נמצא" },
    });
    expect(screen.getByText("אין תוצאות במסנני הלקוחות")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "איפוס מסנני לקוחות" }));
    expect(screen.getByText(a.reason)).toBeInTheDocument();
    io.reports.mockResolvedValueOnce({ data: [], error: null });
    fireEvent.click(screen.getByRole("button", { name: "נסה שוב: דיווחי לקוחות" }));
    expect(await screen.findByText("אין דיווחי לקוחות")).toBeInTheDocument();
  });

  it.each([
    { data: null, error: { message: "private error" } },
    { data: { report_id: "wrong", status: "open" }, error: null },
    { data: { report_id: a.id, status: "resolved" }, error: null },
    { data: null, error: null },
  ])("rejects failed or malformed status response %# without success", async (reply) => {
    io.update.mockResolvedValueOnce(reply);
    mount();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "עדכון סטטוס" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("לא ניתן לאמת");
    expect(io.success).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "עדכון סטטוס" })).toBeEnabled();
  });

  it("handles thrown status failures and permits an explicit subsequent attempt", async () => {
    io.update.mockRejectedValueOnce(new Error("private"));
    mount();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "עדכון סטטוס" }));
    expect(await screen.findByRole("alert")).not.toHaveTextContent("private");
    expect(io.update).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "עדכון סטטוס" }));
    await waitFor(() => expect(io.success).toHaveBeenCalledTimes(1));
  });

  it.each([a.reason, b.reason])(
    "locks double submits and isolates a reopened dialog for %s",
    async (reason) => {
      const write = deferred<Reply>();
      io.update.mockReturnValueOnce(write.promise);
      mount();
      await open();
      await select("סטטוס הדיווח", "טופל");
      const button = screen.getByRole("button", { name: "עדכון סטטוס" });
      act(() => {
        fireEvent.click(button);
        fireEvent.click(button);
      });
      expect(io.update).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "חסום מדווח" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "סגירת פרטי הדיווח" }));
      await open(reason);
      if (reason === a.reason)
        expect(screen.getByRole("button", { name: "עדכון סטטוס" })).toBeDisabled();
      await act(async () =>
        write.resolve({ data: { report_id: a.id, status: "resolved" }, error: null }),
      );
      expect(screen.getByRole("combobox", { name: "סטטוס הדיווח" })).toHaveTextContent("פתוח");
      expect(io.success).not.toHaveBeenCalled();
    },
  );

  it("does not turn a confirmed write into failure when refresh fails", async () => {
    mount();
    await open();
    io.reports.mockRejectedValueOnce(new Error("refresh"));
    fireEvent.click(screen.getByRole("button", { name: "עדכון סטטוס" }));
    await waitFor(() => expect(io.success).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "סגירת פרטי הדיווח" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("רענון דיווחי לקוחות נכשל");
    expect(io.error).not.toHaveBeenCalled();
  });

  it("requires confirmation, supports cancel, and blocks exactly the reporter once", async () => {
    const write = deferred<{ ok: boolean }>();
    io.block.mockReturnValueOnce(write.promise);
    const view = mount();
    const invalidate = vi.spyOn(view.qc, "invalidateQueries");
    await open();
    fireEvent.click(screen.getByRole("button", { name: "חסום מדווח" }));
    expect(screen.getByRole("group", { name: "אישור חסימת מדווח" })).toHaveTextContent("מדווח א");
    expect(io.block).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "ביטול חסימה" }));
    expect(io.block).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "חסום מדווח" }));
    const button = screen.getByRole("button", { name: "אישור חסימת המדווח" });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(io.block).toHaveBeenCalledExactlyOnceWith({
      data: { user_id: "reporter-a", is_active: false },
    });
    await act(async () => write.resolve({ ok: true }));
    expect(io.success).toHaveBeenCalledWith("המדווח נחסם");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["audit-logs", "admin-a"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin-client-details", "reporter-a"] });
  });

  it.each([false, null, "throw"])(
    "reports ambiguous block outcome %s without automatic retry",
    async (kind) => {
      if (kind === "throw") io.block.mockRejectedValueOnce(new Error("private"));
      else io.block.mockResolvedValueOnce(kind === false ? { ok: false } : null);
      mount();
      await open();
      fireEvent.click(screen.getByRole("button", { name: "חסום מדווח" }));
      fireEvent.click(screen.getByRole("button", { name: "אישור חסימת המדווח" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("ייתכן שבוצע שינוי חלקי");
      expect(io.success).not.toHaveBeenCalled();
      expect(io.block).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "חסום מדווח" })).toBeEnabled();
    },
  );

  it.each(["mismatch", "logout", "role"])(
    "clears dialogs and suppresses late writes on %s",
    async (transition) => {
      const write = deferred<Reply>();
      io.update.mockReturnValueOnce(write.promise);
      const view = mount();
      await open();
      fireEvent.click(screen.getByRole("button", { name: "עדכון סטטוס" }));
      if (transition === "mismatch") io.sessionId = "admin-b";
      if (transition === "logout") io.sessionId = null;
      if (transition === "role") io.role = "client";
      view.rerenderAuth();
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(screen.queryByText(a.reason)).not.toBeInTheDocument();
      await act(async () =>
        write.resolve({ data: { report_id: a.id, status: "open" }, error: null }),
      );
      expect(io.success).not.toHaveBeenCalled();
      expect(io.error).not.toHaveBeenCalled();
      const count = io.reports.mock.calls.length;
      await act(async () => {
        await view.qc.invalidateQueries({ queryKey: ["admin-reports"] });
      });
      expect(io.reports).toHaveBeenCalledTimes(count);
    },
  );

  it("isolates late reads and resets filters for a new authenticated admin", async () => {
    const read = deferred<Reply>();
    io.reports.mockReturnValueOnce(read.promise);
    const view = mount();
    await screen.findByRole("status", { name: "טוען דיווחי לקוחות" });
    fireEvent.change(screen.getByRole("textbox", { name: "חיפוש בדיווחי לקוחות" }), {
      target: { value: "טיוטה" },
    });
    io.sessionId = "admin-b";
    view.rerenderAuth();
    await screen.findByText("נדרש חיבור מנהל מאומת.");
    await act(async () => read.resolve({ data: [a], error: null }));
    expect(screen.queryByText(a.reason)).not.toBeInTheDocument();
    io.userId = "admin-b";
    io.reports.mockResolvedValue({ data: [b], error: null });
    view.rerenderAuth();
    expect(await screen.findByText(b.reason)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "חיפוש בדיווחי לקוחות" })).toHaveValue("");
  });

  it("lets an admin record a decision and global action on an operator report", async () => {
    mount();
    await screen.findByText(worker.reason);
    const region = screen.getByRole("region", { name: "דיווחי עובדים" });
    expect(within(region).queryByRole("link")).not.toBeInTheDocument();
    fireEvent.click(within(region).getByRole("button", { name: "טיפול בדיווח עובד" }));
    await select("סטטוס דיווח עובד", "הוכרע");
    fireEvent.change(screen.getByRole("textbox", { name: "נימוק החלטה" }), {
      target: { value: "נבדק מול השיחה" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "פעולה גלובלית שבוצעה" }), {
      target: { value: "חסימה מנהלית" },
    });
    fireEvent.click(screen.getByRole("button", { name: "שמירת טיפול" }));
    await waitFor(() =>
      expect(io.workerUpdate).toHaveBeenCalledWith({
        _report_id: worker.id,
        _expected_version: 1,
        _status: "decided",
        _resolution_note: "נבדק מול השיחה",
        _global_action_note: "חסימה מנהלית",
      }),
    );
    expect(await screen.findByText("הטיפול בדיווח נשמר")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "שמירת טיפול" })).toBeEnabled());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.change(within(region).getByRole("textbox"), { target: { value: "לא נמצא" } });
    expect(within(region).getByText("אין תוצאות במסנני העובדים")).toBeInTheDocument();
    fireEvent.click(within(region).getByRole("button", { name: "איפוס מסנני עובדים" }));
    expect(within(region).getByText(worker.notes)).toBeInTheDocument();
  });

  it("does not claim an operator-report update succeeded without a matching server receipt", async () => {
    io.workerUpdate.mockResolvedValueOnce({
      data: { report_id: worker.id, status: "closed", version: 1 },
      error: null,
    });
    mount();
    await screen.findByText(worker.reason);
    fireEvent.click(screen.getByRole("button", { name: "טיפול בדיווח עובד" }));
    fireEvent.click(screen.getByRole("button", { name: "שמירת טיפול" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("לא ניתן לאמת");
    expect(io.success).not.toHaveBeenCalled();
    expect(io.workerUpdate).toHaveBeenCalledTimes(1);
  });

  it("suppresses late operator-report results after admin logout", async () => {
    const pending = deferred<Reply>();
    io.workerUpdate.mockReturnValueOnce(pending.promise);
    const view = mount();
    await screen.findByText(worker.reason);
    fireEvent.click(screen.getByRole("button", { name: "טיפול בדיווח עובד" }));
    fireEvent.click(screen.getByRole("button", { name: "שמירת טיפול" }));
    expect(screen.getByRole("button", { name: "שמירת טיפול" })).toBeDisabled();
    expect(io.workerUpdate).toHaveBeenCalledTimes(1);

    io.sessionId = null;
    view.rerenderAuth();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await act(async () =>
      pending.resolve({ data: { report_id: worker.id, status: "open", version: 2 }, error: null }),
    );
    expect(io.success).not.toHaveBeenCalled();
    expect(io.error).not.toHaveBeenCalled();
  });
});
