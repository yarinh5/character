import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const io = vi.hoisted(() => ({
  auth: {
    loading: false,
    role: "admin" as "admin" | "operator" | "client" | null,
    userId: "admin-a" as string | null,
    sessionUserId: "admin-a" as string | null,
  },
  snapshot: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    loading: io.auth.loading,
    role: io.auth.role,
    user: io.auth.userId ? { id: io.auth.userId } : null,
    session: io.auth.sessionUserId ? { user: { id: io.auth.sessionUserId } } : null,
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (name: string) => {
      if (name !== "get_admin_operations_snapshot") throw new Error(`Unexpected RPC: ${name}`);
      return io.snapshot();
    },
  },
}));

import { AdminOperationsSnapshot } from "@/components/admin/AdminOperationsSnapshot";

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
      <AdminOperationsSnapshot />
    </QueryClientProvider>,
  );
  const rerenderAuth = () =>
    view.rerender(
      <QueryClientProvider client={client}>
        <AdminOperationsSnapshot />
      </QueryClientProvider>,
    );
  return { ...view, client, rerenderAuth };
}

function expectMetric(label: string, value: string) {
  const metric = screen.getByText(label).closest("div.min-w-0");
  expect(metric).not.toBeNull();
  expect(within(metric as HTMLElement).getByText(value)).toBeInTheDocument();
}

beforeEach(() => {
  io.auth.loading = false;
  io.auth.role = "admin";
  io.auth.userId = "admin-a";
  io.auth.sessionUserId = "admin-a";
  io.snapshot.mockReset().mockResolvedValue({ data: [snapshotRow], error: null });
});

describe("admin operations snapshot read states", () => {
  it("waits for a matching initialized admin identity before calling the RPC", async () => {
    io.auth.loading = true;
    const view = mount();
    expect(screen.getByRole("status")).toHaveTextContent("נדרש חיבור מנהל מאומת");
    expect(io.snapshot).not.toHaveBeenCalled();

    io.auth.loading = false;
    io.auth.role = "operator";
    view.rerenderAuth();
    expect(io.snapshot).not.toHaveBeenCalled();

    io.auth.role = "admin";
    io.auth.sessionUserId = "other-admin";
    view.rerenderAuth();
    expect(io.snapshot).not.toHaveBeenCalled();

    io.auth.sessionUserId = "admin-a";
    view.rerenderAuth();
    expect(await screen.findByText("סה״כ NEW")).toBeInTheDocument();
    expect(io.snapshot).toHaveBeenCalledTimes(1);
  });

  it("uses source-accurate historical outreach labels and preserves destinations", async () => {
    mount();
    expect(await screen.findByText("פנייה יזומה היסטורית")).toBeInTheDocument();
    expect(screen.getByText("24 השעות האחרונות")).toBeInTheDocument();
    expect(screen.getByText("פניות יזומות שנשלחו")).toBeInTheDocument();
    expect(screen.getByText("פניות יזומות שנענו")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "למסך עובדים" })[0]).toHaveAttribute(
      "href",
      "/admin/operators",
    );
    expect(screen.getByRole("link", { name: "לדיווחים" })).toHaveAttribute(
      "href",
      "/admin/reports",
    );
    expect(screen.getByRole("link", { name: "למדיה" })).toHaveAttribute(
      "href",
      "/admin/characters",
    );
  });

  it("keeps valid metrics visible when generated_at is malformed", async () => {
    io.snapshot.mockResolvedValue({
      data: [{ ...snapshotRow, generated_at: "not-a-date" }],
      error: null,
    });
    mount();
    expect(await screen.findByText("שעת עדכון לא זמינה")).toBeInTheDocument();
    expectMetric("סה״כ NEW", "4");
  });

  it("reports malformed consumed metrics instead of inventing zeroes", async () => {
    io.snapshot.mockResolvedValue({
      data: [{ ...snapshotRow, new_total: Number.NaN }],
      error: null,
    });
    mount();
    expect(
      await screen.findByRole("alert", { name: "שגיאת טעינת מצב תפעולי" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("NaN")).not.toBeInTheDocument();
  });

  it("retries an initial RPC failure without exposing private error details", async () => {
    io.snapshot
      .mockResolvedValueOnce({ data: null, error: new Error("private RPC detail") })
      .mockResolvedValueOnce({ data: [snapshotRow], error: null });
    mount();
    const alert = await screen.findByRole("alert", { name: "שגיאת טעינת מצב תפעולי" });
    expect(alert).not.toHaveTextContent("private RPC detail");
    fireEvent.click(within(alert).getByRole("button", { name: "נסה שוב" }));
    expect(await screen.findByText("סה״כ NEW")).toBeInTheDocument();
  });

  it("retains cached metrics after refresh failure and clears one warning after retry", async () => {
    io.snapshot
      .mockResolvedValueOnce({ data: [snapshotRow], error: null })
      .mockResolvedValueOnce({ data: null, error: new Error("refresh detail") })
      .mockResolvedValueOnce({ data: [{ ...snapshotRow, new_total: 8 }], error: null });
    const { client } = mount();
    expect(await screen.findByText("סה״כ NEW")).toBeInTheDocument();
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["admin-operations-snapshot", "admin-a"] });
    });
    const warning = await screen.findByRole("alert", { name: "שגיאת רענון מצב תפעולי" });
    expectMetric("סה״כ NEW", "4");
    fireEvent.click(within(warning).getByRole("button", { name: "נסה לרענן שוב" }));
    await waitFor(() => expectMetric("סה״כ NEW", "8"));
    expect(screen.queryByRole("alert", { name: "שגיאת רענון מצב תפעולי" })).not.toBeInTheDocument();
  });

  it("isolates cache and late completion across admin replacement and logout", async () => {
    const lateA = deferred<{ data: Array<typeof snapshotRow>; error: null }>();
    io.snapshot
      .mockReturnValueOnce(lateA.promise)
      .mockResolvedValueOnce({ data: [{ ...snapshotRow, new_total: 22 }], error: null });
    const view = mount();
    await waitFor(() => expect(io.snapshot).toHaveBeenCalledTimes(1));
    io.auth.userId = io.auth.sessionUserId = "admin-b";
    view.rerenderAuth();
    await waitFor(() => expectMetric("סה״כ NEW", "22"));
    await act(async () =>
      lateA.resolve({ data: [{ ...snapshotRow, new_total: 99 }], error: null }),
    );
    expect(screen.queryByText("99")).not.toBeInTheDocument();

    io.auth.userId = io.auth.sessionUserId = null;
    view.rerenderAuth();
    expect(screen.getByRole("status")).toHaveTextContent("נדרש חיבור מנהל מאומת");
    expect(screen.queryByText("סה״כ NEW")).not.toBeInTheDocument();
  });

  it("stops the 30-second polling lifecycle after logout", async () => {
    vi.useFakeTimers();
    try {
      const view = mount();
      await act(async () => Promise.resolve());
      expect(io.snapshot).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(io.snapshot).toHaveBeenCalledTimes(2);

      io.auth.userId = io.auth.sessionUserId = null;
      view.rerenderAuth();
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(io.snapshot).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
