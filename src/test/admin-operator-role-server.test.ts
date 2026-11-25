import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  createUser: vi.fn(),
  audit: vi.fn(),
  operatorInsert: vi.fn(),
  operatorUpdate: vi.fn(),
  clientProfileRead: vi.fn(),
  roleDelete: vi.fn(),
  roleInsert: vi.fn(),
  targetRoles: vi.fn(),
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
  supabaseAdmin: { from: io.from, auth: { admin: { createUser: io.createUser } } },
}));
vi.mock("@/lib/audit.server", () => ({ logAudit: io.audit }));

import {
  adminConvertOperatorToClient,
  adminCreateOperatorUser,
  adminPromoteClientToOperator,
} from "@/lib/admin-operators.functions";

const adminId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const operatorId = "00000000-0000-4000-8000-000000000003";
const context = { userId: adminId, supabase: { rpc: io.rpc } };
const create = adminCreateOperatorUser as unknown as (input: unknown) => Promise<unknown>;
const promote = adminPromoteClientToOperator as unknown as (input: unknown) => Promise<unknown>;
const convert = adminConvertOperatorToClient as unknown as (input: unknown) => Promise<unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  io.rpc.mockResolvedValue({ data: true, error: null });
  io.createUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
  io.operatorInsert.mockReturnValue({
    select: () => ({ single: async () => ({ data: { id: operatorId }, error: null }) }),
  });
  io.operatorUpdate.mockReturnValue({
    eq: () => ({
      data: null,
      error: null,
      select: () => ({ single: async () => ({ data: { id: operatorId }, error: null }) }),
    }),
  });
  io.clientProfileRead.mockReturnValue({
    eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
  });
  io.roleDelete.mockReturnValue({ eq: () => ({ error: null }) });
  io.roleInsert.mockResolvedValue({ error: null });
  io.targetRoles.mockReturnValue([{ role: "client" }]);
  io.from.mockImplementation((table: string) => {
    if (table === "user_roles")
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { role: "admin" }, error: null }) }),
            data: io.targetRoles(),
            error: null,
          }),
        }),
        delete: io.roleDelete,
        insert: io.roleInsert,
      };
    if (table === "profiles")
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { user_id: userId }, error: null }) }),
        }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    if (table === "operators")
      return {
        select: (fields: string) => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: fields.includes("user_id")
                ? { id: operatorId, user_id: userId }
                : { id: operatorId },
              error: null,
            }),
          }),
        }),
        insert: io.operatorInsert,
        update: io.operatorUpdate,
      };
    if (table === "character_operator_assignments")
      return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
    if (table === "client_profiles")
      return { select: io.clientProfileRead, insert: vi.fn().mockResolvedValue({ error: null }) };
    throw new Error(`Unexpected table: ${table}`);
  });
});

describe("operator role transitions", () => {
  it("creates an operator through the authenticated transaction without a duplicate insert", async () => {
    await expect(
      create({
        data: {
          email: "operator@example.test",
          password: "password123",
          full_name: "Operator",
        },
        context,
      }),
    ).resolves.toEqual({ user_id: userId, operator_id: operatorId });
    expect(io.rpc).toHaveBeenCalledWith("admin_set_user_role", {
      _user_id: userId,
      _new_role: "operator",
    });
    expect(io.operatorInsert).not.toHaveBeenCalled();
    expect(io.roleDelete).not.toHaveBeenCalled();
  });

  it("promotes a client through the authenticated transaction", async () => {
    await expect(
      promote({ data: { email: "client@example.test", full_name: "Operator" }, context }),
    ).resolves.toEqual({ user_id: userId, operator_id: operatorId });
    expect(io.rpc).toHaveBeenCalledWith("admin_set_user_role", {
      _user_id: userId,
      _new_role: "operator",
    });
    expect(io.roleDelete).not.toHaveBeenCalled();
  });

  it("does not promote another admin through the client-only action", async () => {
    io.targetRoles.mockReturnValue([{ role: "admin" }]);
    await expect(
      promote({ data: { email: "admin@example.test", full_name: "Admin" }, context }),
    ).rejects.toThrow("client");
    expect(io.rpc).not.toHaveBeenCalled();
  });

  it("does not promote a target with conflicting role rows", async () => {
    io.targetRoles.mockReturnValue([{ role: "client" }, { role: "admin" }]);
    await expect(
      promote({ data: { email: "admin@example.test", full_name: "Admin" }, context }),
    ).rejects.toThrow("client_role_required");
    expect(io.rpc).not.toHaveBeenCalled();
  });

  it("converts an operator through the authenticated transaction", async () => {
    await expect(convert({ data: { operator_id: operatorId }, context })).resolves.toEqual({
      ok: true,
    });
    expect(io.rpc).toHaveBeenCalledWith("admin_set_user_role", {
      _user_id: userId,
      _new_role: "client",
    });
    expect(io.roleDelete).not.toHaveBeenCalled();
    expect(io.operatorUpdate).not.toHaveBeenCalled();
    expect(io.clientProfileRead).not.toHaveBeenCalled();
  });

  it("stops after a rejected role transaction", async () => {
    io.rpc.mockResolvedValue({ data: null, error: { message: "role rejected" } });
    await expect(convert({ data: { operator_id: operatorId }, context })).rejects.toThrow(
      "role rejected",
    );
    expect(io.audit).not.toHaveBeenCalled();
  });

  it("does not treat an unconfirmed role transaction as success", async () => {
    io.rpc.mockResolvedValue({ data: false, error: null });
    await expect(convert({ data: { operator_id: operatorId }, context })).rejects.toThrow(
      "role_change_not_confirmed",
    );
    expect(io.audit).not.toHaveBeenCalled();
  });
});
