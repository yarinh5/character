import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../../migrations/20261112100000_p06_configuration_connections.sql", import.meta.url),
  "utf8",
);
const registration = readFileSync(
  new URL("../../../../src/lib/registration.functions.ts", import.meta.url),
  "utf8",
);
const recovery = readFileSync(
  new URL("../../../functions/process-restore-recovery/index.ts", import.meta.url),
  "utf8",
);
const deletionRequest = readFileSync(
  new URL("../../../functions/account-deletion-request/index.ts", import.meta.url),
  "utf8",
);
const statusFunction = readFileSync(
  new URL("../../../functions/product-configuration-status/index.ts", import.meta.url),
  "utf8",
);
const envExample = readFileSync(new URL("../../../../.env.example", import.meta.url), "utf8");

for (const column of [
  "support_timezone",
  "support_weekdays",
  "support_day_start",
  "support_day_end",
  "escalation_adapter_state",
]) {
  assert.match(migration, new RegExp(`\\b${column}\\b`), `missing support field ${column}`);
}
assert.match(migration, /configured_not_verified/);
assert.match(migration, /pending_configuration/);
assert.match(migration, /REVOKE EXECUTE ON FUNCTION public\.admin_record_support_incident_delivery/);
assert.match(migration, /auth\.jwt\(\)\s*->>\s*'role'.*service_role/s);
assert.match(migration, /lifecycle_status[\s\S]*draft[\s\S]*approved[\s\S]*active/);
assert.match(migration, /document\.lifecycle_status\s*=\s*'active'/);
assert.match(migration, /document\.approved_at\s+IS\s+NOT\s+NULL/);
assert.match(migration, /escalation_adapter_state\s*=\s*CASE[\s\S]*IS DISTINCT FROM[\s\S]*configured_not_verified/);
assert.match(migration, /escalation_adapter_verified_at\s*=\s*CASE[\s\S]*THEN NULL/);
assert.match(migration, /escalation_adapter_evidence_hash\s*=\s*CASE[\s\S]*THEN NULL/);

assert.doesNotMatch(registration, /redirectUrl:\s*z\.string/);
assert.match(registration, /AUTH_EMAIL_VERIFICATION_REDIRECT_URL/);
assert.match(registration, /AUTH_REDIRECT_ALLOWED_ORIGINS/);
assert.match(deletionRequest, /resolveAllowedAuthRedirect/);
assert.match(recovery, /RESTORE_RECOVERY_EXPECTED_AUTHORITY_ID/);
assert.match(recovery, /RESTORE_RECOVERY_CONTRACT_VERSION/);
assert.match(recovery, /validateRecoveryEnvelopeConfiguration/);
assert.match(statusFunction, /caller\.auth\.getUser\(\)/);
assert.match(statusFunction, /\.eq\("role", "admin"\)/);
assert.doesNotMatch(statusFunction, /AUTHORITY_HMAC_KEY[^\n]*(return|json)/i);

for (const variable of [
  "AUTH_EMAIL_VERIFICATION_REDIRECT_URL",
  "AUTH_REDIRECT_ALLOWED_ORIGINS",
  "ACCOUNT_DELETION_CONFIRM_REDIRECT_URL",
  "ACCOUNT_DELETION_CANCEL_REDIRECT_URL",
  "RESTORE_RECOVERY_EXPECTED_LOCK_ID",
  "RESTORE_RECOVERY_EXPECTED_AUTHORITY_ID",
  "RESTORE_RECOVERY_CONTRACT_VERSION",
  "RESTORE_RECOVERY_AUTHORITY_HMAC_KEY",
  "RESTORE_RECOVERY_IMPORT_ENABLED=false",
  "RESTORE_RECOVERY_RELEASE_ENABLED=false",
  "RESTORE_RECOVERY_REPLAY_ENABLED=false",
]) {
  assert.ok(envExample.includes(variable), `missing environment example ${variable}`);
}
assert.doesNotMatch(envExample, /RESTORE_RECOVERY_AUTHORITY_HMAC_KEY=\S+/);

console.log("P06 configuration connection contract: PASS");
