import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  auth: {
    loading: false,
    session: { user: { id: "operator-user" } },
    role: "operator" as const,
    signOut: vi.fn(async () => undefined),
    user: { id: "operator-user" },
  },
  read: vi.fn(),
  navigate: vi.fn(),
  removeChannel: vi.fn(),
  rpcAwaited: vi.fn(),
  critical: 0,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: forwardRef<
    HTMLAnchorElement,
    AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }
  >(({ to, children, ...props }, ref) => (
    <a ref={ref} href={to} {...props}>
      {children}
    </a>
  )),
  useNavigate: () => io.navigate,
  useRouterState: () => "/operator",
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => io.auth,
}));
vi.mock("@/components/common/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/common/ImpersonationBanner", () => ({ ImpersonationBanner: () => null }));
vi.mock("@/hooks/useOperatorNewQueue", () => ({
  useOperatorNewSlaSummary: () => ({
    summary: {
      total_new: 0,
      warning_count: 0,
      critical_count: io.critical,
      oldest_wait_seconds: 0,
    },
  }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () => Promise.resolve().then(() => io.read(table)),
      };
      return builder;
    },
    channel: () => ({
      on() {
        return this;
      },
      subscribe() {
        return this;
      },
    }),
    removeChannel: io.removeChannel,
    rpc: vi.fn((name: string) => ({
      then: (
        onFulfilled?: (value: { data: null; error: null }) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => {
        io.rpcAwaited(name);
        return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
      },
    })),
  },
}));

import { RequireOperator, useOperator } from "@/components/operator/OperatorLayout";

function OperatorProbe() {
  const { refresh } = useOperator();
  return (
    <div>
      תוכן עובד
      <button type="button" onClick={() => void refresh()}>
        רענון נתוני עובד
      </button>
    </div>
  );
}

const operator = {
  id: "operator-a",
  user_id: "operator-user",
  full_name: "עובד בדיקה",
  is_active: true,
  availability_status: "available",
};

beforeEach(() => {
  io.read.mockReset().mockImplementation((table: string) => {
    if (table === "operators") return { data: operator, error: null };
    if (table === "operator_point_wallets") return { data: { balance: 12 }, error: null };
    throw new Error(`Unexpected table: ${table}`);
  });
  io.navigate.mockReset();
  io.removeChannel.mockReset();
  io.rpcAwaited.mockReset();
  io.critical = 0;
});

describe("operator route guard", () => {
  it("keeps NEW and its alert visible in one mobile navigation row", async () => {
    io.critical = 2;
    render(
      <RequireOperator>
        <OperatorProbe />
      </RequireOperator>,
    );
    const nav = await screen.findByRole("navigation", { name: "ניווט עובד במובייל" });
    expect(nav.firstElementChild).toHaveClass("grid-cols-5");
    expect(nav.firstElementChild?.children).toHaveLength(5);
    expect(within(nav).getByRole("link", { name: /NEW/ })).toHaveAttribute("href", "/operator/new");
    expect(within(nav).getByText("2")).toBeInTheDocument();
    await userEvent.click(within(nav).getByRole("button", { name: "עוד" }));
    expect(await screen.findByRole("menuitem", { name: "ביצועים" })).toHaveAttribute(
      "href",
      "/operator/analytics",
    );
    expect(screen.getByRole("menuitem", { name: "הגדרות" })).toHaveAttribute(
      "href",
      "/operator/settings",
    );
  });

  it("executes the lazy operator heartbeat request after the operator loads", async () => {
    render(
      <RequireOperator>
        <OperatorProbe />
      </RequireOperator>,
    );

    expect(await screen.findByText("תוכן עובד")).toBeInTheDocument();
    await waitFor(() => expect(io.rpcAwaited).toHaveBeenCalledWith("operator_heartbeat"));
  });

  it("shows an explicit retry when the operator bootstrap rejects", async () => {
    let rejectOperator = true;
    io.read.mockImplementation((table: string) => {
      if (table === "operators" && rejectOperator) {
        rejectOperator = false;
        return Promise.reject(new Error("operator transport failed"));
      }
      if (table === "operators") return { data: operator, error: null };
      if (table === "operator_point_wallets") return { data: { balance: 12 }, error: null };
      throw new Error(`Unexpected table: ${table}`);
    });

    render(
      <RequireOperator>
        <OperatorProbe />
      </RequireOperator>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("טעינת חשבון העובד נכשלה");
    expect(screen.queryByText("תוכן עובד")).not.toBeInTheDocument();
    const readsBeforeRetry = io.read.mock.calls.filter(([table]) => table === "operators").length;

    fireEvent.click(screen.getByRole("button", { name: "נסה שוב" }));

    expect(await screen.findByText("תוכן עובד")).toBeInTheDocument();
    expect(io.read.mock.calls.filter(([table]) => table === "operators").length).toBeGreaterThan(
      readsBeforeRetry,
    );
  });

  it("does not misclassify a Supabase read error as a missing operator account", async () => {
    io.read.mockImplementation((table: string) => {
      if (table === "operators") return { data: null, error: new Error("operator unavailable") };
      throw new Error(`Unexpected table: ${table}`);
    });

    render(
      <RequireOperator>
        <div>תוכן עובד</div>
      </RequireOperator>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("טעינת חשבון העובד נכשלה");
    expect(screen.queryByText("חשבון עובד לא מוגדר")).not.toBeInTheDocument();
  });

  it("keeps the last valid operator visible when a later refresh fails", async () => {
    render(
      <RequireOperator>
        <OperatorProbe />
      </RequireOperator>,
    );

    expect(await screen.findByText("תוכן עובד")).toBeInTheDocument();
    expect(screen.getByText("עובד בדיקה")).toBeInTheDocument();

    io.read.mockRejectedValueOnce(new Error("refresh failed"));
    fireEvent.click(screen.getByRole("button", { name: "רענון נתוני עובד" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("רענון נתוני העובד נכשל");
    expect(screen.getByText("עובד בדיקה")).toBeInTheDocument();
  });
});
