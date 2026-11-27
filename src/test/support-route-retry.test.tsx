import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), error: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: io.from, rpc: io.rpc } }));
vi.mock("@/components/admin/AdminLayout", () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("@/components/admin/RecoveryOperationsPanel", () => ({
  RecoveryOperationsPanel: () => null,
}));
vi.mock("sonner", () => ({ toast: { error: io.error, success: vi.fn() } }));

import { Route as AdminRoute } from "@/routes/admin.support";
import { Route as ClientRoute } from "@/routes/app.support";

const ticket = {
  id: "ticket-a",
  subject: "Existing support ticket",
  description: "Existing description",
  status: "new",
  version: 1,
  created_at: "2026-11-11T18:00:00Z",
  updated_at: "2026-11-11T18:00:00Z",
};

function mount(view: "admin" | "client") {
  const Page = (view === "admin" ? AdminRoute : ClientRoute).options.component!;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  );
}

function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
}

function click(label: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

function simulateLostResponse() {
  const stored = new Map<string, { id: string }>();
  io.rpc.mockImplementation(async (_name: string, payload: { _idempotency_key: string }) => {
    if (!stored.has(payload._idempotency_key)) {
      stored.set(payload._idempotency_key, { id: `new-${stored.size + 1}` });
    }
    if (io.rpc.mock.calls.length === 1) throw new Error("response lost after commit");
    return { data: [stored.get(payload._idempotency_key)], error: null };
  });
  return stored;
}

beforeEach(() => {
  io.rpc.mockReset();
  io.error.mockReset();
  io.from.mockImplementation((table: string) => {
    const rows = table === "support_tickets" ? [ticket] : [];
    const result = Promise.resolve({ data: rows, error: null });
    const query = {
      then: result.then.bind(result),
      select: () => query,
      eq: () => query,
      neq: () => query,
      order: () => query,
      limit: () => query,
    };
    return query;
  });
});

describe("support route retry after an ambiguous reply", () => {
  it("reuses the creation key and forgets it after confirmed success", async () => {
    mount("client");
    const stored = simulateLostResponse();
    const fillTicket = () => {
      change("נושא", "Login issue");
      change("תיאור", "Cannot continue on the login screen.");
    };
    fillTicket();
    click("פתיחת פנייה");
    await waitFor(() => expect(io.error).toHaveBeenCalledOnce());
    click("פתיחת פנייה");
    await waitFor(() => expect(screen.getByLabelText("נושא")).toHaveValue(""));
    expect(io.rpc.mock.calls[1]).toEqual(io.rpc.mock.calls[0]);
    expect(stored.size).toBe(1);
    fillTicket();
    click("פתיחת פנייה");
    await waitFor(() => expect(screen.getByLabelText("נושא")).toHaveValue(""));
    expect(stored.size).toBe(2);
  });

  it("replays the existing message if the normalized text is unchanged", async () => {
    mount("client");
    const stored = simulateLostResponse();
    await screen.findByLabelText("הוספת מידע");
    change("הוספת מידע", "Follow-up details");
    click("שליחה");
    await waitFor(() => expect(io.error).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("הוספת מידע")).toHaveValue("Follow-up details");
    change("הוספת מידע", "Follow-up details ");
    click("שליחה");
    await waitFor(() => expect(screen.getByLabelText("הוספת מידע")).toHaveValue(""));
    expect(io.rpc.mock.calls[1]).toEqual(io.rpc.mock.calls[0]);
    expect(stored.size).toBe(1);
  });

  it("cannot replay a lost public reply as an internal note", async () => {
    mount("admin");
    const stored = simulateLostResponse();
    fireEvent.click(await screen.findByRole("button", { name: /Existing support ticket/ }));
    change("תשובה ללקוח", "Same text");
    click("שליחת תשובה");
    await waitFor(() => expect(io.error).toHaveBeenCalledOnce());
    change("הערה פנימית", "Same text");
    click("שמירת הערה פנימית");
    await waitFor(() => expect(screen.getByLabelText("הערה פנימית")).toHaveValue(""));
    click("שליחת תשובה");
    await waitFor(() => expect(screen.getByLabelText("תשובה ללקוח")).toHaveValue(""));
    expect(io.rpc.mock.calls[1][1]._visibility).toBe("internal");
    expect(io.rpc.mock.calls[1][1]._idempotency_key).not.toBe(
      io.rpc.mock.calls[0][1]._idempotency_key,
    );
    expect(io.rpc.mock.calls[2]).toEqual(io.rpc.mock.calls[0]);
    expect(stored.size).toBe(2);
  });

  it("replays an incident without creating a second escalation", async () => {
    mount("admin");
    const stored = simulateLostResponse();
    await userEvent.click(screen.getByRole("tab", { name: "אירועים" }));
    change("כותרת", "Synthetic incident");
    change("פרטים ופעולות ראשוניות", "Observed a synthetic service failure.");
    click("פתיחת אירוע והסלמה פנימית");
    await waitFor(() => expect(io.error).toHaveBeenCalledOnce());
    click("פתיחת אירוע והסלמה פנימית");
    await waitFor(() => expect(screen.getByLabelText("כותרת")).toHaveValue(""));
    expect(io.rpc.mock.calls[1]).toEqual(io.rpc.mock.calls[0]);
    expect(stored.size).toBe(1);
  });
});
