import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ from: vi.fn(), role: vi.fn(), rpc: vi.fn() }));

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

import { adminListUsers } from "@/lib/admin-users.functions";

type Input = {
  data: Record<string, unknown>;
  context: { userId: string; supabase: { rpc: typeof io.rpc } };
};
const list = adminListUsers as unknown as (input: Input) => Promise<unknown>;
const context = () => ({ userId: "admin-a", supabase: { rpc: io.rpc } });

beforeEach(() => {
  const query = { select: () => query, eq: () => query, maybeSingle: io.role };
  io.from.mockReset().mockImplementation((table: string) => {
    if (table !== "user_roles") throw new Error(`Unexpected service-role table: ${table}`);
    return query;
  });
  io.role.mockReset().mockResolvedValue({ data: { role: "admin" }, error: null });
  io.rpc.mockReset().mockResolvedValue({ data: [], error: null });
});

describe("admin user directory server boundary", () => {
  it("pages through the authenticated RPC and preserves a missing role", async () => {
    const orphan = { user_id: "orphan", role: null, created_at: "2026-11-26T00:00:00Z" };
    io.rpc.mockResolvedValueOnce({ data: [orphan], error: null });
    const rows = await list({
      data: {
        search: "orphan@example.test",
        role: "all",
        before_created_at: "2026-11-26T00:00:00Z",
        before_user_id: "00000000-0000-4000-8000-000000000001",
      },
      context: context(),
    });
    expect(rows).toEqual([orphan]);
    expect(io.from).toHaveBeenCalledExactlyOnceWith("user_roles");
    expect(io.rpc).toHaveBeenCalledExactlyOnceWith(
      "admin_list_users_page",
      expect.objectContaining({
        _search: "orphan@example.test",
        _role: "all",
        _page_size: 101,
        _before_user_id: "00000000-0000-4000-8000-000000000001",
      }),
    );
  });

  it("rejects non-admin and invalid page inputs before listing users", async () => {
    io.role.mockResolvedValueOnce({ data: null, error: null });
    await expect(list({ data: {}, context: context() })).rejects.toThrow("אין הרשאת מנהל");
    await expect(
      Promise.resolve().then(() => list({ data: { page_size: 102 }, context: context() })),
    ).rejects.toThrow();
    await expect(
      Promise.resolve().then(() =>
        list({ data: { before_created_at: "2026-11-26T00:00:00Z" }, context: context() }),
      ),
    ).rejects.toThrow("invalid_user_cursor");
    expect(io.rpc).not.toHaveBeenCalled();
  });

  it("does not turn RPC failures or malformed pages into an empty list", async () => {
    io.rpc.mockResolvedValueOnce({ data: null, error: { message: "db unavailable" } });
    await expect(list({ data: {}, context: context() })).rejects.toThrow("db unavailable");
    io.rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(list({ data: {}, context: context() })).rejects.toThrow(
      "invalid_user_directory_page",
    );
  });
});
