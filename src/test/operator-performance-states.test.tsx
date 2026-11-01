import type { ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

type Operator = {
  id: string;
  user_id: string;
  full_name: string;
  is_active: boolean;
  availability_status: "available" | "busy" | "offline";
};

type Summary = {
  operator: {
    id: string;
    full_name: string;
    availability_status: "available" | "busy" | "offline";
    is_active: boolean;
  } | null;
  currentMonthKey: string;
  availablePoints: number;
  currentPoints: number;
  currentScoredMessages: number;
  previousMonthPoints: number;
  monthlyPointChange: number;
  monthlyMessageChange: number;
  avgResponseSec: number;
  assignedCharacters: Array<{
    character_id: string;
    characters: {
      id: string;
      name: string;
      avatar_url: string | null;
      availability_status: string;
    } | null;
  }>;
  monthlyHistory: Array<{
    month: string;
    monthLabel: string;
    points: number;
    scoredMessages: number;
  }>;
  chartData: Array<{ month: string; points: number; scoredMessages: number }>;
};

type TestChannel = {
  name: string;
  on: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
};

const io = vi.hoisted(() => ({
  sessionUserId: "user-a" as string | null,
  authLoading: false,
  operator: null as Operator | null,
  fetchPerformance: vi.fn<(operatorId: string) => Promise<Summary>>(),
  channels: [] as TestChannel[],
  removeChannel: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    session: io.sessionUserId ? { user: { id: io.sessionUserId } } : null,
    user: io.sessionUserId ? { id: io.sessionUserId } : null,
    loading: io.authLoading,
  }),
}));

vi.mock("@/components/operator/OperatorLayout", () => ({
  useOperator: () => ({
    operator: io.operator,
    isAdmin: false,
    walletBalance: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/lib/operatorPerformance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/operatorPerformance")>();
  return { ...actual, fetchOperatorPerformance: io.fetchPerformance };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    channel: (name: string) => {
      const channel = {
        name,
        on: vi.fn(),
        subscribe: vi.fn(),
      } as TestChannel;
      channel.on.mockReturnValue(channel);
      channel.subscribe.mockReturnValue(channel);
      io.channels.push(channel);
      return channel;
    },
    removeChannel: io.removeChannel,
  },
}));

import { Route } from "@/routes/operator.analytics";

const Page = (Route as unknown as { component: ComponentType }).component;

const operatorA: Operator = {
  id: "operator-a",
  user_id: "user-a",
  full_name: "עובד א",
  is_active: true,
  availability_status: "available",
};
const operatorB: Operator = {
  id: "operator-b",
  user_id: "user-b",
  full_name: "עובד ב",
  is_active: true,
  availability_status: "busy",
};

function makeSummary(operator: Operator, overrides: Partial<Summary> = {}): Summary {
  const history = [
    {
      month: "2026-10-01",
      monthLabel: "אוק׳ 26׳",
      points: 37,
      scoredMessages: 4,
    },
  ];
  return {
    operator: {
      id: operator.id,
      full_name: operator.full_name,
      availability_status: operator.availability_status,
      is_active: operator.is_active,
    },
    currentMonthKey: "2026-10-01",
    availablePoints: 37,
    currentPoints: 37,
    currentScoredMessages: 4,
    previousMonthPoints: 25,
    monthlyPointChange: 12,
    monthlyMessageChange: 2,
    avgResponseSec: 90,
    assignedCharacters: [
      {
        character_id: "character-a",
        characters: {
          id: "character-a",
          name: "מאיה",
          avatar_url: "https://example.test/maya.png",
          availability_status: "available",
        },
      },
    ],
    monthlyHistory: history,
    chartData: history.map(({ monthLabel, points, scoredMessages }) => ({
      month: monthLabel,
      points,
      scoredMessages,
    })),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
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

beforeEach(() => {
  io.sessionUserId = operatorA.user_id;
  io.authLoading = false;
  io.operator = operatorA;
  io.fetchPerformance.mockReset().mockResolvedValue(makeSummary(operatorA));
  io.channels.length = 0;
  io.removeChannel.mockReset().mockResolvedValue(undefined);
});

describe("operator performance read states", () => {
  it.each(["user-b", null])(
    "hides cached A and cleans its channel when session becomes %s before context updates",
    async (sessionUserId) => {
      const refreshA = deferred<Summary>();
      io.fetchPerformance
        .mockResolvedValueOnce(makeSummary(operatorA))
        .mockReturnValueOnce(refreshA.promise)
        .mockResolvedValueOnce(makeSummary(operatorB, { availablePoints: 73 }));
      const view = renderPage();
      await screen.findByText("קרדיטים זמינים");
      act(() => {
        void view.queryClient.invalidateQueries({
          queryKey: ["operator-performance", operatorA.id],
        });
      });
      await screen.findByRole("status", { name: "מרענן נתוני ביצועים" });
      const oldChannel = io.channels[0];

      io.sessionUserId = sessionUserId;
      view.rerender();
      expect(screen.queryByText("קרדיטים זמינים")).not.toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(io.removeChannel).toHaveBeenCalledWith(oldChannel);
      expect(io.channels).toHaveLength(1);
      await act(async () => refreshA.resolve(makeSummary(operatorA, { availablePoints: 999 })));
      await act(async () => {
        await view.queryClient.invalidateQueries({ queryKey: ["operator-performance"] });
      });
      expect(screen.queryByText("999")).not.toBeInTheDocument();
      expect(io.fetchPerformance).toHaveBeenCalledTimes(2);

      io.sessionUserId = operatorB.user_id;
      io.operator = operatorB;
      view.rerender();
      expect(await screen.findByText("73")).toBeInTheDocument();
      expect(io.fetchPerformance).toHaveBeenLastCalledWith(operatorB.id);
      expect(io.channels).toHaveLength(2);
      expect(io.channels[1].name).toBe("operator-performance-operator-b");
    },
  );

  it.each(["user-b", null])(
    "does not start a read or channel with stale operator A and session %s",
    (sessionUserId) => {
      io.sessionUserId = sessionUserId;
      renderPage();
      expect(io.fetchPerformance).not.toHaveBeenCalled();
      expect(io.channels).toHaveLength(0);
      expect(screen.queryByText("קרדיטים זמינים")).not.toBeInTheDocument();
    },
  );

  it("waits for auth initialization even when session and operator match", () => {
    io.authLoading = true;
    const view = renderPage();
    expect(io.fetchPerformance).not.toHaveBeenCalled();
    expect(io.channels).toHaveLength(0);
    io.authLoading = false;
    view.rerender();
    expect(io.fetchPerformance).toHaveBeenCalledWith(operatorA.id);
    expect(io.channels).toHaveLength(1);
  });

  it("shows only an accessible skeleton during initial loading", () => {
    io.fetchPerformance.mockReturnValue(deferred<Summary>().promise);
    renderPage();

    expect(screen.getByRole("status", { name: "טוען נתוני ביצועים" })).toBeInTheDocument();
    expect(screen.queryByText("אין עדיין נתוני ביצועים")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("קרדיטים זמינים")).not.toBeInTheDocument();
  });

  it("shows a filtered initial error and retries the existing read successfully", async () => {
    io.fetchPerformance
      .mockRejectedValueOnce(new Error("permission denied: private backend detail"))
      .mockResolvedValueOnce(makeSummary(operatorA));
    renderPage();

    const alert = await screen.findByRole("alert", { name: "שגיאת טעינת נתוני ביצועים" });
    expect(alert).toHaveTextContent("לא ניתן לטעון את נתוני הביצועים כרגע");
    expect(alert).not.toHaveTextContent("permission denied");
    fireEvent.click(screen.getByRole("button", { name: "נסה לטעון שוב" }));

    expect(await screen.findByText("קרדיטים זמינים")).toBeInTheDocument();
    expect(io.fetchPerformance).toHaveBeenCalledTimes(2);
  });

  it("keeps a generic error after a failed retry and disables duplicate retry while pending", async () => {
    const retry = deferred<Summary>();
    io.fetchPerformance
      .mockRejectedValueOnce(new Error("initial private detail"))
      .mockReturnValueOnce(retry.promise);
    renderPage();
    await screen.findByRole("alert", { name: "שגיאת טעינת נתוני ביצועים" });

    fireEvent.click(screen.getByRole("button", { name: "נסה לטעון שוב" }));
    expect(await screen.findByRole("status", { name: "טוען נתוני ביצועים" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "נסה לטעון שוב" })).not.toBeInTheDocument();
    await act(async () => retry.reject(new Error("retry private detail")));

    const alert = await screen.findByRole("alert", { name: "שגיאת טעינת נתוני ביצועים" });
    expect(alert).not.toHaveTextContent(/private detail/i);
    expect(screen.getByRole("button", { name: "נסה לטעון שוב" })).toBeEnabled();
    expect(io.fetchPerformance).toHaveBeenCalledTimes(2);
  });

  it("keeps current data visible during refresh and replaces it after success", async () => {
    const refresh = deferred<Summary>();
    io.fetchPerformance
      .mockResolvedValueOnce(makeSummary(operatorA))
      .mockReturnValueOnce(refresh.promise);
    const { queryClient } = renderPage();
    expect(await screen.findByText("קרדיטים זמינים")).toBeInTheDocument();
    expect(screen.getAllByText("37").length).toBeGreaterThan(0);

    act(() => {
      void queryClient.invalidateQueries({ queryKey: ["operator-performance", operatorA.id] });
    });
    expect(await screen.findByRole("status", { name: "מרענן נתוני ביצועים" })).toBeInTheDocument();
    expect(screen.getAllByText("37").length).toBeGreaterThan(0);
    await act(async () => refresh.resolve(makeSummary(operatorA, { availablePoints: 41 })));

    expect(await screen.findByText("41")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "מרענן נתוני ביצועים" })).not.toBeInTheDocument();
  });

  it("keeps cached data visible after refresh failure and supports a read-only retry", async () => {
    io.fetchPerformance
      .mockResolvedValueOnce(makeSummary(operatorA))
      .mockRejectedValueOnce(new Error("refresh private detail"))
      .mockResolvedValueOnce(makeSummary(operatorA, { availablePoints: 52 }));
    const { queryClient } = renderPage();
    await screen.findByText("קרדיטים זמינים");
    expect(screen.getAllByText("37").length).toBeGreaterThan(0);

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["operator-performance", operatorA.id] });
    });
    const alert = await screen.findByRole("alert", { name: "שגיאת רענון נתוני ביצועים" });
    expect(alert).toHaveTextContent("הנתונים המוצגים לא עודכנו");
    expect(alert).not.toHaveTextContent("private detail");
    expect(screen.getAllByText("37").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "נסה לרענן שוב" }));
    expect(await screen.findByText("52")).toBeInTheDocument();
    expect(io.fetchPerformance).toHaveBeenCalledTimes(3);
  });

  it("distinguishes successful empty history and a real zero balance from read failure", async () => {
    io.fetchPerformance.mockResolvedValue(
      makeSummary(operatorA, {
        availablePoints: 0,
        currentPoints: 0,
        currentScoredMessages: 0,
        monthlyPointChange: 0,
        monthlyMessageChange: 0,
        avgResponseSec: 0,
        monthlyHistory: [],
        chartData: [],
      }),
    );
    renderPage();

    expect(await screen.findByText("קרדיטים זמינים")).toBeInTheDocument();
    expect(screen.getAllByText("0").length).toBeGreaterThan(0);
    expect(screen.getAllByText("אין עדיין נתוני ביצועים")).toHaveLength(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("treats a missing operator context as unavailable data without starting a read", () => {
    io.operator = null;
    renderPage();

    expect(screen.getByText("אין חשבון עובד פעיל להצגת נתוני ביצועים.")).toBeInTheDocument();
    expect(screen.queryByText("קרדיטים זמינים")).not.toBeInTheDocument();
    expect(io.fetchPerformance).not.toHaveBeenCalled();
  });

  it("does not render zero metrics when the fetched summary has no operator", async () => {
    io.fetchPerformance.mockResolvedValue(makeSummary(operatorA, { operator: null }));
    renderPage();

    expect(await screen.findByText("לא נמצאו נתוני עובד עבור החשבון הפעיל.")).toBeInTheDocument();
    expect(screen.queryByText("קרדיטים זמינים")).not.toBeInTheDocument();
  });

  it("isolates A to B identity changes from a late response and cleans the old channel", async () => {
    const responseA = deferred<Summary>();
    io.fetchPerformance.mockImplementation((operatorId) =>
      operatorId === operatorA.id
        ? responseA.promise
        : Promise.resolve(makeSummary(operatorB, { availablePoints: 73 })),
    );
    const view = renderPage();
    expect(screen.getByRole("status", { name: "טוען נתוני ביצועים" })).toBeInTheDocument();
    const channelA = io.channels[0];

    io.operator = operatorB;
    io.sessionUserId = operatorB.user_id;
    view.rerender();
    expect(await screen.findByText("73")).toBeInTheDocument();
    expect(io.removeChannel).toHaveBeenCalledWith(channelA);
    expect(io.channels[1]?.name).toBe("operator-performance-operator-b");
    await act(async () => responseA.resolve(makeSummary(operatorA, { availablePoints: 999 })));

    expect(screen.getByText("73")).toBeInTheDocument();
    expect(screen.queryByText("999")).not.toBeInTheDocument();
  });

  it("clears current data and subscription on logout", async () => {
    const view = renderPage();
    await screen.findByText("קרדיטים זמינים");
    expect(screen.getAllByText("37").length).toBeGreaterThan(0);
    const channelA = io.channels[0];

    io.operator = null;
    view.rerender();

    expect(screen.getByText("אין חשבון עובד פעיל להצגת נתוני ביצועים.")).toBeInTheDocument();
    expect(screen.queryByText("37")).not.toBeInTheDocument();
    expect(io.removeChannel).toHaveBeenCalledWith(channelA);
  });

  it("preserves the realtime filters and removes the channel on unmount", async () => {
    const view = renderPage();
    await screen.findByText("קרדיטים זמינים");
    const channel = io.channels[0];

    expect(channel.name).toBe("operator-performance-operator-a");
    expect(channel.on).toHaveBeenNthCalledWith(
      1,
      "postgres_changes",
      expect.objectContaining({ table: "credit_wallets", filter: "user_id=eq.user-a" }),
      expect.any(Function),
    );
    expect(channel.on).toHaveBeenNthCalledWith(
      2,
      "postgres_changes",
      expect.objectContaining({ table: "credit_transactions", filter: "user_id=eq.user-a" }),
      expect.any(Function),
    );
    view.unmount();
    expect(io.removeChannel).toHaveBeenCalledWith(channel);
  });

  it("preserves metrics, history, chart container, assignments, and invalidation prefix", async () => {
    const { queryClient } = renderPage();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    expect(await screen.findByText("קרדיטים זמינים")).toBeInTheDocument();
    expect(screen.getByText("+12")).toBeInTheDocument();
    expect(screen.getByText("2 דקות")).toBeInTheDocument();
    expect(screen.getByText("אוק׳ 26׳")).toBeInTheDocument();
    expect(screen.getByText("מאיה")).toBeInTheDocument();
    expect(document.querySelector("[data-chart]")).toBeInTheDocument();
    expect(document.querySelector('img[src="https://example.test/maya.png"]')).toBeInTheDocument();

    const walletCallback = io.channels[0].on.mock.calls[0][2] as () => void;
    walletCallback();
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["operator-performance", operatorA.id],
      }),
    );
  });
});
