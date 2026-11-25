import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migrationUrl = new URL(
  "../../../migrations/20261111170000_wp10_retention_minimization.sql",
  import.meta.url,
);
const sql = readFileSync(migrationUrl, "utf8");
const basePolicySql = readFileSync(
  new URL(
    "../../../migrations/20261111140000_wp10_deletion_retention_policy.sql",
    import.meta.url,
  ),
  "utf8",
);
const worker = readFileSync(
  new URL("../../../functions/process-deletion-workflows/index.ts", import.meta.url),
  "utf8",
);
const orchestration = readFileSync(
  new URL("../../../functions/process-deletion-workflows/orchestration.ts", import.meta.url),
  "utf8",
);

function functionBody(name, schema = "public") {
  const marker = `FUNCTION ${schema}.${name}`;
  const start = sql.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist in the migration`);
  const bodyStart = sql.indexOf("AS $$", start);
  const end = sql.indexOf("$$;", bodyStart + 5);
  assert.ok(bodyStart > start && end > bodyStart, `${name} must have a complete SQL body`);
  return sql.slice(bodyStart + 5, end);
}

test("approved retention categories progress while unresolved classifications remain protected", () => {
  const body = functionBody("execute_account_retention_minimization_for_server");
  assert.match(body, /'financial_records'[\s\S]*'pending_legal'/);
  assert.match(body, /'backups'[\s\S]*'provider_unverified'/);
  assert.match(body, /outcome[^;]*'held'/s);
  assert.match(body, /outcome[^;]*'pending_anchor'/s);
  for (const recordType of [
    "financial_records",
    "internal_credits_points",
    "safety_reports",
    "blocks",
    "admin_audit",
  ]) {
    assert.match(body, new RegExp(`'${recordType}'`));
  }
});

test("the minimizer is fenced and stale workers cannot persist or complete work", () => {
  const body = functionBody("execute_account_retention_minimization_for_server");
  const blockBody = functionBody("block_account_retention_minimization_for_server");
  const claimBody = functionBody("claim_account_deletion_step_for_server");
  assert.match(body, /step\.claim_token = _claim_token/);
  assert.match(body, /step\.lease_expires_at > _now/);
  assert.match(body, /FOR UPDATE/);
  assert.match(body, /deletion_step_claim_stale/);
  assert.match(body, /ON CONFLICT \(request_id, record_type\) DO UPDATE/);
  assert.match(body, /'completion_ready', NOT EXISTS/);
  assert.match(blockBody, /step\.claim_token = _claim_token/);
  assert.match(blockBody, /failure_code = 'retention_conditions_pending'/);
  assert.match(blockBody, /status = 'blocked_retention'/);
  assert.match(claimBody, /failure_code = 'retention_conditions_pending'/);
});

test("ledger values and financial classifications are preserved", () => {
  const body = functionBody("execute_account_retention_minimization_for_server");
  assert.doesNotMatch(body, /UPDATE\s+public\.credit_wallets/i);
  assert.doesNotMatch(body, /SET\s+(amount|balance_after|balance|lifetime_earned|lifetime_spent)\s*=/i);
  assert.doesNotMatch(body, /DELETE\s+FROM\s+public\.(credit_transactions|credit_wallets)/i);
  assert.match(body, /credit_tx\.type <> 'package_purchase'/);
  assert.match(sql, /blocks_step = NULL[\s\S]*record_type = 'financial_records'/);
});

test("the existing worker calls the real retention RPC and keeps execution disabled by default", () => {
  assert.match(worker, /execute_account_retention_minimization_for_server/);
  assert.match(worker, /block_account_retention_minimization_for_server/);
  assert.match(worker, /_claim_token: claimToken/);
  assert.match(orchestration, /evidence\.completion_ready !== true/);
  assert.match(orchestration, /await io\.blockRetention/);
  assert.doesNotMatch(worker, /retention_classification_not_approved/);
  assert.match(worker, /DELETION_WORKFLOW_ENABLED/);
  assert.match(basePolicySql, /'deletion_scheduler_enabled', 'false'::jsonb/);
  assert.doesNotMatch(sql, /deletion_scheduler_enabled'\s*,\s*'true'/);
});

test("future expiry work is represented without claiming backup expiry or enabling a scheduler", () => {
  assert.match(sql, /CREATE TABLE private\.deletion_retention_results/);
  assert.match(sql, /interval '12 months'/);
  assert.match(sql, /interval '24 months'/);
  assert.match(sql, /active_system_completion_anchor_pending/);
  assert.match(sql, /record_type IN \('internal_credits_points', 'blocks'\)/);
  assert.match(sql, /blocked\.reason_code <> 'active_system_completion_anchor_pending'/);
  assert.doesNotMatch(sql, /_request\.confirmed_at \+ interval '12 months'/);
  assert.match(sql, /provider_unverified/);
  assert.match(sql, /private\.anchor_account_retention_after_completion/);
  assert.doesNotMatch(
    sql,
    /blocked\.outcome IN \('held', 'pending_anchor', 'pending_legal', 'provider_unverified'\)/,
  );
});
