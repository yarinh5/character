import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const migrationPath = path.join(
  root,
  "supabase/migrations/20261111160000_p06a_registration_eligibility.sql",
);
const migration = await readFile(migrationPath, "utf8");
const config = await readFile(path.join(root, "supabase/config.toml"), "utf8");
const route = await readFile(path.join(root, "src/routes/register.tsx"), "utf8");
const adminSettings = await readFile(path.join(root, "src/routes/admin.settings.tsx"), "utf8");

assert.match(migration, /CREATE OR REPLACE FUNCTION public\.before_user_created_hook\s*\(/i);
assert.match(migration, /registration_admission_token/i);
assert.match(migration, /registration_admission_open\(\)/i);
assert.match(migration, /registration_rate_limited/i);
assert.match(migration, /email_confirmed_at\s+IS\s+NOT\s+NULL/i);
assert.match(migration, /onboarding_completed_at\s+IS\s+NOT\s+NULL/i);
assert.match(migration, /BETWEEN\s+18\s+AND\s+120/i);
assert.match(migration, /CREATE TABLE private\.signup_credit_grants/i);
assert.match(migration, /ON CONFLICT \(user_id\) DO NOTHING/i);
assert.match(migration, /CREATE OR REPLACE FUNCTION public\.admin_set_registration_state/i);
assert.match(migration, /INSERT INTO public\.audit_logs/i);
assert.doesNotMatch(migration, /UPDATE\s+auth\.users[\s\S]*email_confirmed_at/i);

assert.match(config, /\[auth\.hook\.before_user_created\]/);
assert.match(config, /pg-functions:\/\/postgres\/public\/before_user_created_hook/);
assert.doesNotMatch(route, /supabase\.auth\.signUp/);
assert.match(route, /registerClient/);
assert.match(adminSettings, /admin_set_registration_state/);
assert.match(adminSettings, /registrationChangeReason/);

console.log("p06a registration eligibility offline contract: PASS");
