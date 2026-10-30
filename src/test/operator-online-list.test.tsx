import type { ComponentType, ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type ConversationRow = {
  id: string;
  status: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  operator_unread_count: number;
  client_id: string;
  characters: { id: string; name: string; avatar_url: string | null };
  profiles: { display_name: string; avatar_url: string | null };
};

const query = vi.hoisted(() => ({
  data: undefined as ConversationRow[] | undefined,
  error: null as Error | null,
  isFetching: false,
  isLoading: false,
  refetch: vi.fn(async () => undefined),
}));

const rpc = vi.hoisted(() => vi.fn());
const channel = {
  on: vi.fn(() => channel),
  subscribe: vi.fn(() => channel),
};

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  Link: ({
    children,
    params,
    to,
  }: {
    children: ReactNode;
    params?: { conversationId?: string };
    to: string;
  }) => (
    <a href={params?.conversationId ? to.replace("$conversationId", params.conversationId) : to}>
      {children}
    </a>
  ),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => query,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "user-a" } }) }));
vi.mock("@/components/operator/OperatorLayout", () => ({
  ConversationStatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
  useOperator: () => ({
    isAdmin: false,
    operator: { id: "operator-a" },
    walletBalance: 12,
  }),
}));
vi.mock("@/lib/readStates", () => ({
  fetchUnreadCounts: vi.fn(async () => new Map()),
  logSupabaseError: vi.fn(),
}));
vi.mock("@/lib/slaMonitoring", () => ({ fetchSlaRiskConversations: vi.fn(async () => []) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
    rpc,
  },
}));

import { Route as ConversationsRoute } from "@/routes/operator.conversations";

const ConversationsPage = (ConversationsRoute as unknown as { component: ComponentType }).component;

const rows: ConversationRow[] = [
  {
    id: "conversation-unread",
    status: "open",
    last_message_at: "2026-10-28T08:00:00Z",
    last_message_preview: "הודעה שלא נקראה",
    operator_unread_count: 3,
    client_id: "client-a",
    characters: { id: "character-a", name: "נועה", avatar_url: null },
    profiles: { display_name: "אייל", avatar_url: null },
  },
  {
    id: "conversation-newest",
    status: "waiting",
    last_message_at: "2026-10-30T09:00:00Z",
    last_message_preview: "הודעה חדשה יותר",
    operator_unread_count: 0,
    client_id: "client-b",
    characters: { id: "character-b", name: "מאיה", avatar_url: null },
    profiles: { display_name: "בר", avatar_url: null },
  },
  {
    id: "conversation-closed",
    status: "closed",
    last_message_at: "2026-10-29T09:00:00Z",
    last_message_preview: "שיחה סגורה",
    operator_unread_count: 0,
    client_id: "client-c",
    characters: { id: "character-a", name: "נועה", avatar_url: null },
    profiles: { display_name: "גיל", avatar_url: null },
  },
];

function renderPage() {
  return render(<ConversationsPage />);
}

beforeEach(() => {
  query.data = rows;
  query.error = null;
  query.isFetching = false;
  query.isLoading = false;
  query.refetch.mockClear();
  rpc.mockReset();
  channel.on.mockClear();
  channel.subscribe.mockClear();
});

describe("ONLINE conversation list", () => {
  it("preserves conversation content and sorts unread before last-message activity", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "ONLINE" })).toBeInTheDocument();
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/operator/chat/conversation-unread",
      "/operator/chat/conversation-newest",
      "/operator/chat/conversation-closed",
    ]);
    expect(links[0]).toHaveTextContent("אייל");
    expect(links[0]).toHaveTextContent("נועה");
    expect(links[0]).toHaveTextContent("הודעה שלא נקראה");
    expect(links[0]).toHaveTextContent("3");
    expect(screen.queryByText(/מחובר|online now/i)).not.toBeInTheDocument();
  });

  it("keeps local search and status and character filters", () => {
    renderPage();

    fireEvent.change(screen.getByPlaceholderText("חיפוש לפי שם לקוח..."), {
      target: { value: "בר" },
    });
    expect(screen.getByText("בר")).toBeInTheDocument();
    expect(screen.queryByText("אייל")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "הכל" }));
    fireEvent.change(screen.getByPlaceholderText("חיפוש לפי שם לקוח..."), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "סגורות" }));
    expect(screen.getByText("גיל")).toBeInTheDocument();
    expect(screen.queryByText("בר")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "הכל" }));
    fireEvent.click(screen.getByRole("button", { name: "מאיה" }));
    expect(screen.getByText("בר")).toBeInTheDocument();
    expect(screen.queryByText("אייל")).not.toBeInTheDocument();
  });

  it("shows only an accessible skeleton state during initial loading", () => {
    query.data = undefined;
    query.isLoading = true;
    renderPage();

    expect(screen.getByRole("status", { name: "טוען שיחות" })).toBeInTheDocument();
    expect(screen.queryByText("אין שיחות")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a generic retryable error without leaking the raw server message", () => {
    query.data = undefined;
    query.error = new Error("permission denied: internal detail");
    renderPage();

    expect(screen.getByRole("alert")).toHaveTextContent("לא ניתן לטעון את השיחות כרגע");
    expect(screen.queryByText(/permission denied/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "נסה שוב" }));
    expect(query.refetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("אין שיחות")).not.toBeInTheDocument();
  });

  it("disables duplicate retries while a retry is pending", () => {
    query.data = undefined;
    query.error = new Error("network");
    query.isFetching = true;
    renderPage();

    expect(screen.getByRole("button", { name: "מנסה שוב" })).toBeDisabled();
  });

  it("separates an empty inbox from filtered no-results and can reset local filters", () => {
    query.data = [];
    const view = renderPage();
    expect(screen.getByText("אין שיחות")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "איפוס מסננים" })).not.toBeInTheDocument();

    query.data = rows;
    view.rerender(<ConversationsPage />);
    fireEvent.change(screen.getByPlaceholderText("חיפוש לפי שם לקוח..."), {
      target: { value: "לא קיים" },
    });
    expect(screen.getByText("לא נמצאו שיחות תואמות")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "איפוס מסננים" }));
    expect(screen.getByText("אייל")).toBeInTheDocument();
    expect(screen.queryByText("לא נמצאו שיחות תואמות")).not.toBeInTheDocument();
  });

  it("opens the existing chat route without invoking a claim or send RPC", () => {
    renderPage();

    const link = screen.getByRole("link", { name: /אייל/ });
    expect(link).toHaveAttribute("href", "/operator/chat/conversation-unread");
    fireEvent.click(link);
    expect(rpc).not.toHaveBeenCalled();
  });
});
