import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { OperatorSendTicket } from "@/hooks/useStickerSend";
import { toast } from "sonner";

const testState = vi.hoisted(() => ({
  concurrencyMode: "open" as "open" | "warning" | "lock",
  conversationId: "00000000-0000-4000-8000-000000000001",
  conversationStatus: "open" as "open" | "closed",
  foreignLock: false,
  realOwnership: false,
  responsibility: "other" as "mine" | "available" | "other" | "closed",
  cycleId: null as string | null,
  readAccessState: "allowed" as "checking" | "allowed" | "denied" | "error",
  readAccessGeneration: 0,
}));
const rpcMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const startTypingMock = vi.hoisted(() => vi.fn());
const stopTypingMock = vi.hoisted(() => vi.fn());
type PickerProbeProps = {
  open: boolean;
  readOnly?: boolean;
  operatorSendGeneration: number;
  onSent: (
    result: { cycle_id: string },
    conversationId: string,
    ticket: OperatorSendTicket,
  ) => boolean;
};
const recordPicker = vi.hoisted(() => vi.fn<(kind: string, props: PickerProbeProps) => void>());
const stableMocks = vi.hoisted(() => ({
  applySuccessfulSendCycle: vi.fn((_ticket: unknown, _result: unknown, effect?: () => void) => {
    effect?.();
    return true;
  }),
  beginRequest: vi.fn(),
  claimConversation: vi.fn(),
  completeRequest: vi.fn(),
  isCurrent: vi.fn(() => true),
  invalidate: vi.fn(),
  operator: { id: "00000000-0000-4000-8000-000000000011", full_name: "עובד בדיקה" },
  refreshResponsibility: vi.fn(async () => undefined),
  revalidateReadAccess: vi.fn(),
  suspendReadAccess: vi.fn(),
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
    useParams: () => ({ conversationId: testState.conversationId }),
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
    useOperatorSendOwnership: (...args: Parameters<typeof original.useOperatorSendOwnership>) =>
      testState.realOwnership
        ? original.useOperatorSendOwnership(...args)
        : {
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
              invalidate: stableMocks.invalidate,
            },
            responsibility: testState.responsibility,
            responsibilityCycleId: testState.cycleId,
            refreshResponsibility: stableMocks.refreshResponsibility,
            applySuccessfulSendCycle: stableMocks.applySuccessfulSendCycle,
            releaseOwnership: stableMocks.releaseOwnership,
          },
  };
});

vi.mock("@/components/operator/OperatorMediaPicker", () => ({
  OperatorMediaPicker: (props: PickerProbeProps) => {
    if (!props.open) return null;
    recordPicker("media", props);
    return (
      <div data-testid="media-picker" data-readonly={String(Boolean(props.readOnly))}>
        media picker
      </div>
    );
  },
}));

vi.mock("@/hooks/useConversationReadAccess", () => ({
  useConversationReadAccess: () => ({
    state: testState.readAccessState,
    generation: testState.readAccessGeneration,
    revalidate: stableMocks.revalidateReadAccess,
    suspend: stableMocks.suspendReadAccess,
  }),
}));

vi.mock("@/components/chat/StickerPicker", () => ({
  StickerPicker: (props: PickerProbeProps) => {
    if (!props.open) return null;
    recordPicker("sticker", props);
    return (
      <div data-testid="sticker-picker" data-readonly={String(Boolean(props.readOnly))}>
        sticker picker
      </div>
    );
  },
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
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let conversationMaybeSinglePromise: Promise<QueryResult> | null = null;
let messageRows: unknown[] = [];
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
        id: testState.conversationId,
        client_id: "00000000-0000-4000-8000-000000000031",
        character_id: "00000000-0000-4000-8000-000000000041",
        status: testState.conversationStatus,
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
  if (table === "conversation_locks") {
    return {
      data: testState.foreignLock
        ? {
            conversation_id: testState.conversationId,
            locked_by_operator_id: "00000000-0000-4000-8000-000000000012",
            locked_by_user_id: "00000000-0000-4000-8000-000000000022",
            locked_at: new Date().toISOString(),
            last_activity_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            released_at: null,
            release_reason: null,
            operators: { full_name: "עמית" },
          }
        : null,
      error: null,
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
  if (table === "messages") return { data: messageRows, error: null };
  return { data: [], error: null, count: 0 };
}

function queryFor(table: string): Query {
  const result = () => resultFor(table);
  const query = {} as Query;
  Object.assign(query, {
    eq: () => query,
    in: () => query,
    limit: () => query,
    maybeSingle: () =>
      table === "conversations" && conversationMaybeSinglePromise
        ? conversationMaybeSinglePromise
        : Promise.resolve(result()),
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

type ChannelDouble = {
  status: (status: string) => void;
  on: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
};

type ChannelRegistration = [
  type: string,
  filter: Record<string, string | undefined>,
  callback: (...args: unknown[]) => void,
];

const channels: ChannelDouble[] = [];
function createChannel(): ChannelDouble {
  const channel: ChannelDouble = {
    status: (_status: string) => {},
    on: vi.fn(
      (
        _type: string,
        _filter: Record<string, string | undefined>,
        _callback: ChannelRegistration[2],
      ) => channel,
    ),
    subscribe: vi.fn((callback: (status: string) => void) => {
      channel.status = callback;
      return channel;
    }),
  };
  channels.push(channel);
  return channel;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    channel: vi.fn(() => createChannel()),
    from: vi.fn((table: string) => queryFor(table)),
    removeChannel: vi.fn((channel: ReturnType<typeof createChannel>) => channel.status("CLOSED")),
    rpc: rpcMock,
  },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { OperatorChatPage } from "@/routes/operator.chat.$conversationId";

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  channels.length = 0;
  messageRows = [];
  recordPicker.mockClear();
  stableMocks.applySuccessfulSendCycle.mockClear();
  stableMocks.revalidateReadAccess.mockClear();
  stableMocks.suspendReadAccess.mockClear();
  stableMocks.refreshResponsibility.mockClear();
  testState.concurrencyMode = "open";
  testState.conversationId = conversationId;
  testState.conversationStatus = "open";
  testState.foreignLock = false;
  testState.realOwnership = false;
  testState.responsibility = "other";
  testState.cycleId = null;
  testState.readAccessState = "allowed";
  testState.readAccessGeneration = 0;
  conversationMaybeSinglePromise = null;
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
    if (name === "get_operator_conversation_responsibility") {
      return Promise.resolve({
        data: [{ state: testState.responsibility, cycle_id: testState.cycleId }],
        error: null,
      });
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
  await screen.findByPlaceholderText(/השיחה בטיפול עובד אחר|כתוב כ|השיחה נעולה כרגע לעובד אחר/);
  return view;
}

describe("operator chat read-only responsibility", () => {
  it("reconciles a missed message only after postgres changes is ready", async () => {
    await renderChat();
    messageRows = [
      {
        id: "message-catch-up",
        conversation_id: conversationId,
        sender_type: "client",
        sender_id: "00000000-0000-4000-8000-000000000031",
        content: "Operator catch-up message",
        created_at: "2026-11-27T10:00:00.000Z",
        is_read: false,
        message_attachments: [],
        message_stickers: null,
      },
    ];
    const channel = [...channels]
      .reverse()
      .find((item) =>
        item.on.mock.calls.some(
          ([type, filter]) =>
            type === "postgres_changes" &&
            filter.table === "messages" &&
            filter.filter === `conversation_id=eq.${conversationId}`,
        ),
      );
    expect(channel).toBeDefined();
    const system = channel!.on.mock.calls.find(([type]) => type === "system")?.[2] as
      ((payload: { extension: string; status: string }) => void) | undefined;
    expect(system).toBeDefined();
    expect(screen.queryByText("Operator catch-up message")).not.toBeInTheDocument();
    act(() => {
      channel!.status("SUBSCRIBED");
      system?.({ extension: "postgres_changes", status: "ok" });
    });
    expect(await screen.findByText("Operator catch-up message")).toBeInTheDocument();
  });

  it("does not reconcile from a retired channel after read access is revoked", async () => {
    const view = await renderChat();
    const channel = [...channels]
      .reverse()
      .find((item) =>
        item.on.mock.calls.some(
          ([type, filter]) =>
            type === "postgres_changes" &&
            filter.table === "messages" &&
            filter.filter === `conversation_id=eq.${conversationId}`,
        ),
      );
    const system = channel?.on.mock.calls.find(([type]) => type === "system")?.[2] as
      ((payload: { extension: string; status: string }) => void) | undefined;
    expect(channel).toBeDefined();
    expect(system).toBeDefined();

    testState.readAccessState = "denied";
    testState.readAccessGeneration += 1;
    view.rerender(
      <TooltipProvider>
        <OperatorChatPage />
      </TooltipProvider>,
    );
    messageRows = [
      {
        id: "revoked-message",
        conversation_id: conversationId,
        sender_type: "client",
        sender_id: "00000000-0000-4000-8000-000000000031",
        content: "Revoked message",
        created_at: "2026-11-27T10:01:00.000Z",
        is_read: false,
      },
    ];
    act(() => {
      channel?.status("SUBSCRIBED");
      system?.({ extension: "postgres_changes", status: "ok" });
    });
    expect(screen.queryByText("Revoked message")).not.toBeInTheDocument();
  });

  it("names the icon-only header controls", async () => {
    await renderChat();

    expect(screen.getByRole("button", { name: "חזרה לרשימת השיחות" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "פתיחת פרטי הלקוח והערות" })).toBeInTheDocument();
  });

  it("names the composer independently of its read-only placeholder", async () => {
    await renderChat();

    expect(screen.getByRole("textbox", { name: "הודעה ללקוח" })).toBeDisabled();
  });

  it("names both fields in the client report dialog", async () => {
    await renderChat();
    fireEvent.click(screen.getAllByRole("button", { name: "דווח" })[0]);

    const dialog = screen.getByRole("dialog", { name: "דיווח על לקוח" });
    expect(within(dialog).getByRole("textbox", { name: "סיבה קצרה" })).toBeInTheDocument();
    expect(
      within(dialog).getByRole("textbox", { name: "הערות פנימיות (אופציונלי)" }),
    ).toBeInTheDocument();
  });

  it("returns focus to the report button when the dialog is canceled", async () => {
    await renderChat();
    const opener = screen.getAllByRole("button", { name: "דווח" })[0];
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "ביטול" }));

    await waitFor(() => expect(opener).toHaveFocus());
    expect(rpcMock).not.toHaveBeenCalledWith("report_client_as_operator", expect.anything());
  });

  it("returns focus inside the client details sheet when its block dialog is dismissed", async () => {
    await renderChat();
    fireEvent.click(screen.getByRole("button", { name: "פתיחת פרטי הלקוח והערות" }));
    const sheet = screen.getByRole("dialog", { name: "פרטי לקוח והערות" });
    const opener = within(sheet).getByRole("button", { name: "חסום לקוח" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "חסימת לקוח" });

    fireEvent.keyDown(within(dialog).getByRole("textbox", { name: "סיבה קצרה" }), {
      key: "Escape",
    });

    await waitFor(() => expect(opener).toHaveFocus());
    expect(sheet).toBeInTheDocument();
    expect(rpcMock).not.toHaveBeenCalledWith("block_client_for_operator", expect.anything());
  });

  it("does not fail closed when its own channel is disposed", async () => {
    const view = await renderChat();
    stableMocks.suspendReadAccess.mockClear();
    view.unmount();
    expect(stableMocks.suspendReadAccess).not.toHaveBeenCalled();
  });

  it("leaves subscription access reconciliation to the dedicated access channel", async () => {
    await renderChat();
    act(() => channels.at(-1)!.status("SUBSCRIBED"));
    expect(stableMocks.revalidateReadAccess).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("השיחה בטיפול עובד אחר")).toBeInTheDocument();
  });

  it.each(["CHANNEL_ERROR", "CLOSED", "TIMED_OUT"])(
    "still suspends access on active channel %s",
    async (status) => {
      await renderChat();
      stableMocks.suspendReadAccess.mockClear();
      act(() => channels.at(-1)!.status(status));
      expect(stableMocks.suspendReadAccess).toHaveBeenCalledOnce();
    },
  );

  it("refreshes responsibility from the published conversation assignment event", async () => {
    await renderChat();
    const registrations = channels.at(-1)!.on.mock.calls as ChannelRegistration[];
    expect(
      registrations.some(([, filter]) => filter.table === "conversation_handling_cycles"),
    ).toBe(false);
    const registration = registrations.find(([, filter]) => filter.table === "conversations");
    expect(registration?.[1].filter).toBe(`id=eq.${conversationId}`);
    stableMocks.refreshResponsibility.mockClear();
    act(() => registration![2]({}));
    expect(stableMocks.refreshResponsibility).toHaveBeenCalledOnce();
  });

  it.each(["open", "warning", "lock"] as const)(
    "keeps responsibility=other read-only in %s mode without send or lock acquisition",
    async (mode) => {
      testState.concurrencyMode = mode;
      testState.foreignLock = true;
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

  it.each([
    ["media", "בחירת מדיה לשליחה"],
    ["sticker", "בחירת סטיקר לשליחה"],
  ])(
    "accepts a current %s completion and rejects it after the read scope changes",
    async (kind, name) => {
      testState.responsibility = "mine";
      testState.cycleId = cycleId;
      testState.readAccessGeneration = 1;
      const view = await renderChat();
      fireEvent.click(screen.getByRole("button", { name }));
      const call = recordPicker.mock.calls.filter(([recorded]) => recorded === kind).at(-1);
      expect(call).toBeDefined();
      const props = call![1];
      const ticket = {
        conversationId,
        generation: props.operatorSendGeneration,
        requestId: 9,
        expectedCycleId: cycleId,
      };
      const result = { cycle_id: cycleId };
      expect(props.onSent(result, conversationId, ticket)).toBe(true);
      expect(stableMocks.applySuccessfulSendCycle.mock.lastCall?.[0]).toEqual({
        ...ticket,
        generation: 4,
      });

      testState.readAccessGeneration = 2;
      view.rerender(
        <TooltipProvider>
          <OperatorChatPage />
        </TooltipProvider>,
      );
      stableMocks.applySuccessfulSendCycle.mockClear();
      expect(props.onSent(result, conversationId, ticket)).toBe(false);
      expect(stableMocks.applySuccessfulSendCycle).not.toHaveBeenCalled();
    },
  );

  it("removes sensitive UI state immediately when read access is revoked", async () => {
    testState.responsibility = "mine";
    testState.cycleId = cycleId;
    const view = await renderChat();
    const composer = screen.getByPlaceholderText(/כתוב כ/);
    fireEvent.change(composer, { target: { value: "טיוטה סודית" } });
    fireEvent.click(screen.getByRole("button", { name: "בחירת מדיה לשליחה" }));
    expect(screen.getByTestId("media-picker")).toBeInTheDocument();

    testState.readAccessState = "denied";
    testState.readAccessGeneration = 1;
    view.rerender(
      <TooltipProvider>
        <OperatorChatPage />
      </TooltipProvider>,
    );

    expect(screen.getByText("הגישה לשיחה בוטלה")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("טיוטה סודית")).not.toBeInTheDocument();
    expect(screen.queryByTestId("media-picker")).not.toBeInTheDocument();
    await waitFor(() => expect(stableMocks.invalidate).toHaveBeenCalled());

    testState.readAccessState = "allowed";
    view.rerender(
      <TooltipProvider>
        <OperatorChatPage />
      </TooltipProvider>,
    );
    await screen.findByPlaceholderText(/כתוב כ/);
    expect(screen.queryByDisplayValue("טיוטה סודית")).not.toBeInTheDocument();
    expect(screen.queryByTestId("media-picker")).not.toBeInTheDocument();
  });

  it("keeps a delayed authorized load valid across ordinary renders", async () => {
    const delayedConversation = deferred<QueryResult>();
    conversationMaybeSinglePromise = delayedConversation.promise;
    const view = render(
      <TooltipProvider>
        <OperatorChatPage />
      </TooltipProvider>,
    );

    view.rerender(
      <TooltipProvider>
        <OperatorChatPage />
      </TooltipProvider>,
    );
    await act(async () => delayedConversation.resolve(resultFor("conversations")));

    await screen.findByPlaceholderText("השיחה בטיפול עובד אחר");
  });
});

// Exercise the page with its actual ownership/scope hook; only the external API is mocked.
const textComposer = () => screen.getByPlaceholderText(/כתוב כ|השיחה נעולה כרגע לעובד אחר/);
const textCalls = () => rpcMock.mock.calls.filter(([name]) => name === "send_operator_message");
async function renderLegacyText(
  responsibility: "available" | "mine" = "available",
  foreignLock = true,
) {
  testState.realOwnership = true;
  testState.concurrencyMode = "lock";
  testState.responsibility = responsibility;
  testState.cycleId = responsibility === "mine" ? cycleId : null;
  testState.foreignLock = foreignLock;
  const view = await renderChat();
  await screen.findByText(responsibility === "mine" ? "השיחה בטיפולך" : "השיחה פנויה");
  return view;
}
function lateTextResult() {
  return {
    data: {
      cycle_id: cycleId,
      message: {
        id: "00000000-0000-4000-8000-000000000201",
        conversation_id: conversationId,
        sender_type: "operator",
        sender_id: stableMocks.user.id,
        operator_id: operatorId,
        content: "השלמה ישנה",
        created_at: "2026-11-23T10:00:00Z",
      },
    },
    error: null,
  };
}

describe("text sends follow cycle authority rather than legacy locks", () => {
  it.each(["available", "mine"] as const)(
    "sends once for %s despite a foreign legacy lock with the exact server token contract",
    async (responsibility) => {
      await renderLegacyText(responsibility);
      const composer = textComposer();
      expect(composer).toBeEnabled();
      // The media entry controls keep their prior legacy-lock behavior.
      expect(screen.getByRole("button", { name: "בחירת מדיה לשליחה" })).toBeDisabled();
      fireEvent.change(composer, { target: { value: "בקשת טקסט" } });
      fireEvent.click(screen.getByRole("button", { name: "שליחת הודעה" }));
      await waitFor(() =>
        expect(textCalls()).toEqual([
          [
            "send_operator_message",
            {
              _conversation_id: conversationId,
              _content: "בקשת טקסט",
              _expected_cycle_id: responsibility === "mine" ? cycleId : null,
            },
          ],
        ]),
      );
      expect(rpcMock).not.toHaveBeenCalledWith("acquire_conversation_lock", expect.any(Object));
      await waitFor(() => expect(composer).toHaveValue(""));
    },
  );

  it("does not require a successful advisory lock acquisition when no legacy lock exists", async () => {
    await renderLegacyText("available", false);
    const prior = rpcMock.getMockImplementation()!;
    rpcMock.mockImplementation((name: string, ...args: unknown[]) =>
      name === "acquire_conversation_lock"
        ? Promise.resolve({ data: { acquired: false }, error: null })
        : prior(name, ...args),
    );
    fireEvent.change(textComposer(), { target: { value: "ללא נעילה" } });
    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith("acquire_conversation_lock", expect.any(Object)),
    );
    fireEvent.click(screen.getByRole("button", { name: "שליחת הודעה" }));
    await waitFor(() => expect(textCalls()).toHaveLength(1));
  });

  it.each(["warning", "lock"] as const)(
    "describes the %s legacy marker as coordination rather than active handling",
    async (mode) => {
      const view = await renderLegacyText();
      testState.concurrencyMode = mode;
      // Reload the page's settings through its existing mount path.
      view.unmount();
      await renderChat();
      await screen.findByText(/נעילה לתיאום/);
      expect(screen.queryByText(/עמית פעיל בשיחה|השיחה נעולה אצל/)).not.toBeInTheDocument();
    },
  );

  it("keeps manual lock acquisition as coordination without claiming handling", async () => {
    await renderLegacyText("available", false);
    expect(screen.queryByRole("button", { name: "קח שיחה" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "סמן לתיאום" }));
    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith("acquire_conversation_lock", {
        _conversation_id: conversationId,
      }),
    );
    expect(textCalls()).toHaveLength(0);
    expect(screen.getByText("השיחה פנויה")).toBeInTheDocument();
  });

  it.each([
    "conversation_claim_state_expired",
    "operator_capacity_reached",
    "conversation_not_responsible_operator",
  ])("preserves the draft after %s and never retries or publishes success", async (reason) => {
    await renderLegacyText();
    const prior = rpcMock.getMockImplementation()!;
    rpcMock.mockImplementation((name: string, ...args: unknown[]) =>
      name === "send_operator_message"
        ? Promise.resolve({ data: null, error: { message: reason } })
        : prior(name, ...args),
    );
    const composer = textComposer();
    fireEvent.change(composer, { target: { value: "טיוטה נדחית" } });
    fireEvent.click(screen.getByRole("button", { name: "שליחת הודעה" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("שליחה נכשלה"));
    expect(composer).toHaveValue("טיוטה נדחית");
    expect(screen.getByText("השיחה פנויה")).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    expect(textCalls()).toHaveLength(1);
  });

  it("does not submit twice while the server response is pending", async () => {
    await renderLegacyText();
    const pending = deferred<ReturnType<typeof lateTextResult>>();
    const prior = rpcMock.getMockImplementation()!;
    rpcMock.mockImplementation((name: string, ...args: unknown[]) =>
      name === "send_operator_message" ? pending.promise : prior(name, ...args),
    );
    const composer = textComposer();
    fireEvent.change(composer, { target: { value: "בקשה אחת" } });
    fireEvent.click(screen.getByRole("button", { name: "שליחת הודעה" }));
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(textCalls()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "שליחת הודעה" })).toBeDisabled();
    await act(async () => pending.resolve(lateTextResult()));
  });

  it("ignores a late completion after the conversation changes", async () => {
    const view = await renderLegacyText();
    const pending = deferred<ReturnType<typeof lateTextResult>>();
    const prior = rpcMock.getMockImplementation()!;
    rpcMock.mockImplementation((name: string, ...args: unknown[]) =>
      name === "send_operator_message" ? pending.promise : prior(name, ...args),
    );
    fireEvent.change(textComposer(), { target: { value: "טיוטת א" } });
    fireEvent.click(screen.getByRole("button", { name: "שליחת הודעה" }));
    testState.conversationId = "00000000-0000-4000-8000-000000000002";
    view.rerender(
      <TooltipProvider>
        <OperatorChatPage />
      </TooltipProvider>,
    );
    const composer = await screen.findByPlaceholderText(/כתוב כ/);
    fireEvent.change(composer, { target: { value: "טיוטת ב" } });
    await act(async () => pending.resolve(lateTextResult()));
    expect(composer).toHaveValue("טיוטת ב");
    expect(screen.queryByText("השלמה ישנה")).not.toBeInTheDocument();
    expect(textCalls()).toHaveLength(1);
    expect(textCalls()[0][1]).toMatchObject({ _conversation_id: conversationId });
  });

  it("ignores a late completion after responsibility changes to another operator", async () => {
    await renderLegacyText();
    const pending = deferred<ReturnType<typeof lateTextResult>>();
    const prior = rpcMock.getMockImplementation()!;
    rpcMock.mockImplementation((name: string, ...args: unknown[]) =>
      name === "send_operator_message" ? pending.promise : prior(name, ...args),
    );
    fireEvent.change(textComposer(), { target: { value: "בקשה ישנה" } });
    fireEvent.click(screen.getByRole("button", { name: "שליחת הודעה" }));
    testState.responsibility = "other";
    const registration = (channels.at(-1)!.on.mock.calls as ChannelRegistration[]).find(
      ([, filter]) => filter.table === "conversations",
    )!;
    act(() => registration[2]({}));
    await screen.findByPlaceholderText("השיחה בטיפול עובד אחר");
    await act(async () => pending.resolve(lateTextResult()));
    expect(screen.getByRole("button", { name: "שליחת הודעה" })).toBeDisabled();
    expect(screen.queryByText("השלמה ישנה")).not.toBeInTheDocument();
    expect(textCalls()).toHaveLength(1);
  });

  it("does not publish a pending completion after read access is revoked", async () => {
    const view = await renderLegacyText();
    const pending = deferred<ReturnType<typeof lateTextResult>>();
    const prior = rpcMock.getMockImplementation()!;
    rpcMock.mockImplementation((name: string, ...args: unknown[]) =>
      name === "send_operator_message" ? pending.promise : prior(name, ...args),
    );
    fireEvent.change(textComposer(), { target: { value: "טיוטה מוגנת" } });
    fireEvent.click(screen.getByRole("button", { name: "שליחת הודעה" }));
    testState.readAccessState = "denied";
    testState.readAccessGeneration++;
    view.rerender(
      <TooltipProvider>
        <OperatorChatPage />
      </TooltipProvider>,
    );
    expect(screen.getByText("הגישה לשיחה בוטלה")).toBeInTheDocument();
    await act(async () => pending.resolve(lateTextResult()));
    expect(screen.queryByRole("button", { name: "שליחת הודעה" })).not.toBeInTheDocument();
    expect(screen.queryByText("השלמה ישנה")).not.toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    expect(textCalls()).toHaveLength(1);
  });

  it("never exposes text sending for a closed conversation", async () => {
    testState.realOwnership = true;
    testState.responsibility = "closed";
    testState.conversationStatus = "closed";
    testState.foreignLock = true;
    render(
      <TooltipProvider>
        <OperatorChatPage />
      </TooltipProvider>,
    );
    await screen.findAllByRole("button", { name: "פתח מחדש" });
    expect(screen.queryByRole("button", { name: "שליחת הודעה" })).not.toBeInTheDocument();
    expect(textCalls()).toHaveLength(0);
  });
});
