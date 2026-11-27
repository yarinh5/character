import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Inspect the fixture that the DB suite consumes. PostgreSQL runs the pgTAP
// assertions themselves in the live DB suite.
const sql = readFileSync(new URL("./cycle_bound_operator_send.test.sql", import.meta.url), "utf8")
  .replace(/--[^\n]*/g, "")
  .replace(/\s+/g, " ");
const owner = "00000000-0000-4000-8000-0000000b3101";
const claim = "00000000-0000-4000-8000-0000000b3102";

function beforeSend(content) {
  const index = sql.indexOf(`'${content}'`);
  assert.ok(index > 0, `missing send: ${content}`);
  return sql.slice(0, index);
}

test("active-token setup uses one business clock and checks expiry before sending", () => {
  const setup = beforeSend("owner strict response");
  const anchor = setup.match(
    /WITH owner_activity AS \(SELECT clock_timestamp\(\) AS activity_at\) INSERT INTO public\.conversations \([^;]+ FROM owner_activity;/,
  )?.[0];
  assert.ok(anchor?.includes(owner), "owner conversation has a server-clock anchor");
  assert.match(anchor, /last_business_message_at, inactivity_expires_at/);
  assert.match(anchor, /'open', activity_at, activity_at \+ interval '180 seconds'/);
  assert.match(
    setup,
    /inactivity_expires_at = last_business_message_at \+ interval '180 seconds' AND inactivity_expires_at > clock_timestamp\(\)/,
  );
});

test("first claim is prepared by a client message and checks the projected queue row", () => {
  const setup = beforeSend("atomic first response");
  const messages = setup.match(/INSERT INTO public\.messages\b[^;]+;/g) ?? [];
  assert.equal(messages.length, 1);
  assert.ok(messages[0].includes(`'${claim}', 'client', '00000000-0000-4000-8000-0000000b0101'`));
  for (const insert of setup.match(/INSERT INTO public\.conversation_work_items\b[^;]+;/g) ?? []) {
    assert.ok(!insert.includes(claim), "the NEW row belongs to the client-message trigger");
  }
  assert.match(
    setup,
    /SELECT is\(\( SELECT count\(\*\).*JOIN public\.conversation_work_items work_item ON work_item\.conversation_id = conversation\.id/,
  );
  for (const predicate of [
    "conversation.needs_handling IS TRUE",
    "conversation.pending_since = message.created_at",
    "conversation.inactivity_expires_at = message.created_at + interval '180 seconds'",
    "conversation.inactivity_expires_at > clock_timestamp()",
    "work_item.last_client_message_id = message.id",
    "work_item.status = 'new'",
    "work_item.responsible_operator_id IS NULL",
    "NOT EXISTS ( SELECT 1 FROM public.conversation_handling_cycles cycle",
    "), 1::bigint, 'Client request",
  ])
    assert.ok(setup.includes(predicate), predicate);
});

test("separate active tokens reject missing and expired windows, and open non-pending work rejects claim", () => {
  const cases = [
    ["b3103", "b6103", "absent expiry", "handling_cycle_expired"],
    ["b3104", "b6104", "expired window", "handling_cycle_expired"],
    ["b3105", null, "no pending request", "conversation_not_available_for_claim"],
  ];
  const id = (suffix) => `'00000000-0000-4000-8000-0000000${suffix}'`;
  const start = sql.indexOf("SELECT set_config('wp01_4.before_invalid_states'");
  assert.ok(start > sql.indexOf("'Atomic send assigns responsibility to the sending operator'"));
  const probes = sql.slice(start);
  for (const [conversation, cycle, content, reason] of cases) {
    const token = cycle ? id(cycle) : "NULL::uuid";
    const call = `SELECT public.send_operator_message(${id(conversation)}, '${content}', ${token})`;
    assert.ok(sql.slice(0, start).includes(id(conversation)), conversation);
    assert.ok(probes.includes(`SELECT throws_ok( $$${call}$$, 'P0001', '${reason}'`), reason);
  }
  assert.match(sql.slice(0, start), /clock_timestamp\(\) - interval '181 seconds' AS activity_at/);
  assert.match(
    probes,
    /RESET ROLE; SELECT is\(pg_temp\.wp01_4_send_counts\(\), current_setting\('wp01_4.before_invalid_states'\)::jsonb/,
  );
});

test("the TAP plan matches the fixture and the transaction rolls back", () => {
  const assertions = sql.match(/\bSELECT (?:ok|is|throws_like|throws_ok|lives_ok)\(/gi);
  assert.equal(assertions.length, Number(sql.match(/SELECT plan\((\d+)\);/)[1]));
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /SELECT \* FROM finish\(\); ROLLBACK;\s*$/);
});
