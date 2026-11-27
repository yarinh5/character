import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const giftRemovalSql = readFileSync(
  new URL("../../../migrations/20260721095659_remove_gifts_safely.sql", import.meta.url),
  "utf8",
);
const canonicalGiftSql = readFileSync(
  new URL("../../../migrations/20261105150000_wp07_gift_attachment_access.sql", import.meta.url),
  "utf8",
);
const clientLevelsSql = readFileSync(
  new URL(
    "../../../migrations/20261105190000_wp07_credit_requests_wp09_levels.sql",
    import.meta.url,
  ),
  "utf8",
);

function publicTableState(...migrations) {
  const tables = new Set();
  const statementPattern =
    /\b(CREATE|DROP)\s+TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?\s+public\.([a-z_][a-z0-9_]*)/giu;

  for (const migration of migrations) {
    for (const match of migration.matchAll(statementPattern)) {
      if (match[1].toUpperCase() === "CREATE") tables.add(match[2]);
      else tables.delete(match[2]);
    }
  }

  return tables;
}

function canonicalGiftRelations(sql) {
  const backfill = sql.match(
    /LEFT\s+JOIN\s+public\.([a-z_][a-z0-9_]*)\s+gift\s+ON\s+gift\.([a-z_][a-z0-9_]*)\s*=\s*message\.id/iu,
  );
  const trigger = sql.match(
    /CREATE\s+TRIGGER\s+count_client_gift_level[\s\S]*?\sON\s+public\.([a-z_][a-z0-9_]*)/iu,
  );

  assert.ok(backfill, "the level backfill must identify its canonical Gift relation");
  assert.ok(trigger, "the live level counter must identify its canonical Gift relation");

  return {
    backfillColumn: backfill[2],
    backfillTable: backfill[1],
    triggerTable: trigger[1],
  };
}

test("WP09 Gift level references survive the legacy Gift removal", () => {
  const availableTables = publicTableState(giftRemovalSql, canonicalGiftSql);
  const relations = canonicalGiftRelations(clientLevelsSql);

  assert.equal(availableTables.has("message_gifts"), false);
  assert.equal(availableTables.has("gift_attachment_purchases"), true);
  assert.equal(availableTables.has(relations.backfillTable), true);
  assert.equal(availableTables.has(relations.triggerTable), true);
});

test("WP09 counts the canonical purchased Gift message exactly at its stored message link", () => {
  const relations = canonicalGiftRelations(clientLevelsSql);
  const giftCounter = clientLevelsSql.match(
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+private\.count_client_gift_level\(\)[\s\S]*?\n\$\$;/iu,
  );

  assert.deepEqual(relations, {
    backfillColumn: "gift_message_id",
    backfillTable: "gift_attachment_purchases",
    triggerTable: "gift_attachment_purchases",
  });
  assert.ok(giftCounter, "the canonical Gift counter function must exist");
  assert.match(giftCounter[0], /NEW\.gift_message_id/iu);
  assert.match(
    clientLevelsSql,
    /AFTER\s+UPDATE\s+OF\s+gift_message_id,\s*status\s+ON\s+public\.gift_attachment_purchases/iu,
  );
  assert.match(
    clientLevelsSql,
    /OLD\.gift_message_id\s+IS\s+DISTINCT\s+FROM\s+NEW\.gift_message_id/iu,
  );
  assert.doesNotMatch(clientLevelsSql, /public\.message_gifts/iu);
});
