import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const container = "supabase_db_qmgkmsarzfjnqltljkjl";
const run = `v4_3_claim_${randomUUID().replaceAll("-", "")}`;
const sessions = [];
const quote = (value) => `'${value.replaceAll("'", "''")}'`;

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
        } else if (line) this.pending.lines.push(line);
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
    assert.equal(result.failed, "false", `SQL step failed: ${result.sqlstate}`);
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
  'migrations', (SELECT json_agg(version ORDER BY version) FROM supabase_migrations.schema_migrations),
  'settings', (SELECT jsonb_object_agg(key,value) FROM public.system_settings),
  'users', (SELECT count(*) FROM auth.users),
  'profiles', (SELECT count(*) FROM public.profiles),
  'operators', (SELECT count(*) FROM public.operators),
  'characters', (SELECT count(*) FROM public.characters),
  'assignments', (SELECT count(*) FROM public.character_operator_assignments),
  'conversations', (SELECT count(*) FROM public.conversations),
  'messages', (SELECT count(*) FROM public.messages),
  'work_items', (SELECT count(*) FROM public.conversation_work_items),
  'cycles', (SELECT count(*) FROM public.conversation_handling_cycles),
  'wallets', (SELECT count(*) FROM public.credit_wallets),
  'ledger', (SELECT count(*) FROM public.credit_transactions),
  'notifications', (SELECT count(*) FROM public.notifications),
  'analytics', (SELECT count(*) FROM public.analytics_events),
  'audit', (SELECT count(*) FROM public.audit_logs),
  'storage', (SELECT count(*) FROM storage.objects)
);`;

async function authenticate(session, user) {
  await session.ok(`BEGIN; SET LOCAL ROLE authenticated;
    SET LOCAL "request.jwt.claim.role"='authenticated';
    SET LOCAL "request.jwt.claim.sub"=${quote(user)};`);
  const identity = await session.json(
    "SELECT json_build_object('role',current_user,'uid',auth.uid());",
  );
  assert.deepEqual(identity, { role: "authenticated", uid: user });
}

async function scenario(observer, label, reversed) {
  const ids = Object.fromEntries(
    [
      "client",
      "user1",
      "user2",
      "operator1",
      "operator2",
      "character",
      "conversation",
      "message",
      "item",
    ].map((key) => [key, randomUUID()]),
  );
  const userIds = [ids.client, ids.user1, ids.user2].map(quote).join(",");
  const a = new Session(`${label}_a`);
  const b = new Session(`${label}_b`);
  let setupCommitted = false;
  let pendingB;
  try {
    await a.initialize();
    await b.initialize();
    assert.notEqual(a.pid, b.pid, "claims use distinct backend PIDs");
    assert.notEqual(a.pid, observer.pid);
    assert.notEqual(b.pid, observer.pid);
    await observer.ok(`BEGIN;
      INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      SELECT id,'authenticated','authenticated',email,now(),'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now()
      FROM (VALUES (${quote(ids.client)}::uuid,${quote(`${run}_${label}_client@example.invalid`)}),
        (${quote(ids.user1)}::uuid,${quote(`${run}_${label}_op1@example.invalid`)}),
        (${quote(ids.user2)}::uuid,${quote(`${run}_${label}_op2@example.invalid`)})) AS fixture(id,email);
      INSERT INTO public.user_roles(user_id,role) VALUES (${quote(ids.user1)},'operator'),(${quote(ids.user2)},'operator') ON CONFLICT DO NOTHING;
      INSERT INTO public.operators(id,user_id,full_name,is_active,availability_status,presence_status,last_seen_at)
      VALUES (${quote(ids.operator1)},${quote(ids.user1)},${quote(`${run}_op1`)},true,'available','online',now()),
        (${quote(ids.operator2)},${quote(ids.user2)},${quote(`${run}_op2`)},true,'available','online',now());
      INSERT INTO public.characters(id,name,is_active,is_visible,availability_status) VALUES (${quote(ids.character)},${quote(run)},true,true,'available');
      INSERT INTO public.character_operator_assignments(character_id,operator_id) VALUES (${quote(ids.character)},${quote(ids.operator1)}),(${quote(ids.character)},${quote(ids.operator2)});
      INSERT INTO public.conversations(id,client_id,character_id,status) VALUES (${quote(ids.conversation)},${quote(ids.client)},${quote(ids.character)},'open');
      INSERT INTO public.conversation_work_items(id,conversation_id,client_id,character_id,status,last_activity_at)
      VALUES (${quote(ids.item)},${quote(ids.conversation)},${quote(ids.client)},${quote(ids.character)},'new',now());
      INSERT INTO public.messages(id,conversation_id,sender_type,sender_id,content)
      VALUES (${quote(ids.message)},${quote(ids.conversation)},'client',${quote(ids.client)},'Synthetic concurrency test');
      COMMIT;`);
    setupCommitted = true;
    const ledgerBefore = await observer.json(
      "SELECT to_json(count(*)) FROM public.credit_transactions;",
    );
    const winner = reversed ? ids.operator2 : ids.operator1;
    await authenticate(a, reversed ? ids.user2 : ids.user1);
    await authenticate(b, reversed ? ids.user1 : ids.user2);
    for (const actor of [a, b]) {
      const visible = await actor.json(
        `SELECT to_json(count(*)) FROM public.get_operator_new_queue() WHERE work_item_id=${quote(ids.item)};`,
      );
      assert.equal(visible, 1, "both operators can see the same NEW item");
    }
    const first = await a.json(`SELECT public.claim_new_conversation(${quote(ids.item)});`);
    assert.equal(first.claimed, true);
    assert.equal(first.already_claimed, false);
    pendingB = b.query(`SELECT public.claim_new_conversation(${quote(ids.item)});`);
    pendingB.catch(() => {});
    let blocked;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      blocked = await observer.json(
        `SELECT json_build_object('wait',wait_event_type,'blocked_by_a',${a.pid}=ANY(pg_blocking_pids(pid))) FROM pg_stat_activity WHERE pid=${b.pid};`,
      );
      if (blocked?.wait === "Lock" && blocked.blocked_by_a) break;
      await delay(25);
    }
    assert.equal(blocked?.wait, "Lock", "B has a real PostgreSQL lock wait");
    assert.equal(blocked.blocked_by_a, true, "pg_blocking_pids identifies A as B's blocker");
    console.log(`${label}: A pid=${a.pid}; B pid=${b.pid}; B wait=Lock; blocking PID=${a.pid}`);
    await a.ok("COMMIT;");
    const loser = await pendingB;
    assert.equal(loser.failed, "true");
    assert.equal(loser.sqlstate, "P0001");
    assert.equal(loser.message, "conversation_already_claimed");
    assert.equal(loser.lines.length, 0, "loser returned no successful claim result");
    await b.ok("ROLLBACK;");
    await authenticate(a, reversed ? ids.user2 : ids.user1);
    const retry = await a.json(`SELECT public.claim_new_conversation(${quote(ids.item)});`);
    assert.equal(retry.claimed, true);
    assert.equal(retry.already_claimed, true);
    assert.equal(retry.work_item_id, first.work_item_id);
    await a.ok("COMMIT;");
    const state = await observer.json(`SELECT json_build_object(
      'items',(SELECT count(*) FROM public.conversation_work_items WHERE conversation_id=${quote(ids.conversation)}),
      'responsible',(SELECT responsible_operator_id FROM public.conversation_work_items WHERE id=${quote(ids.item)}),
      'assigned',(SELECT assigned_operator_id FROM public.conversations WHERE id=${quote(ids.conversation)}),
      'cycles',(SELECT count(*) FROM public.conversation_handling_cycles WHERE conversation_id=${quote(ids.conversation)}),
      'active_cycles',(SELECT count(*) FROM public.conversation_handling_cycles WHERE work_item_id=${quote(ids.item)} AND ended_at IS NULL),
      'cycle_owner',(SELECT operator_id FROM public.conversation_handling_cycles WHERE work_item_id=${quote(ids.item)} AND ended_at IS NULL));`);
    assert.deepEqual(state, {
      items: 1,
      responsible: winner,
      assigned: winner,
      cycles: 1,
      active_cycles: 1,
      cycle_owner: winner,
    });
    assert.equal(
      await observer.json("SELECT to_json(count(*)) FROM public.credit_transactions;"),
      ledgerBefore,
      "claims and retry have no ledger effects",
    );
    console.log(
      `${label}: winner=operator${reversed ? 2 : 1}; loser=conversation_already_claimed; retry=already_claimed; items=1; cycles=1; ledger delta=0`,
    );
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
    if (pendingB) await pendingB.catch(() => {});
    await observer.ok("ROLLBACK;");
    // Terminate only this harness's exact named sessions, including a timed-out transaction.
    await observer.ok(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name IN (${quote(a.name)},${quote(b.name)}) AND pid<>pg_backend_pid();`,
    );
    if (setupCommitted) {
      await observer.ok(`BEGIN;
        DELETE FROM public.analytics_events WHERE conversation_id=${quote(ids.conversation)}
          OR actor_user_id IN (${userIds}) OR metadata->>'work_item_id'=${quote(ids.item)}
          OR metadata->>'message_id'=${quote(ids.message)};
        DELETE FROM public.notifications WHERE conversation_id=${quote(ids.conversation)}
          OR metadata->>'character_id'=${quote(ids.character)};
        DELETE FROM public.conversation_handling_cycles WHERE conversation_id=${quote(ids.conversation)};
        DELETE FROM public.conversation_work_items WHERE conversation_id=${quote(ids.conversation)};
        DELETE FROM public.messages WHERE conversation_id=${quote(ids.conversation)};
        DELETE FROM public.conversations WHERE id=${quote(ids.conversation)};
        DELETE FROM public.character_operator_assignments WHERE character_id=${quote(ids.character)};
        DELETE FROM public.characters WHERE id=${quote(ids.character)};
        DELETE FROM public.operators WHERE id IN (${quote(ids.operator1)},${quote(ids.operator2)});
        DELETE FROM public.credit_wallets WHERE user_id IN (${userIds});
        DELETE FROM public.user_roles WHERE user_id IN (${userIds});
        DELETE FROM public.profiles WHERE user_id IN (${userIds});
        DELETE FROM auth.users WHERE id IN (${userIds});
        COMMIT;`);
    }
  }
}

let observer;
let baseline;
async function verifyBaseline() {
  const current = await observer.json(baselineSql);
  for (const key of Object.keys(baseline)) {
    assert.deepEqual(current[key], baseline[key], `baseline mismatch: ${key}`);
  }
}
try {
  const info = JSON.parse(docker(["inspect", container]))[0];
  assert.equal(info.Name, `/${container}`);
  assert.equal(info.State.Running, true);
  assert.equal(info.State.Health.Status, "healthy");
  assert.ok(info.NetworkSettings.Ports["5432/tcp"].some((port) => port.HostPort === "60422"));
  const api = JSON.parse(docker(["inspect", "supabase_kong_qmgkmsarzfjnqltljkjl"]))[0];
  assert.equal(api.State.Running, true);
  assert.ok(api.NetworkSettings.Ports["8000/tcp"].some((port) => port.HostPort === "60421"));
  observer = new Session("observer");
  await observer.initialize();
  await observer.ok("\\set ON_ERROR_STOP on\nSELECT 1;");
  baseline = await observer.json(baselineSql);
  assert.equal(baseline.migrations.length, 109);
  assert.equal(baseline.migrations.at(-1), "20260926232222");
  console.log(
    `Baseline counts: ${JSON.stringify(Object.fromEntries(Object.entries(baseline).filter(([key]) => !["migrations", "settings"].includes(key))))}`,
  );
  console.log("Local stack verified: API 60421, DB 60422, migrations 109/latest 20260926232222.");
  await scenario(observer, "forward", false);
  await verifyBaseline();
  await scenario(observer, "reverse", true);
  await verifyBaseline();
  console.log(
    "PASS: both contention orders, identity checks, ownership invariants, winner retry, and baseline restoration.",
  );
} catch (error) {
  console.error(
    `FAIL: ${error instanceof assert.AssertionError ? error.message.split("\n")[0] : "local concurrency harness failed; inspect the bounded test steps"}`,
  );
  process.exitCode = 1;
} finally {
  if (observer && baseline) {
    try {
      await observer.ok("ROLLBACK;");
      await verifyBaseline();
      const remaining = await observer.json(
        `SELECT to_json(count(*)) FROM pg_stat_activity WHERE application_name LIKE ${quote(`${run}_%`)} AND pid<>pg_backend_pid();`,
      );
      assert.equal(remaining, 0);
      console.log(
        "Postflight: baseline/settings/migrations unchanged; no remaining actor sessions or their locks.",
      );
    } catch {
      console.error(
        "Cleanup verification FAILED; inspect only this run's fixture namespace before retrying.",
      );
      process.exitCode = 1;
    }
  }
  await Promise.allSettled(sessions.map((session) => session.close()));
}
