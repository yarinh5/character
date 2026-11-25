import type { ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ navigate: vi.fn() }));

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
  fetchCharacterLiveAvailability: vi.fn().mockResolvedValue(new Map([["character-a", "available"]])),
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
  const channel = { on: vi.fn(), subscribe: vi.fn() };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);

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
        limit: () => Promise.resolve({ data: [], error: null }),
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

const Page = (Route as unknown as { component: ComponentType }).component;

describe("client chat accessibility regressions", () => {
  it("keeps every icon-only chat action named after hydration", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <Page />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("button", { name: "חזרה לרשימת השיחות" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "דיווח על השיחה" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "הסרת השיחה מהרשימה" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "בחירת סטיקר לשליחה" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "שליחת הודעה" })).toBeInTheDocument();
  });
});
