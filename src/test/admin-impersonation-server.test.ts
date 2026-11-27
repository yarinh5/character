import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  from: vi.fn(),
  role: vi.fn(),
  target: vi.fn(),
  generateLink: vi.fn(),
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
  supabaseAdmin: { from: io.from, auth: { admin: { generateLink: io.generateLink } } },
}));
vi.mock("@/lib/audit.server", () => ({ logAudit: io.audit }));

import { adminImpersonate, adminSendPasswordReset } from "@/lib/impersonation.functions";

type Input = { data: { user_id: string }; context: { userId: string } };
const impersonate = adminImpersonate as unknown as (input: Input) => Promise<unknown>;
const reset = adminSendPasswordReset as unknown as (input: Input) => Promise<unknown>;
const targetId = "00000000-0000-4000-8000-000000000002";
const input = () => ({ data: { user_id: targetId }, context: { userId: "admin-a" } });

beforeEach(() => {
  io.role.mockReset().mockResolvedValue({ data: { role: "admin" }, error: null });
  io.target.mockReset().mockResolvedValue({
    data: {
      email: "user@example.test",
      display_name: "User",
      status: "active",
      deleted_at: null,
      pii_archived_at: null,
    },
    error: null,
  });
  io.generateLink.mockReset().mockResolvedValue({
    data: { properties: { action_link: "https://example.test/action" } },
    error: null,
  });
  io.audit.mockReset();
  io.from.mockReset().mockImplementation((table: string) => {
    if (table === "user_roles")
      return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: io.role }) }) }) };
    if (table === "profiles") return { select: () => ({ eq: () => ({ maybeSingle: io.target }) }) };
    throw new Error(`Unexpected table: ${table}`);
  });
});

describe("admin user link generation", () => {
  it.each([
    ["blocked", { status: "blocked", deleted_at: null, pii_archived_at: null }],
    ["archived", { status: "active", deleted_at: "2026-11-26T00:00:00Z", pii_archived_at: null }],
    [
      "PII archived",
      { status: "active", deleted_at: null, pii_archived_at: "2026-11-26T00:00:00Z" },
    ],
  ])("does not create links for a %s user", async (_case, state) => {
    io.target.mockResolvedValue({ data: { email: "user@example.test", ...state }, error: null });
    await expect(impersonate(input())).rejects.toThrow();
    await expect(reset(input())).rejects.toThrow();
    expect(io.generateLink).not.toHaveBeenCalled();
    expect(io.audit).not.toHaveBeenCalled();
  });

  it("does not mask a failed profile lookup as a missing user", async () => {
    io.target.mockResolvedValue({ data: null, error: { message: "db unavailable" } });
    await expect(impersonate(input())).rejects.toThrow("db unavailable");
    await expect(reset(input())).rejects.toThrow("db unavailable");
    expect(io.generateLink).not.toHaveBeenCalled();
  });

  it("preserves authorized active-user links", async () => {
    io.role.mockResolvedValueOnce({ data: { role: "admin" }, error: null });
    io.role.mockResolvedValueOnce({ data: null, error: null });
    await expect(impersonate(input())).resolves.toEqual(
      expect.objectContaining({ email: "user@example.test" }),
    );
    io.role.mockReset().mockResolvedValue({ data: { role: "admin" }, error: null });
    await expect(reset(input())).resolves.toEqual(expect.objectContaining({ ok: true }));
    expect(io.generateLink).toHaveBeenNthCalledWith(1, {
      type: "magiclink",
      email: "user@example.test",
    });
    expect(io.generateLink).toHaveBeenNthCalledWith(2, {
      type: "recovery",
      email: "user@example.test",
    });
  });

  it("does not issue an impersonation link for another admin", async () => {
    await expect(impersonate(input())).rejects.toThrow("admin");
    expect(io.generateLink).not.toHaveBeenCalled();
    expect(io.audit).not.toHaveBeenCalled();
  });

  it("fails closed when the target admin-role lookup fails", async () => {
    io.role.mockResolvedValueOnce({ data: { role: "admin" }, error: null });
    io.role.mockResolvedValueOnce({ data: null, error: { message: "role lookup failed" } });
    await expect(impersonate(input())).rejects.toThrow("role lookup failed");
    expect(io.generateLink).not.toHaveBeenCalled();
    expect(io.audit).not.toHaveBeenCalled();
  });
});
