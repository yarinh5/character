import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repository = process.env.HANDLING_SHADOW_TEST_ROOT
  ? pathToFileURL(resolve(process.env.HANDLING_SHADOW_TEST_ROOT) + "/")
  : new URL("../../../../", import.meta.url);
const fixture = readFileSync(
  new URL("supabase/tests/database/v4_3/handling_shadow_foundation.test.sql", repository),
  "utf8",
).replace(/\r\n/g, "\n");
const migrations = new URL("supabase/migrations/", repository);
const files = readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort();
const forward = "20261123090000_restore_handling_writer_barrier_order.sql";
const barrier = "  PERFORM private.acquire_handling_writer_barrier();";
const writers = [
  ["private.send_operator_message", "20261105170000_wp08_operator_points_rewards.sql"],
  ["public.finalize_client_media_upload_for_server", "20261105130000_wp06_client_media_uploads.sql"],
  ["public.purchase_attachment_gift", "20261105150000_wp07_gift_attachment_access.sql"],
  ["public.request_conversation_deletion", "20261111140000_wp10_deletion_retention_policy.sql"],
];
const readMigration = (name) => readFileSync(new URL(name, migrations), "utf8").replace(/\r\n/g, "\n");

function definition(source, qualifiedName) {
  const head = new RegExp("^CREATE (?:OR REPLACE )?FUNCTION " + qualifiedName.replace(".", "\\.") + "\\(", "im");
  const start = source.search(head);
  if (start < 0) return undefined;
  const end = source.indexOf("\n$$;", start);
  assert.ok(end > start, "expected complete dollar-quoted function " + qualifiedName);
  return source.slice(start, end + 4);
}

function definitionFromHeader(source, header) {
  const start = source.indexOf(header);
  assert.ok(start >= 0, "expected exact function header: " + header);
  const end = source.indexOf("\n$$;", start);
  assert.ok(end > start, "expected complete function for exact header");
  return source.slice(start, end + 4);
}

for (const [name, previousFile] of writers) {
  test(name + " acquires the transaction barrier before business logic or row locks", () => {
    let effective;
    for (const file of files.filter((file) => file >= previousFile)) {
      const body = definition(readMigration(file), name);
      if (body) effective = body;
    }
    assert.ok(effective, name);
    assert.match(effective, /\nBEGIN\n  PERFORM private\.acquire_handling_writer_barrier\(\);/,
      "first executable statement must take the handling barrier");
  });
}

test("the migration preserves all four definitions, signatures, guards and ACLs except for the first lock", () => {
  assert.ok(files.includes(forward), "forward migration required");
  const sql = readMigration(forward);
  let remaining = sql;
  for (const [name, previous] of writers) {
    const before = definition(readMigration(previous), name).replace(/^CREATE (?:OR REPLACE )?FUNCTION/, "CREATE OR REPLACE FUNCTION");
    const after = definition(sql, name);
    assert.equal(after, before.replace("\nBEGIN\n", "\nBEGIN\n" + barrier + "\n"), name);
    remaining = remaining.replace(after, "");
  }
  assert.equal(remaining.replace(/^--[^\n]*/gm, "").trim(), "", "no other DDL or grant changes");
});

test("a barrier acquired after validation or a row lock is rejected", () => {
  const corrected = definition(readMigration(forward), "public.purchase_attachment_gift");
  const late = corrected.replace(
    "\nBEGIN\n" + barrier,
    "\nBEGIN\n  PERFORM private.ensure_active_client(_client_id);\n" + barrier,
  );
  assert.doesNotMatch(
    late,
    /\nBEGIN\n  PERFORM private\.acquire_handling_writer_barrier\(\);/,
    "a later barrier must not satisfy the barrier-first contract",
  );
});

const inventory = new Map([...fixture.matchAll(/^\s*\('([^']+)', '(relevant_writer|relevant_guard|delegated_writer|rejected_compatibility|cutover_safe_non_handling)', '/gm)]
  .map(([, signature, classification]) => [signature, classification]));

test("the two legacy entry points are classified and separately verified, while the private send remains a writer", () => {
  const allocation = readMigration("20261105090000_wp016_wp02_handling_allocation.sql");
  const staleUuid = definitionFromHeader(
    allocation,
    "CREATE OR REPLACE FUNCTION private.return_stale_work_items_to_new(\n  _fresh_operator_id uuid\n)",
  );
  const staleNoArg = definitionFromHeader(
    allocation,
    "CREATE OR REPLACE FUNCTION private.return_stale_work_items_to_new()",
  );
  const adminThreeArg = definitionFromHeader(
    allocation,
    "CREATE OR REPLACE FUNCTION public.admin_reassign_conversation(\n  _conversation_id uuid,\n  _operator_id uuid,\n  _reason text\n)",
  );
  const adminTwoArg = definitionFromHeader(
    allocation,
    "CREATE OR REPLACE FUNCTION public.admin_reassign_conversation(\n  _conversation_id uuid,\n  _operator_id uuid\n)",
  );

  assert.match(staleUuid, /\nBEGIN\n  PERFORM private\.acquire_handling_writer_barrier\(\);/);
  assert.match(
    staleNoArg,
    /AS \$\$\n  SELECT private\.return_stale_work_items_to_new\(NULL::uuid\);\n\$\$;/,
  );
  assert.match(adminThreeArg, /\nBEGIN\n  PERFORM private\.acquire_handling_writer_barrier\(\);/);
  assert.match(
    adminTwoArg,
    /AS \$\$\nBEGIN\n  RAISE EXCEPTION 'admin_transfer_reason_required';\nEND;\n\$\$;/,
  );
  assert.doesNotMatch(adminTwoArg, /\b(?:INSERT|UPDATE|DELETE)\b/i);

  assert.equal(inventory.get("private.return_stale_work_items_to_new()"), "delegated_writer");
  assert.equal(inventory.get("public.admin_reassign_conversation(uuid, uuid)"), "rejected_compatibility");
  assert.equal(inventory.get("private.send_operator_message(uuid, text)"), "relevant_writer");
  assert.match(fixture, /SELECT private\.return_stale_work_items_to_new\(NULL::uuid\);/);
  assert.match(fixture, /RAISE EXCEPTION 'admin_transfer_reason_required';/);
  assert.match(fixture, /_released := private\.return_stale_work_items_to_new\(\);/);
  assert.match(fixture, /_allocated := private\.allocate_new_conversations\(_max_assignments\);/);
  for (const name of ["private.return_stale_work_items_to_new()", "public.admin_reassign_conversation(uuid,uuid)", "public.run_handling_allocation(integer)"]) {
    assert.ok(fixture.includes("'" + name + "'::regprocedure"), "catalog assertion required for " + name);
  }
});

test("all 15 signatures from the failed TAP inventory have an explicit cutover classification", () => {
  for (const [classification, signatures] of Object.entries({
    relevant_writer: [
      "private.allocate_new_conversations(integer, uuid)", "private.finish_handling_cycle(uuid, uuid, text, timestamptz, uuid)",
      "private.return_stale_work_items_to_new(uuid)", "private.send_operator_gift_media_message(uuid, uuid, text)",
      "public.admin_reassign_conversation(uuid, uuid, text)", "public.finalize_client_media_upload_for_server(uuid, uuid, text, text, bigint, uuid)",
      "public.purchase_attachment_gift(uuid, uuid, uuid)", "public.request_conversation_deletion(uuid, text, uuid, boolean)",
      "public.send_operator_gift_media_message(uuid, uuid, text, uuid)",
    ],
    delegated_writer: ["public.run_handling_allocation(integer)"],
    cutover_safe_non_handling: [
      "private.block_business_mutation_during_recovery()", "private.count_plain_client_message_level()",
      "private.sync_operational_wait_cycle()", "public.execute_account_deletion_database_step_for_server(uuid, uuid)",
      "public.execute_conversation_deletion_database_step_for_server(uuid, uuid)",
    ],
  })) {
    for (const signature of signatures) assert.equal(inventory.get(signature), classification, signature);
  }
  assert.match(fixture, /to_regprocedure\(inventory\.signature\) = candidate\.routine_oid/);
  assert.match(fixture, /inventory\.signature IS NULL/);
});

test("an independently discovered writer without an inventory entry remains a failure", () => {
  const discovered = new Set([
    ...inventory.keys(),
    "pg_temp.wp01_unclassified_writer_probe()",
  ]);
  const unclassified = [...discovered].filter((signature) => !inventory.has(signature));
  assert.deepEqual(unclassified, ["pg_temp.wp01_unclassified_writer_probe()"]);
  assert.match(fixture, /CREATE OR REPLACE FUNCTION pg_temp\.wp01_unclassified_writer_probe\(\)/);
  assert.match(
    fixture,
    /candidate\.routine_name = 'wp01_unclassified_writer_probe'[\s\S]+inventory\.signature IS NULL/,
  );
});

test("first claim uses the client-message projection and all replays use its original work item", () => {
  const conversation = "00000000-0000-4000-8000-0000000a3104";
  const from = fixture.lastIndexOf("INSERT INTO public.conversations", fixture.indexOf(conversation));
  const to = fixture.indexOf("DELETE FROM public.conversation_handling_cycles\nWHERE conversation_id IN", from);
  assert.ok(from >= 0 && to > from, "expected claim fixture boundaries");
  const scenario = fixture.slice(from, to).replace(/\s+/g, " ");
  const first = scenario.indexOf("SELECT 'first', public.claim_new_conversation");
  assert.ok(first > 0);
  const setup = scenario.slice(0, first);
  assert.match(setup, /INSERT INTO public\.messages\b[^;]+0a3104', 'client', '00000000-0000-4000-8000-0000000a0105'[^;]+clock_timestamp\(\)/);
  assert.doesNotMatch(setup, /INSERT INTO public\.conversation_work_items|UPDATE public\.conversations/);
  for (const predicate of ["c.needs_handling IS TRUE", "c.pending_since = m.created_at", "w.last_client_message_id = m.id",
    "w.status = 'new'", "w.responsible_operator_id IS NULL", "c.assigned_operator_id IS NULL", "cycle.ended_at IS NULL"]) {
    assert.ok(setup.includes(predicate), predicate);
  }
  assert.match(setup, /CREATE TEMP TABLE wp01_claim_target ON COMMIT DROP AS SELECT.+FROM public\.conversation_work_items/);
  assert.equal(scenario.match(/public\.claim_new_conversation\(\(SELECT work_item_id FROM wp01_claim_target\)\)/g)?.length, 5);
  assert.match(scenario, /SET work_item_id = \(SELECT work_item_id FROM wp01_claim_target\)/);
  assert.ok(!scenario.includes("00000000-0000-4000-8000-0000000a5104"));
});

// These checks inspect the SQL consumed by pgTAP; they do not execute PostgreSQL.
test("the owner send graph has one stored server anchor and deterministic business-time offsets", () => {
  const start = fixture.indexOf("CREATE TEMP TABLE wp01_send_clock");
  assert.ok(start >= 0, "live owner fixture needs a stored server clock");
  const beforeOwner = fixture.slice(start, fixture.indexOf("'owner response'"));
  assert.match(beforeOwner, /CREATE TEMP TABLE wp01_send_clock ON COMMIT DROP AS\nSELECT clock_timestamp\(\) AS observed_at;/);
  const messages = [...beforeOwner.matchAll(/INSERT INTO public\.messages\b[\s\S]*?;/g)]
    .map(([statement]) => statement)
    .filter((statement) => statement.includes("'00000000-0000-4000-8000-0000000a3101'"));
  assert.equal(messages.length, 2, "owner response must remain message three");
  assert.match(messages[0], /observed_at - interval '90 seconds'/);
  assert.match(messages[1], /observed_at - interval '30 seconds'/);
  for (const offset of ["3690", "1890", "1830", "150"]) {
    assert.ok(beforeOwner.includes(`observed_at - interval '${offset} seconds'`), "historical cycle offset " + offset);
  }
  assert.match(beforeOwner, /'00000000-0000-4000-8000-0000000a6101',[\s\S]*?work_item\.id,[\s\S]*?\(SELECT observed_at FROM wp01_send_clock\)/);
  assert.match(beforeOwner, /\(SELECT pending_since[^;]+observed_at - interval '90 seconds'/);
  assert.match(beforeOwner, /\(SELECT inactivity_expires_at[^;]+observed_at \+ interval '150 seconds'/);
  assert.doesNotMatch(beforeOwner, /2026-10-06/);
});

test("owner-send prerequisites check the live window, original token and projected work item", () => {
  const start = fixture.indexOf("-- Live owner send prerequisites");
  assert.ok(start > 0, "owner send requires a direct precondition assertion");
  const end = fixture.indexOf('SET LOCAL "request.jwt.claim.sub"', start);
  const setup = fixture.slice(start, end).replace(/\s+/g, " ");
  for (const predicate of [
    "c.last_business_message_at = (SELECT observed_at - interval '30 seconds' FROM wp01_send_clock)",
    "c.pending_since = (SELECT observed_at - interval '90 seconds' FROM wp01_send_clock)",
    "c.inactivity_expires_at = c.last_business_message_at + interval '180 seconds'",
    "c.inactivity_expires_at > clock_timestamp()", "c.needs_handling IS TRUE",
    "c.assigned_operator_id = '00000000-0000-4000-8000-0000000a1102'",
    "cycle.id = '00000000-0000-4000-8000-0000000a6101'", "cycle.ended_at IS NULL",
    "cycle.operator_id = c.assigned_operator_id", "w.id = cycle.work_item_id",
    "w.responsible_operator_id = cycle.operator_id", "w.status = 'assigned'",
    "w.last_client_message_id = '00000000-0000-4000-8000-0000000a4102'",
    "), 1::bigint, 'Owner send prerequisites",
  ]) assert.ok(setup.includes(predicate), predicate);
  assert.match(beforeOwnerResponse(), /\(SELECT count\(\*\) FROM public\.messages WHERE conversation_id = c\.id\) = 2/);
});

function beforeOwnerResponse() {
  return fixture.slice(0, fixture.indexOf("'owner response'"));
}

test("atomic send keeps the canonical Client request after the non-pending legacy-lock probe", () => {
  const start = fixture.indexOf("'Rejected legacy-lock send has no side effect'");
  const end = fixture.indexOf("'atomic claim response'", start);
  assert.ok(start > 0 && end > start);
  const setup = fixture.slice(start, end).replace(/\s+/g, " ");
  const messages = setup.match(/INSERT INTO public\.messages\b[^;]+;/g) ?? [];
  assert.equal(messages.length, 1, "one fresh Client message is required after the legacy probe");
  assert.match(messages[0], /'00000000-0000-4000-8000-0000000a4103', '00000000-0000-4000-8000-0000000a3101', 'client', '00000000-0000-4000-8000-0000000a0101'/);
  assert.match(messages[0], /'Client request for atomic claim after release', clock_timestamp\(\)/);
  assert.doesNotMatch(setup, /INSERT INTO public\.conversation_work_items|UPDATE public\.conversations|DISABLE TRIGGER/);
  for (const predicate of [
    "c.needs_handling IS TRUE", "c.pending_since = m.created_at",
    "c.last_business_message_at = m.created_at",
    "c.inactivity_expires_at = m.created_at + interval '180 seconds'",
    "c.inactivity_expires_at > clock_timestamp()", "c.assigned_operator_id IS NULL",
    "w.last_client_message_id = m.id", "w.status = 'new'",
    "w.responsible_operator_id IS NULL", "w.assigned_at IS NULL",
    "NOT EXISTS ( SELECT 1 FROM public.conversation_handling_cycles cycle",
    "cycle.ended_at IS NULL", "active.status IN ('new', 'assigned', 'in_progress')) = 1",
    "), 1::bigint, 'Client request prepares atomic send",
  ]) assert.ok(setup.includes(predicate), predicate);
});

test("missing owner response fails an explicit prerequisite before any reconciliation UUID cast", () => {
  const marker = "-- Require the successful owner response before dependent reconciliation.";
  const start = fixture.indexOf(marker);
  const firstIdUse = fixture.indexOf("'wp01.staff_none_message_id'");
  assert.ok(start > 0 && start < firstIdUse, "owner response prerequisite precedes the dependent ID");
  const setup = fixture.slice(start, firstIdUse).replace(/\s+/g, " ");
  assert.match(setup, /SELECT is\( \(SELECT count\(\*\) FROM public\.messages WHERE content = 'owner response'\), 1::bigint, 'Owner response exists exactly once before reconciliation ID use' \);/);
  assert.match(setup, /IF \(SELECT count\(\*\) FROM public\.messages WHERE content = 'owner response'\) <> 1 THEN RAISE EXCEPTION 'owner_response_fixture_prerequisite_failed'; END IF;/);
  assert.doesNotMatch(setup, /COALESCE|NULLIF|gen_random_uuid/);
  assert.match(fixture.slice(firstIdUse, firstIdUse + 180), /\(SELECT id::TEXT FROM public\.messages WHERE content = 'owner response'\)/);
});

test("the former legacy-lock probe rejects non-pending work rather than treating the lock as authority", () => {
  const marker = fixture.indexOf("'wp01.legacy_lock_rejection_before'");
  const start = fixture.lastIndexOf("-- Non-pending work", marker);
  const end = fixture.indexOf("\nDELETE FROM public.conversation_locks", marker);
  assert.ok(start > 0 && end > start);
  const scenario = fixture.slice(start, end).replace(/\s+/g, " ");
  for (const predicate of ["c.needs_handling IS FALSE", "c.pending_since IS NULL",
    "c.assigned_operator_id IS NULL", "cycle.ended_at IS NULL",
    "w.status IN ('new', 'assigned', 'in_progress')", "legacy_lock.expires_at > clock_timestamp()",
    "legacy_lock.locked_by_operator_id = '00000000-0000-4000-8000-0000000a1104'"]) {
    assert.ok(scenario.includes(predicate), predicate);
  }
  assert.match(scenario, /SELECT throws_like\( \$\$SELECT public\.send_operator_message/);
  assert.ok(scenario.includes("'conversation_not_available_for_claim'"));
  assert.ok(!scenario.includes("'conversation_locked_by_other_operator'"));
  assert.ok(scenario.includes("current_setting('wp01.legacy_lock_rejection_before')::jsonb"));
  assert.doesNotMatch(scenario, /INSERT INTO public\.messages|SET needs_handling|SET pending_since/);
});

test("no_plan accounts for the contract scenarios and maps the original assertions", () => {
  const assertions = [...fixture.matchAll(/^SELECT\s+(?:ok|is|throws_like|throws_ok|lives_ok)\(/gm)];
  const helpers = [...fixture.matchAll(/^SELECT \* FROM pg_temp\.wp01_assert_semantic_corruption\(/gm)];
  const helperBody = fixture.slice(fixture.indexOf("CREATE OR REPLACE FUNCTION pg_temp.wp01_assert_semantic_corruption"), fixture.indexOf("CREATE OR REPLACE FUNCTION pg_temp.wp01_handling_writer_candidates"));
  assert.equal((helperBody.match(/RETURN NEXT (?:is|ok)\(/g) ?? []).length, 4);
  assert.equal(assertions.length, 199);
  assert.equal(helpers.length, 14);
  assert.equal(assertions.length + helpers.length * 4, 255, "static full-fixture count; not a live TAP result");
  for (const [number, description] of [
    [49, "Owner send prerequisites"], [50, "Cycle owner can send through the existing RPC"],
    [59, "Non-pending work is ineligible"], [60, "Non-pending conversation remains unavailable"],
    [62, "Client request prepares atomic send"], [63, "No active cycle atomically claims authority and sends"],
    [76, "Owner response exists exactly once before reconciliation ID use"],
  ]) {
    const start = assertions[number - 1].index;
    assert.ok(fixture.slice(start, fixture.indexOf(";\n", start)).includes(description), "assertion " + number);
  }
  assert.match(fixture, /^SELECT no_plan\(\);$/m);
  assert.match(fixture, /SELECT \* FROM finish\(\);\nROLLBACK;\s*$/);
});

// Contract coverage is structural Offline evidence; pgTAP and real contention remain NOT RUN.
test("the specification records the owner's 2026-11-23 legacy-lock eligibility decision", () => {
  const spec = readFileSync(new URL("Product Specification and Work Plan 2026-10-06.md", repository), "utf8");
  assert.ok(spec.includes("LEGACY-CLAIM-20261123"));
  for (const word of ["23.11.2026", "atomic claim-and-send", "claim_new_conversation", "allocate_new_conversations",
    "pending", "expiry", "heartbeat", "קיבולת"]) assert.ok(spec.includes(word), word);
});

function legacyContractScenario(route) {
  const start = fixture.indexOf("-- Legacy contract route: " + route);
  const next = fixture.indexOf("-- Legacy contract route:", start + 1);
  const end = fixture.indexOf("-- End legacy claim contract", start);
  assert.ok(start > 0 && end > start, "missing isolated scenario " + route);
  return fixture.slice(start, next > start ? next : end).replace(/\s+/g, " ");
}

for (const [route, call] of [
  ["atomic", "public.send_operator_message("],
  ["explicit", "public.claim_new_conversation("],
  ["automatic", "public.run_handling_allocation(500)"],
]) {
  test(route + " claim has a canonical eligible fixture and a still-valid foreign lock", () => {
    const start = fixture.indexOf("-- Approved legacy claim contract: LEGACY-CLAIM-20261123");
    assert.ok(start > 0);
    const setup = fixture.slice(start, fixture.indexOf("-- Legacy contract route:", start)).replace(/\s+/g, " ");
    assert.match(setup, /INSERT INTO public\.messages \(id, conversation_id, sender_type, sender_id, content, created_at\)/);
    assert.match(setup, /'client'::public\.sender_type, conversation\.client_id[^;]+clock_timestamp\(\)/);
    assert.doesNotMatch(setup, /INSERT INTO public\.conversation_work_items|SET needs_handling|DISABLE TRIGGER/);
    assert.ok(setup.includes("SET value = '\"lock\"'::jsonb"));
    assert.ok(setup.includes("clock_timestamp() + interval '1 hour'"));
    const scenario = legacyContractScenario(route);
    const before = scenario.slice(0, scenario.indexOf(call));
    for (const predicate of ["c.needs_handling IS TRUE", "c.pending_since = m.created_at",
      "c.inactivity_expires_at = m.created_at + interval '180 seconds'", "c.inactivity_expires_at > clock_timestamp()",
      "c.assigned_operator_id IS NULL", "w.status = 'new'", "w.responsible_operator_id IS NULL",
      "w.assigned_at IS NULL", "cycle.ended_at IS NULL", "legacy_lock.expires_at > clock_timestamp()",
      "legacy_lock.locked_by_operator_id = '00000000-0000-4000-8000-0000000a1202'",
      "active.status IN ('new', 'assigned', 'in_progress')) = 1"]) assert.ok(before.includes(predicate), predicate);
    assert.match(scenario, /SELECT lives_ok\(/);
    assert.ok(scenario.includes("cycle.operator_id = '00000000-0000-4000-8000-0000000a1201'"));
    assert.ok(scenario.includes("c.assigned_operator_id = cycle.operator_id"));
    assert.ok(scenario.includes("w.responsible_operator_id = cycle.operator_id"));
    assert.ok(scenario.includes("target.lock_before"));
    assert.doesNotMatch(scenario, /DELETE FROM public\.conversation_locks|UPDATE public\.conversation_locks/);
  });
}

test("atomic legacy-lock claim checks a single message, cycle-bound authority and foreign-owner rejection", () => {
  const scenario = legacyContractScenario("atomic");
  for (const predicate of ["evidence.authority_source = 'atomic_claim_and_send'", "evidence.actor_user_id",
    "evidence.operator_id = cycle.operator_id", "cycle.id = evidence.handling_cycle_id",
    "m.handling_cycle_id = cycle.id", "m.handling_effect = 'staff_response'",
    "m.content = 'Legacy lock atomic response'", "'conversation_not_responsible_operator'",
    "current_setting('wp01.legacy_foreign_owner_before')::jsonb"]) assert.ok(scenario.includes(predicate), predicate);
  assert.ok(scenario.includes("SELECT count(*) FROM public.messages operator_message"));
  assert.ok(scenario.includes("SELECT count(*) FROM private.handling_send_authority_evidence"));
});

test("the final three allocation paths do not make a legacy lock an independent claim veto", () => {
  const allocation = readMigration("20261105090000_wp016_wp02_handling_allocation.sql");
  for (const name of ["private.acquire_operator_send_authority", "public.claim_new_conversation", "private.allocate_new_conversations"]) {
    let effective;
    for (const file of files) effective = definition(readMigration(file), name) ?? effective;
    const expected = name === "private.acquire_operator_send_authority" ? allocation
      : readMigration("20261123110000_enforce_handling_claim_expiry.sql");
    assert.equal(effective, definition(expected, name), "review must follow the final definition " + name);
    assert.doesNotMatch(effective, /conversation_locks|conversation_locked_by_other_operator|assert_operator_can_send_conversation_message/);
    assert.match(effective, /PERFORM private\.acquire_handling_writer_barrier\(\);/);
    assert.match(effective, /FOR UPDATE/);
    assert.match(effective, /needs_handling/);
    assert.match(effective, /conversation_handling_cycles/);
  }
});


// Inspect only message-producing INSERTs, not repeated references in assertions.
// These are the two explicit-ID forms used by this fixture; fail on a new form.
function messageInsertIds(sql) {
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const statements = [...sql.matchAll(/INSERT INTO public\.messages\s*\(([^)]*)\)([^;]*);/gi)];
  assert.equal(statements.length, (sql.match(/INSERT INTO public\.messages\b/gi) ?? []).length,
    "every message INSERT must be inspected");
  assert.ok(statements.length > 0, "message fixtures required");
  return statements.flatMap(([, columns, body]) => {
    assert.equal(columns.trim().split(/\s*,\s*/)[0], "id", "explicit message ID must be first");
    let ids;
    if (/^\s*VALUES\b/i.test(body)) {
      ids = [...body.matchAll(new RegExp("\\(\\s*'(" + uuid + ")'", "gi"))].map((m) => m[1]);
    } else {
      assert.match(body, /^\s*SELECT request\.message_id, conversation\.id,/,
        "unrecognized message-producing SELECT");
      const projected = body.match(/FROM \(VALUES([\s\S]*?)\) request\(route, conversation_id, message_id\)/);
      assert.ok(projected, "canonical Client request VALUES required");
      const rows = [...projected[1].matchAll(new RegExp(
        "\\(\\s*'(atomic|explicit|automatic)',\\s*'" + uuid + "'::uuid,\\s*'(" + uuid + ")'::uuid\\s*\\)", "gi"))];
      assert.equal(rows.length, 3, "all three legacy route message IDs must be inspected");
      assert.equal(new Set(rows.map((m) => m[1])).size, 3, "one Client request per route");
      ids = rows.map((m) => m[2]);
    }
    assert.ok(ids.length > 0, "every message INSERT must provide explicit IDs");
    return ids.map((id) => id.toLowerCase());
  });
}

function assertUniqueMessageInsertIds(sql) {
  const seen = new Set();
  const duplicates = new Set();
  for (const id of messageInsertIds(sql)) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  assert.deepEqual([...duplicates].sort(), [], "duplicate message INSERT IDs");
}

test("all explicitly inserted message IDs are unique across historical and legacy scenarios", () => {
  assertUniqueMessageInsertIds(fixture);
});

test("message-ID regression rejects duplicates within VALUES and across the projected Client requests", () => {
  const id = "00000000-0000-4000-8000-0000000a4991";
  const direct = `INSERT INTO public.messages (id, content) VALUES ('${id}', 'one'), ('${id}', 'two');`;
  assert.throws(() => assertUniqueMessageInsertIds(direct), /duplicate message INSERT IDs/);
  const insertStart = fixture.indexOf("INSERT INTO public.messages", fixture.indexOf("-- Approved legacy claim contract:"));
  const insertEnd = fixture.indexOf(";", insertStart) + 1;
  const projected = fixture.slice(insertStart, insertEnd);
  const ids = messageInsertIds(projected);
  assert.throws(() => assertUniqueMessageInsertIds(projected.replace(ids[1], ids[0])), /duplicate message INSERT IDs/);
  assert.throws(() => assertUniqueMessageInsertIds(
    `INSERT INTO public.messages (id, content) VALUES ('${ids[0].toUpperCase()}', 'earlier');\n` + projected),
    /duplicate message INSERT IDs/);
  assert.doesNotThrow(() => assertUniqueMessageInsertIds(
    `INSERT INTO public.messages (id, content) VALUES ('${id}', 'one');\nSELECT '${id}'::uuid;`));
  assert.throws(() => messageInsertIds("INSERT INTO public.messages (id) SELECT gen_random_uuid();"),
    /unrecognized message-producing SELECT/);
});
