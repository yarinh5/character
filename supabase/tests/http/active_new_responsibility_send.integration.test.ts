import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertSafeBusinessError,
  assertNoFixtureEvents,
  createAnonymousClient,
  createServiceClient,
  createSyntheticUser,
  deleteAuthUser,
  deleteByEq,
  deleteFixtureEventsForOwnership,
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
  claimConversation: "00000000-0000-4000-8000-000000070203",
  ownedWorkItem: "00000000-0000-4000-8000-000000070301",
  releasedWorkItem: "00000000-0000-4000-8000-000000070302",
  claimWorkItem: "00000000-0000-4000-8000-000000070303",
  ownedClientMessage: "00000000-0000-4000-8000-000000070401",
  releasedClientMessage: "00000000-0000-4000-8000-000000070402",
  claimClientMessage: "00000000-0000-4000-8000-000000070403",
  ownerOperator: "00000000-0000-4000-8000-000000070501",
  otherOperator: "00000000-0000-4000-8000-000000070502",
  adminOperator: "00000000-0000-4000-8000-000000070503",
  unassignedOperator: "00000000-0000-4000-8000-000000070504",
};

const prefix = "v4-3-e1-responsibility";
const eventSentinelId = "00000000-0000-4000-8000-000000079999";
const emails = {
  ownedClient: `${prefix}-owned-client@example.invalid`,
  releasedClient: `${prefix}-released-client@example.invalid`,
  claimClient: `${prefix}-claim-client@example.invalid`,
  owner: `${prefix}-owner@example.invalid`,
  other: `${prefix}-other@example.invalid`,
  adminWorker: `${prefix}-admin-worker@example.invalid`,
  unassigned: `${prefix}-unassigned@example.invalid`,
};

const suite = describe.skipIf(!localHttpReady);

suite("V4-3-E1 HTTP active NEW responsibility", () => {
  let service: HttpClient;
  const users: Array<{ id: string; email: string }> = [];
  const profileIds: string[] = [];
  let owner: HttpClient;
  let other: HttpClient;
  let adminWorker: HttpClient;
  let unassigned: HttpClient;
  let anonymous: HttpClient;
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

  async function activeCycleId(conversationId: string) {
    const { data, error } = await service
      .from("conversation_handling_cycles")
      .select("id")
      .eq("conversation_id", conversationId)
      .is("ended_at", null)
      .single();
    if (error || !data?.id) throw new Error("local fixture active cycle is unavailable");
    return data.id;
  }

  async function sideEffectCounts() {
    const conversationIds = [
      ids.ownedConversation,
      ids.releasedConversation,
      ids.claimConversation,
    ];
    const { data: messages, error: messageError } = await service
      .from("messages")
      .select("id")
      .in("conversation_id", conversationIds);
    if (messageError) throw messageError;
    const messageIds = messages.map((message) => message.id);
    const operatorIds = [
      ids.ownerOperator,
      ids.otherOperator,
      ids.adminOperator,
      ids.unassignedOperator,
    ];
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
    await insertRow(service, "analytics_events", {
      id: eventSentinelId,
      event_name: "fixture_cleanup_sentinel",
      metadata: { sentinel: true },
    });
    const [
      ownedClient,
      releasedClient,
      claimClient,
      ownerUser,
      otherUser,
      adminUser,
      unassignedUser,
    ] = await Promise.all([
      createSyntheticUser(service, emails.ownedClient, trackUser(emails.ownedClient)),
      createSyntheticUser(service, emails.releasedClient, trackUser(emails.releasedClient)),
      createSyntheticUser(service, emails.claimClient, trackUser(emails.claimClient)),
      createSyntheticUser(service, emails.owner, trackUser(emails.owner)),
      createSyntheticUser(service, emails.other, trackUser(emails.other)),
      createSyntheticUser(service, emails.adminWorker, trackUser(emails.adminWorker)),
      createSyntheticUser(service, emails.unassigned, trackUser(emails.unassigned)),
    ]);
    await Promise.all([
      setRole(service, ownerUser.user.id, "operator"),
      setRole(service, otherUser.user.id, "operator"),
      setRole(service, adminUser.user.id, "operator"),
      setRole(service, adminUser.user.id, "admin"),
      setRole(service, unassignedUser.user.id, "operator"),
    ]);
    const { data: fixtureProfiles, error: fixtureProfilesError } = await service
      .from("profiles")
      .select("id")
      .in(
        "user_id",
        users.map((user) => user.id),
      );
    if (fixtureProfilesError) throw fixtureProfilesError;
    profileIds.push(...fixtureProfiles.map((profile) => profile.id));
    await Promise.all([
      seedOperator(service, ids.ownerOperator, ownerUser.user.id, "V4-3-E1 owner"),
      seedOperator(service, ids.otherOperator, otherUser.user.id, "V4-3-E1 other"),
      seedOperator(service, ids.adminOperator, adminUser.user.id, "V4-3-E1 admin worker"),
      seedOperator(service, ids.unassignedOperator, unassignedUser.user.id, "V4-3-E1 unassigned"),
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
    await seedConversation(service, ids.claimConversation, claimClient.user.id, ids.character);
    await seedClientMessage(
      service,
      ids.claimClientMessage,
      ids.claimConversation,
      claimClient.user.id,
      "v4_3_e1_claim_client_message",
    );
    await seedNewWorkItem(
      service,
      ids.claimWorkItem,
      ids.claimConversation,
      claimClient.user.id,
      ids.character,
      ids.claimClientMessage,
    );
    [owner, other, adminWorker, unassigned] = await Promise.all([
      signInSyntheticUser(emails.owner, ownerUser.password),
      signInSyntheticUser(emails.other, otherUser.password),
      signInSyntheticUser(emails.adminWorker, adminUser.password),
      signInSyntheticUser(emails.unassigned, unassignedUser.password),
    ]);
    anonymous = createAnonymousClient();
  });

  afterAll(async () => {
    if (!service) return;
    const conversationIds = [
      ids.ownedConversation,
      ids.releasedConversation,
      ids.claimConversation,
    ];
    const ownedEventTokens = [
      ...Object.values(ids),
      ...users.map((user) => user.id),
      ...profileIds,
      ...successfulMessageIds,
    ];
    await runCleanupSteps([
      {
        label: "fixture events before parent cleanup",
        run: async () => {
          await deleteFixtureEventsForOwnership(service, ownedEventTokens);
        },
      },
      ...successfulMessageIds.map((messageId) => ({
        label: `credit transactions ${messageId}`,
        run: async () => deleteByEq(service, "credit_transactions", "message_id", messageId),
      })),
      ...[ids.ownerOperator, ids.otherOperator, ids.adminOperator, ids.unassignedOperator].flatMap(
        (operatorId) => [
          {
            label: `operator score events ${operatorId}`,
            run: async () =>
              deleteByEq(service, "operator_score_events", "operator_id", operatorId),
          },
          {
            label: `operator monthly scores ${operatorId}`,
            run: async () =>
              deleteByEq(service, "operator_monthly_scores", "operator_id", operatorId),
          },
        ],
      ),
      ...users.map((user) => ({
        label: `notifications for fixture user ${user.id}`,
        run: async () => deleteByEq(service, "notifications", "user_id", user.id),
      })),
      ...profileIds.map((profileId) => ({
        label: `analytics for fixture profile ${profileId}`,
        run: async () => {
          const { error } = await service
            .from("analytics_events")
            .delete()
            .contains("metadata", { profile_id: profileId });
          if (error) throw error;
        },
      })),
      ...conversationIds.flatMap((conversationId) => [
        {
          label: `audit logs ${conversationId}`,
          run: async () => deleteByEq(service, "audit_logs", "entity_id", conversationId),
        },
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
          label: `messages ${conversationId}`,
          run: async () => deleteByEq(service, "messages", "conversation_id", conversationId),
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
      ...[ids.ownerOperator, ids.otherOperator, ids.adminOperator, ids.unassignedOperator].map(
        (operatorId) => ({
          label: `operator ${operatorId}`,
          run: async () => deleteByEq(service, "operators", "id", operatorId),
        }),
      ),
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
      {
        label: "fixture events created during cleanup",
        run: async () => {
          await deleteFixtureEventsForOwnership(service, ownedEventTokens);
        },
      },
      {
        label: "fixture event residue verification",
        run: async () => assertNoFixtureEvents(service, ownedEventTokens),
      },
      {
        label: "non-owned event sentinel preservation",
        run: async () => {
          const { count, error } = await service
            .from("analytics_events")
            .select("id", { count: "exact", head: true })
            .eq("id", eventSentinelId);
          if (error || count !== 1) throw new Error("non-owned event sentinel was not preserved");
        },
      },
      {
        label: "separate non-owned event sentinel cleanup",
        run: async () => deleteByEq(service, "analytics_events", "id", eventSentinelId),
      },
    ]);
  });

  it("allows only the RLS-authorized status update and denies direct shadow mutation", async () => {
    const baseline = await service
      .from("conversations")
      .select("status, needs_handling, pending_since, handling_next_sequence")
      .eq("id", ids.ownedConversation)
      .single();
    expect(baseline.error).toBeNull();
    const baselineShadow = {
      needs_handling: baseline.data.needs_handling,
      pending_since: baseline.data.pending_since,
      handling_next_sequence: baseline.data.handling_next_sequence,
    };

    const assignedStatus = await owner
      .from("conversations")
      .update({ status: "waiting" })
      .eq("id", ids.ownedConversation)
      .select("status");
    expect(assignedStatus.error).toBeNull();
    expect(assignedStatus.data).toEqual([{ status: "waiting" }]);

    const assignedRestore = await owner
      .from("conversations")
      .update({ status: "open" })
      .eq("id", ids.ownedConversation)
      .select("status");
    expect(assignedRestore.error).toBeNull();
    expect(assignedRestore.data).toEqual([{ status: "open" }]);

    const unassignedStatus = await unassigned
      .from("conversations")
      .update({ status: "waiting" })
      .eq("id", ids.ownedConversation)
      .select("status");
    if (unassignedStatus.error) {
      expect(unassignedStatus.error.code).toMatch(/^(42501|PGRST\d+)$/);
    } else {
      expect(unassignedStatus.data).toEqual([]);
    }

    for (const payload of [
      { needs_handling: false },
      { pending_since: null },
      { handling_next_sequence: 999 },
    ]) {
      const denied = await owner
        .from("conversations")
        .update(payload)
        .eq("id", ids.ownedConversation)
        .select("id");
      expect(denied.error?.code).toBe("42501");
    }

    const anonymousStatus = await anonymous
      .from("conversations")
      .update({ status: "waiting" })
      .eq("id", ids.ownedConversation)
      .select("status");
    expect(anonymousStatus.error?.code).toBe("42501");

    const after = await service
      .from("conversations")
      .select("status, needs_handling, pending_since, handling_next_sequence")
      .eq("id", ids.ownedConversation)
      .single();
    expect(after.error).toBeNull();
    expect(after.data).toEqual({ status: "open", ...baselineShadow });
  });

  it("preserves the Admin status RPC", async () => {
    const waiting = await adminWorker.rpc("admin_set_conversation_status", {
      _conversation_id: ids.claimConversation,
      _status: "waiting",
    });
    expect(waiting.error).toBeNull();
    expect(waiting.data).toMatchObject({ status: "waiting" });

    const restored = await adminWorker.rpc("admin_set_conversation_status", {
      _conversation_id: ids.claimConversation,
      _status: "open",
    });
    expect(restored.error).toBeNull();
    expect(restored.data).toMatchObject({ status: "open" });
  });

  it("rejects another assigned Operator and an Admin Worker without side effects", async () => {
    const expectedCycleId = await activeCycleId(ids.ownedConversation);
    const beforeOther = await sideEffectCounts();
    const missingToken = await other.rpc("send_operator_message", {
      _conversation_id: ids.ownedConversation,
      _content: "v4_3_e1_other_missing_token",
      _expected_cycle_id: null,
    });
    assertSafeBusinessError(missingToken.error, "handling_cycle_token_invalid");
    expect(await sideEffectCounts()).toEqual(beforeOther);

    const otherResult = await other.rpc("send_operator_message", {
      _conversation_id: ids.ownedConversation,
      _content: "v4_3_e1_other_blocked",
      _expected_cycle_id: expectedCycleId,
    });
    assertSafeBusinessError(otherResult.error, "conversation_not_responsible_operator");
    expect(await sideEffectCounts()).toEqual(beforeOther);

    const beforeAdmin = await sideEffectCounts();
    const adminResult = await adminWorker.rpc("send_operator_message", {
      _conversation_id: ids.ownedConversation,
      _content: "v4_3_e1_admin_blocked",
      _expected_cycle_id: expectedCycleId,
    });
    assertSafeBusinessError(adminResult.error, "admin_takeover_required");
    expect(await sideEffectCounts()).toEqual(beforeAdmin);
  });

  it("allows the active-cycle owner to send", async () => {
    const result = await owner.rpc("send_operator_message", {
      _conversation_id: ids.ownedConversation,
      _content: "v4_3_e1_owner_allowed",
      _expected_cycle_id: await activeCycleId(ids.ownedConversation),
    });
    expect(result.error).toBeNull();
    const messageId = String((result.data as { message: { id: string } }).message.id);
    successfulMessageIds.push(messageId);
    expect(messageId).toMatch(/^[0-9a-f-]{36}$/i);

    const shadowResult = await service.from("messages").select("*").eq("id", messageId).single();
    expect(shadowResult.error).toBeNull();
    const shadow = shadowResult.data as unknown as {
      handling_cycle_id: string | null;
      handling_effect: string | null;
      handling_sequence: number | null;
    };
    expect(shadow.handling_effect).toBe("staff_response");
    expect(shadow.handling_cycle_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(shadow.handling_sequence).toBeGreaterThan(0);
    expect(await activeCycleId(ids.ownedConversation)).toBe(shadow.handling_cycle_id);

    const staleToken = await owner.rpc("send_operator_message", {
      _conversation_id: ids.ownedConversation,
      _content: "v4_3_e1_owner_stale_token",
      _expected_cycle_id: "00000000-0000-4000-8000-000000070799",
    });
    assertSafeBusinessError(staleToken.error, "handling_cycle_token_invalid");

    const secondOwnerResult = await owner.rpc("send_operator_message", {
      _conversation_id: ids.ownedConversation,
      _content: "v4_3_e1_owner_second_allowed",
      _expected_cycle_id: shadow.handling_cycle_id,
    });
    expect(secondOwnerResult.error).toBeNull();
    successfulMessageIds.push(
      String((secondOwnerResult.data as { message: { id: string } }).message.id),
    );
  });

  it("returns the active cycle token only to its responsible Operator", async () => {
    const expectedCycleId = await activeCycleId(ids.ownedConversation);
    const [ownerResponsibility, otherResponsibility] = await Promise.all([
      owner.rpc("get_operator_conversation_responsibility", {
        _conversation_id: ids.ownedConversation,
      }),
      other.rpc("get_operator_conversation_responsibility", {
        _conversation_id: ids.ownedConversation,
      }),
    ]);
    expect(ownerResponsibility.error).toBeNull();
    expect(ownerResponsibility.data).toEqual([{ state: "mine", cycle_id: expectedCycleId }]);
    expect(otherResponsibility.error).toBeNull();
    expect(otherResponsibility.data).toEqual([{ state: "other", cycle_id: null }]);
  });

  it("returns the authoritative cycle token and replays the same claim", async () => {
    const first = await owner.rpc("claim_new_conversation", {
      _work_item_id: ids.claimWorkItem,
    });
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ claimed: true, already_claimed: false });
    const firstCycleId = String((first.data as { cycle_id: string }).cycle_id);
    expect(firstCycleId).toMatch(/^[0-9a-f-]{36}$/i);

    const retry = await owner.rpc("claim_new_conversation", {
      _work_item_id: ids.claimWorkItem,
    });
    expect(retry.error).toBeNull();
    expect(retry.data).toMatchObject({
      claimed: true,
      already_claimed: true,
      cycle_id: firstCycleId,
    });

    const cycle = await service
      .from("conversation_handling_cycles")
      .select("id, conversation_id, work_item_id, operator_id, ended_at")
      .eq("conversation_id", ids.claimConversation)
      .is("ended_at", null);
    expect(cycle.error).toBeNull();
    expect(cycle.data).toEqual([
      {
        id: firstCycleId,
        conversation_id: ids.claimConversation,
        work_item_id: ids.claimWorkItem,
        operator_id: ids.ownerOperator,
        ended_at: null,
      },
    ]);
  });

  it("allows an assigned Operator to send after the owner explicitly releases responsibility", async () => {
    const releasedCycleId = await activeCycleId(ids.releasedConversation);
    const released = await owner.rpc("release_operator_conversation", {
      _conversation_id: ids.releasedConversation,
      _reason: "released",
    });
    expect(released.error).toBeNull();
    expect(released.data).toMatchObject({ released: true });

    const staleResult = await other.rpc("send_operator_message", {
      _conversation_id: ids.releasedConversation,
      _content: "v4_3_e1_post_release_stale_token",
      _expected_cycle_id: releasedCycleId,
    });
    assertSafeBusinessError(staleResult.error, "handling_cycle_token_invalid");

    const result = await other.rpc("send_operator_message", {
      _conversation_id: ids.releasedConversation,
      _content: "v4_3_e1_post_release_allowed",
      _expected_cycle_id: null,
    });
    expect(result.error).toBeNull();
    const messageId = String((result.data as { message: { id: string } }).message.id);
    successfulMessageIds.push(messageId);
    expect(messageId).toMatch(/^[0-9a-f-]{36}$/i);

    const shadowResult = await service.from("messages").select("*").eq("id", messageId).single();
    expect(shadowResult.error).toBeNull();
    const shadow = shadowResult.data as unknown as {
      handling_cycle_id: string | null;
      handling_effect: string | null;
      handling_sequence: number | null;
    };
    expect(shadow).toMatchObject({
      handling_effect: "staff_response",
    });
    expect(shadow.handling_cycle_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await activeCycleId(ids.releasedConversation)).toBe(shadow.handling_cycle_id);
    expect(shadow.handling_sequence).toBeGreaterThan(0);
  });
});
