import type { ComponentType, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Reply = { data: unknown; error: unknown; status?: number };

const ids = {
  clientA: "00000000-0000-4000-8000-000000000001",
  clientB: "00000000-0000-4000-8000-000000000002",
  characterA: "00000000-0000-4000-8000-000000000101",
  characterB: "00000000-0000-4000-8000-000000000102",
  conversation: "00000000-0000-4000-8000-000000000201",
};

const profile = {
  id: ids.characterA,
  name: "מאיה",
  avatar_url: null,
  fictional_age: 29,
  short_description: "תיאור קצר",
  full_description: null,
  personality: null,
  category: "חברות",
  interests: ["מוזיקה"],
  availability_status: "available",
  city_name: null,
  gallery_images: null,
  is_favorite: false,
  conversation_id: null,
};

const io = vi.hoisted(() => ({
  auth: {
    loading: false,
    role: "client" as "client" | "operator" | "admin" | null,
    userId: "00000000-0000-4000-8000-000000000001" as string | null,
    sessionUserId: "00000000-0000-4000-8000-000000000001" as string | null,
  },
  characterId: "00000000-0000-4000-8000-000000000101",
  profileRead: vi.fn<() => Promise<Reply>>(),
  favoriteWrite: vi.fn<() => Promise<Reply>>(),
  conversationWrite: vi.fn<() => Promise<Reply>>(),
  analytics: vi.fn<() => Promise<unknown>>(),
  navigate: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: unknown }) => ({
    ...options,
    useParams: () => ({ characterId: io.characterId }),
  }),
  useNavigate: () => io.navigate,
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
      if (name === "get_character_profile") return io.profileRead();
      if (name === "set_character_favorite") return io.favoriteWrite();
      if (name === "start_or_get_conversation") return io.conversationWrite();
      throw new Error(`Unexpected RPC: ${name}`);
    },
  },
}));

vi.mock("@/lib/analyticsEvents", () => ({ trackAnalyticsEvent: io.analytics }));
vi.mock("sonner", () => ({ toast: { success: io.success, error: io.error } }));

import { Route } from "@/routes/app.characters.$characterId";

const Page = (Route as unknown as { component: ComponentType }).component;

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
      <Page />
    </QueryClientProvider>,
  );
  return {
    ...view,
    client,
    rerenderPage: () =>
      view.rerender(
        <QueryClientProvider client={client}>
          <Page />
        </QueryClientProvider>,
      ),
  };
}

beforeEach(() => {
  Object.assign(io.auth, {
    loading: false,
    role: "client",
    userId: ids.clientA,
    sessionUserId: ids.clientA,
  });
  io.characterId = ids.characterA;
  io.profileRead.mockReset().mockResolvedValue({ data: [profile], error: null });
  io.favoriteWrite.mockReset().mockResolvedValue({
    data: { character_id: ids.characterA, is_favorite: true, idempotent: false },
    error: null,
  });
  io.conversationWrite.mockReset().mockResolvedValue({ data: ids.conversation, error: null });
  io.analytics.mockReset().mockResolvedValue(undefined);
  io.navigate.mockReset().mockResolvedValue(undefined);
  io.success.mockReset();
  io.error.mockReset();
});

describe("client character profile", () => {
  it("waits for initialized matching client identity before reading", async () => {
    io.auth.loading = true;
    const view = mount();
    expect(io.profileRead).not.toHaveBeenCalled();

    io.auth.loading = false;
    io.auth.sessionUserId = ids.clientB;
    view.rerenderPage();
    expect(io.profileRead).not.toHaveBeenCalled();

    io.auth.sessionUserId = ids.clientA;
    view.rerenderPage();
    expect(await screen.findByRole("heading", { name: "מאיה" })).toBeInTheDocument();
    expect(io.profileRead).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a verified missing profile from malformed data and accepts legal nulls", async () => {
    io.profileRead.mockResolvedValueOnce({ data: [], error: null });
    const missing = mount();
    expect(await screen.findByText("הדמות אינה זמינה")).toBeInTheDocument();
    missing.unmount();

    io.profileRead.mockResolvedValueOnce({
      data: [{ ...profile, fictional_age: Number.NaN }],
      error: null,
    });
    const malformed = mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("טעינת הפרופיל נכשלה");
    expect(screen.queryByText("הדמות אינה זמינה")).not.toBeInTheDocument();
    malformed.unmount();

    io.profileRead.mockResolvedValueOnce({
      data: [{ ...profile, interests: null, gallery_images: null, city_name: null }],
      error: null,
    });
    mount();
    expect(await screen.findByRole("heading", { name: "מאיה" })).toBeInTheDocument();
  });

  it("keeps cached profile data with one retryable warning after a failed refresh", async () => {
    io.profileRead
      .mockResolvedValueOnce({ data: [profile], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "refresh failed" } })
      .mockResolvedValueOnce({ data: [{ ...profile, name: "מאיה מעודכנת" }], error: null });
    const view = mount();
    expect(await screen.findByRole("heading", { name: "מאיה" })).toBeInTheDocument();

    await act(async () => {
      await view.client.invalidateQueries({
        queryKey: ["character-profile", ids.clientA, ids.characterA],
      });
    });
    expect(screen.getByRole("heading", { name: "מאיה" })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("רענון הפרופיל נכשל");
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "נסה שוב" }));
    expect(await screen.findByRole("heading", { name: "מאיה מעודכנת" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("validates favorite replies, accepts idempotency and blocks same-tick double submit", async () => {
    const pending = deferred<Reply>();
    io.favoriteWrite.mockReturnValue(pending.promise);
    mount();
    await screen.findByRole("heading", { name: "מאיה" });
    const favorite = screen.getByRole("button", { name: "הוספה למועדפים" });
    fireEvent.click(favorite);
    fireEvent.click(favorite);
    expect(io.favoriteWrite).toHaveBeenCalledTimes(1);
    io.profileRead.mockResolvedValue({ data: [{ ...profile, is_favorite: true }], error: null });
    await act(async () => {
      pending.resolve({
        data: { character_id: ids.characterA, is_favorite: true, idempotent: true },
        error: null,
      });
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "הסרה ממועדפים" })).toBeEnabled(),
    );

    io.favoriteWrite.mockResolvedValueOnce({
      data: { character_id: ids.characterB, is_favorite: false },
      error: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "הסרה ממועדפים" }));
    await waitFor(() => expect(io.error).toHaveBeenCalled());
  });

  it("locks conversation opening before pending telemetry and validates the returned id", async () => {
    const telemetry = deferred<unknown>();
    io.analytics.mockReturnValue(telemetry.promise);
    mount();
    await screen.findByRole("heading", { name: "מאיה" });
    const start = screen.getByRole("button", { name: "התחל שיחה" });
    fireEvent.click(start);
    fireEvent.click(start);
    expect(io.analytics).toHaveBeenCalledTimes(1);
    expect(io.conversationWrite).not.toHaveBeenCalled();

    await act(async () => telemetry.resolve(undefined));
    await waitFor(() => expect(io.conversationWrite).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(io.navigate).toHaveBeenCalledWith({
        to: "/app/chat/$conversationId",
        params: { conversationId: ids.conversation },
      }),
    );

    io.navigate.mockClear();
    io.analytics.mockResolvedValue(undefined);
    io.conversationWrite.mockResolvedValueOnce({ data: "not-a-conversation-id", error: null });
    fireEvent.click(screen.getByRole("button", { name: "התחל שיחה" }));
    await waitFor(() => expect(io.error).toHaveBeenCalled());
    expect(io.navigate).not.toHaveBeenCalled();
  });

  it("uses an existing conversation directly and suppresses late navigation and toast after identity change", async () => {
    io.profileRead.mockResolvedValueOnce({
      data: [{ ...profile, conversation_id: ids.conversation }],
      error: null,
    });
    const direct = mount();
    await screen.findByRole("heading", { name: "מאיה" });
    fireEvent.click(screen.getByRole("button", { name: "המשך שיחה" }));
    await waitFor(() => expect(io.navigate).toHaveBeenCalled());
    expect(io.analytics).not.toHaveBeenCalled();
    expect(io.conversationWrite).not.toHaveBeenCalled();
    direct.unmount();

    io.navigate.mockClear();
    io.profileRead.mockResolvedValue({ data: [profile], error: null });
    const conversation = deferred<Reply>();
    io.conversationWrite.mockReturnValue(conversation.promise);
    const view = mount();
    await screen.findByRole("heading", { name: "מאיה" });
    fireEvent.click(screen.getByRole("button", { name: "התחל שיחה" }));
    await waitFor(() => expect(io.conversationWrite).toHaveBeenCalled());
    io.auth.userId = io.auth.sessionUserId = ids.clientB;
    view.rerenderPage();
    await act(async () => conversation.reject(new Error("late failure")));
    expect(io.navigate).not.toHaveBeenCalled();
    expect(io.error).not.toHaveBeenCalled();
  });

  it("does not let a late character response populate a different character route", async () => {
    const oldRead = deferred<Reply>();
    io.profileRead.mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce({
      data: [{ ...profile, id: ids.characterB, name: "נועה" }],
      error: null,
    });
    const view = mount();
    io.characterId = ids.characterB;
    view.rerenderPage();
    expect(await screen.findByRole("heading", { name: "נועה" })).toBeInTheDocument();
    await act(async () => oldRead.resolve({ data: [profile], error: null }));
    expect(screen.getByRole("heading", { name: "נועה" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "מאיה" })).not.toBeInTheDocument();
  });
});
