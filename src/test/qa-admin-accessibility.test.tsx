import type { ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal(
  "ResizeObserver",
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const io = vi.hoisted(() => ({
  auth: { user: { id: "admin-a", email: "admin@example.test" }, role: "admin" as const },
  listUsers: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  resetPassword: vi.fn(),
  setStatus: vi.fn(),
  deleteUser: vi.fn(),
  impersonate: vi.fn(),
  sendReset: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
}));
vi.mock("@tanstack/react-start", () => ({
  useServerFn: (serverFn: unknown) => serverFn,
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => io.auth,
}));
vi.mock("@/lib/admin-users.functions", () => ({
  adminListUsers: io.listUsers,
  adminCreateUser: io.createUser,
  adminUpdateUser: io.updateUser,
  adminResetPassword: io.resetPassword,
  adminSetStatus: io.setStatus,
  adminSoftDeleteUser: io.deleteUser,
}));
vi.mock("@/lib/impersonation.functions", () => ({
  adminImpersonate: io.impersonate,
  adminSendPasswordReset: io.sendReset,
}));
vi.mock("@/components/common/ImpersonationBanner", () => ({
  startImpersonation: vi.fn(),
}));
vi.mock("@/components/account/AccountSettingsShared", () => ({
  AccountSecurityCard: () => null,
  AccountSummaryCard: () => null,
}));
vi.mock("@/components/account/NotificationSettingsCard", () => ({
  NotificationSettingsCard: () => null,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      if (table === "system_settings") {
        return {
          select: () =>
            Promise.resolve({
              data: [
                { key: "minimum_age", value: 18 },
                { key: "require_age_confirmation", value: true },
              ],
              error: null,
            }),
          update: () => ({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        };
      }
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: { display_name: "מנהל QA", email: "admin@example.test", status: "active" },
                  error: null,
                }),
            }),
          }),
          update: () => ({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        };
      }
      throw new Error(`Unexpected Supabase table read: ${table}`);
    },
    rpc: vi.fn().mockResolvedValue({ data: [{}], error: null }),
    functions: {
      invoke: vi.fn().mockResolvedValue({ data: { status: [] }, error: null }),
    },
    auth: { getSession: vi.fn() },
  },
}));

import { Route as SettingsRoute } from "@/routes/admin.settings";
import { Route as UsersRoute } from "@/routes/admin.users";

const SettingsPage = (SettingsRoute as unknown as { component: ComponentType }).component;
const UsersPage = (UsersRoute as unknown as { component: ComponentType }).component;

function renderWithQueryClient(component: ComponentType) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const Component = component;
  return render(
    <QueryClientProvider client={queryClient}>
      <Component />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  io.listUsers.mockResolvedValue([
    {
      user_id: "client-a",
      email: "client@example.test",
      display_name: "לקוח אלפא",
      avatar_url: null,
      status: "active",
      created_at: "2026-11-01T00:00:00Z",
      role: "client",
    },
  ]);
});

describe("QA admin accessibility regressions", () => {
  it("gives every user-row action a contextual accessible name", async () => {
    renderWithQueryClient(UsersPage);
    const rowName = "לקוח אלפא";
    const row = (await screen.findByText(rowName)).closest("div.flex.flex-wrap.items-center");
    expect(row).not.toBeNull();

    for (const name of [
      `עריכת ${rowName}`,
      `איפוס סיסמה עבור ${rowName}`,
      `שליחת קישור איפוס סיסמה עבור ${rowName}`,
      `התחזות אל ${rowName}`,
      `חסימה עבור ${rowName}`,
      `מחיקת ${rowName}`,
    ]) {
      expect(within(row as HTMLElement).getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("associates system-setting labels with their hydrated controls", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(SettingsPage);
    await user.click(screen.getByRole("tab", { name: "הגדרות מערכת" }));

    expect(await screen.findByLabelText("גיל מינימום")).toHaveAttribute(
      "id",
      "system-setting-minimum_age",
    );
    expect(screen.getByLabelText("דרוש אישור גיל בהרשמה")).toHaveAttribute(
      "id",
      "system-setting-require_age_confirmation",
    );
    expect(screen.getByLabelText("סטטוס שיחה ברירת מחדל")).toHaveAttribute(
      "id",
      "system-setting-default_conversation_status",
    );
    expect(screen.getByLabelText("טקסט גילוי נאות")).toHaveAttribute(
      "id",
      "system-setting-service_disclaimer_text",
    );
  });
});
