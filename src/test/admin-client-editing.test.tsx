import type { ComponentType, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
const io = vi.hoisted(() => ({
  auth: {
    sessionUserId: "admin-a" as string | null,
    userId: "admin-a" as string | null,
    role: "admin" as string | null,
    loading: false,
  },
  list: vi.fn(),
  details: vi.fn(),
  update: vi.fn(),
  status: vi.fn(),
  credits: vi.fn(),
  archive: vi.fn(),
  pii: vi.fn(),
  restore: vi.fn(),
  promote: vi.fn(),
  reset: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({ children, ...props }: { children: ReactNode }) => <a {...props}>{children}</a>,
  useNavigate: () => io.navigate,
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    session: io.auth.sessionUserId ? { user: { id: io.auth.sessionUserId } } : null,
    user: io.auth.userId ? { id: io.auth.userId } : null,
    role: io.auth.role,
    loading: io.auth.loading,
  }),
}));
vi.mock("@/lib/admin-clients.functions", () => ({
  adminListClients: io.list,
  adminGetClientDetails: io.details,
  adminUpdateClient: io.update,
  adminSetClientStatus: io.status,
  adminAdjustClientCredits: io.credits,
  adminArchiveClient: io.archive,
  adminArchiveClientPii: io.pii,
  adminRestoreClient: io.restore,
}));
vi.mock("@/lib/admin-operators.functions", () => ({ adminPromoteClientToOperator: io.promote }));
vi.mock("@/lib/impersonation.functions", () => ({ adminSendPasswordReset: io.reset }));
vi.mock("sonner", () => ({ toast: { success: io.success, error: io.error } }));

import { Route } from "@/routes/admin.clients";
const Page = (Route as unknown as { component: ComponentType }).component;
const a = {
  user_id: "client-a",
  email: "alpha@example.test",
  display_name: "לקוחה אלפא",
  avatar_url: null,
  status: "active",
  pii_archived_at: null,
  created_at: "2026-10-01T00:00:00Z",
  deleted_at: null,
  credits_balance: 25,
  conversations_count: 2,
  active_conversations_count: 1,
  last_message_at: null,
};
const b = { ...a, user_id: "client-b", email: "beta@example.test", display_name: "לקוחה בטא" };
function makeDetails(client = a, hasProfile = true) {
  return {
    profile: client,
    client_profile: hasProfile
      ? {
          age: null as number | null,
          gender: "legacy-value" as string | null,
          interests: ["מוזיקה"] as string[],
          conversation_preferences: null as string | null,
        }
      : null,
    wallet: { balance: 25, lifetime_earned: 40, lifetime_spent: 15, updated_at: null },
    conversations: [],
    transactions: [],
    timeline: [],
    activity: { conversations_count: 0, client_messages_count: 0 },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function qc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } },
  });
}
function mount(queryClient = qc()) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Page />
    </QueryClientProvider>,
  );
  const rerender = () =>
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <Page />
      </QueryClientProvider>,
    );
  return { ...view, queryClient, rerender };
}
async function open(index = 0) {
  await screen.findByText(index ? b.display_name : a.display_name);
  fireEvent.click(screen.getAllByTitle("עריכת לקוח")[index]);
  return screen.findByRole("dialog", { name: "עריכת לקוח" });
}

beforeEach(() => {
  Object.assign(io.auth, {
    sessionUserId: "admin-a",
    userId: "admin-a",
    role: "admin",
    loading: false,
  });
  io.list.mockReset().mockResolvedValue([a, b]);
  io.details
    .mockReset()
    .mockImplementation(({ data }: { data: { user_id: string } }) =>
      Promise.resolve(makeDetails(data.user_id === a.user_id ? a : b)),
    );
  io.update.mockReset().mockResolvedValue({ ok: true });
  for (const fn of [io.status, io.credits, io.archive, io.pii, io.restore, io.promote])
    fn.mockReset().mockResolvedValue({ ok: true });
  io.reset.mockReset().mockResolvedValue({ action_link: null });
  io.success.mockReset();
  io.error.mockReset();
});

describe("admin client editing", () => {
  it("does not normalize untouched legacy strings or comma-bearing interests into writes", async () => {
    const details = makeDetails();
    details.client_profile = {
      age: null,
      gender: "",
      interests: ["rock, roll"],
      conversation_preferences: "  original  ",
    };
    io.details.mockResolvedValue(details);
    mount();
    const dialog = await open();
    fireEvent.change(await within(dialog).findByRole("textbox", { name: "שם תצוגה" }), {
      target: { value: "new name" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "שמור" }));

    await waitFor(() => expect(io.update).toHaveBeenCalledTimes(1));
    expect(io.update).toHaveBeenCalledWith({
      data: { user_id: a.user_id, display_name: "new name" },
    });
  });

  it("treats fields returned to their original form representation as unchanged", async () => {
    const details = makeDetails();
    details.client_profile = {
      age: null,
      gender: "",
      interests: ["rock, roll"],
      conversation_preferences: "  original  ",
    };
    io.details.mockResolvedValue(details);
    mount();
    const dialog = await open();
    const name = await within(dialog).findByRole("textbox", { name: "שם תצוגה" });
    const gender = within(dialog).getByRole("textbox", { name: "מגדר" });
    const interests = within(dialog).getByRole("textbox", { name: "תחומי עניין" });
    const preferences = within(dialog).getByRole("textbox", { name: "העדפות שיחה" });

    fireEvent.change(gender, { target: { value: "temporary" } });
    fireEvent.change(gender, { target: { value: "" } });
    fireEvent.change(interests, { target: { value: "temporary" } });
    fireEvent.change(interests, { target: { value: "rock, roll" } });
    fireEvent.change(preferences, { target: { value: "temporary" } });
    fireEvent.change(preferences, { target: { value: "  original  " } });
    fireEvent.change(name, { target: { value: "renamed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "שמור" }));

    await waitFor(() => expect(io.update).toHaveBeenCalledTimes(1));
    expect(io.update).toHaveBeenCalledWith({
      data: { user_id: a.user_id, display_name: "renamed" },
    });
  });

  it("blocks save until details load, preserves a dirty draft on refetch and sends only changed fields", async () => {
    const first = deferred<ReturnType<typeof makeDetails>>();
    io.details
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(makeDetails({ ...a, display_name: "שם שרת חדש" }));
    const view = mount();
    const dialog = await open();
    expect(within(dialog).getByRole("button", { name: "שמור" })).toBeDisabled();
    first.resolve(makeDetails());
    await act(async () => first.promise);
    const name = await within(dialog).findByRole("textbox", { name: "שם תצוגה" });
    fireEvent.change(name, { target: { value: "טיוטה מקומית" } });
    await act(async () => {
      await view.queryClient.invalidateQueries({ queryKey: ["admin-client-details", a.user_id] });
    });
    expect(name).toHaveValue("טיוטה מקומית");
    fireEvent.click(within(dialog).getByRole("button", { name: "שמור" }));
    await waitFor(() =>
      expect(io.update).toHaveBeenCalledWith({
        data: { user_id: a.user_id, display_name: "טיוטה מקומית" },
      }),
    );
  });

  it("blocks a missing client profile instead of offering blank or zero-filled writes", async () => {
    io.details.mockResolvedValueOnce(makeDetails(a, false));
    mount();
    const dialog = await open();
    expect(await within(dialog).findByText("פרופיל הלקוח אינו זמין לעריכה")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "שמור" })).toBeDisabled();
    expect(io.update).not.toHaveBeenCalled();
  });

  it("validates edited fields and preserves untouched null and legacy values", async () => {
    mount();
    const dialog = await open();
    const name = await within(dialog).findByRole("textbox", { name: "שם תצוגה" });
    fireEvent.change(name, { target: { value: "   " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "שמור" }));
    expect(io.error).toHaveBeenCalledWith("שם התצוגה חייב להכיל 1–120 תווים");
    expect(io.update).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: a.display_name } });
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: "גיל" }), {
      target: { value: "21" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "שמור" }));
    await waitFor(() =>
      expect(io.update).toHaveBeenCalledWith({ data: { user_id: a.user_id, age: 21 } }),
    );
  });

  it("enforces gender, interests and preferences limits only after those fields are edited", async () => {
    mount();
    const dialog = await open();
    const gender = await within(dialog).findByRole("textbox", { name: "מגדר" });
    fireEvent.change(gender, { target: { value: "ג".repeat(81) } });
    fireEvent.click(within(dialog).getByRole("button", { name: "שמור" }));
    expect(io.error).toHaveBeenLastCalledWith("מגדר יכול להכיל עד 80 תווים");
    fireEvent.change(gender, { target: { value: "legacy-value" } });

    const interests = within(dialog).getByRole("textbox", { name: "תחומי עניין" });
    fireEvent.change(interests, {
      target: { value: Array.from({ length: 31 }, (_, index) => `תחום${index}`).join(",") },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "שמור" }));
    expect(io.error).toHaveBeenLastCalledWith("ניתן להזין עד 30 תחומי עניין, עד 60 תווים לכל תחום");
    fireEvent.change(interests, { target: { value: "מוזיקה" } });

    fireEvent.change(within(dialog).getByRole("textbox", { name: "העדפות שיחה" }), {
      target: { value: "א".repeat(1001) },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "שמור" }));
    expect(io.error).toHaveBeenLastCalledWith("העדפות שיחה יכולות להכיל עד 1000 תווים");
    expect(io.update).not.toHaveBeenCalled();
  });

  it("keeps a failed mutation draft but reports success when only the following refresh fails", async () => {
    io.update
      .mockRejectedValueOnce(new Error("mutation failed"))
      .mockResolvedValueOnce({ ok: true });
    const view = mount();
    const dialog = await open();
    const name = await within(dialog).findByRole("textbox", { name: "שם תצוגה" });
    fireEvent.change(name, { target: { value: "שם לאחר כשל" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "שמור" }));
    await waitFor(() => expect(io.error).toHaveBeenCalledWith("mutation failed"));
    expect(name).toHaveValue("שם לאחר כשל");

    io.list.mockRejectedValueOnce(new Error("refresh failed"));
    fireEvent.click(within(dialog).getByRole("button", { name: "שמור" }));
    await waitFor(() => expect(io.success).toHaveBeenCalledWith("הלקוח עודכן"));
    expect(screen.queryByRole("dialog", { name: "עריכת לקוח" })).not.toBeInTheDocument();
    expect(io.error).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("alert", { name: "שגיאת רענון רשימת הלקוחות" }),
    ).toBeInTheDocument();
    expect(view.queryClient.getQueryState(["admin-clients", "admin-a", false])?.status).toBe(
      "error",
    );
  });

  it("prevents synchronous double-submit, rejects malformed success and keeps the draft", async () => {
    const pending = deferred<{ ok: boolean }>();
    io.update.mockReturnValueOnce(pending.promise);
    mount();
    const dialog = await open();
    const name = await within(dialog).findByRole("textbox", { name: "שם תצוגה" });
    fireEvent.change(name, { target: { value: "טיוטה לשימור" } });
    const save = within(dialog).getByRole("button", { name: "שמור" });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(io.update).toHaveBeenCalledTimes(1);
    pending.resolve({ ok: false });
    await act(async () => pending.promise);
    expect(io.success).not.toHaveBeenCalled();
    expect(io.error).toHaveBeenCalledWith("שמירת פרטי הלקוח לא אושרה");
    expect(name).toHaveValue("טיוטה לשימור");
    expect(save).toBeEnabled();
  });

  it("drops a late save completion after logout and resets the draft for client B", async () => {
    const pending = deferred<{ ok: true }>();
    io.update.mockReturnValueOnce(pending.promise);
    const view = mount();
    const dialog = await open();
    fireEvent.change(await within(dialog).findByRole("textbox", { name: "שם תצוגה" }), {
      target: { value: "טיוטת A" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "שמור" }));
    Object.assign(io.auth, { sessionUserId: null, userId: null, role: null });
    view.rerender();
    expect(screen.queryByRole("dialog", { name: "עריכת לקוח" })).not.toBeInTheDocument();
    pending.resolve({ ok: true });
    await act(async () => pending.promise);
    expect(io.success).not.toHaveBeenCalled();
    Object.assign(io.auth, { sessionUserId: "admin-a", userId: "admin-a", role: "admin" });
    view.rerender();
    const dialogB = await open(1);
    expect(await within(dialogB).findByRole("textbox", { name: "שם תצוגה" })).toHaveValue(
      b.display_name,
    );
  });
});
