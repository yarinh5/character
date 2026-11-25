import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const migrationsUrl = new URL("../../../migrations/", import.meta.url);
const retirementName = "20261117120000_wp03_retire_operator_outreach_action.sql";
const retirementUrl = new URL(retirementName, migrationsUrl);

test("the retired outreach action is denied to every API role", () => {
  assert.equal(
    existsSync(retirementUrl),
    true,
    `${retirementName} must retire the old action with a forward-only migration`,
  );

  const sql = readFileSync(retirementUrl, "utf8");
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION public\.start_operator_outreach\(uuid, uuid, text, text\)\s+FROM PUBLIC, anon, authenticated, service_role;/i,
  );
  assert.doesNotMatch(sql, /GRANT\s+EXECUTE[\s\S]*start_operator_outreach/i);
  assert.doesNotMatch(sql, /DROP\s+FUNCTION[\s\S]*start_operator_outreach/i);
  assert.doesNotMatch(sql, /CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION[\s\S]*start_operator_outreach/i);
});

test("no later migration reopens the retired outreach action", () => {
  const migrationNames = readdirSync(migrationsUrl)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const retirementIndex = migrationNames.indexOf(retirementName);
  assert.notEqual(retirementIndex, -1);

  for (const name of migrationNames.slice(retirementIndex + 1)) {
    const sql = readFileSync(new URL(name, migrationsUrl), "utf8");
    assert.doesNotMatch(
      sql,
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.start_operator_outreach/i,
      `${name} must not reopen the retired action`,
    );
  }
});
