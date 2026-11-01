import type { ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Range = { startDate: string; endDate: string };

const analyticsFixture = {
  range: { startDate: "2026-10-01", endDate: "2026-10-31" },
  kpis: {
    newUsers: 2,
    conversationsStarted: 3,
    clientMessages: 4,
    operatorMessages: 5,
    characterViews: 6,
    packagesViewed: 7,
    insufficientCredits: 1,
    creditsBurn: 8,
  },
  funnel: [{ eventName: "signup_completed", count: 2 }],
  days: [
    {
      date: "2026-10-01",
      signups: 0,
      conversations: 0,
      clientMessages: 0,
      operatorMessages: 0,
      events: 0,
    },
  ],
  topCharacters: [],
  topOperators: [],
};

const io = vi.hoisted(() => ({
  auth: {
    loading: false,
    role: "admin" as "admin" | "operator" | "client" | null,
    userId: "admin-a" as string | null,
    sessionUserId: "admin-a" as string | null,
  },
  analytics: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
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
  adminAdvancedAnalytics: io.analytics,
}));

import { Route } from "@/routes/admin.analytics";

const Page = (Route as unknown as { component: ComponentType }).component;

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

function setRange(startDate: string, endDate: string) {
  fireEvent.change(screen.getByLabelText("התחלה"), { target: { value: startDate } });
  fireEvent.change(screen.getByLabelText("סיום"), { target: { value: endDate } });
}

beforeEach(() => {
  io.auth.loading = false;
  io.auth.role = "admin";
  io.auth.userId = "admin-a";
  io.auth.sessionUserId = "admin-a";
  io.analytics.mockReset().mockResolvedValue(analyticsFixture);
});

describe("admin analytics read states", () => {
  it("does not read until Auth is initialized with a matching admin identity", async () => {
    io.auth.loading = true;
    const view = mount();
    expect(screen.getByRole("status")).toHaveTextContent("נדרש חיבור מנהל מאומת");
    expect(io.analytics).not.toHaveBeenCalled();

    io.auth.loading = false;
    io.auth.role = "client";
    view.rerenderAuth();
    expect(io.analytics).not.toHaveBeenCalled();

    io.auth.role = "admin";
    io.auth.userId = "different-user";
    view.rerenderAuth();
    expect(io.analytics).not.toHaveBeenCalled();

    io.auth.userId = "admin-a";
    view.rerenderAuth();
    expect(await screen.findByText("טווח בפועל")).toBeInTheDocument();
    expect(io.analytics).toHaveBeenCalledTimes(1);
  });

  it("keeps draft dates local and rejects missing, impossible, and reversed ranges", async () => {
    mount();
    expect(await screen.findByText("2026-10-01 - 2026-10-31")).toBeInTheDocument();
    expect(io.analytics).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("התחלה"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "החל טווח" }));
    expect(screen.getByRole("alert", { name: "טווח תאריכים לא תקין" })).toBeInTheDocument();
    expect(io.analytics).toHaveBeenCalledTimes(1);
    expect(screen.getByText("2026-10-01 - 2026-10-31")).toBeInTheDocument();

    setRange("2026-02-30", "2026-03-02");
    fireEvent.click(screen.getByRole("button", { name: "החל טווח" }));
    expect(io.analytics).toHaveBeenCalledTimes(1);

    setRange("2026-10-20", "2026-10-10");
    fireEvent.click(screen.getByRole("button", { name: "החל טווח" }));
    expect(io.analytics).toHaveBeenCalledTimes(1);
    expect(screen.getByText("2026-10-01 - 2026-10-31")).toBeInTheDocument();
  });

  it("applies a valid range only on command and displays the range returned by the server", async () => {
    io.analytics.mockResolvedValueOnce(analyticsFixture).mockResolvedValueOnce({
      ...analyticsFixture,
      range: { startDate: "2026-04-20", endDate: "2026-10-20" },
    });
    mount();
    await screen.findByText("2026-10-01 - 2026-10-31");
    setRange("2026-01-01", "2026-10-20");
    expect(io.analytics).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "החל טווח" }));

    expect(await screen.findByText("2026-04-20 - 2026-10-20")).toBeInTheDocument();
    expect(io.analytics).toHaveBeenLastCalledWith({
      data: { startDate: "2026-01-01", endDate: "2026-10-20" },
    });
  });

  it("keeps the newest applied range when requests resolve out of order", async () => {
    const oldRange = deferred<typeof analyticsFixture>();
    const newRange = deferred<typeof analyticsFixture>();
    io.analytics
      .mockResolvedValueOnce(analyticsFixture)
      .mockReturnValueOnce(oldRange.promise)
      .mockReturnValueOnce(newRange.promise);
    mount();
    await screen.findByText("2026-10-01 - 2026-10-31");

    setRange("2026-08-01", "2026-08-31");
    fireEvent.click(screen.getByRole("button", { name: "החל טווח" }));
    setRange("2026-09-01", "2026-09-30");
    fireEvent.click(screen.getByRole("button", { name: "החל טווח" }));

    await act(async () =>
      newRange.resolve({
        ...analyticsFixture,
        range: { startDate: "2026-09-01", endDate: "2026-09-30" },
      }),
    );
    expect(await screen.findByText("2026-09-01 - 2026-09-30")).toBeInTheDocument();
    await act(async () =>
      oldRange.resolve({
        ...analyticsFixture,
        range: { startDate: "2026-08-01", endDate: "2026-08-31" },
      }),
    );
    expect(screen.getByText("2026-09-01 - 2026-09-30")).toBeInTheDocument();
    expect(screen.queryByText("2026-08-01 - 2026-08-31")).not.toBeInTheDocument();
  });

  it("retries an initial error and preserves cached data across a failed refresh", async () => {
    io.analytics
      .mockRejectedValueOnce(new Error("initial private detail"))
      .mockResolvedValueOnce(analyticsFixture)
      .mockRejectedValueOnce(new Error("refresh private detail"))
      .mockResolvedValueOnce({
        ...analyticsFixture,
        kpis: { ...analyticsFixture.kpis, newUsers: 9 },
      });
    const { client } = mount();
    const initial = await screen.findByRole("alert", { name: "שגיאת טעינת אנליטיקה" });
    expect(initial).not.toHaveTextContent("private detail");
    fireEvent.click(within(initial).getByRole("button", { name: "נסה לטעון שוב" }));
    expect(await screen.findByText("2026-10-01 - 2026-10-31")).toBeInTheDocument();

    const applied = io.analytics.mock.calls.at(-1)?.[0] as { data: Range };
    await act(async () => {
      await client.invalidateQueries({
        queryKey: ["admin-advanced-analytics", "admin-a", applied.data],
      });
    });
    const warning = await screen.findByRole("alert", { name: "שגיאת רענון אנליטיקה" });
    expect(screen.getByText("2026-10-01 - 2026-10-31")).toBeInTheDocument();
    fireEvent.click(within(warning).getByRole("button", { name: "נסה לרענן שוב" }));
    expect(await screen.findByText("9")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("alert", { name: "שגיאת רענון אנליטיקה" })).not.toBeInTheDocument(),
    );
  });

  it("rejects malformed consumed fields and renders verified zero activity at zero height", async () => {
    io.analytics.mockResolvedValueOnce({
      ...analyticsFixture,
      kpis: { ...analyticsFixture.kpis, newUsers: Number.NaN },
    });
    const first = mount();
    expect(await screen.findByRole("alert", { name: "שגיאת טעינת אנליטיקה" })).toBeInTheDocument();
    expect(screen.queryByText("NaN")).not.toBeInTheDocument();
    first.unmount();

    io.analytics.mockReset().mockResolvedValue(analyticsFixture);
    mount();
    const bar = await screen.findByTitle("2026-10-01: 0 פעולות");
    expect(bar).toHaveStyle({ height: "0%" });
    expect(screen.getAllByText("קרדיטים שנצרכו").length).toBeGreaterThan(0);
    expect(screen.getByText(/עד 10,000 רשומות לכל מקור/)).toBeInTheDocument();
  });

  it("isolates cached and late data across admin replacement and logout", async () => {
    const lateA = deferred<typeof analyticsFixture>();
    io.analytics.mockReturnValueOnce(lateA.promise).mockResolvedValueOnce({
      ...analyticsFixture,
      range: { startDate: "2026-09-01", endDate: "2026-09-30" },
      kpis: { ...analyticsFixture.kpis, newUsers: 22 },
    });
    const view = mount();
    await waitFor(() => expect(io.analytics).toHaveBeenCalledTimes(1));
    io.auth.userId = io.auth.sessionUserId = "admin-b";
    view.rerenderAuth();
    expect(await screen.findByText("2026-09-01 - 2026-09-30")).toBeInTheDocument();
    await act(async () => lateA.resolve(analyticsFixture));
    expect(screen.queryByText("2026-10-01 - 2026-10-31")).not.toBeInTheDocument();

    io.auth.userId = io.auth.sessionUserId = null;
    view.rerenderAuth();
    expect(screen.getByRole("status")).toHaveTextContent("נדרש חיבור מנהל מאומת");
    expect(screen.queryByText("22")).not.toBeInTheDocument();
  });
});
