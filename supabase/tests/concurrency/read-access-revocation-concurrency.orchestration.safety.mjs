import assert from "node:assert/strict";
import test from "node:test";
import {
  assertFixtureGraphRestored,
  buildOwnedFixtureCleanupSql,
  reportReadAccessConcurrencyFailure,
  runOperationWithCleanup,
  runVerifiedConcurrencyMutation,
} from "./read-access-revocation-concurrency.mjs";

function target(overrides = {}) {
  return {
    api: { id: "a".repeat(64), name: "api", internalPort: "8000/tcp", hostPort: 61421 },
    apiPort: 61421,
    cliVersion: "2.95.4",
    configHash: "c".repeat(64),
    db: { id: "d".repeat(64), name: "db", internalPort: "5432/tcp", hostPort: 61422 },
    dbPort: 61422,
    dockerContext: "desktop-linux",
    projectId: "qmgkmsarzfjnqltljkjl",
    ...overrides,
  };
}

test("config, context, endpoint, mapping, or container drift prevents fixture mutation", async () => {
  for (const drift of [
    { configHash: "x".repeat(64) },
    { dockerContext: "default" },
    { apiPort: 9999 },
    { db: { ...target().db, hostPort: 9998 } },
    { api: { ...target().api, id: "b".repeat(64) } },
  ]) {
    let mutations = 0;
    await assert.rejects(
      runVerifiedConcurrencyMutation({
        frozen: target(),
        discover: async () => target(drift),
        mutate: async () => {
          mutations += 1;
        },
      }),
    );
    assert.equal(mutations, 0);
  }
});

test("drift before cleanup prevents cleanup mutation", async () => {
  let cleanups = 0;
  await assert.rejects(
    runVerifiedConcurrencyMutation({
      frozen: target(),
      discover: async () => target({ dbPort: 9997 }),
      mutate: async () => {
        cleanups += 1;
      },
    }),
  );
  assert.equal(cleanups, 0);
});

test("concurrency reporter does not expose raw nested credentials or subprocess output", () => {
  const secret = "postgresql://user:password@localhost/db apikey=secret raw stderr";
  const output = reportReadAccessConcurrencyFailure(
    new AggregateError([new Error(secret, { cause: new Error(`nested ${secret}`) })]),
  );
  assert.doesNotMatch(output, /password|apikey|stderr|postgresql:\/\//i);
  assert.match(output, /unknown_failure/);
});

const ownedFixture = {
  client: "00000000-0000-4000-8000-000000000101",
  user: "00000000-0000-4000-8000-000000000102",
  operator: "00000000-0000-4000-8000-000000000103",
  character: "00000000-0000-4000-8000-000000000104",
  conversation: "00000000-0000-4000-8000-000000000105",
};

test("fixture graph residue in characters, notifications, or analytics is a failure", () => {
  const baseline = { characters: 0, notifications: 0, analytics: 0 };
  for (const key of Object.keys(baseline)) {
    assert.throws(() => assertFixtureGraphRestored({ ...baseline, [key]: 1 }, baseline));
  }
  assert.doesNotThrow(() => assertFixtureGraphRestored(baseline, baseline));
});

test("cleanup captures signup analytics and profile ids before deleting parent users", () => {
  const sql = buildOwnedFixtureCleanupSql(ownedFixture);
  const captureProfiles = sql.indexOf("CREATE TEMP TABLE wp01_owned_profiles");
  const captureAnalytics = sql.indexOf("CREATE TEMP TABLE wp01_owned_analytics");
  const deleteUsers = sql.indexOf("DELETE FROM auth.users");
  assert.ok(captureProfiles >= 0);
  assert.ok(captureAnalytics > captureProfiles);
  assert.ok(deleteUsers > captureAnalytics);
  assert.match(sql, /actor_user_id/);
  assert.match(sql, /metadata->>'profile_id'/);
});

test("cleanup is id-bound and never selects an unrelated same-time sentinel", () => {
  const sentinel = "00000000-0000-4000-8000-000000000999";
  const sql = buildOwnedFixtureCleanupSql(ownedFixture);
  assert.match(sql, new RegExp(ownedFixture.character));
  assert.doesNotMatch(sql, new RegExp(sentinel));
  assert.doesNotMatch(sql, /created_at\s*(?:>=|<=|BETWEEN)/i);
  assert.doesNotMatch(sql, /TRUNCATE/i);
});

test("partial fixture ownership still produces a bounded cleanup transaction", () => {
  const sql = buildOwnedFixtureCleanupSql({ client: ownedFixture.client });
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;$/);
  assert.match(sql, new RegExp(ownedFixture.client));
  assert.doesNotMatch(sql, /IN\s*\(\s*\)/);
});

test("cleanup failure preserves the primary failure and remains nonzero", async () => {
  const secret = "postgresql://user:password@localhost/db apikey=secret raw stderr";
  await assert.rejects(
    runOperationWithCleanup({
      operation: async () => {
        throw new Error(secret);
      },
      cleanup: async () => {
        throw new Error(`cleanup ${secret}`);
      },
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      const output = reportReadAccessConcurrencyFailure(error);
      assert.match(output, /primary_failure/);
      assert.match(output, /cleanup_failure/);
      assert.doesNotMatch(output, /password|apikey|stderr|postgresql:\/\//i);
      return true;
    },
  );
});
