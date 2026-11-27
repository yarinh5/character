import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertNoFixtureEvents,
  assertSafeBusinessError,
  createServiceClient,
  createSyntheticUser,
  deleteAuthUser,
  deleteByEq,
  deleteFixtureEventsForOwnership,
  insertRow,
  localHttpReady,
  runCleanupSteps,
  seedCharacter,
  seedClientMessage,
  seedConversation,
  seedWallet,
  setRole,
  signInSyntheticUser,
  type HttpClient,
} from "./v4_3_http_fixtures";

const suite = describe.skipIf(!localHttpReady);
const ids = {
  character: randomUUID(),
  conversation: randomUUID(),
  message: randomUUID(),
  transaction: randomUUID(),
  idempotencyKey: randomUUID(),
};
const reason = "Synthetic AC34 conversation deletion request";
const messageContent = "Synthetic AC34 private text";
const emailPrefix = `ac34-${ids.conversation}`;

suite("AC34 HTTP conversation deletion request boundary", () => {
  let service: HttpClient;
  let adminSession: HttpClient;
  let clientSession: HttpClient;
  let operatorSession: HttpClient;
  let requestId: string | undefined;
  const users: Array<{ id: string; email: string }> = [];
  const email = (role: string) => `${emailPrefix}-${role}@example.invalid`;
  const track = (address: string) => (user: { id: string }) =>
    users.push({ id: user.id, email: address });
  const userId = (role: string) => users.find((user) => user.email === email(role))?.id;

  beforeAll(async () => {
    service = createServiceClient();
    // This suite exercises only the non-destructive request and disabled claim path.
    const setting = await service
      .from("system_settings")
      .select("value")
      .eq("key", "conversation_deletion_irreversible_enabled")
      .single();
    expect(setting.error).toBeNull();
    expect(setting.data?.value).toBe(false);

    const admin = await createSyntheticUser(service, email("admin"), track(email("admin")));
    const client = await createSyntheticUser(service, email("client"), track(email("client")));
    const operator = await createSyntheticUser(
      service,
      email("operator"),
      track(email("operator")),
    );
    await setRole(service, admin.user.id, "admin");
    await setRole(service, client.user.id, "client");
    await setRole(service, operator.user.id, "operator");
    await seedCharacter(service, ids.character, "Synthetic AC34 shared character");
    await seedConversation(service, ids.conversation, client.user.id, ids.character);
    await seedClientMessage(service, ids.message, ids.conversation, client.user.id, messageContent);
    await seedWallet(service, client.user.id, 19);
    await insertRow(service, "credit_transactions", {
      id: ids.transaction,
      user_id: client.user.id,
      amount: 19,
      balance_after: 19,
      type: "admin_adjustment",
      reason: "Synthetic AC34 ledger sentinel",
    });

    adminSession = await signInSyntheticUser(email("admin"), admin.password);
    clientSession = await signInSyntheticUser(email("client"), client.password);
    operatorSession = await signInSyntheticUser(email("operator"), operator.password);
  });

  afterAll(async () => {
    if (!service) return;
    const ownedTokens = [...Object.values(ids), ...users.map((user) => user.id)];
    await runCleanupSteps([
      {
        label: "fixture events before parent cleanup",
        run: async () => {
          await deleteFixtureEventsForOwnership(service, ownedTokens);
        },
      },
      {
        label: "deletion request",
        run: async () =>
          deleteByEq(
            service,
            "conversation_deletion_requests",
            "conversation_id",
            ids.conversation,
          ),
      },
      {
        label: "transaction",
        run: async () => deleteByEq(service, "credit_transactions", "id", ids.transaction),
      },
      {
        label: "wallet",
        run: async () => {
          const clientId = userId("client");
          if (clientId) await deleteByEq(service, "credit_wallets", "user_id", clientId);
        },
      },
      { label: "message", run: async () => deleteByEq(service, "messages", "id", ids.message) },
      {
        label: "work item",
        run: async () =>
          deleteByEq(service, "conversation_work_items", "conversation_id", ids.conversation),
      },
      {
        label: "conversation",
        run: async () => deleteByEq(service, "conversations", "id", ids.conversation),
      },
      {
        label: "character",
        run: async () => deleteByEq(service, "characters", "id", ids.character),
      },
      ...users.flatMap((user) => [
        {
          label: `role ${user.id}`,
          run: async () => deleteByEq(service, "user_roles", "user_id", user.id),
        },
        {
          label: `profile ${user.id}`,
          run: async () => deleteByEq(service, "profiles", "user_id", user.id),
        },
        { label: `Auth user ${user.id}`, run: async () => deleteAuthUser(service, user.id) },
      ]),
      {
        label: "fixture events after parent cleanup",
        run: async () => {
          await deleteFixtureEventsForOwnership(service, ownedTokens);
        },
      },
      {
        label: "fixture event residue",
        run: async () => assertNoFixtureEvents(service, ownedTokens),
      },
      {
        label: "fixture row residue",
        run: async () => {
          for (const [table, column, value] of [
            ["conversation_deletion_requests", "conversation_id", ids.conversation],
            ["conversations", "id", ids.conversation],
            ["messages", "id", ids.message],
            ["credit_transactions", "id", ids.transaction],
            ["characters", "id", ids.character],
          ]) {
            const result = await service
              .from(table)
              .select(column, { count: "exact", head: true })
              .eq(column, value);
            if (result.error || result.count !== 0)
              throw new Error(`AC34 fixture residue in ${table}`);
          }
        },
      },
    ]);
  });

  it("requires Admin confirmation, blocks access, and keeps retry inert while execution is disabled", async () => {
    const visibleBefore = await clientSession.from("messages").select("id").eq("id", ids.message);
    expect(visibleBefore.error).toBeNull();
    expect(visibleBefore.data).toEqual([{ id: ids.message }]);

    const args = {
      _conversation_id: ids.conversation,
      _reason: reason,
      _idempotency_key: ids.idempotencyKey,
      _confirmed: true,
    };
    const [clientDenied, operatorDenied, unconfirmed] = await Promise.all([
      clientSession.rpc("request_conversation_deletion", args),
      operatorSession.rpc("request_conversation_deletion", args),
      adminSession.rpc("request_conversation_deletion", { ...args, _confirmed: false }),
    ]);
    assertSafeBusinessError(clientDenied.error, "admin_only");
    assertSafeBusinessError(operatorDenied.error, "admin_only");
    assertSafeBusinessError(unconfirmed.error, "explicit_confirmation_required");
    const before = await service
      .from("conversation_deletion_requests")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", ids.conversation);
    expect(before.error).toBeNull();
    expect(before.count).toBe(0);

    const first = await adminSession.rpc("request_conversation_deletion", args);
    expect(first.error).toBeNull();
    expect(first.data).toHaveLength(1);
    requestId = first.data[0].id;
    expect(first.data[0].status).toBe("access_blocked");

    const replay = await adminSession.rpc("request_conversation_deletion", args);
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual(first.data);
    const requestsAfterReplay = await service
      .from("conversation_deletion_requests")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", ids.conversation);
    expect(requestsAfterReplay.error).toBeNull();
    expect(requestsAfterReplay.count).toBe(1);
    const reused = await adminSession.rpc("request_conversation_deletion", {
      ...args,
      _reason: `${reason} changed`,
    });
    assertSafeBusinessError(reused.error, "idempotency_key_reused");
    const reopen = await adminSession.rpc("admin_set_conversation_status", {
      _conversation_id: ids.conversation,
      _status: "open",
    });
    assertSafeBusinessError(reopen.error, "conversation_access_denied");

    const [
      request,
      hiddenConversation,
      hiddenMessage,
      writer,
      wallet,
      ledger,
      character,
      message,
      messageCount,
    ] = await Promise.all([
      service
        .from("conversation_deletion_requests")
        .select(
          "status,access_blocked_at,irreversible_started_at,active_system_completed_at,retention_policy_version",
        )
        .eq("id", requestId)
        .single(),
      clientSession.from("conversations").select("id").eq("id", ids.conversation),
      clientSession.from("messages").select("id").eq("id", ids.message),
      clientSession.rpc("send_client_message", {
        _conversation_id: ids.conversation,
        _content: "must not reappear",
      }),
      service.from("credit_wallets").select("balance").eq("user_id", userId("client")).single(),
      service
        .from("credit_transactions")
        .select("amount,balance_after,type")
        .eq("id", ids.transaction)
        .single(),
      service.from("characters").select("id,name").eq("id", ids.character).single(),
      service.from("messages").select("content").eq("id", ids.message).single(),
      service
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", ids.conversation),
    ]);
    expect(request.error).toBeNull();
    expect(request.data).toMatchObject({
      status: "access_blocked",
      access_blocked_at: expect.any(String),
      irreversible_started_at: null,
      active_system_completed_at: null,
      retention_policy_version: "p04-2026-11-11",
    });
    expect(hiddenConversation.error).toBeNull();
    expect(hiddenConversation.data).toEqual([]);
    expect(hiddenMessage.error).toBeNull();
    expect(hiddenMessage.data).toEqual([]);
    assertSafeBusinessError(writer.error, "conversation_closed");
    expect(wallet.error).toBeNull();
    expect(wallet.data?.balance).toBe(19);
    expect(ledger.error).toBeNull();
    expect(ledger.data).toMatchObject({ amount: 19, balance_after: 19, type: "admin_adjustment" });
    expect(messageCount.error).toBeNull();
    expect(messageCount.count).toBe(1);
    expect(character.error).toBeNull();
    expect(character.data).toMatchObject({
      id: ids.character,
      name: "Synthetic AC34 shared character",
    });
    expect(message.error).toBeNull();
    expect(message.data?.content).toBe(messageContent);

    const disabled = await service.rpc("claim_conversation_deletion_step_for_server", {
      _request_id: requestId,
    });
    expect(disabled.error).toBeNull();
    expect(disabled.data).toEqual([]);
    const final = await service
      .from("conversation_deletion_requests")
      .select("status,irreversible_started_at,active_system_completed_at")
      .eq("id", requestId)
      .single();
    expect(final.error).toBeNull();
    expect(final.data).toMatchObject({
      status: "blocked_retention",
      irreversible_started_at: null,
      active_system_completed_at: null,
    });
  });
});
