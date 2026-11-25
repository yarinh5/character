import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../../migrations/20261112110000_p06_support_first_response_sla.sql", import.meta.url),
  "utf8",
);
const clientUi = readFileSync(
  new URL("../../../../src/routes/app.support.tsx", import.meta.url),
  "utf8",
);
const adminUi = readFileSync(
  new URL("../../../../src/routes/admin.support.tsx", import.meta.url),
  "utf8",
);

for (const column of [
  "first_response_target_at",
  "first_response_schedule_version",
  "first_response_timezone",
  "first_human_response_at",
  "first_response_within_target",
]) {
  assert.match(migration, new RegExp(`ADD COLUMN ${column}`));
}
assert.match(migration, /CREATE FUNCTION private\.calculate_support_first_response_target/);
assert.match(migration, /0\.\.370/);
assert.match(migration, /_received_at\s*>=\s*_start_at/);
assert.match(migration, /_received_at\s*<\s*_end_at/);
assert.match(migration, /first_human_response_at\s*=\s*CASE/);
assert.match(migration, /COALESCE\(first_human_response_at,\s*_response_at\)/);
assert.match(migration, /_visibility\s*=\s*'client'/);
assert.match(migration, /FOR UPDATE/);
assert.match(migration, /admin_set_support_operations_config_v3/);
assert.match(migration, /support_closure_dates/);
assert.match(clientUi, /first_response_target_at/);
assert.match(adminUi, /first_response_target_at/);

console.log("P06 support first-response SLA contract: PASS");
