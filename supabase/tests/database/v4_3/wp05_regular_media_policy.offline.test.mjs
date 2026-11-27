import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../../../migrations/20261105230000_wp05_regular_media_60s_policy.sql", import.meta.url),
  "utf8",
);

function settingValue(key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = migration.match(
    new RegExp(`\\(\\s*'${escapedKey}'\\s*,\\s*'((?:''|[^'])*)'\\s*::jsonb\\s*\\)`),
  );
  assert.ok(match, `missing ${key} setting`);
  return JSON.parse(match[1].replaceAll("''", "'"));
}

test("P01 enables the approved 60-second policy for new attachments", () => {
  assert.equal(settingValue("regular_media_60s_policy_enabled"), true);
  assert.equal(settingValue("regular_media_policy_version"), "regular_60s_v1");
  assert.match(
    migration,
    /NEW\.view_mode = 'view_once'[\s\S]*setting_bool\('regular_media_60s_policy_enabled', FALSE\)[\s\S]*NEW\.view_policy_version := 'regular_60s_v1'/,
  );
});

test("P01 starts the approved window at the first authorized server open", () => {
  const openFunction = migration.match(
    /CREATE OR REPLACE FUNCTION public\.open_free_view_once_attachment\([\s\S]*?\n\$\$;/,
  );
  assert.ok(openFunction, "open_free_view_once_attachment must remain present");
  assert.match(openFunction[0], /SET view_once_opened_at = clock_timestamp\(\)/);
  assert.match(
    openFunction[0],
    /WHEN _attachment\.view_policy_version = 'regular_60s_v1' THEN interval '60 seconds'/,
  );
  assert.match(openFunction[0], /ELSE interval '7 seconds'/);
});

test("P01 preserves legacy rows instead of rewriting their policy version", () => {
  assert.match(migration, /ADD COLUMN view_policy_version TEXT NOT NULL DEFAULT 'legacy'/);
  assert.doesNotMatch(
    migration,
    /UPDATE\s+public\.message_attachments\s+SET\s+view_policy_version/iu,
  );
});
