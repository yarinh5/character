import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type DateRange = { startDate: string; endDate: string };

const io = vi.hoisted(() => ({
  isAdmin: true,
  rpcCalls: [] as Array<[string, DateRange]>,
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validator: ((value: unknown) => unknown) | undefined;
    return {
      middleware() {
        return this;
      },
      inputValidator(nextValidator: (value: unknown) => unknown) {
        validator = nextValidator;
        return this;
      },
      handler(
        handler: (input: {
          data: unknown;
          context: { userId: string };
        }) => Promise<unknown>,
      ) {
        return (input: { data?: unknown; context: { userId: string } }) =>
          handler({
            data: validator ? validator(input.data) : input.data,
            context: input.context,
          });
      },
    };
  },
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from(table: string) {
      if (table !== "user_roles") throw new Error(`Unexpected table: ${table}`);
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        maybeSingle() {
          return Promise.resolve({ data: io.isAdmin ? { role: "admin" } : null });
        },
      };
      return query;
    },
    rpc(name: string, args: { _start_date: string; _end_date: string }) {
      const range = { startDate: args._start_date, endDate: args._end_date };
      io.rpcCalls.push([name, range]);
      return Promise.resolve({
        data: {
          range,
          kpis: {
            newUsers: 0,
            conversationsStarted: 0,
            clientMessages: 0,
            operatorMessages: 0,
            characterViews: 0,
            packagesViewed: 0,
            insufficientCredits: 0,
            creditsBurn: 0,
          },
          funnel: [],
          days: [],
          topCharacters: [],
          topOperators: [],
        },
        error: null,
      });
    },
  },
}));

import { adminAdvancedAnalytics } from "@/lib/analytics.functions";

const invoke = adminAdvancedAnalytics as unknown as (input: {
  data?: Partial<DateRange>;
  context: { userId: string };
}) => Promise<unknown>;

async function call(data?: Partial<DateRange>) {
  await invoke({ data, context: { userId: "admin-user" } });
  return io.rpcCalls.at(-1)?.[1];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-30T12:34:56.000Z"));
  io.isAdmin = true;
  io.rpcCalls = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("admin analytics calendar-date contract", () => {
  it("uses a timezone-independent 30-day inclusive UTC default", async () => {
    expect(await call()).toEqual({ startDate: "2026-03-01", endDate: "2026-03-30" });
  });

  it.each([
    ["one day", "2026-03-30", "2026-03-30"],
    ["leap day", "2024-02-29", "2024-02-29"],
    ["180 inclusive days", "2026-01-01", "2026-06-29"],
  ])("accepts %s without normalization", async (_case, startDate, endDate) => {
    expect(await call({ startDate, endDate })).toEqual({ startDate, endDate });
  });

  it.each([
    ["impossible date", "2026-02-30", "2026-03-02"],
    ["non-canonical date", "2026-2-01", "2026-03-02"],
    ["reversed range", "2026-03-02", "2026-03-01"],
    ["181 inclusive days", "2026-01-01", "2026-06-30"],
  ])("rejects %s before the aggregate RPC", async (_case, startDate, endDate) => {
    await expect(call({ startDate, endDate })).rejects.toThrow();
    expect(io.rpcCalls).toEqual([]);
  });

  it("rejects a partial explicit range instead of mixing it with a default", async () => {
    await expect(call({ startDate: "2026-03-01" })).rejects.toThrow();
    expect(io.rpcCalls).toEqual([]);
  });

  it("preserves the admin authorization boundary before the aggregate RPC", async () => {
    io.isAdmin = false;
    await expect(call({ startDate: "2026-03-01", endDate: "2026-03-30" })).rejects.toThrow(
      "אין הרשאת מנהל",
    );
    expect(io.rpcCalls).toEqual([]);
  });
});
