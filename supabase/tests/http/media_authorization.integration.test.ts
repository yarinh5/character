import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertSafeBusinessError,
  assertNoFixtureEvents,
  cleanupPrivateMediaOpenState,
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
  seedWallet,
  setRole,
  signInSyntheticUser,
  verifiedLocalFixtureDbContainer,
  type HttpClient,
} from "./v4_3_http_fixtures";
import { createMediaTestEvidenceFromEnvironment, createMediaTestPath } from "./media-test-evidence";

const suite = describe.skipIf(!localHttpReady);
const bucket = "character-media";
const folder = "characters/00000000-0000-4000-8000-000000060301";
const objectName = "v4_3_media_fixture.webp";
const objectPath = `${folder}/${objectName}`;
const giftPurchaseKey = "00000000-0000-4000-8000-000000061101";
const giftOpenKey = "00000000-0000-4000-8000-000000061102";

const ids = {
  character: "00000000-0000-4000-8000-000000060301",
  otherCharacter: "00000000-0000-4000-8000-000000060302",
  conversation: "00000000-0000-4000-8000-000000060401",
  otherClientConversation: "00000000-0000-4000-8000-000000060402",
  crossCharacterConversation: "00000000-0000-4000-8000-000000060403",
  tag: "00000000-0000-4000-8000-000000060501",
  otherTag: "00000000-0000-4000-8000-000000060502",
  giftCollection: "00000000-0000-4000-8000-000000060503",
  giftSticker: "00000000-0000-4000-8000-000000060504",
  assignedOperator: "00000000-0000-4000-8000-000000060601",
  otherAssignedOperator: "00000000-0000-4000-8000-000000060602",
  unassignedOperator: "00000000-0000-4000-8000-000000060603",
  permanentAsset: "00000000-0000-4000-8000-000000060701",
  viewOnceAsset: "00000000-0000-4000-8000-000000060702",
  paidAsset: "00000000-0000-4000-8000-000000060703",
  lockedAsset: "00000000-0000-4000-8000-000000060704",
  ownerSendAsset: "00000000-0000-4000-8000-000000060705",
  otherSendAsset: "00000000-0000-4000-8000-000000060706",
  raceAsset: "00000000-0000-4000-8000-000000060707",
  clientMessage: "00000000-0000-4000-8000-000000060750",
  workItem: "00000000-0000-4000-8000-000000060751",
  otherClientMessage: "00000000-0000-4000-8000-000000060752",
  otherClientWorkItem: "00000000-0000-4000-8000-000000060753",
  crossCharacterMessage: "00000000-0000-4000-8000-000000060754",
  crossCharacterWorkItem: "00000000-0000-4000-8000-000000060755",
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

const { expectSignedMedia, expectUnavailable, invokeMediaView, runPermanentMediaScenario } =
  createMediaTestPath({
    apiUrl: process.env.SUPABASE_LOCAL_URL ?? "",
    anonKey: process.env.SUPABASE_LOCAL_ANON_KEY ?? "",
    serviceRoleKey: process.env.SUPABASE_LOCAL_SERVICE_ROLE_KEY ?? "",
    bucket,
    objectPath,
    fetch: (input, init) => fetch(input, init),
  });

const wp06bUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const wp06bBucket = "user-avatars";

function requireWp06b(valid: unknown, stage: string): asserts valid {
  if (!valid) throw new Error(`WP06B fixture failed: ${stage}`);
}

function wp06bFixtureDb(sql: string, stage: string) {
  // Use the exact DB container and private-fixture psql path checked by run-local.mjs.
  try {
    return execFileSync(
      "docker",
      [
        "exec",
        "-i",
        verifiedLocalFixtureDbContainer(),
        "psql",
        "-X",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      { input: sql, encoding: "utf8", stdio: "pipe", timeout: 15_000, windowsHide: true },
    ).trim();
  } catch {
    throw new Error(`WP06B local DB step refused or failed: ${stage}`);
  }
}

function claimWp06bFixture(ownerId: string, objectPath: string) {
  requireWp06b(
    wp06bUuid.test(ownerId) &&
      /^wp06b-[0-9a-f]{24}\.webp$/.test(objectPath.slice(ownerId.length + 1)) &&
      objectPath.startsWith(`${ownerId}/`),
    "claim identity",
  );
  // Keep the guard and real service-role claim in one transaction. An HTTP
  // preflight followed by a global claim would leave a window for other writers.
  const result = wp06bFixtureDb(
    `
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
LOCK TABLE private.client_profile_image_cleanup_queue IN SHARE ROW EXCLUSIVE MODE NOWAIT;
DO $scope$
DECLARE
  _fixture_id uuid;
BEGIN
  SELECT id INTO STRICT _fixture_id
  FROM private.client_profile_image_cleanup_queue
  WHERE owner_user_id = '${ownerId}'::uuid
    AND bucket_id = '${wp06bBucket}'
    AND object_path = '${objectPath}'
    AND status = 'pending_reference_check'
    AND attempts = 0;
  IF EXISTS (
    SELECT 1 FROM private.client_profile_image_cleanup_queue
    WHERE id <> _fixture_id
      AND status IN ('pending_reference_check', 'failed', 'claimed')
  ) THEN
    RAISE EXCEPTION 'wp06b_competing_queue_work';
  END IF;
  PERFORM set_config('wp06b.fixture_queue_id', _fixture_id::text, true);
END;
$scope$;
SET LOCAL ROLE service_role;
SET LOCAL "request.jwt.claim.role" = 'service_role';
DO $claim$
DECLARE
  _claim record;
BEGIN
  SELECT * INTO STRICT _claim
  FROM public.claim_client_profile_image_cleanup_for_server(1);
  IF _claim.queue_id IS DISTINCT FROM current_setting('wp06b.fixture_queue_id')::uuid
    OR _claim.owner_user_id IS DISTINCT FROM '${ownerId}'::uuid
    OR _claim.bucket_id IS DISTINCT FROM '${wp06bBucket}'
    OR _claim.object_path IS DISTINCT FROM '${objectPath}'
    OR _claim.claim_token IS NULL THEN
    RAISE EXCEPTION 'wp06b_unexpected_claim';
  END IF;
  PERFORM set_config('wp06b.fixture_claim_token', _claim.claim_token::text, true);
END;
$claim$;
SELECT current_setting('wp06b.fixture_queue_id') || '|' ||
       current_setting('wp06b.fixture_claim_token');
COMMIT;
`,
    "atomic claim (requires one fresh exact row, no competing work, and a free queue lock)",
  );
  const [queueId, claimToken, extra] = result.split("|");
  requireWp06b(
    extra === undefined && wp06bUuid.test(queueId) && wp06bUuid.test(claimToken),
    "claim return",
  );
  return { queueId, claimToken };
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
    clientUploads: [] as string[],
  };
  let owner: HttpClient;
  let otherClient: HttpClient;
  let assigned: HttpClient;
  let assignedParallel: HttpClient;
  let otherAssigned: HttpClient;
  let unassigned: HttpClient;
  let adminClient: HttpClient;
  let permanentReservationId: string | undefined;
  let paidSessionId: string | undefined;
  let giftPurchaseId: string | undefined;
  let giftMessageId: string | undefined;
  let otherClientAttachmentId: string | undefined;
  let lockedImagesEnabled = true;

  const trackUser = (email: string) => (user: { id: string }) => users.push({ id: user.id, email });
  const userId = (email: string) => users.find((user) => user.email === email)?.id;

  async function activeCycleId(conversationId = ids.conversation) {
    const { data, error } = await service
      .from("conversation_handling_cycles")
      .select("id")
      .eq("conversation_id", conversationId)
      .is("ended_at", null)
      .single();
    if (error || !data?.id) throw new Error("local media fixture active cycle is unavailable");
    return data.id;
  }

  async function reopenMainConversation() {
    const { error } = await service
      .from("conversations")
      .update({ status: "open" })
      .eq("id", ids.conversation);
    if (error) throw error;
  }

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
    await seedCharacter(service, ids.otherCharacter, "v4_3_media_other_character");
    await Promise.all([
      insertRow(service, "character_operator_assignments", {
        character_id: ids.character,
        operator_id: ids.assignedOperator,
      }),
      insertRow(service, "character_operator_assignments", {
        character_id: ids.character,
        operator_id: ids.otherAssignedOperator,
      }),
      insertRow(service, "character_operator_assignments", {
        character_id: ids.otherCharacter,
        operator_id: ids.assignedOperator,
      }),
    ]);
    await seedConversation(
      service,
      ids.conversation,
      ownerUser.user.id,
      ids.character,
      ids.assignedOperator,
    );
    await seedConversation(
      service,
      ids.otherClientConversation,
      otherClientUser.user.id,
      ids.character,
      ids.assignedOperator,
    );
    await seedConversation(
      service,
      ids.crossCharacterConversation,
      ownerUser.user.id,
      ids.otherCharacter,
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
    await seedClientMessage(
      service,
      ids.otherClientMessage,
      ids.otherClientConversation,
      otherClientUser.user.id,
    );
    await seedNewWorkItem(
      service,
      ids.otherClientWorkItem,
      ids.otherClientConversation,
      otherClientUser.user.id,
      ids.character,
      ids.otherClientMessage,
    );
    await seedClientMessage(
      service,
      ids.crossCharacterMessage,
      ids.crossCharacterConversation,
      ownerUser.user.id,
    );
    await seedNewWorkItem(
      service,
      ids.crossCharacterWorkItem,
      ids.crossCharacterConversation,
      ownerUser.user.id,
      ids.otherCharacter,
      ids.crossCharacterMessage,
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
    const { error: assignAdditionalWorkItemsError } = await service
      .from("conversation_work_items")
      .update({
        status: "assigned",
        responsible_operator_id: ids.assignedOperator,
        assigned_at: new Date().toISOString(),
      })
      .in("id", [ids.otherClientWorkItem, ids.crossCharacterWorkItem]);
    if (assignAdditionalWorkItemsError) throw assignAdditionalWorkItemsError;
    await insertRow(service, "media_tags", {
      id: ids.tag,
      character_id: ids.character,
      name: "v4_3_media_tag",
      sort_order: 1,
    });
    await insertRow(service, "media_tags", {
      id: ids.otherTag,
      character_id: ids.otherCharacter,
      name: "v4_3_media_other_tag",
      sort_order: 1,
    });
    await insertRow(service, "sticker_collections", {
      id: ids.giftCollection,
      slug: "v4-3-media-gifts",
      name: "V4-3 media gifts",
      character_id: ids.character,
      is_active: true,
    });
    await insertRow(service, "stickers", {
      id: ids.giftSticker,
      collection_id: ids.giftCollection,
      slug: "v4-3-media-gift",
      name: "V4-3 media gift",
      object_path: `collections/${ids.giftCollection}/stickers/${ids.giftSticker}/render.webp`,
      width: 1,
      height: 1,
      byte_size: 1,
      is_active: true,
      is_gift: true,
      ingest_status: "ready",
      processed_at: new Date().toISOString(),
      price_credits: 7,
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
      { id: ids.raceAsset, source_path: `${folder}/v4_3_media_race_source.webp` },
    ];
    for (const asset of assetRows) {
      await insertRow(service, "character_media_assets", {
        ...baseAsset,
        ...asset,
        is_global: asset.id === ids.permanentAsset,
      });
      await insertRow(service, "character_media_asset_characters", {
        media_asset_id: asset.id,
        character_id: ids.character,
        created_by_user_id: adminUser.user.id,
      });
      await insertRow(service, "character_media_asset_tags", {
        media_asset_id: asset.id,
        media_tag_id: ids.tag,
        created_by_user_id: adminUser.user.id,
      });
      if (asset.id === ids.permanentAsset) {
        await insertRow(service, "character_media_asset_characters", {
          media_asset_id: asset.id,
          character_id: ids.otherCharacter,
          created_by_user_id: adminUser.user.id,
        });
        await insertRow(service, "character_media_asset_tags", {
          media_asset_id: asset.id,
          media_tag_id: ids.otherTag,
          created_by_user_id: adminUser.user.id,
        });
      }
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
      requiredGiftId: string | null = null,
    ) => {
      await insertRow(service, "character_media_reservations", {
        id: reservationId,
        media_asset_id: assetId,
        conversation_id: ids.conversation,
        client_id: ownerUser.user.id,
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
        required_gift_id: requiredGiftId,
        required_gift_name_snapshot: requiredGiftId ? "V4-3 media gift" : null,
        required_gift_price_credits_snapshot: requiredGiftId ? priceCreditsSnapshot : null,
      });
      tracked.attachments.push(attachmentId);
      await insertRow(service, "character_media_deliveries", {
        media_asset_id: assetId,
        client_id: ownerUser.user.id,
        conversation_id: ids.conversation,
        message_attachment_id: attachmentId,
        reservation_id: reservationId,
        delivered_by_user_id: assignedUser.user.id,
      });
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
      ids.giftSticker,
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
      .in("id", [ids.conversation, ids.otherClientConversation, ids.crossCharacterConversation]);
    if (restoreConversationError) throw restoreConversationError;
    await insertRow(service, "conversation_handling_cycles", {
      conversation_id: ids.conversation,
      work_item_id: ids.workItem,
      operator_id: ids.assignedOperator,
    });
    await insertRow(service, "conversation_handling_cycles", {
      conversation_id: ids.otherClientConversation,
      work_item_id: ids.otherClientWorkItem,
      operator_id: ids.assignedOperator,
    });
    await insertRow(service, "conversation_handling_cycles", {
      conversation_id: ids.crossCharacterConversation,
      work_item_id: ids.crossCharacterWorkItem,
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

    [owner, otherClient, assigned, assignedParallel, otherAssigned, unassigned, adminClient] =
      await Promise.all([
        signInSyntheticUser(emails.owner, ownerUser.password),
        signInSyntheticUser(emails.otherClient, otherClientUser.password),
        signInSyntheticUser(emails.assigned, assignedUser.password),
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
    const ownedEventTokens = [
      ...Object.values(ids),
      ...fixtureUserIds,
      ...tracked.attachments,
      ...tracked.messages,
      ...tracked.reservations,
      ...tracked.clientUploads,
    ];
    const assertCleanup = async () => {
      const [
        assets,
        reservations,
        messages,
        attachments,
        transactions,
        purchases,
        stickers,
        collections,
        profiles,
        objects,
      ] = await Promise.all([
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
          .in("message_attachment_id", tracked.attachments),
        service
          .from("gift_attachment_purchases")
          .select("id", { count: "exact", head: true })
          .eq("attachment_id", ids.paidAttachment),
        service
          .from("stickers")
          .select("id", { count: "exact", head: true })
          .eq("id", ids.giftSticker),
        service
          .from("sticker_collections")
          .select("id", { count: "exact", head: true })
          .eq("id", ids.giftCollection),
        service
          .from("profiles")
          .select("user_id", { count: "exact", head: true })
          .in("user_id", fixtureUserIds),
        service.storage.from(bucket).list(folder, { search: objectName }),
      ]);
      for (const result of [
        assets,
        reservations,
        messages,
        attachments,
        transactions,
        purchases,
        stickers,
        collections,
        profiles,
      ]) {
        if (result.error || result.count !== 0)
          throw new Error("local media fixture cleanup verification failed");
      }
      if (objects.error || objects.data?.some((object) => object.name === objectName)) {
        throw new Error("local media Storage cleanup verification failed");
      }
      if (giftPurchaseId) {
        requireWp06b(wp06bUuid.test(giftPurchaseId), "gift purchase identity");
        const privateCleared = wp06bFixtureDb(
          `
SELECT NOT EXISTS (
  SELECT 1 FROM private.gift_attachment_open_sessions
  WHERE attachment_id = '${ids.paidAttachment}'::uuid
) AND NOT EXISTS (
  SELECT 1 FROM private.gift_reward_events
  WHERE purchase_id = '${giftPurchaseId}'::uuid
);
`,
          "scoped gift private cleanup verification",
        );
        if (privateCleared !== "t")
          throw new Error("local gift private cleanup verification failed");
      }
    };

    await runCleanupSteps([
      {
        label: "resolve gift purchase",
        run: async () => {
          const { data, error } = await service
            .from("gift_attachment_purchases")
            .select("id,gift_message_id")
            .eq("attachment_id", ids.paidAttachment)
            .maybeSingle();
          if (error) throw error;
          giftPurchaseId = data?.id;
          giftMessageId = data?.gift_message_id ?? undefined;
          if (giftMessageId) ownedEventTokens.push(giftMessageId);
        },
      },
      {
        label: "fixture events before parent cleanup",
        run: async () => {
          await deleteFixtureEventsForOwnership(service, ownedEventTokens);
        },
      },
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
        label: "gift private sessions and allocations",
        run: async () => {
          wp06bFixtureDb(
            `
BEGIN;
DELETE FROM private.gift_attachment_open_sessions WHERE attachment_id = '${ids.paidAttachment}'::uuid;
DELETE FROM private.gift_reward_allocations WHERE gift_reward_event_id IN (
  SELECT event.id FROM private.gift_reward_events event
  JOIN public.gift_attachment_purchases purchase ON purchase.id = event.purchase_id
  WHERE purchase.attachment_id = '${ids.paidAttachment}'::uuid
);
WITH removed AS (
  DELETE FROM public.operator_point_transactions WHERE gift_reward_event_id IN (
    SELECT event.id FROM private.gift_reward_events event
    JOIN public.gift_attachment_purchases purchase ON purchase.id = event.purchase_id
    WHERE purchase.attachment_id = '${ids.paidAttachment}'::uuid
  ) RETURNING operator_id, amount
), totals AS (
  SELECT operator_id, sum(amount) AS amount FROM removed GROUP BY operator_id
)
UPDATE public.operator_point_wallets wallet
SET balance = wallet.balance - totals.amount,
    lifetime_earned = wallet.lifetime_earned - totals.amount
FROM totals WHERE wallet.operator_id = totals.operator_id;
COMMIT;
`,
            "scoped gift sessions and allocations",
          );
        },
      },
      {
        label: "operator point transactions",
        run: async () => {
          const { error } = await service
            .from("operator_point_transactions")
            .delete()
            .in("operator_id", [
              ids.assignedOperator,
              ids.otherAssignedOperator,
              ids.unassignedOperator,
            ]);
          if (error) throw error;
        },
      },
      {
        label: "gift reward event",
        run: async () => {
          wp06bFixtureDb(
            `
DELETE FROM private.gift_reward_events WHERE purchase_id IN (
  SELECT id FROM public.gift_attachment_purchases
  WHERE attachment_id = '${ids.paidAttachment}'::uuid
);
`,
            "scoped gift reward event",
          );
        },
      },
      {
        label: "gift purchase",
        run: async () =>
          deleteByEq(service, "gift_attachment_purchases", "attachment_id", ids.paidAttachment),
      },
      {
        label: "gift message sticker",
        run: async () => {
          if (giftMessageId)
            await deleteByEq(service, "message_stickers", "message_id", giftMessageId);
        },
      },
      {
        label: "credit transactions",
        run: async () => {
          const { error } = await service
            .from("credit_transactions")
            .delete()
            .in("message_attachment_id", tracked.attachments);
          if (error) throw error;
        },
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
        run: async () => {
          for (const conversationId of [
            ids.conversation,
            ids.otherClientConversation,
            ids.crossCharacterConversation,
          ]) {
            await deleteByEq(service, "notifications", "conversation_id", conversationId);
          }
        },
      },
      {
        label: "media deliveries",
        run: async () => {
          for (const clientId of [ownerId, userId(emails.otherClient)].filter(Boolean)) {
            await deleteByEq(service, "character_media_deliveries", "client_id", clientId!);
          }
        },
      },
      {
        label: "client upload fixture tombstones",
        run: async () => {
          if (tracked.clientUploads.length === 0) return;
          const { error } = await service
            .from("client_media_uploads")
            .update({
              status: "deleted",
              finalized_at: null,
              access_expires_at: null,
              message_id: null,
              message_attachment_id: null,
              idempotency_key: null,
            })
            .in("id", tracked.clientUploads);
          if (error) throw error;
        },
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
        label: "client media uploads",
        run: async () => {
          for (const uploadId of tracked.clientUploads) {
            await deleteByEq(service, "client_media_uploads", "id", uploadId);
          }
        },
      },
      {
        label: "messages",
        run: async () => {
          for (const conversationId of [
            ids.conversation,
            ids.otherClientConversation,
            ids.crossCharacterConversation,
          ]) {
            await deleteByEq(service, "messages", "conversation_id", conversationId);
          }
        },
      },
      {
        label: "reservations and handling cycle",
        run: async () => {
          for (const conversationId of [
            ids.conversation,
            ids.otherClientConversation,
            ids.crossCharacterConversation,
          ]) {
            await deleteByEq(
              service,
              "character_media_reservations",
              "conversation_id",
              conversationId,
            );
            await deleteByEq(
              service,
              "conversation_handling_cycles",
              "conversation_id",
              conversationId,
            );
          }
        },
      },
      {
        label: "work item",
        run: async () => {
          for (const conversationId of [
            ids.conversation,
            ids.otherClientConversation,
            ids.crossCharacterConversation,
          ]) {
            await deleteByEq(service, "conversation_work_items", "conversation_id", conversationId);
          }
        },
      },
      {
        label: "assets",
        run: async () =>
          deleteByEq(service, "character_media_assets", "character_id", ids.character),
      },
      {
        label: "media tags",
        run: async () => {
          await deleteByEq(service, "media_tags", "id", ids.tag);
          await deleteByEq(service, "media_tags", "id", ids.otherTag);
        },
      },
      {
        label: "gift sticker",
        run: async () => deleteByEq(service, "stickers", "id", ids.giftSticker),
      },
      {
        label: "gift collection",
        run: async () => deleteByEq(service, "sticker_collections", "id", ids.giftCollection),
      },
      ...[ids.assignedOperator, ids.otherAssignedOperator, ids.unassignedOperator].map(
        (operatorId) => ({
          label: `operator point wallet ${operatorId}`,
          run: async () => deleteByEq(service, "operator_point_wallets", "operator_id", operatorId),
        }),
      ),
      ...fixtureUserIds.map((fixtureUserId) => ({
        label: `wallet ${fixtureUserId}`,
        run: async () => deleteByEq(service, "credit_wallets", "user_id", fixtureUserId),
      })),
      {
        label: "character assignments",
        run: async () => {
          await deleteByEq(
            service,
            "character_operator_assignments",
            "character_id",
            ids.character,
          );
          await deleteByEq(
            service,
            "character_operator_assignments",
            "character_id",
            ids.otherCharacter,
          );
        },
      },
      {
        label: "conversation",
        run: async () => {
          for (const conversationId of [
            ids.conversation,
            ids.otherClientConversation,
            ids.crossCharacterConversation,
          ]) {
            await deleteByEq(service, "conversations", "id", conversationId);
          }
        },
      },
      {
        label: "character",
        run: async () => {
          await deleteByEq(service, "characters", "id", ids.character);
          await deleteByEq(service, "characters", "id", ids.otherCharacter);
        },
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
    expect(catalog.data).toHaveLength(4);
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
    assertSafeBusinessError(otherReservation.error, "active_handling_cycle_required");

    const expectedCycleId = await activeCycleId();
    const sideEffectsBeforeDeniedSends = await mediaSideEffectCounts();
    const [otherOperatorSend, unassignedSend] = await Promise.all([
      otherAssigned.rpc("send_operator_media_message", {
        _reservation_id: permanentReservationId,
        _caption: "v4_3_media_other_operator_attempt",
        _view_mode: "permanent",
        _expected_cycle_id: expectedCycleId,
      }),
      unassigned.rpc("send_operator_media_message", {
        _reservation_id: permanentReservationId,
        _caption: "v4_3_media_unassigned_attempt",
        _view_mode: "permanent",
        _expected_cycle_id: expectedCycleId,
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
      _caption: "",
      _view_mode: "permanent",
      _expected_cycle_id: expectedCycleId,
    });
    expect(ownerSend.error).toBeNull();
    const ownerSendResult = ownerSend.data as {
      already_sent: boolean;
      attachment: { id: string; message_id: string };
      message: { id: string };
    };
    expect(ownerSendResult).toMatchObject({ already_sent: false });
    expect(ownerSendResult.attachment.message_id).toBe(ownerSendResult.message.id);
    const sentWithoutCaption = await service
      .from("message_attachments")
      .select("caption")
      .eq("id", ownerSendResult.attachment.id)
      .single();
    expect(sentWithoutCaption.error).toBeNull();
    expect(sentWithoutCaption.data?.caption).toBeNull();
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
    await insertRow(service, "character_media_deliveries", {
      media_asset_id: ids.permanentAsset,
      client_id: userId(emails.owner),
      conversation_id: ids.conversation,
      message_attachment_id: ids.permanentAttachment,
      reservation_id: permanentReservationId,
      delivered_by_user_id: userId(emails.assigned),
    });
  });

  it("allows the same asset for another client, rejects the original client through another character, and keeps send retry idempotent", async () => {
    const otherCatalog = await assigned.rpc("get_operator_media_catalog", {
      _conversation_id: ids.otherClientConversation,
    });
    expect(otherCatalog.error).toBeNull();
    expect(otherCatalog.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: ids.permanentAsset,
          is_global: true,
          is_reservable: true,
          character_ids: expect.arrayContaining([ids.character, ids.otherCharacter]),
          media_tags: expect.arrayContaining([
            expect.objectContaining({ id: ids.tag }),
            expect.objectContaining({ id: ids.otherTag }),
          ]),
        }),
      ]),
    );

    const reservation = await assigned.rpc("reserve_character_media_for_delivery", {
      _conversation_id: ids.otherClientConversation,
      _asset_id: ids.permanentAsset,
      _intended_access_mode: "standard",
    });
    expect(reservation.error).toBeNull();
    const reservationId = String((reservation.data as { reservation_id: string }).reservation_id);
    tracked.reservations.push(reservationId);
    const cycleId = await activeCycleId(ids.otherClientConversation);
    const firstSend = await assigned.rpc("send_operator_media_message", {
      _reservation_id: reservationId,
      _caption: "wp05 second client",
      _view_mode: "permanent",
      _expected_cycle_id: cycleId,
    });
    expect(firstSend.error).toBeNull();
    const firstResult = firstSend.data as {
      already_sent: boolean;
      message: { id: string };
      attachment: { id: string };
    };
    expect(firstResult.already_sent).toBe(false);
    tracked.messages.push(firstResult.message.id);
    tracked.attachments.push(firstResult.attachment.id);
    otherClientAttachmentId = firstResult.attachment.id;

    const retry = await assigned.rpc("send_operator_media_message", {
      _reservation_id: reservationId,
      _caption: "wp05 second client",
      _view_mode: "permanent",
      _expected_cycle_id: cycleId,
    });
    expect(retry.error).toBeNull();
    expect(retry.data).toMatchObject({ already_sent: true });

    const duplicateAcrossCharacter = await assigned.rpc("reserve_character_media_for_delivery", {
      _conversation_id: ids.crossCharacterConversation,
      _asset_id: ids.permanentAsset,
      _intended_access_mode: "standard",
    });
    assertSafeBusinessError(
      duplicateAcrossCharacter.error,
      "media_asset_already_delivered_to_client",
    );
  });

  it("releases and expires reservations without creating or deleting delivery history", async () => {
    await reopenMainConversation();
    const reserveArgs = {
      _conversation_id: ids.conversation,
      _asset_id: ids.otherSendAsset,
      _intended_access_mode: "standard",
    };
    const first = await assigned.rpc("reserve_character_media_for_delivery", reserveArgs);
    expect(first.error).toBeNull();
    const firstId = String((first.data as { reservation_id: string }).reservation_id);
    tracked.reservations.push(firstId);
    const released = await assigned.rpc("release_character_media_reservation", {
      _reservation_id: firstId,
    });
    expect(released.error).toBeNull();
    expect(released.data).toMatchObject({ state: "released" });

    const second = await assigned.rpc("reserve_character_media_for_delivery", reserveArgs);
    expect(second.error).toBeNull();
    const secondId = String((second.data as { reservation_id: string }).reservation_id);
    tracked.reservations.push(secondId);
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    const createdAt = new Date(Date.now() - 120_000).toISOString();
    const forceExpiry = await service
      .from("character_media_reservations")
      .update({ created_at: createdAt, expires_at: expiredAt })
      .eq("id", secondId);
    expect(forceExpiry.error).toBeNull();

    const third = await assigned.rpc("reserve_character_media_for_delivery", reserveArgs);
    expect(third.error).toBeNull();
    const thirdId = String((third.data as { reservation_id: string }).reservation_id);
    expect(thirdId).not.toBe(secondId);
    tracked.reservations.push(thirdId);
    const [expiredReservation, deliveries] = await Promise.all([
      service.from("character_media_reservations").select("state").eq("id", secondId).single(),
      service
        .from("character_media_deliveries")
        .select("id", { count: "exact", head: true })
        .eq("media_asset_id", ids.otherSendAsset)
        .eq("client_id", userId(emails.owner)),
    ]);
    expect(expiredReservation.error).toBeNull();
    expect(expiredReservation.data?.state).toBe("expired");
    expect(deliveries.error).toBeNull();
    expect(deliveries.count).toBe(0);
  });

  it("serializes concurrent reserve and send retries without a second delivery", async () => {
    await reopenMainConversation();
    const reserveArgs = {
      _conversation_id: ids.conversation,
      _asset_id: ids.raceAsset,
      _intended_access_mode: "standard",
    };
    const [leftReserve, rightReserve] = await Promise.all([
      assigned.rpc("reserve_character_media_for_delivery", reserveArgs),
      assignedParallel.rpc("reserve_character_media_for_delivery", reserveArgs),
    ]);
    expect(leftReserve.error).toBeNull();
    expect(rightReserve.error).toBeNull();
    const reservationIds = [leftReserve.data, rightReserve.data].map((value) =>
      String((value as { reservation_id: string }).reservation_id),
    );
    expect(new Set(reservationIds).size).toBe(1);
    tracked.reservations.push(reservationIds[0]!);

    const expectedCycleId = await activeCycleId();
    const sendArgs = {
      _reservation_id: reservationIds[0]!,
      _caption: "wp05 concurrent retry",
      _view_mode: "permanent",
      _expected_cycle_id: expectedCycleId,
    };
    const [leftSend, rightSend] = await Promise.all([
      assigned.rpc("send_operator_media_message", sendArgs),
      assignedParallel.rpc("send_operator_media_message", sendArgs),
    ]);
    expect(leftSend.error).toBeNull();
    expect(rightSend.error).toBeNull();
    const results = [leftSend.data, rightSend.data] as Array<{
      already_sent: boolean;
      message: { id: string };
      attachment?: { id: string };
    }>;
    expect(results.filter((result) => result.already_sent === false)).toHaveLength(1);
    expect(results.filter((result) => result.already_sent === true)).toHaveLength(1);
    expect(new Set(results.map((result) => result.message.id)).size).toBe(1);
    tracked.messages.push(results[0]!.message.id);
    const attachmentId = results.find((result) => result.attachment)?.attachment?.id;
    if (attachmentId) tracked.attachments.push(attachmentId);

    const deliveries = await service
      .from("character_media_deliveries")
      .select("id", { count: "exact" })
      .eq("media_asset_id", ids.raceAsset)
      .eq("client_id", userId(emails.owner));
    expect(deliveries.error).toBeNull();
    expect(deliveries.count).toBe(1);
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
    expect(ownerAccess.data?.map((row) => row.attachment_id).sort()).toEqual(
      attachmentIds.filter((id) => id !== otherClientAttachmentId).sort(),
    );
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
          render_state: "gift_purchase_required",
          required_gift_id: ids.giftSticker,
          required_gift_name: "V4-3 media gift",
          required_gift_price_credits: 7,
        }),
        expect.objectContaining({ attachment_id: ids.lockedAttachment, render_state: "disabled" }),
      ]),
    );
    expect(otherAccess.error).toBeNull();
    expect(otherClientAttachmentId).toBeDefined();
    expect(otherAccess.data?.map((row) => row.attachment_id)).toEqual([otherClientAttachmentId]);
    expect(assignedAccess.error).toBeNull();
    expect(assignedAccess.data?.map((row) => row.attachment_id).sort()).toEqual(
      [...attachmentIds].sort(),
    );
    expect(unassignedAccess.error).toBeNull();
    expect(unassignedAccess.data).toEqual([]);
    for (const row of [...(ownerAccess.data ?? []), ...(assignedAccess.data ?? [])]) {
      expect(row).not.toHaveProperty("source_path");
      expect(row).not.toHaveProperty("preview_path");
      expect(row).not.toHaveProperty("object_path");
    }
  });

  it("issues short signed URLs only to authorized permanent-media actors", async () => {
    await runPermanentMediaScenario({
      actors: {
        owner,
        assigned,
        other: otherClient,
        unassigned,
        admin: adminClient,
      },
      attachmentId: ids.permanentAttachment,
      assetId: ids.permanentAsset,
      evidence: createMediaTestEvidenceFromEnvironment(),
    });
  }, 15_000);

  it("runs the client upload, real decode, idempotent replay, expiry and cleanup path", async () => {
    const intent = await owner.functions.invoke("client-media-upload-intent", {
      body: { conversation_id: ids.conversation, content_type: "image/png" },
    });
    expect(intent.error).toBeNull();
    const uploadId = String((intent.data as { upload_id: string }).upload_id);
    const uploadUrl = String((intent.data as { upload_url: string }).upload_url);
    tracked.clientUploads.push(uploadId);

    const onePixelPng = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const signedUpload = new URL(uploadUrl);
    expect(signedUpload.pathname).toMatch(/^\/storage\/v1\/object\/upload\/sign\/client-media\//);
    expect(signedUpload.searchParams.has("token")).toBe(true);
    const localApi = new URL(process.env.SUPABASE_LOCAL_URL ?? "");
    signedUpload.protocol = localApi.protocol;
    signedUpload.host = localApi.host;
    const uploaded = await fetch(signedUpload, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: onePixelPng,
    });
    expect(uploaded.ok).toBe(true);

    const idempotencyKey = "00000000-0000-4000-8000-000000061199";
    const finalized = await owner.functions.invoke("client-media-finalize", {
      body: { upload_id: uploadId, idempotency_key: idempotencyKey },
    });
    expect(finalized.error).toBeNull();
    const first = finalized.data as {
      message: { id: string };
      attachment: { id: string };
      already_finalized?: boolean;
    };
    tracked.messages.push(first.message.id);
    tracked.attachments.push(first.attachment.id);

    const replay = await owner.functions.invoke("client-media-finalize", {
      body: { upload_id: uploadId, idempotency_key: idempotencyKey },
    });
    expect(replay.error).toBeNull();
    expect(replay.data).toMatchObject({
      already_finalized: true,
      message: { id: first.message.id },
      attachment: { id: first.attachment.id },
    });

    const expired = await service
      .from("client_media_uploads")
      .update({
        access_expires_at: new Date(Date.now() - 60_000).toISOString(),
        next_cleanup_at: new Date(Date.now() - 60_000).toISOString(),
      })
      .eq("id", uploadId);
    expect(expired.error).toBeNull();

    const cleanup = await service.functions.invoke("cleanup-client-media", {
      body: { limit: 25 },
    });
    expect(cleanup.error).toBeNull();
    expect(cleanup.data).toMatchObject({ failed: 0 });
    const cleaned = await service
      .from("client_media_uploads")
      .select("status")
      .eq("id", uploadId)
      .single();
    expect(cleaned.error).toBeNull();
    expect(cleaned.data?.status).toBe("deleted");
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
      view_policy_version: "regular_60s_v1",
    });
    await expectSignedMedia(await invokeMediaView(owner, body), 60);

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

  it("purchases the required Gift once, opens its session, and keeps locked legacy media disabled", async () => {
    expect(lockedImagesEnabled).toBe(false);
    const paidBody = { kind: "message_attachment", attachment_id: ids.paidAttachment };
    await expectUnavailable(await invokeMediaView(owner, paidBody));

    const financialState = async () => {
      const [ownerWallet, operatorWallet, ledger] = await Promise.all([
        service
          .from("credit_wallets")
          .select("balance")
          .eq("user_id", userId(emails.owner))
          .single(),
        service
          .from("credit_wallets")
          .select("balance")
          .eq("user_id", userId(emails.assigned))
          .single(),
        service
          .from("credit_transactions")
          .select("id", { count: "exact", head: true })
          .eq("message_attachment_id", ids.paidAttachment),
      ]);
      expect(ownerWallet.error).toBeNull();
      expect(operatorWallet.error).toBeNull();
      expect(ledger.error).toBeNull();
      return [ownerWallet.data?.balance, operatorWallet.data?.balance, ledger.count];
    };
    const startingBalance = (await financialState())[0];
    expect(typeof startingBalance).toBe("number");
    expect(await financialState()).toEqual([startingBalance, 0, 0]);
    const legacyOpen = await owner.rpc("open_paid_message_attachment", {
      _attachment_id: ids.paidAttachment,
      _idempotency_key: "v4_3_media_legacy_gift_guard_0001",
    });
    assertSafeBusinessError(legacyOpen.error, "gift_purchase_required");
    expect(await financialState()).toEqual([startingBalance, 0, 0]);

    const purchased = await owner.rpc("purchase_attachment_gift", {
      _attachment_id: ids.paidAttachment,
      _gift_id: ids.giftSticker,
      _idempotency_key: giftPurchaseKey,
    });
    expect(purchased.error).toBeNull();
    const purchase = purchased.data as {
      purchase_id: string;
      balance: number;
      already_purchased: boolean;
      message: { id: string };
    };
    expect(purchase).toMatchObject({
      attachment_id: ids.paidAttachment,
      gift_id: ids.giftSticker,
      already_purchased: false,
      balance: startingBalance! - 7,
      message: { content: "[sticker]" },
    });
    giftPurchaseId = purchase.purchase_id;
    giftMessageId = purchase.message.id;
    expect(await financialState()).toEqual([startingBalance! - 7, 0, 1]);
    await expectUnavailable(await invokeMediaView(owner, paidBody));
    const purchasedAccess = await owner.rpc("get_message_attachment_access", {
      _attachment_ids: [ids.paidAttachment],
    });
    expect(purchasedAccess.error).toBeNull();
    expect(purchasedAccess.data).toEqual([
      expect.objectContaining({
        render_state: "gift_purchased",
        available_purchase_id: giftPurchaseId,
      }),
    ]);

    const purchaseReplay = await owner.rpc("purchase_attachment_gift", {
      _attachment_id: ids.paidAttachment,
      _gift_id: ids.giftSticker,
      _idempotency_key: giftPurchaseKey,
    });
    expect(purchaseReplay.error).toBeNull();
    expect(purchaseReplay.data).toMatchObject({
      purchase_id: giftPurchaseId,
      already_purchased: true,
      balance: startingBalance! - 7,
    });
    expect(await financialState()).toEqual([startingBalance! - 7, 0, 1]);

    const opened = await owner.rpc("open_attachment_gift_purchase", {
      _attachment_id: ids.paidAttachment,
      _purchase_id: giftPurchaseId,
      _idempotency_key: giftOpenKey,
    });
    expect(opened.error).toBeNull();
    const openResult = opened.data as {
      session_id: string;
      expires_at: string;
      already_opened: boolean;
    };
    expect(openResult.already_opened).toBe(false);
    expect(new Date(openResult.expires_at).getTime()).toBeGreaterThan(Date.now());
    paidSessionId = openResult.session_id;
    await expectSignedMedia(await invokeMediaView(owner, paidBody), 60);
    const openedAccess = await owner.rpc("get_message_attachment_access", {
      _attachment_ids: [ids.paidAttachment],
    });
    expect(openedAccess.error).toBeNull();
    expect(openedAccess.data).toEqual([
      expect.objectContaining({ render_state: "paid_open_active", available_purchase_id: null }),
    ]);
    const openReplay = await owner.rpc("open_attachment_gift_purchase", {
      _attachment_id: ids.paidAttachment,
      _purchase_id: giftPurchaseId,
      _idempotency_key: giftOpenKey,
    });
    expect(openReplay.error).toBeNull();
    expect(openReplay.data).toMatchObject({ session_id: paidSessionId, already_opened: true });
    const secondOpen = await owner.rpc("open_attachment_gift_purchase", {
      _attachment_id: ids.paidAttachment,
      _purchase_id: giftPurchaseId,
      _idempotency_key: "00000000-0000-4000-8000-000000061103",
    });
    assertSafeBusinessError(secondOpen.error, "gift_purchase_already_consumed");
    expect(await financialState()).toEqual([startingBalance! - 7, 0, 1]);

    const { data: transactions, error: transactionError } = await service
      .from("credit_transactions")
      .select("id,user_id,amount,type,reason,message_id,message_attachment_id")
      .eq("message_attachment_id", ids.paidAttachment);
    expect(transactionError).toBeNull();
    expect(transactions).toEqual([
      expect.objectContaining({
        user_id: userId(emails.owner),
        amount: -7,
        type: "sticker_spend",
        reason: "attachment_gift_purchase",
        message_id: giftMessageId,
        message_attachment_id: ids.paidAttachment,
      }),
    ]);
    const [purchaseRow, messageSticker] = await Promise.all([
      service
        .from("gift_attachment_purchases")
        .select("status,charged_transaction_id,gift_message_id,price_credits_snapshot")
        .eq("id", giftPurchaseId)
        .single(),
      service
        .from("message_stickers")
        .select("sticker_id,sticker_name_snapshot,price_credits_snapshot")
        .eq("message_id", giftMessageId)
        .single(),
    ]);
    expect(purchaseRow.error).toBeNull();
    expect(purchaseRow.data).toMatchObject({
      status: "opened",
      charged_transaction_id: transactions?.[0]?.id,
      gift_message_id: giftMessageId,
      price_credits_snapshot: 7,
    });
    expect(messageSticker.error).toBeNull();
    expect(messageSticker.data).toMatchObject({
      sticker_id: ids.giftSticker,
      sticker_name_snapshot: "V4-3 media gift",
      price_credits_snapshot: 7,
    });

    requireWp06b(wp06bUuid.test(paidSessionId), "gift session identity");
    const expiredSessionId = wp06bFixtureDb(
      `
UPDATE private.gift_attachment_open_sessions
SET opened_at = clock_timestamp() - interval '61 seconds',
    expires_at = clock_timestamp() - interval '1 second'
WHERE id = '${paidSessionId}'::uuid AND attachment_id = '${ids.paidAttachment}'::uuid
RETURNING id;
`,
      "expire exact gift session",
    );
    expect(expiredSessionId).toBe(paidSessionId);
    await expectUnavailable(await invokeMediaView(owner, paidBody));

    await expectUnavailable(
      await invokeMediaView(owner, {
        kind: "message_attachment",
        attachment_id: ids.lockedAttachment,
      }),
    );
  });
});

suite("WP06B profile image Storage cleanup", () => {
  it("WP06B #10: the current worker records deletion only after authoritative Storage absence", async () => {
    const service = createServiceClient();
    const runId = process.env.WP015_HTTP_RUN_ID || process.env.RUN_ID;
    const api = new URL(process.env.SUPABASE_LOCAL_URL ?? "");
    requireWp06b(
      runId &&
        api.protocol === "http:" &&
        api.port === process.env.SUPABASE_LOCAL_API_PORT &&
        ["127.0.0.1", "localhost", "[::1]"].includes(api.hostname),
      "disposable local HTTP runner and run ID required",
    );
    requireWp06b(wp06bFixtureDb("SELECT 1;", "local DB target") === "1", "local DB target");
    const scope = createHash("sha256")
      .update(JSON.stringify([runId, process.pid, performance.timeOrigin]))
      .digest("hex")
      .slice(0, 24);
    const fileName = `wp06b-${scope}.webp`;
    const email = `wp06b-${scope}@example.invalid`;
    const password = randomBytes(24).toString("base64url");
    const storage = service.storage.from(wp06bBucket);
    let ownerId = "";
    let objectPath = "";
    let uploadAttempted = false;

    async function fixtureObjectPresent() {
      const listed = await storage.list(ownerId, { search: fileName, limit: 2 });
      requireWp06b(!listed.error && Array.isArray(listed.data), "Storage listing");
      requireWp06b(
        listed.data.length === 0 || (listed.data.length === 1 && listed.data[0].name === fileName),
        "exact Storage listing",
      );
      return listed.data.length === 1;
    }

    async function removeFixtureObject() {
      const removed = await storage.remove([objectPath]);
      requireWp06b(
        !removed.error && removed.data?.length === 1 && removed.data[0].name === objectPath,
        "exact Storage API remove acknowledgment",
      );
    }

    try {
      const created = await service.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: { registration_origin: "admin_provisioned" },
      });
      const createdId = created.data.user?.id;
      requireWp06b(!created.error && createdId && wp06bUuid.test(createdId), "fresh Auth Client");
      ownerId = createdId;
      objectPath = `${ownerId}/${fileName}`;
      requireWp06b(
        created.data.user?.app_metadata.registration_origin === "admin_provisioned",
        "trusted Auth provisioning",
      );
      const fixtureOwner = await signInSyntheticUser(email, password);
      requireWp06b(!(await fixtureObjectPresent()), "new Storage path must be vacant");
      const image = Buffer.from("UklGRhoAAABXRUJQVlA4TA4AAAAvAUAAAAcQEf0PRET/Aw==", "base64");
      uploadAttempted = true;
      const uploaded = await fixtureOwner.storage.from(wp06bBucket).upload(objectPath, image, {
        contentType: "image/webp",
        upsert: false,
      });
      requireWp06b(!uploaded.error && uploaded.data?.path === objectPath, "owner Storage upload");
      const publicUrl = storage.getPublicUrl(objectPath).data.publicUrl;

      async function saveImages(primary: string | null) {
        const urls = primary === null ? [] : [primary];
        const saved = await fixtureOwner.rpc("update_client_profile_images", {
          _profile_image_urls: urls,
          _profile_image_url: primary,
        });
        const row = saved.data?.[0];
        requireWp06b(
          !saved.error &&
            saved.data?.length === 1 &&
            row?.profile_image_url === primary &&
            Array.isArray(row.profile_image_urls) &&
            row.profile_image_urls.length === urls.length &&
            (primary === null || row.profile_image_urls[0] === primary),
          primary === null ? "committed profile removal" : "committed profile save",
        );
      }

      await saveImages(publicUrl);
      await saveImages(null);
      const { queueId, claimToken } = claimWp06bFixture(ownerId, objectPath);
      const claimArgs = { _queue_id: queueId, _claim_token: claimToken };
      const authorization = await service.rpc(
        "authorize_client_profile_image_cleanup_for_server",
        claimArgs,
      );
      if (authorization.error || authorization.data !== "delete") {
        throw new Error("WP06B fixture failed: worker delete authorization");
      }
      const downloaded = await storage.download(objectPath);
      requireWp06b(
        !downloaded.error &&
          downloaded.data &&
          image.equals(Buffer.from(await downloaded.data.arrayBuffer())),
        "uploaded WebP remains readable after profile removal",
      );

      async function expectCompletionError(token: string, expected: string) {
        const completed = await service.rpc("complete_client_profile_image_cleanup_for_server", {
          ...claimArgs,
          _claim_token: token,
        });
        requireWp06b(
          completed.data === null &&
            completed.error?.code === "P0001" &&
            completed.error.message === expected,
          `completion must reject with ${expected}`,
        );
      }

      await expectCompletionError(claimToken, "profile_image_storage_object_still_present");
      await removeFixtureObject();
      requireWp06b(!(await fixtureObjectPresent()), "Storage absence");
      const wrongToken = randomUUID();
      requireWp06b(wrongToken !== claimToken, "distinct wrong token");
      await expectCompletionError(wrongToken, "profile_image_cleanup_claim_not_found");
      const completed = await service.rpc(
        "complete_client_profile_image_cleanup_for_server",
        claimArgs,
      );
      requireWp06b(
        !completed.error && completed.data === "deleted",
        "current token completes deletion",
      );
    } finally {
      if (ownerId) {
        let storageCleared = false;
        await runCleanupSteps([
          {
            label: "WP06B exact Storage fixture",
            run: async () => {
              if (uploadAttempted && (await fixtureObjectPresent())) {
                const owned = wp06bFixtureDb(
                  `
SELECT count(*) FROM storage.objects
WHERE bucket_id = '${wp06bBucket}' AND name = '${objectPath}' AND owner_id = '${ownerId}';
`,
                  "Storage cleanup ownership",
                );
                requireWp06b(owned === "1", "refuse Storage cleanup without exact ownership");
                await removeFixtureObject();
              }
              if (uploadAttempted)
                requireWp06b(!(await fixtureObjectPresent()), "Storage cleanup verification");
              storageCleared = true;
            },
          },
          {
            label: "WP06B fixture events before Auth cleanup",
            run: async () => {
              await deleteFixtureEventsForOwnership(service, [ownerId]);
            },
          },
          {
            label: "WP06B exact Auth fixture",
            run: async () => {
              requireWp06b(
                storageCleared,
                "preserve Auth owner when Storage cleanup is unverified",
              );
              await deleteAuthUser(service, ownerId);
            },
          },
          {
            label: "WP06B fixture event cleanup verification",
            run: async () => {
              await deleteFixtureEventsForOwnership(service, [ownerId]);
              await assertNoFixtureEvents(service, [ownerId]);
            },
          },
          {
            label: "WP06B Auth and queue cascade verification",
            run: async () => {
              const cleared = wp06bFixtureDb(
                `
SELECT NOT EXISTS (SELECT 1 FROM auth.users WHERE id = '${ownerId}'::uuid)
   AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = '${ownerId}'::uuid)
   AND NOT EXISTS (SELECT 1 FROM public.client_profiles WHERE user_id = '${ownerId}'::uuid)
   AND NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = '${ownerId}'::uuid)
   AND NOT EXISTS (SELECT 1 FROM private.registration_eligibility WHERE user_id = '${ownerId}'::uuid)
   AND NOT EXISTS (
     SELECT 1 FROM private.client_profile_image_cleanup_queue
     WHERE owner_user_id = '${ownerId}'::uuid
       AND bucket_id = '${wp06bBucket}' AND object_path = '${objectPath}'
   );
`,
                "Auth and exact queue cascade",
              );
              requireWp06b(cleared === "t", "Auth and exact queue cleanup verification");
            },
          },
        ]);
      }
    }
  }, 60_000);
});
