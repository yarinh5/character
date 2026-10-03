import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertSafeBusinessError,
  createServiceClient,
  createSyntheticUser,
  deleteAuthUser,
  deleteByEq,
  insertRow,
  localHttpReady,
  seedCharacter,
  seedClientMessage,
  seedConversation,
  seedNewWorkItem,
  seedOperator,
  setRole,
  signInSyntheticUser,
  runCleanupSteps,
  type HttpClient,
} from "./v4_3_http_fixtures";

const ids = {
  character: "00000000-0000-4000-8000-000000010301",
  conversation: "00000000-0000-4000-8000-000000010401",
  workItem: "00000000-0000-4000-8000-000000010501",
  message: "00000000-0000-4000-8000-000000010601",
  assignedOperator: "00000000-0000-4000-8000-000000010701",
  unassignedOperator: "00000000-0000-4000-8000-000000010702",
  blockedOperator: "00000000-0000-4000-8000-000000010703",
  competingOperator: "00000000-0000-4000-8000-000000010704",
};

const prefix = "v4-3-c-new";
const emails = {
  owner: `${prefix}-owner@example.invalid`,
  other: `${prefix}-other@example.invalid`,
  assigned: `${prefix}-assigned@example.invalid`,
  unassigned: `${prefix}-unassigned@example.invalid`,
  blocked: `${prefix}-blocked@example.invalid`,
  competing: `${prefix}-competing@example.invalid`,
};

const suite = describe.skipIf(!localHttpReady);

suite("V4-3-C HTTP NEW authorization", () => {
  let admin: HttpClient;
  const users: Array<{ id: string; email: string }> = [];
  let ownerClient: HttpClient;
  let otherClient: HttpClient;
  let assigned: HttpClient;
  let unassigned: HttpClient;
  let blocked: HttpClient;
  let competing: HttpClient;

  beforeAll(async () => {
    admin = createServiceClient();
    const owner = await createSyntheticUser(admin, emails.owner, (user) =>
      users.push({ id: user.id, email: emails.owner }),
    );
    const other = await createSyntheticUser(admin, emails.other, (user) =>
      users.push({ id: user.id, email: emails.other }),
    );
    const assignedUser = await createSyntheticUser(admin, emails.assigned, (user) =>
      users.push({ id: user.id, email: emails.assigned }),
    );
    const unassignedUser = await createSyntheticUser(admin, emails.unassigned, (user) =>
      users.push({ id: user.id, email: emails.unassigned }),
    );
    const blockedUser = await createSyntheticUser(admin, emails.blocked, (user) =>
      users.push({ id: user.id, email: emails.blocked }),
    );
    const competingUser = await createSyntheticUser(admin, emails.competing, (user) =>
      users.push({ id: user.id, email: emails.competing }),
    );
    await Promise.all([
      setRole(admin, assignedUser.user.id, "operator"),
      setRole(admin, unassignedUser.user.id, "operator"),
      setRole(admin, blockedUser.user.id, "operator"),
      setRole(admin, competingUser.user.id, "operator"),
    ]);
    await Promise.all([
      seedOperator(admin, ids.assignedOperator, assignedUser.user.id, "V4-3-C assigned"),
      seedOperator(admin, ids.unassignedOperator, unassignedUser.user.id, "V4-3-C unassigned"),
      seedOperator(admin, ids.blockedOperator, blockedUser.user.id, "V4-3-C blocked"),
      seedOperator(admin, ids.competingOperator, competingUser.user.id, "V4-3-C competing"),
    ]);
    await seedCharacter(admin, ids.character, "V4-3-C HTTP character");
    await seedConversation(admin, ids.conversation, owner.user.id, ids.character);
    await seedClientMessage(admin, ids.message, ids.conversation, owner.user.id);
    await seedNewWorkItem(
      admin,
      ids.workItem,
      ids.conversation,
      owner.user.id,
      ids.character,
      ids.message,
    );
    await Promise.all([
      insertRow(admin, "character_operator_assignments", {
        character_id: ids.character,
        operator_id: ids.assignedOperator,
      }),
      insertRow(admin, "character_operator_assignments", {
        character_id: ids.character,
        operator_id: ids.blockedOperator,
      }),
      insertRow(admin, "character_operator_assignments", {
        character_id: ids.character,
        operator_id: ids.competingOperator,
      }),
      insertRow(admin, "operator_client_blocks", {
        operator_id: ids.blockedOperator,
        client_id: owner.user.id,
        reason: "V4-3-C synthetic block",
        created_by_operator_id: ids.blockedOperator,
      }),
    ]);
    assigned = await signInSyntheticUser(emails.assigned, assignedUser.password);
    unassigned = await signInSyntheticUser(emails.unassigned, unassignedUser.password);
    blocked = await signInSyntheticUser(emails.blocked, blockedUser.password);
    competing = await signInSyntheticUser(emails.competing, competingUser.password);
    ownerClient = await signInSyntheticUser(emails.owner, owner.password);
    otherClient = await signInSyntheticUser(emails.other, other.password);
  });

  afterAll(async () => {
    if (!admin) return;
    const steps: Array<{ label: string; run: () => Promise<void> }> = [
      {
        label: "notifications",
        run: async () => {
          const { error } = await admin
            .from("notifications")
            .delete()
            .eq("conversation_id", ids.conversation);
          if (error) throw error;
        },
      },
      {
        label: "messages",
        run: async () => {
          const { error } = await admin
            .from("messages")
            .delete()
            .eq("conversation_id", ids.conversation);
          if (error) throw error;
        },
      },
      {
        label: "handling cycles",
        run: async () =>
          deleteByEq(admin, "conversation_handling_cycles", "conversation_id", ids.conversation),
      },
      {
        label: "operator blocks",
        run: async () =>
          deleteByEq(admin, "operator_client_blocks", "client_id", users[0]?.id ?? ""),
      },
      {
        label: "character assignments",
        run: async () =>
          deleteByEq(admin, "character_operator_assignments", "character_id", ids.character),
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
        label: "character",
        run: async () => deleteByEq(admin, "characters", "id", ids.character),
      },
      ...[
        ids.assignedOperator,
        ids.unassignedOperator,
        ids.blockedOperator,
        ids.competingOperator,
      ].map((operatorId) => ({
        label: `operator ${operatorId}`,
        run: async () => deleteByEq(admin, "operators", "id", operatorId),
      })),
      ...users.flatMap((user) => [
        {
          label: `user role ${user.id}`,
          run: async () => deleteByEq(admin, "user_roles", "user_id", user.id),
        },
        {
          label: `profile ${user.id}`,
          run: async () => deleteByEq(admin, "profiles", "user_id", user.id),
        },
        {
          label: `Auth user ${user.id}`,
          run: async () => deleteAuthUser(admin, user.id),
        },
      ]),
    ];
    await runCleanupSteps(steps);
  });

  it("filters NEW queue by assignment and operator block", async () => {
    const assignedResult = await assigned.rpc("get_operator_new_queue");
    expect(assignedResult.error).toBeNull();
    expect(assignedResult.data).toHaveLength(1);
    expect(assignedResult.data?.[0]?.work_item_id).toBe(ids.workItem);

    const unassignedResult = await unassigned.rpc("get_operator_new_queue");
    expect(unassignedResult.error).toBeNull();
    expect(unassignedResult.data).toHaveLength(0);

    const blockedResult = await blocked.rpc("get_operator_new_queue");
    expect(blockedResult.error).toBeNull();
    expect(blockedResult.data).toHaveLength(0);
  });

  it("allows one assigned claim and rejects a competing operator", async () => {
    const claim = await assigned.rpc("claim_new_conversation", { _work_item_id: ids.workItem });
    expect(claim.error).toBeNull();
    expect(claim.data).toMatchObject({ claimed: true, already_claimed: false });

    const competingClaim = await competing.rpc("claim_new_conversation", {
      _work_item_id: ids.workItem,
    });
    assertSafeBusinessError(competingClaim.error, "conversation_already_claimed");

    const { count, error } = await admin
      .from("conversation_handling_cycles")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", ids.conversation)
      .is("ended_at", null);
    expect(error).toBeNull();
    expect(count).toBe(1);
  });

  it("keeps owner conversation and message reads private to the owner", async () => {
    const ownerConversation = await ownerClient
      .from("conversations")
      .select("id")
      .eq("id", ids.conversation);
    expect(ownerConversation.error).toBeNull();
    expect(ownerConversation.data).toHaveLength(1);

    const otherConversation = await otherClient
      .from("conversations")
      .select("id")
      .eq("id", ids.conversation);
    expect(otherConversation.error).toBeNull();
    expect(otherConversation.data).toHaveLength(0);

    const ownerMessages = await ownerClient
      .from("messages")
      .select("id")
      .eq("conversation_id", ids.conversation);
    expect(ownerMessages.error).toBeNull();
    expect(ownerMessages.data).toHaveLength(1);

    const otherMessages = await otherClient
      .from("messages")
      .select("id")
      .eq("conversation_id", ids.conversation);
    expect(otherMessages.error).toBeNull();
    expect(otherMessages.data).toHaveLength(0);
  });
});
