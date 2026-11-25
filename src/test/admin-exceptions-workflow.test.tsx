import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  role: "admin" as string,
  sessionId: "admin-a" as string | null,
  userId: "admin-a" as string | null,
  list: vi.fn<(args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>>(),
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    loading: false,
    role: io.role,
    session: io.sessionId ? { user: { id: io.sessionId } } : null,
    user: io.userId ? { id: io.userId } : null,
  }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      if (name !== "get_admin_completion_exception_cases") throw new Error("unexpected RPC");
      return io.list(args);
    },
  },
}));

import { Route } from "@/routes/admin.exceptions";

const time = "2026-11-25T12:00:00Z";
const firstPage = Array.from({ length: 101 }, (_, index) => ({
  kind: "allocation",
  id: `00000000-0000-4000-8000-${String(101 - index).padStart(12, "0")}`,
  occurred_at: time,
  code: "unresolved",
  subject_id: index === 0 ? "00000000-0000-4000-8000-000000000999" : null,
}));

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute({ component: Outlet });
  const exceptions = createRoute({
    getParentRoute: () => root,
    path: "/admin/exceptions",
    component: Route.options.component,
  });
  const conversation = createRoute({
    getParentRoute: () => root,
    path: "/admin/conversations/$conversationId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([exceptions, conversation]),
    history: createMemoryHistory({ initialEntries: ["/admin/exceptions"] }),
  });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  window.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

beforeEach(() => {
  io.role = "admin";
  io.sessionId = io.userId = "admin-a";
  io.list.mockReset().mockResolvedValue({ data: [], error: null });
});

describe("admin completion exception cases", () => {
  it("does not read cases for an unverified admin identity", async () => {
    io.sessionId = "another-user";
    mount();
    expect(await screen.findByRole("status")).toHaveTextContent("נדרש חיבור מנהל מאומת");
    expect(io.list).not.toHaveBeenCalled();
  });

  it("does not present a malformed case response as an empty queue", async () => {
    io.list.mockResolvedValueOnce({ data: { cases: [] }, error: null });
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("טעינת החריגים נכשלה");
    expect(screen.queryByText("אין חריגים פתוחים במסנן הנוכחי.")).not.toBeInTheDocument();
  });

  it("loads a bounded next page with the last visible tuple and links to the affected conversation", async () => {
    io.list
      .mockResolvedValueOnce({ data: firstPage, error: null })
      .mockResolvedValueOnce({ data: [firstPage[100]], error: null });
    mount();
    expect(await screen.findByText("100 מקרים שנטענו; קיימים מקרים נוספים")).toBeInTheDocument();
    expect(screen.getAllByText("מזהה מקרה:")).toHaveLength(100);
    expect(screen.getByRole("link", { name: "לשיחה" })).toHaveAttribute(
      "href",
      "/admin/conversations/00000000-0000-4000-8000-000000000999",
    );
    await userEvent.click(screen.getByRole("button", { name: "טען עוד מקרים" }));
    expect(await screen.findByText("101 מקרים שנטענו")).toBeInTheDocument();
    expect(screen.getAllByText("מזהה מקרה:")).toHaveLength(101);
    expect(io.list.mock.calls[1][0]).toEqual({
      _kind: null,
      _before_occurred_at: time,
      _before_kind: "allocation",
      _before_id: firstPage[99].id,
      _page_size: 101,
    });
  });

  it("filters by source and keeps loaded cases after a later page fails", async () => {
    io.list
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: firstPage, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "temporarily unavailable" } })
      .mockResolvedValueOnce({ data: [firstPage[100]], error: null });
    mount();
    expect(await screen.findByText("אין חריגים פתוחים במסנן הנוכחי.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("combobox", { name: "סוג חריג" }));
    await userEvent.click(await screen.findByRole("option", { name: "שיוך והקצאה" }));
    expect(await screen.findByText("100 מקרים שנטענו; קיימים מקרים נוספים")).toBeInTheDocument();
    expect(io.list.mock.calls[1][0]).toMatchObject({ _kind: "allocation" });
    await userEvent.click(screen.getByRole("button", { name: "טען עוד מקרים" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("המקרים שכבר נטענו נשמרו");
    expect(screen.getAllByText("מזהה מקרה:")).toHaveLength(100);
    await userEvent.click(screen.getByRole("button", { name: "טען עוד מקרים" }));
    expect(await screen.findByText("101 מקרים שנטענו")).toBeInTheDocument();
    expect(io.list.mock.calls[2][0]).toEqual(io.list.mock.calls[3][0]);
  });
});
