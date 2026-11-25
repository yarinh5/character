import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSecurityCard } from "@/components/account/AccountSettingsShared";

const io = vi.hoisted(() => ({ invoke: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: io.invoke },
    auth: { resetPasswordForEmail: vi.fn() },
  },
}));
vi.mock("sonner", () => ({ toast: { success: io.success, error: io.error } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

beforeEach(() => {
  io.invoke.mockReset();
  io.success.mockReset();
  io.error.mockReset();
});

describe("account deletion request preparation", () => {
  it("creates one idempotent verification request without claiming deletion", async () => {
    const write = deferred<{ data: unknown; error: unknown }>();
    io.invoke.mockReturnValue(write.promise);
    const onDeletionRequested = vi.fn();
    render(
      <AccountSecurityCard
        userId="client-a"
        email="client@example.com"
        onDeletionRequested={onDeletionRequested}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "בקשת מחיקת חשבון" }));
    const submit = screen.getByRole("button", { name: "שלח בקשה" });
    act(() => {
      submit.click();
      submit.click();
    });
    await waitFor(() => expect(io.invoke).toHaveBeenCalledTimes(1));
    expect(io.invoke).toHaveBeenCalledWith("account-deletion-request", {
      body: { idempotency_key: expect.any(String) },
    });

    await act(async () =>
      write.resolve({
        data: {
          request: {
            id: "request-a",
            status: "awaiting_verification",
            requested_at: "2026-11-05T12:00:00Z",
          },
          delivery_status: "provider_requested",
        },
        error: null,
      }),
    );
    expect(io.success).toHaveBeenCalledWith("בקשת האימות הועברה לספק הדוא״ל");
    expect(onDeletionRequested).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not report email delivery when only the deletion request was saved", async () => {
    io.invoke.mockResolvedValue({
      data: {
        request: {
          id: "request-a",
          status: "awaiting_verification",
          requested_at: "2026-11-05T12:00:00Z",
        },
      },
      error: null,
    });
    render(<AccountSecurityCard userId="client-a" email="client@example.com" />);
    fireEvent.click(screen.getByRole("button", { name: "בקשת מחיקת חשבון" }));
    fireEvent.click(screen.getByRole("button", { name: "שלח בקשה" }));

    await waitFor(() => expect(io.error).toHaveBeenCalledWith("בקשת המחיקה נכשלה"));
    expect(io.success).not.toHaveBeenCalled();
  });

  it("keeps the dialog open when the server result cannot be verified", async () => {
    io.invoke.mockResolvedValue({ data: { request: { status: "completed" } }, error: null });
    render(<AccountSecurityCard userId="client-a" email="client@example.com" />);
    fireEvent.click(screen.getByRole("button", { name: "בקשת מחיקת חשבון" }));
    fireEvent.click(screen.getByRole("button", { name: "שלח בקשה" }));

    await waitFor(() => expect(io.error).toHaveBeenCalledWith("בקשת המחיקה נכשלה"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("releases the pending state and reuses the idempotency key after a rejected transport", async () => {
    io.invoke.mockRejectedValueOnce(new Error("network unavailable")).mockResolvedValueOnce({
      data: {
        request: {
          id: "request-a",
          status: "awaiting_verification",
          requested_at: "2026-11-05T12:00:00Z",
        },
        delivery_status: "provider_requested",
      },
      error: null,
    });
    render(<AccountSecurityCard userId="client-a" email="client@example.com" />);
    fireEvent.click(screen.getByRole("button", { name: "בקשת מחיקת חשבון" }));

    const submit = screen.getByRole("button", { name: "שלח בקשה" });
    fireEvent.click(submit);

    await waitFor(() => expect(io.error).toHaveBeenCalledWith("בקשת המחיקה נכשלה"));
    expect(submit).toBeEnabled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(submit);

    await waitFor(() => expect(io.invoke).toHaveBeenCalledTimes(2));
    expect(io.invoke.mock.calls[1]?.[1]).toEqual(io.invoke.mock.calls[0]?.[1]);
    await waitFor(() => expect(io.success).toHaveBeenCalledTimes(1));
  });
});
