import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertSafeBusinessError,
  cleanupPrivateMediaOpenState,
  createAnonymousClient,
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
  seedWallet,
  setRole,
  signInSyntheticUser,
  type HttpClient,
} from "./v4_3_http_fixtures";

const suite = describe.skipIf(!localHttpReady);
const bucket = "character-media";
const folder = "characters/00000000-0000-4000-8000-000000060301";
const objectName = "v4_3_media_fixture.webp";
const objectPath = `${folder}/${objectName}`;
const paidIdempotencyKey = "v4_3_media_paid_open_0000000000000001";

const ids = {
  character: "00000000-0000-4000-8000-000000060301",
  conversation: "00000000-0000-4000-8000-000000060401",
  tag: "00000000-0000-4000-8000-000000060501",
  assignedOperator: "00000000-0000-4000-8000-000000060601",
  otherAssignedOperator: "00000000-0000-4000-8000-000000060602",
  unassignedOperator: "00000000-0000-4000-8000-000000060603",
  permanentAsset: "00000000-0000-4000-8000-000000060701",
  viewOnceAsset: "00000000-0000-4000-8000-000000060702",
  paidAsset: "00000000-0000-4000-8000-000000060703",
  lockedAsset: "00000000-0000-4000-8000-000000060704",
  ownerSendAsset: "00000000-0000-4000-8000-000000060705",
  otherSendAsset: "00000000-0000-4000-8000-000000060706",
  clientMessage: "00000000-0000-4000-8000-000000060750",
  workItem: "00000000-0000-4000-8000-000000060751",
  viewOnceReservation: "00000000-0000-4000-8000-000000060801",
  paidReservation: "00000000-0000-4000-8000-000000060802",
  lockedReservation: "00000000-0000-4000-8000-000000060803",
  permanentMessage: "00000000-0000-4000-8000-000000060901",
  viewOnceMessage: "00000000-0000-4000-8000-000000060902",
  paidMessage: "00000000-0000-4000-8000-000000060903",
  lockedMessage: "00000000-0000-4000-8000-000000060904",
  permanentAttachment: "00000000-0000-4000-8000-000000061001",
  viewOnceAttachment: "00000000-0000-4000-8000-000000061002",
  paidAttachment: "00000000-0000-4000-8000-000000061003",
  lockedAttachment: "00000000-0000-4000-8000-000000061004",
};

const emails = {
  owner: "v4_3_media_owner@example.invalid",
  otherClient: "v4_3_media_other_client@example.invalid",
  assigned: "v4_3_media_assigned_operator@example.invalid",
  otherAssigned: "v4_3_media_other_assigned_operator@example.invalid",
  unassigned: "v4_3_media_unassigned_operator@example.invalid",
  admin: "v4_3_media_admin@example.invalid",
};

type MediaViewPayload = { url: string; expires_at: string };

async function invokeMediaView(client: HttpClient | null, body: Record<string, string>) {
  const apiUrl = process.env.SUPABASE_LOCAL_URL ?? "";
  const anonKey = process.env.SUPABASE_LOCAL_ANON_KEY ?? "";
  const headers: Record<string, string> = { apikey: anonKey, "Content-Type": "application/json" };
  if (client) {
    const { data, error } = await client.auth.getSession();
    if (error || !data.session?.access_token)
      throw new Error("local media actor session unavailable");
    headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  return fetch(`${apiUrl}/functions/v1/media-view-url`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function expectSignedMedia(response: Response, expectedMaxTtlSeconds: number) {
  expect(response.status).toBe(200);
  const payload = (await response.json()) as MediaViewPayload;
  expect(Object.keys(payload).sort()).toEqual(["expires_at", "url"]);
  expect(payload.url).toEqual(expect.any(String));
  expect(payload.expires_at).toEqual(expect.any(String));
  const signedUrl = new URL(payload.url);
  expect(decodeURIComponent(signedUrl.pathname)).toContain(`/object/sign/${bucket}/${objectPath}`);
  expect(signedUrl.searchParams.has("token")).toBe(true);
  const ttlMs = new Date(payload.expires_at).getTime() - Date.now();
  expect(ttlMs).toBeGreaterThan(0);
  expect(ttlMs).toBeLessThanOrEqual(expectedMaxTtlSeconds * 1000 + 1500);
  const serialized = JSON.stringify(payload);
  for (const forbidden of ["source_path", "preview_path", "object_path"]) {
    expect(serialized).not.toContain(forbidden);
  }
  expect(serialized).not.toContain(process.env.SUPABASE_LOCAL_SERVICE_ROLE_KEY ?? "never-present");
  const localObjectUrl = new URL(payload.url);
  const localApiUrl = new URL(process.env.SUPABASE_LOCAL_URL ?? "");
  localObjectUrl.protocol = localApiUrl.protocol;
  localObjectUrl.host = localApiUrl.host;
  const objectResponse = await fetch(localObjectUrl);
  expect(objectResponse.status).toBe(200);
  expect((await objectResponse.arrayBuffer()).byteLength).toBeGreaterThan(0);
  return payload;
}

async function expectUnavailable(response: Response) {
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ code: "media_not_available" });
}

suite("V4-3-D2 local media, Storage and signed URL authorization", () => {
  let service: HttpClient;
  const users: Array<{ id: string; email: string }> = [];
  const tracked = {
    storageObjects: [] as string[],
    assets: [] as string[],
    reservations: [] as string[],
    messages: [] as string[],
    attachments: [] as string[],
  };
  let owner: HttpClient;
  let otherClient: HttpClient;
  let assigned: HttpClient;
  let otherAssigned: HttpClient;
  let unassigned: HttpClient;
  let adminClient: HttpClient;
  let permanentReservationId: string | undefined;
  let paidSessionId: string | undefined;
  let lockedImagesEnabled = true;

  const trackUser = (email: string) => (user: { id: string }) => users.push({ id: user.id, email });
  const userId = (email: string) => users.find((user) => user.email === email)?.id;

  async function mediaSideEffectCounts() {
    const { data: messages, error: messageError } = await service
      .from("messages")
      .select("id")
      .eq("conversation_id", ids.conversation);
    if (messageError) throw messageError;
    const messageIds = messages.map((message) => message.id);
    const [attachments, scores, ledger, notifications, analytics, stickerAttempts] =
      await Promise.all([
        service
          .from("message_attachments")
          .select("id", { count: "exact", head: true })
          .in("message_id", messageIds),
        service
          .from("operator_score_events")
          .select("id", { count: "exact", head: true })
          .in("operator_id", [
            ids.assignedOperator,
            ids.otherAssignedOperator,
            ids.unassignedOperator,
          ]),
        service
          .from("credit_transactions")
          .select("id", { count: "exact", head: true })
          .in(
            "user_id",
            users.map((user) => user.id),
          ),
        service
          .from("notifications")
          .select("id", { count: "exact", head: true })
          .eq("conversation_id", ids.conversation),
        service
          .from("analytics_events")
          .select("id", { count: "exact", head: true })
          .eq("conversation_id", ids.conversation),
        readLocalPrivateStickerAttemptCount(users.map((user) => user.id)),
      ]);
    for (const result of [attachments, scores, ledger, notifications, analytics]) {
      if (result.error) throw result.error;
    }
    return [
      messages.length,
      attachments.count ?? 0,
      scores.count ?? 0,
      ledger.count ?? 0,
      notifications.count ?? 0,
      analytics.count ?? 0,
      stickerAttempts,
    ];
  }

  beforeAll(async () => {
    service = createServiceClient();
    const { data: existingObjects, error: existingObjectError } = await service.storage
      .from(bucket)
      .list(folder, { search: objectName });
    if (existingObjectError) throw existingObjectError;
    if (existingObjects?.some((object) => object.name === objectName)) {
      throw new Error("local media fixture object already exists; refusing to overwrite it");
    }

    const [ownerUser, otherClientUser, assignedUser, otherAssignedUser, unassignedUser, adminUser] =
      await Promise.all([
        createSyntheticUser(service, emails.owner, trackUser(emails.owner)),
        createSyntheticUser(service, emails.otherClient, trackUser(emails.otherClient)),
        createSyntheticUser(service, emails.assigned, trackUser(emails.assigned)),
        createSyntheticUser(service, emails.otherAssigned, trackUser(emails.otherAssigned)),
        createSyntheticUser(service, emails.unassigned, trackUser(emails.unassigned)),
        createSyntheticUser(service, emails.admin, trackUser(emails.admin)),
      ]);
    await Promise.all([
      setRole(service, ownerUser.user.id, "client"),
      setRole(service, otherClientUser.user.id, "client"),
      setRole(service, assignedUser.user.id, "operator"),
      setRole(service, otherAssignedUser.user.id, "operator"),
      setRole(service, unassignedUser.user.id, "operator"),
      setRole(service, adminUser.user.id, "admin"),
    ]);
    await Promise.all([
      seedOperator(service, ids.assignedOperator, assignedUser.user.id, "v4_3_media_assigned"),
      seedOperator(
        service,
        ids.otherAssignedOperator,
        otherAssignedUser.user.id,
        "v4_3_media_other_assigned",
      ),
      seedOperator(
        service,
        ids.unassignedOperator,
        unassignedUser.user.id,
        "v4_3_media_unassigned",
      ),
    ]);
    await seedCharacter(service, ids.character, "v4_3_media_character");
    await Promise.all([
      insertRow(service, "character_operator_assignments", {
        character_id: ids.character,
        operator_id: ids.assignedOperator,
      }),
      insertRow(service, "character_operator_assignments", {
        character_id: ids.character,
        operator_id: ids.otherAssignedOperator,
      }),
    ]);
    await seedConversation(
      service,
      ids.conversation,
      ownerUser.user.id,
      ids.character,
      ids.assignedOperator,
    );
    await seedClientMessage(service, ids.clientMessage, ids.conversation, ownerUser.user.id);
    await seedNewWorkItem(
      service,
      ids.workItem,
      ids.conversation,
      ownerUser.user.id,
      ids.character,
      ids.clientMessage,
    );
    const { error: assignWorkItemError } = await service
      .from("conversation_work_items")
      .update({
        status: "assigned",
        responsible_operator_id: ids.assignedOperator,
        assigned_at: new Date().toISOString(),
      })
      .eq("id", ids.workItem);
    if (assignWorkItemError) throw assignWorkItemError;
    await insertRow(service, "media_tags", {
      id: ids.tag,
      character_id: ids.character,
      name: "v4_3_media_tag",
      sort_order: 1,
    });

    const syntheticWebp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    const upload = await service.storage.from(bucket).upload(objectPath, syntheticWebp, {
      contentType: "image/webp",
      upsert: false,
    });
    if (upload.error) throw upload.error;
    tracked.storageObjects.push(objectPath);

    const baseAsset = {
      character_id: ids.character,
      bucket_id: bucket,
      preview_path: objectPath,
      status: "available",
      ingest_status: "ready",
      content_type: "image/webp",
      byte_size: syntheticWebp.byteLength,
      width: 1,
      height: 1,
      preview_generated_at: new Date().toISOString(),
      media_tag_id: ids.tag,
      created_by_user_id: adminUser.user.id,
    };
    const assetRows = [
      { id: ids.permanentAsset, source_path: `${folder}/v4_3_media_permanent_source.webp` },
      { id: ids.viewOnceAsset, source_path: `${folder}/v4_3_media_view_once_source.webp` },
      {
        id: ids.paidAsset,
        source_path: `${folder}/v4_3_media_paid_source.webp`,
        paid_open_price_credits: 7,
      },
      {
        id: ids.lockedAsset,
        source_path: `${folder}/v4_3_media_locked_source.webp`,
        locked_price_credits: 5,
        locked_teaser_path: objectPath,
        locked_delivery_path: objectPath,
        locked_derivative_status: "ready",
        locked_derivatives_generated_at: new Date().toISOString(),
      },
      { id: ids.ownerSendAsset, source_path: `${folder}/v4_3_media_owner_send_source.webp` },
      { id: ids.otherSendAsset, source_path: `${folder}/v4_3_media_other_send_source.webp` },
    ];
    for (const asset of assetRows) {
      await insertRow(service, "character_media_assets", { ...baseAsset, ...asset });
      tracked.assets.push(asset.id);
    }

    const seedAttachment = async (
      reservationId: string,
      assetId: string,
      messageId: string,
      attachmentId: string,
      viewMode: "view_once" | "paid_open" | "permanent",
      accessMode: "standard" | "locked" = "standard",
      priceCreditsSnapshot: number | null = null,
    ) => {
      await insertRow(service, "character_media_reservations", {
        id: reservationId,
        media_asset_id: assetId,
        conversation_id: ids.conversation,
        operator_id: ids.assignedOperator,
        reserved_by_user_id: assignedUser.user.id,
        previous_asset_status: "available",
        state: "consumed",
        intended_access_mode: accessMode,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        ended_at: new Date().toISOString(),
        ended_by_user_id: assignedUser.user.id,
        ended_reason: "sent",
      });
      tracked.reservations.push(reservationId);
      await insertRow(service, "messages", {
        id: messageId,
        conversation_id: ids.conversation,
        sender_type: "operator",
        sender_id: assignedUser.user.id,
        operator_id: ids.assignedOperator,
        content: "[image]",
      });
      tracked.messages.push(messageId);
      await insertRow(service, "message_attachments", {
        id: attachmentId,
        message_id: messageId,
        media_asset_id: assetId,
        reservation_id: reservationId,
        kind: "image",
        access_mode: accessMode,
        view_mode: viewMode,
        price_credits_snapshot: priceCreditsSnapshot,
      });
      tracked.attachments.push(attachmentId);
    };
    await seedAttachment(
      ids.viewOnceReservation,
      ids.viewOnceAsset,
      ids.viewOnceMessage,
      ids.viewOnceAttachment,
      "view_once",
    );
    await seedAttachment(
      ids.paidReservation,
      ids.paidAsset,
      ids.paidMessage,
      ids.paidAttachment,
      "paid_open",
      "standard",
      7,
    );
    await seedAttachment(
      ids.lockedReservation,
      ids.lockedAsset,
      ids.lockedMessage,
      ids.lockedAttachment,
      "permanent",
      "locked",
      5,
    );
    const { error: restoreConversationError } = await service
      .from("conversations")
      .update({ status: "open" })
      .eq("id", ids.conversation);
    if (restoreConversationError) throw restoreConversationError;
    await insertRow(service, "conversation_handling_cycles", {
      conversation_id: ids.conversation,
      work_item_id: ids.workItem,
      operator_id: ids.assignedOperator,
    });
    await Promise.all([
      seedWallet(service, ownerUser.user.id, 20),
      seedWallet(service, assignedUser.user.id, 0),
    ]);

    const { data: lockedSetting, error: lockedSettingError } = await service
      .from("system_settings")
      .select("value")
      .eq("key", "locked_images_enabled")
      .single();
    if (lockedSettingError) throw lockedSettingError;
    lockedImagesEnabled = lockedSetting.value === true;

    [owner, otherClient, assigned, otherAssigned, unassigned, adminClient] = await Promise.all([
      signInSyntheticUser(emails.owner, ownerUser.password),
      signInSyntheticUser(emails.otherClient, otherClientUser.password),
      signInSyntheticUser(emails.assigned, assignedUser.password),
      signInSyntheticUser(emails.otherAssigned, otherAssignedUser.password),
      signInSyntheticUser(emails.unassigned, unassignedUser.password),
      signInSyntheticUser(emails.admin, adminUser.password),
    ]);
  });

  afterAll(async () => {
    if (!service) return;
    const ownerId = userId(emails.owner);
    const fixtureUserIds = users.map((user) => user.id);
    const assertCleanup = async () => {
      const [assets, reservations, messages, attachments, transactions, profiles, objects] =
        await Promise.all([
          service
            .from("character_media_assets")
            .select("id", { count: "exact", head: true })
            .in(
              "id",
              Object.values(ids).filter((value) =>
                value.startsWith("00000000-0000-4000-8000-0000000607"),
              ),
            ),
          service
            .from("character_media_reservations")
            .select("id", { count: "exact", head: true })
            .eq("conversation_id", ids.conversation),
          service
            .from("messages")
            .select("id", { count: "exact", head: true })
            .eq("conversation_id", ids.conversation),
          service
            .from("message_attachments")
            .select("id", { count: "exact", head: true })
            .in("id", tracked.attachments),
          service
            .from("credit_transactions")
            .select("id", { count: "exact", head: true })
            .eq("message_attachment_id", ids.paidAttachment),
          service
            .from("profiles")
            .select("user_id", { count: "exact", head: true })
            .in("user_id", fixtureUserIds),
          service.storage.from(bucket).list(folder, { search: objectName }),
        ]);
      for (const result of [assets, reservations, messages, attachments, transactions, profiles]) {
        if (result.error || result.count !== 0)
          throw new Error("local media fixture cleanup verification failed");
      }
      if (objects.error || objects.data?.some((object) => object.name === objectName)) {
        throw new Error("local media Storage cleanup verification failed");
      }
    };

    await runCleanupSteps([
      {
        label: "Storage object",
        run: async () => {
          if (tracked.storageObjects.length === 0) return;
          const { error } = await service.storage.from(bucket).remove(tracked.storageObjects);
          if (error) throw error;
        },
      },
      {
        label: "private media open state",
        run: async () =>
          cleanupPrivateMediaOpenState(tracked.attachments, ownerId ? [ownerId] : []),
      },
      {
        label: "credit transactions",
        run: async () =>
          deleteByEq(service, "credit_transactions", "message_attachment_id", ids.paidAttachment),
      },
      {
        label: "media audit logs",
        run: async () => {
          const { error } = await service
            .from("audit_logs")
            .delete()
            .eq("actor_user_id", ownerId ?? "")
            .in("action", [
              "message_attachment.view_once_opened",
              "message_attachment.view_once_completed",
              "message_attachment.paid_opened",
            ]);
          if (error) throw error;
          const { error: reservationAuditError } = await service
            .from("audit_logs")
            .delete()
            .eq("entity_id", ids.permanentAsset);
          if (reservationAuditError) throw reservationAuditError;
        },
      },
      {
        label: "notifications",
        run: async () => deleteByEq(service, "notifications", "conversation_id", ids.conversation),
      },
      {
        label: "handling cycle",
        run: async () =>
          deleteByEq(service, "conversation_handling_cycles", "conversation_id", ids.conversation),
      },
      {
        label: "work item",
        run: async () =>
          deleteByEq(service, "conversation_work_items", "conversation_id", ids.conversation),
      },
      {
        label: "attachments",
        run: async () =>
          deleteByEq(service, "message_attachments", "message_id", ids.permanentMessage),
      },
      ...tracked.attachments
        .filter((id) => id !== ids.permanentAttachment)
        .map((attachmentId) => ({
          label: `attachment ${attachmentId}`,
          run: async () => deleteByEq(service, "message_attachments", "id", attachmentId),
        })),
      {
        label: "messages",
        run: async () => deleteByEq(service, "messages", "conversation_id", ids.conversation),
      },
      {
        label: "reservations",
        run: async () =>
          deleteByEq(service, "character_media_reservations", "conversation_id", ids.conversation),
      },
      {
        label: "assets",
        run: async () =>
          deleteByEq(service, "character_media_assets", "character_id", ids.character),
      },
      { label: "media tag", run: async () => deleteByEq(service, "media_tags", "id", ids.tag) },
      ...fixtureUserIds.map((fixtureUserId) => ({
        label: `wallet ${fixtureUserId}`,
        run: async () => deleteByEq(service, "credit_wallets", "user_id", fixtureUserId),
      })),
      {
        label: "character assignments",
        run: async () =>
          deleteByEq(service, "character_operator_assignments", "character_id", ids.character),
      },
      {
        label: "conversation",
        run: async () => deleteByEq(service, "conversations", "id", ids.conversation),
      },
      {
        label: "character",
        run: async () => deleteByEq(service, "characters", "id", ids.character),
      },
      ...[ids.assignedOperator, ids.otherAssignedOperator, ids.unassignedOperator].map(
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
      { label: "fixture cleanup verification", run: assertCleanup },
    ]);
  });

  it("blocks unauthenticated, Client and non-Operator catalog and Storage access", async () => {
    const noJwt = await invokeMediaView(null, {
      kind: "message_attachment",
      attachment_id: ids.viewOnceAttachment,
    });
    expect(noJwt.status).toBe(401);

    const anonymous = createAnonymousClient();
    for (const actor of [anonymous, owner, otherClient]) {
      const directObject = await actor.storage.from(bucket).download(objectPath);
      expect(directObject.data).toBeNull();
      expect(directObject.error).not.toBeNull();
    }

    const [clientCatalog, clientReservation, adminCatalog] = await Promise.all([
      owner.rpc("get_operator_media_catalog", { _conversation_id: ids.conversation }),
      owner.rpc("reserve_character_media_asset", {
        _conversation_id: ids.conversation,
        _asset_id: ids.permanentAsset,
      }),
      adminClient.rpc("get_operator_media_catalog", { _conversation_id: ids.conversation }),
    ]);
    assertSafeBusinessError(clientCatalog.error, "operator_record_required");
    assertSafeBusinessError(clientReservation.error, "operator_record_required");
    assertSafeBusinessError(adminCatalog.error, "operator_record_required");
  });

  it("allows only assigned Operators to catalog and reserve media", async () => {
    const catalog = await assigned.rpc("get_operator_media_catalog", {
      _conversation_id: ids.conversation,
    });
    expect(catalog.error).toBeNull();
    expect(catalog.data).toHaveLength(6);
    const permanent = catalog.data?.find((asset) => asset.id === ids.permanentAsset);
    expect(permanent).toMatchObject({ is_reservable: true, is_reserved_by_me: false });
    for (const row of catalog.data ?? []) {
      expect(row).not.toHaveProperty("source_path");
      expect(row).not.toHaveProperty("preview_path");
      expect(row).not.toHaveProperty("object_path");
    }

    const deniedCatalog = await unassigned.rpc("get_operator_media_catalog", {
      _conversation_id: ids.conversation,
    });
    assertSafeBusinessError(deniedCatalog.error, "operator_not_assigned_to_character");

    const reservation = await assigned.rpc("reserve_character_media_asset", {
      _conversation_id: ids.conversation,
      _asset_id: ids.permanentAsset,
    });
    expect(reservation.error).toBeNull();
    permanentReservationId = String(
      (reservation.data as { reservation_id: string }).reservation_id,
    );
    tracked.reservations.push(permanentReservationId);

    const otherReservation = await otherAssigned.rpc("reserve_character_media_asset", {
      _conversation_id: ids.conversation,
      _asset_id: ids.otherSendAsset,
    });
    expect(otherReservation.error).toBeNull();
    const otherReservationId = String(
      (otherReservation.data as { reservation_id: string }).reservation_id,
    );
    tracked.reservations.push(otherReservationId);

    const sideEffectsBeforeDeniedSends = await mediaSideEffectCounts();
    const [otherOperatorSend, unassignedSend] = await Promise.all([
      otherAssigned.rpc("send_operator_media_message", {
        _reservation_id: otherReservationId,
        _caption: "v4_3_media_other_operator_attempt",
        _view_mode: "permanent",
      }),
      unassigned.rpc("send_operator_media_message", {
        _reservation_id: permanentReservationId,
        _caption: "v4_3_media_unassigned_attempt",
        _view_mode: "permanent",
      }),
    ]);
    assertSafeBusinessError(otherOperatorSend.error, "conversation_not_responsible_operator");
    assertSafeBusinessError(unassignedSend.error, "operator_not_assigned_to_character");
    expect(await mediaSideEffectCounts()).toEqual(sideEffectsBeforeDeniedSends);

    const ownerReservation = await assigned.rpc("reserve_character_media_asset", {
      _conversation_id: ids.conversation,
      _asset_id: ids.ownerSendAsset,
    });
    expect(ownerReservation.error).toBeNull();
    const ownerReservationId = String(
      (ownerReservation.data as { reservation_id: string }).reservation_id,
    );
    tracked.reservations.push(ownerReservationId);
    const ownerSend = await assigned.rpc("send_operator_media_message", {
      _reservation_id: ownerReservationId,
      _caption: "v4_3_media_cycle_owner_allowed",
      _view_mode: "permanent",
    });
    expect(ownerSend.error).toBeNull();
    const ownerSendResult = ownerSend.data as {
      already_sent: boolean;
      attachment: { id: string; message_id: string };
      message: { id: string };
    };
    expect(ownerSendResult).toMatchObject({ already_sent: false });
    expect(ownerSendResult.attachment.message_id).toBe(ownerSendResult.message.id);
    tracked.messages.push(ownerSendResult.message.id);
    tracked.attachments.push(ownerSendResult.attachment.id);

    await insertRow(service, "messages", {
      id: ids.permanentMessage,
      conversation_id: ids.conversation,
      sender_type: "operator",
      sender_id: userId(emails.assigned),
      operator_id: ids.assignedOperator,
      content: "[image]",
    });
    tracked.messages.push(ids.permanentMessage);
    await insertRow(service, "message_attachments", {
      id: ids.permanentAttachment,
      message_id: ids.permanentMessage,
      media_asset_id: ids.permanentAsset,
      reservation_id: permanentReservationId,
      kind: "image",
      access_mode: "standard",
      view_mode: "permanent",
    });
    tracked.attachments.push(ids.permanentAttachment);
  });

  it("returns attachment state only to the owner and assigned Operators", async () => {
    const attachmentIds = tracked.attachments;
    const [ownerAccess, otherAccess, assignedAccess, unassignedAccess] = await Promise.all([
      owner.rpc("get_message_attachment_access", { _attachment_ids: attachmentIds }),
      otherClient.rpc("get_message_attachment_access", { _attachment_ids: attachmentIds }),
      assigned.rpc("get_message_attachment_access", { _attachment_ids: attachmentIds }),
      unassigned.rpc("get_message_attachment_access", { _attachment_ids: attachmentIds }),
    ]);
    expect(ownerAccess.error).toBeNull();
    expect(ownerAccess.data).toHaveLength(5);
    expect(ownerAccess.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attachment_id: ids.permanentAttachment,
          render_state: "standard",
        }),
        expect.objectContaining({
          attachment_id: ids.viewOnceAttachment,
          render_state: "view_once_available",
        }),
        expect.objectContaining({
          attachment_id: ids.paidAttachment,
          render_state: "paid_open_available",
        }),
        expect.objectContaining({ attachment_id: ids.lockedAttachment, render_state: "disabled" }),
      ]),
    );
    expect(otherAccess.error).toBeNull();
    expect(otherAccess.data).toEqual([]);
    expect(assignedAccess.error).toBeNull();
    expect(assignedAccess.data).toHaveLength(5);
    expect(unassignedAccess.error).toBeNull();
    expect(unassignedAccess.data).toEqual([]);
    for (const row of [...(ownerAccess.data ?? []), ...(assignedAccess.data ?? [])]) {
      expect(row).not.toHaveProperty("source_path");
      expect(row).not.toHaveProperty("preview_path");
      expect(row).not.toHaveProperty("object_path");
    }
  });

  it("issues short signed URLs only to authorized permanent-media actors", async () => {
    const body = { kind: "message_attachment", attachment_id: ids.permanentAttachment };
    await expectSignedMedia(await invokeMediaView(owner, body), 60);
    await expectSignedMedia(await invokeMediaView(owner, body), 60);
    await expectSignedMedia(await invokeMediaView(assigned, body), 60);
    await expectUnavailable(await invokeMediaView(otherClient, body));
    await expectUnavailable(await invokeMediaView(unassigned, body));
    await expectSignedMedia(
      await invokeMediaView(adminClient, {
        kind: "admin_asset_preview",
        asset_id: ids.permanentAsset,
      }),
      60,
    );
  });

  it("enforces the View Once open and completion window", async () => {
    const body = { kind: "message_attachment", attachment_id: ids.viewOnceAttachment };
    await expectSignedMedia(await invokeMediaView(assigned, body), 60);
    await expectUnavailable(await invokeMediaView(owner, body));

    const opened = await owner.rpc("open_free_view_once_attachment", {
      _attachment_id: ids.viewOnceAttachment,
      _idempotency_key: "00000000-0000-4000-8000-000000061101",
    });
    expect(opened.error).toBeNull();
    expect(opened.data).toMatchObject({
      attachment_id: ids.viewOnceAttachment,
      render_state: "view_once_opened",
    });
    await expectSignedMedia(await invokeMediaView(owner, body), 7);

    const completed = await owner.rpc("complete_free_view_once_attachment", {
      _attachment_id: ids.viewOnceAttachment,
    });
    expect(completed.error).toBeNull();
    expect(completed.data).toMatchObject({
      attachment_id: ids.viewOnceAttachment,
      completed: true,
    });
    await expectUnavailable(await invokeMediaView(owner, body));
  });

  it("opens Paid media once and keeps locked legacy media disabled", async () => {
    expect(lockedImagesEnabled).toBe(false);
    const paidBody = { kind: "message_attachment", attachment_id: ids.paidAttachment };
    await expectUnavailable(await invokeMediaView(owner, paidBody));

    const opened = await owner.rpc("open_paid_message_attachment", {
      _attachment_id: ids.paidAttachment,
      _idempotency_key: paidIdempotencyKey,
    });
    expect(opened.error).toBeNull();
    const paidResult = opened.data as {
      session_id: string;
      expires_at: string;
      balance: number;
      already_opened: boolean;
    };
    expect(paidResult).toMatchObject({ already_opened: false, balance: 13 });
    paidSessionId = paidResult.session_id;
    await expectSignedMedia(await invokeMediaView(owner, paidBody), 7);

    const completed = await owner.rpc("complete_paid_message_attachment_session", {
      _session_id: paidSessionId,
    });
    expect(completed.error).toBeNull();
    expect(completed.data).toMatchObject({ session_id: paidSessionId, completed: true });
    await expectUnavailable(await invokeMediaView(owner, paidBody));

    const { data: transactions, error: transactionError } = await service
      .from("credit_transactions")
      .select("user_id,amount,type,message_attachment_id")
      .eq("message_attachment_id", ids.paidAttachment)
      .order("amount", { ascending: true });
    expect(transactionError).toBeNull();
    expect(transactions).toEqual([
      {
        user_id: userId(emails.owner),
        amount: -7,
        type: "paid_image_open_spend",
        message_attachment_id: ids.paidAttachment,
      },
      {
        user_id: userId(emails.assigned),
        amount: 7,
        type: "paid_image_open_payout",
        message_attachment_id: ids.paidAttachment,
      },
    ]);

    await expectUnavailable(
      await invokeMediaView(owner, {
        kind: "message_attachment",
        attachment_id: ids.lockedAttachment,
      }),
    );
  });
});
