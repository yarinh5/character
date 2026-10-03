import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertSafeBusinessError,
  createAnonymousClient,
  createServiceClient,
  createSyntheticUser,
  deleteAuthUser,
  localHttpReady,
  runCleanupSteps,
  setRole,
  signInSyntheticUser,
  type HttpClient,
} from "./v4_3_http_fixtures";

const suite = describe.skipIf(!localHttpReady);
const emails = {
  nonAdmin: "v4-3-c-snapshot-nonadmin@example.invalid",
  admin: "v4-3-c-snapshot-admin@example.invalid",
};

suite("V4-3-C HTTP Admin snapshot authorization", () => {
  let admin: HttpClient;
  const users: string[] = [];
  let nonAdminClient: ReturnType<typeof createAnonymousClient>;
  let adminClient: ReturnType<typeof createAnonymousClient>;

  beforeAll(async () => {
    admin = createServiceClient();
    const nonAdmin = await createSyntheticUser(admin, emails.nonAdmin, (user) =>
      users.push(user.id),
    );
    const adminUser = await createSyntheticUser(admin, emails.admin, (user) => users.push(user.id));
    await setRole(admin, adminUser.user.id, "admin");
    nonAdminClient = await signInSyntheticUser(emails.nonAdmin, nonAdmin.password);
    adminClient = await signInSyntheticUser(emails.admin, adminUser.password);
  });

  afterAll(async () => {
    if (!admin) return;
    await runCleanupSteps(
      users.flatMap((userId) => [
        {
          label: `user role ${userId}`,
          run: async () => {
            const { error } = await admin.from("user_roles").delete().eq("user_id", userId);
            if (error) throw error;
          },
        },
        {
          label: `profile ${userId}`,
          run: async () => {
            const { error } = await admin.from("profiles").delete().eq("user_id", userId);
            if (error) throw error;
          },
        },
        {
          label: `Auth user ${userId}`,
          run: async () => deleteAuthUser(admin, userId),
        },
      ]),
    );
  });

  it("does not expose sensitive wallet rows to an anonymous HTTP client", async () => {
    const anon = createAnonymousClient();
    const result = await anon.from("credit_wallets").select("user_id").limit(1);
    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
  });

  it("rejects a non-admin and returns one aggregate row to an admin", async () => {
    const denied = await nonAdminClient.rpc("get_admin_operations_snapshot");
    assertSafeBusinessError(denied.error, "admin_required");

    const allowed = await adminClient.rpc("get_admin_operations_snapshot");
    expect(allowed.error).toBeNull();
    expect(allowed.data).toHaveLength(1);
    expect(allowed.data?.[0]).toEqual(
      expect.objectContaining({
        generated_at: expect.any(String),
        activity_window_started_at: expect.any(String),
      }),
    );
    const serialized = JSON.stringify(allowed.data?.[0]);
    expect(serialized).not.toMatch(/email|preview|path|url|name|reason|content/i);
  });

  it.skip("anonymous direct invocation of the revoked Admin RPC remains blocked on the local image", () => {
    // The local postgres:17.6.1.106 image previously SIGSEGVed on this path.
  });
});
