import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertSafeBusinessError,
  createServiceClient,
  createSyntheticUser,
  deleteAuthUser,
  deleteByEq,
  insertRow,
  localHttpReady,
  readLocalPrivateStickerAttemptCount,
  runCleanupSteps,
  seedCharacter,
  seedClientMessage,
  seedConversation,
  seedNewWorkItem,
  seedOperator,
  setRole,
  signInSyntheticUser,
  type HttpClient,
} from "./v4_3_http_fixtures";

const ids = {
  character: "00000000-0000-4000-8000-000000070101",
  ownedConversation: "00000000-0000-4000-8000-000000070201",
  releasedConversation: "00000000-0000-4000-8000-000000070202",
  ownedWorkItem: "00000000-0000-4000-8000-000000070301",
  releasedWorkItem: "00000000-0000-4000-8000-000000070302",
  ownedClientMessage: "00000000-0000-4000-8000-000000070401",
  releasedClientMessage: "00000000-0000-4000-8000-000000070402",
  ownerOperator: "00000000-0000-4000-8000-000000070501",
  otherOperator: "00000000-0000-4000-8000-000000070502",
  adminOperator: "00000000-0000-4000-8000-000000070503",
};

const prefix = "v4-3-e1-responsibility";
const emails = {
  ownedClient: `${prefix}-owned-client@example.invalid`,
  releasedClient: `${prefix}-released-client@example.invalid`,
  owner: `${prefix}-owner@example.invalid`,
  other: `${prefix}-other@example.invalid`,
  adminWorker: `${prefix}-admin-worker@example.invalid`,
};

const suite = describe.skipIf(!localHttpReady);

suite("V4-3-E1 HTTP active NEW responsibility", () => {
  let service: HttpClient;
  const users: Array<{ id: string; email: string }> = [];
  let owner: HttpClient;
  let other: HttpClient;
  let adminWorker: HttpClient;
  const successfulMessageIds: string[] = [];

  const trackUser = (email: string) => (user: { id: string }) => users.push({ id: user.id, email });

  async function seedAssignedCycle(
    conversationId: string,
    workItemId: string,
    clientId: string,
    clientMessageId: string,
  ) {
    await seedConversation(service, conversationId, clientId, ids.character, ids.ownerOperator);
    await seedClientMessage(service, clientMessageId, conversationId, clientId);
    await seedNewWorkItem(
      service,
      workItemId,
      conversationId,
      clientId,
      ids.character,
      clientMessageId,
    );
    const { error: assignmentError } = await service
      .from("conversation_work_items")
      .update({
        status: "assigned",
        responsible_operator_id: ids.ownerOperator,
        assigned_at: new Date().toISOString(),
      })
      .eq("id", workItemId);
    if (assignmentError) throw assignmentError;
    await insertRow(service, "conversation_handling_cycles", {
      conversation_id: conversationId,
      work_item_id: workItemId,
      operator_id: ids.ownerOperator,
    });
  }

  async function sideEffectCounts() {
    const conversationIds = [ids.ownedConversation, ids.releasedConversation];
    const { data: messages, error: messageError } = await service
      .from("messages")
      .select("id")
      .in("conversation_id", conversationIds);
    if (messageError) throw messageError;
    const messageIds = messages.map((message) => message.id);
    const operatorIds = [ids.ownerOperator, ids.otherOperator, ids.adminOperator];
    const fixtureUserIds = users.map((user) => user.id);
    const [attachments, scores, ledger, notifications, analytics, stickerAttempts] =
      await Promise.all([
        service
          .from("message_attachments")
          .select("id", { count: "exact", head: true })
          .in("message_id", messageIds),
        service
          .from("operator_score_events")
          .select("id", { count: "exact", head: true })
          .in("operator_id", operatorIds),
        service
          .from("credit_transactions")
          .select("id", { count: "exact", head: true })
          .in("message_id", messageIds),
        service
          .from("notifications")
          .select("id", { count: "exact", head: true })
          .in("conversation_id", conversationIds),
        service
          .from("analytics_events")
          .select("id", { count: "exact", head: true })
          .in("conversation_id", conversationIds),
        readLocalPrivateStickerAttemptCount(fixtureUserIds),
      ]);
    for (const result of [attachments, scores, ledger, notifications, analytics]) {
      if (result.error) throw result.error;
    }
    return {
      messages: messages.length,
      attachments: attachments.count ?? 0,
      scores: scores.count ?? 0,
      ledger: ledger.count ?? 0,
      notifications: notifications.count ?? 0,
      analytics: analytics.count ?? 0,
      stickerAttempts,
    };
  }

  beforeAll(async () => {
    service = createServiceClient();
    const [ownedClient, releasedClient, ownerUser, otherUser, adminUser] = await Promise.all([
      createSyntheticUser(service, emails.ownedClient, trackUser(emails.ownedClient)),
      createSyntheticUser(service, emails.releasedClient, trackUser(emails.releasedClient)),
      createSyntheticUser(service, emails.owner, trackUser(emails.owner)),
      createSyntheticUser(service, emails.other, trackUser(emails.other)),
      createSyntheticUser(service, emails.adminWorker, trackUser(emails.adminWorker)),
    ]);
    await Promise.all([
      setRole(service, ownerUser.user.id, "operator"),
      setRole(service, otherUser.user.id, "operator"),
      setRole(service, adminUser.user.id, "operator"),
      setRole(service, adminUser.user.id, "admin"),
    ]);
    await Promise.all([
      seedOperator(service, ids.ownerOperator, ownerUser.user.id, "V4-3-E1 owner"),
      seedOperator(service, ids.otherOperator, otherUser.user.id, "V4-3-E1 other"),
      seedOperator(service, ids.adminOperator, adminUser.user.id, "V4-3-E1 admin worker"),
    ]);
    await seedCharacter(service, ids.character, "V4-3-E1 responsibility character");
    await Promise.all(
      [ids.ownerOperator, ids.otherOperator, ids.adminOperator].map((operatorId) =>
        insertRow(service, "character_operator_assignments", {
          character_id: ids.character,
          operator_id: operatorId,
        }),
      ),
    );
    await seedAssignedCycle(
      ids.ownedConversation,
      ids.ownedWorkItem,
      ownedClient.user.id,
      ids.ownedClientMessage,
    );
    await seedAssignedCycle(
      ids.releasedConversation,
      ids.releasedWorkItem,
      releasedClient.user.id,
      ids.releasedClientMessage,
    );
    [owner, other, adminWorker] = await Promise.all([
      signInSyntheticUser(emails.owner, ownerUser.password),
      signInSyntheticUser(emails.other, otherUser.password),
      signInSyntheticUser(emails.adminWorker, adminUser.password),
    ]);
  });

  afterAll(async () => {
    if (!service) return;
    const conversationIds = [ids.ownedConversation, ids.releasedConversation];
    await runCleanupSteps([
      ...successfulMessageIds.map((messageId) => ({
        label: `credit transactions ${messageId}`,
        run: async () => deleteByEq(service, "credit_transactions", "message_id", messageId),
      })),
      ...[ids.ownerOperator, ids.otherOperator, ids.adminOperator].flatMap((operatorId) => [
        {
          label: `operator score events ${operatorId}`,
          run: async () => deleteByEq(service, "operator_score_events", "operator_id", operatorId),
        },
        {
          label: `operator monthly scores ${operatorId}`,
          run: async () =>
            deleteByEq(service, "operator_monthly_scores", "operator_id", operatorId),
        },
      ]),
      ...conversationIds.flatMap((conversationId) => [
        {
          label: `analytics ${conversationId}`,
          run: async () =>
            deleteByEq(service, "analytics_events", "conversation_id", conversationId),
        },
        {
          label: `notifications ${conversationId}`,
          run: async () => deleteByEq(service, "notifications", "conversation_id", conversationId),
        },
        {
          label: `handling cycles ${conversationId}`,
          run: async () =>
            deleteByEq(service, "conversation_handling_cycles", "conversation_id", conversationId),
        },
        {
          label: `work item ${conversationId}`,
          run: async () =>
            deleteByEq(service, "conversation_work_items", "conversation_id", conversationId),
        },
        {
          label: `messages ${conversationId}`,
          run: async () => deleteByEq(service, "messages", "conversation_id", conversationId),
        },
        {
          label: `conversation ${conversationId}`,
          run: async () => deleteByEq(service, "conversations", "id", conversationId),
        },
      ]),
      {
        label: "character assignments",
        run: async () =>
          deleteByEq(service, "character_operator_assignments", "character_id", ids.character),
      },
      {
        label: "character",
        run: async () => deleteByEq(service, "characters", "id", ids.character),
      },
      ...[ids.ownerOperator, ids.otherOperator, ids.adminOperator].map((operatorId) => ({
        label: `operator ${operatorId}`,
        run: async () => deleteByEq(service, "operators", "id", operatorId),
      })),
      ...users.flatMap((user) => [
        {
          label: `user role ${user.id}`,
          run: async () => deleteByEq(service, "user_roles", "user_id", user.id),
        },
        {
          label: `profile ${user.id}`,
          run: async () => deleteByEq(service, "profiles", "user_id", user.id),
        },
        { label: `Auth user ${user.id}`, run: async () => deleteAuthUser(service, user.id) },
      ]),
    ]);
  });

  it("rejects another assigned Operator and an Admin Worker without side effects", async () => {
    const beforeOther = await sideEffectCounts();
    const otherResult = await other.rpc("send_operator_message", {
      _conversation_id: ids.ownedConversation,
      _content: "v4_3_e1_other_blocked",
    });
    assertSafeBusinessError(otherResult.error, "conversation_not_responsible_operator");
    expect(await sideEffectCounts()).toEqual(beforeOther);

    const beforeAdmin = await sideEffectCounts();
    const adminResult = await adminWorker.rpc("send_operator_message", {
      _conversation_id: ids.ownedConversation,
      _content: "v4_3_e1_admin_blocked",
    });
    assertSafeBusinessError(adminResult.error, "conversation_not_responsible_operator");
    expect(await sideEffectCounts()).toEqual(beforeAdmin);
  });

  it("allows the active-cycle owner to send", async () => {
    const result = await owner.rpc("send_operator_message", {
      _conversation_id: ids.ownedConversation,
      _content: "v4_3_e1_owner_allowed",
    });
    expect(result.error).toBeNull();
    const messageId = String((result.data as { message: { id: string } }).message.id);
    successfulMessageIds.push(messageId);
    expect(messageId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("allows an assigned Operator to send after the owner explicitly releases responsibility", async () => {
    const released = await owner.rpc("release_operator_conversation", {
      _conversation_id: ids.releasedConversation,
      _reason: "released",
    });
    expect(released.error).toBeNull();
    expect(released.data).toMatchObject({ released: true });

    const result = await other.rpc("send_operator_message", {
      _conversation_id: ids.releasedConversation,
      _content: "v4_3_e1_post_release_allowed",
    });
    expect(result.error).toBeNull();
    const messageId = String((result.data as { message: { id: string } }).message.id);
    successfulMessageIds.push(messageId);
    expect(messageId).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
