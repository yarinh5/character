import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Context = { userId: string };
type Middleware = (input: { next: (input: { context: Context }) => unknown }) => unknown;

const io = vi.hoisted(() => ({
  request: vi.fn(),
  claims: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  role: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({ server: (run: Middleware) => run }),
  createServerFn: () => {
    let auth: Middleware;
    return {
      middleware([run]: [Middleware]) {
        auth = run;
        return this;
      },
      inputValidator() {
        return this;
      },
      handler(run: (input: { context: Context }) => unknown) {
        return async () => auth({ next: run });
      },
    };
  },
}));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: io.request }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getClaims: io.claims } }),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: io.from, rpc: io.rpc },
}));

import { adminAnalytics } from "@/lib/analytics.functions";

const dayKeys = Array.from({ length: 14 }, (_, i) =>
  new Date(2026, 2, 20 + i).toISOString().slice(0, 10),
);
const snapshot = {
  days: dayKeys.map((date) => ({ date, conversations: 0, users: 0, messages: 0 })),
  avgResponseSec: 2,
  topOperators: [{ name: "Operator profile", count: 10001 }],
  topCharacters: [{ name: "Character", count: 10001 }],
  totalCreditsSpent: 20002,
  manualCreditsAdded: 30003,
  clientMessages: 10001,
  operatorMessages: 10004,
  topOperatorsByAvailablePoints: [
    {
      id: "operator-a",
      name: "Operator",
      availablePoints: 20,
      monthlyPayouts: 15001.5,
      messages: 10001,
      status: "available",
      isActive: true,
    },
  ],
  lowBalanceUsers: [{ userId: "client-a", name: "Client", email: null, balance: 1 }],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-02T12:34:56Z"));
  vi.stubEnv("SUPABASE_URL", "https://supabase.example.invalid");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "test-publishable-key");
  io.request
    .mockReset()
    .mockReturnValue({ headers: new Headers({ authorization: "Bearer test" }) });
  io.claims.mockReset().mockResolvedValue({ data: { claims: { sub: "admin-a" } }, error: null });
  const query = { select: io.select, eq: io.eq, maybeSingle: io.role };
  io.from.mockReset().mockImplementation((table: string) => {
    if (table !== "user_roles") throw new Error(`Unexpected service read: ${table}`);
    return query;
  });
  io.select.mockReset().mockReturnValue(query);
  io.eq.mockReset().mockReturnValue(query);
  io.role.mockReset().mockResolvedValue({ data: { role: "admin" }, error: null });
  io.rpc.mockReset().mockResolvedValue({ data: snapshot, error: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("active dashboard aggregate server boundary", () => {
  it("keeps the existing local-midnight cutoffs and 14 UTC keys through a DST and month change", async () => {
    expect(await adminAnalytics()).toEqual(snapshot);
    expect(io.from).toHaveBeenCalledExactlyOnceWith("user_roles");
    expect(io.eq.mock.calls).toEqual([
      ["user_id", "admin-a"],
      ["role", "admin"],
    ]);
    expect(io.role.mock.invocationCallOrder[0]).toBeLessThan(io.rpc.mock.invocationCallOrder[0]);
    expect(io.rpc).toHaveBeenCalledExactlyOnceWith("get_admin_dashboard_analytics_for_server", {
      _since: new Date(2026, 2, 20).toISOString(),
      _month_start: new Date(2026, 3, 1).toISOString(),
      _day_keys: dayKeys,
    });
  });

  it("rejects anonymous requests before any service request", async () => {
    io.request.mockReturnValue({ headers: new Headers() });
    await expect(adminAnalytics()).rejects.toMatchObject({ status: 401 });
    expect(io.from).not.toHaveBeenCalled();
    expect(io.rpc).not.toHaveBeenCalled();
  });

  it("rejects authenticated non-admins before the service aggregate", async () => {
    io.claims.mockResolvedValue({ data: { claims: { sub: "client-a" } }, error: null });
    io.role.mockResolvedValue({ data: null, error: null });
    await expect(adminAnalytics()).rejects.toThrow();
    expect(io.eq.mock.calls).toEqual([
      ["user_id", "client-a"],
      ["role", "admin"],
    ]);
    expect(io.rpc).not.toHaveBeenCalled();
  });

  it("rejects an aggregate error even when the response includes data", async () => {
    io.rpc.mockResolvedValue({ data: snapshot, error: { message: "internal detail" } });
    await expect(adminAnalytics()).rejects.toThrow("admin_dashboard_analytics_unavailable");
  });

  it.each([
    null,
    { ...snapshot, days: snapshot.days.slice(1) },
    { ...snapshot, days: [...snapshot.days].reverse() },
  ])("rejects a missing or incomplete snapshot (%#)", async (data) => {
    io.rpc.mockResolvedValue({ data, error: null });
    await expect(adminAnalytics()).rejects.toThrow();
  });
});
