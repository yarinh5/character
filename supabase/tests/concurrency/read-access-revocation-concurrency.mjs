import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveConcurrencyBinding } from "./local-target.mjs";
import {
  assertFrozenReadAccessTarget,
  discoverReadAccessTarget,
} from "../upgrades/wp01-read-access-117-to-118.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const binding = resolveConcurrencyBinding();
const runId = `wp01_read_revoke_${randomUUID().replaceAll("-", "")}`;
const q = (value) => `'${String(value).replaceAll("'", "''")}'`;
let frozenTarget;
const failureMetadata = new WeakMap();

function reportable(error, metadata) {
  if (error instanceof Error) failureMetadata.set(error, Object.freeze({ ...metadata }));
  return error;
}

export function reportReadAccessConcurrencyFailure(error) {
  const metadata = error instanceof Error ? (failureMetadata.get(error) ?? {}) : {};
  const seen = new Set();
  const failures = [];
  const visit = (candidate, relation = "cause") => {
    if (!(candidate instanceof Error) || seen.has(candidate) || failures.length >= 16) return;
    seen.add(candidate);
    const item = failureMetadata.get(candidate) ?? {};
    failures.push({
      relation: /^(primary|cleanup|cause)$/.test(relation) ? relation : "cause",
      category:
        typeof item.category === "string" && /^[a-z_]{1,48}$/.test(item.category)
          ? item.category
          : "unknown_failure",
      stage:
        typeof item.stage === "string" && /^[a-z_]{1,48}$/.test(item.stage)
          ? item.stage
          : "orchestration",
    });
    if (candidate instanceof AggregateError) {
      candidate.errors.forEach((nested, index) =>
        visit(nested, index === 0 ? "primary" : "cleanup"),
      );
    }
    visit(candidate.cause, "cause");
  };
  visit(error);
  return JSON.stringify({
    category:
      typeof metadata.category === "string" && /^[a-z_]{1,48}$/.test(metadata.category)
        ? metadata.category
        : "unknown_failure",
    stage:
      typeof metadata.stage === "string" && /^[a-z_]{1,48}$/.test(metadata.stage)
        ? metadata.stage
        : "orchestration",
    failures,
    guidance: "Inspect only the frozen WP01.5 target; do not clean up after identity drift.",
  });
}

function asError(value) {
  return value instanceof Error ? value : new Error("non_error_failure");
}

export async function runOperationWithCleanup({ operation, cleanup }) {
  let result;
  let primaryFailure = null;
  let cleanupFailure = null;
  try {
    result = await operation();
  } catch (error) {
    primaryFailure = asError(error);
    if (!failureMetadata.has(primaryFailure)) {
      reportable(primaryFailure, { category: "primary_failure", stage: "execution" });
    }
  }
  try {
    await cleanup();
  } catch (error) {
    cleanupFailure = asError(error);
    if (!failureMetadata.has(cleanupFailure)) {
      reportable(cleanupFailure, { category: "cleanup_failure", stage: "cleanup" });
    }
  }
  if (primaryFailure && cleanupFailure) {
    throw reportable(new AggregateError([primaryFailure, cleanupFailure]), {
      category: "primary_and_cleanup_failure",
      stage: "cleanup",
    });
  }
  if (cleanupFailure) throw cleanupFailure;
  if (primaryFailure) throw primaryFailure;
  return result;
}

function assertTarget() {
  assert.ok(frozenTarget, "target must be frozen before orchestration");
  return assertFrozenReadAccessTarget(frozenTarget, discoverReadAccessTarget(binding));
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fixtureUuid(fixture, key) {
  const value = fixture?.[key];
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

function uuidSqlList(values) {
  const unique = [...new Set(values.filter(Boolean))];
  return unique.length > 0 ? unique.map(q).join(",") : "NULL";
}

export function buildOwnedFixtureCleanupSql(fixture) {
  const client = fixtureUuid(fixture, "client");
  const user = fixtureUuid(fixture, "user");
  const operator = fixtureUuid(fixture, "operator");
  const character = fixtureUuid(fixture, "character");
  const conversation = fixtureUuid(fixture, "conversation");
  const userIds = uuidSqlList([client, user]);
  const operatorIds = uuidSqlList([operator]);
  const characterIds = uuidSqlList([character]);
  const conversationIds = uuidSqlList([conversation]);
  const entityIds = uuidSqlList([client, user, operator, character, conversation]);
  return `BEGIN;
CREATE TEMP TABLE wp01_owned_profiles ON COMMIT DROP AS
  SELECT id,user_id FROM public.profiles WHERE user_id IN (${userIds});
CREATE TEMP TABLE wp01_owned_analytics ON COMMIT DROP AS
  SELECT id FROM public.analytics_events
  WHERE actor_user_id IN (${userIds})
     OR operator_id IN (${operatorIds})
     OR character_id IN (${characterIds})
     OR conversation_id IN (${conversationIds})
     OR metadata->>'profile_id' IN (SELECT id::text FROM wp01_owned_profiles);
CREATE TEMP TABLE wp01_owned_notifications ON COMMIT DROP AS
  SELECT id FROM public.notifications
  WHERE user_id IN (${userIds})
     OR conversation_id IN (${conversationIds})
     OR metadata->>'character_id' IN (${characterIds})
     OR metadata->>'operator_id' IN (${operatorIds});
CREATE TEMP TABLE wp01_owned_audit ON COMMIT DROP AS
  SELECT id FROM public.audit_logs
  WHERE actor_user_id IN (${userIds}) OR entity_id IN (${entityIds});
DELETE FROM public.analytics_events WHERE id IN (SELECT id FROM wp01_owned_analytics);
DELETE FROM public.notifications WHERE id IN (SELECT id FROM wp01_owned_notifications);
DELETE FROM public.audit_logs WHERE id IN (SELECT id FROM wp01_owned_audit);
DELETE FROM private.handling_send_authority_evidence WHERE conversation_id IN (${conversationIds});
DELETE FROM private.conversation_sticker_rate_limits WHERE conversation_id IN (${conversationIds}) OR actor_user_id IN (${userIds});
DELETE FROM private.sticker_send_attempts WHERE conversation_id IN (${conversationIds}) OR actor_user_id IN (${userIds});
DELETE FROM public.user_active_conversations WHERE conversation_id IN (${conversationIds}) OR user_id IN (${userIds});
DELETE FROM public.conversation_presence_states WHERE conversation_id IN (${conversationIds}) OR user_id IN (${userIds});
DELETE FROM public.conversation_read_states WHERE conversation_id IN (${conversationIds}) OR user_id IN (${userIds});
DELETE FROM public.conversation_locks WHERE conversation_id IN (${conversationIds}) OR locked_by_user_id IN (${userIds});
DELETE FROM public.internal_notes WHERE conversation_id IN (${conversationIds}) OR operator_id IN (${operatorIds});
DELETE FROM public.customer_info_entries WHERE conversation_id IN (${conversationIds}) OR client_id IN (${userIds}) OR operator_id IN (${operatorIds});
DELETE FROM public.operator_point_transactions WHERE operator_id IN (${operatorIds});
DELETE FROM public.operator_score_events WHERE conversation_id IN (${conversationIds}) OR operator_id IN (${operatorIds});
DELETE FROM public.operator_monthly_scores WHERE operator_id IN (${operatorIds});
DELETE FROM public.message_stickers WHERE message_id IN (SELECT id FROM public.messages WHERE conversation_id IN (${conversationIds}));
DELETE FROM public.message_attachments WHERE message_id IN (SELECT id FROM public.messages WHERE conversation_id IN (${conversationIds}));
DELETE FROM public.messages WHERE conversation_id IN (${conversationIds});
DELETE FROM public.conversation_handling_cycles WHERE conversation_id IN (${conversationIds});
DELETE FROM public.conversation_work_items WHERE conversation_id IN (${conversationIds});
DELETE FROM public.character_operator_assignments WHERE character_id IN (${characterIds}) OR operator_id IN (${operatorIds});
DELETE FROM public.conversations WHERE id IN (${conversationIds});
DELETE FROM public.user_conversation_access_versions WHERE user_id IN (${userIds});
DELETE FROM public.characters WHERE id IN (${characterIds});
DELETE FROM public.operator_point_wallets WHERE operator_id IN (${operatorIds});
DELETE FROM public.operators WHERE id IN (${operatorIds}) OR user_id IN (${userIds});
DELETE FROM public.user_roles WHERE user_id IN (${userIds});
DELETE FROM public.profiles WHERE id IN (SELECT id FROM wp01_owned_profiles) OR user_id IN (${userIds});
DELETE FROM auth.users WHERE id IN (${userIds});
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.analytics_events WHERE id IN (SELECT id FROM wp01_owned_analytics))
     OR EXISTS (SELECT 1 FROM public.notifications WHERE id IN (SELECT id FROM wp01_owned_notifications))
     OR EXISTS (SELECT 1 FROM public.audit_logs WHERE id IN (SELECT id FROM wp01_owned_audit))
     OR EXISTS (SELECT 1 FROM auth.users WHERE id IN (${userIds}))
     OR EXISTS (SELECT 1 FROM public.profiles WHERE user_id IN (${userIds}))
     OR EXISTS (SELECT 1 FROM public.operators WHERE id IN (${operatorIds}) OR user_id IN (${userIds}))
     OR EXISTS (SELECT 1 FROM public.characters WHERE id IN (${characterIds}))
     OR EXISTS (SELECT 1 FROM public.conversations WHERE id IN (${conversationIds}))
     OR EXISTS (SELECT 1 FROM public.messages WHERE conversation_id IN (${conversationIds}))
     OR EXISTS (SELECT 1 FROM public.conversation_handling_cycles WHERE conversation_id IN (${conversationIds}))
  THEN RAISE EXCEPTION 'fixture_cleanup_residue';
  END IF;
END $$;
COMMIT;`;
}

export function assertFixtureGraphRestored(actual, baseline) {
  assert.deepEqual(actual, baseline, "fixture graph was not restored to its frozen baseline");
}

export async function runVerifiedConcurrencyMutation({ frozen, discover, mutate }) {
  assertFrozenReadAccessTarget(frozen, await discover());
  const result = await mutate();
  assertFrozenReadAccessTarget(frozen, await discover());
  return result;
}

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    input: options.input,
  });
}
function json(sql) {
  assertTarget();
  return JSON.parse(
    docker(
      [
        "exec",
        "-i",
        frozenTarget.db.id,
        "psql",
        "-X",
        "-qAt",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      { input: sql },
    )
      .trim()
      .split(/\r?\n/)
      .at(-1),
  );
}
class Session {
  constructor(label) {
    assertTarget();
    this.label = label;
    this.buffer = "";
    this.pending = null;
    this.child = spawn(
      "docker",
      [
        "exec",
        "-i",
        "-e",
        `PGAPPNAME=${runId}_${label}`,
        frozenTarget.db.id,
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
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!this.pending) continue;
        if (line.startsWith(`${this.pending.marker} `)) {
          const pending = this.pending;
          this.pending = null;
          clearTimeout(pending.timer);
          const [, failed, sqlstate, ...message] = line.split(" ");
          pending.resolve({ failed, sqlstate, message: message.join(" "), lines: pending.lines });
        } else if (line) this.pending.lines.push(line);
      }
    });
  }
  query(sql) {
    assert.equal(this.pending, null);
    assertTarget();
    return new Promise((resolve, reject) => {
      const marker = `done_${randomUUID()}`;
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`${this.label} timeout`));
      }, 15_000);
      this.pending = { marker, timer, resolve, reject, lines: [] };
      this.child.stdin.write(`${sql}\n\\echo ${marker} :ERROR :SQLSTATE :LAST_ERROR_MESSAGE\n`);
    });
  }
  async ok(sql) {
    const result = await this.query(sql);
    assert.equal(result.failed, "false", `${this.label}: ${result.sqlstate} ${result.message}`);
    return result;
  }
  async close() {
    this.child.stdin.end("\\q\n");
    await Promise.race([new Promise((resolve) => this.child.once("close", resolve)), delay(2000)]);
    if (this.child.exitCode === null) this.child.kill();
  }
}

function fixtureSql(ids) {
  return `BEGIN;
  INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES
    (${q(ids.client)},'authenticated','authenticated',${q(`${runId}_client@example.invalid`)},now(),'{}','{}',now(),now()),
    (${q(ids.user)},'authenticated','authenticated',${q(`${runId}_operator@example.invalid`)},now(),'{}','{}',now(),now());
  INSERT INTO public.user_roles(user_id,role) VALUES (${q(ids.user)},'operator');
  INSERT INTO public.operators(id,user_id,full_name,is_active,availability_status,presence_status,last_seen_at) VALUES (${q(ids.operator)},${q(ids.user)},${q(runId)},true,'available','online',clock_timestamp());
  INSERT INTO public.characters(id,name,is_active,is_visible,availability_status) VALUES (${q(ids.character)},${q(runId)},true,true,'available');
  INSERT INTO public.character_operator_assignments(character_id,operator_id) VALUES (${q(ids.character)},${q(ids.operator)});
  INSERT INTO public.conversations(id,client_id,character_id,status) VALUES (${q(ids.conversation)},${q(ids.client)},${q(ids.character)},'open');
  INSERT INTO public.messages(id,conversation_id,sender_type,sender_id,content) VALUES (${q(ids.clientMessage)},${q(ids.conversation)},'client',${q(ids.client)},'synthetic client request');
  COMMIT;`;
}
function ids() {
  return Object.fromEntries(
    ["client", "user", "operator", "character", "conversation", "clientMessage"].map((key) => [
      key,
      randomUUID(),
    ]),
  );
}

function mutateDatabase(input) {
  assertTarget();
  const result = docker(
    [
      "exec",
      "-i",
      frozenTarget.db.id,
      "psql",
      "-X",
      "-q",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input },
  );
  assertTarget();
  return result;
}

function cleanupFixture(fixture) {
  mutateDatabase(buildOwnedFixtureCleanupSql(fixture));
}

function fixtureGraphSnapshot() {
  return json(`SELECT json_build_object(
    'users',(SELECT count(*) FROM auth.users),
    'sessions',(SELECT count(*) FROM auth.sessions),
    'profiles',(SELECT count(*) FROM public.profiles),
    'roles',(SELECT count(*) FROM public.user_roles),
    'operators',(SELECT count(*) FROM public.operators),
    'characters',(SELECT count(*) FROM public.characters),
    'assignments',(SELECT count(*) FROM public.character_operator_assignments),
    'conversations',(SELECT count(*) FROM public.conversations),
    'messages',(SELECT count(*) FROM public.messages),
    'notes',(SELECT count(*) FROM public.internal_notes),
    'customer_info',(SELECT count(*) FROM public.customer_info_entries),
    'read_states',(SELECT count(*) FROM public.conversation_read_states),
    'locks',(SELECT count(*) FROM public.conversation_locks),
    'active_conversations',(SELECT count(*) FROM public.user_active_conversations),
    'presence',(SELECT count(*) FROM public.conversation_presence_states),
    'work_items',(SELECT count(*) FROM public.conversation_work_items),
    'cycles',(SELECT count(*) FROM public.conversation_handling_cycles),
    'authority_evidence',(SELECT count(*) FROM private.handling_send_authority_evidence),
    'access_versions',(SELECT count(*) FROM public.user_conversation_access_versions),
    'notifications',(SELECT count(*) FROM public.notifications),
    'analytics',(SELECT count(*) FROM public.analytics_events),
    'audit',(SELECT count(*) FROM public.audit_logs),
    'score_events',(SELECT count(*) FROM public.operator_score_events),
    'point_transactions',(SELECT count(*) FROM public.operator_point_transactions),
    'point_wallets',(SELECT count(*) FROM public.operator_point_wallets),
    'monthly_scores',(SELECT count(*) FROM public.operator_monthly_scores),
    'attachments',(SELECT count(*) FROM public.message_attachments),
    'message_stickers',(SELECT count(*) FROM public.message_stickers),
    'media_assets',(SELECT count(*) FROM public.character_media_assets),
    'media_reservations',(SELECT count(*) FROM public.character_media_reservations),
    'storage_objects',(SELECT count(*) FROM storage.objects),
    'waiting_locks',(SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock')
  );`);
}

function sentinelIds() {
  return {
    character: randomUUID(),
    notification: randomUUID(),
    analytics: randomUUID(),
    notificationUser: randomUUID(),
  };
}

function seedSentinelSql(sentinel) {
  return `BEGIN;
INSERT INTO public.characters(id,name,is_active,is_visible,availability_status)
VALUES (${q(sentinel.character)},${q(`${runId}_cleanup_sentinel`)},true,true,'available');
INSERT INTO public.notifications(id,user_id,type,title,metadata)
VALUES (${q(sentinel.notification)},${q(sentinel.notificationUser)},'system','WP01 cleanup sentinel',jsonb_build_object('character_id',${q(sentinel.character)}));
INSERT INTO public.analytics_events(id,event_name,character_id,metadata)
VALUES (${q(sentinel.analytics)},'wp01_cleanup_sentinel',${q(sentinel.character)},jsonb_build_object('sentinel',true));
COMMIT;`;
}

function cleanupSentinelSql(sentinel) {
  return `BEGIN;
DELETE FROM public.analytics_events WHERE id=${q(sentinel.analytics)};
DELETE FROM public.notifications WHERE id=${q(sentinel.notification)};
DELETE FROM public.characters WHERE id=${q(sentinel.character)};
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.analytics_events WHERE id=${q(sentinel.analytics)})
     OR EXISTS (SELECT 1 FROM public.notifications WHERE id=${q(sentinel.notification)})
     OR EXISTS (SELECT 1 FROM public.characters WHERE id=${q(sentinel.character)})
  THEN RAISE EXCEPTION 'sentinel_cleanup_residue';
  END IF;
END $$;
COMMIT;`;
}

function assertSentinelPresent(sentinel) {
  assert.deepEqual(
    json(`SELECT json_build_object(
      'character',(SELECT count(*) FROM public.characters WHERE id=${q(sentinel.character)}),
      'notification',(SELECT count(*) FROM public.notifications WHERE id=${q(sentinel.notification)}),
      'analytics',(SELECT count(*) FROM public.analytics_events WHERE id=${q(sentinel.analytics)})
    );`),
    { character: 1, notification: 1, analytics: 1 },
    "unrelated cleanup sentinel was modified",
  );
}

async function closeSessionsAndCleanup(sessions, fixture) {
  const failures = [];
  for (const session of sessions) {
    try {
      await session.close();
    } catch (error) {
      failures.push(asError(error));
    }
  }
  try {
    cleanupFixture(fixture);
  } catch (error) {
    failures.push(asError(error));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures);
}

async function runFixtureScenario(operation, { seedOwned = false } = {}) {
  const fixture = ids();
  const sessions = [];
  const openSession = (label) => {
    const session = new Session(label);
    sessions.push(session);
    return session;
  };
  return runOperationWithCleanup({
    operation: async () => {
      if (seedOwned) seedOwnedFixture(fixture);
      else mutateDatabase(fixtureSql(fixture));
      return operation(fixture, openSession);
    },
    cleanup: () => closeSessionsAndCleanup(sessions, fixture),
  });
}

async function waitBlocked(pid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = json(
      `SELECT json_build_object('wait',wait_event_type,'blockers',pg_blocking_pids(pid)) FROM pg_stat_activity WHERE pid=${pid};`,
    );
    if (state?.wait === "Lock" && state.blockers.length > 0) return state;
    await delay(25);
  }
  assert.fail("expected PostgreSQL lock wait was not observed");
}

async function scenarioRevokeWins() {
  return runFixtureScenario(async (fixture, openSession) => {
    const revoke = openSession("revoke_first");
    const send = openSession("send_second");
    await revoke.ok(
      `BEGIN; DELETE FROM public.character_operator_assignments WHERE character_id=${q(fixture.character)} AND operator_id=${q(fixture.operator)}; SELECT pg_backend_pid();`,
    );
    const sendPid = Number((await send.ok("SELECT pg_backend_pid();")).lines.at(-1));
    const pending = send.query(
      `BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims='{"sub":"${fixture.user}","role":"authenticated"}'; SELECT public.send_operator_message(${q(fixture.conversation)},'must not commit',NULL);`,
    );
    await waitBlocked(sendPid);
    await revoke.ok("COMMIT;");
    const result = await pending;
    assert.equal(result.failed, "true");
    assert.match(result.message, /operator_not_assigned_to_character/);
    await send.ok("ROLLBACK;");
    const after = json(
      `SELECT json_build_object('messages',(SELECT count(*) FROM public.messages WHERE conversation_id=${q(fixture.conversation)}),'cycles',(SELECT count(*) FROM public.conversation_handling_cycles WHERE conversation_id=${q(fixture.conversation)}),'allowed',private.can_user_read_conversation(${q(fixture.conversation)},${q(fixture.user)}));`,
    );
    assert.deepEqual(after, { messages: 1, cycles: 0, allowed: false });
  });
}

async function scenarioSendWins() {
  return runFixtureScenario(async (fixture, openSession) => {
    const send = openSession("send_first");
    const revoke = openSession("revoke_second");
    await send.ok(
      `BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims='{"sub":"${fixture.user}","role":"authenticated"}';`,
    );
    await send.ok(
      `SELECT public.send_operator_message(${q(fixture.conversation)},'authorized before revoke',NULL);`,
    );
    const revokePid = Number((await revoke.ok("SELECT pg_backend_pid();")).lines.at(-1));
    const pending = revoke.query(
      `BEGIN; DELETE FROM public.character_operator_assignments WHERE character_id=${q(fixture.character)} AND operator_id=${q(fixture.operator)}; COMMIT;`,
    );
    await waitBlocked(revokePid);
    await send.ok("COMMIT;");
    const result = await pending;
    assert.equal(result.failed, "false");
    const after = json(
      `SELECT json_build_object('messages',(SELECT count(*) FROM public.messages WHERE conversation_id=${q(fixture.conversation)} AND content='authorized before revoke'),'allowed',private.can_user_read_conversation(${q(fixture.conversation)},${q(fixture.user)}));`,
    );
    assert.deepEqual(after, { messages: 1, allowed: false });
  });
}

const contentMutations = [
  {
    label: "note",
    sql: (fixture) =>
      `SELECT public.add_operator_internal_note(${q(fixture.conversation)},${q(`${runId}_note`)});`,
    count: (fixture) =>
      `(SELECT count(*) FROM public.internal_notes WHERE conversation_id=${q(fixture.conversation)} AND note=${q(`${runId}_note`)})`,
  },
  {
    label: "crm",
    sql: (fixture) =>
      `SELECT public.add_operator_customer_info(${q(fixture.conversation)},${q(`${runId}_crm`)});`,
    count: (fixture) =>
      `(SELECT count(*) FROM public.customer_info_entries WHERE conversation_id=${q(fixture.conversation)} AND content=${q(`${runId}_crm`)})`,
  },
  {
    label: "status",
    sql: (fixture) =>
      `SELECT public.update_operator_conversation_status(${q(fixture.conversation)},'waiting');`,
    count: (fixture) =>
      `(SELECT count(*) FROM public.conversations WHERE id=${q(fixture.conversation)} AND status='waiting')`,
  },
];

function seedOwnedFixture(fixture) {
  mutateDatabase(fixtureSql(fixture));
  mutateDatabase(
    `BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims='{"sub":"${fixture.user}","role":"authenticated"}'; SELECT public.send_operator_message(${q(fixture.conversation)},'claim',NULL); COMMIT;`,
  );
}

async function scenarioContentMutationRevokeRace(operation, revokeFirst) {
  return runFixtureScenario(
    async (fixture, openSession) => {
      const mutation = openSession(
        `${operation.label}_${revokeFirst ? "revoke_first" : "write_first"}`,
      );
      const revoke = openSession(`${operation.label}_${revokeFirst ? "revoke" : "revoke_second"}`);
      if (revokeFirst) {
        await revoke.ok(
          `BEGIN; DELETE FROM public.character_operator_assignments WHERE character_id=${q(fixture.character)} AND operator_id=${q(fixture.operator)};`,
        );
        const mutationPid = Number((await mutation.ok("SELECT pg_backend_pid();")).lines.at(-1));
        const pending = mutation.query(
          `BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims='{"sub":"${fixture.user}","role":"authenticated"}'; ${operation.sql(fixture)}`,
        );
        await waitBlocked(mutationPid);
        await revoke.ok("COMMIT;");
        const result = await pending;
        assert.equal(result.failed, "true");
        assert.match(result.message, /conversation_write_forbidden/);
        await mutation.ok("ROLLBACK;");
        assert.equal(Number(json(`SELECT ${operation.count(fixture)};`)), 0);
      } else {
        await mutation.ok(
          `BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims='{"sub":"${fixture.user}","role":"authenticated"}'; ${operation.sql(fixture)}`,
        );
        const revokePid = Number((await revoke.ok("SELECT pg_backend_pid();")).lines.at(-1));
        const pending = revoke.query(
          `BEGIN; DELETE FROM public.character_operator_assignments WHERE character_id=${q(fixture.character)} AND operator_id=${q(fixture.operator)}; COMMIT;`,
        );
        await waitBlocked(revokePid);
        await mutation.ok("COMMIT;");
        const result = await pending;
        assert.equal(result.failed, "false");
        assert.equal(Number(json(`SELECT ${operation.count(fixture)};`)), 1);
      }
    },
    { seedOwned: true },
  );
}

async function scenarioAuthorityRevokeVsSend(kind, revokeFirst) {
  return runFixtureScenario(async (fixture, openSession) => {
    const send = openSession(`${kind}_${revokeFirst ? "revoke_first" : "send_first"}`);
    const revoke = openSession(`${kind}_revoke`);
    const revokeSql =
      kind === "role"
        ? `DELETE FROM public.user_roles WHERE user_id=${q(fixture.user)} AND role='operator';`
        : `UPDATE public.operators SET is_active=false WHERE id=${q(fixture.operator)};`;
    if (revokeFirst) {
      await revoke.ok(`BEGIN; ${revokeSql}`);
      const sendPid = Number((await send.ok("SELECT pg_backend_pid();")).lines.at(-1));
      const pending = send.query(
        `BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims='{"sub":"${fixture.user}","role":"authenticated"}'; SELECT public.send_operator_message(${q(fixture.conversation)},'must fail',NULL);`,
      );
      await waitBlocked(sendPid);
      await revoke.ok("COMMIT;");
      const result = await pending;
      assert.equal(result.failed, "true");
      assert.match(result.message, /operator_record_required/);
      await send.ok("ROLLBACK;");
      assert.equal(
        Number(
          json(
            `SELECT count(*) FROM public.messages WHERE conversation_id=${q(fixture.conversation)};`,
          ),
        ),
        1,
      );
    } else {
      await send.ok(
        `BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims='{"sub":"${fixture.user}","role":"authenticated"}'; SELECT public.send_operator_message(${q(fixture.conversation)},'commits first',NULL);`,
      );
      const revokePid = Number((await revoke.ok("SELECT pg_backend_pid();")).lines.at(-1));
      const pending = revoke.query(`BEGIN; ${revokeSql} COMMIT;`);
      await waitBlocked(revokePid);
      await send.ok("COMMIT;");
      assert.equal((await pending).failed, "false");
      assert.equal(
        Number(
          json(
            `SELECT count(*) FROM public.messages WHERE conversation_id=${q(fixture.conversation)} AND content='commits first';`,
          ),
        ),
        1,
      );
    }
  });
}

export async function runReadAccessConcurrency() {
  frozenTarget = discoverReadAccessTarget(binding);
  const originalBaseline = fixtureGraphSnapshot();
  const sentinel = sentinelIds();
  await runOperationWithCleanup({
    operation: async () => {
      mutateDatabase(seedSentinelSql(sentinel));
      const baselineWithSentinel = fixtureGraphSnapshot();
      assertSentinelPresent(sentinel);
      const runAndVerifyCleanup = async (operation) => {
        await operation();
        assertFixtureGraphRestored(fixtureGraphSnapshot(), baselineWithSentinel);
        assertSentinelPresent(sentinel);
      };
      await runAndVerifyCleanup(scenarioRevokeWins);
      await runAndVerifyCleanup(scenarioSendWins);
      for (const operation of contentMutations) {
        await runAndVerifyCleanup(() => scenarioContentMutationRevokeRace(operation, true));
        await runAndVerifyCleanup(() => scenarioContentMutationRevokeRace(operation, false));
      }
      for (const kind of ["role", "activity"]) {
        await runAndVerifyCleanup(() => scenarioAuthorityRevokeVsSend(kind, true));
        await runAndVerifyCleanup(() => scenarioAuthorityRevokeVsSend(kind, false));
      }
      assertFixtureGraphRestored(fixtureGraphSnapshot(), baselineWithSentinel);
      assertSentinelPresent(sentinel);
    },
    cleanup: async () => {
      mutateDatabase(cleanupSentinelSql(sentinel));
      assertFixtureGraphRestored(fixtureGraphSnapshot(), originalBaseline);
    },
  });
  console.log(
    "WP01.5 revocation concurrency passed: send/notes/CRM/status serialize; fixture graph restored; unrelated sentinel preserved and removed by ownership",
  );
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  runReadAccessConcurrency().catch((error) => {
    const failure =
      error instanceof Error
        ? reportable(error, { category: "concurrency_failure", stage: "execution" })
        : error;
    console.error(reportReadAccessConcurrencyFailure(failure));
    process.exitCode = 1;
  });
}
