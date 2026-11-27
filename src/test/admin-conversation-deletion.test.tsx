import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  rpc: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  invalidateQueries: vi.fn(),
}));

const conversationId = "00000000-0000-4000-8000-000000000901";
const routeData = {
  conv: {
    id: conversationId,
    status: "open",
    client_id: "client-a",
    character_id: "character-a",
    assigned_operator_id: null,
    characters: { id: "character-a", name: "דמות", avatar_url: null },
    operators: null,
  },
  client: { display_name: "לקוח", email: "client@example.test", status: "active" },
  cprof: null,
  notes: [],
  customerInfo: [],
  reports: [],
  currentOperator: null,
  currentOperatorAssigned: false,
  concurrencyMode: "open",
  lockTimeoutMinutes: 10,
  lock: null,
  availableOps: [],
};

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({ conversationId }),
  }),
  Link: ({ children }: { children: ReactNode }) => <>{children}</>,
  useNavigate: () => vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: routeData, isLoading: false }),
  useQueryClient: () => ({ invalidateQueries: io.invalidateQueries }),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "admin-a" } }) }));
vi.mock("@/lib/activeConversation", () => ({ useActiveConversation: vi.fn() }));
vi.mock("@/components/admin/AdminLayout", () => ({ StatusBadge: () => null }));
vi.mock("@/components/common/ChatAvatar", () => ({ ChatAvatar: () => null }));
vi.mock("@/components/chat/MessageAttachment", () => ({ MessageAttachment: () => null }));
vi.mock("@/components/chat/MessageSticker", () => ({
  MessageSticker: () => null,
  StickerHydrationPlaceholder: () => null,
}));
vi.mock("@/components/chat/StickerPicker", () => ({ StickerPicker: () => null }));
vi.mock("@/components/operator/OperatorMediaPicker", () => ({ OperatorMediaPicker: () => null }));
vi.mock("@/hooks/useMessageAttachmentAccessMap", () => ({
  useMessageAttachmentAccessMap: () => ({
    accessByAttachmentId: {},
    getAccessStatus: () => "idle",
    refreshAttachment: vi.fn(),
  }),
}));
vi.mock("sonner", () => ({ toast: { error: io.error, success: io.success } }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: io.rpc,
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => Promise.resolve({ data: [], error: null }),
      };
      return builder;
    },
    channel: () => ({
      on() {
        return this;
      },
      subscribe() {
        return this;
      },
    }),
    removeChannel: vi.fn(),
  },
}));

import { Route as AdminConversationRoute } from "@/routes/admin.conversations.$conversationId";

const AdminConversation = (AdminConversationRoute as unknown as { component: () => ReactNode })
  .component;

beforeEach(() => {
  io.rpc.mockReset().mockImplementation(async (name: string) => {
    if (name === "mark_conversation_read") return { data: null, error: null };
    throw new Error(`Unexpected RPC: ${name}`);
  });
  io.error.mockReset();
  io.success.mockReset();
  io.invalidateQueries.mockReset();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("admin conversation deletion request", () => {
  it("releases a rejected request and retries with the same idempotency key", async () => {
    io.rpc.mockImplementationOnce(async () => ({ data: null, error: null }));
    io.rpc.mockRejectedValueOnce(new Error("transport unavailable")).mockResolvedValueOnce({
      data: [
        {
          id: "00000000-0000-4000-8000-000000000902",
          status: "blocked_retention",
          requested_at: "2026-11-09T12:00:00.000Z",
        },
      ],
      error: null,
    });

    render(<AdminConversation />);
    fireEvent.change(screen.getByPlaceholderText("סיבה מפורשת לבקשת המחיקה"), {
      target: { value: "בקשת לקוח מאומתת" },
    });
    const submit = screen.getByRole("button", { name: "אישור ותיעוד בקשת מחיקה" });
    fireEvent.click(submit);

    await waitFor(() =>
      expect(io.error).toHaveBeenCalledWith(
        "יצירת בקשת המחיקה נכשלה. ניתן לנסות שוב בלי ליצור בקשה כפולה.",
      ),
    );
    expect(submit).toBeEnabled();
    expect(screen.getByPlaceholderText("סיבה מפורשת לבקשת המחיקה")).toHaveValue("בקשת לקוח מאומתת");
    fireEvent.click(submit);

    await waitFor(() => expect(io.success).toHaveBeenCalled());
    const calls = io.rpc.mock.calls.filter(([name]) => name === "request_conversation_deletion");
    expect(calls).toHaveLength(2);
    expect(calls[0][1]._idempotency_key).toBe(calls[1][1]._idempotency_key);
  });
});
