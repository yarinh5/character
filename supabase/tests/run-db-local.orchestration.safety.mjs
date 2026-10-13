import assert from "node:assert/strict";
import {
  assertValidatedTargetIdentity,
  formatDbSuiteFailure,
  runValidatedDbSuite,
  validateLocalDbTarget,
  validateTapOutput,
} from "./run-db-local.mjs";

const projectId = "qmgkmsarzfjnqltljkjl";
const config = (apiPort = 61421, dbPort = 61422, id = projectId) =>
  Buffer.from(`project_id = "${id}"\n\n[api]\nport = ${apiPort}\n\n[db]\nport = ${dbPort}\n`);
const container = (name, id, hostPort, containerPort, health = undefined) => ({
  Id: id.repeat(64),
  Name: `/${name}`,
  State: { Running: true, ...(health ? { Health: { Status: health } } : {}) },
  NetworkSettings: {
    Ports: { [containerPort]: [{ HostIp: "127.0.0.1", HostPort: `${hostPort}` }] },
  },
});
const targetInput = (overrides = {}) => ({
  configBytes: config(),
  status: { API_URL: "http://127.0.0.1:61421", DB_URL: "postgres://127.0.0.1:61422" },
  dbContainer: container(`supabase_db_${projectId}`, "a", 61422, "5432/tcp", "healthy"),
  apiContainer: container(`supabase_kong_${projectId}`, "b", 61421, "8000/tcp"),
  ...overrides,
});
function expectFailure(callback) {
  assert.throws(callback, /Refusing local database tests/);
}
function operations(overrides = {}) {
  const target = validateLocalDbTarget(targetInput());
  const events = [];
  return {
    events,
    validateTarget: () => target,
    verifyTarget: (expected) => assertValidatedTargetIdentity(expected, target),
    createTemporaryDirectory: (expected) => {
      events.push(["mkdir", expected.db.id]);
      return "/tmp/wp01-pgtap-safety";
    },
    copyTestFiles: (expected, temporaryDirectory) =>
      events.push(["copy", expected.db.id, temporaryDirectory]),
    executeSuite: (expected, temporaryDirectory) =>
      events.push(["sql", expected.db.id, temporaryDirectory]),
    cleanupTemporaryFiles: (expected, temporaryDirectory) =>
      events.push(["cleanup", expected.db.id, temporaryDirectory]),
    ...overrides,
  };
}
const expectedId = "a".repeat(64);
const accepted = validateLocalDbTarget(targetInput());
assert.equal(accepted.apiPort, 61421);
assert.equal(accepted.dbPort, 61422);
assert.equal(accepted.db.id, expectedId);
expectFailure(() =>
  validateLocalDbTarget(targetInput({ configBytes: config(61421, 61422, "wrong-project") })),
);
expectFailure(() =>
  validateLocalDbTarget(
    targetInput({
      status: { API_URL: "https://remote.invalid:61421", DB_URL: "postgres://127.0.0.1:61422" },
    }),
  ),
);
expectFailure(() =>
  validateLocalDbTarget(
    targetInput({
      dbContainer: container(`supabase_db_${projectId}`, "a", 61423, "5432/tcp", "healthy"),
    }),
  ),
);
expectFailure(() =>
  assertValidatedTargetIdentity(accepted, {
    ...accepted,
    db: { ...accepted.db, id: "c".repeat(64) },
  }),
);
{
  const suite = operations({
    validateTarget: () => {
      throw new Error("validation failed");
    },
  });
  assert.throws(() => runValidatedDbSuite(suite), /validation failed/);
  assert.deepEqual(suite.events, []);
}
{
  const suite = operations({
    verifyTarget: () => {
      throw new Error("identity changed");
    },
  });
  assert.throws(() => runValidatedDbSuite(suite), /identity changed/);
  assert.deepEqual(suite.events, []);
}
{
  const suite = operations({
    executeSuite: (target, temporaryDirectory) => {
      suite.events.push(["sql", target.db.id, temporaryDirectory]);
      throw new Error("intentional suite failure");
    },
  });
  assert.throws(() => runValidatedDbSuite(suite), /intentional suite failure/);
  assert.deepEqual(suite.events, [
    ["mkdir", expectedId],
    ["copy", expectedId, "/tmp/wp01-pgtap-safety"],
    ["sql", expectedId, "/tmp/wp01-pgtap-safety"],
    ["cleanup", expectedId, "/tmp/wp01-pgtap-safety"],
  ]);
}
{
  const suite = operations();
  runValidatedDbSuite(suite);
  assert.deepEqual(suite.events, [
    ["mkdir", expectedId],
    ["copy", expectedId, "/tmp/wp01-pgtap-safety"],
    ["sql", expectedId, "/tmp/wp01-pgtap-safety"],
    ["cleanup", expectedId, "/tmp/wp01-pgtap-safety"],
  ]);
}
console.log("run-db-local orchestration safety: 7 passed");

assert.equal(
  validateTapOutput(
    '{"messages":0,"ledger":0}\n1..2\nok 1 - first assertion\nset_config\nok 2 # SKIP feature disabled\n',
  ),
  2,
);
assert.equal(
  validateTapOutput(
    '1..2\n{"v4_3_e1.before_other":{"messages":0}}\nok 1 - setup remained valid\nplain setup output\nok 2 - second assertion\n',
  ),
  2,
);
for (const invalidTap of [
  "Bail out! interrupted\n",
  "1..1\nnot ok 1 - synthetic failure\n",
  "ok 1 - no plan\n",
  "1..1\n1..1\nok 1 - duplicate plan\n",
  "1..2\nok 1 - duplicate\nok 1 - duplicate\n",
  "1..2\nok 1 - missing second\n",
  "1..1\nok 2 - outside plan\n",
  "1..1\nok - missing ID\n",
  "1..bad\nok 1 - malformed plan\n",
  "1..1\nok malformed\n",
  "1..1\nnot ok malformed\n",
  "",
]) {
  expectFailure(() => validateTapOutput(invalidTap));
}
{
  let parserError;
  try {
    validateTapOutput("1..1\nnot ok 1 - synthetic failure\n");
  } catch (error) {
    parserError = error;
  }
  const diagnostic = formatDbSuiteFailure("/tmp/wp01-pgtap-test.sql", parserError);
  assert.match(
    diagnostic,
    /wp01-pgtap-test\.sql: Refusing local database tests: pgTAP assertion failed #1/,
  );
  assert.doesNotMatch(diagnostic, /postgres:|password|config\.toml/i);
}
