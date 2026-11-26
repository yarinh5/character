import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  table: vi.fn(),
  rpc: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({
    ...(options as Record<string, unknown>),
    useSearch: () => ({}),
  }),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "admin-a" } }) }));
vi.mock("sonner", () => ({ toast: { success: io.success, error: io.error } }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: io.rpc,
    from: (table: string) => {
      const filters: [string, string, string][] = [];
      let limit: number | undefined;
      const query = {
        select: () => query,
        order: () => query,
        eq: (field: string, value: string) => {
          filters.push(["eq", field, value]);
          return query;
        },
        neq: (field: string, value: string) => {
          filters.push(["neq", field, value]);
          return query;
        },
        limit: (value: number) => {
          limit = value;
          return query;
        },
        in: () => query,
        then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
          Promise.resolve()
            .then(() => io.table(table, filters, limit))
            .then(resolve, reject),
      };
      return query;
    },
  },
}));

import { CreditRequestsTab } from "@/routes/admin.credits";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CreditRequestsTab />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  io.table.mockReset().mockImplementation(async (table: string) =>
    table === "credit_requests"
      ? {
          data: [
            {
              id: "request-a",
              client_id: "client-a",
              package_name_snapshot: "חבילת התחלה",
              credits_snapshot: 50,
              status: "pending",
              requested_at: "2026-11-05T10:00:00Z",
              resolved_at: null,
            },
          ],
          error: null,
        }
      : { data: [{ user_id: "client-a", display_name: "לקוחה" }], error: null },
  );
  io.rpc.mockReset();
  io.success.mockReset();
  io.error.mockReset();
});

describe("admin credit request workflow", () => {
  it("loads an actionable queue even when recent history fills the result limit", async () => {
    const history = Array.from({ length: 100 }, (_, i) => ({
      id: `closed-${i}`,
      client_id: "client-a",
      package_name_snapshot: "היסטוריה",
      credits_snapshot: 10,
      status: "rejected",
    }));
    const pending = {
      id: "pending-later",
      client_id: "client-a",
      package_name_snapshot: "בקשה חדשה",
      credits_snapshot: 50,
      status: "pending",
    };
    io.table.mockImplementation(async (table, filters, limit) =>
      table === "credit_requests"
        ? {
            data: [...history, pending]
              .filter((row) =>
                filters.every(([op, field, value]: [string, string, string]) => {
                  expect(field).toBe("status");
                  return op === "eq" ? row.status === value : row.status !== value;
                }),
              )
              .slice(0, limit),
            error: null,
          }
        : { data: [], error: null },
    );

    renderTab();

    expect(await screen.findByText(/בקשה חדשה/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "אשר" })).toBeInTheDocument();
    expect(screen.queryByText(/היסטוריה ·/)).not.toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "היסטוריה" }), { button: 0 });
    expect(await screen.findAllByText(/היסטוריה ·/)).toHaveLength(100);
    expect(screen.queryByRole("button", { name: "אשר" })).not.toBeInTheDocument();
  });

  it("approves once only after the canonical response is verified", async () => {
    const write = deferred<{ data: unknown; error: unknown }>();
    io.rpc.mockReturnValue(write.promise);
    renderTab();

    expect(await screen.findByText("לקוחה")).toBeInTheDocument();
    const approve = screen.getByRole("button", { name: "אשר" });
    act(() => {
      approve.click();
      approve.click();
    });
    await waitFor(() => expect(io.rpc).toHaveBeenCalledTimes(1));
    expect(io.rpc).toHaveBeenCalledWith("resolve_credit_request", {
      _request_id: "request-a",
      _decision: "approved",
      _note: "Approved in admin credit requests",
    });

    const readBeforeResolution = io.table.getMockImplementation()!;
    io.table.mockImplementation(async (table, filters, limit) => {
      const result = await readBeforeResolution(table, filters, limit);
      if (table !== "credit_requests") return result;
      return {
        ...result,
        data: filters.some(([op]: [string]) => op === "eq")
          ? []
          : result.data.map((row: object) => ({ ...row, status: "approved" })),
      };
    });
    await act(async () =>
      write.resolve({
        data: [
          {
            id: "request-a",
            status: "approved",
            transaction_id: "transaction-a",
            balance_after: 50,
            resolved_at: "2026-11-05T10:01:00Z",
          },
        ],
        error: null,
      }),
    );
    expect(await screen.findByText("אין בקשות קרדיטים ממתינות.")).toBeInTheDocument();
    expect(io.success).toHaveBeenCalledWith("בקשת הקרדיטים אושרה");
    expect(screen.queryByRole("button", { name: "אשר" })).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "היסטוריה" }), { button: 0 });
    expect(await screen.findByText("approved")).toBeInTheDocument();
  });

  it("keeps the request pending when the response is malformed", async () => {
    io.rpc.mockResolvedValue({ data: [{ id: "other", status: "approved" }], error: null });
    renderTab();
    await screen.findByText("לקוחה");
    fireEvent.click(screen.getByRole("button", { name: "אשר" }));

    await waitFor(() =>
      expect(io.error).toHaveBeenCalledWith("לא ניתן לאמת את תוצאת הטיפול בבקשת הקרדיטים."),
    );
    expect(screen.getByText("pending")).toBeInTheDocument();
  });
});
