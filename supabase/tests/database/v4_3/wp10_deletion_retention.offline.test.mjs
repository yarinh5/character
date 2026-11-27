import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const baseMigrationUrl = new URL(
  "../../../migrations/20261111140000_wp10_deletion_retention_policy.sql",
  import.meta.url,
);
const continuationMigrationUrl = new URL(
  "../../../migrations/20261111170000_wp10_retention_minimization.sql",
  import.meta.url,
);
const baseSql = readFileSync(baseMigrationUrl, "utf8");
const sql = `${baseSql}\n${readFileSync(continuationMigrationUrl, "utf8")}`;
const sharedOrchestration = readFileSync(
  new URL("../../../functions/_shared/deletion-verification-orchestration.ts", import.meta.url),
  "utf8",
);
const workerEntrypoint = readFileSync(
  new URL("../../../functions/process-deletion-workflows/index.ts", import.meta.url),
  "utf8",
);
const workerOrchestration = readFileSync(
  new URL("../../../functions/process-deletion-workflows/orchestration.ts", import.meta.url),
  "utf8",
);

function functionBody(name, schema = "public") {
  const escapedName = `${schema}.${name}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`CREATE(?: OR REPLACE)? FUNCTION\\s+${escapedName}\\s*\\(`, "g");
  let start = -1;
  for (const match of sql.matchAll(declaration)) start = match.index;
  assert.notEqual(start, -1, `${name} must exist in the migration`);
  const bodyStart = sql.indexOf("AS $$", start);
  const end = sql.indexOf("$$;", bodyStart + 5);
  assert.ok(bodyStart > start && end > bodyStart, `${name} must have a complete SQL body`);
  return sql.slice(bodyStart + 5, end);
}

function intervalDays(fragment) {
  const match = fragment.match(/interval\s+'(\d+) days'/);
  assert.ok(match, `expected a day interval in ${fragment}`);
  return Number(match[1]);
}

test("conversation status and client text writers check the deletion gate under the row lock", () => {
  const directory = new URL("../../../migrations/", import.meta.url);
  const migrations = readdirSync(directory)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()
    .reverse();
  for (const [name, mutation] of [
    ["admin_set_conversation_status", /UPDATE public\.conversations/i],
    ["send_client_message", /INSERT INTO public\.credit_wallets/i],
  ]) {
    const declaration = new RegExp(
      `CREATE(?: OR REPLACE)? FUNCTION\\s+public\\.${name}\\s*\\(`,
      "i",
    );
    let body;
    for (const migration of migrations) {
      const source = readFileSync(new URL(migration, directory), "utf8");
      const start = source.search(declaration);
      if (start < 0) continue;
      const definition = source.slice(start);
      const delimiter = /\bAS\s+(\$\w*\$)/i.exec(definition);
      assert.ok(delimiter, `${name} must have a body`);
      const bodyStart = delimiter.index + delimiter[0].length;
      const bodyEnd = definition.indexOf(delimiter[1], bodyStart);
      assert.ok(bodyEnd > bodyStart, `${name} must have a complete body`);
      body = definition.slice(bodyStart, bodyEnd);
      break;
    }
    assert.ok(body, `${name} must have an effective definition`);
    const rowLock = body.search(/FOR UPDATE/i);
    const gate = body.indexOf("private.conversation_deletion_blocks_access(");
    const write = body.search(mutation);
    assert.ok(rowLock >= 0 && gate > rowLock && write > gate, `${name}: gate must precede writes`);
  }
});

test("confirmation establishes immutable server-time cancellation and content deadlines", () => {
  const body = functionBody("verify_account_deletion_for_server");
  const cancelDays = intervalDays(body.slice(body.indexOf("cancellation_deadline")));
  const contentDays = intervalDays(body.slice(body.indexOf("content_deletion_due_at")));
  assert.equal(cancelDays, 7);
  assert.equal(contentDays, 30);
  assert.match(body, /confirmed_at\s*=\s*COALESCE\(request\.confirmed_at, _now\)/);
  assert.match(body, /cancellation_deadline\s*=\s*COALESCE/);
  assert.match(body, /content_deletion_due_at\s*=\s*COALESCE/);
  assert.match(body, /auth_user\.email_confirmed_at IS NOT NULL/);
  assert.match(body, /verified_email_required/);

  const confirmed = Date.parse("2026-11-11T10:00:00.000Z");
  assert.equal(
    new Date(confirmed + cancelDays * 86_400_000).toISOString(),
    "2026-11-18T10:00:00.000Z",
  );
  assert.equal(
    new Date(confirmed + contentDays * 86_400_000).toISOString(),
    "2026-12-11T10:00:00.000Z",
  );
});

test("cancellation closes at the boundary and consumes a fresh one-time identity proof", () => {
  const body = functionBody("cancel_account_deletion_for_server");
  assert.match(body, /cancellation_deadline\s*<=\s*_now/);
  assert.match(body, /_verification\.user_id IS DISTINCT FROM _verified_user_id/);
  assert.match(body, /_verification\.token_hash IS DISTINCT FROM _token_hash/);
  assert.match(body, /_verification\.consumed_at IS NOT NULL/);
  assert.match(body, /irreversible_started_at IS NOT NULL/);
  assert.match(body, /status = 'cancelled'/);
  assert.match(body, /status = 'active'/);
});

test("cancellation ACLs reference only the canonical server function", () => {
  const aclStart = baseSql.indexOf(
    "REVOKE ALL ON FUNCTION public.get_my_account_deletion_status()",
  );
  assert.ok(aclStart >= 0, "the WP10 function ACL block must exist");

  const targets = new Set(
    [
      ...baseSql
        .slice(aclStart)
        .matchAll(/public\.(cancel_account_deletion(?:_for_server)?)\(([^)]*)\)/g),
    ].map((match) => `${match[1]}(${match[2].replace(/\s+/g, "").toLowerCase()})`),
  );

  assert.deepEqual([...targets], ["cancel_account_deletion_for_server(uuid,uuid,text)"]);
});

test("WP10 uses the canonical Gift purchase/message relation and never the removed message_gifts table", () => {
  assert.doesNotMatch(sql, /\bmessage_gifts\b/);
  const policyStart = sql.indexOf(
    'CREATE POLICY "Clients view own undeleted Gift attachment purchases"',
  );
  const policyEnd = sql.indexOf(
    'DROP POLICY IF EXISTS "Admins view Gift attachment purchases"',
    policyStart,
  );
  assert.ok(policyStart >= 0 && policyEnd > policyStart, "client Gift policy must be complete");
  const policy = sql.slice(policyStart, policyEnd);
  assert.match(policy, /ON public\.gift_attachment_purchases/);
  assert.match(policy, /gift_message_id IS NULL/);
  assert.match(policy, /message\.id = gift_message_id/);
  assert.match(policy, /message\.conversation_id = gift_attachment_purchases\.conversation_id/);
  assert.match(policy, /conversation_deletion_blocks_access\(conversation_id\)/);
});

test("claims are fenced, leased, bounded and do not start irreversible work while disabled", () => {
  const claim = functionBody("claim_account_deletion_step_for_server");
  const complete = functionBody("complete_account_deletion_step_for_server");
  const fail = functionBody("fail_account_deletion_step_for_server");
  assert.match(claim, /account_deletion_irreversible_enabled/);
  assert.match(claim, /step\.attempt_count < 5/);
  assert.match(claim, /claim_token = gen_random_uuid\(\)/);
  assert.match(claim, /lease_expires_at = clock_timestamp\(\) \+ interval '5 minutes'/);
  assert.match(complete, /step\.claim_token = _claim_token/);
  assert.match(complete, /step\.lease_expires_at > clock_timestamp\(\)/);
  assert.match(complete, /deletion_evidence_required/);
  assert.match(fail, /step\.claim_token = _claim_token/);
});

test("conversation requests block access immediately and retain a seven-day physical-deletion target", () => {
  const body = functionBody("request_conversation_deletion");
  assert.match(body, /'access_blocked'/);
  assert.match(body, /_now \+ interval '7 days'/);
  assert.match(body, /status = 'closed'/);
  assert.match(body, /conversation_handling_cycles/);
  assert.match(body, /conversation_work_items/);
  assert.match(
    functionBody("conversation_deletion_blocks_access", "private"),
    /status NOT IN \('cancelled'\)/,
  );
});

test("retention policy localizes unresolved legal and provider decisions", () => {
  assert.match(sql, /'financial_records'.*'pending_legal'/s);
  assert.match(sql, /blocks_step = NULL[\s\S]*record_type = 'financial_records'/);
  assert.match(sql, /'financial_records'[\s\S]*'pending_legal'[\s\S]*'records_mutated', false/);
  assert.match(sql, /'business_records'.*'pending_legal'.*'finalize'/s);
  assert.match(sql, /'backups'.*'provider_unverified', NULL/s);
  assert.match(sql, /account_deletion_irreversible_enabled', 'false'/);
  assert.match(sql, /conversation_deletion_irreversible_enabled', 'false'/);
  assert.match(sql, /deletion_scheduler_enabled', 'false'/);
});

test("partial completion cannot be reported as active-system completion", () => {
  const account = functionBody("complete_account_deletion_step_for_server");
  const conversation = functionBody("complete_conversation_deletion_step_for_server");
  for (const body of [account, conversation]) {
    assert.match(body, /SELECT count\(\*\) INTO _remaining/);
    assert.match(
      body,
      /CASE WHEN _remaining = 0 THEN 'active_system_completed' ELSE 'processing' END/,
    );
  }
});

test("email verification, provider session revocation and cancellation are connected to fenced server transitions", () => {
  assert.match(sharedOrchestration, /prepareVerification\(request\.id, tokenHash/);
  assert.match(sharedOrchestration, /sendMagicLink\([\s\S]*request: request\.id, token/);
  assert.match(sharedOrchestration, /verifyDeletion\(requestId, tokenHash, identity\.id\)/);
  assert.match(sharedOrchestration, /revokeGlobalSessions\(accessToken\)/);
  assert.match(
    sharedOrchestration,
    /completeAccountStep\(requestId, claim\.step_name, claim\.claim_token/,
  );
  assert.match(sharedOrchestration, /failAccountStep\([\s\S]*claim\.claim_token/);
  assert.match(
    sharedOrchestration,
    /cancelDeletion\(requestId, identity\.id, await io\.sha256\(token\)\)/,
  );
  assert.match(
    functionBody("verify_account_deletion_for_server"),
    /_request\.user_id IS DISTINCT FROM _verified_user_id/,
  );
  assert.match(
    functionBody("cancel_account_deletion_for_server"),
    /fresh_identity_verification_required/,
  );
});

test("the disabled worker executes DB, Storage and Auth operations before persisting completion", () => {
  assert.match(workerEntrypoint, /DELETION_WORKFLOW_ENABLED/);
  assert.match(workerEntrypoint, /execute_account_deletion_database_step_for_server/);
  assert.match(workerEntrypoint, /execute_conversation_deletion_database_step_for_server/);
  assert.match(workerEntrypoint, /trusted\.storage\.from\(bucketId\)\.remove/);
  assert.match(workerEntrypoint, /trusted\.auth\.admin\.deleteUser\(userId, true\)/);
  assert.match(workerEntrypoint, /execute_account_retention_minimization_for_server/);
  assert.match(workerEntrypoint, /block_account_retention_minimization_for_server/);
  assert.match(workerEntrypoint, /complete_account_deletion_step_for_server/);
  assert.match(workerEntrypoint, /fail_account_deletion_step_for_server/);
  assert.match(workerOrchestration, /await io\.executeDatabase/);
  assert.match(workerOrchestration, /await io\.removeStorage/);
  assert.match(workerOrchestration, /await io\.storageObjectExists/);
  assert.match(workerOrchestration, /await io\.softDeleteAuthUser/);
  assert.match(
    workerOrchestration,
    /await io\.complete\(kind, requestId, claim\.step_name, claim\.claim_token, evidence\)/,
  );
  assert.match(
    workerOrchestration,
    /await io\.fail\(kind, requestId, claim\.step_name, claim\.claim_token/,
  );
});

test("database and Storage execution require a live claim token and produce real operation evidence", () => {
  for (const name of [
    "execute_account_deletion_database_step_for_server",
    "execute_conversation_deletion_database_step_for_server",
    "list_deletion_storage_objects_for_server",
    "complete_deletion_storage_object_for_server",
    "summarize_deletion_storage_step_for_server",
    "get_account_deletion_subject_for_server",
    "record_deletion_completion_for_server",
  ]) {
    assert.match(functionBody(name), /_claim_token/);
  }
  assert.match(
    functionBody("execute_account_deletion_database_step_for_server"),
    /database_content_minimized/,
  );
  assert.match(
    functionBody("execute_conversation_deletion_database_step_for_server"),
    /conversation_content_minimized/,
  );
  assert.match(
    functionBody("summarize_deletion_storage_step_for_server"),
    /deletion_storage_objects_pending/,
  );
  assert.match(functionBody("record_deletion_completion_for_server"), /completion_ledger_recorded/);
});
