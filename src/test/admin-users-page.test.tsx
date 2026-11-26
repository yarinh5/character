import type { ComponentType, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  list: vi.fn(),
  navigate: vi.fn(),
  sendReset: vi.fn(),
  clipboard: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (options: unknown) => options }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "admin-a" } }) }));
vi.mock("@/lib/admin-users.functions", () => ({
  adminListUsers: io.list,
  adminCreateUser: vi.fn(),
  adminUpdateUser: vi.fn(),
  adminResetPassword: vi.fn(),
  adminSetStatus: vi.fn(),
  adminSoftDeleteUser: vi.fn(),
}));
vi.mock("@/lib/impersonation.functions", () => ({
  adminImpersonate: vi.fn(),
  adminSendPasswordReset: io.sendReset,
}));
vi.mock("sonner", () => ({ toast: { success: io.success, error: io.error } }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: { getSession: vi.fn() } } }));
vi.mock("@/components/common/ImpersonationBanner", () => ({ startImpersonation: vi.fn() }));
vi.mock("@/components/admin/AdminLayout", () => ({
  PageHeader: ({ title, actions }: { title: string; actions: ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {actions}
    </header>
  ),
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

import { Route } from "@/routes/admin.users";
const Page = (Route as unknown as { component: ComponentType }).component;

const users = Array.from({ length: 105 }, (_, index) => ({
  user_id: `user-${index}`,
  email: `user${index}@example.test`,
  display_name: `User ${index}`,
  avatar_url: null,
  status: "active",
  created_at: new Date(Date.UTC(2026, 10, 26) - index * 1000).toISOString(),
  role: index === 0 ? null : "client",
}));

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  io.sendReset.mockReset().mockResolvedValue({ action_link: "https://example.test/reset" });
  io.clipboard.mockReset().mockResolvedValue(undefined);
  io.success.mockReset();
  io.error.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: io.clipboard },
    configurable: true,
  });
  io.list
    .mockReset()
    .mockImplementation(({ data }: { data: { search: string; before_user_id: string | null } }) => {
      const matching = data.search
        ? users.filter((user) => user.email.includes(data.search.toLowerCase()))
        : users;
      const start = data.before_user_id
        ? matching.findIndex((user) => user.user_id === data.before_user_id) + 1
        : 0;
      return Promise.resolve(matching.slice(start, start + 101));
    });
});

describe("admin users directory", () => {
  it("omits unsupported deprovision and impersonation actions for admin rows", async () => {
    io.list.mockResolvedValue([
      { ...users[1], user_id: "admin-target", display_name: "Admin Target", role: "admin" },
      {
        ...users[2],
        user_id: "operator-target",
        display_name: "Operator Target",
        role: "operator",
      },
    ]);
    mount();
    expect(await screen.findByText("Admin Target")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "התחזות אל Admin Target" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "חסימה עבור Admin Target" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "מחיקת Admin Target" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "התחזות אל Operator Target" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "חסימה עבור Operator Target" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "מחיקת Operator Target" })).toBeInTheDocument();
  });

  it("shows an unassigned role, loads a later page, and searches beyond the initial page", async () => {
    mount();
    expect(await screen.findByText("User 0")).toBeInTheDocument();
    expect(screen.getByText("לא הוקצה")).toBeInTheDocument();
    expect(screen.queryByText("User 104")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "טען משתמשים נוספים" }));
    expect(await screen.findByText("User 104")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "חיפוש לפי שם או אימייל" }), {
      target: { value: "user104@example.test" },
    });
    expect(await screen.findByText("User 104")).toBeInTheDocument();
    expect(io.list).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ search: "user104@example.test" }),
    });
  });

  it("retains loaded users and allows retry after a later page failure", async () => {
    let failed = false;
    io.list.mockImplementation(({ data }: { data: { before_user_id: string | null } }) => {
      if (!data.before_user_id) return Promise.resolve(users.slice(0, 101));
      if (!failed) {
        failed = true;
        return Promise.reject(new Error("page unavailable"));
      }
      return Promise.resolve(users.slice(100));
    });
    mount();
    expect(await screen.findByText("User 0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "טען משתמשים נוספים" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("טעינת משתמשים נוספים נכשלה");
    expect(screen.getByText("User 0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "טען משתמשים נוספים" }));
    expect(await screen.findByText("User 104")).toBeInTheDocument();
  });

  it("never reports a reset link as copied when clipboard access fails", async () => {
    io.clipboard.mockRejectedValueOnce(new Error("clipboard denied"));
    mount();
    expect(await screen.findByText("User 0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "שליחת קישור איפוס סיסמה עבור User 0" }));
    expect(io.sendReset).toHaveBeenCalled();
    await waitFor(() => expect(io.error).toHaveBeenCalledWith("clipboard denied"));
    expect(io.success).not.toHaveBeenCalled();
  });
});
