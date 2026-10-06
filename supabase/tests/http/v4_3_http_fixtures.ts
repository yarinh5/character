import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

export type HttpClient = SupabaseClient;

export const localHttpReady = Boolean(
  process.env.SUPABASE_LOCAL_URL &&
  process.env.SUPABASE_LOCAL_ANON_KEY &&
  process.env.SUPABASE_LOCAL_SERVICE_ROLE_KEY,
);

export const localStickersEnabled = process.env.SUPABASE_LOCAL_STICKERS_ENABLED === "true";

const localUrl = process.env.SUPABASE_LOCAL_URL ?? "";
const anonKey = process.env.SUPABASE_LOCAL_ANON_KEY ?? "";
const serviceRoleKey = process.env.SUPABASE_LOCAL_SERVICE_ROLE_KEY ?? "";

export function createAnonymousClient(): HttpClient {
  return createClient(localUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

export function createServiceClient(): HttpClient {
  return createClient(localUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

export async function createSyntheticUser(
  admin: HttpClient,
  email: string,
  onCreated?: (user: User) => void,
): Promise<{ user: User; password: string }> {
  const password = randomBytes(24).toString("base64url");
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user)
    throw new Error(`local fixture user creation failed: ${error?.code ?? "unknown"}`);
  onCreated?.(data.user);
  return { user: data.user, password };
}

export async function signInSyntheticUser(email: string, password: string): Promise<HttpClient> {
  const client = createAnonymousClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`local fixture sign-in failed: ${error.code ?? "unknown"}`);
  return client;
}

export async function insertRow(client: HttpClient, table: string, row: Record<string, unknown>) {
  const { error } = await client.from(table).insert(row);
  if (error)
    throw new Error(`local fixture insert failed for ${table}: ${error.code ?? "unknown"}`);
}

export async function upsertRow(
  client: HttpClient,
  table: string,
  row: Record<string, unknown>,
  onConflict: string,
) {
  const { error } = await client.from(table).upsert(row, { onConflict });
  if (error)
    throw new Error(`local fixture upsert failed for ${table}: ${error.code ?? "unknown"}`);
}

export async function setRole(admin: HttpClient, userId: string, role: string) {
  await upsertRow(admin, "user_roles", { user_id: userId, role }, "user_id,role");
}

export async function updateProfile(
  admin: HttpClient,
  userId: string,
  email: string,
  displayName: string,
) {
  const { error } = await admin
    .from("profiles")
    .update({ email, display_name: displayName })
    .eq("user_id", userId);
  if (error) throw new Error(`local fixture profile update failed: ${error.code ?? "unknown"}`);
}

export async function seedOperator(
  admin: HttpClient,
  operatorId: string,
  userId: string,
  fullName: string,
) {
  await insertRow(admin, "operators", {
    id: operatorId,
    user_id: userId,
    full_name: fullName,
    is_active: true,
    availability_status: "available",
    presence_status: "online",
    last_seen_at: new Date().toISOString(),
  });
}

export async function seedCharacter(admin: HttpClient, characterId: string, name: string) {
  await insertRow(admin, "characters", {
    id: characterId,
    name,
    is_active: true,
    is_visible: true,
    availability_status: "available",
  });
}

export async function seedConversation(
  admin: HttpClient,
  conversationId: string,
  clientId: string,
  characterId: string,
  assignedOperatorId?: string,
) {
  await insertRow(admin, "conversations", {
    id: conversationId,
    client_id: clientId,
    character_id: characterId,
    assigned_operator_id: assignedOperatorId ?? null,
    status: "open",
  });
}

export async function seedNewWorkItem(
  admin: HttpClient,
  workItemId: string,
  conversationId: string,
  clientId: string,
  characterId: string,
  messageId: string,
) {
  const { error } = await admin
    .from("conversation_work_items")
    .update({
      id: workItemId,
      client_id: clientId,
      character_id: characterId,
      status: "new",
      last_client_message_id: messageId,
      last_activity_at: new Date().toISOString(),
    })
    .eq("conversation_id", conversationId);
  if (error) throw new Error(`local fixture work-item setup failed: ${error.code ?? "unknown"}`);
}

export async function seedClientMessage(
  admin: HttpClient,
  messageId: string,
  conversationId: string,
  clientId: string,
  content = "V4-3-C synthetic HTTP message",
) {
  await insertRow(admin, "messages", {
    id: messageId,
    conversation_id: conversationId,
    sender_type: "client",
    sender_id: clientId,
    content,
  });
}

export async function seedStickerFixture(
  admin: HttpClient,
  collectionId: string,
  stickerId: string,
  characterId: string,
) {
  await insertRow(admin, "sticker_collections", {
    id: collectionId,
    slug: "v4-3-c-paid",
    name: "V4-3-C paid stickers",
    character_id: characterId,
    is_active: true,
  });
  await insertRow(admin, "stickers", {
    id: stickerId,
    collection_id: collectionId,
    slug: "v4-3-c-paid-sticker",
    name: "V4-3-C paid sticker",
    object_path: `collections/${collectionId}/stickers/${stickerId}/render.webp`,
    width: 1,
    height: 1,
    byte_size: 1,
    is_active: true,
    ingest_status: "ready",
    processed_at: new Date().toISOString(),
    price_credits: 7,
  });
}

export async function seedWallet(admin: HttpClient, userId: string, balance: number) {
  await upsertRow(
    admin,
    "credit_wallets",
    { user_id: userId, balance, lifetime_earned: balance, lifetime_spent: 0 },
    "user_id",
  );
}

export async function readCount(client: HttpClient, table: string, column = "id") {
  const { count, error } = await client.from(table).select(column, { count: "exact", head: true });
  if (error) throw new Error(`local baseline read failed for ${table}: ${error.code ?? "unknown"}`);
  return count ?? 0;
}

export async function deleteByEq(client: HttpClient, table: string, column: string, value: string) {
  const { error } = await client.from(table).delete().eq(column, value);
  if (error)
    throw new Error(`local fixture cleanup failed for ${table}: ${error.code ?? "unknown"}`);
}

export async function cleanupPrivateStickerAttempts(keys: string[]) {
  if (keys.length === 0) return;
  const db = execFileSync(
    "docker",
    ["ps", "--filter", "name=supabase_db_qmgkmsarzfjnqltljkjl", "--format", "{{.Names}}"],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  )
    .trim()
    .split(/\r?\n/)[0];
  if (!db) throw new Error("local fixture cleanup could not find the target DB container");
  const literals = keys.map((key) => `'${key.replaceAll("'", "''")}'`).join(", ");
  execFileSync(
    "docker",
    [
      "exec",
      db,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `DELETE FROM private.sticker_send_attempts WHERE idempotency_key::text IN (${literals});`,
    ],
    { encoding: "utf8", windowsHide: true, stdio: "pipe" },
  );
}

export async function readLocalPrivateStickerAttemptCount(actorUserIds: string[] = []) {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!actorUserIds.every((value) => uuidPattern.test(value))) {
    throw new Error("local sticker-attempt count received a non-UUID actor identifier");
  }
  const db = execFileSync(
    "docker",
    ["ps", "--filter", "name=supabase_db_qmgkmsarzfjnqltljkjl", "--format", "{{.Names}}"],
    { encoding: "utf8", windowsHide: true },
  )
    .trim()
    .split(/\r?\n/)[0];
  if (!db) throw new Error("local fixture inspection could not find the target DB container");
  const predicate =
    actorUserIds.length === 0
      ? ""
      : ` WHERE actor_user_id IN (${actorUserIds.map((value) => `'${value}'::uuid`).join(", ")})`;
  const output = execFileSync(
    "docker",
    [
      "exec",
      db,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `SELECT count(*) FROM private.sticker_send_attempts${predicate};`,
    ],
    { encoding: "utf8", windowsHide: true, stdio: "pipe" },
  ).trim();
  const count = Number(output);
  if (!Number.isInteger(count)) throw new Error("local sticker-attempt count was not an integer");
  return count;
}

export async function cleanupPrivateMediaOpenState(attachmentIds: string[], clientIds: string[]) {
  if (attachmentIds.length === 0 && clientIds.length === 0) return;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (![...attachmentIds, ...clientIds].every((value) => uuidPattern.test(value))) {
    throw new Error("local media cleanup received a non-UUID identifier");
  }
  const db = execFileSync(
    "docker",
    ["ps", "--filter", "name=supabase_db_qmgkmsarzfjnqltljkjl", "--format", "{{.Names}}"],
    { encoding: "utf8", windowsHide: true },
  )
    .trim()
    .split(/\r?\n/)[0];
  if (!db) throw new Error("local media cleanup could not find the target DB container");
  const attachmentLiterals = attachmentIds.map((value) => `'${value}'::uuid`).join(", ");
  const clientLiterals = clientIds.map((value) => `'${value}'::uuid`).join(", ");
  const sessionPredicates = [
    attachmentLiterals ? `attachment_id IN (${attachmentLiterals})` : "",
    clientLiterals ? `client_id IN (${clientLiterals})` : "",
  ].filter(Boolean);
  execFileSync(
    "docker",
    [
      "exec",
      db,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `DELETE FROM private.message_attachment_open_sessions WHERE ${sessionPredicates.join(" OR ")}; DELETE FROM private.message_attachment_open_rate_limits WHERE ${sessionPredicates.join(" OR ")};`,
    ],
    { encoding: "utf8", windowsHide: true, stdio: "pipe" },
  );
}

export async function deleteAuthUser(admin: HttpClient, userId: string) {
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) throw new Error(`local fixture auth cleanup failed: ${error.code ?? "unknown"}`);
}

export async function runCleanupSteps(steps: Array<{ label: string; run: () => Promise<void> }>) {
  const failures: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code ?? "unknown")
          : "unknown";
      failures.push(`${step.label} [${code}]`);
    }
  }
  if (failures.length > 0) {
    const summary = failures.join(", ");
    console.error(`Local fixture cleanup failures after all attempts: ${summary}`);
    throw new Error(`Local fixture cleanup incomplete: ${summary}`);
  }
}

export function assertSafeBusinessError(
  error: { code?: string; message?: string } | null,
  expectedCode: string,
) {
  if (!error) throw new Error(`expected business error ${expectedCode}`);
  if (error.code !== expectedCode && !error.message?.includes(expectedCode)) {
    throw new Error(`unexpected sanitized business error code: ${error.code ?? "unknown"}`);
  }
}
