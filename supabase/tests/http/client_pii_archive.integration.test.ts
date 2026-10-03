import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertSafeBusinessError,
  createServiceClient,
  createSyntheticUser,
  deleteAuthUser,
  deleteByEq,
  insertRow,
  localHttpReady,
  runCleanupSteps,
  seedCharacter,
  seedConversation,
  seedOperator,
  setRole,
  signInSyntheticUser,
  upsertRow,
  updateProfile,
  type HttpClient,
} from "./v4_3_http_fixtures";

const suite = describe.skipIf(!localHttpReady);
const ids = {
  character: "00000000-0000-4000-8000-000000050301",
  conversation: "00000000-0000-4000-8000-000000050401",
  workItem: "00000000-0000-4000-8000-000000050501",
  operator: "00000000-0000-4000-8000-000000050601",
};
const emails = {
  admin: "v4-3-d1-http-admin@example.invalid",
  client: "v4-3-d1-http-client@example.invalid",
  nonAdminClient: "v4-3-d1-http-non-admin-client@example.invalid",
  operator: "v4-3-d1-http-operator@example.invalid",
};
const archiveReason = "V4-3-D1 archive reason";

type ArchiveResult = { archived: boolean; archived_at: string; idempotent_replay: boolean };

suite("V4-3-D1 HTTP client PII archive authorization", () => {
  let admin: HttpClient;
  const users: Array<{ id: string; email: string }> = [];
  let adminClient: HttpClient;
  let clientSession: HttpClient;
  let nonAdminClient: HttpClient;
  let operatorClient: HttpClient;
  let archivedAt: string | undefined;

  const trackUser = (email: string) => (user: { id: string }) => users.push({ id: user.id, email });
  const userId = (email: string) => users.find((user) => user.email === email)?.id;

  beforeAll(async () => {
    admin = createServiceClient();
    const adminUser = await createSyntheticUser(admin, emails.admin, trackUser(emails.admin));
    const clientUser = await createSyntheticUser(admin, emails.client, trackUser(emails.client));
    const nonAdminUser = await createSyntheticUser(
      admin,
      emails.nonAdminClient,
      trackUser(emails.nonAdminClient),
    );
    const operatorUser = await createSyntheticUser(
      admin,
      emails.operator,
      trackUser(emails.operator),
    );

    await Promise.all([
      setRole(admin, adminUser.user.id, "admin"),
      setRole(admin, clientUser.user.id, "client"),
      setRole(admin, nonAdminUser.user.id, "client"),
      setRole(admin, operatorUser.user.id, "operator"),
    ]);
    await updateProfile(admin, clientUser.user.id, emails.client, "V4-3-D1 HTTP client");
    await seedOperator(admin, ids.operator, operatorUser.user.id, "V4-3-D1 HTTP operator");
    await seedCharacter(admin, ids.character, "V4-3-D1 HTTP character");
    await seedConversation(admin, ids.conversation, clientUser.user.id, ids.character);
    await insertRow(admin, "conversation_work_items", {
      id: ids.workItem,
      conversation_id: ids.conversation,
      client_id: clientUser.user.id,
      character_id: ids.character,
      status: "assigned",
      responsible_operator_id: ids.operator,
      assigned_at: new Date().toISOString(),
    });
    await insertRow(admin, "conversation_handling_cycles", {
      conversation_id: ids.conversation,
      work_item_id: ids.workItem,
      operator_id: ids.operator,
    });
    await upsertRow(
      admin,
      "client_profiles",
      {
        user_id: clientUser.user.id,
        age: 31,
        interests: ["v4-3-d1"],
        first_name: "V4",
        last_name: "Client",
        content_preferences: ["synthetic"],
        character_preferences: ["synthetic"],
        profile_image_url: "https://example.invalid/v4-3-d1-profile.png",
        profile_image_urls: ["https://example.invalid/v4-3-d1-profile.png"],
      },
      "user_id",
    );
    await insertRow(admin, "client_character_preferences", {
      client_id: clientUser.user.id,
      character_id: ids.character,
      is_favorite: true,
    });
    await insertRow(admin, "client_discovery_cycles", {
      client_id: clientUser.user.id,
      filter_hash: "v4-3-d1-http",
      cycle_number: 501,
    });
    await insertRow(admin, "client_conversation_deletions", {
      client_id: clientUser.user.id,
      conversation_id: ids.conversation,
    });
    await insertRow(admin, "conversation_read_states", {
      conversation_id: ids.conversation,
      user_id: clientUser.user.id,
    });
    await insertRow(admin, "user_active_conversations", {
      user_id: clientUser.user.id,
      conversation_id: ids.conversation,
      role: "client",
    });
    await insertRow(admin, "notification_settings", { user_id: clientUser.user.id });
    await insertRow(admin, "notifications", {
      user_id: clientUser.user.id,
      type: "system",
      title: "V4-3-D1 HTTP",
      body: "synthetic",
      conversation_id: ids.conversation,
    });

    adminClient = await signInSyntheticUser(emails.admin, adminUser.password);
    clientSession = await signInSyntheticUser(emails.client, clientUser.password);
    nonAdminClient = await signInSyntheticUser(emails.nonAdminClient, nonAdminUser.password);
    operatorClient = await signInSyntheticUser(emails.operator, operatorUser.password);
  });

  afterAll(async () => {
    if (!admin) return;
    const targetUserId = userId(emails.client);
    const assertFixtureCleanup = async () => {
      const [profiles, conversations, workItems, cycles, audits] = await Promise.all([
        admin
          .from("profiles")
          .select("user_id", { count: "exact", head: true })
          .in(
            "user_id",
            users.map((user) => user.id),
          ),
        admin
          .from("conversations")
          .select("id", { count: "exact", head: true })
          .eq("id", ids.conversation),
        admin
          .from("conversation_work_items")
          .select("id", { count: "exact", head: true })
          .eq("id", ids.workItem),
        admin
          .from("conversation_handling_cycles")
          .select("id", { count: "exact", head: true })
          .eq("conversation_id", ids.conversation),
        admin
          .from("audit_logs")
          .select("id", { count: "exact", head: true })
          .eq("action", "client.pii_archived")
          .eq("entity_id", targetUserId ?? ""),
      ]);
      for (const result of [profiles, conversations, workItems, cycles, audits]) {
        if (result.error || result.count !== 0)
          throw new Error("local PII archive fixture cleanup verification failed");
      }
    };

    await runCleanupSteps([
      {
        label: "archive audit row",
        run: async () => deleteByEq(admin, "audit_logs", "entity_id", targetUserId ?? ""),
      },
      {
        label: "notifications",
        run: async () => deleteByEq(admin, "notifications", "user_id", targetUserId ?? ""),
      },
      {
        label: "notification settings",
        run: async () => deleteByEq(admin, "notification_settings", "user_id", targetUserId ?? ""),
      },
      {
        label: "active conversations",
        run: async () =>
          deleteByEq(admin, "user_active_conversations", "user_id", targetUserId ?? ""),
      },
      {
        label: "conversation read states",
        run: async () =>
          deleteByEq(admin, "conversation_read_states", "user_id", targetUserId ?? ""),
      },
      {
        label: "client conversation deletions",
        run: async () =>
          deleteByEq(admin, "client_conversation_deletions", "client_id", targetUserId ?? ""),
      },
      {
        label: "client discovery cycles",
        run: async () =>
          deleteByEq(admin, "client_discovery_cycles", "client_id", targetUserId ?? ""),
      },
      {
        label: "client character preferences",
        run: async () =>
          deleteByEq(admin, "client_character_preferences", "client_id", targetUserId ?? ""),
      },
      {
        label: "handling cycles",
        run: async () =>
          deleteByEq(admin, "conversation_handling_cycles", "conversation_id", ids.conversation),
      },
      {
        label: "work item",
        run: async () => deleteByEq(admin, "conversation_work_items", "id", ids.workItem),
      },
      {
        label: "conversation",
        run: async () => deleteByEq(admin, "conversations", "id", ids.conversation),
      },
      {
        label: "client profile",
        run: async () => deleteByEq(admin, "client_profiles", "user_id", targetUserId ?? ""),
      },
      { label: "character", run: async () => deleteByEq(admin, "characters", "id", ids.character) },
      { label: "operator", run: async () => deleteByEq(admin, "operators", "id", ids.operator) },
      ...users.flatMap((user) => [
        {
          label: `user role ${user.id}`,
          run: async () => deleteByEq(admin, "user_roles", "user_id", user.id),
        },
        {
          label: `profile ${user.id}`,
          run: async () => deleteByEq(admin, "profiles", "user_id", user.id),
        },
        { label: `Auth user ${user.id}`, run: async () => deleteAuthUser(admin, user.id) },
      ]),
      { label: "fixture cleanup verification", run: assertFixtureCleanup },
    ]);
  });

  it("rejects Client and Operator callers without mutating the target", async () => {
    const targetUserId = userId(emails.client);
    const [clientDenied, operatorDenied] = await Promise.all([
      nonAdminClient.rpc("archive_client_pii", {
        _client_id: targetUserId,
        _reason: archiveReason,
        _confirm: "ARCHIVE_CLIENT_PII",
      }),
      operatorClient.rpc("archive_client_pii", {
        _client_id: targetUserId,
        _reason: archiveReason,
        _confirm: "ARCHIVE_CLIENT_PII",
      }),
    ]);
    assertSafeBusinessError(clientDenied.error, "admin_required");
    assertSafeBusinessError(operatorDenied.error, "admin_required");

    const { data: profile, error } = await admin
      .from("profiles")
      .select("status,pii_archived_at")
      .eq("user_id", targetUserId)
      .single();
    expect(error).toBeNull();
    expect(profile).toMatchObject({ status: "active", pii_archived_at: null });
  });

  it("archives a Client through an Admin JWT and applies the existing contract", async () => {
    const targetUserId = userId(emails.client);
    const archive = await adminClient.rpc("archive_client_pii", {
      _client_id: targetUserId,
      _reason: `  ${archiveReason}  `,
      _confirm: "ARCHIVE_CLIENT_PII",
    });
    expect(archive.error).toBeNull();
    const result = archive.data as ArchiveResult;
    expect(result).toMatchObject({ archived: true, idempotent_replay: false });
    expect(result.archived_at).toEqual(expect.any(String));
    archivedAt = result.archived_at;

    const [
      profileResult,
      clientProfileResult,
      workItemResult,
      cycleResult,
      auditResult,
      authResult,
    ] = await Promise.all([
      admin
        .from("profiles")
        .select(
          "display_name,email,avatar_url,status,deleted_at,pii_archived_at,pii_archived_by,pii_archive_reason",
        )
        .eq("user_id", targetUserId)
        .single(),
      admin
        .from("client_profiles")
        .select(
          "age,interests,first_name,last_name,content_preferences,character_preferences,profile_image_url,profile_image_urls",
        )
        .eq("user_id", targetUserId)
        .single(),
      admin
        .from("conversation_work_items")
        .select("status,responsible_operator_id,assigned_at")
        .eq("id", ids.workItem)
        .single(),
      admin
        .from("conversation_handling_cycles")
        .select("ended_at,end_reason")
        .eq("conversation_id", ids.conversation)
        .single(),
      admin
        .from("audit_logs")
        .select("actor_user_id,action,entity_type,entity_id,metadata")
        .eq("action", "client.pii_archived")
        .eq("entity_id", targetUserId),
      admin.auth.admin.getUserById(targetUserId ?? ""),
    ]);

    expect(profileResult.error).toBeNull();
    expect(profileResult.data).toMatchObject({
      display_name: "\u05dc\u05e7\u05d5\u05d7 \u05d1\u05d0\u05e8\u05db\u05d9\u05d5\u05df",
      email: null,
      avatar_url: null,
      status: "archived",
      pii_archived_by: userId(emails.admin),
      pii_archive_reason: archiveReason,
    });
    expect(profileResult.data?.deleted_at).toEqual(expect.any(String));
    expect(profileResult.data?.pii_archived_at).toEqual(archivedAt);
    expect(clientProfileResult.error).toBeNull();
    expect(clientProfileResult.data).toMatchObject({
      age: null,
      interests: [],
      first_name: null,
      last_name: null,
      content_preferences: [],
      character_preferences: [],
      profile_image_url: null,
      profile_image_urls: [],
    });
    expect(workItemResult.data).toMatchObject({
      status: "closed",
      responsible_operator_id: null,
      assigned_at: null,
    });
    expect(cycleResult.data).toMatchObject({ end_reason: "closed" });
    expect(cycleResult.data?.ended_at).toEqual(expect.any(String));
    expect(auditResult.error).toBeNull();
    expect(auditResult.data).toHaveLength(1);
    expect(auditResult.data?.[0]).toMatchObject({
      actor_user_id: userId(emails.admin),
      action: "client.pii_archived",
      entity_type: "user",
      entity_id: targetUserId,
      metadata: expect.objectContaining({
        reason: archiveReason,
        auth_user_preserved: true,
        pii_redacted: true,
      }),
    });
    expect(authResult.error).toBeNull();
    expect(authResult.data.user?.id).toBe(targetUserId);
  });

  it("keeps retry idempotent and blocks the archived session's profile update", async () => {
    const targetUserId = userId(emails.client);
    const retry = await adminClient.rpc("archive_client_pii", {
      _client_id: targetUserId,
      _reason: archiveReason,
      _confirm: "ARCHIVE_CLIENT_PII",
    });
    expect(retry.error).toBeNull();
    expect(retry.data).toMatchObject({
      archived: true,
      idempotent_replay: true,
      archived_at: archivedAt,
    });

    const profileUpdate = await clientSession
      .from("profiles")
      .update({ display_name: "must not persist" })
      .eq("user_id", targetUserId)
      .select("user_id");
    expect(profileUpdate.error).toBeNull();
    expect(profileUpdate.data).toEqual([]);

    const { data: audits, error } = await admin
      .from("audit_logs")
      .select("id", { count: "exact" })
      .eq("action", "client.pii_archived")
      .eq("entity_id", targetUserId);
    expect(error).toBeNull();
    expect(audits).toHaveLength(1);
  });
});
