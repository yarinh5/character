import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const container = "supabase_db_qmgkmsarzfjnqltljkjl";
const run = `product_review_${randomUUID().replaceAll("-", "")}`;
const sessions = [];
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

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
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.child.on("close", (code) => {
      if (this.pending) {
        const pending = this.pending;
        this.pending = null;
        clearTimeout(pending.timer);
        pending.reject(new Error(`psql exited ${code}: ${this.stderr.slice(-2000)}`));
      }
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
    sessions.push(this);
  }

  query(sql) {
    assert.equal(this.pending, null);
    if (this.child.exitCode !== null) {
      return Promise.reject(new Error(`psql already exited ${this.child.exitCode}: ${this.stderr.slice(-2000)}`));
    }
    return new Promise((resolve, reject) => {
      const marker = `done_${randomUUID()}`;
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error("query watchdog exceeded 15 seconds"));
      }, 15_000);
      this.pending = { marker, timer, resolve, reject, lines: [] };
      this.child.stdin.write(`${sql}\n\\echo ${marker} :ERROR :SQLSTATE :LAST_ERROR_MESSAGE\n`);
    });
  }

  async ok(sql) {
    const result = await this.query(sql);
    assert.equal(result.failed, "false", `${result.sqlstate} ${result.message}`);
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
  }

  async close() {
    this.child.stdin.end("\\q\n");
    await Promise.race([this.closed, delay(2000)]);
    if (this.child.exitCode === null) this.child.kill();
  }
}

const ids = Object.fromEntries(
  [
    "client",
    "scanClientFirst",
    "scanClientSecond",
    "operatorUser",
    "adminUser",
    "operator",
    "character",
    "conversation",
    "item",
    "cycle",
    "upload",
    "supportTicket",
    "supportReplyFirst",
    "supportReplySecond",
  ].map((key) => [key, randomUUID()]),
);
const [scanConversationFirst, scanConversationSecond] = [randomUUID(), randomUUID()].sort();
Object.assign(ids, {
  scanConversationFirst,
  scanConversationSecond,
  scanItemFirst: randomUUID(),
  scanItemSecond: randomUUID(),
  scanCycleFirst: randomUUID(),
  scanCycleSecond: randomUUID(),
});

async function setup(observer) {
  await observer.ok(`\\set ON_ERROR_STOP on
    BEGIN;
    INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES
      (${quote(ids.client)},'authenticated','authenticated',${quote(`${run}_client@example.invalid`)},now(),'{}','{}',now(),now()),
      (${quote(ids.operatorUser)},'authenticated','authenticated',${quote(`${run}_operator@example.invalid`)},now(),'{}','{}',now(),now()),
      (${quote(ids.scanClientFirst)},'authenticated','authenticated',${quote(`${run}_scan_first@example.invalid`)},now(),'{}','{}',now(),now()),
      (${quote(ids.scanClientSecond)},'authenticated','authenticated',${quote(`${run}_scan_second@example.invalid`)},now(),'{}','{}',now(),now());
    INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES (${quote(ids.adminUser)},'authenticated','authenticated',${quote(`${run}_admin@example.invalid`)},now(),'{}','{}',now(),now());
    INSERT INTO public.user_roles(user_id,role) VALUES
      (${quote(ids.operatorUser)},'operator'),(${quote(ids.adminUser)},'admin');
    INSERT INTO public.operators(id,user_id,full_name,is_active,availability_status,presence_status,last_seen_at)
    VALUES (${quote(ids.operator)},${quote(ids.operatorUser)},${quote(run)},true,'available','online',now());
    INSERT INTO public.characters(id,name,is_active,is_visible,availability_status)
    VALUES (${quote(ids.character)},${quote(run)},true,true,'available');
    INSERT INTO public.character_operator_assignments(character_id,operator_id)
    VALUES (${quote(ids.character)},${quote(ids.operator)});
    INSERT INTO public.conversations(id,client_id,character_id,assigned_operator_id,status,needs_handling,inactivity_expires_at)
    VALUES (${quote(ids.conversation)},${quote(ids.client)},${quote(ids.character)},${quote(ids.operator)},'open',true,now()+interval '3 minutes');
    INSERT INTO public.conversation_work_items(id,conversation_id,client_id,character_id,status,responsible_operator_id,assigned_at,last_activity_at)
    VALUES (${quote(ids.item)},${quote(ids.conversation)},${quote(ids.client)},${quote(ids.character)},'assigned',${quote(ids.operator)},now(),now());
    INSERT INTO public.conversation_handling_cycles(id,conversation_id,work_item_id,operator_id)
    VALUES (${quote(ids.cycle)},${quote(ids.conversation)},${quote(ids.item)},${quote(ids.operator)});
    INSERT INTO public.conversations(id,client_id,character_id,assigned_operator_id,status,needs_handling,inactivity_expires_at)
    VALUES
      (${quote(ids.scanConversationFirst)},${quote(ids.scanClientFirst)},${quote(ids.character)},${quote(ids.operator)},'open',true,now()-interval '2 minutes'),
      (${quote(ids.scanConversationSecond)},${quote(ids.scanClientSecond)},${quote(ids.character)},${quote(ids.operator)},'open',true,now()-interval '1 minute');
    INSERT INTO public.conversation_work_items(id,conversation_id,client_id,character_id,status,responsible_operator_id,assigned_at,last_activity_at)
    VALUES
      (${quote(ids.scanItemFirst)},${quote(ids.scanConversationFirst)},${quote(ids.scanClientFirst)},${quote(ids.character)},'assigned',${quote(ids.operator)},now(),now()),
      (${quote(ids.scanItemSecond)},${quote(ids.scanConversationSecond)},${quote(ids.scanClientSecond)},${quote(ids.character)},'assigned',${quote(ids.operator)},now(),now());
    INSERT INTO public.conversation_handling_cycles(id,conversation_id,work_item_id,operator_id)
    VALUES
      (${quote(ids.scanCycleFirst)},${quote(ids.scanConversationFirst)},${quote(ids.scanItemFirst)},${quote(ids.operator)}),
      (${quote(ids.scanCycleSecond)},${quote(ids.scanConversationSecond)},${quote(ids.scanItemSecond)},${quote(ids.operator)});
    INSERT INTO public.credit_wallets(user_id,balance,lifetime_earned,lifetime_spent)
    VALUES (${quote(ids.client)},20,20,0);
    INSERT INTO public.client_media_uploads(id,client_id,conversation_id,source_path,preview_path,content_type,upload_expires_at)
    VALUES (${quote(ids.upload)},${quote(ids.client)},${quote(ids.conversation)},
      ${quote(`clients/${ids.client}/conversations/${ids.conversation}/uploads/${ids.upload}/source.webp`)},
      ${quote(`clients/${ids.client}/conversations/${ids.conversation}/uploads/${ids.upload}/preview.webp`)},
      'image/webp',now()-interval '1 second');
    INSERT INTO public.support_tickets(
      id,client_id,subject,category,description,idempotency_key,
      first_response_target_at,first_response_schedule_version,first_response_timezone
    ) VALUES (
      ${quote(ids.supportTicket)},${quote(ids.client)},'concurrent first response','technical',
      'two admins respond concurrently and only the first response timestamp is retained',${quote(randomUUID())},
      now()+interval '1 day',1,'UTC'
    );
    COMMIT;
    \\set ON_ERROR_STOP off`);
}

async function waitForLock(observer, session) {
  let activity = null;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    activity = await observer.json(
      `SELECT row_to_json(a) FROM (SELECT state,wait_event_type,left(query,120) AS query FROM pg_stat_activity WHERE application_name=${quote(session.name)}) a;`,
    );
    if (activity?.wait_event_type === "Lock") return;
    await delay(10);
  }
  throw new Error(`${session.name} did not reach the expected row-lock barrier: ${JSON.stringify(activity)}`);
}

async function handlingLockOrderRace(observer, admin, timeoutWorker) {
  await observer.ok(
    `UPDATE public.conversations SET inactivity_expires_at=now()+interval '3 minutes' WHERE id=${quote(ids.conversation)};`,
  );
  await admin.ok(`BEGIN;
    SELECT id FROM public.conversations WHERE id=${quote(ids.conversation)} FOR UPDATE;
    SET LOCAL ROLE authenticated;
    SET LOCAL "request.jwt.claim.role"='authenticated';
    SET LOCAL "request.jwt.claim.sub"=${quote(ids.adminUser)};`);

  const timeout = timeoutWorker.query(
    `SELECT private.finish_handling_cycle(${quote(ids.conversation)},${quote(ids.operator)},'timeout',clock_timestamp(),${quote(ids.cycle)});`,
  );
  await waitForLock(observer, timeoutWorker);
  const transfer = await admin.json(
    `SELECT public.admin_reassign_conversation(${quote(ids.conversation)},${quote(ids.operator)},'same operator lock-order regression');`,
  );
  assert.equal(transfer.already_assigned, true, "same-operator transfer remains idempotent");
  await admin.ok("COMMIT;");
  const timeoutOutcome = await timeout;
  assert.equal(
    timeoutOutcome.failed,
    "false",
    `${timeoutOutcome.sqlstate} ${timeoutOutcome.message}`,
  );
  assert.equal(
    JSON.parse(timeoutOutcome.lines.at(-1)).released,
    false,
    "timeout revalidation preserves the refreshed conversation",
  );
}

async function multiConversationScannerLockOrderRace(observer, admin, timeoutWorker) {
  const candidates = await observer.json(`SELECT COALESCE(json_agg(row_to_json(candidate)),'[]'::json) FROM (
    SELECT conversation.id,conversation.status,conversation.inactivity_expires_at,cycle.ended_at
    FROM public.conversations conversation
    JOIN public.conversation_handling_cycles cycle ON cycle.conversation_id=conversation.id
    WHERE conversation.id IN (${quote(ids.scanConversationFirst)},${quote(ids.scanConversationSecond)})
    ORDER BY conversation.id
  ) candidate;`);
  assert.equal(candidates?.length, 2, `scanner fixture candidates: ${JSON.stringify(candidates)}`);
  await admin.ok(`BEGIN;
    SELECT id FROM public.conversations WHERE id=${quote(ids.scanConversationSecond)} FOR UPDATE;
    SET LOCAL ROLE authenticated;
    SET LOCAL "request.jwt.claim.role"='authenticated';
    SET LOCAL "request.jwt.claim.sub"=${quote(ids.adminUser)};`);

  const timeoutScan = timeoutWorker.query("SELECT private.return_stale_work_items_to_new();");
  await waitForLock(observer, timeoutWorker);

  const transfer = await admin.json(
    `SELECT public.admin_reassign_conversation(${quote(ids.scanConversationSecond)},${quote(ids.operator)},'multi conversation scanner lock-order regression');`,
  );
  assert.equal(
    transfer.already_assigned,
    true,
    "same-operator Admin transfer is not blocked by a prior scan candidate",
  );
  await admin.ok("COMMIT;");

  const scanOutcome = await timeoutScan;
  assert.equal(scanOutcome.failed, "false", `${scanOutcome.sqlstate} ${scanOutcome.message}`);
  assert.ok(Number(scanOutcome.lines.at(-1)) >= 2, "the scan releases both controlled candidates");
  assert.equal(
    await observer.json(
      `SELECT to_json(count(*)) FROM public.conversation_handling_cycles WHERE id IN (${quote(ids.scanCycleFirst)},${quote(ids.scanCycleSecond)}) AND ended_at IS NOT NULL;`,
    ),
    2,
    "both controlled expired cycles are released exactly once",
  );
}

async function handlingRaces(observer, a, b) {
  await a.ok(`BEGIN; SELECT private.acquire_handling_writer_barrier();
    UPDATE public.conversations SET inactivity_expires_at=now()+interval '3 minutes' WHERE id=${quote(ids.conversation)};`);
  const afterMessage = b.query(
    `SELECT private.finish_handling_cycle(${quote(ids.conversation)},${quote(ids.operator)},'timeout',clock_timestamp(),${quote(ids.cycle)});`,
  );
  await delay(100);
  await a.ok("COMMIT;");
  assert.equal((await afterMessage).failed, "false");
  assert.equal(
    await observer.json(
      `SELECT to_json(ended_at IS NULL) FROM public.conversation_handling_cycles WHERE id=${quote(ids.cycle)};`,
    ),
    true,
    "a committed message expiry extension preserves the cycle",
  );

  await observer.ok(
    `UPDATE public.operators SET last_seen_at=now()-interval '10 minutes' WHERE id=${quote(ids.operator)};`,
  );
  await a.ok(`BEGIN; SELECT private.acquire_handling_writer_barrier();
    UPDATE public.operators SET last_seen_at=now(),presence_status='online' WHERE id=${quote(ids.operator)};`);
  const afterHeartbeat = b.query(
    `SELECT private.finish_handling_cycle(${quote(ids.conversation)},${quote(ids.operator)},'timeout',clock_timestamp(),${quote(ids.cycle)});`,
  );
  await delay(100);
  await a.ok("COMMIT;");
  assert.equal((await afterHeartbeat).failed, "false");
  assert.equal(
    await observer.json(
      `SELECT to_json(presence_status='online') FROM public.operators WHERE id=${quote(ids.operator)};`,
    ),
    true,
    "a committed heartbeat is not overwritten as offline",
  );

  await observer.ok(
    `UPDATE public.conversations SET inactivity_expires_at=now()-interval '1 second' WHERE id=${quote(ids.conversation)};`,
  );
  const first = a.query(
    `SELECT private.finish_handling_cycle(${quote(ids.conversation)},${quote(ids.operator)},'timeout',clock_timestamp(),${quote(ids.cycle)});`,
  );
  const second = b.query(
    `SELECT private.finish_handling_cycle(${quote(ids.conversation)},${quote(ids.operator)},'timeout',clock_timestamp(),${quote(ids.cycle)});`,
  );
  const outcomes = await Promise.all([first, second]);
  assert.ok(outcomes.every((outcome) => outcome.failed === "false"));
  assert.equal(
    await observer.json(
      `SELECT to_json(count(*)) FROM public.conversation_handling_cycles WHERE id=${quote(ids.cycle)} AND ended_at IS NOT NULL;`,
    ),
    1,
    "two timeout workers end one cycle once",
  );
}

async function cleanupLeaseRace(observer, a, b) {
  await a.ok(
    `BEGIN; SET LOCAL ROLE service_role; SET LOCAL "request.jwt.claim.role"='service_role';`,
  );
  const first = await a.json(
    `SELECT row_to_json(claim) FROM public.claim_expired_client_media_cleanup_for_server(25) claim WHERE upload_id=${quote(ids.upload)};`,
  );
  await a.ok("COMMIT;");
  await observer.ok(
    `UPDATE public.client_media_uploads SET cleanup_claim_expires_at=now()-interval '1 second' WHERE id=${quote(ids.upload)};`,
  );
  await b.ok(
    `BEGIN; SET LOCAL ROLE service_role; SET LOCAL "request.jwt.claim.role"='service_role';`,
  );
  const replacement = await b.json(
    `SELECT row_to_json(claim) FROM public.claim_expired_client_media_cleanup_for_server(25) claim WHERE upload_id=${quote(ids.upload)};`,
  );
  await b.ok("COMMIT;");
  assert.notEqual(first.claim_token, replacement.claim_token);

  await a.ok(
    `BEGIN; SET LOCAL ROLE service_role; SET LOCAL "request.jwt.claim.role"='service_role';`,
  );
  const staleCompletion = await a.query(
    `SELECT public.complete_client_media_cleanup_for_server(${quote(ids.upload)},${quote(first.claim_token)});`,
  );
  assert.equal(staleCompletion.failed, "true", "an interrupted worker is fenced");
  await a.ok("ROLLBACK;");
  await b.ok(`BEGIN; SET LOCAL ROLE service_role; SET LOCAL "request.jwt.claim.role"='service_role';
    SELECT public.complete_client_media_cleanup_for_server(${quote(ids.upload)},${quote(replacement.claim_token)}); COMMIT;`);
  assert.equal(
    await observer.json(
      `SELECT to_json(status) FROM public.client_media_uploads WHERE id=${quote(ids.upload)};`,
    ),
    "deleted",
  );
}

async function supportFirstResponseRace(observer, a, b) {
  const sessionSetup = `SET LOCAL ROLE authenticated;
    SET LOCAL "request.jwt.claim.role"='authenticated';
    SET LOCAL "request.jwt.claim.sub"=${quote(ids.adminUser)};`;
  await a.ok(`BEGIN; SELECT id FROM public.support_tickets WHERE id=${quote(ids.supportTicket)} FOR UPDATE; ${sessionSetup}`);
  await b.ok(`BEGIN; ${sessionSetup}`);
  const waitingResponse = b.query(
    `SELECT row_to_json(response) FROM public.admin_add_support_ticket_message(${quote(ids.supportTicket)},'second concurrent answer','client',${quote(ids.supportReplySecond)}) response; COMMIT;`,
  );
  await waitForLock(observer, b);
  const firstResponse = await a.query(
    `SELECT row_to_json(response) FROM public.admin_add_support_ticket_message(${quote(ids.supportTicket)},'first concurrent answer','client',${quote(ids.supportReplyFirst)}) response; COMMIT;`,
  );
  const outcomes = [firstResponse, await waitingResponse];
  assert.ok(outcomes.every((outcome) => outcome.failed === "false"));
  const firstCreatedAt = JSON.parse(firstResponse.lines.at(-1)).created_at;
  assert.equal(
    await observer.json(
      `SELECT to_json(count(*)) FROM public.support_ticket_messages WHERE ticket_id=${quote(ids.supportTicket)} AND visibility='client';`,
    ),
    2,
    "both distinct client-visible responses are stored",
  );
  const responseTimes = await observer.json(
      `SELECT json_build_object('first',ticket.first_human_response_at,'earliest',messages.first_created_at,'messages',messages.message_times)
       FROM public.support_tickets ticket
       CROSS JOIN LATERAL (
         SELECT min(created_at) AS first_created_at,array_agg(created_at ORDER BY created_at) AS message_times
         FROM public.support_ticket_messages
         WHERE ticket_id=ticket.id AND author_kind='admin' AND visibility='client'
       ) messages
       WHERE ticket.id=${quote(ids.supportTicket)};`,
  );
  assert.equal(responseTimes.first, firstCreatedAt,
    `first response timestamp tracks the first committed message: ${JSON.stringify(responseTimes)}`);
  assert.equal(responseTimes.first, responseTimes.earliest,
    `the row lock preserves the first response: ${JSON.stringify(responseTimes)}`);
}

async function cleanup(observer, baselineAnalytics) {
  const baselineIds = (baselineAnalytics ?? []).map(quote).join(",");
  const events = baselineAnalytics === null ? [] : await observer.json(
    `SELECT COALESCE(json_agg(json_build_object('id',id,'name',event_name)),'[]'::json)
     FROM public.analytics_events WHERE id <> ALL(ARRAY[${baselineIds}]::uuid[]);`,
  );
  const expectedEvents = new Set(["signup_completed", "conversation_started", "new_claimed", "new_timed_out"]);
  assert.ok(events.every((event) => expectedEvents.has(event.name)),
    `unexpected analytics event in fixture window: ${JSON.stringify(events)}`);
  await observer.ok(`\\set ON_ERROR_STOP on
    BEGIN;
    DELETE FROM public.analytics_events WHERE id IN (${events.map((event) => quote(event.id)).join(",") || "NULL"});
    DELETE FROM public.notifications WHERE user_id IN (${quote(ids.client)},${quote(ids.operatorUser)});
    DELETE FROM public.support_ticket_messages WHERE ticket_id=${quote(ids.supportTicket)};
    DELETE FROM public.support_tickets WHERE id=${quote(ids.supportTicket)};
    DELETE FROM public.client_media_uploads WHERE id=${quote(ids.upload)};
    DELETE FROM public.audit_logs WHERE entity_id IN (${quote(ids.conversation)},${quote(ids.scanConversationFirst)},${quote(ids.scanConversationSecond)},${quote(ids.upload)},${quote(ids.supportTicket)});
    DELETE FROM public.conversation_handling_cycles WHERE conversation_id IN (${quote(ids.conversation)},${quote(ids.scanConversationFirst)},${quote(ids.scanConversationSecond)});
    DELETE FROM public.conversation_work_items WHERE conversation_id IN (${quote(ids.conversation)},${quote(ids.scanConversationFirst)},${quote(ids.scanConversationSecond)});
    DELETE FROM public.conversations WHERE id IN (${quote(ids.conversation)},${quote(ids.scanConversationFirst)},${quote(ids.scanConversationSecond)});
    DELETE FROM public.character_operator_assignments WHERE character_id=${quote(ids.character)};
    DELETE FROM public.characters WHERE id=${quote(ids.character)};
    DELETE FROM public.operators WHERE id=${quote(ids.operator)};
    DELETE FROM public.credit_wallets WHERE user_id=${quote(ids.client)};
    DELETE FROM public.user_roles WHERE user_id IN (${quote(ids.client)},${quote(ids.operatorUser)},${quote(ids.adminUser)},${quote(ids.scanClientFirst)},${quote(ids.scanClientSecond)});
    DELETE FROM public.client_profiles WHERE user_id IN (${quote(ids.client)},${quote(ids.operatorUser)},${quote(ids.adminUser)},${quote(ids.scanClientFirst)},${quote(ids.scanClientSecond)});
    DELETE FROM public.profiles WHERE user_id IN (${quote(ids.client)},${quote(ids.operatorUser)},${quote(ids.adminUser)},${quote(ids.scanClientFirst)},${quote(ids.scanClientSecond)});
    DELETE FROM auth.users WHERE id IN (${quote(ids.client)},${quote(ids.operatorUser)},${quote(ids.adminUser)},${quote(ids.scanClientFirst)},${quote(ids.scanClientSecond)});
    COMMIT;`);
}

const observer = new Session("observer");
const first = new Session("first");
const second = new Session("second");
let baselineAnalytics = null;
try {
  await Promise.all([observer.initialize(), first.initialize(), second.initialize()]);
  baselineAnalytics = await observer.json("SELECT COALESCE(json_agg(id),'[]'::json) FROM public.analytics_events;");
  await setup(observer);
  await multiConversationScannerLockOrderRace(observer, first, second);
  await handlingLockOrderRace(observer, first, second);
  await handlingRaces(observer, first, second);
  await cleanupLeaseRace(observer, first, second);
  await supportFirstResponseRace(observer, first, second);
  console.log(
    "PASS: handling lock order, stale decisions, cleanup leases, and the first support response are fenced under real DB contention.",
  );
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : "unknown concurrency failure"}`);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([first.ok("ROLLBACK;"), second.ok("ROLLBACK;")]);
  await cleanup(observer, baselineAnalytics).catch(() => {
    process.exitCode = 1;
  });
  await Promise.allSettled(sessions.map((session) => session.close()));
}
