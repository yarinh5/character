import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  from: vi.fn(),
  role: vi.fn(),
  rpc: vi.fn(),
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

import { adminListClients } from "@/lib/admin-clients.functions";

type Input = {
  data: Record<string, unknown>;
  context: { userId: string; supabase: { rpc: typeof io.rpc } };
};
const list = adminListClients as unknown as (input: Input) => Promise<unknown>;
const context = () => ({ userId: "admin-a", supabase: { rpc: io.rpc } });

beforeEach(() => {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: io.role,
  };
  io.from.mockReset().mockImplementation((table: string) => {
    if (table !== "user_roles") throw new Error(`Unexpected service-role table: ${table}`);
    return query;
  });
  io.role.mockReset().mockResolvedValue({ data: { role: "admin" }, error: null });
  io.rpc.mockReset().mockResolvedValue({ data: [], error: null });
});

describe("admin client directory server boundary", () => {
  it("uses the authenticated admin RPC with bounded cursor input", async () => {
    io.rpc.mockResolvedValueOnce({
      data: [{ user_id: "client-a", credits_balance: null, conversations_count: 0 }],
      error: null,
    });
    const rows = await list({
      data: {
        search: "alpha@example.test",
        before_created_at: "2026-11-25T12:00:00Z",
        before_user_id: "00000000-0000-4000-8000-000000000001",
      },
      context: context(),
    });
    expect(rows).toEqual([{ user_id: "client-a", credits_balance: null, conversations_count: 0 }]);
    expect(io.from).toHaveBeenCalledExactlyOnceWith("user_roles");
    expect(io.rpc).toHaveBeenCalledExactlyOnceWith(
      "admin_list_clients_page",
      expect.objectContaining({
        _search: "alpha@example.test",
        _page_size: 101,
        _before_created_at: "2026-11-25T12:00:00Z",
        _before_user_id: "00000000-0000-4000-8000-000000000001",
      }),
    );
  });

  it("rejects a non-admin and invalid page contracts before reading clients", async () => {
    io.role.mockResolvedValueOnce({ data: null, error: null });
    await expect(list({ data: {}, context: context() })).rejects.toThrow("אין הרשאת מנהל");
    expect(io.rpc).not.toHaveBeenCalled();
    await expect(
      Promise.resolve().then(() => list({ data: { page_size: 102 }, context: context() })),
    ).rejects.toThrow();
    await expect(
      Promise.resolve().then(() =>
        list({ data: { before_created_at: "2026-11-25T12:00:00Z" }, context: context() }),
      ),
    ).rejects.toThrow("invalid_client_cursor");
    expect(io.rpc).not.toHaveBeenCalled();
  });

  it("surfaces RPC and malformed-page failures without substituting empty or zero values", async () => {
    io.rpc.mockResolvedValueOnce({ data: null, error: { message: "database unavailable" } });
    await expect(list({ data: {}, context: context() })).rejects.toThrow("database unavailable");
    io.rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(list({ data: {}, context: context() })).rejects.toThrow(
      "invalid_client_directory_page",
    );
  });
});
