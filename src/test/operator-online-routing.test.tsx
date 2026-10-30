import type { ComponentType, ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pathname: "/operator/conversations",
  outreachCandidates: vi.fn(),
  outreachSend: vi.fn(),
}));

const channel = {
  on: vi.fn(() => channel),
  subscribe: vi.fn(() => channel),
};

function queryResult(table: string) {
  if (table === "operators") {
    return {
      data: {
        id: "operator-a",
        user_id: "user-a",
        full_name: "עובד בדיקה",
        is_active: true,
        availability_status: "available",
      },
    };
  }
  if (table === "credit_wallets") return { data: { balance: 12 } };
  return { data: null };
}

function queryFor(table: string) {
  const query = {
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => queryResult(table)),
    select: vi.fn(() => query),
  };
  return query;
}

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  redirect: (options: Record<string, unknown>) => Object.assign(new Error("redirect"), { options }),
  useNavigate: () => vi.fn(),
  useRouterState: ({
    select,
  }: {
    select: (value: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: state.pathname } }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      active: 0,
      waiting: 0,
      unread: 0,
      closedToday: 0,
      walletBalance: 12,
      monthlyPointChange: 0,
      scoredMessages: 0,
      sentThisMonth: 0,
      avgResponseSec: 0,
      waitingConversations: [],
      slaRisks: [],
      recent: [
        {
          id: "conversation-a",
          status: "open",
          last_message_preview: "שלום",
          last_message_at: "2026-10-29T10:00:00Z",
          operator_unread_count: 0,
          characters: { id: "character-a", name: "דמות", avatar_url: null },
        },
      ],
      assignedCharacters: [],
    },
    error: null,
    isLoading: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    loading: false,
    role: "operator",
    session: { user: { id: "user-a" } },
    signOut: vi.fn(async () => undefined),
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    channel: vi.fn(() => channel),
    from: vi.fn((table: string) => queryFor(table)),
    removeChannel: vi.fn(),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  },
}));

vi.mock("@/hooks/useOperatorNewQueue", () => ({
  useOperatorNewSlaSummary: () => ({ summary: { critical_count: 0 } }),
}));
vi.mock("@/hooks/useOperatorOnlineCandidates", () => ({
  useOperatorOnlineCandidates: state.outreachCandidates,
}));
vi.mock("@/hooks/useOperatorOutreachSend", () => ({
  operatorOutreachErrorMessage: vi.fn(),
  useOperatorOutreachSend: state.outreachSend,
}));
vi.mock("@/components/common/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/common/ImpersonationBanner", () => ({ ImpersonationBanner: () => null }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { RequireOperator } from "@/components/operator/OperatorLayout";
import { Route as DashboardRoute } from "@/routes/operator.index";
import { Route as LegacyOnlineRoute } from "@/routes/operator.online";

const Dashboard = (DashboardRoute as unknown as { component: ComponentType }).component;
const onlineRoute = LegacyOnlineRoute as unknown as {
  beforeLoad?: () => unknown;
};

beforeEach(() => {
  state.pathname = "/operator/conversations";
  state.outreachCandidates.mockReset();
  state.outreachSend.mockReset();
  channel.on.mockClear();
  channel.subscribe.mockClear();
});

describe("operator ONLINE routing", () => {
  it("keeps NEW and exposes one ONLINE destination without the legacy online path", async () => {
    render(
      <RequireOperator>
        <div>תוכן</div>
      </RequireOperator>,
    );

    await screen.findByText("תוכן");
    const onlineLinks = screen.getAllByRole("link", { name: "ONLINE" });
    expect(onlineLinks).toHaveLength(2); // desktop and mobile renderings of one NAV item
    expect(
      onlineLinks.every((link) => link.getAttribute("href") === "/operator/conversations"),
    ).toBe(true);
    expect(screen.getAllByRole("link", { name: "NEW" })).toHaveLength(2);
    expect(screen.queryByRole("link", { name: "שיחות" })).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/operator/online"]')).not.toBeInTheDocument();
  });

  it("redirects the legacy online route with replace before outreach can activate", () => {
    expect(onlineRoute.beforeLoad).toBeTypeOf("function");

    let thrown: unknown;
    try {
      onlineRoute.beforeLoad?.();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      options: { to: "/operator/conversations", replace: true },
    });
    expect(state.outreachCandidates).not.toHaveBeenCalled();
    expect(state.outreachSend).not.toHaveBeenCalled();
  });

  it("labels the dashboard list link as ONLINE while preserving its destination", async () => {
    render(
      <RequireOperator>
        <Dashboard />
      </RequireOperator>,
    );

    const link = await screen.findByRole("link", { name: "לכל שיחות ONLINE" });
    expect(link).toHaveAttribute("href", "/operator/conversations");
    await waitFor(() => expect(screen.getByText("השיחות האחרונות שלי")).toBeInTheDocument());
  });
});
