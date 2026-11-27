import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  from: vi.fn(),
  operators: vi.fn(),
  enrich: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validator: (value: unknown) => unknown;
    return {
      middleware() {
        return this;
      },
      inputValidator(next: (value: unknown) => unknown) {
        validator = next;
        return this;
      },
      handler(run: (input: { data: unknown; context: unknown }) => Promise<unknown>) {
        return (input: { data: unknown; context: unknown }) =>
          run({ data: validator(input.data), context: input.context });
      },
    };
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: io.from } }));
vi.mock("@/lib/audit.server", () => ({ logAudit: vi.fn() }));

import { adminListOperators } from "@/lib/admin-operators.functions";

const list = adminListOperators as unknown as (input: {
  data: { show_archived_only: boolean };
  context: { userId: string };
}) => Promise<unknown>;

beforeEach(() => {
  io.operators.mockReset().mockResolvedValue({
    data: [
      {
        id: "operator-1",
        user_id: "user-1",
        full_name: "Operator",
        is_active: true,
        availability_status: "available",
        created_at: "2026-11-26T00:00:00Z",
        deleted_at: null,
      },
    ],
    error: null,
  });
  io.enrich.mockReset().mockImplementation((table: string) => ({
    data:
      table === "user_roles"
        ? [{ user_id: "user-1", role: "operator" }]
        : table === "operator_point_wallets"
          ? [{ operator_id: "operator-1", balance: 42 }]
          : [],
    error: null,
  }));
  io.from.mockReset().mockImplementation((table: string) => {
    if (table === "operators") {
      return {
        select: () => ({ order: () => ({ is: io.operators, not: io.operators }) }),
      };
    }
    if (table === "user_roles") {
      return {
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: "admin" } }) }) }),
          in: () => io.enrich(table),
        }),
      };
    }
    return { select: () => ({ in: () => io.enrich(table) }) };
  });
});

describe("admin operator directory enrichment", () => {
  it("returns verified balances and roles", async () => {
    await expect(
      list({ data: { show_archived_only: false }, context: { userId: "admin-1" } }),
    ).resolves.toEqual([expect.objectContaining({ role: "operator", credit_balance: 42 })]);
  });

  it.each([
    "user_roles",
    "character_operator_assignments",
    "conversations",
    "profiles",
    "operator_point_wallets",
  ])("surfaces a %s read failure instead of returning partial zeros", async (table) => {
    io.enrich.mockImplementation((name: string) =>
      name === table
        ? { data: null, error: { message: `${table} unavailable` } }
        : { data: [], error: null },
    );
    await expect(
      list({ data: { show_archived_only: false }, context: { userId: "admin-1" } }),
    ).rejects.toThrow(`${table} unavailable`);
  });
});
