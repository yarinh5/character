import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Structural checks of the SQL actually supplied for future PostgreSQL tests.
// They do not execute PL/pgSQL or model a database/concurrent transaction.
const repository = process.env.HANDLING_CLAIM_EXPIRY_TEST_ROOT
  ? pathToFileURL(resolve(process.env.HANDLING_CLAIM_EXPIRY_TEST_ROOT) + "/")
  : new URL("../../../../", import.meta.url);
const migrations = new URL("supabase/migrations/", repository);
const names = readdirSync(migrations)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const previous = "20261105090000_wp016_wp02_handling_allocation.sql";
const forward = "20261123110000_enforce_handling_claim_expiry.sql";
const capacityForward = "20261126152000_recheck_locked_auto_allocation_capacity.sql";
const read = (name) => readFileSync(new URL(name, migrations), "utf8").replace(/\r\n/g, "\n");
const before = read(previous);
function definition(sql, name) {
  const start = sql.search(
    new RegExp("^CREATE (?:OR REPLACE )?FUNCTION " + name.replace(".", "\\.") + "\\(", "m"),
  );
  if (start < 0) return undefined;
  const end = sql.indexOf("\n$$;", start);
  assert.ok(end > start, "complete function " + name);
  return sql.slice(start, end + 4);
}
function effective(name) {
  let result;
  for (const file of names) result = definition(read(file), name) ?? result;
  assert.ok(result, name);
  return result;
}
const claimName = "public.claim_new_conversation";
const autoName = "private.allocate_new_conversations";
const claim = effective(claimName);
const allocation = effective(autoName);
const expiryAllocation = definition(read(forward), autoName);
const claimBlock = `  IF _conversation.inactivity_expires_at IS NULL
     OR _conversation.inactivity_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'conversation_claim_state_expired';
  END IF;

`;
const autoBlock = `    IF _conversation.inactivity_expires_at IS NULL
       OR _conversation.inactivity_expires_at <= clock_timestamp() THEN
      CONTINUE;
    END IF;

`;
const filter = `      AND conversation.inactivity_expires_at IS NOT NULL
      AND conversation.inactivity_expires_at > clock_timestamp()
`;
const capacityBlock = `    -- The ranking count can predate another allocator's commit. Count again
    -- in a new statement while holding the operator row lock.
    IF (
      SELECT count(*) FROM public.conversation_handling_cycles active_cycle
      WHERE active_cycle.operator_id = _operator_id AND active_cycle.ended_at IS NULL
    ) >= 5 THEN
      CONTINUE;
    END IF;

`;
function assertClaimGuard(body) {
  assert.equal(body.split(claimBlock).length - 1, 1, "one fail-closed claim expiry gate");
  const gate = body.indexOf(claimBlock);
  assert.ok(gate > body.indexOf("'already_claimed', true"), "replay precedes the new-claim gate");
  assert.ok(
    gate > body.indexOf("IF _active_count >= 5"),
    "operator lock and capacity precede gate",
  );
  assert.ok(
    gate < body.indexOf("  UPDATE public.conversations"),
    "gate precedes first claim mutation",
  );
}
function assertAutoGuard(body) {
  assert.equal(body.split(filter).length - 1, 1, "one pre-limit candidate filter");
  assert.equal(body.split(autoBlock).length - 1, 1, "one locked-row recheck");
  assert.ok(body.indexOf(filter) < body.indexOf("LIMIT _max_assignments"));
  assert.ok(
    body.indexOf(autoBlock) > body.indexOf("IF _operator_id IS NULL THEN"),
    "selected operator precedes recheck",
  );
  assert.ok(body.indexOf(autoBlock) < body.indexOf("    UPDATE public.conversations"));
}
function replay(body) {
  return body.slice(
    body.indexOf("  IF _work_item.status IN"),
    body.indexOf("  IF _work_item.status <>"),
  );
}
const fixtureUrl = new URL(
  "supabase/tests/database/v4_3/handling_claim_expiry.test.sql",
  repository,
);
const fixture = existsSync(fixtureUrl)
  ? readFileSync(fixtureUrl, "utf8").replace(/\r\n/g, "\n")
  : "";

test("new explicit claim checks missing/equal/elapsed expiry after locks and replay before any mutation", () =>
  assertClaimGuard(claim));
test("allocation filters stale candidates before LIMIT and checks the locked conversation immediately before mutation", () =>
  assertAutoGuard(allocation));
test("the forward migration contains only the two definitions and exactly the three expiry additions", () => {
  assert.ok(names.includes(forward), "forward migration required");
  let sql = read(forward);
  for (const [name, body] of [
    [claimName, claim],
    [autoName, expiryAllocation],
  ]) {
    assert.equal(definition(sql, name), body, "each expected historical definition is exact");
    sql = sql.replace(body, "");
  }
  assert.equal(claim.replace(claimBlock, ""), definition(before, claimName));
  assert.equal(
    expiryAllocation.replace(filter, "").replace(autoBlock, ""),
    definition(before, autoName),
  );
  assert.equal(sql.replace(/^--[^\n]*/gm, "").trim(), "", "no extra DDL, grants or business logic");
});
test("the allocator rechecks live capacity under the operator lock before any assignment write", () => {
  const lock = allocation.indexOf("FOR UPDATE OF operator SKIP LOCKED");
  const write = allocation.indexOf("    UPDATE public.conversations");
  const gate = allocation.indexOf(capacityBlock);
  assert.ok(
    lock >= 0 && gate > lock && write > gate,
    "the separate locked capacity gate must precede the first write",
  );
  assert.equal(
    allocation.replace(capacityBlock, ""),
    expiryAllocation,
    "eligibility, ranking, lock order and writes must stay intact",
  );
  const sql = read(capacityForward);
  assert.equal(definition(sql, autoName), allocation);
  assert.equal(
    sql
      .replace(allocation, "")
      .replace(/^--[^\n]*/gm, "")
      .trim(),
    "",
    "no extra DDL or grants",
  );
});
test("replay keeps the exact original idempotent return and does not refresh the deadline", () => {
  assert.equal(replay(claim), replay(definition(before, claimName)));
  assert.doesNotMatch(replay(claim), /\b(?:UPDATE|INSERT|DELETE)\b|inactivity_expires_at/i);
});
test("legacy decisions, writer barrier, locking and other eligibility checks remain unchanged", () => {
  for (const body of [claim, allocation]) {
    assert.match(body, /\nBEGIN\n  PERFORM private\.acquire_handling_writer_barrier\(\);/);
    assert.match(body, /FOR UPDATE/);
    assert.doesNotMatch(body, /conversation_locks|conversation_locked_by_other_operator/);
    for (const token of [
      "needs_handling",
      "presence_status",
      "last_seen_at",
      "availability_status",
      "operator_client_blocks",
    ])
      assert.ok(body.includes(token), token);
    assert.doesNotMatch(
      body,
      /SET inactivity_expires_at|SET last_business_message_at|INTERVAL '.*180/i,
    );
  }
});
test("the new guards use current server time and reject NULL without coercion", () => {
  assertClaimGuard(claim);
  assertAutoGuard(allocation);
  assert.match(claimBlock, /IS NULL\n     OR .* <= clock_timestamp\(\)/);
  assert.match(autoBlock, /IS NULL\n       OR .* <= clock_timestamp\(\)/);
  assert.match(filter, /IS NOT NULL\n      AND .* > clock_timestamp\(\)/);
});
test("removed, early and late claim guards are rejected by the actual source contract check", () => {
  assertClaimGuard(claim);
  assert.throws(() => assertClaimGuard(claim.replace(claimBlock, "")));
  const early = claim
    .replace(claimBlock, "")
    .replace("  IF _work_item.status IN", claimBlock + "  IF _work_item.status IN");
  assert.throws(() => assertClaimGuard(early));
  const late = claim.replace(claimBlock, "") + claimBlock;
  assert.throws(() => assertClaimGuard(late));
});
test("removing either allocation expiry layer or moving the recheck after a write is rejected", () => {
  assertAutoGuard(allocation);
  assert.throws(() => assertAutoGuard(allocation.replace(filter, "")));
  assert.throws(() => assertAutoGuard(allocation.replace(autoBlock, "")));
  assert.throws(() => assertAutoGuard(allocation.replace(autoBlock, "") + autoBlock));
});
test("wrappers and atomic-send authority are unchanged final definitions", () => {
  for (const name of [
    "public.run_handling_allocation",
    "public.operator_heartbeat",
    "private.acquire_operator_send_authority",
  ])
    assert.equal(effective(name), definition(before, name), name);
});
test("pgTAP prepares canonical client messages and isolates fault injection from eligible setup", () => {
  assert.ok(fixture, "pgTAP file required");
  assert.match(
    fixture,
    /INSERT INTO public\.messages \(id, conversation_id, sender_type, sender_id, content, created_at\)/,
  );
  assert.match(fixture, /'client'::public\.sender_type/);
  assert.match(fixture, /clock_timestamp\(\) - interval '181 seconds'/);
  assert.match(fixture, /clock_timestamp\(\) - interval '180 seconds'/);
  assert.match(fixture, /-- Fault injection for missing deadline and missing pending/);
  assert.doesNotMatch(fixture, /INSERT INTO public\.conversation_work_items|DISABLE TRIGGER/);
});
test("pgTAP covers expiry cases, legacy acceptance, no side effects, replay and both allocation callers", () => {
  for (const label of [
    "explicit missing expiry",
    "explicit elapsed expiry",
    "explicit boundary expiry",
    "explicit missing pending",
    "eligible claim with foreign legacy lock",
    "foreign cycle blocks claim",
    "NULL-expiry replay returns the original cycle",
    "expired replay returns the original cycle",
    "allocator skips invalid rows without mutation",
    "admin cleanup does not reclaim expired NEW",
    "heartbeat does not reclaim expired NEW",
  ])
    assert.ok(fixture.includes(label), label);
  assert.ok(fixture.includes("public.run_handling_allocation(500)"));
  assert.ok(fixture.includes("public.operator_heartbeat()"));
  assert.ok(fixture.includes("pg_temp.claim_expiry_state"));
  assert.ok(fixture.includes("'conversation_claim_state_expired'"));
});
test("the dedicated pgTAP plan agrees with its assertions and rolls back", () => {
  assert.ok(fixture, "pgTAP required");
  const count = [...fixture.matchAll(/^SELECT (?:is|ok|lives_ok|throws_ok|throws_like)\(/gm)]
    .length;
  const plan = fixture.match(/^SELECT plan\((\d+)\);/m);
  assert.ok(plan);
  assert.ok(count >= 25, "expiry/replay/wrapper regression cases must not disappear");
  assert.equal(count, Number(plan[1]));
  assert.match(fixture, /^BEGIN;/);
  assert.match(fixture, /SELECT \* FROM finish\(\);\nROLLBACK;\s*$/);
});
