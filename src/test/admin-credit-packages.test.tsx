import type { ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Reply = { data: unknown; error: unknown };
type ReadRequest = {
  table: string;
  columns: string;
  orders: Array<[string, { ascending: boolean }]>;
};
type WriteRequest = {
  table: string;
  operation: "insert" | "update";
  payload: Record<string, unknown>;
  filters: Array<[string, unknown]>;
  returning: string;
};

const io = vi.hoisted(() => ({
  user: { id: "admin-a" } as { id: string } | null,
  read: vi.fn<(request: ReadRequest) => Promise<Reply>>(),
  write: vi.fn<(request: WriteRequest) => Promise<Reply>>(),
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
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: io.user, role: io.user ? "admin" : null }),
}));
vi.mock("sonner", () => ({ toast: { success: io.success, error: io.error } }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: io.rpc,
    from: (table: string) => {
      let operation: "read" | "insert" | "update" = "read";
      let columns = "";
      let returning = "";
      let payload: Record<string, unknown> = {};
      const filters: Array<[string, unknown]> = [];
      const orders: Array<[string, { ascending: boolean }]> = [];
      const execute = () =>
        operation === "read"
          ? io.read({ table, columns, orders: [...orders] })
          : io.write({
              table,
              operation,
              payload,
              filters: [...filters],
              returning,
            });
      const query = {
        select: (value: string) => {
          if (operation === "read") columns = value;
          else returning = value;
          return query;
        },
        order: (column: string, options: { ascending: boolean }) => {
          orders.push([column, options]);
          return query;
        },
        insert: (value: Record<string, unknown>) => {
          operation = "insert";
          payload = value;
          return query;
        },
        update: (value: Record<string, unknown>) => {
          operation = "update";
          payload = value;
          return query;
        },
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return query;
        },
        single: () => execute(),
        then: (resolve: (value: Reply) => unknown, reject: (error: unknown) => unknown) =>
          Promise.resolve().then(execute).then(resolve, reject),
      };
      return query;
    },
  },
}));

import { Route } from "@/routes/admin.credits";

const Page = (Route as unknown as { component: ComponentType }).component;
const packageA = {
  id: "package-a",
  name: "חבילת התחלה",
  credits: 50,
  price: 9.9,
  currency: "ILS",
  is_active: true,
  sort_order: 1,
  created_at: "2026-01-01T00:00:00Z",
};
const packageB = {
  ...packageA,
  id: "package-b",
  name: "חבילה גדולה",
  credits: 170,
  price: 29.9,
  sort_order: 2,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function renderAdmin() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Page />
    </QueryClientProvider>,
  );
  return { queryClient, ...view };
}

async function loaded() {
  return screen.findByText("חבילת התחלה");
}

async function openNewPackage() {
  await loaded();
  fireEvent.click(screen.getByRole("button", { name: "חבילה חדשה" }));
  return screen.findByRole("dialog");
}

function changeField(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function fillValidCreate(name = "חבילה חדשה") {
  changeField("שם חבילה", name);
  changeField("כמות קרדיטים", "230");
  changeField("מחיר", "49.90");
  changeField("מטבע", "ILS");
  changeField("סדר הופעה", "3");
}

function submitPackage() {
  fireEvent.click(screen.getByRole("button", { name: "שמור חבילה" }));
}

const scrollIntoView = HTMLElement.prototype.scrollIntoView;

beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterAll(() => {
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
});

beforeEach(() => {
  io.user = { id: "admin-a" };
  io.read.mockReset().mockResolvedValue({ data: [packageA, packageB], error: null });
  io.write.mockReset().mockImplementation(async (request) => ({
    data: { id: request.operation === "update" ? request.filters[0]?.[1] : "package-created" },
    error: null,
  }));
  io.rpc.mockReset();
  io.success.mockReset();
  io.error.mockReset();
});

describe("admin credit package reads", () => {
  it("preserves the admin query and distinguishes initial loading from true empty", async () => {
    const read = deferred<Reply>();
    io.read.mockReturnValue(read.promise);
    renderAdmin();

    expect(screen.getByRole("status", { name: "טוען חבילות לאדמין" })).toBeInTheDocument();
    expect(screen.queryByText("אין חבילות קרדיטים עדיין")).not.toBeInTheDocument();
    await act(async () => read.resolve({ data: [], error: null }));
    expect(await screen.findByText("אין חבילות קרדיטים עדיין")).toBeInTheDocument();
    expect(io.read).toHaveBeenCalledWith({
      table: "credit_packages",
      columns: "id, name, credits, price, currency, is_active, sort_order, created_at",
      orders: [
        ["sort_order", { ascending: true }],
        ["created_at", { ascending: false }],
      ],
    });
  });

  it("shows a read error instead of empty and retries only the read", async () => {
    let reads = 0;
    io.read.mockImplementation(async () => {
      reads += 1;
      return reads === 1
        ? { data: null, error: { message: "private read detail" } }
        : { data: [packageA], error: null };
    });
    renderAdmin();

    const alert = await screen.findByRole("alert", { name: "שגיאת טעינת חבילות לאדמין" });
    expect(alert).not.toHaveTextContent("private read detail");
    expect(screen.queryByText("אין חבילות קרדיטים עדיין")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "נסה לטעון חבילות שוב" }));
    await loaded();
    expect(reads).toBe(2);
    expect(io.write).not.toHaveBeenCalled();
    expect(io.rpc).not.toHaveBeenCalled();
  });

  it("keeps a draft and cached list on refresh failure and blocks opening another editor", async () => {
    const refresh = deferred<Reply>();
    let reads = 0;
    io.read.mockImplementation(() => {
      reads += 1;
      return reads === 1 ? Promise.resolve({ data: [packageA], error: null }) : refresh.promise;
    });
    const { queryClient } = renderAdmin();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "עריכת חבילת התחלה" }));
    changeField("שם חבילה", "טיוטה שלא תאבד");

    act(() => {
      void queryClient.invalidateQueries({ queryKey: ["admin-credit-packages"] });
    });
    expect(await screen.findByText("מרענן חבילות...")).toBeInTheDocument();
    await act(async () => refresh.resolve({ data: null, error: { message: "refresh failed" } }));
    expect(await screen.findByText(/החבילות המוצגות עשויות להיות לא מעודכנות/)).toBeInTheDocument();
    expect(screen.getByLabelText("שם חבילה")).toHaveValue("טיוטה שלא תאבד");
    expect(screen.getByText("חבילה חדשה").closest("button")).toBeDisabled();
    expect(screen.getByLabelText("עריכת חבילת התחלה")).toBeDisabled();
  });

  it("renders an unsupported legacy currency without crashing", async () => {
    io.read.mockResolvedValue({ data: [{ ...packageA, currency: "LEGACY" }], error: null });
    renderAdmin();
    expect(await screen.findByText(/LEGACY/)).toBeInTheDocument();
  });
});

describe("admin credit package saves", () => {
  it("creates a package with an exact payload, verifies the returned id, and refreshes both catalogs", async () => {
    const { queryClient } = renderAdmin();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
    await openNewPackage();
    fillValidCreate("  חבילה חדשה  ");
    submitPackage();

    await waitFor(() => expect(io.success).toHaveBeenCalledWith("חבילה נוצרה"));
    expect(io.write).toHaveBeenCalledWith({
      table: "credit_packages",
      operation: "insert",
      payload: {
        name: "חבילה חדשה",
        credits: 230,
        price: 49.9,
        currency: "ILS",
        is_active: true,
        sort_order: 3,
      },
      filters: [],
      returning: "id",
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin-credit-packages"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["client-credit-packages"] });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(io.rpc).not.toHaveBeenCalled();
  });

  it("updates the selected id and accepts the INTEGER and NUMERIC upper boundaries", async () => {
    const { queryClient } = renderAdmin();
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "עריכת חבילת התחלה" }));
    changeField("שם חבילה", "חבילת גבול");
    changeField("כמות קרדיטים", "2147483647");
    changeField("מחיר", "99999999.99");
    changeField("סדר הופעה", "-2147483648");
    submitPackage();

    await waitFor(() => expect(io.success).toHaveBeenCalledWith("חבילה עודכנה"));
    expect(io.write).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "update",
        filters: [["id", "package-a"]],
        returning: "id",
        payload: expect.objectContaining({
          name: "חבילת גבול",
          credits: 2147483647,
          price: 99999999.99,
          sort_order: -2147483648,
        }),
      }),
    );
  });

  it.each([
    ["שם חבילה", ""],
    ["שם חבילה", "א".repeat(121)],
    ["כמות קרדיטים", ""],
    ["כמות קרדיטים", "NaN"],
    ["כמות קרדיטים", "Infinity"],
    ["כמות קרדיטים", "1.5"],
    ["כמות קרדיטים", "0"],
    ["כמות קרדיטים", "2147483648"],
    ["מחיר", ""],
    ["מחיר", "NaN"],
    ["מחיר", "Infinity"],
    ["מחיר", "-1"],
    ["מחיר", "1.234"],
    ["מחיר", "100000000"],
    ["סדר הופעה", ""],
    ["סדר הופעה", "NaN"],
    ["סדר הופעה", "Infinity"],
    ["סדר הופעה", "1.5"],
    ["סדר הופעה", "2147483648"],
    ["סדר הופעה", "-2147483649"],
    ["מטבע", ""],
    ["מטבע", "AB"],
    ["מטבע", "ABCDEFGHI"],
  ])("rejects invalid schema input for %s=%s without writing", async (label, value) => {
    renderAdmin();
    await openNewPackage();
    fillValidCreate();
    changeField(label, value);
    submitPackage();

    expect(io.write).not.toHaveBeenCalled();
    expect(io.success).not.toHaveBeenCalled();
    expect(io.error).toHaveBeenCalled();
    expect(screen.getByLabelText(label)).toHaveValue(value);
  });

  it.each(["error", "throw", "zero-row", "malformed"])(
    "preserves the draft and unlocks after a %s create response",
    async (failure) => {
      io.write.mockImplementation(async () => {
        if (failure === "throw") throw new Error("private thrown detail");
        if (failure === "error") return { data: null, error: { message: "private server detail" } };
        if (failure === "zero-row") return { data: null, error: null };
        return { data: { unexpected: "shape" }, error: null };
      });
      renderAdmin();
      await openNewPackage();
      fillValidCreate("טיוטה שנשמרת");
      submitPackage();

      await waitFor(() => expect(io.error).toHaveBeenCalled());
      expect(io.success).not.toHaveBeenCalled();
      expect(screen.getByLabelText("שם חבילה")).toHaveValue("טיוטה שנשמרת");
      expect(screen.getByRole("button", { name: "שמור חבילה" })).toBeEnabled();
      expect(screen.getByRole("alert", { name: "שגיאת שמירת חבילה" })).not.toHaveTextContent(
        /private|unexpected/,
      );
    },
  );

  it("rejects a returned id that does not match the edited package", async () => {
    io.write.mockResolvedValue({ data: { id: "package-other" }, error: null });
    renderAdmin();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "עריכת חבילת התחלה" }));
    changeField("שם חבילה", "טיוטת עדכון");
    submitPackage();

    await waitFor(() => expect(io.error).toHaveBeenCalled());
    expect(io.success).not.toHaveBeenCalled();
    expect(screen.getByLabelText("שם חבילה")).toHaveValue("טיוטת עדכון");
  });

  it("blocks duplicate submits before rerender", async () => {
    const write = deferred<Reply>();
    io.write.mockReturnValue(write.promise);
    renderAdmin();
    await openNewPackage();
    fillValidCreate();
    const button = screen.getByRole("button", { name: "שמור חבילה" });
    act(() => {
      button.click();
      button.click();
    });
    expect(io.write).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "שומר..." })).toBeDisabled();
    await act(async () => write.resolve({ data: { id: "package-created" }, error: null }));
  });

  it("does not turn a refresh failure after a verified write into a write failure or retry", async () => {
    const { queryClient } = renderAdmin();
    vi.spyOn(queryClient, "invalidateQueries").mockRejectedValue(new Error("refresh failed"));
    await openNewPackage();
    fillValidCreate();
    submitPackage();

    await waitFor(() => expect(io.success).toHaveBeenCalledWith("חבילה נוצרה"));
    expect(io.write).toHaveBeenCalledTimes(1);
    expect(io.error).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("ignores an old completion after closing and reopening a new form", async () => {
    const oldWrite = deferred<Reply>();
    io.write.mockReturnValueOnce(oldWrite.promise);
    renderAdmin();
    await openNewPackage();
    fillValidCreate("טופס ישן");
    submitPackage();
    await waitFor(() => expect(io.write).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "ביטול" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "חבילה חדשה" }));
    await screen.findByRole("dialog");
    changeField("שם חבילה", "טופס חדש");

    await act(async () => oldWrite.resolve({ data: { id: "package-old" }, error: null }));
    expect(screen.getByLabelText("שם חבילה")).toHaveValue("טופס חדש");
    expect(io.success).not.toHaveBeenCalled();
    expect(io.error).not.toHaveBeenCalled();
  });

  it.each(["switch", "logout"])("ignores a late save after identity %s", async (change) => {
    const oldWrite = deferred<Reply>();
    io.write.mockReturnValue(oldWrite.promise);
    const view = renderAdmin();
    await openNewPackage();
    fillValidCreate();
    submitPackage();
    await waitFor(() => expect(io.write).toHaveBeenCalledTimes(1));

    io.user = change === "logout" ? null : { id: "admin-b" };
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <Page />
      </QueryClientProvider>,
    );
    await act(async () => oldWrite.resolve({ data: { id: "package-created" }, error: null }));
    expect(io.success).not.toHaveBeenCalled();
    expect(io.error).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
