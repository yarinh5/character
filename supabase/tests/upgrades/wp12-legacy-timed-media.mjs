import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import {
  discoverConcurrencyTarget,
  resolveConcurrencyBinding,
} from "../concurrency/local-target.mjs";

const phase = process.argv[2];
assert.ok(phase === "seed" || phase === "verify", "expected seed or verify");
const binding = resolveConcurrencyBinding();
assert.ok(
  binding.engineId && binding.projectId.startsWith("ac33-legacy-"),
  "disposable AC33 target required",
);
const { dbId, apiPort } = discoverConcurrencyTarget(binding, { healthy: true });
const status = JSON.parse(
  execFileSync("supabase", ["status", "--output", "json"], { encoding: "utf8", timeout: 30_000 }),
);
const api = new URL(status.API_URL);
assert.equal(api.origin, `http://127.0.0.1:${apiPort}`);
assert.ok(status.ANON_KEY && status.SERVICE_ROLE_KEY, "local Auth credentials required");
const password = process.env.AC33_SYNTHETIC_PASSWORD;
assert.match(password ?? "", /^[a-f0-9]{48}$/);
const options = {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
};
const service = createClient(api.origin, status.SERVICE_ROLE_KEY, options);
const id = (n) => `00000000-0000-4000-8000-00000033${String(n).padStart(4, "0")}`;
const characterId = id(1);
const operatorId = id(2);
const conversationId = id(3);
const price = 7;
const initialBalance = 20;
const bucket = "character-media";
const objectPath = `characters/${characterId}/legacy-timed.webp`;
const bytes = Buffer.from(
  "UklGRjYAAABXRUJQVlA4ICoAAABwAQCdASoBAAEAAUAmJaACdAFAAAD+7U3CMNGv/20P//bQ//9tD/pQAAA=",
  "base64",
);
const ownerEmail = "ac33-legacy-owner@example.invalid";
const cases = [
  {
    name: "legacy View Once",
    mode: "view_once",
    asset: id(11),
    reservation: id(12),
    message: id(13),
    attachment: id(14),
    key: id(15),
  },
  {
    name: "pre-Gift paid open",
    mode: "paid_open",
    asset: id(21),
    reservation: id(22),
    message: id(23),
    attachment: id(24),
    key: id(25),
  },
];

function sql(command) {
  return execFileSync(
    "docker",
    [
      "exec",
      dbId,
      "psql",
      "-X",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      command,
    ],
    { encoding: "utf8", timeout: 15_000 },
  ).trim();
}

async function checked(request, context) {
  const { data, error } = await request;
  assert.ok(!error, `${context}: ${error?.code ?? error?.status ?? "unknown"}`);
  return data;
}

const insert = (table, row) => checked(service.from(table).insert(row), `insert ${table}`);
const head = sql("SELECT max(version) FROM supabase_migrations.schema_migrations");
const guard = sql(
  "SELECT EXISTS (SELECT FROM pg_trigger WHERE tgname = 'require_gift_for_new_paid_attachment' AND tgrelid = 'public.message_attachments'::regclass AND tgenabled = 'O')",
);

if (phase === "seed") {
  assert.equal(head, "20261105130000", "seed immediately before the Gift migration");
  assert.equal(guard, "f");
  assert.equal(sql("SELECT count(*) FROM auth.users"), "0", "fresh synthetic target required");
  const owner = id(31);
  const operator = id(32);
  // Model a historical Auth import; the currently configured signup hook was not installed yet.
  try {
    execFileSync(
      "docker",
      [
        "exec",
        "-i",
        dbId,
        "psql",
        "-X",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15_000,
        input: `
BEGIN;
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
SELECT '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
  email, extensions.crypt('${password}', extensions.gen_salt('bf')), now(),
  '', '', '', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()
FROM (VALUES
  ('${owner}'::uuid, '${ownerEmail}'),
  ('${operator}'::uuid, 'ac33-legacy-operator@example.invalid')
) AS seed(uid, email);
INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider, created_at, updated_at)
SELECT gen_random_uuid(), id, id::text, jsonb_build_object('sub', id::text, 'email', email, 'email_verified', true),
  'email', now(), now()
FROM auth.users WHERE id IN ('${owner}', '${operator}');
COMMIT;`,
      },
    );
  } catch {
    throw new Error("historical synthetic Auth import failed");
  }
  await insert("user_roles", { user_id: operator, role: "operator" });
  await insert("operators", {
    id: operatorId,
    user_id: operator,
    full_name: "AC33 worker",
    is_active: true,
  });
  await insert("characters", {
    id: characterId,
    name: "AC33 character",
    is_active: true,
    is_visible: true,
  });
  await insert("character_operator_assignments", {
    character_id: characterId,
    operator_id: operatorId,
  });
  await insert("conversations", {
    id: conversationId,
    client_id: owner,
    character_id: characterId,
    assigned_operator_id: operatorId,
    status: "open",
  });
  await checked(
    service.from("credit_wallets").upsert(
      [
        {
          user_id: owner,
          balance: initialBalance,
          lifetime_earned: initialBalance,
          lifetime_spent: 0,
        },
        { user_id: operator, balance: 0, lifetime_earned: 0, lifetime_spent: 0 },
      ],
      { onConflict: "user_id" },
    ),
    "seed wallets",
  );
  await checked(
    service.storage
      .from(bucket)
      .upload(objectPath, bytes, { contentType: "image/webp", upsert: false }),
    "upload synthetic preview",
  );
  for (const spec of cases) {
    const now = new Date();
    const paid = spec.mode === "paid_open";
    await insert("character_media_assets", {
      id: spec.asset,
      character_id: characterId,
      bucket_id: bucket,
      source_path: `${objectPath}.${spec.mode}`,
      preview_path: objectPath,
      content_type: "image/webp",
      status: "available",
      ingest_status: "ready",
      preview_generated_at: now.toISOString(),
      paid_open_price_credits: paid ? price : null,
    });
    await insert("character_media_reservations", {
      id: spec.reservation,
      media_asset_id: spec.asset,
      conversation_id: conversationId,
      client_id: owner,
      operator_id: operatorId,
      reserved_by_user_id: operator,
      previous_asset_status: "available",
      state: "consumed",
      intended_access_mode: "standard",
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
      ended_at: now.toISOString(),
      ended_by_user_id: operator,
      ended_reason: "sent",
    });
    await insert("messages", {
      id: spec.message,
      conversation_id: conversationId,
      sender_type: "operator",
      sender_id: operator,
      operator_id: operatorId,
      content: "[image]",
    });
    await insert("message_attachments", {
      id: spec.attachment,
      message_id: spec.message,
      media_asset_id: spec.asset,
      reservation_id: spec.reservation,
      kind: "image",
      access_mode: "standard",
      view_mode: spec.mode,
      price_credits_snapshot: paid ? price : null,
    });
  }
  console.log("Seeded both historical attachment IDs with Gift trigger absent");
} else {
  assert.equal(guard, "t", "Gift trigger must be enabled after upgrade");
  assert.equal(
    sql(
      "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261105150000'",
    ),
    "1",
  );
  const rows = await checked(
    service
      .from("message_attachments")
      .select("id,view_policy_version,required_gift_id,view_mode")
      .in(
        "id",
        cases.map((spec) => spec.attachment),
      ),
    "read migrated fixtures",
  );
  assert.equal(rows.length, cases.length);
  for (const spec of cases) {
    assert.deepEqual(
      rows.find((row) => row.id === spec.attachment),
      {
        id: spec.attachment,
        view_policy_version: "legacy",
        required_gift_id: null,
        view_mode: spec.mode,
      },
    );
  }
  const { error: guardError } = await service.from("message_attachments").insert({
    id: id(90),
    message_id: cases[1].message,
    media_asset_id: cases[1].asset,
    reservation_id: cases[1].reservation,
    kind: "image",
    access_mode: "standard",
    view_mode: "paid_open",
    price_credits_snapshot: price,
  });
  assert.equal(guardError?.code, "P0001");
  assert.equal(guardError?.message, "paid_attachment_requires_gift");

  const owner = createClient(api.origin, status.ANON_KEY, options);
  const { user, session } = await checked(
    owner.auth.signInWithPassword({ email: ownerEmail, password }),
    "owner sign-in",
  );
  const operator = await checked(
    service.from("operators").select("user_id").eq("id", operatorId).single(),
    "read payout owner",
  );
  const invoke = (spec) =>
    fetch(new URL("/functions/v1/media-view-url", api), {
      method: "POST",
      headers: {
        apikey: status.ANON_KEY,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ kind: "message_attachment", attachment_id: spec.attachment }),
      signal: AbortSignal.timeout(8_000),
    });

  for (const spec of cases) {
    try {
      assert.equal((await invoke(spec)).status, 404, "closed before opening");
      const args = { _attachment_id: spec.attachment, _idempotency_key: spec.key };
      const paid = spec.mode === "paid_open";
      const opened = await checked(
        owner.rpc(paid ? "open_paid_message_attachment" : "open_free_view_once_attachment", args),
        "open migrated attachment",
      );
      if (paid) {
        assert.equal(opened.already_opened, false);
        assert.equal(opened.balance, initialBalance - price);
        assert.match(opened.session_id ?? "", /^[a-f0-9-]{36}$/);
      } else {
        assert.equal(opened.view_policy_version, "legacy");
        assert.equal(opened.render_state, "view_once_opened");
      }
      const response = await invoke(spec);
      assert.equal(response.status, 200, "signing within legacy window");
      const signed = await response.json();
      assert.deepEqual(Object.keys(signed).sort(), ["expires_at", "url"]);
      const ttl = Date.parse(signed.expires_at) - Date.now();
      assert.ok(ttl > 0 && ttl <= 8_500, "signed lifetime limited to legacy window");
      const url = new URL(signed.url);
      assert.ok(decodeURIComponent(url.pathname).endsWith(`/object/sign/${bucket}/${objectPath}`));
      const object = await fetch(new URL(url.pathname + url.search, api), {
        signal: AbortSignal.timeout(8_000),
      });
      assert.equal(object.status, 200, "download signed historical object");
      assert.deepEqual(Buffer.from(await object.arrayBuffer()), bytes);

      const complete = await checked(
        owner.rpc(
          paid ? "complete_paid_message_attachment_session" : "complete_free_view_once_attachment",
          paid ? { _session_id: opened.session_id } : { _attachment_id: spec.attachment },
        ),
        "complete historical session",
      );
      assert.equal(complete.completed, true);
      assert.equal((await invoke(spec)).status, 404, "no new signed URL after completion");
      if (paid) {
        const replay = await checked(
          owner.rpc("open_paid_message_attachment", args),
          "replay paid open",
        );
        assert.equal(replay.session_id, opened.session_id);
        assert.equal(replay.already_opened, true);
        const ledger = await checked(
          service
            .from("credit_transactions")
            .select("amount,type,user_id,message_id")
            .eq("message_attachment_id", spec.attachment)
            .order("amount"),
          "read linked ledger",
        );
        assert.deepEqual(ledger, [
          {
            amount: -price,
            type: "paid_image_open_spend",
            user_id: user.id,
            message_id: spec.message,
          },
          {
            amount: price,
            type: "paid_image_open_payout",
            user_id: operator.user_id,
            message_id: spec.message,
          },
        ]);
      }
      console.log(`PASS: ${spec.name}`);
    } catch (error) {
      console.error(`FAIL: ${spec.name}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
