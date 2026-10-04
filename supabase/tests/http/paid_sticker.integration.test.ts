import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertSafeBusinessError,
  cleanupPrivateStickerAttempts,
  createServiceClient,
  createSyntheticUser,
  deleteAuthUser,
  deleteByEq,
  insertRow,
  localHttpReady,
  localStickersEnabled,
  seedCharacter,
  seedConversation,
  seedOperator,
  seedStickerFixture,
  seedWallet,
  setRole,
  signInSyntheticUser,
  runCleanupSteps,
} from "./v4_3_http_fixtures";

const suite = describe.skipIf(!localHttpReady || !localStickersEnabled);
const ids = {
  character: "00000000-0000-4000-8000-000000020301",
  conversation: "00000000-0000-4000-8000-000000020401",
  workItem: "00000000-0000-4000-8000-000000020501",
  operator: "00000000-0000-4000-8000-000000020601",
  collection: "00000000-0000-4000-8000-000000020701",
  sticker: "00000000-0000-4000-8000-000000020801",
  idempotency: "00000000-0000-4000-8000-000000020901",
};
const emails = {
  owner: "v4-3-c-sticker-owner@example.invalid",
  other: "v4-3-c-sticker-other@example.invalid",
  operator: "v4-3-c-sticker-operator@example.invalid",
};

suite("V4-3-C HTTP paid sticker authorization and idempotency", () => {
  let admin: ReturnType<typeof createServiceClient>;
  const users: string[] = [];
  let actualMessageId: string | undefined;
  let ownerClient: Awaited<ReturnType<typeof signInSyntheticUser>>;
  let otherClient: Awaited<ReturnType<typeof signInSyntheticUser>>;

  beforeAll(async () => {
    admin = createServiceClient();
    const owner = await createSyntheticUser(admin, emails.owner, (user) => users.push(user.id));
    const other = await createSyntheticUser(admin, emails.other, (user) => users.push(user.id));
    const operator = await createSyntheticUser(admin, emails.operator, (user) =>
      users.push(user.id),
    );
    await setRole(admin, operator.user.id, "operator");
    await seedOperator(admin, ids.operator, operator.user.id, "V4-3-C sticker operator");
    await seedCharacter(admin, ids.character, "V4-3-C sticker character");
    await insertRow(admin, "character_operator_assignments", {
      character_id: ids.character,
      operator_id: ids.operator,
    });
    await seedConversation(admin, ids.conversation, owner.user.id, ids.character, ids.operator);
    await insertRow(admin, "conversation_work_items", {
      id: ids.workItem,
      conversation_id: ids.conversation,
      client_id: owner.user.id,
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
    await seedStickerFixture(admin, ids.collection, ids.sticker, ids.character);
    await seedWallet(admin, owner.user.id, 20);
    await seedWallet(admin, operator.user.id, 0);
    ownerClient = await signInSyntheticUser(emails.owner, owner.password);
    otherClient = await signInSyntheticUser(emails.other, other.password);
  });

  afterAll(async () => {
    if (!admin) return;
    const resolveActualMessageId = async () => {
      if (actualMessageId) return;
      const { data, error } = await admin
        .from("messages")
        .select("id")
        .eq("conversation_id", ids.conversation)
        .eq("content", "[sticker]")
        .limit(1);
      if (error) throw error;
      actualMessageId = data?.[0]?.id;
    };
    const requireActualMessageId = () => {
      if (!actualMessageId) throw new Error("actual sticker message id was not found");
      return actualMessageId;
    };
    await runCleanupSteps([
      { label: "resolve sticker message id", run: resolveActualMessageId },
      {
        label: "message stickers",
        run: async () =>
          deleteByEq(admin, "message_stickers", "message_id", requireActualMessageId()),
      },
      {
        label: "private sticker send attempt",
        run: async () => cleanupPrivateStickerAttempts([ids.idempotency]),
      },
      {
        label: "credit transactions by actual message id",
        run: async () =>
          deleteByEq(admin, "credit_transactions", "message_id", requireActualMessageId()),
      },
      {
        label: "notifications",
        run: async () => deleteByEq(admin, "notifications", "conversation_id", ids.conversation),
      },
      {
        label: "messages",
        run: async () => deleteByEq(admin, "messages", "conversation_id", ids.conversation),
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
        label: "sticker",
        run: async () => deleteByEq(admin, "stickers", "id", ids.sticker),
      },
      {
        label: "sticker collection",
        run: async () => deleteByEq(admin, "sticker_collections", "id", ids.collection),
      },
      {
        label: "character assignments",
        run: async () =>
          deleteByEq(admin, "character_operator_assignments", "character_id", ids.character),
      },
      {
        label: "character",
        run: async () => deleteByEq(admin, "characters", "id", ids.character),
      },
      {
        label: "operator",
        run: async () => deleteByEq(admin, "operators", "id", ids.operator),
      },
      ...users.map((userId) => ({
        label: `wallet ${userId}`,
        run: async () => deleteByEq(admin, "credit_wallets", "user_id", userId),
      })),
      ...users.flatMap((userId) => [
        {
          label: `user role ${userId}`,
          run: async () => deleteByEq(admin, "user_roles", "user_id", userId),
        },
        {
          label: `profile ${userId}`,
          run: async () => deleteByEq(admin, "profiles", "user_id", userId),
        },
        {
          label: `Auth user ${userId}`,
          run: async () => deleteAuthUser(admin, userId),
        },
      ]),
    ]);
  });

  it("rejects another Client before any sticker send side effect", async () => {
    const denied = await otherClient.rpc("send_client_sticker_message", {
      _conversation_id: ids.conversation,
      _sticker_id: ids.sticker,
      _idempotency_key: ids.idempotency,
    });
    assertSafeBusinessError(denied.error, "conversation_access_denied");
  });

  it("creates one paid send and returns the same message on retry", async () => {
    const first = await ownerClient.rpc("send_client_sticker_message", {
      _conversation_id: ids.conversation,
      _sticker_id: ids.sticker,
      _idempotency_key: ids.idempotency,
    });
    expect(first.error).toBeNull();
    const retry = await ownerClient.rpc("send_client_sticker_message", {
      _conversation_id: ids.conversation,
      _sticker_id: ids.sticker,
      _idempotency_key: ids.idempotency,
    });
    expect(retry.error).toBeNull();

    const firstResponse = first.data as {
      already_sent: boolean;
      balance: number;
      message: { id: string };
    };
    const retryResponse = retry.data as {
      already_sent: boolean;
      balance: number;
      message: { id: string };
    };
    expect(firstResponse.already_sent).toBe(false);
    expect(retryResponse.already_sent).toBe(true);
    expect(firstResponse.message.id).toBeTruthy();
    expect(retryResponse.message.id).toBe(firstResponse.message.id);
    expect(retryResponse.balance).toBe(firstResponse.balance);
    actualMessageId = firstResponse.message.id;

    const { data: messages, error: messagesError } = await admin
      .from("messages")
      .select("id,conversation_id,sender_id,content")
      .eq("conversation_id", ids.conversation);
    expect(messagesError).toBeNull();
    expect(messages).toHaveLength(1);
    expect(messages?.[0]).toMatchObject({
      id: firstResponse.message.id,
      conversation_id: ids.conversation,
      content: "[sticker]",
    });

    const { data: stickerRows, error: stickerError } = await admin
      .from("message_stickers")
      .select(
        "message_id,charged_transaction_id,payout_transaction_id,payer_client_id,payout_operator_id",
      )
      .eq("message_id", firstResponse.message.id);
    expect(stickerError).toBeNull();
    expect(stickerRows).toHaveLength(1);
    const stickerRow = stickerRows?.[0];

    const { data: transactions, error: transactionError } = await admin
      .from("credit_transactions")
      .select("id,message_id,user_id,type,amount")
      .eq("message_id", firstResponse.message.id)
      .order("amount", { ascending: true });
    expect(transactionError).toBeNull();
    expect(transactions).toHaveLength(2);
    expect(transactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: stickerRow?.charged_transaction_id,
          message_id: firstResponse.message.id,
          user_id: users[0],
          type: "sticker_spend",
          amount: -7,
        }),
        expect.objectContaining({
          id: stickerRow?.payout_transaction_id,
          message_id: firstResponse.message.id,
          user_id: users[2],
          type: "sticker_payout",
          amount: 7,
        }),
      ]),
    );

    const { data: wallets, error: walletError } = await admin
      .from("credit_wallets")
      .select("user_id,balance")
      .in("user_id", [users[0], users[2]]);
    expect(walletError).toBeNull();
    expect(wallets).toEqual(
      expect.arrayContaining([
        { user_id: users[0], balance: 13 },
        { user_id: users[2], balance: 7 },
      ]),
    );
  });
});
