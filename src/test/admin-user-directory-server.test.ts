import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  from: vi.fn(),
  role: vi.fn(),
  rpc: vi.fn(),
  authUpdate: vi.fn(),
  authCreate: vi.fn(),
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
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: io.from,
    auth: { admin: { updateUserById: io.authUpdate, createUser: io.authCreate } },
  },
}));
vi.mock("@/lib/audit.server", () => ({ logAudit: vi.fn() }));

import { adminCreateUser, adminListUsers, adminUpdateUser } from "@/lib/admin-users.functions";

type Input = {
  data: Record<string, unknown>;
  context: { userId: string; supabase: { rpc: typeof io.rpc } };
};
const list = adminListUsers as unknown as (input: Input) => Promise<unknown>;
const update = adminUpdateUser as unknown as (input: Input) => Promise<unknown>;
const create = adminCreateUser as unknown as (input: Input) => Promise<unknown>;
const context = () => ({ userId: "admin-a", supabase: { rpc: io.rpc } });

beforeEach(() => {
  const query = { select: () => query, eq: () => query, maybeSingle: io.role };
  io.from.mockReset().mockImplementation((table: string) => {
    if (table !== "user_roles") throw new Error(`Unexpected service-role table: ${table}`);
    return query;
  });
  io.role.mockReset().mockResolvedValue({ data: { role: "admin" }, error: null });
  io.rpc.mockReset().mockResolvedValue({ data: [], error: null });
  io.authUpdate.mockReset().mockResolvedValue({ error: null });
  io.authCreate.mockReset().mockResolvedValue({
    data: { user: { id: "00000000-0000-4000-8000-000000000003" } },
    error: null,
  });
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

  it("rejects self role changes before any email or profile write", async () => {
    const adminId = "00000000-0000-4000-8000-000000000001";
    await expect(
      update({
        data: {
          user_id: adminId,
          role: "client",
          email: "changed@example.test",
          display_name: "Changed",
        },
        context: { userId: adminId, supabase: { rpc: io.rpc } },
      }),
    ).rejects.toThrow("לא ניתן לשנות את התפקיד של עצמך מכאן");
    expect(io.from).toHaveBeenCalledExactlyOnceWith("user_roles");
    expect(io.authUpdate).not.toHaveBeenCalled();
  });

  it("delegates another user's role transition to one authenticated transaction", async () => {
    io.rpc.mockResolvedValueOnce({ data: true, error: null });
    const targetId = "00000000-0000-4000-8000-000000000002";
    await expect(
      update({ data: { user_id: targetId, role: "operator" }, context: context() }),
    ).resolves.toEqual({ ok: true });
    expect(io.from).toHaveBeenCalledExactlyOnceWith("user_roles");
    expect(io.rpc).toHaveBeenCalledExactlyOnceWith("admin_set_user_role", {
      _user_id: targetId,
      _new_role: "operator",
    });
  });

  it("does not report a role change when the transaction is rejected", async () => {
    io.rpc.mockResolvedValueOnce({ data: null, error: { message: "transition rejected" } });
    const targetId = "00000000-0000-4000-8000-000000000002";
    await expect(
      update({ data: { user_id: targetId, role: "client" }, context: context() }),
    ).rejects.toThrow("transition rejected");
    expect(io.from).toHaveBeenCalledExactlyOnceWith("user_roles");
    io.rpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(
      update({ data: { user_id: targetId, role: "client" }, context: context() }),
    ).rejects.toThrow("role_change_not_confirmed");
  });

  it("provisions a new user's role through the same authenticated transaction", async () => {
    const query = { eq: () => Promise.resolve({ error: null }) };
    io.from.mockImplementation((table: string) => {
      if (table === "user_roles")
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: io.role }) }) }) };
      if (table === "profiles") return { update: () => query };
      throw new Error(`Unexpected service-role table: ${table}`);
    });
    io.rpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(
      create({
        data: {
          email: "new@example.test",
          password: "password123",
          full_name: "New User",
          role: "operator",
        },
        context: context(),
      }),
    ).resolves.toEqual({ user_id: "00000000-0000-4000-8000-000000000003" });
    expect(io.rpc).toHaveBeenCalledExactlyOnceWith("admin_set_user_role", {
      _user_id: "00000000-0000-4000-8000-000000000003",
      _new_role: "operator",
    });
    expect(io.from).not.toHaveBeenCalledWith("operators");
    expect(io.from).not.toHaveBeenCalledWith("client_profiles");
  });
});
