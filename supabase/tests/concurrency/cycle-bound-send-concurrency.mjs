import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const projectId = "qmgkmsarzfjnqltljkjl";
const dbContainer = `supabase_db_${projectId}`;
const apiContainer = `supabase_kong_${projectId}`;
const run = `wp01_cycle_send_${randomUUID().replaceAll("-", "")}`;
const sessions = [];
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

function docker(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function configPort(config, section) {
  const match = config.match(
    new RegExp(`\\[${section.replaceAll(".", "\\.")}\\]([\\s\\S]*?)(?=\\n\\[|$)`),
  );
  assert.ok(match, `missing [${section}] local configuration`);
  const port = match[1].match(/^\s*port\s*=\s*(\d+)\s*$/m);
  assert.ok(port, `missing [${section}].port local configuration`);
  return Number(port[1]);
}
function assertLoopbackUrl(value, expectedPort, label) {
  const url = new URL(String(value));
  assert.ok(
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname),
    `${label} must be loopback`,
  );
  assert.equal(Number(url.port), expectedPort, `${label} must match config.toml`);
}
function assertDockerPort(info, name, internalPort, expectedPort, healthy = false) {
  assert.equal(info.Name, `/${name}`);
  assert.equal(info.State?.Running, true, `${name} must be running`);
  if (healthy) assert.equal(info.State?.Health?.Status, "healthy", `${name} must be healthy`);
  assert.ok(
    (info.NetworkSettings?.Ports?.[internalPort] ?? []).some(
      (entry) => Number(entry.HostPort) === expectedPort,
    ),
    `${name} port mapping mismatch`,
  );
}
function assertLocalTarget() {
  const config = readFileSync(join(repoRoot, "supabase", "config.toml"), "utf8");
  assert.match(config, new RegExp(`project_id\\s*=\\s*"${projectId}"`));
  const apiPort = configPort(config, "api");
  const dbPort = configPort(config, "db");
  const status = JSON.parse(
    execFileSync("supabase", ["status", "--output", "json"], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    }),
  );
  assertLoopbackUrl(status.API_URL, apiPort, "local API URL");
  assertLoopbackUrl(status.DB_URL, dbPort, "local DB URL");
  const [db] = JSON.parse(docker(["inspect", dbContainer]));
  const [api] = JSON.parse(docker(["inspect", apiContainer]));
  assertDockerPort(db, dbContainer, "5432/tcp", dbPort, true);
  assertDockerPort(api, apiContainer, "8000/tcp", apiPort);
  return { apiPort, dbPort };
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
        dbContainer,
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
    assert.equal(result.failed, "false", `SQL step failed: ${result.sqlstate} ${result.message}`);
    return result.lines;
  }
  async json(sql) {
    return JSON.parse((await this.ok(sql)).at(-1));
  }
  async initialize() {
    await this.ok(
      "SET statement_timeout='10s'; SET lock_timeout='8s'; SET idle_in_transaction_session_timeout='20s';",
    );
    this.pid = Number((await this.ok("SELECT pg_backend_pid();"))[0]);
    assert.ok(Number.isInteger(this.pid));
  }
  async beginAs(userId) {
    await this.ok(
      `BEGIN; SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.role"='authenticated'; SET LOCAL "request.jwt.claim.sub"=${quote(userId)};`,
    );
    assert.deepEqual(
      await this.json("SELECT json_build_object('role',current_user,'uid',auth.uid());"),
      { role: "authenticated", uid: userId },
    );
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
  'migrations',(SELECT count(*) FROM supabase_migrations.schema_migrations),
  'latest',(SELECT max(version) FROM supabase_migrations.schema_migrations),
  'users',(SELECT count(*) FROM auth.users),
  'operators',(SELECT count(*) FROM public.operators),
  'characters',(SELECT count(*) FROM public.characters),
  'conversations',(SELECT count(*) FROM public.conversations),
  'messages',(SELECT count(*) FROM public.messages),
  'work_items',(SELECT count(*) FROM public.conversation_work_items),
  'cycles',(SELECT count(*) FROM public.conversation_handling_cycles),
  'evidence',(SELECT count(*) FROM private.handling_send_authority_evidence),
  'ledger',(SELECT count(*) FROM public.credit_transactions),
  'notifications',(SELECT count(*) FROM public.notifications),
  'analytics',(SELECT count(*) FROM public.analytics_events),
  'audit',(SELECT count(*) FROM public.audit_logs),
  'storage',(SELECT count(*) FROM storage.objects)
);`;
async function waitForLock(observer, blockedPid, blockerPid, label) {
  const deadline = Date.now() + 5000;
  let state;
  while (Date.now() < deadline) {
    state = await observer.json(
      `SELECT json_build_object('wait',wait_event_type,'blocked',${blockerPid}=ANY(pg_blocking_pids(pid))) FROM pg_stat_activity WHERE pid=${blockedPid};`,
    );
    if (state?.wait === "Lock" && state.blocked) return;
    await delay(25);
  }
  assert.fail(`${label} did not produce an observed PostgreSQL lock wait`);
}
async function scenario(observer, label, reverse) {
  const ids = Object.fromEntries(
    [
      "client",
      "userA",
      "userB",
      "operatorA",
      "operatorB",
      "character",
      "conversation",
      "clientMessage",
      "item",
    ].map((key) => [key, randomUUID()]),
  );
  const a = new Session(`${label}_a`);
  const b = new Session(`${label}_b`);
  let setupCommitted = false;
  let pendingB;
  try {
    await a.initialize();
    await b.initialize();
    assert.notEqual(a.pid, b.pid, "writers use different PostgreSQL backends");
    await observer.ok("BEGIN;");
    await observer.ok(`INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      SELECT id,'authenticated','authenticated',email,now(),'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now()
      FROM (VALUES (${quote(ids.client)}::uuid,${quote(`${run}_${label}_client@example.invalid`)}),(${quote(ids.userA)}::uuid,${quote(`${run}_${label}_a@example.invalid`)}),(${quote(ids.userB)}::uuid,${quote(`${run}_${label}_b@example.invalid`)})) AS fixture(id,email);`);
    await observer.ok(
      `INSERT INTO public.user_roles(user_id,role) VALUES (${quote(ids.userA)},'operator'),(${quote(ids.userB)},'operator');`,
    );
    await observer.ok(
      `INSERT INTO public.operators(id,user_id,full_name,is_active,availability_status,presence_status,last_seen_at) VALUES (${quote(ids.operatorA)},${quote(ids.userA)},${quote(`${run}_a`)},true,'available','online',now()),(${quote(ids.operatorB)},${quote(ids.userB)},${quote(`${run}_b`)},true,'available','online',now());`,
    );
    await observer.ok(
      `INSERT INTO public.characters(id,name,is_active,is_visible,availability_status) VALUES (${quote(ids.character)},${quote(`${run}_${label}`)},true,true,'available');`,
    );
    await observer.ok(
      `INSERT INTO public.character_operator_assignments(character_id,operator_id) VALUES (${quote(ids.character)},${quote(ids.operatorA)}),(${quote(ids.character)},${quote(ids.operatorB)});`,
    );
    await observer.ok(
      `INSERT INTO public.conversations(id,client_id,character_id,status) VALUES (${quote(ids.conversation)},${quote(ids.client)},${quote(ids.character)},'open');`,
    );
    await observer.ok(
      `INSERT INTO public.conversation_work_items(id,conversation_id,client_id,character_id,status,last_activity_at) VALUES (${quote(ids.item)},${quote(ids.conversation)},${quote(ids.client)},${quote(ids.character)},'new',now());`,
    );
    await observer.ok(
      `INSERT INTO public.messages(id,conversation_id,sender_type,sender_id,content) VALUES (${quote(ids.clientMessage)},${quote(ids.conversation)},'client',${quote(ids.client)},'cycle-bound concurrency client message');`,
    );
    await observer.ok("COMMIT;");
    setupCommitted = true;
    const seededOperators = await observer.json(
      `SELECT json_build_object('operators', (SELECT count(*) FROM public.operators WHERE id IN (${quote(ids.operatorA)},${quote(ids.operatorB)})), 'profiles', (SELECT count(*) FROM public.profiles WHERE user_id IN (${quote(ids.client)},${quote(ids.userA)},${quote(ids.userB)})));`,
    );
    assert.deepEqual(
      seededOperators,
      { operators: 2, profiles: 3 },
      "synthetic actor graph is complete before authentication",
    );
    const firstUser = reverse ? ids.userB : ids.userA;
    const secondUser = reverse ? ids.userA : ids.userB;
    const winnerOperator = reverse ? ids.operatorB : ids.operatorA;
    const ledgerBefore = await observer.json(
      "SELECT to_json(count(*)) FROM public.credit_transactions;",
    );
    await a.beginAs(firstUser);
    await b.beginAs(secondUser);
    const firstIdentity = await a.json(
      "SELECT json_build_object('uid', auth.uid(), 'operator', public.get_my_operator_id(), 'visible', (SELECT id FROM public.operators WHERE user_id = auth.uid()));",
    );
    assert.equal(
      firstIdentity.operator,
      winnerOperator,
      "first session resolves its operator identity",
    );
    assert.equal(
      (await b.json("SELECT json_build_object('operator', public.get_my_operator_id());")).operator,
      reverse ? ids.operatorA : ids.operatorB,
      "second session resolves its operator identity",
    );
    const first = await a.json(
      `SELECT public.send_operator_message(${quote(ids.conversation)},${quote(`${run}_${label}_first`)},NULL::uuid);`,
    );
    assert.ok(first.message?.id, "first atomic send returns a message");
    assert.equal(first.authority_source, "atomic_claim_and_send");
    const winnerCycleId = first.cycle_id;
    assert.match(winnerCycleId, /^[0-9a-f-]{36}$/i);
    pendingB = b.query(
      `SELECT public.send_operator_message(${quote(ids.conversation)},${quote(`${run}_${label}_second`)},NULL::uuid);`,
    );
    pendingB.catch(() => {});
    await waitForLock(observer, b.pid, a.pid, label);
    console.log(`${label}: A pid=${a.pid}; B pid=${b.pid}; B waits on A lock.`);
    await a.ok("COMMIT;");
    const loser = await pendingB;
    assert.equal(loser.failed, "true", "second atomic send must not succeed");
    assert.equal(loser.sqlstate, "P0001");
    assert.equal(loser.message, "handling_cycle_token_invalid");
    await b.ok("ROLLBACK;");
    await a.beginAs(firstUser);
    const retry = await a.json(
      `SELECT public.send_operator_message(${quote(ids.conversation)},${quote(`${run}_${label}_follow_up`)},${quote(winnerCycleId)}::uuid);`,
    );
    assert.ok(retry.message?.id, "winner can follow up with exact token");
    assert.equal(retry.cycle_id, winnerCycleId);
    await a.ok("COMMIT;");
    const state = await observer.json(
      `SELECT json_build_object('active_cycles',(SELECT count(*) FROM public.conversation_handling_cycles WHERE conversation_id=${quote(ids.conversation)} AND ended_at IS NULL),'cycle_owner',(SELECT operator_id FROM public.conversation_handling_cycles WHERE id=${quote(winnerCycleId)}::uuid),'responsible',(SELECT responsible_operator_id FROM public.conversation_work_items WHERE id=${quote(ids.item)}::uuid),'assigned',(SELECT assigned_operator_id FROM public.conversations WHERE id=${quote(ids.conversation)}::uuid),'operator_messages',(SELECT count(*) FROM public.messages WHERE conversation_id=${quote(ids.conversation)} AND sender_type='operator'),'evidence',(SELECT count(*) FROM private.handling_send_authority_evidence WHERE conversation_id=${quote(ids.conversation)}),'effects',(SELECT json_agg(handling_effect ORDER BY handling_sequence) FROM public.messages WHERE conversation_id=${quote(ids.conversation)}));`,
    );
    assert.deepEqual(state, {
      active_cycles: 1,
      cycle_owner: winnerOperator,
      responsible: winnerOperator,
      assigned: winnerOperator,
      operator_messages: 2,
      evidence: 2,
      effects: ["client_request", "staff_response", "staff_response"],
    });
    const payoutCount = await observer.json(
      `SELECT to_json(count(*)) FROM public.credit_transactions WHERE user_id IN (${quote(ids.userA)},${quote(ids.userB)}) AND type='operator_message_payout';`,
    );
    assert.equal(payoutCount, 2, "only the two authorized operator sends create payouts");
    assert.equal(
      await observer.json("SELECT to_json(count(*)) FROM public.credit_transactions;"),
      ledgerBefore + 2,
      "the rejected contender creates no extra ledger transaction",
    );
    console.log(
      `${label}: winner=${reverse ? "B" : "A"}; loser=handling_cycle_token_invalid; active_cycles=1; evidence=2; ledger delta=0.`,
    );
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
    if (pendingB) await pendingB.catch(() => {});
    await observer.ok("ROLLBACK;");
    await observer.ok(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name IN (${quote(a.name)},${quote(b.name)}) AND pid<>pg_backend_pid();`,
    );
    if (setupCommitted)
      await observer.ok(
        `BEGIN; DELETE FROM public.analytics_events WHERE conversation_id=${quote(ids.conversation)} OR actor_user_id IN (${quote(ids.client)},${quote(ids.userA)},${quote(ids.userB)}) OR operator_id IN (${quote(ids.operatorA)},${quote(ids.operatorB)}) OR character_id=${quote(ids.character)}; DELETE FROM public.notifications WHERE conversation_id=${quote(ids.conversation)} OR user_id IN (${quote(ids.client)},${quote(ids.userA)},${quote(ids.userB)}) OR metadata->>'character_id'=${quote(ids.character)}; DELETE FROM public.audit_logs WHERE entity_id=${quote(ids.conversation)} OR actor_user_id IN (${quote(ids.client)},${quote(ids.userA)},${quote(ids.userB)}); DELETE FROM public.operator_score_events WHERE operator_id IN (${quote(ids.operatorA)},${quote(ids.operatorB)}); DELETE FROM public.operator_monthly_scores WHERE operator_id IN (${quote(ids.operatorA)},${quote(ids.operatorB)}); DELETE FROM public.credit_transactions WHERE user_id IN (${quote(ids.client)},${quote(ids.userA)},${quote(ids.userB)}); DELETE FROM public.messages WHERE conversation_id=${quote(ids.conversation)}; DELETE FROM public.conversation_handling_cycles WHERE conversation_id=${quote(ids.conversation)}; DELETE FROM public.conversation_work_items WHERE conversation_id=${quote(ids.conversation)}; DELETE FROM public.conversations WHERE id=${quote(ids.conversation)}; DELETE FROM public.character_operator_assignments WHERE character_id=${quote(ids.character)}; DELETE FROM public.characters WHERE id=${quote(ids.character)}; DELETE FROM public.operators WHERE id IN (${quote(ids.operatorA)},${quote(ids.operatorB)}); DELETE FROM public.credit_wallets WHERE user_id IN (${quote(ids.client)},${quote(ids.userA)},${quote(ids.userB)}); DELETE FROM public.user_roles WHERE user_id IN (${quote(ids.userA)},${quote(ids.userB)}); DELETE FROM public.profiles WHERE user_id IN (${quote(ids.client)},${quote(ids.userA)},${quote(ids.userB)}); DELETE FROM auth.users WHERE id IN (${quote(ids.client)},${quote(ids.userA)},${quote(ids.userB)}); COMMIT;`,
      );
  }
}
let observer;
let baseline;
try {
  const target = assertLocalTarget();
  observer = new Session("observer");
  await observer.initialize();
  baseline = await observer.json(baselineSql);
  console.log(`Baseline counts: ${JSON.stringify(baseline)}`);
  assert.equal(baseline.migrations, 117);
  assert.equal(baseline.latest, "20261013113744");
  console.log(
    `Local stack verified: API ${target.apiPort}, DB ${target.dbPort}, migrations 117/latest 20261013113744.`,
  );
  await scenario(observer, "forward", false);
  const afterForward = await observer.json(baselineSql);
  console.log(`forward: post-cleanup=${JSON.stringify(afterForward)}`);
  assert.deepEqual(afterForward, baseline, "forward scenario restores baseline");
  await scenario(observer, "reverse", true);
  const afterReverse = await observer.json(baselineSql);
  console.log(`reverse: post-cleanup=${JSON.stringify(afterReverse)}`);
  assert.deepEqual(afterReverse, baseline, "reverse scenario restores baseline");
  console.log(
    "PASS: deterministic two-session atomic claim-and-send exclusivity in both actor orders.",
  );
} catch (error) {
  console.error(
    `FAIL: ${error instanceof Error ? error.message.split("\n")[0] : "local cycle-bound concurrency harness failed"}`,
  );
  process.exitCode = 1;
} finally {
  if (observer && baseline)
    try {
      await observer.ok("ROLLBACK;");
      assert.deepEqual(
        await observer.json(baselineSql),
        baseline,
        "postflight baseline restoration",
      );
      const remaining = await observer.json(
        `SELECT to_json(count(*)) FROM pg_stat_activity WHERE application_name LIKE ${quote(`${run}_%`)} AND pid<>pg_backend_pid();`,
      );
      assert.equal(remaining, 0, "no harness sessions remain");
      console.log(
        "Postflight: fixture graph, authority evidence, settings, migrations, and harness sessions restored.",
      );
    } catch {
      console.error(
        "Cleanup verification FAILED; inspect only this run's fixture namespace before retrying.",
      );
      process.exitCode = 1;
    }
  await Promise.allSettled(sessions.map((session) => session.close()));
}
