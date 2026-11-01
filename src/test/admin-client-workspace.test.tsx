import type { ComponentType, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const io = vi.hoisted(() => ({
  auth: {
    sessionUserId: "admin-a" as string | null,
    userId: "admin-a" as string | null,
    role: "admin" as string | null,
    loading: false,
  },
  list: vi.fn(),
  details: vi.fn(),
  update: vi.fn(),
  status: vi.fn(),
  credits: vi.fn(),
  archive: vi.fn(),
  pii: vi.fn(),
  restore: vi.fn(),
  promote: vi.fn(),
  reset: vi.fn(),
  navigate: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  clipboard: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
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
    <a href={params ? `${to}/${Object.values(params).join("/")}` : to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => io.navigate,
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    session: io.auth.sessionUserId ? { user: { id: io.auth.sessionUserId } } : null,
    user: io.auth.userId ? { id: io.auth.userId } : null,
    role: io.auth.role,
    loading: io.auth.loading,
  }),
}));
vi.mock("@/lib/admin-clients.functions", () => ({
  adminListClients: io.list,
  adminGetClientDetails: io.details,
  adminUpdateClient: io.update,
  adminSetClientStatus: io.status,
  adminAdjustClientCredits: io.credits,
  adminArchiveClient: io.archive,
  adminArchiveClientPii: io.pii,
  adminRestoreClient: io.restore,
}));
vi.mock("@/lib/admin-operators.functions", () => ({ adminPromoteClientToOperator: io.promote }));
vi.mock("@/lib/impersonation.functions", () => ({ adminSendPasswordReset: io.reset }));
vi.mock("sonner", () => ({ toast: { success: io.success, error: io.error } }));

import { Route } from "@/routes/admin.clients";
const Page = (Route as unknown as { component: ComponentType }).component;

const clientA = {
  user_id: "client-a",
  email: "alpha@example.test",
  display_name: "לקוחה אלפא",
  avatar_url: null,
  status: "active",
  pii_archived_at: null,
  created_at: "2026-10-01T00:00:00Z",
  deleted_at: null,
  credits_balance: 25,
  conversations_count: 2,
  active_conversations_count: 1,
  last_message_at: "2026-10-20T00:00:00Z",
};
const clientB = {
  ...clientA,
  user_id: "client-b",
  email: "beta@example.test",
  display_name: "לקוחה בטא",
  status: "blocked",
};
const archived = {
  ...clientA,
  user_id: "client-archived",
  email: "archive@example.test",
  display_name: "לקוח ארכיון",
  deleted_at: "2026-10-30T00:00:00Z",
};

function makeDetails(profile: typeof clientA | null = clientA) {
  return {
    profile,
    client_profile: profile
      ? { age: 31, gender: "אישה", interests: ["מוזיקה"], conversation_preferences: "שיחה רגועה" }
      : null,
    wallet: { balance: 25, lifetime_earned: 40, lifetime_spent: 15, updated_at: null },
    conversations: [
      {
        id: "conversation-a",
        status: "active",
        last_message_at: null,
        last_message_preview: "שלום",
        created_at: "2026-10-01T00:00:00Z",
        characters: { id: "character-a", name: "מאיה", avatar_url: null },
      },
    ],
    transactions: [
      {
        id: "tx-a",
        amount: 5,
        balance_after: 25,
        type: "manual",
        reason: "זיכוי",
        created_at: "2026-10-20T00:00:00Z",
      },
    ],
    timeline: [
      {
        id: "event-a",
        type: "signup" as const,
        title: "הרשמה הושלמה",
        description: null,
        created_at: "2026-10-01T00:00:00Z",
      },
    ],
    activity: { conversations_count: 2, client_messages_count: 8 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function qc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } },
  });
}
function mount(client = qc()) {
  const view = render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  );
  const rerender = () =>
    view.rerender(
      <QueryClientProvider client={client}>
        <Page />
      </QueryClientProvider>,
    );
  return { ...view, queryClient: client, rerender };
}

const confirmationCases = [
  {
    label: "archive",
    confirmName: "ארכב לקוח",
    busyName: "מאורכב...",
    successMessage: "הלקוח אורכב",
    request: () => io.archive,
    open: async () => {
      await screen.findByText(clientA.display_name);
      fireEvent.click(screen.getAllByTitle("ארכוב לקוח")[0]);
      return screen.findByRole("alertdialog");
    },
  },
  {
    label: "restore",
    confirmName: "שחזר לקוח",
    busyName: "משחזר...",
    successMessage: "הלקוח שוחזר לרשימה הרגילה כלא פעיל",
    request: () => io.restore,
    open: async () => {
      await screen.findByText(clientA.display_name);
      fireEvent.click(screen.getByRole("switch", { name: "הצג לקוחות שנמחקו בלבד" }));
      await screen.findByText(archived.display_name);
      fireEvent.click(screen.getByTitle("שחזור לקוח"));
      return screen.findByRole("alertdialog");
    },
  },
  {
    label: "promote",
    confirmName: "הפוך לעובד",
    busyName: "מעביר...",
    successMessage: "הלקוח הועבר לתפקיד עובד",
    request: () => io.promote,
    open: async () => {
      await screen.findByText(clientA.display_name);
      fireEvent.click(screen.getAllByTitle("פרטי לקוח")[0]);
      await screen.findByText("הרשמה הושלמה");
      fireEvent.click(screen.getByRole("button", { name: "הפוך לעובד" }));
      return screen.findByRole("alertdialog");
    },
  },
] as const;

beforeEach(() => {
  Object.assign(io.auth, {
    sessionUserId: "admin-a",
    userId: "admin-a",
    role: "admin",
    loading: false,
  });
  io.list
    .mockReset()
    .mockImplementation(({ data }: { data: { include_archived: boolean } }) =>
      Promise.resolve(data.include_archived ? [archived] : [clientA, clientB]),
    );
  io.details.mockReset().mockResolvedValue(makeDetails());
  for (const fn of [io.update, io.status, io.credits, io.archive, io.pii, io.restore, io.promote])
    fn.mockReset().mockResolvedValue({ ok: true });
  io.reset.mockReset().mockResolvedValue({ action_link: null });
  io.navigate.mockReset();
  io.success.mockReset();
  io.error.mockReset();
  io.clipboard.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: io.clipboard },
  });
});

describe("admin client workspace", () => {
  it.each(confirmationCases)(
    "$label confirmation stays mounted until success and then refreshes once",
    async ({ confirmName, busyName, successMessage, request, open }) => {
      const pending = deferred<{ ok: true }>();
      request().mockReturnValueOnce(pending.promise);
      mount();
      const dialog = await open();
      const listCallsBeforeMutation = io.list.mock.calls.length;

      fireEvent.click(within(dialog).getByRole("button", { name: confirmName }));

      expect(request()).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: busyName })).toBeDisabled();
      pending.resolve({ ok: true });
      await act(async () => pending.promise);

      await waitFor(() =>
        expect(io.list.mock.calls.length).toBeGreaterThan(listCallsBeforeMutation),
      );
      expect(io.success).toHaveBeenCalledWith(successMessage);
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    },
  );

  it.each(confirmationCases)(
    "$label confirmation reports failure and remains available for a manual retry",
    async ({ confirmName, request, open }) => {
      const pending = deferred<{ ok: true }>();
      request().mockReturnValueOnce(pending.promise);
      mount();
      const dialog = await open();
      const listCallsBeforeMutation = io.list.mock.calls.length;

      fireEvent.click(within(dialog).getByRole("button", { name: confirmName }));
      pending.reject(new Error("הפעולה נכשלה"));
      await act(async () => pending.promise.catch(() => undefined));

      expect(request()).toHaveBeenCalledTimes(1);
      expect(io.error).toHaveBeenCalledWith("הפעולה נכשלה");
      expect(io.list).toHaveBeenCalledTimes(listCallsBeforeMutation);
      expect(
        within(screen.getByRole("alertdialog")).getByRole("button", { name: confirmName }),
      ).toBeEnabled();
    },
  );

  it.each(confirmationCases)(
    "$label pending completion has no late side effects after logout",
    async ({ confirmName, request, open }) => {
      const pending = deferred<{ ok: true }>();
      request().mockReturnValueOnce(pending.promise);
      const view = mount();
      const dialog = await open();
      fireEvent.click(within(dialog).getByRole("button", { name: confirmName }));
      expect(request()).toHaveBeenCalledTimes(1);

      Object.assign(io.auth, { sessionUserId: null, userId: null, role: null });
      view.rerender();
      expect(screen.getByRole("status")).toHaveTextContent("נדרש חיבור מנהל מאומת");
      const listCallsAfterIdentityLoss = io.list.mock.calls.length;
      pending.resolve({ ok: true });
      await act(async () => pending.promise);

      expect(io.success).not.toHaveBeenCalled();
      expect(io.list).toHaveBeenCalledTimes(listCallsAfterIdentityLoss);
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    },
  );

  it.each(confirmationCases)(
    "$label pending completion has no late side effects after admin replacement",
    async ({ confirmName, request, open }) => {
      const pending = deferred<{ ok: true }>();
      request().mockReturnValueOnce(pending.promise);
      const view = mount();
      const dialog = await open();
      fireEvent.click(within(dialog).getByRole("button", { name: confirmName }));
      expect(request()).toHaveBeenCalledTimes(1);

      Object.assign(io.auth, { sessionUserId: "admin-b", userId: "admin-b", role: "admin" });
      const listCallsBeforeReplacement = io.list.mock.calls.length;
      view.rerender();
      await waitFor(() =>
        expect(io.list.mock.calls.length).toBeGreaterThan(listCallsBeforeReplacement),
      );
      const listCallsAfterReplacement = io.list.mock.calls.length;
      pending.resolve({ ok: true });
      await act(async () => pending.promise);

      expect(io.success).not.toHaveBeenCalled();
      expect(io.list).toHaveBeenCalledTimes(listCallsAfterReplacement);
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    },
  );

  it("waits for a matching admin and isolates admin B from a pending admin A read", async () => {
    io.auth.loading = true;
    const view = mount();
    expect(screen.getByRole("status")).toHaveTextContent("נדרש חיבור מנהל מאומת");
    expect(io.list).not.toHaveBeenCalled();
    io.auth.loading = false;
    io.auth.userId = "other";
    view.rerender();
    expect(io.list).not.toHaveBeenCalled();

    const pendingA = deferred<(typeof clientA)[]>();
    io.auth.userId = "admin-a";
    io.list.mockReturnValueOnce(pendingA.promise).mockResolvedValueOnce([clientB]);
    view.rerender();
    await waitFor(() => expect(io.list).toHaveBeenCalledTimes(1));
    io.auth.sessionUserId = "admin-b";
    io.auth.userId = "admin-b";
    view.rerender();
    expect(await screen.findByText(clientB.display_name)).toBeInTheDocument();
    fireEvent.click(screen.getAllByTitle("פרטי לקוח")[0]);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    io.auth.role = "operator";
    view.rerender();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("נדרש חיבור מנהל מאומת");
    expect(io.list).toHaveBeenCalledTimes(2);
    pendingA.resolve([clientA]);
    await act(async () => pendingA.promise);
    expect(screen.queryByText(clientA.display_name)).not.toBeInTheDocument();
  });

  it("distinguishes a true empty list from filtered no-results", async () => {
    io.list.mockResolvedValueOnce([]);
    mount();
    expect(await screen.findByText("אין לקוחות עדיין")).toBeInTheDocument();
    expect(screen.queryByText("לא נמצאו לקוחות התואמים למסננים")).not.toBeInTheDocument();
  });

  it("handles initial error, no-results reset, loaded count and archived-only semantics", async () => {
    io.list.mockRejectedValueOnce(new Error("private")).mockResolvedValueOnce([clientA, clientB]);
    mount();
    const alert = await screen.findByRole("alert", { name: "שגיאת טעינת רשימת הלקוחות" });
    expect(alert).not.toHaveTextContent("private");
    fireEvent.click(within(alert).getByRole("button", { name: "נסה לטעון שוב" }));
    await screen.findByText(clientA.display_name);
    fireEvent.change(screen.getByRole("searchbox", { name: "חיפוש לפי שם או אימייל" }), {
      target: { value: "לא קיים" },
    });
    expect(screen.getByText("לא נמצאו לקוחות התואמים למסננים")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "איפוס מסננים" }));
    expect(screen.getByText("2 מתוך 2 לקוחות ברשימה שנטענה")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "הצג לקוחות שנמחקו בלבד" }));
    expect(await screen.findByText(archived.display_name)).toBeInTheDocument();
    expect(io.list).toHaveBeenLastCalledWith({ data: { include_archived: true } });
  });

  it("keeps cached rows after refresh failure and clears one warning on retry", async () => {
    io.list
      .mockResolvedValueOnce([clientA])
      .mockRejectedValueOnce(new Error("refresh"))
      .mockResolvedValueOnce([{ ...clientA, display_name: "לקוחה מעודכנת" }]);
    const view = mount();
    await screen.findByText(clientA.display_name);
    await act(async () => {
      await view.queryClient.invalidateQueries({ queryKey: ["admin-clients"] });
    });
    const alert = await screen.findByRole("alert", { name: "שגיאת רענון רשימת הלקוחות" });
    expect(screen.getByText(clientA.display_name)).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "נסה לרענן שוב" }));
    expect(await screen.findByText("לקוחה מעודכנת")).toBeInTheDocument();
    expect(
      screen.queryByRole("alert", { name: "שגיאת רענון רשימת הלקוחות" }),
    ).not.toBeInTheDocument();
  });

  it("turns cached missing details plus refetch failure into retry and then shows activity", async () => {
    io.details
      .mockResolvedValueOnce(makeDetails(null))
      .mockRejectedValueOnce(new Error("refresh"))
      .mockResolvedValueOnce(makeDetails());
    const view = mount();
    await screen.findByText(clientA.display_name);
    fireEvent.click(screen.getAllByTitle("פרטי לקוח")[0]);
    expect(await screen.findByText("פרופיל הלקוח אינו זמין")).toBeInTheDocument();
    await act(async () => {
      await view.queryClient.invalidateQueries({
        queryKey: ["admin-client-details", clientA.user_id],
      });
    });
    const alert = await screen.findByRole("alert", { name: "שגיאת רענון פרטי הלקוח" });
    fireEvent.click(within(alert).getByRole("button", { name: "נסה לרענן פרטים" }));
    expect(await screen.findByText("הרשמה הושלמה")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /מאיה/ })).toHaveAttribute(
      "href",
      expect.stringContaining("conversation-a"),
    );
    expect(screen.getByText("זיכוי")).toBeInTheDocument();
  });

  it("preserves confirmed status payload and credit navigation from verified details", async () => {
    mount();
    await screen.findByText(clientA.display_name);
    fireEvent.click(screen.getAllByTitle("פרטי לקוח")[0]);
    await screen.findByText("הרשמה הושלמה");
    fireEvent.click(screen.getByRole("button", { name: "ניהול קרדיטים" }));
    expect(io.navigate).toHaveBeenCalledWith({
      to: "/admin/credits",
      search: { clientId: clientA.user_id },
    });

    fireEvent.click(screen.getAllByTitle("פרטי לקוח")[0]);
    await screen.findByText("הרשמה הושלמה");
    fireEvent.click(screen.getByRole("button", { name: "חסום לקוח" }));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "חסום לקוח" }));
    await waitFor(() =>
      expect(io.status).toHaveBeenCalledWith({
        data: { user_id: clientA.user_id, is_active: false },
      }),
    );
  });

  it("does not claim a reset link was copied when clipboard writing fails", async () => {
    io.reset.mockResolvedValueOnce({ action_link: "sensitive-link" });
    io.clipboard.mockRejectedValueOnce(new Error("clipboard denied"));
    mount();
    await screen.findByText(clientA.display_name);
    fireEvent.click(screen.getAllByTitle("שליחת איפוס סיסמה")[0]);
    fireEvent.click(
      (await screen.findByRole("dialog", { name: "איפוס סיסמה" })).querySelector("button")!,
    );
    await waitFor(() => expect(io.error).toHaveBeenCalledWith("העתקת קישור האיפוס נכשלה"));
    expect(io.success).not.toHaveBeenCalledWith("קישור איפוס הועתק ללוח");
  });
});
