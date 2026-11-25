import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const io = vi.hoisted(() => ({
  isAdmin: true,
  logs: [] as Row[],
  logError: null as { message: string } | null,
  profiles: [] as Row[],
  calls: [] as Array<[string, ...unknown[]]>,
  validator: null as null | ((value: unknown) => unknown),
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    middleware() {
      return this;
    },
    inputValidator(validator: (value: unknown) => unknown) {
      io.validator = validator;
      return this;
    },
    handler(handler: (input: { data: unknown; context: { userId: string } }) => Promise<unknown>) {
      return (input: { data?: unknown; context: { userId: string } }) =>
        handler({ data: io.validator?.(input.data) ?? input.data, context: input.context });
    },
  }),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from(table: string) {
      io.calls.push(["from", table]);
      if (table === "user_roles") {
        const query = {
          select(value: string) {
            io.calls.push(["roles.select", value]);
            return query;
          },
          eq(column: string, value: unknown) {
            io.calls.push(["roles.eq", column, value]);
            return query;
          },
          maybeSingle() {
            return Promise.resolve({ data: io.isAdmin ? { role: "admin" } : null });
          },
        };
        return query;
      }
      if (table === "profiles") {
        const query = {
          select(value: string) {
            io.calls.push(["profiles.select", value]);
            return query;
          },
          in(column: string, values: unknown[]) {
            io.calls.push(["profiles.in", column, values]);
            return Promise.resolve({ data: io.profiles });
          },
        };
        return query;
      }
      const query = {
        select(value: string) {
          io.calls.push(["logs.select", value]);
          return query;
        },
        order(column: string, options: unknown) {
          io.calls.push(["logs.order", column, options]);
          return query;
        },
        limit(value: number) {
          io.calls.push(["logs.limit", value]);
          return query;
        },
        eq(column: string, value: unknown) {
          io.calls.push(["logs.eq", column, value]);
          return query;
        },
        or(value: string) {
          io.calls.push(["logs.or", value]);
          return query;
        },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          return Promise.resolve({ data: io.logs, error: io.logError }).then(resolve, reject);
        },
      };
      return query;
    },
  },
}));

import { adminListAuditLogs } from "@/lib/audit.functions";

const invoke = adminListAuditLogs as unknown as (input: {
  data?: unknown;
  context: { userId: string };
}) => Promise<{
  items: Row[];
  nextCursor: { createdAt: string; id: string } | null;
}>;

const rows = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    actor_user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    action: "first",
    entity_type: "demo",
    entity_id: "1",
    metadata: {},
    created_at: "2026-10-06T12:00:00+03:00",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    actor_user_id: null,
    action: "second",
    entity_type: "demo",
    entity_id: "2",
    metadata: {},
    created_at: "2026-10-06T12:00:00+03:00",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    actor_user_id: null,
    action: "lookahead",
    entity_type: "demo",
    entity_id: "3",
    metadata: {},
    created_at: "2026-10-06T10:00:00+03:00",
  },
];

beforeEach(() => {
  io.isAdmin = true;
  io.logs = [];
  io.logError = null;
  io.profiles = [];
  io.calls = [];
});

describe("adminListAuditLogs", () => {
  it("uses stable created_at/id keyset ordering and the last returned row as cursor", async () => {
    io.logs = rows;
    io.profiles = [
      {
        user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        email: "admin@example.test",
        display_name: "Admin",
      },
    ];
    const cursor = {
      createdAt: "2026-10-06T13:00:00+03:00",
      id: "44444444-4444-4444-8444-444444444444",
    };

    const result = await invoke({
      data: { limit: 2, cursor, action: "media.sent" },
      context: { userId: "admin-user" },
    });

    expect(io.calls.filter(([name]) => name === "logs.order")).toEqual([
      ["logs.order", "created_at", { ascending: false }],
      ["logs.order", "id", { ascending: false }],
    ]);
    expect(io.calls).toContainEqual(["logs.limit", 3]);
    expect(io.calls).toContainEqual(["logs.eq", "action", "media.sent"]);
    expect(io.calls).toContainEqual([
      "logs.or",
      `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
    ]);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.actor).toEqual({
      user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      email: "admin@example.test",
      display_name: "Admin",
    });
    expect(result.nextCursor).toEqual({
      createdAt: rows[1]?.created_at,
      id: rows[1]?.id,
    });
  });

  it("uses the id tie-breaker from a page cursor when created_at values are equal", async () => {
    expect(rows[0]?.created_at).toBe(rows[1]?.created_at);
    io.logs = rows;
    const firstPage = await invoke({ data: { limit: 2 }, context: { userId: "admin-user" } });
    expect(firstPage.nextCursor).toEqual({
      createdAt: rows[1]?.created_at,
      id: rows[1]?.id,
    });

    io.calls = [];
    io.logs = [];
    await invoke({
      data: { limit: 2, cursor: firstPage.nextCursor! },
      context: { userId: "admin-user" },
    });

    expect(io.calls).toContainEqual([
      "logs.or",
      `created_at.lt.${firstPage.nextCursor?.createdAt},and(created_at.eq.${firstPage.nextCursor?.createdAt},id.lt.${firstPage.nextCursor?.id})`,
    ]);
  });

  it.each([0, 1, 2])("returns no cursor for a page with %i rows at limit", async (count) => {
    io.logs = rows.slice(0, count);
    const result = await invoke({ data: { limit: 2 }, context: { userId: "admin-user" } });
    expect(result.items).toHaveLength(count);
    expect(result.nextCursor).toBeNull();
  });

  it("rejects an invalid UUID cursor before querying", async () => {
    expect(() =>
      invoke({
        data: { cursor: { createdAt: "2026-10-06T12:00:00+03:00", id: "not-a-uuid" } },
        context: { userId: "admin-user" },
      }),
    ).toThrow();
    expect(io.calls).toEqual([]);
  });

  it("rejects a malformed cursor timestamp before querying", () => {
    expect(() =>
      invoke({
        data: {
          cursor: {
            createdAt: "not-a-timestamp",
            id: "44444444-4444-4444-8444-444444444444",
          },
        },
        context: { userId: "admin-user" },
      }),
    ).toThrow();
    expect(io.calls).toEqual([]);
  });

  it("propagates database errors", async () => {
    io.logError = { message: "database unavailable" };
    await expect(invoke({ data: {}, context: { userId: "admin-user" } })).rejects.toThrow(
      "database unavailable",
    );
  });

  it("rejects callers without the admin role before reading logs", async () => {
    io.isAdmin = false;
    await expect(invoke({ data: {}, context: { userId: "non-admin" } })).rejects.toThrow(
      "אין הרשאת מנהל",
    );
    expect(io.calls.some(([name, table]) => name === "from" && table === "audit_logs")).toBe(false);
  });
});
