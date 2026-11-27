import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { assertConcurrencyMigrationVersions } from "./migration-inventory.mjs";
import { discoverConcurrencyTarget, resolveConcurrencyBinding } from "./local-target.mjs";

const binding = resolveConcurrencyBinding();
assert.ok(
  binding.engineId,
  "AC22 requires PRODUCT_TEST_PROJECT_ID and PRODUCT_TEST_ENGINE_ID for an isolated non-QA stack",
);
const container = discoverConcurrencyTarget(binding, { healthy: true }).dbId;
const run = `ac22_${randomUUID().replaceAll("-", "")}`;
const ids = Object.fromEntries(
  [
    "client",
    "operatorUser1",
    "operatorUser2",
    "operator1",
    "operator2",
    "character",
    "tag",
    "asset",
    "reservation",
    "conversation",
    "sourceMessage",
    "attachment",
    "collection",
    "gift",
    "purchaseKey",
    "emptyKey",
  ].map((name) => [name, randomUUID()]),
);
const sessions = [];
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const inList = (values) => values.map(quote).join(",");
const users = inList([ids.client, ids.operatorUser1, ids.operatorUser2]);
const operators = inList([ids.operator1, ids.operator2]);

class Session {
  constructor(label) {
    this.name = `${run}_${label}`;
    this.buffer = "";
    this.stderr = "";
    this.pending = null;
    this.child = spawn(
      "docker",
      [
        "exec",
        "-i",
        "-e",
        `PGAPPNAME=${this.name}`,
        container,
        "psql",
        "-X",
        "-qAt",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=off",
        "-v",
        "VERBOSITY=terse",
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let newline;
      while ((newline = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!this.pending) continue;
        if (line.startsWith(`${this.pending.marker} `)) {
          const pending = this.pending;
          this.pending = null;
          clearTimeout(pending.timer);
          const [, failed, sqlstate, ...message] = line.split(" ");
          pending.resolve({ lines: pending.lines, failed, sqlstate, message: message.join(" ") });
        } else if (line) this.pending.lines.push(line);
      }
    });
    this.closed = new Promise((resolve) => this.child.once("close", resolve));
    this.child.on("error", (error) => this.fail(error.message));
    this.child.on("close", (code) => this.fail(`psql exited ${code}: ${this.stderr.slice(-1000)}`));
    sessions.push(this);
  }

  fail(message) {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
  }

  query(sql) {
    assert.equal(this.pending, null, "one query per physical session");
    return new Promise((resolve, reject) => {
      const marker = `done_${randomUUID()}`;
      const timer = setTimeout(() => this.fail("query watchdog exceeded 15 seconds"), 15_000);
      this.pending = { marker, timer, resolve, reject, lines: [] };
      this.child.stdin.write(`${sql}\n\\echo ${marker} :ERROR :SQLSTATE :LAST_ERROR_MESSAGE\n`);
    });
  }

  async ok(sql) {
    const result = await this.query(sql);
    assert.equal(result.failed, "false", `SQL failed: ${result.sqlstate} ${result.message}`);
    return result.lines;
  }

  async json(sql) {
    return JSON.parse((await this.ok(sql)).at(-1));
  }

  async initialize() {
    await this.ok(
      "SET statement_timeout='12s'; SET lock_timeout='10s'; SET idle_in_transaction_session_timeout='20s';",
    );
    this.pid = Number((await this.ok("SELECT pg_backend_pid();"))[0]);
    assert.ok(Number.isInteger(this.pid));
  }

  async close() {
    if (this.closing) return this.closed;
    this.closing = true;
    this.child.stdin.end("\\q\n");
    await Promise.race([this.closed, delay(3000)]);
    if (this.child.exitCode === null) this.child.kill();
    this.fail("connection closed during cleanup");
  }
}

const baselineSql = `SELECT json_build_object(
  'users',(SELECT count(*) FROM auth.users),
  'profiles',(SELECT count(*) FROM public.profiles),
  'client_profiles',(SELECT count(*) FROM public.client_profiles),
  'roles',(SELECT count(*) FROM public.user_roles),
  'operators',(SELECT count(*) FROM public.operators),
  'point_wallets',(SELECT count(*) FROM public.operator_point_wallets),
  'point_transactions',(SELECT count(*) FROM public.operator_point_transactions),
  'characters',(SELECT count(*) FROM public.characters),
  'tags',(SELECT count(*) FROM public.media_tags),
  'assets',(SELECT count(*) FROM public.character_media_assets),
  'reservations',(SELECT count(*) FROM public.character_media_reservations),
  'conversations',(SELECT count(*) FROM public.conversations),
  'messages',(SELECT count(*) FROM public.messages),
  'attachments',(SELECT count(*) FROM public.message_attachments),
  'collections',(SELECT count(*) FROM public.sticker_collections),
  'stickers',(SELECT count(*) FROM public.stickers),
  'message_stickers',(SELECT count(*) FROM public.message_stickers),
  'credit_wallets',(SELECT count(*) FROM public.credit_wallets),
  'credit_transactions',(SELECT count(*) FROM public.credit_transactions),
  'purchases',(SELECT count(*) FROM public.gift_attachment_purchases),
  'reward_events',(SELECT count(*) FROM private.gift_reward_events),
  'allocations',(SELECT count(*) FROM private.gift_reward_allocations),
  'analytics',(SELECT count(*) FROM public.analytics_events),
  'notifications',(SELECT count(*) FROM public.notifications),
  'audit',(SELECT count(*) FROM public.audit_logs),
  'migrations',(SELECT json_agg(version ORDER BY version) FROM supabase_migrations.schema_migrations),
  'settings',(SELECT jsonb_object_agg(key,value) FROM public.system_settings));`;

async function setup(observer) {
  await observer.ok(`\\set ON_ERROR_STOP on
    BEGIN;
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES
      (${quote(ids.client)},'authenticated','authenticated',${quote(`${run}_client@example.invalid`)},'x',now(),'{}','{}',now(),now()),
      (${quote(ids.operatorUser1)},'authenticated','authenticated',${quote(`${run}_op1@example.invalid`)},'x',now(),'{}','{}',now(),now()),
      (${quote(ids.operatorUser2)},'authenticated','authenticated',${quote(`${run}_op2@example.invalid`)},'x',now(),'{}','{}',now(),now());
    INSERT INTO public.user_roles(user_id,role) VALUES (${quote(ids.operatorUser1)},'operator'),(${quote(ids.operatorUser2)},'operator');
    INSERT INTO public.operators(id,user_id,full_name,is_active,presence_status,last_seen_at)
    VALUES (${quote(ids.operator1)},${quote(ids.operatorUser1)},${quote(`${run} operator 1`)},true,'online',clock_timestamp()),
      (${quote(ids.operator2)},${quote(ids.operatorUser2)},${quote(`${run} operator 2`)},true,'online',clock_timestamp());
    INSERT INTO public.characters(id,name) VALUES (${quote(ids.character)},${quote(run)});
    INSERT INTO public.media_tags(id,character_id,name,is_default) VALUES (${quote(ids.tag)},${quote(ids.character)},'Gift media',true);
    INSERT INTO public.character_media_assets(id,character_id,media_tag_id,source_path,preview_path,content_type,status,ingest_status,display_name,preview_generated_at)
    VALUES (${quote(ids.asset)},${quote(ids.character)},${quote(ids.tag)},${quote(`assets/${run}/source.webp`)},
      ${quote(`assets/${run}/preview.webp`)},'image/webp','sent','ready','Gift image',clock_timestamp());
    INSERT INTO public.conversations(id,client_id,character_id,assigned_operator_id)
    VALUES (${quote(ids.conversation)},${quote(ids.client)},${quote(ids.character)},${quote(ids.operator1)});
    INSERT INTO public.character_media_reservations(id,media_asset_id,conversation_id,client_id,operator_id,reserved_by_user_id,previous_asset_status,state,expires_at,ended_at)
    VALUES (${quote(ids.reservation)},${quote(ids.asset)},${quote(ids.conversation)},${quote(ids.client)},${quote(ids.operator1)},
      ${quote(ids.operatorUser1)},'available','consumed',clock_timestamp()+interval '5 minutes',clock_timestamp());
    INSERT INTO public.sticker_collections(id,slug,name,is_active) VALUES (${quote(ids.collection)},${quote(run)},'AC22 Gifts',true);
    INSERT INTO public.stickers(id,collection_id,slug,name,object_path,width,height,byte_size,ingest_status,price_credits,is_active,is_gift,processed_at)
    VALUES (${quote(ids.gift)},${quote(ids.collection)},'ac22-gift','AC22 Gift',
      ${quote(`collections/${ids.collection}/stickers/${ids.gift}/render.webp`)},64,64,1024,'ready',100,true,true,clock_timestamp());
    INSERT INTO public.messages(id,conversation_id,sender_type,sender_id,operator_id,content)
    VALUES (${quote(ids.sourceMessage)},${quote(ids.conversation)},'operator',${quote(ids.operatorUser1)},${quote(ids.operator1)},'[image]');
    INSERT INTO public.message_attachments(id,message_id,media_asset_id,reservation_id,kind,access_mode,view_mode,
      price_credits_snapshot,required_gift_id,required_gift_name_snapshot,required_gift_price_credits_snapshot)
    VALUES (${quote(ids.attachment)},${quote(ids.sourceMessage)},${quote(ids.asset)},${quote(ids.reservation)},
      'image','standard','paid_open',100,${quote(ids.gift)},'AC22 Gift',100);
    INSERT INTO public.credit_wallets(user_id,balance,lifetime_earned)
    VALUES (${quote(ids.client)},200,200);
    COMMIT;
    \\set ON_ERROR_STOP off`);
}

async function authenticate(session) {
  await session.ok(`BEGIN; SET LOCAL ROLE authenticated;
    SET LOCAL "request.jwt.claim.role"='authenticated';
    SET LOCAL "request.jwt.claim.sub"=${quote(ids.client)};`);
  assert.deepEqual(
    await session.json("SELECT json_build_object('role',current_user,'uid',auth.uid());"),
    { role: "authenticated", uid: ids.client },
  );
}

const purchaseSql = (key) =>
  `SELECT public.purchase_attachment_gift(${quote(ids.attachment)},${quote(ids.gift)},${quote(key)});`;

async function waitForBlockedPurchase(observer, first, second) {
  let activity;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    activity = await observer.json(`SELECT json_build_object('wait',wait_event_type,
      'blocked_by_first',${first.pid}=ANY(pg_blocking_pids(pid)))
      FROM pg_stat_activity WHERE pid=${second.pid};`);
    if (activity?.wait === "Lock" && activity.blocked_by_first) return;
    await delay(25);
  }
  assert.fail(
    `second purchase did not wait on first PostgreSQL transaction: ${JSON.stringify(activity)}`,
  );
}

async function assertPurchase(observer, key, expectedCount) {
  const state = await observer.json(`SELECT json_build_object(
    'purchases',(SELECT count(*) FROM public.gift_attachment_purchases WHERE client_id=${quote(ids.client)} AND idempotency_key=${quote(key)}),
    'receipt',(SELECT json_build_object('id',id,'status',status,'price',price_credits_snapshot,
      'charge',charged_transaction_id,'message',gift_message_id) FROM public.gift_attachment_purchases
      WHERE client_id=${quote(ids.client)} AND idempotency_key=${quote(key)}),
    'events',(SELECT count(*) FROM private.gift_reward_events event JOIN public.gift_attachment_purchases purchase ON purchase.id=event.purchase_id
      WHERE purchase.client_id=${quote(ids.client)} AND purchase.idempotency_key=${quote(key)}),
    'pool',(SELECT json_build_object('id',event.id,'status',event.status,'eligible',event.eligible_operator_count,
      'total',event.reward_pool_points,'distributed',event.distributed_points,'unallocated',event.unallocated_points)
      FROM private.gift_reward_events event JOIN public.gift_attachment_purchases purchase ON purchase.id=event.purchase_id
      WHERE purchase.client_id=${quote(ids.client)} AND purchase.idempotency_key=${quote(key)}),
    'charges',(SELECT count(*) FROM public.credit_transactions ledger JOIN public.gift_attachment_purchases purchase
      ON purchase.charged_transaction_id=ledger.id WHERE purchase.client_id=${quote(ids.client)} AND purchase.idempotency_key=${quote(key)}
      AND ledger.amount=-100 AND ledger.type='sticker_spend' AND ledger.reason='attachment_gift_purchase'
      AND ledger.message_attachment_id=${quote(ids.attachment)} AND ledger.message_id=purchase.gift_message_id),
    'allocations',(SELECT COALESCE(json_agg(json_build_object('operator',allocation.operator_id,'amount',allocation.amount,
      'transaction',allocation.point_transaction_id) ORDER BY allocation.operator_id),'[]'::json)
      FROM private.gift_reward_allocations allocation JOIN private.gift_reward_events event ON event.id=allocation.gift_reward_event_id
      JOIN public.gift_attachment_purchases purchase ON purchase.id=event.purchase_id
      WHERE purchase.client_id=${quote(ids.client)} AND purchase.idempotency_key=${quote(key)}),
    'point_transactions',(SELECT COALESCE(json_agg(json_build_object('id',transaction.id,'operator',transaction.operator_id,
      'amount',transaction.amount) ORDER BY transaction.operator_id),'[]'::json)
      FROM public.operator_point_transactions transaction JOIN private.gift_reward_events event ON event.id=transaction.gift_reward_event_id
      JOIN public.gift_attachment_purchases purchase ON purchase.id=event.purchase_id
      WHERE purchase.client_id=${quote(ids.client)} AND purchase.idempotency_key=${quote(key)}));`);
  assert.equal(state.purchases, 1);
  assert.equal(state.events, 1);
  assert.equal(state.charges, 1);
  assert.equal(state.receipt.status, "purchased");
  assert.equal(state.receipt.price, 100);
  assert.ok(state.receipt.charge && state.receipt.message);
  assert.equal(state.pool.status, "distributed");
  assert.equal(Number(state.pool.total), 10);
  assert.equal(state.pool.eligible, expectedCount);
  assert.equal(state.allocations.length, expectedCount);
  assert.equal(state.point_transactions.length, expectedCount);
  assert.equal(Number(state.pool.distributed) + Number(state.pool.unallocated), 10);
  assert.equal(
    state.allocations.reduce((sum, row) => sum + Number(row.amount), 0),
    Number(state.pool.distributed),
  );
  assert.equal(
    state.point_transactions.reduce((sum, row) => sum + Number(row.amount), 0),
    Number(state.pool.distributed),
  );
  for (const allocation of state.allocations) {
    assert.deepEqual(
      state.point_transactions.filter((transaction) => transaction.id === allocation.transaction),
      [{ id: allocation.transaction, operator: allocation.operator, amount: allocation.amount }],
    );
  }
  if (expectedCount === 2) {
    assert.equal(Number(state.pool.unallocated), 0);
    assert.deepEqual(
      state.allocations.map(({ operator, amount }) => [operator, Number(amount)]),
      [ids.operator1, ids.operator2].sort().map((operator) => [operator, 5]),
    );
  } else {
    assert.equal(Number(state.pool.distributed), 0);
    assert.equal(Number(state.pool.unallocated), 10);
  }
  return state;
}

async function assertLedgerTotals(observer, purchaseCount, balance, spent, pointBalance) {
  assert.deepEqual(
    await observer.json(`SELECT json_build_object(
    'purchases',(SELECT count(*) FROM public.gift_attachment_purchases WHERE client_id=${quote(ids.client)} AND attachment_id=${quote(ids.attachment)}),
    'debits',(SELECT count(*) FROM public.credit_transactions WHERE user_id=${quote(ids.client)}
      AND message_attachment_id=${quote(ids.attachment)} AND reason='attachment_gift_purchase'),
    'debit_total',(SELECT COALESCE(sum(amount),0) FROM public.credit_transactions WHERE user_id=${quote(ids.client)}
      AND message_attachment_id=${quote(ids.attachment)} AND reason='attachment_gift_purchase'),
    'balance',(SELECT balance FROM public.credit_wallets WHERE user_id=${quote(ids.client)}),
    'spent',(SELECT lifetime_spent FROM public.credit_wallets WHERE user_id=${quote(ids.client)}),
    'point_wallets',(SELECT COALESCE(json_agg(json_build_object('operator',operator_id,'balance',balance)
      ORDER BY operator_id),'[]'::json) FROM public.operator_point_wallets WHERE operator_id IN (${operators})));`),
    {
      purchases: purchaseCount,
      debits: purchaseCount,
      debit_total: -100 * purchaseCount,
      balance,
      spent,
      point_wallets: [ids.operator1, ids.operator2]
        .sort()
        .map((operator) => ({ operator, balance: pointBalance })),
    },
  );
}

async function cleanup(observer) {
  await observer.ok(`\\set ON_ERROR_STOP on
    BEGIN;
    DELETE FROM public.notifications WHERE conversation_id=${quote(ids.conversation)} OR user_id IN (${users});
    DELETE FROM public.analytics_events WHERE conversation_id=${quote(ids.conversation)} OR actor_user_id IN (${users});
    DELETE FROM public.audit_logs WHERE actor_user_id IN (${users})
      OR entity_id IN (${quote(ids.conversation)},${quote(ids.asset)},${quote(ids.attachment)});
    DELETE FROM private.gift_reward_allocations WHERE gift_reward_event_id IN
      (SELECT event.id FROM private.gift_reward_events event JOIN public.gift_attachment_purchases purchase ON purchase.id=event.purchase_id
       WHERE purchase.client_id=${quote(ids.client)} AND purchase.attachment_id=${quote(ids.attachment)});
    DELETE FROM public.operator_point_transactions WHERE gift_reward_event_id IN
      (SELECT event.id FROM private.gift_reward_events event JOIN public.gift_attachment_purchases purchase ON purchase.id=event.purchase_id
       WHERE purchase.client_id=${quote(ids.client)} AND purchase.attachment_id=${quote(ids.attachment)});
    DELETE FROM private.gift_reward_events WHERE purchase_id IN
      (SELECT id FROM public.gift_attachment_purchases WHERE client_id=${quote(ids.client)} AND attachment_id=${quote(ids.attachment)});
    DELETE FROM public.message_stickers WHERE message_id IN
      (SELECT gift_message_id FROM public.gift_attachment_purchases WHERE client_id=${quote(ids.client)} AND attachment_id=${quote(ids.attachment)});
    DELETE FROM public.gift_attachment_purchases WHERE client_id=${quote(ids.client)} AND attachment_id=${quote(ids.attachment)};
    DELETE FROM public.credit_transactions WHERE user_id=${quote(ids.client)}
      AND message_attachment_id=${quote(ids.attachment)} AND reason='attachment_gift_purchase';
    DELETE FROM public.message_attachments WHERE id=${quote(ids.attachment)};
    DELETE FROM public.message_stickers WHERE message_id IN (SELECT id FROM public.messages WHERE conversation_id=${quote(ids.conversation)});
    DELETE FROM public.conversation_handling_cycles WHERE conversation_id=${quote(ids.conversation)};
    DELETE FROM public.conversation_work_items WHERE conversation_id=${quote(ids.conversation)};
    DELETE FROM public.messages WHERE conversation_id=${quote(ids.conversation)};
    DELETE FROM public.character_media_reservations WHERE id=${quote(ids.reservation)};
    DELETE FROM public.conversations WHERE id=${quote(ids.conversation)};
    DELETE FROM public.character_media_assets WHERE id=${quote(ids.asset)};
    DELETE FROM public.media_tags WHERE id=${quote(ids.tag)};
    DELETE FROM public.stickers WHERE id=${quote(ids.gift)};
    DELETE FROM public.sticker_collections WHERE id=${quote(ids.collection)};
    DELETE FROM public.characters WHERE id=${quote(ids.character)};
    DELETE FROM public.operator_point_wallets WHERE operator_id IN (${operators});
    DELETE FROM public.operators WHERE id IN (${operators});
    DELETE FROM public.credit_wallets WHERE user_id=${quote(ids.client)};
    DELETE FROM public.user_roles WHERE user_id IN (${users});
    DELETE FROM public.client_profiles WHERE user_id IN (${users});
    DELETE FROM public.profiles WHERE user_id IN (${users});
    DELETE FROM auth.users WHERE id IN (${users});
    COMMIT;
    \\set ON_ERROR_STOP off`);
}

let observer;
let first;
let second;
let baseline;
let setupCommitted = false;
let pendingSecond;
try {
  observer = new Session("observer");
  first = new Session("first");
  second = new Session("second");
  await Promise.all([observer.initialize(), first.initialize(), second.initialize()]);
  assert.equal(
    new Set([observer.pid, first.pid, second.pid]).size,
    3,
    "distinct PostgreSQL backends",
  );
  baseline = await observer.json(baselineSql);
  assertConcurrencyMigrationVersions(baseline.migrations);
  await setup(observer);
  setupCommitted = true;
  await authenticate(first);
  await authenticate(second);
  const firstReceipt = await first.json(purchaseSql(ids.purchaseKey));
  assert.equal(firstReceipt.already_purchased, false);
  pendingSecond = second.query(purchaseSql(ids.purchaseKey));
  pendingSecond.catch(() => {});
  await waitForBlockedPurchase(observer, first, second);
  await first.ok("COMMIT;");
  const secondResult = await pendingSecond;
  if (secondResult.failed === "false") {
    const secondReceipt = JSON.parse(secondResult.lines.at(-1));
    assert.equal(secondReceipt.purchase_id, firstReceipt.purchase_id);
    assert.equal(secondReceipt.already_purchased, true);
    await second.ok("COMMIT;");
  } else {
    // The current RPC can see no purchase before waiting on the attachment, then hit the unique key.
    assert.equal(
      secondResult.sqlstate,
      "23505",
      `unexpected losing RPC failure: ${secondResult.message}`,
    );
    assert.match(secondResult.message, /gift_attachment_purchases_client_id_idempotency_key_key/);
    await second.ok("ROLLBACK;");
  }
  await authenticate(second);
  const replay = await second.json(purchaseSql(ids.purchaseKey));
  assert.equal(replay.purchase_id, firstReceipt.purchase_id);
  assert.equal(replay.already_purchased, true);
  await second.ok("COMMIT;");
  const distributed = await assertPurchase(observer, ids.purchaseKey, 2);
  assert.equal(distributed.receipt.id, firstReceipt.purchase_id);
  await assertLedgerTotals(observer, 1, 100, 100, 5);

  await observer.ok(
    `UPDATE public.operators SET presence_status='offline' WHERE id IN (${operators});`,
  );
  await authenticate(first);
  const emptyReceipt = await first.json(purchaseSql(ids.emptyKey));
  assert.equal(emptyReceipt.already_purchased, false);
  await first.ok("COMMIT;");
  const empty = await assertPurchase(observer, ids.emptyKey, 0);
  assert.equal(empty.receipt.id, emptyReceipt.purchase_id);
  await observer.ok(
    `UPDATE public.operators SET presence_status='online',last_seen_at=clock_timestamp() WHERE id IN (${operators});`,
  );
  assert.deepEqual(
    await assertPurchase(observer, ids.emptyKey, 0),
    empty,
    "later presence does not allocate an empty purchase retroactively",
  );
  assert.deepEqual(
    await assertPurchase(observer, ids.purchaseKey, 2),
    distributed,
    "the later purchase does not mutate the concurrent purchase pool",
  );
  await assertLedgerTotals(observer, 2, 0, 200, 5);
  console.log(
    "PASS: blocked same-key Gift purchase has one debit/pool and one Point transaction per eligible operator; replay and zero-eligible snapshot conserve Points.",
  );
} catch (error) {
  console.error(
    `FAIL: ${error instanceof Error ? error.message : "unknown AC22 concurrency failure"}`,
  );
  process.exitCode = 1;
} finally {
  await Promise.allSettled([first?.ok("ROLLBACK;"), second?.ok("ROLLBACK;")].filter(Boolean));
  await Promise.allSettled([first?.close(), second?.close()].filter(Boolean));
  if (pendingSecond) await pendingSecond.catch(() => {});
  if (observer && setupCommitted) {
    try {
      await cleanup(observer);
      assert.deepEqual(
        await observer.json(baselineSql),
        baseline,
        "fixture cleanup restores the baseline",
      );
      assert.equal(
        await observer.json(`SELECT to_json(count(*)) FROM pg_stat_activity
        WHERE application_name LIKE ${quote(`${run}_%`)} AND pid<>pg_backend_pid();`),
        0,
      );
      console.log("Postflight: fixture rows, settings, migrations and actor sessions restored.");
    } catch (error) {
      console.error(
        `Cleanup verification FAILED: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      process.exitCode = 1;
    }
  }
  if (observer) await observer.close();
}
