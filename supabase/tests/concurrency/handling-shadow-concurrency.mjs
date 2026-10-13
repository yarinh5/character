import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const container = "supabase_db_qmgkmsarzfjnqltljkjl";
const run = `wp01_handling_${randomUUID().replaceAll("-", "")}`;
const sessions = [];
const fixtures = [];
let backfillRunId = null;
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

function docker(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

class Session {
  constructor(label) {
    this.name = `${run}_${label}`;
    this.buffer = "";
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
        } else if (line) {
          this.pending.lines.push(line);
        }
      }
    });
    this.child.stderr.on("data", (chunk) => {
      if (this.pending) this.pending.error += chunk;
    });
    this.closed = new Promise((resolve) => this.child.once("close", resolve));
    this.child.on("error", () => this.fail("local psql process failed"));
    this.child.on("close", () => this.fail("local psql connection closed unexpectedly"));
    sessions.push(this);
  }

  fail(message) {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(new Error(message));
    this.pending = null;
  }

  query(sql) {
    assert.equal(this.pending, null, "only one query per physical session");
    return new Promise((resolve, reject) => {
      const marker = `done_${randomUUID()}`;
      const timer = setTimeout(() => this.fail("query watchdog exceeded 15 seconds"), 15000);
      this.pending = { marker, timer, resolve, reject, lines: [], error: "" };
      this.child.stdin.write(`${sql}\n\\echo ${marker} :ERROR :SQLSTATE :LAST_ERROR_MESSAGE\n`);
    });
  }

  async ok(sql) {
    const result = await this.query(sql);
    assert.equal(
      result.failed,
      "false",
      `SQL step failed: ${result.sqlstate} ${result.message} ${result.error}`,
    );
    return result.lines;
  }

  async json(sql) {
    const lines = await this.ok(sql);
    return JSON.parse(lines.at(-1));
  }

  async initialize() {
    await this.ok(
      "SET statement_timeout='10s'; SET lock_timeout='8s'; SET idle_in_transaction_session_timeout='20s';",
    );
    this.pid = Number((await this.ok("SELECT pg_backend_pid();"))[0]);
    assert.ok(Number.isInteger(this.pid));
  }

  async beginAs(userId) {
    await this.ok(`BEGIN;
      SET LOCAL ROLE authenticated;
      SELECT set_config(
        'request.jwt.claims',
        json_build_object('sub',${quote(userId)},'role','authenticated')::text,
        true
      );
      SELECT current_user, auth.uid();`);
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
  'migrations',(SELECT json_agg(version ORDER BY version) FROM supabase_migrations.schema_migrations),
  'mode',(SELECT mode FROM private.handling_contract_runtime WHERE singleton),
  'users',(SELECT count(*) FROM auth.users),
  'conversations',(SELECT count(*) FROM public.conversations),
  'messages',(SELECT count(*) FROM public.messages),
  'work_items',(SELECT count(*) FROM public.conversation_work_items),
  'cycles',(SELECT count(*) FROM public.conversation_handling_cycles),
  'wallets',(SELECT count(*) FROM public.credit_wallets),
  'ledger',(SELECT count(*) FROM public.credit_transactions),
  'scores',(SELECT count(*) FROM public.operator_score_events),
  'issues',(SELECT count(*) FROM private.handling_reconciliation_issues),
  'backfill_runs',(SELECT count(*) FROM private.handling_backfill_runs),
  'notifications',(SELECT count(*) FROM public.notifications),
  'analytics',(SELECT count(*) FROM public.analytics_events)
);`;

async function waitForBlock(observer, blockedPid, blockerPid, label) {
  const deadline = Date.now() + 5000;
  let state;
  while (Date.now() < deadline) {
    state = await observer.json(
      `SELECT json_build_object(
        'wait',wait_event_type,
        'blocked',${blockerPid}=ANY(pg_blocking_pids(pid))
      ) FROM pg_stat_activity WHERE pid=${blockedPid};`,
    );
    if (state?.wait === "Lock" && state.blocked) return;
    await delay(25);
  }
  assert.fail(
    `${label} did not produce an observed PostgreSQL lock wait: ${JSON.stringify(state)}`,
  );
}

async function seedConversation(observer, label, withCycle = true) {
  const ids = Object.fromEntries(
    ["client", "operatorUser", "operator", "character", "conversation", "item", "cycle"].map(
      (key) => [key, randomUUID()],
    ),
  );
  fixtures.push(ids);
  await observer.ok(`BEGIN;
    INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES
      (${quote(ids.client)},'authenticated','authenticated',${quote(`${run}_${label}_client@example.invalid`)},now(),'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now()),
      (${quote(ids.operatorUser)},'authenticated','authenticated',${quote(`${run}_${label}_operator@example.invalid`)},now(),'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now());
    INSERT INTO public.user_roles(user_id,role) VALUES (${quote(ids.operatorUser)},'operator');
    INSERT INTO public.operators(id,user_id,full_name,is_active,availability_status,presence_status,last_seen_at)
    VALUES (${quote(ids.operator)},${quote(ids.operatorUser)},${quote(`${run}_${label}`)},true,'available','online',now());
    INSERT INTO public.characters(id,name,is_active,is_visible,availability_status)
    VALUES (${quote(ids.character)},${quote(`${run}_${label}`)},true,true,'available');
    INSERT INTO public.character_operator_assignments(character_id,operator_id)
    VALUES (${quote(ids.character)},${quote(ids.operator)});
    INSERT INTO public.credit_wallets(user_id,balance,lifetime_earned,lifetime_spent)
    VALUES
      (${quote(ids.client)},20,20,0),
      (${quote(ids.operatorUser)},20,20,0)
    ON CONFLICT (user_id) DO UPDATE SET
      balance=EXCLUDED.balance,
      lifetime_earned=EXCLUDED.lifetime_earned,
      lifetime_spent=EXCLUDED.lifetime_spent;
    INSERT INTO public.conversations(id,client_id,character_id,assigned_operator_id,status)
    VALUES (${quote(ids.conversation)},${quote(ids.client)},${quote(ids.character)},${quote(ids.operator)},'open');
    INSERT INTO public.conversation_work_items(
      id,conversation_id,client_id,character_id,status,responsible_operator_id,assigned_at,last_activity_at
    ) VALUES (
      ${quote(ids.item)},${quote(ids.conversation)},${quote(ids.client)},${quote(ids.character)},
      'assigned',${quote(ids.operator)},now(),now()
    );
    ${
      withCycle
        ? `INSERT INTO public.conversation_handling_cycles(id,conversation_id,work_item_id,operator_id)
           VALUES (${quote(ids.cycle)},${quote(ids.conversation)},${quote(ids.item)},${quote(ids.operator)});`
        : ""
    }
    COMMIT;`);
  return ids;
}

async function messageRace(observer, label, firstActor, secondActor) {
  const ids = await seedConversation(observer, label, true);
  const first = new Session(`${label}_first`);
  const second = new Session(`${label}_second`);
  await first.initialize();
  await second.initialize();
  assert.notEqual(first.pid, second.pid);

  const rpc = (actor, suffix) =>
    actor === "client"
      ? `SELECT public.send_client_message(${quote(ids.conversation)},${quote(`${run}_${label}_client_${suffix}`)});`
      : `SELECT public.send_operator_message(${quote(ids.conversation)},${quote(`${run}_${label}_operator_${suffix}`)});`;
  const actorUser = (actor) => (actor === "client" ? ids.client : ids.operatorUser);

  await first.beginAs(actorUser(firstActor));
  await second.beginAs(actorUser(secondActor));
  const firstResult = await first.json(rpc(firstActor, "first"));
  assert.ok(firstResult.message?.id, `${label} first RPC returned a message`);
  const pendingSecond = second.query(rpc(secondActor, "second"));
  pendingSecond.catch(() => {});
  await waitForBlock(observer, second.pid, first.pid, label);
  await first.ok("COMMIT;");
  const secondResult = await pendingSecond;
  assert.equal(secondResult.failed, "false", `${label} second writer completes after lock release`);
  await second.ok("COMMIT;");

  const state = await observer.json(`SELECT json_build_object(
    'needs',(SELECT needs_handling FROM public.conversations WHERE id=${quote(ids.conversation)}),
    'pending',(SELECT pending_since IS NOT NULL FROM public.conversations WHERE id=${quote(ids.conversation)}),
    'sequences',(SELECT json_agg(handling_sequence ORDER BY handling_sequence) FROM public.messages WHERE conversation_id=${quote(ids.conversation)}),
    'effects',(SELECT json_agg(handling_effect ORDER BY handling_sequence) FROM public.messages WHERE conversation_id=${quote(ids.conversation)}),
    'distinct_sequences',(SELECT count(DISTINCT handling_sequence) FROM public.messages WHERE conversation_id=${quote(ids.conversation)}),
    'message_count',(SELECT count(*) FROM public.messages WHERE conversation_id=${quote(ids.conversation)}),
    'issues',(SELECT count(*) FROM private.handling_reconciliation_issues WHERE conversation_id=${quote(ids.conversation)})
  );`);

  assert.deepEqual(state.sequences, [1, 2]);
  assert.equal(state.distinct_sequences, 2);
  assert.equal(state.message_count, 2);
  assert.equal(state.issues, 0);
  if (firstActor === "client" && secondActor === "client") {
    assert.deepEqual(state.effects, ["client_request", "client_request"]);
    assert.equal(state.needs, true);
    assert.equal(state.pending, true);
  } else if (firstActor === "operator") {
    assert.deepEqual(state.effects, ["staff_response", "client_request"]);
    assert.equal(state.needs, true);
    assert.equal(state.pending, true);
  } else {
    assert.deepEqual(state.effects, ["client_request", "staff_response"]);
    assert.equal(state.needs, false);
    assert.equal(state.pending, false);
  }
  console.log(`${label}: order=${state.effects.join(" -> ")}; needs_handling=${state.needs}`);
}

async function barrierScenario(observer) {
  const ids = await seedConversation(observer, "barrier", false);
  const blocker = new Session("barrier_row_blocker");
  const writer = new Session("barrier_writer");
  const cutover = new Session("barrier_cutover");
  await blocker.initialize();
  await writer.initialize();
  await cutover.initialize();

  await blocker.ok("BEGIN;");
  await blocker.ok(
    `SELECT 1 FROM public.conversations WHERE id=${quote(ids.conversation)} FOR UPDATE;`,
  );
  await writer.beginAs(ids.client);
  const pendingWriter = writer.query(
    `SELECT public.send_client_message(${quote(ids.conversation)},'barrier probe');`,
  );
  pendingWriter.catch(() => {});
  await waitForBlock(observer, writer.pid, blocker.pid, "client RPC conversation row lock");

  await cutover.ok("BEGIN;");
  const pendingCutover = cutover.query("SELECT private.acquire_handling_cutover_barrier();");
  pendingCutover.catch(() => {});
  await waitForBlock(observer, cutover.pid, writer.pid, "cutover barrier");
  await blocker.ok("COMMIT;");
  const writerResult = await pendingWriter;
  assert.equal(writerResult.failed, "false");
  await writer.ok("COMMIT;");
  const cutoverResult = await pendingCutover;
  assert.equal(cutoverResult.failed, "false");
  await cutover.ok("ROLLBACK;");
  assert.equal(
    await observer.json(
      "SELECT to_json(mode) FROM private.handling_contract_runtime WHERE singleton;",
    ),
    "legacy_shadow",
  );
  console.log("barrier: exclusive cutover lock waited for active writer; mode unchanged");
}

async function backfillRace(observer) {
  const ids = await seedConversation(observer, "backfill_race", false);
  await observer.ok(`INSERT INTO public.messages(
      id,conversation_id,sender_type,sender_id,content,created_at
    ) VALUES (
      ${quote(randomUUID())},${quote(ids.conversation)},'client',${quote(ids.client)},
      'backfill historical message',clock_timestamp() - interval '1 minute'
    );
    UPDATE public.messages
    SET handling_sequence=NULL,
        handling_cycle_id=NULL,
        handling_effect=NULL,
        handling_metadata_version=NULL,
        handling_classification_reason=NULL,
        handling_classified_at=NULL
    WHERE conversation_id=${quote(ids.conversation)};
    UPDATE public.conversations
    SET needs_handling=NULL,
        pending_since=NULL,
        last_business_message_at=NULL,
        inactivity_expires_at=NULL,
        handling_next_sequence=1,
        last_handling_message_sequence=NULL,
        handling_state_initialized=false,
        handling_state_updated_at=NULL
    WHERE id=${quote(ids.conversation)};`);

  const writer = new Session("backfill_writer");
  const backfill = new Session("backfill_runner");
  await writer.initialize();
  await backfill.initialize();
  await writer.beginAs(ids.client);
  const result = await writer.json(
    `SELECT public.send_client_message(${quote(ids.conversation)},'backfill live writer');`,
  );
  assert.ok(result.message?.id);

  await backfill.ok("BEGIN;");
  const skipped = await backfill.json("SELECT private.backfill_handling_shadow_batch(1000);");
  backfillRunId = skipped.run_id;
  assert.ok(backfillRunId);
  assert.equal(skipped.remaining_count >= 1, true);
  await backfill.ok("COMMIT;");
  await writer.ok("COMMIT;");

  const state = await observer.json(`SELECT json_build_object(
    'initialized',(SELECT handling_state_initialized FROM public.conversations WHERE id=${quote(ids.conversation)}),
    'needs',(SELECT needs_handling FROM public.conversations WHERE id=${quote(ids.conversation)}),
    'message_count',(SELECT count(*) FROM public.messages WHERE conversation_id=${quote(ids.conversation)}),
    'classified',(SELECT count(*) FROM public.messages WHERE conversation_id=${quote(ids.conversation)} AND handling_sequence IS NOT NULL AND handling_effect IS NOT NULL),
    'sequences',(SELECT json_agg(handling_sequence ORDER BY handling_sequence) FROM public.messages WHERE conversation_id=${quote(ids.conversation)})
  );`);
  assert.equal(state.initialized, true);
  assert.equal(state.needs, true);
  assert.equal(state.message_count, 2);
  assert.equal(state.classified, 2);
  assert.deepEqual(state.sequences, [1, 2]);
  console.log(
    "backfill race: locked live writer preserved two classified messages and shadow state",
  );
}

async function cleanup(observer) {
  for (const ids of fixtures.reverse()) {
    await observer.ok(`BEGIN;
      DELETE FROM public.notifications WHERE conversation_id=${quote(ids.conversation)};
      DELETE FROM public.analytics_events WHERE conversation_id=${quote(ids.conversation)};
      DELETE FROM public.operator_score_events WHERE conversation_id=${quote(ids.conversation)};
      DELETE FROM public.credit_transactions WHERE user_id IN (${quote(ids.client)},${quote(ids.operatorUser)});
      DELETE FROM public.conversation_handling_cycles WHERE conversation_id=${quote(ids.conversation)};
      DELETE FROM public.conversation_work_items WHERE conversation_id=${quote(ids.conversation)};
      DELETE FROM public.messages WHERE conversation_id=${quote(ids.conversation)};
      DELETE FROM public.conversations WHERE id=${quote(ids.conversation)};
      DELETE FROM public.character_operator_assignments WHERE character_id=${quote(ids.character)};
      DELETE FROM public.notifications
      WHERE metadata->>'operator_id'=${quote(ids.operator)}
         OR metadata->>'character_id'=${quote(ids.character)}
         OR user_id IN (${quote(ids.client)},${quote(ids.operatorUser)});
      DELETE FROM public.analytics_events
      WHERE metadata->>'profile_id' IN (
        SELECT profile.id::text
        FROM public.profiles profile
        WHERE profile.user_id IN (${quote(ids.client)},${quote(ids.operatorUser)})
      )
         OR operator_id=${quote(ids.operator)}
         OR character_id=${quote(ids.character)};
      DELETE FROM public.operators WHERE id=${quote(ids.operator)};
      DELETE FROM public.characters WHERE id=${quote(ids.character)};
      DELETE FROM public.user_roles WHERE user_id=${quote(ids.operatorUser)};
      DELETE FROM public.credit_wallets WHERE user_id IN (${quote(ids.client)},${quote(ids.operatorUser)});
      DELETE FROM public.profiles WHERE user_id IN (${quote(ids.client)},${quote(ids.operatorUser)});
      DELETE FROM auth.users WHERE id IN (${quote(ids.client)},${quote(ids.operatorUser)});
      COMMIT;`);
  }
  if (backfillRunId) {
    await observer.ok(`DELETE FROM private.handling_backfill_runs
      WHERE id=${quote(backfillRunId)};`);
  }
}

const observer = new Session("observer");
let baseline;
try {
  docker(["inspect", "--format", "{{.State.Running}}", container]);
  await observer.initialize();
  baseline = await observer.json(baselineSql);
  assert.equal(baseline.mode, "legacy_shadow");
  await messageRace(observer, "client_client", "client", "client");
  await messageRace(observer, "client_first", "client", "operator");
  await messageRace(observer, "operator_first", "operator", "client");
  await barrierScenario(observer);
  await backfillRace(observer);
  console.log("WP01 handling concurrency assertions passed");
} finally {
  await Promise.allSettled(
    sessions.filter((session) => session !== observer).map((session) => session.close()),
  );
  try {
    await cleanup(observer);
    if (baseline) assert.deepEqual(await observer.json(baselineSql), baseline);
  } finally {
    await observer.close();
  }
}
