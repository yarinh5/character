import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../../migrations/20261111190000_p06_restore_recovery_gate.sql", import.meta.url),
  "utf8",
);
const worker = readFileSync(
  new URL("../../../functions/process-restore-recovery/index.ts", import.meta.url),
  "utf8",
);
const clientRoute = readFileSync(
  new URL("../../../../src/routes/app.tsx", import.meta.url),
  "utf8",
);
const operatorRoute = readFileSync(
  new URL("../../../../src/routes/operator.tsx", import.meta.url),
  "utf8",
);
const adminRoute = readFileSync(
  new URL("../../../../src/routes/admin.support.tsx", import.meta.url),
  "utf8",
);

for (const contract of [
  "private.restore_recovery_events",
  "private.restore_recovery_requirements",
  "private.restore_recovery_authority_manifests",
  "private.restore_recovery_reconciliation_results",
  "private.restore_recovery_deletion_replay",
  "private.ensure_recovery_business_open",
  "public.begin_restore_recovery_for_server",
  "public.finalize_restore_recovery_import_for_server",
  "public.admin_approve_restore_recovery",
  "public.complete_restore_recovery_release_for_server",
]) {
  assert.ok(migration.includes(contract), `missing recovery contract: ${contract}`);
}

assert.match(
  migration,
  /GRANT EXECUTE ON FUNCTION public\.begin_restore_recovery_for_server[\s\S]+TO service_role/,
  "only the server boundary may establish a restore event",
);
assert.match(
  migration,
  /approval_event_id = event\.id[\s\S]+approval_version = event\.version/,
  "reopening must bind approval to the current event and version",
);
assert.match(
  migration,
  /recovery_deletion_replay_enabled[^;]+FALSE/i,
  "irreversible replay must remain disabled by default",
);
assert.match(
  migration,
  /CREATE TRIGGER recovery_block_credit_transactions[\s\S]+BEFORE INSERT OR UPDATE OR DELETE ON public\.credit_transactions/,
  "credit mutations must fail closed during recovery",
);
assert.match(
  migration,
  /CREATE TRIGGER recovery_block_messages[\s\S]+BEFORE INSERT ON public\.messages/,
  "new messages must fail closed during recovery",
);
assert.doesNotMatch(worker, /applyLedgerCorrection|resetBalance|grantCredits/);
assert.match(worker, /RESTORE_RECOVERY_AUTHORITY_HMAC_KEY/);
assert.match(worker, /RESTORE_RECOVERY_EXPECTED_LOCK_ID/);
assert.match(worker, /RESTORE_RECOVERY_IMPORT_ENABLED/);
assert.match(worker, /RESTORE_RECOVERY_REPLAY_ENABLED/);
assert.match(worker, /RESTORE_RECOVERY_RELEASE_ENABLED/);
assert.match(clientRoute, /RecoveryAccessGate/);
assert.match(operatorRoute, /RecoveryAccessGate/);
assert.match(adminRoute, /שחזור והתאוששות/);

console.log("P06 restore recovery Offline contract: PASS");
