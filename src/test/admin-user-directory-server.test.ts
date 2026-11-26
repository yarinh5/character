import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  from: vi.fn(),
  role: vi.fn(),
  rpc: vi.fn(),
  authUpdate: vi.fn(),
  authCreate: vi.fn(),
  audit: vi.fn(),
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
vi.mock("@/lib/audit.server", () => ({ logAudit: io.audit }));

import {
  adminCreateUser,
  adminListUsers,
  adminSetStatus,
  adminSoftDeleteUser,
  adminUpdateUser,
} from "@/lib/admin-users.functions";

type Input = {
  data: Record<string, unknown>;
  context: { userId: string; supabase: { rpc: typeof io.rpc } };
};
const list = adminListUsers as unknown as (input: Input) => Promise<unknown>;
const update = adminUpdateUser as unknown as (input: Input) => Promise<unknown>;
const create = adminCreateUser as unknown as (input: Input) => Promise<unknown>;
const softDelete = adminSoftDeleteUser as unknown as (input: Input) => Promise<unknown>;
const setStatus = adminSetStatus as unknown as (input: Input) => Promise<unknown>;
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
  io.audit.mockReset();
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
    expect(io.rpc).toHaveBeenCalledExactlyOnceWith("admin_update_user_db", {
      _user_id: targetId,
      _display_name: null,
      _email: null,
      _status: null,
      _role: "operator",
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
    ).rejects.toThrow("user_update_not_confirmed");
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

  it.each([
    ["profile lookup", { message: "lookup failed" }, false],
    ["profile missing", null, true],
  ])("does not report deletion when %s fails", async (_step, lookupError, missing) => {
    io.role.mockResolvedValueOnce({ data: { role: "admin" }, error: null });
    io.role.mockResolvedValueOnce({ data: null, error: null });
    const profileLookup = vi.fn().mockResolvedValue({
      data: lookupError || missing ? null : { email: "user@example.test" },
      error: lookupError,
    });
    io.from.mockImplementation((table: string) => {
      if (table === "user_roles")
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: io.role }) }) }) };
      if (table === "profiles")
        return {
          select: () => ({ eq: () => ({ maybeSingle: profileLookup }) }),
        };
      throw new Error(`Unexpected service-role table: ${table}`);
    });
    await expect(
      softDelete({
        data: { user_id: "00000000-0000-4000-8000-000000000002" },
        context: context(),
      }),
    ).rejects.toThrow();
    expect(io.authUpdate).not.toHaveBeenCalled();
    expect(io.rpc).not.toHaveBeenCalled();
    expect(io.audit).not.toHaveBeenCalled();
  });

  it("uses one authenticated DB mutation after the Auth ban for soft delete", async () => {
    io.role.mockResolvedValueOnce({ data: { role: "admin" }, error: null });
    io.role.mockResolvedValueOnce({ data: null, error: null });
    const calls: string[] = [];
    io.from.mockImplementation((table: string) => {
      if (table === "user_roles")
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: io.role }) }) }) };
      if (table === "profiles")
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { email: "user@example.test" }, error: null }),
            }),
          }),
        };
      throw new Error(`Unexpected independent DB write: ${table}`);
    });
    io.authUpdate.mockImplementation(async () => {
      calls.push("auth-ban");
      return { error: null };
    });
    io.rpc.mockImplementation(async () => {
      calls.push("db-archive");
      return { data: true, error: null };
    });
    const userId = "00000000-0000-4000-8000-000000000002";
    await expect(softDelete({ data: { user_id: userId }, context: context() })).resolves.toEqual({
      ok: true,
    });
    expect(calls).toEqual(["auth-ban", "db-archive"]);
    expect(io.rpc).toHaveBeenCalledExactlyOnceWith("admin_soft_delete_user", {
      _user_id: userId,
    });
    expect(io.audit).not.toHaveBeenCalled();
  });

  it("bans a user in Auth before reporting a blocked profile", async () => {
    io.role.mockResolvedValueOnce({ data: { role: "admin" }, error: null });
    io.role.mockResolvedValueOnce({ data: null, error: null });
    const writes: string[] = [];
    io.authUpdate.mockImplementation(async () => {
      writes.push("auth-ban");
      return { error: null };
    });
    io.from.mockImplementation((table: string) => {
      if (table === "user_roles")
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: io.role }) }) }) };
      throw new Error(`Unexpected service-role table: ${table}`);
    });
    io.rpc.mockImplementation(async () => {
      writes.push("status-rpc");
      return { data: true, error: null };
    });
    await expect(
      setStatus({
        data: { user_id: "00000000-0000-4000-8000-000000000002", status: "blocked" },
        context: context(),
      }),
    ).resolves.toEqual({ ok: true });
    expect(io.authUpdate).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000002", {
      ban_duration: "876000h",
    });
    expect(writes).toEqual(["auth-ban", "status-rpc"]);
    expect(io.audit).not.toHaveBeenCalled();
  });

  it("does not claim a status change if Auth rejects the ban", async () => {
    io.role.mockResolvedValueOnce({ data: { role: "admin" }, error: null });
    io.role.mockResolvedValueOnce({ data: null, error: null });
    io.authUpdate.mockResolvedValueOnce({ error: { message: "auth unavailable" } });
    await expect(
      setStatus({
        data: { user_id: "00000000-0000-4000-8000-000000000002", status: "blocked" },
        context: context(),
      }),
    ).rejects.toThrow("auth unavailable");
    expect(io.from).toHaveBeenCalledTimes(2);
    expect(io.from).toHaveBeenNthCalledWith(1, "user_roles");
    expect(io.from).toHaveBeenNthCalledWith(2, "user_roles");
    expect(io.audit).not.toHaveBeenCalled();
  });

  it("uses the Auth ban for blocked status in the edit form", async () => {
    io.role.mockResolvedValueOnce({ data: { role: "admin" }, error: null });
    io.role.mockResolvedValueOnce({ data: null, error: null });
    io.from.mockImplementation((table: string) => {
      if (table === "user_roles")
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: io.role }) }) }) };
      throw new Error(`Unexpected service-role table: ${table}`);
    });
    io.rpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(
      update({
        data: { user_id: "00000000-0000-4000-8000-000000000002", status: "blocked" },
        context: context(),
      }),
    ).resolves.toEqual({ ok: true });
    expect(io.authUpdate).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000002", {
      ban_duration: "876000h",
    });
  });

  it("routes edited status through the authenticated, audited DB boundary", async () => {
    io.role.mockResolvedValueOnce({ data: { role: "admin" }, error: null });
    io.role.mockResolvedValueOnce({ data: null, error: null });
    const userId = "00000000-0000-4000-8000-000000000002";
    io.rpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(
      update({ data: { user_id: userId, status: "blocked" }, context: context() }),
    ).resolves.toEqual({ ok: true });
    expect(io.rpc).toHaveBeenCalledExactlyOnceWith("admin_update_user_db", {
      _user_id: userId,
      _display_name: null,
      _email: null,
      _status: "blocked",
      _role: null,
    });
    expect(io.from).not.toHaveBeenCalledWith("profiles");
    expect(io.audit).not.toHaveBeenCalled();
  });

  it("rejects a blocked privileged-role edit before touching Auth", async () => {
    for (const role of ["admin", "operator"] as const) {
      await expect(
        update({
          data: {
            user_id: "00000000-0000-4000-8000-000000000002",
            status: "blocked",
            role,
          },
          context: context(),
        }),
      ).rejects.toThrow("blocked_privileged_role_forbidden");
    }
    expect(io.authUpdate).not.toHaveBeenCalled();
    expect(io.rpc).not.toHaveBeenCalled();
  });

  it("blocks self-status changes before touching Auth or profile", async () => {
    const adminId = "00000000-0000-4000-8000-000000000001";
    await expect(
      setStatus({
        data: { user_id: adminId, status: "blocked" },
        context: { userId: adminId, supabase: { rpc: io.rpc } },
      }),
    ).rejects.toThrow();
    expect(io.authUpdate).not.toHaveBeenCalled();
    expect(io.from).toHaveBeenCalledExactlyOnceWith("user_roles");
  });

  it("unbans only after an active profile write succeeds", async () => {
    io.role.mockResolvedValueOnce({ data: { role: "admin" }, error: null });
    io.role.mockResolvedValueOnce({ data: null, error: null });
    const writes: string[] = [];
    io.from.mockImplementation((table: string) => {
      if (table === "user_roles")
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: io.role }) }) }) };
      if (table === "profiles")
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { deleted_at: null, pii_archived_at: null },
                error: null,
              }),
            }),
          }),
        };
      if (table === "account_deletion_requests")
        return {
          select: () => ({
            eq: () => ({
              not: () => ({
                is: () => ({
                  limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
                }),
              }),
            }),
          }),
        };
      throw new Error(`Unexpected service-role table: ${table}`);
    });
    io.authUpdate.mockImplementation(async () => {
      writes.push("auth-unban");
      return { error: null };
    });
    io.rpc.mockImplementation(async () => {
      writes.push("status-rpc");
      return { data: true, error: null };
    });
    await expect(
      setStatus({
        data: { user_id: "00000000-0000-4000-8000-000000000002", status: "active" },
        context: context(),
      }),
    ).resolves.toEqual({ ok: true });
    expect(io.authUpdate).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000002", {
      ban_duration: "none",
    });
    expect(writes).toEqual(["status-rpc", "auth-unban"]);
  });

  it("does not mutate a user when the Auth ban for soft delete fails", async () => {
    io.role.mockResolvedValueOnce({ data: { role: "admin" }, error: null });
    io.role.mockResolvedValueOnce({ data: null, error: null });
    io.from.mockImplementation((table: string) => {
      if (table === "user_roles")
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: io.role }) }) }) };
      if (table === "profiles")
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { email: "user@example.test" }, error: null }),
            }),
          }),
        };
      throw new Error(`Unexpected service-role table: ${table}`);
    });
    io.authUpdate.mockResolvedValueOnce({ error: { message: "auth unavailable" } });
    await expect(
      softDelete({
        data: { user_id: "00000000-0000-4000-8000-000000000002" },
        context: context(),
      }),
    ).rejects.toThrow("auth unavailable");
    expect(io.from).not.toHaveBeenCalledWith("operators");
    expect(io.audit).not.toHaveBeenCalled();
  });

  it.each([
    [{ message: "archive failed" }, true, "archive failed"],
    [null, false, "soft_delete_not_confirmed"],
  ])("does not report success when the archive RPC fails", async (rpcError, confirmed, message) => {
    io.role.mockResolvedValueOnce({ data: { role: "admin" }, error: null });
    io.role.mockResolvedValueOnce({ data: null, error: null });
    io.from.mockImplementation((table: string) => {
      if (table === "user_roles")
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: io.role }) }) }) };
      if (table === "profiles")
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { user_id: "target" }, error: null }),
            }),
          }),
        };
      throw new Error(`Unexpected independent DB write: ${table}`);
    });
    io.rpc.mockResolvedValueOnce({ data: confirmed, error: rpcError });
    await expect(
      softDelete({
        data: { user_id: "00000000-0000-4000-8000-000000000002" },
        context: context(),
      }),
    ).rejects.toThrow(message);
    expect(io.authUpdate).toHaveBeenCalledOnce();
    expect(io.rpc).toHaveBeenCalledOnce();
    expect(io.audit).not.toHaveBeenCalled();
  });

  it("rejects deletion of another admin before any mutation", async () => {
    await expect(
      softDelete({
        data: { user_id: "00000000-0000-4000-8000-000000000002" },
        context: context(),
      }),
    ).rejects.toThrow("admin");
    expect(io.authUpdate).not.toHaveBeenCalled();
    expect(io.from).not.toHaveBeenCalledWith("profiles");
    expect(io.audit).not.toHaveBeenCalled();
  });

  it.each([setStatus, update])(
    "rejects generic status changes for another admin before mutation",
    async (action) => {
      await expect(
        action({
          data: { user_id: "00000000-0000-4000-8000-000000000002", status: "blocked" },
          context: context(),
        }),
      ).rejects.toThrow("admin");
      expect(io.authUpdate).not.toHaveBeenCalled();
      expect(io.from).not.toHaveBeenCalledWith("profiles");
      expect(io.audit).not.toHaveBeenCalled();
    },
  );

  it.each([setStatus, update])(
    "never reactivates an archived account through a generic user action",
    async (action) => {
      io.role.mockResolvedValueOnce({ data: { role: "admin" }, error: null });
      io.role.mockResolvedValueOnce({ data: null, error: null });
      io.from.mockImplementation((table: string) => {
        if (table === "user_roles")
          return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: io.role }) }) }) };
        if (table === "profiles")
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { deleted_at: "2026-11-26T00:00:00Z", pii_archived_at: null },
                  error: null,
                }),
              }),
            }),
          };
        throw new Error(`Unexpected service-role table: ${table}`);
      });
      await expect(
        action({
          data: { user_id: "00000000-0000-4000-8000-000000000002", status: "active" },
          context: context(),
        }),
      ).rejects.toThrow("archived");
      expect(io.authUpdate).not.toHaveBeenCalled();
      expect(io.audit).not.toHaveBeenCalled();
    },
  );

  it.each([setStatus, update])(
    "never reactivates an account with a confirmed deletion request",
    async (action) => {
      io.role.mockResolvedValueOnce({ data: { role: "admin" }, error: null });
      io.role.mockResolvedValueOnce({ data: null, error: null });
      const cancelledFilter = vi.fn(() => ({
        limit: () => ({ maybeSingle: async () => ({ data: { id: "request-a" }, error: null }) }),
      }));
      const confirmedFilter = vi.fn(() => ({ is: cancelledFilter }));
      io.from.mockImplementation((table: string) => {
        if (table === "user_roles")
          return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: io.role }) }) }) };
        if (table === "profiles")
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { deleted_at: null, pii_archived_at: null },
                  error: null,
                }),
              }),
            }),
            update: () => ({ eq: async () => ({ error: null }) }),
          };
        if (table === "account_deletion_requests")
          return {
            select: () => ({
              eq: () => ({
                not: confirmedFilter,
              }),
            }),
          };
        throw new Error(`Unexpected service-role table: ${table}`);
      });
      await expect(
        action({
          data: { user_id: "00000000-0000-4000-8000-000000000002", status: "active" },
          context: context(),
        }),
      ).rejects.toThrow("deletion");
      expect(confirmedFilter).toHaveBeenCalledWith("confirmed_at", "is", null);
      expect(cancelledFilter).toHaveBeenCalledWith("cancelled_at", null);
      expect(io.authUpdate).not.toHaveBeenCalled();
      expect(io.audit).not.toHaveBeenCalled();
    },
  );
});
