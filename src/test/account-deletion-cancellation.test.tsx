import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  rpc: vi.fn(),
  invoke: vi.fn(),
  signOut: vi.fn(),
  navigate: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  sessionUserId: "client-a" as string | null,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useSearch: () => {
      const search = new URLSearchParams(window.location.search);
      return { request: search.get("request"), token: search.get("token") };
    },
  }),
  useNavigate: () => io.navigate,
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    loading: false,
    session: io.sessionUserId ? { user: { id: io.sessionUserId } } : null,
    signOut: io.signOut,
  }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: io.rpc, functions: { invoke: io.invoke } },
}));
vi.mock("sonner", () => ({ toast: { success: io.success, error: io.error } }));

import { CancelAccountDeletionPage } from "@/routes/cancel-account-deletion";

const status = {
  id: "00000000-0000-4000-8000-000000000010",
  status: "cancellation_window",
  requested_at: "2026-11-11T08:00:00.000Z",
  confirmed_at: "2026-11-11T08:05:00.000Z",
  cancellation_deadline: "2026-11-18T08:05:00.000Z",
  content_deletion_due_at: "2026-12-11T08:05:00.000Z",
  active_system_completed_at: null,
  failure_code: null,
};

beforeEach(() => {
  io.rpc.mockReset();
  io.invoke.mockReset();
  io.signOut.mockReset().mockResolvedValue(undefined);
  io.navigate.mockReset().mockResolvedValue(undefined);
  io.success.mockReset();
  io.error.mockReset();
  io.sessionUserId = "client-a";
  window.history.replaceState({}, "", "/cancel-account-deletion");
});

describe("account deletion cancellation", () => {
  it("requests a one-time email instead of cancelling from the old session", async () => {
    io.rpc.mockResolvedValueOnce({ data: [status], error: null });
    io.invoke.mockResolvedValueOnce({
      data: { request_id: status.id, delivery_status: "provider_requested" },
      error: null,
    });
    renderPage();

    expect(await screen.findByText("מאושרת — בתוך חלון הביטול")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "שלח קישור לביטול הבקשה" }));

    await waitFor(() =>
      expect(io.invoke).toHaveBeenCalledWith("account-deletion-cancel-request", { body: {} }),
    );
    await waitFor(() => expect(io.signOut).toHaveBeenCalledTimes(1));
    expect(io.navigate).toHaveBeenCalledWith({ to: "/login", replace: true });
    expect(io.success).toHaveBeenCalledWith("בקשת קישור הביטול הועברה לספק הדוא״ל");
  });

  it("consumes the one-time email proof and forces a fresh login after cancellation", async () => {
    window.history.replaceState(
      {},
      "",
      `/cancel-account-deletion?request=${status.id}&token=one-time`,
    );
    io.rpc.mockResolvedValueOnce({ data: [status], error: null });
    io.invoke.mockResolvedValueOnce({
      data: { status: "cancelled", requires_new_login: true },
      error: null,
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "אשר ביטול לאחר אימות" }));
    await waitFor(() =>
      expect(io.invoke).toHaveBeenCalledWith("account-deletion-cancel", {
        body: { request_id: status.id, token: "one-time" },
      }),
    );
    await waitFor(() => expect(io.signOut).toHaveBeenCalledTimes(1));
    expect(io.success).toHaveBeenCalledWith("בקשת המחיקה בוטלה. יש להתחבר מחדש כדי להמשיך.");
  });

  it("does not claim success after a partial or malformed server response", async () => {
    io.rpc.mockResolvedValueOnce({ data: [status], error: null });
    io.invoke.mockResolvedValueOnce({ data: { status: "processing" }, error: null });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "שלח קישור לביטול הבקשה" }));
    await waitFor(() => expect(io.error).toHaveBeenCalledWith("ביטול בקשת המחיקה נכשל"));
    expect(io.signOut).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "שלח קישור לביטול הבקשה" })).toBeEnabled();
  });

  it("requires authentication before reading or mutating a deletion request", async () => {
    io.sessionUserId = null;
    renderPage();
    expect(screen.getByText(/יש להתחבר מחדש/)).toBeInTheDocument();
    expect(io.rpc).not.toHaveBeenCalled();
  });
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CancelAccountDeletionPage />
    </QueryClientProvider>,
  );
}
