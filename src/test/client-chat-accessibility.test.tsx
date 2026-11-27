import type { ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ navigate: vi.fn() }));
const realtime = vi.hoisted(() => ({
  messages: [] as unknown[],
  pendingMessages: null as null | Promise<{ data: unknown[]; error: null }>,
  message: null as null | ((payload: { eventType: string; new: unknown }) => void),
  status: null as null | ((status: string) => void),
  system: null as null | ((payload: { extension: string; status: string }) => void),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({
    ...(options as object),
    useParams: () => ({ conversationId: "conversation-a" }),
  }),
  useNavigate: () => io.navigate,
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "client-a", email: "client@example.test" } }),
}));
vi.mock("@/lib/activeConversation", () => ({ useActiveConversation: vi.fn() }));
vi.mock("@/lib/conversationPresence", () => ({
  useConversationPresence: () => ({
    typingUsers: [],
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  }),
}));
vi.mock("@/lib/readStates", () => ({ fetchReadSummary: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/analyticsEvents", () => ({ trackAnalyticsEvent: vi.fn() }));
vi.mock("@/lib/characterAvailability", () => ({
  fetchCharacterLiveAvailability: vi
    .fn()
    .mockResolvedValue(new Map([["character-a", "available"]])),
}));
vi.mock("@/hooks/useMessageAttachmentAccessMap", () => ({
  useMessageAttachmentAccessMap: () => ({
    accessByAttachmentId: {},
    getAccessStatus: () => "error",
    refreshAttachment: vi.fn(),
  }),
}));
vi.mock("@/components/common/ChatAvatar", () => ({ ChatAvatar: () => null }));
vi.mock("@/components/chat/MessageAttachment", () => ({ MessageAttachment: () => null }));
vi.mock("@/components/chat/ClientMediaUploadButton", () => ({
  ClientMediaUploadButton: () => null,
}));
vi.mock("@/components/chat/MessageSticker", () => ({
  MessageSticker: () => null,
  StickerHydrationPlaceholder: () => null,
}));
vi.mock("@/components/chat/StickerPicker", () => ({ StickerPicker: () => null }));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/integrations/supabase/client", () => {
  const channel = {
    on: vi.fn((type: string, _filter: unknown, callback: (...args: unknown[]) => void) => {
      if (type === "system") realtime.system = callback as typeof realtime.system;
      if (type === "postgres_changes") realtime.message = callback as typeof realtime.message;
      return channel;
    }),
    subscribe: vi.fn((callback?: (status: string) => void) => {
      realtime.status = callback ?? null;
      return channel;
    }),
  };

  function from(table: string) {
    if (table === "conversations") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: {
                  id: "conversation-a",
                  client_id: "client-a",
                  status: "open",
                  client_hidden_at: null,
                  characters: {
                    id: "character-a",
                    name: "דמות QA",
                    avatar_url: null,
                    availability_status: "available",
                  },
                },
                error: null,
              }),
          }),
        }),
      };
    }
    if (table === "messages") {
      const query = {
        eq: () => query,
        order: () => query,
        limit: () =>
          realtime.pendingMessages ?? Promise.resolve({ data: realtime.messages, error: null }),
      };
      return { select: () => query };
    }
    if (table === "message_attachments" || table === "message_stickers") {
      const result = { data: [], error: null };
      const query = {
        eq: () => query,
        order: () => Promise.resolve(result),
        then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
      };
      return { select: () => query };
    }
    if (table === "credit_wallets") {
      return { select: () => ({ maybeSingle: () => Promise.resolve({ data: { balance: 10 } }) }) };
    }
    if (table === "profiles") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: { display_name: "לקוח QA", avatar_url: null } }),
          }),
        }),
      };
    }
    throw new Error(`Unexpected Supabase table read: ${table}`);
  }

  return {
    supabase: {
      from,
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      channel: () => channel,
      removeChannel: vi.fn(),
    },
  };
});

import { Route } from "@/routes/app.chat.$conversationId";
import { supabase } from "@/integrations/supabase/client";

const Page = (Route as unknown as { component: ComponentType }).component;

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  realtime.messages = [];
  realtime.pendingMessages = null;
  realtime.message = null;
  realtime.status = null;
  realtime.system = null;
});

function renderChat() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Page />
    </QueryClientProvider>,
  );
}

describe("client chat accessibility regressions", () => {
  it("keeps a realtime message when the initial query returns an older snapshot", async () => {
    let resolveMessages!: (result: { data: unknown[]; error: null }) => void;
    realtime.pendingMessages = new Promise((resolve) => {
      resolveMessages = resolve;
    });
    renderChat();
    await waitFor(() => expect(realtime.message).not.toBeNull());
    const message = {
      id: "message-before-initial-load",
      conversation_id: "conversation-a",
      sender_type: "client",
      sender_id: "client-a",
      content: "Message before initial load",
      created_at: "2026-11-27T10:00:00.000Z",
      is_read: false,
    };
    act(() => realtime.message?.({ eventType: "INSERT", new: message }));
    await act(async () => resolveMessages({ data: [], error: null }));
    expect(await screen.findByText("Message before initial load")).toBeInTheDocument();
  });

  it("reconciles a message missed before postgres changes became ready", async () => {
    renderChat();
    await screen.findByRole("textbox", { name: "הודעה" });
    realtime.messages = [
      {
        id: "message-catch-up",
        conversation_id: "conversation-a",
        sender_type: "operator",
        sender_id: "operator-a",
        content: "Catch-up message",
        created_at: "2026-11-27T10:00:00.000Z",
        is_read: false,
        message_attachments: [],
        message_stickers: null,
      },
    ];

    expect(screen.queryByText("Catch-up message")).not.toBeInTheDocument();
    act(() => {
      realtime.status?.("SUBSCRIBED");
      realtime.system?.({ extension: "postgres_changes", status: "ok" });
    });
    expect(await screen.findByText("Catch-up message")).toBeInTheDocument();
  });

  it("keeps every icon-only chat action named after hydration", async () => {
    renderChat();

    expect(await screen.findByRole("button", { name: "חזרה לרשימת השיחות" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "דיווח על השיחה" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "הסרת השיחה מהרשימה" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "בחירת סטיקר לשליחה" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "שליחת הודעה" })).toBeInTheDocument();
  });

  it("gives the message composer a stable accessible name", async () => {
    renderChat();

    expect(await screen.findByRole("textbox", { name: "הודעה" })).toBeInTheDocument();
  });

  it("associates both report fields with their visible labels", async () => {
    const user = userEvent.setup();
    renderChat();

    await user.click(await screen.findByRole("button", { name: "דיווח על השיחה" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByRole("textbox", { name: "סיבה" })).toEqual(dialog.getByLabelText("סיבה"));
    expect(dialog.getByRole("textbox", { name: "פירוט (אופציונלי)" })).toEqual(
      dialog.getByLabelText("פירוט (אופציונלי)"),
    );
  });

  it("describes hiding as reversible without promising a new conversation", async () => {
    const user = userEvent.setup();
    renderChat();

    await user.click(await screen.findByRole("button", { name: "הסרת השיחה מהרשימה" }));
    const dialog = await screen.findByRole("dialog", { name: "הסתרת שיחה מהרשימה" });
    expect(dialog).toHaveAccessibleDescription(
      "השיחה תוסתר רק מהרשימה שלך. ההסתרה לא מוחקת את ההיסטוריה. אפשר לחזור לשיחה דרך אותה דמות.",
    );
    expect(within(dialog).getByRole("button", { name: "הסתר שיחה" })).toBeEnabled();
  });

  it.each([
    ["הסרת השיחה מהרשימה", "Escape"],
    ["הסרת השיחה מהרשימה", "Cancel"],
    ["דיווח על השיחה", "Escape"],
    ["דיווח על השיחה", "Cancel"],
  ])("restores focus to %s after %s without changing the chat", async (name, method) => {
    vi.clearAllMocks();
    const user = userEvent.setup();
    renderChat();

    const opener = await screen.findByRole("button", { name });
    opener.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    if (method === "Escape") {
      await user.keyboard("{Escape}");
    } else {
      const cancel = within(dialog).getByRole("button", { name: "ביטול" });
      cancel.focus();
      await user.keyboard("{Enter}");
    }

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(opener).toHaveFocus();
    });
    expect(supabase.rpc).not.toHaveBeenCalledWith(
      "hide_conversation_for_client",
      expect.anything(),
    );
    expect(io.navigate).not.toHaveBeenCalled();
  });
});
