import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

const testState = vi.hoisted(() => ({
  concurrencyMode: "open" as "open" | "warning" | "lock",
  responsibility: "other" as "mine" | "available" | "other" | "closed",
  cycleId: null as string | null,
}));
const rpcMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const startTypingMock = vi.hoisted(() => vi.fn());
const stopTypingMock = vi.hoisted(() => vi.fn());
const stableMocks = vi.hoisted(() => ({
  applySuccessfulSendCycle: vi.fn((_ticket: unknown, _result: unknown, effect?: () => void) => {
    effect?.();
    return true;
  }),
  beginRequest: vi.fn(),
  claimConversation: vi.fn(),
  completeRequest: vi.fn(),
  isCurrent: vi.fn(() => true),
  operator: { id: "00000000-0000-4000-8000-000000000011", full_name: "עובד בדיקה" },
  refreshResponsibility: vi.fn(async () => undefined),
  refetch: vi.fn(async () => undefined),
  releaseOwnership: vi.fn(),
  user: { id: "00000000-0000-4000-8000-000000000021" },
}));

const conversationId = "00000000-0000-4000-8000-000000000001";
const operatorId = "00000000-0000-4000-8000-000000000011";
const cycleId = "00000000-0000-4000-8000-000000000101";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: unknown }) => ({
    ...options,
    useParams: () => ({ conversationId }),
  }),
  useNavigate: () => navigateMock,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: stableMocks.user }),
}));

vi.mock("@/components/operator/OperatorLayout", () => ({
  ConversationStatusBadge: () => <span>פתוחה</span>,
  useOperator: () => ({
    isAdmin: false,
    operator: stableMocks.operator,
  }),
}));

vi.mock("@/hooks/useStickerSend", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/hooks/useStickerSend")>();
  return {
    ...original,
    useOperatorSendOwnership: () => ({
      sendScope: {
        conversationId,
        generation: 4,
        beginRequest: stableMocks.beginRequest.mockImplementation(() => ({
          conversationId,
          generation: 4,
          requestId: 1,
          expectedCycleId: testState.cycleId,
        })),
        completeRequest: stableMocks.completeRequest,
        isCurrent: stableMocks.isCurrent,
      },
      responsibility: testState.responsibility,
      responsibilityCycleId: testState.cycleId,
      refreshResponsibility: stableMocks.refreshResponsibility,
      applySuccessfulSendCycle: stableMocks.applySuccessfulSendCycle,
      releaseOwnership: stableMocks.releaseOwnership,
    }),
  };
});

vi.mock("@/components/operator/OperatorMediaPicker", () => ({
  OperatorMediaPicker: ({ open, readOnly }: { open: boolean; readOnly?: boolean }) =>
    open ? (
      <div data-testid="media-picker" data-readonly={String(Boolean(readOnly))}>
        media picker
      </div>
    ) : null,
}));

vi.mock("@/components/chat/StickerPicker", () => ({
  StickerPicker: ({ open, readOnly }: { open: boolean; readOnly?: boolean }) =>
    open ? (
      <div data-testid="sticker-picker" data-readonly={String(Boolean(readOnly))}>
        sticker picker
      </div>
    ) : null,
}));

vi.mock("@/components/operator/OperatorNewQueueList", () => ({
  OperatorNewQueuePanel: () => <div />,
}));
vi.mock("@/hooks/useOperatorNewQueue", () => ({
  operatorNewQueueClaimError: () => "claim failed",
  useOperatorNewQueue: () => ({
    items: [],
    claimingId: null,
    isLoading: false,
    error: null,
    dataUpdatedAt: 0,
    refetch: stableMocks.refetch,
    claimConversation: stableMocks.claimConversation,
  }),
}));
vi.mock("@/lib/activeConversation", () => ({ useActiveConversation: vi.fn() }));
vi.mock("@/lib/conversationPresence", () => ({
  useConversationPresence: () => ({
    activeUsers: [],
    typingUsers: [],
    startTyping: startTypingMock,
    stopTyping: stopTypingMock,
  }),
}));
vi.mock("@/hooks/useMessageAttachmentAccessMap", () => ({
  useMessageAttachmentAccessMap: () => ({
    accessByAttachmentId: {},
    getAccessStatus: () => "idle",
    refreshAttachment: vi.fn(),
  }),
}));

type QueryResult = { data: unknown; error: null; count?: number };
type Query = {
  eq: (...args: unknown[]) => Query;
  in: (...args: unknown[]) => Query;
  limit: (...args: unknown[]) => Query;
  maybeSingle: () => Promise<QueryResult>;
  or: (...args: unknown[]) => Query;
  order: (...args: unknown[]) => Query;
  select: (...args: unknown[]) => Query;
  then: <TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) => PromiseLike<TResult1 | TResult2>;
  update: (...args: unknown[]) => Query;
};

function resultFor(table: string): QueryResult {
  if (table === "conversations") {
    return {
      data: {
        id: conversationId,
        client_id: "00000000-0000-4000-8000-000000000031",
        character_id: "00000000-0000-4000-8000-000000000041",
        status: "open",
        assigned_operator_id: testState.responsibility === "mine" ? operatorId : null,
        characters: {
          id: "character",
          name: "דמות",
          avatar_url: null,
          availability_status: "available",
        },
      },
      error: null,
      count: 1,
    };
  }
  if (table === "character_operator_assignments")
    return { data: { id: "assignment" }, error: null };
  if (table === "profiles") {
    return {
      data: {
        display_name: "לקוח",
        email: null,
        avatar_url: null,
        created_at: "2026-01-01T00:00:00Z",
      },
      error: null,
    };
  }
  if (table === "system_settings") {
    return {
      data: [
        { key: "concurrency_mode", value: testState.concurrencyMode },
        { key: "lock_timeout_minutes", value: 10 },
      ],
      error: null,
    };
  }
  return { data: [], error: null, count: 0 };
}

function queryFor(table: string): Query {
  const result = () => resultFor(table);
  const query = {} as Query;
  Object.assign(query, {
    eq: () => query,
    in: () => query,
    limit: () => query,
    maybeSingle: () => Promise.resolve(result()),
    or: () => query,
    order: () => query,
    select: () => query,
    then: <TResult1 = QueryResult, TResult2 = never>(
      resolve?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
      reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => Promise.resolve(result()).then(resolve, reject),
    update: () => query,
  });
  return query;
}

const channel = {
  on: vi.fn(() => channel),
  subscribe: vi.fn(() => channel),
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    channel: vi.fn(() => channel),
    from: vi.fn((table: string) => queryFor(table)),
    removeChannel: vi.fn(),
    rpc: rpcMock,
  },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { OperatorChatPage } from "@/routes/operator.chat.$conversationId";

beforeEach(() => {
  testState.concurrencyMode = "open";
  testState.responsibility = "other";
  testState.cycleId = null;
  rpcMock.mockReset();
  rpcMock.mockImplementation((name: string) => {
    if (name === "get_operator_conversation_client_profile") {
      return {
        maybeSingle: () =>
          Promise.resolve({
            data: { age: null, interests: null, conversation_preferences: null },
            error: null,
          }),
      };
    }
    if (name === "get_my_operator_client_block_status") {
      return Promise.resolve({ data: { is_blocked: false }, error: null });
    }
    if (name === "send_operator_message") {
      return Promise.resolve({ data: { cycle_id: cycleId }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
});

async function renderChat() {
  const view = render(
    <TooltipProvider>
      <OperatorChatPage />
    </TooltipProvider>,
  );
  await screen.findByPlaceholderText(/השיחה בטיפול עובד אחר|כתוב כ/);
  return view;
}

describe("operator chat read-only responsibility", () => {
  it.each(["open", "warning", "lock"] as const)(
    "keeps responsibility=other read-only in %s mode without send or lock acquisition",
    async (mode) => {
      testState.concurrencyMode = mode;
      await renderChat();

      const composer = screen.getByPlaceholderText("השיחה בטיפול עובד אחר");
      expect(composer).toBeDisabled();
      expect(screen.getByRole("button", { name: "בחירת מדיה לשליחה" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "בחירת סטיקר לשליחה" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "שליחת הודעה" })).toBeDisabled();
      fireEvent.keyDown(composer, { key: "Enter" });

      expect(rpcMock).not.toHaveBeenCalledWith("send_operator_message", expect.any(Object));
      expect(rpcMock).not.toHaveBeenCalledWith("acquire_conversation_lock", expect.any(Object));
    },
  );

  it.each(["mine", "available"] as const)(
    "keeps %s writable and sends only after an explicit action",
    async (responsibility) => {
      testState.responsibility = responsibility;
      testState.cycleId = responsibility === "mine" ? cycleId : null;
      await renderChat();

      expect(rpcMock).not.toHaveBeenCalledWith("send_operator_message", expect.any(Object));
      const composer = screen.getByPlaceholderText(/כתוב כ/);
      fireEvent.change(composer, { target: { value: "הודעת בדיקה" } });
      fireEvent.click(screen.getByRole("button", { name: "שליחת הודעה" }));

      await waitFor(() =>
        expect(rpcMock).toHaveBeenCalledWith(
          "send_operator_message",
          expect.objectContaining({ _expected_cycle_id: testState.cycleId }),
        ),
      );
    },
  );

  it("keeps an already-open picker visible but read-only after responsibility is lost", async () => {
    testState.responsibility = "mine";
    testState.cycleId = cycleId;
    const view = await renderChat();
    fireEvent.click(screen.getByRole("button", { name: "בחירת מדיה לשליחה" }));
    expect(screen.getByTestId("media-picker")).toHaveAttribute("data-readonly", "false");

    testState.responsibility = "other";
    testState.cycleId = null;
    view.rerender(
      <TooltipProvider>
        <OperatorChatPage />
      </TooltipProvider>,
    );

    expect(screen.getByTestId("media-picker")).toHaveAttribute("data-readonly", "true");
    expect(screen.getByPlaceholderText("השיחה בטיפול עובד אחר")).toBeDisabled();
  });
});
