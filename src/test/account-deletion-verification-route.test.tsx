import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  invoke: vi.fn(),
  signOut: vi.fn(),
  navigate: vi.fn(),
  userId: "user-a" as string | null,
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
    session: io.userId ? { user: { id: io.userId } } : null,
    signOut: io.signOut,
  }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: io.invoke } },
}));

import { VerifyAccountDeletionPage } from "@/routes/verify-account-deletion";

beforeEach(() => {
  io.invoke.mockReset();
  io.signOut.mockReset().mockResolvedValue(undefined);
  io.navigate.mockReset().mockResolvedValue(undefined);
  io.userId = "user-a";
  window.history.replaceState({}, "", "/verify-account-deletion?request=request-a&token=one-time");
});

describe("account deletion verification route", () => {
  it("submits the email proof and signs the locally cached session out after provider revocation", async () => {
    io.invoke.mockResolvedValue({
      data: { status: "cancellation_window", sessions_revoked: true },
      error: null,
    });
    render(<VerifyAccountDeletionPage />);
    fireEvent.click(screen.getByRole("button", { name: "אשר את בקשת המחיקה" }));
    await waitFor(() =>
      expect(io.invoke).toHaveBeenCalledWith("account-deletion-verify", {
        body: { request_id: "request-a", token: "one-time" },
      }),
    );
    expect(io.signOut).toHaveBeenCalledTimes(1);
    expect(io.navigate).toHaveBeenCalledWith({ to: "/login", replace: true });
  });

  it("does not claim success or sign out after a partial response", async () => {
    io.invoke.mockResolvedValue({ data: { status: "cancellation_window" }, error: null });
    render(<VerifyAccountDeletionPage />);
    fireEvent.click(screen.getByRole("button", { name: "אשר את בקשת המחיקה" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("האימות נכשל");
    expect(io.signOut).not.toHaveBeenCalled();
  });
});
