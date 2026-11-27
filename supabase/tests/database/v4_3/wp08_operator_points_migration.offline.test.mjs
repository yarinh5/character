import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/20261105170000_wp08_operator_points_rewards.sql",
);

function decodeSqlStringLiteral(value) {
  return value.replaceAll("''", "'");
}

function parseDirectJsonCasts(sql) {
  return [...sql.matchAll(/'((?:''|[^'])*)'\s*::jsonb\b/g)].map((match) => ({
    literal: decodeSqlStringLiteral(match[1]),
    value: JSON.parse(decodeSqlStringLiteral(match[1])),
  }));
}

function parseSystemSettingsInsert(sql) {
  const statement = sql.match(
    /INSERT INTO public\.system_settings\s*\(key, value\)\s*VALUES([\s\S]*?)ON CONFLICT \(key\) DO UPDATE SET value = EXCLUDED\.value;/,
  );
  assert.ok(statement, "the real system_settings INSERT must remain present");

  const settings = new Map();
  for (const row of statement[1].matchAll(
    /\(\s*'((?:''|[^'])+)'\s*,\s*'((?:''|[^'])*)'\s*::jsonb\s*\)/g,
  )) {
    const key = decodeSqlStringLiteral(row[1]);
    const literal = decodeSqlStringLiteral(row[2]);
    settings.set(key, JSON.parse(literal));
  }
  assert.equal(settings.size, 3, "the WP08 settings INSERT must contain exactly three settings");
  return settings;
}

function validateMigration(sql) {
  const casts = parseDirectJsonCasts(sql);
  assert.ok(
    casts.length > 0,
    "the migration must expose its direct jsonb literal casts to JSON.parse",
  );

  const settings = parseSystemSettingsInsert(sql);
  assert.equal(settings.get("operator_points_rule_version"), "wp08-v1");
  assert.equal(typeof settings.get("operator_points_rule_version"), "string");
  assert.equal(settings.get("client_text_credit_price"), 10);
  assert.equal(typeof settings.get("client_text_credit_price"), "number");
  assert.equal(settings.get("gift_reward_precision_scale"), 6);
  assert.equal(typeof settings.get("gift_reward_precision_scale"), "number");
  return { directJsonCasts: casts.length, settings: Object.fromEntries(settings) };
}

const mode = process.argv[2];
if (mode === "--validate" || mode === "--validate-historical-unquoted") {
  const selectedPath = process.argv[3] ?? migrationPath;
  let sql = readFileSync(selectedPath, "utf8");
  if (mode === "--validate-historical-unquoted") {
    const corrected = `('operator_points_rule_version', '"wp08-v1"'::jsonb)`;
    const historical = `('operator_points_rule_version', 'wp08-v1'::jsonb)`;
    assert.ok(
      sql.includes(corrected),
      "the corrected statement is required to reconstruct the proven prior revision",
    );
    sql = sql.replace(corrected, historical);
  }
  process.stdout.write(`${JSON.stringify(validateMigration(sql))}\n`);
} else {
  const currentSql = readFileSync(migrationPath, "utf8");

  test("the real WP08 settings INSERT contains the approved JSON values and types", () => {
    const result = validateMigration(currentSql);
    assert.deepEqual(result.settings, {
      client_text_credit_price: 10,
      operator_points_rule_version: "wp08-v1",
      gift_reward_precision_scale: 6,
    });
  });

  test("all direct jsonb literal casts in the WP08 migration are valid JSON", () => {
    assert.doesNotThrow(() => parseDirectJsonCasts(currentSql));
  });

  test("the proven historical unquoted rule-version literal is rejected by JSON.parse", () => {
    const historicalSql = currentSql.replace(
      `('operator_points_rule_version', '"wp08-v1"'::jsonb)`,
      `('operator_points_rule_version', 'wp08-v1'::jsonb)`,
    );
    assert.throws(() => validateMigration(historicalSql), SyntaxError);
  });
}
