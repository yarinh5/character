import type { ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type ReadReply = { data: unknown[] | null; error: unknown };
type ReadRequest = {
  table: string;
  columns: string;
  filters: Array<[string, unknown]>;
  orders: Array<[string, { ascending: boolean }]>;
};

const io = vi.hoisted(() => ({
  read: vi.fn<(request: ReadRequest) => Promise<ReadReply>>(),
  analytics: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
}));
vi.mock("@/lib/analyticsEvents", () => ({ trackAnalyticsEvent: io.analytics }));
vi.mock("sonner", () => ({
  toast: { info: io.toastInfo, error: io.toastError, success: io.toastSuccess },
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const request: ReadRequest = { table, columns: "", filters: [], orders: [] };
      const execute = () =>
        io.read({ ...request, filters: [...request.filters], orders: [...request.orders] });
      const query = {
        select: (columns: string) => {
          request.columns = columns;
          return query;
        },
        eq: (column: string, value: unknown) => {
          request.filters.push([column, value]);
          return query;
        },
        order: (column: string, options: { ascending: boolean }) => {
          request.orders.push([column, options]);
          return query;
        },
        then: (resolve: (value: ReadReply) => unknown, reject: (error: unknown) => unknown) =>
          Promise.resolve().then(execute).then(resolve, reject),
      };
      return query;
    },
  },
}));

import { Route } from "@/routes/app.packages";

const Page = (Route as unknown as { component: ComponentType }).component;
const firstPackage = {
  id: "package-a",
  name: "חבילת התחלה",
  credits: 50,
  price: 9.9,
  currency: "ILS",
  sort_order: 1,
};
const secondPackage = {
  ...firstPackage,
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

function renderPage() {
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

beforeEach(() => {
  io.read.mockReset().mockResolvedValue({ data: [firstPackage, secondPackage], error: null });
  io.analytics.mockReset().mockResolvedValue(undefined);
  io.toastInfo.mockReset();
  io.toastError.mockReset();
  io.toastSuccess.mockReset();
});

describe("client credit packages", () => {
  it("preserves the active-package query, server order, and analytics while removing the fake purchase action", async () => {
    renderPage();

    expect(await screen.findByText("חבילת התחלה")).toBeInTheDocument();
    expect(io.read).toHaveBeenCalledWith({
      table: "credit_packages",
      columns: "id, name, credits, price, currency, sort_order",
      filters: [["is_active", true]],
      orders: [
        ["sort_order", { ascending: true }],
        ["created_at", { ascending: false }],
      ],
    });
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(["חבילת התחלה", "חבילה גדולה"]);
    expect(screen.getByRole("note")).toHaveTextContent(
      "רכישה מתוך האתר אינה זמינה כרגע. לא נשלחה בקשה ולא בוצע חיוב.",
    );
    expect(screen.queryByRole("button", { name: "בקשת רכישה ידנית" })).not.toBeInTheDocument();
    expect(screen.queryByText(/בקשת רכישה נרשמה/)).not.toBeInTheDocument();
    expect(io.toastInfo).not.toHaveBeenCalled();
    expect(io.analytics).toHaveBeenCalledWith({
      eventName: "packages_viewed",
      metadata: { source: "client_packages_page" },
      dedupeSeconds: 900,
    });
  });

  it("distinguishes initial loading from a true empty result", async () => {
    const read = deferred<ReadReply>();
    io.read.mockReturnValue(read.promise);
    renderPage();

    expect(screen.getByRole("status", { name: "טוען חבילות" })).toBeInTheDocument();
    expect(screen.queryByText("אין חבילות פעילות כרגע")).not.toBeInTheDocument();
    await act(async () => read.resolve({ data: [], error: null }));
    expect(await screen.findByText("אין חבילות פעילות כרגע")).toBeInTheDocument();
  });

  it("shows a read error instead of empty, retries only the read, and recovers", async () => {
    let reads = 0;
    io.read.mockImplementation(async () => {
      reads += 1;
      return reads === 1
        ? { data: null, error: { message: "private read detail" } }
        : { data: [firstPackage], error: null };
    });
    renderPage();

    const alert = await screen.findByRole("alert", { name: "שגיאת טעינת חבילות" });
    expect(alert).not.toHaveTextContent("private read detail");
    expect(screen.queryByText("אין חבילות פעילות כרגע")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "נסה לטעון חבילות שוב" }));
    expect(await screen.findByText("חבילת התחלה")).toBeInTheDocument();
    expect(reads).toBe(2);
    expect(io.toastInfo).not.toHaveBeenCalled();
  });

  it("keeps cached packages visible during refresh failure and supports read-only retry", async () => {
    const refresh = deferred<ReadReply>();
    let reads = 0;
    io.read.mockImplementation(() => {
      reads += 1;
      if (reads === 1) return Promise.resolve({ data: [firstPackage], error: null });
      if (reads === 2) return refresh.promise;
      return Promise.resolve({ data: [secondPackage], error: null });
    });
    const { queryClient } = renderPage();
    expect(await screen.findByText("חבילת התחלה")).toBeInTheDocument();

    act(() => {
      void queryClient.invalidateQueries({ queryKey: ["client-credit-packages"] });
    });
    expect(
      await screen.findByRole("status", { name: "מרענן את קטלוג החבילות" }),
    ).toBeInTheDocument();
    expect(screen.getByText("חבילת התחלה")).toBeInTheDocument();
    await act(async () => refresh.resolve({ data: null, error: { message: "refresh failed" } }));
    expect(await screen.findByRole("alert", { name: "שגיאת טעינת חבילות" })).toHaveTextContent(
      "החבילות המוצגות עשויות להיות לא מעודכנות",
    );
    expect(screen.getByText("חבילת התחלה")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "נסה לטעון חבילות שוב" }));
    expect(await screen.findByText("חבילה גדולה")).toBeInTheDocument();
    expect(io.toastInfo).not.toHaveBeenCalled();
  });

  it("renders an unsupported legacy currency without crashing", async () => {
    io.read.mockResolvedValue({
      data: [{ ...firstPackage, currency: "LEGACY" }],
      error: null,
    });
    renderPage();

    expect(await screen.findByText("חבילת התחלה")).toBeInTheDocument();
    expect(screen.getByText(/LEGACY/)).toBeInTheDocument();
  });
});
