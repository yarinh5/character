import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal(
  "ResizeObserver",
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  is_read: boolean;
  created_at: string;
};

type Reply<T> = { data: T; error: unknown };

type TestChannel = {
  name: string;
  handlers: Record<string, () => void>;
  on: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
};

const io = vi.hoisted(() => ({
  auth: {
    loading: false,
    userId: "user-a" as string | null,
    sessionUserId: "user-a" as string | null,
    role: "client" as "client" | "operator" | "admin" | null,
  },
  readNotifications: vi.fn(),
  updateNotifications: vi.fn(),
  channels: [] as TestChannel[],
  removeChannel: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    loading: io.auth.loading,
    user: io.auth.userId ? { id: io.auth.userId } : null,
    session: io.auth.sessionUserId ? { user: { id: io.auth.sessionUserId } } : null,
    role: io.auth.role,
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, onClick, children }: { to: string; onClick?: () => void; children: ReactNode }) => (
    <a href={to} onClick={onClick}>
      {children}
    </a>
  ),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      if (table !== "notifications") throw new Error(`Unexpected table: ${table}`);
      let operation: "read" | "update" = "read";
      let payload: Record<string, unknown> = {};
      const filters: Array<[string, unknown]> = [];
      let executed: Promise<Reply<NotificationRow[] | null>> | null = null;
      const execute = () => {
        if (!executed) {
          const userId = filters.find(([column]) => column === "user_id")?.[1];
          executed = Promise.resolve().then(() =>
            operation === "read"
              ? io.readNotifications(userId)
              : io.updateNotifications({ payload, filters }),
          );
        }
        return executed;
      };
      const query = {
        select: vi.fn(() => query),
        update: vi.fn((values: Record<string, unknown>) => {
          operation = "update";
          payload = values;
          return query;
        }),
        eq: vi.fn((column: string, value: unknown) => {
          filters.push([column, value]);
          return query;
        }),
        order: vi.fn(() => query),
        limit: vi.fn(() => query),
        then: (
          resolve: (value: Reply<NotificationRow[] | null>) => unknown,
          reject: (reason: unknown) => unknown,
        ) => execute().then(resolve, reject),
      };
      return query;
    },
    channel: (name: string) => {
      const channel = {
        name,
        handlers: {},
        on: vi.fn(),
        subscribe: vi.fn(),
      } as TestChannel;
      channel.on.mockImplementation(
        (_event: string, config: { event: string }, handler: () => void) => {
          channel.handlers[config.event] = handler;
          return channel;
        },
      );
      channel.subscribe.mockReturnValue(channel);
      io.channels.push(channel);
      return channel;
    },
    removeChannel: io.removeChannel,
  },
}));

import { NotificationBell } from "@/components/common/NotificationBell";

const unreadA: NotificationRow = {
  id: "notification-a",
  type: "new_message",
  title: "הודעה חדשה",
  body: "טקסט ארוך שנשאר בתוך גבולות הפעמון",
  link: "/app/conversations/a",
  is_read: false,
  created_at: "2026-11-01T10:00:00Z",
};

const readB: NotificationRow = {
  ...unreadA,
  id: "notification-b",
  title: "עדכון מערכת",
  link: null,
  is_read: true,
  created_at: "2026-11-01T11:00:00Z",
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

function openBell() {
  fireEvent.click(screen.getByRole("button", { name: "התראות" }));
}

beforeEach(() => {
  io.auth.loading = false;
  io.auth.userId = "user-a";
  io.auth.sessionUserId = "user-a";
  io.auth.role = "client";
  io.readNotifications.mockReset().mockResolvedValue({ data: [unreadA], error: null });
  io.updateNotifications.mockReset().mockResolvedValue({ data: [unreadA], error: null });
  io.channels.length = 0;
  io.removeChannel.mockReset().mockResolvedValue(undefined);
});

describe("NotificationBell", () => {
  it("waits for an initialized matching identity before reading or subscribing", async () => {
    io.auth.loading = true;
    const view = render(<NotificationBell />);
    expect(io.readNotifications).not.toHaveBeenCalled();
    expect(io.channels).toHaveLength(0);

    io.auth.loading = false;
    io.auth.sessionUserId = "different-user";
    view.rerender(<NotificationBell />);
    expect(io.readNotifications).not.toHaveBeenCalled();

    io.auth.sessionUserId = "user-a";
    view.rerender(<NotificationBell />);
    await waitFor(() => expect(io.readNotifications).toHaveBeenCalledWith("user-a"));
    expect(io.channels).toHaveLength(1);
    expect(io.channels[0].name).toContain("user-a");
  });

  it("distinguishes an initial failure from a confirmed empty list and retries", async () => {
    io.readNotifications
      .mockResolvedValueOnce({ data: null, error: { message: "offline" } })
      .mockResolvedValueOnce({ data: [], error: null });
    render(<NotificationBell />);
    openBell();

    expect(await screen.findByRole("alert")).toHaveTextContent("טעינת ההתראות נכשלה");
    expect(screen.queryByText("אין התראות")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "נסה שוב" }));
    expect(await screen.findByText("אין התראות")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps cached notifications through a refresh failure and clears one warning after recovery", async () => {
    io.readNotifications
      .mockResolvedValueOnce({ data: [unreadA], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "refresh failed" } })
      .mockResolvedValueOnce({ data: [readB], error: null });
    render(<NotificationBell />);
    openBell();
    expect(await screen.findByText(unreadA.title)).toBeInTheDocument();

    await act(async () => io.channels[0].handlers.INSERT());
    expect(await screen.findByRole("alert")).toHaveTextContent("רענון ההתראות נכשל");
    expect(screen.getByText(unreadA.title)).toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "נסה שוב" }));
    expect(await screen.findByText(readB.title)).toBeInTheDocument();
    expect(screen.queryByText(unreadA.title)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores an older same-identity response when Realtime starts a newer read", async () => {
    const older = deferred<Reply<NotificationRow[] | null>>();
    const newer = deferred<Reply<NotificationRow[] | null>>();
    io.readNotifications.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    render(<NotificationBell />);
    await waitFor(() => expect(io.channels).toHaveLength(1));
    openBell();
    act(() => io.channels[0].handlers.UPDATE());

    await act(async () => newer.resolve({ data: [readB], error: null }));
    expect(await screen.findByText(readB.title)).toBeInTheDocument();
    await act(async () => older.resolve({ data: [unreadA], error: null }));
    expect(screen.getByText(readB.title)).toBeInTheDocument();
    expect(screen.queryByText(unreadA.title)).not.toBeInTheDocument();
  });

  it("hides A immediately, closes the popover, cleans its channel, and ignores A after switching to B", async () => {
    const lateA = deferred<Reply<NotificationRow[] | null>>();
    io.readNotifications
      .mockReturnValueOnce(lateA.promise)
      .mockResolvedValueOnce({ data: [{ ...readB, title: "התראת משתמש ב" }], error: null });
    const view = render(<NotificationBell />);
    await waitFor(() => expect(io.channels).toHaveLength(1));
    openBell();
    const channelA = io.channels[0];

    io.auth.userId = "user-b";
    io.auth.sessionUserId = "user-b";
    view.rerender(<NotificationBell />);
    await waitFor(() => expect(io.removeChannel).toHaveBeenCalledWith(channelA));
    await act(async () => lateA.resolve({ data: [unreadA], error: null }));
    expect(screen.queryByText(unreadA.title)).not.toBeInTheDocument();

    openBell();
    expect(await screen.findByText("התראת משתמש ב")).toBeInTheDocument();
    expect(io.readNotifications).toHaveBeenLastCalledWith("user-b");
    expect(io.channels[1].name).toContain("user-b");
  });

  it.each([
    ["mismatch", "user-a", "different-user"],
    ["logout", null, null],
  ])("stops reads and hides old data on %s", async (_label, userId, sessionUserId) => {
    const view = render(<NotificationBell />);
    await waitFor(() => expect(io.readNotifications).toHaveBeenCalledTimes(1));
    io.auth.userId = userId;
    io.auth.sessionUserId = sessionUserId;
    view.rerender(<NotificationBell />);
    expect(screen.queryByRole("button", { name: "התראות" })).not.toBeInTheDocument();
    expect(io.readNotifications).toHaveBeenCalledTimes(1);
  });

  it("guards mark-all synchronously and preserves the required update filters", async () => {
    const pending = deferred<Reply<NotificationRow[] | null>>();
    io.updateNotifications.mockReturnValue(pending.promise);
    io.readNotifications
      .mockResolvedValueOnce({ data: [unreadA], error: null })
      .mockResolvedValueOnce({ data: [{ ...unreadA, is_read: true }], error: null });
    render(<NotificationBell />);
    openBell();
    const button = await screen.findByRole("button", { name: "סמן הכל כנקרא" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(io.updateNotifications).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "מסמן התראות" })).toBeDisabled();

    await act(async () => pending.resolve({ data: [unreadA], error: null }));
    await waitFor(() => expect(io.readNotifications).toHaveBeenCalledTimes(2));
    expect(io.updateNotifications).toHaveBeenCalledWith({
      payload: { is_read: true },
      filters: [
        ["user_id", "user-a"],
        ["is_read", false],
      ],
    });
  });

  it.each([
    ["returned error", () => Promise.resolve({ data: null, error: { message: "denied" } })],
    ["rejection", () => Promise.reject(new Error("network"))],
  ])("does not report local success when mark-all ends in %s", async (_label, result) => {
    io.updateNotifications.mockImplementation(result);
    render(<NotificationBell />);
    openBell();
    fireEvent.click(await screen.findByRole("button", { name: "סמן הכל כנקרא" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("סימון ההתראות נכשל");
    expect(screen.getByText(unreadA.title)).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "סמן הכל כנקרא" })).toBeEnabled();
  });

  it("treats zero updated rows as a no-op and uses the verification read as the source of truth", async () => {
    io.updateNotifications.mockResolvedValue({ data: [], error: null });
    io.readNotifications
      .mockResolvedValueOnce({ data: [unreadA], error: null })
      .mockResolvedValueOnce({ data: [{ ...unreadA, is_read: true }], error: null });
    render(<NotificationBell />);
    openBell();
    fireEvent.click(await screen.findByRole("button", { name: "סמן הכל כנקרא" }));

    await waitFor(() => expect(io.readNotifications).toHaveBeenCalledTimes(2));
    expect(io.updateNotifications).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "סמן הכל כנקרא" })).not.toBeInTheDocument();
  });

  it("distinguishes a successful update followed by refresh failure and never hides a concurrent unread event", async () => {
    io.readNotifications
      .mockResolvedValueOnce({ data: [unreadA], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "refresh" } })
      .mockResolvedValueOnce({
        data: [{ ...readB, id: "new-event", is_read: false }],
        error: null,
      });
    render(<NotificationBell />);
    openBell();
    fireEvent.click(await screen.findByRole("button", { name: "סמן הכל כנקרא" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ההתראות סומנו, אך רענון הרשימה נכשל",
    );
    expect(screen.getByText(unreadA.title)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "נסה שוב" }));
    expect(await screen.findByText(readB.title)).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });
});
