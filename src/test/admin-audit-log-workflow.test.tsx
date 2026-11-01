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
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  sessionId: "admin-a" as string | null,
  userId: "admin-a",
  role: "admin",
  list: vi.fn(),
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
      user: { id: io.userId },
      role: io.role,
      loading: false,
    };
  },
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/audit.functions", () => ({ adminListAuditLogs: io.list }));
import { Route } from "@/routes/admin.audit-logs";
const log = {
  id: "log-a",
  action: "report.status_changed",
  entity_type: "report",
  entity_id: "report-a",
  metadata: { previous_status: "open", status: "resolved" },
  actor: { display_name: "מנהל א", email: "a@example.test" },
  created_at: "2026-10-01T10:00:00Z",
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/admin/audit-logs",
    component: Route.options.component,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/admin/audit-logs"] }),
  });
  const element = () => (
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  const view = render(element());
  return {
    qc,
    ...view,
    rerenderAuth: () =>
      act(() => {
        io.listeners.forEach((notify) => notify());
      }),
  };
}
beforeAll(() => {
  window.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});
beforeEach(() => {
  io.sessionId = io.userId = "admin-a";
  io.role = "admin";
  io.list.mockReset().mockResolvedValue([log]);
});

describe("audit workflow", () => {
  it("shows loading, limited loaded count, explicit status metadata and unknown-action fallback", async () => {
    const pending = deferred<(typeof log)[]>();
    io.list.mockReturnValueOnce(pending.promise);
    mount();
    expect(await screen.findByRole("status", { name: "טוען יומן" })).toBeInTheDocument();
    await act(async () => pending.resolve([log, { ...log, id: "other", action: "legacy.event" }]));
    expect(await screen.findByText("legacy.event")).toBeInTheDocument();
    expect(screen.getByText("2 מתוך 2 רשומות שנטענו (מגבלה: 200)")).toBeInTheDocument();
    expect(screen.getByText(/היעדר תוצאה אינו מעיד/)).toBeInTheDocument();
    expect(screen.getAllByText("סטטוס קודם")).toHaveLength(2);
    expect(io.list).toHaveBeenCalledWith({ data: { limit: 200 } });
  });
  it("sends action filter to server and searches only loaded rows with reset", async () => {
    mount();
    await screen.findByText("מנהל א");
    const user = userEvent.setup();
    io.list.mockResolvedValueOnce([{ ...log, action: "client.status_changed" }]);
    await user.click(screen.getByRole("combobox", { name: "סוג פעולה" }));
    await user.click(await screen.findByRole("option", { name: "שינוי סטטוס לקוח" }));
    await waitFor(() =>
      expect(io.list).toHaveBeenLastCalledWith({
        data: { limit: 200, action: "client.status_changed" },
      }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "חיפוש ביומן שנטען" }), {
      target: { value: "אין כזה" },
    });
    expect(screen.getByText("אין תוצאות ברשומות שנטענו.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "איפוס מסנני יומן" }));
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(await screen.findByText("מנהל א")).toBeInTheDocument();
  });
  it("distinguishes initial failure from empty and retries", async () => {
    io.list.mockRejectedValueOnce(new Error("private backend")).mockResolvedValueOnce([]);
    mount();
    expect(await screen.findByRole("alert")).not.toHaveTextContent("private backend");
    expect(screen.queryByText("לא הוחזרו אירועים בקריאה זו.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "נסה לטעון יומן שוב" }));
    expect(await screen.findByText("לא הוחזרו אירועים בקריאה זו.")).toBeInTheDocument();
  });
  it("keeps cached rows through refresh and failure, then allows recovery", async () => {
    const refresh = deferred<(typeof log)[]>();
    io.list.mockResolvedValueOnce([log]).mockReturnValueOnce(refresh.promise);
    mount();
    await screen.findByText("מנהל א");
    fireEvent.click(screen.getByRole("button", { name: "רענון יומן" }));
    expect(await screen.findByRole("status")).toHaveTextContent("מרענן יומן");
    expect(screen.getByText("מנהל א")).toBeInTheDocument();
    await act(async () => refresh.reject(new Error("private")));
    expect(await screen.findByRole("alert")).toHaveTextContent("המידע השמור לא עודכן");
    fireEvent.click(screen.getByRole("button", { name: "נסה לטעון יומן שוב" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
  it.each(["mismatch", "logout", "role"])(
    "clears cached rows and local drafts on %s",
    async (transition) => {
      const view = mount();
      await screen.findByText("מנהל א");
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "מנהל" } });
      if (transition === "mismatch") io.sessionId = "admin-b";
      if (transition === "logout") io.sessionId = null;
      if (transition === "role") io.role = "operator";
      view.rerenderAuth();
      await screen.findByText("נדרש חיבור מנהל מאומת.");
      expect(screen.queryByText("מנהל א")).not.toBeInTheDocument();
      const count = io.list.mock.calls.length;
      await act(async () => {
        await view.qc.invalidateQueries({ queryKey: ["audit-logs"] });
      });
      expect(io.list).toHaveBeenCalledTimes(count);
      io.sessionId = io.userId = "admin-b";
      io.role = "admin";
      io.list.mockResolvedValue([]);
      view.rerenderAuth();
      expect(await screen.findByRole("textbox")).toHaveValue("");
      expect(await screen.findByText("לא הוחזרו אירועים בקריאה זו.")).toBeInTheDocument();
    },
  );
  it("ignores a late A read after B becomes current", async () => {
    const pending = deferred<(typeof log)[]>();
    io.list.mockReturnValueOnce(pending.promise);
    const view = mount();
    await screen.findByRole("status", { name: "טוען יומן" });
    io.sessionId = io.userId = "admin-b";
    io.list.mockResolvedValue([]);
    view.rerenderAuth();
    await screen.findByText("לא הוחזרו אירועים בקריאה זו.");
    await act(async () => pending.resolve([log]));
    expect(screen.queryByText("מנהל א")).not.toBeInTheDocument();
  });
});
