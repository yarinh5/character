import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertNoFixtureEvents,
  assertSafeBusinessError,
  createServiceClient,
  createSyntheticUser,
  deleteAuthUser,
  deleteFixtureEventsForOwnership,
  localHttpReady,
  runCleanupSteps,
  setRole,
  signInSyntheticUser,
  type HttpClient,
} from "./v4_3_http_fixtures";

describe.skipIf(!localHttpReady)("WP11 HTTP admin status and role boundary", () => {
  const users: string[] = [];
  const adminEmail = "wp11-http-status-admin-20261126@example.invalid";
  const operatorEmail = "wp11-http-status-operator-20261126@example.invalid";
  let service: HttpClient;
  let admin: HttpClient;
  let nonAdmin: HttpClient;
  let operatorId: string;

  beforeAll(async () => {
    service = createServiceClient();
    const adminUser = await createSyntheticUser(service, adminEmail, (user) => users.push(user.id));
    const operatorUser = await createSyntheticUser(service, operatorEmail, (user) =>
      users.push(user.id),
    );
    operatorId = operatorUser.user.id;
    await setRole(service, adminUser.user.id, "admin");
    admin = await signInSyntheticUser(adminEmail, adminUser.password);
    nonAdmin = await signInSyntheticUser(operatorEmail, operatorUser.password);
    const role = await admin.rpc("admin_set_user_role", {
      _user_id: operatorId,
      _new_role: "operator",
    });
    expect(role.error).toBeNull();
    expect(role.data).toBe(true);
  });

  afterAll(async () => {
    if (!service) return;
    await runCleanupSteps([
      {
        label: "fixture events before account cleanup",
        run: async () => {
          await deleteFixtureEventsForOwnership(service, users);
        },
      },
      ...users.map((userId) => ({
        label: `Auth user ${userId}`,
        run: async () => deleteAuthUser(service, userId),
      })),
      {
        label: "fixture events after account cleanup",
        run: async () => {
          await deleteFixtureEventsForOwnership(service, users);
          await assertNoFixtureEvents(service, users);
        },
      },
    ]);
  });

  it("requires an admin JWT for a status change", async () => {
    const denied = await nonAdmin.rpc("admin_set_user_status", {
      _user_id: operatorId,
      _status: "blocked",
    });
    assertSafeBusinessError(denied.error, "admin_required");
  });

  it("blocks an operator, audits it, and rejects direct role reactivation", async () => {
    const blocked = await admin.rpc("admin_set_user_status", {
      _user_id: operatorId,
      _status: "blocked",
    });
    expect(blocked.error).toBeNull();
    expect(blocked.data).toBe(true);

    const [profile, operator, audits] = await Promise.all([
      service.from("profiles").select("status").eq("user_id", operatorId).single(),
      service
        .from("operators")
        .select("is_active,availability_status")
        .eq("user_id", operatorId)
        .single(),
      service
        .from("audit_logs")
        .select("actor_user_id,action,entity_id")
        .eq("entity_id", operatorId)
        .eq("action", "user.status_changed"),
    ]);
    expect(profile.error).toBeNull();
    expect(profile.data?.status).toBe("blocked");
    expect(operator.error).toBeNull();
    expect(operator.data).toMatchObject({ is_active: false, availability_status: "offline" });
    expect(audits.error).toBeNull();
    expect(audits.data).toEqual([
      expect.objectContaining({ actor_user_id: users[0], entity_id: operatorId }),
    ]);

    const denied = await admin.rpc("admin_set_user_role", {
      _user_id: operatorId,
      _new_role: "operator",
    });
    assertSafeBusinessError(denied.error, "blocked_privileged_role_forbidden");
  });
});
