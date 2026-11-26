import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalDbTargetError,
  PgTapEvidenceError,
  PgTapProcessError,
  assertValidatedTargetIdentity,
  executePgTapFile,
  formatDbSuiteFailure,
  preservePgTapProcessEvidence,
  resolveLocalTestBinding,
  runValidatedDbSuite,
  validateLocalDbTarget,
  validateTapOutput,
  waitForStableLocalDbTarget,
} from "./run-db-local.mjs";

const projectId = "qmgkmsarzfjnqltljkjl";
const config = (apiPort = 61421, dbPort = 61422, id = projectId) =>
  Buffer.from(`project_id = "${id}"\n\n[api]\nport = ${apiPort}\n\n[db]\nport = ${dbPort}\n`);
const container = (name, id, hostPort, containerPort, health = undefined, running = true) => ({
  Id: id.repeat(64),
  Name: `/${name}`,
  State: { Running: running, ...(health ? { Health: { Status: health } } : {}) },
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
const withBindings = (value, containerPort, bindings) => ({
  ...value,
  NetworkSettings: { Ports: { [containerPort]: bindings } },
});
const target = (id = "a") =>
  validateLocalDbTarget(
    targetInput({
      dbContainer: container(`supabase_db_${projectId}`, id, 61422, "5432/tcp", "healthy"),
    }),
  );
function expectFailure(callback, expression = /Refusing local database tests/) {
  assert.throws(callback, expression);
}
function capturedFailure(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a failure");
}
function virtualClock() {
  let elapsed = 0;
  const sleeps = [];
  return {
    now: () => elapsed,
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      elapsed += milliseconds;
    },
    sleeps,
  };
}
function sequence(entries) {
  let index = 0;
  return () => {
    const entry = entries[Math.min(index, entries.length - 1)];
    index += 1;
    if (entry instanceof Error) throw entry;
    return entry;
  };
}
function retryable(code, message) {
  return new LocalDbTargetError(code, message, { retryable: true });
}
function suiteOperations(stableTarget, overrides = {}) {
  const events = [];
  return {
    events,
    target: stableTarget,
    verifyTarget: (expected) => assertValidatedTargetIdentity(expected, stableTarget),
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
const responsibilityFixtureSql = readFileSync(
  new URL("./database/v4_3/active_new_responsibility_send.test.sql", import.meta.url),
  "utf8",
);
const activeConversationFixture = responsibilityFixtureSql.match(
  /WITH active_conversation_clock AS \([\s\S]*?INSERT INTO public\.conversation_work_items/,
);
assert.ok(activeConversationFixture, "active-cycle fixture must define a shared server clock");
assert.match(
  activeConversationFixture[0],
  /SELECT clock_timestamp\(\) AS activity_at/,
  "active-cycle fixture must use the PostgreSQL server clock",
);
assert.match(
  activeConversationFixture[0],
  /activity_at,\s*activity_at \+ interval '180 seconds'/,
  "active-cycle fixture must derive its expiry from the same anchor by exactly 180 seconds",
);
const accepted = target();
assert.equal(accepted.apiPort, 61421);
assert.equal(accepted.dbPort, 61422);
assert.equal(accepted.db.id, expectedId);
const isolatedId = "wp12-isolated-01";
const isolatedEngine = "9bfee319-9d33-4def-8cc7-0e08fd977777";
assert.deepEqual(resolveLocalTestBinding({}), { projectId, engineId: null });
const isolatedBinding = resolveLocalTestBinding({
  PRODUCT_TEST_PROJECT_ID: isolatedId,
  PRODUCT_TEST_ENGINE_ID: isolatedEngine,
});
assert.deepEqual(isolatedBinding, { projectId: isolatedId, engineId: isolatedEngine });
for (const environment of [
  { PRODUCT_TEST_PROJECT_ID: projectId, PRODUCT_TEST_ENGINE_ID: isolatedEngine },
  { PRODUCT_TEST_PROJECT_ID: isolatedId },
  { PRODUCT_TEST_ENGINE_ID: isolatedEngine },
  { PRODUCT_TEST_PROJECT_ID: "../qa", PRODUCT_TEST_ENGINE_ID: isolatedEngine },
]) {
  expectFailure(() => resolveLocalTestBinding(environment));
}
const labeledContainer = (name, id, port, containerPort, health) => ({
  ...container(name, id, port, containerPort, health),
  Config: { Labels: { "com.supabase.cli.project": isolatedId } },
});
const isolatedTarget = targetInput({
  configBytes: config(61421, 61422, isolatedId),
  dbContainer: labeledContainer(`supabase_db_${isolatedId}`, "a", 61422, "5432/tcp", "healthy"),
  apiContainer: labeledContainer(`supabase_kong_${isolatedId}`, "b", 61421, "8000/tcp"),
  binding: isolatedBinding,
  engineId: isolatedEngine,
});
assert.equal(validateLocalDbTarget(isolatedTarget).projectId, isolatedId);
expectFailure(() => validateLocalDbTarget({ ...isolatedTarget, engineId: "other-engine" }));
expectFailure(() => validateLocalDbTarget({ ...isolatedTarget, configBytes: config() }));
expectFailure(() =>
  validateLocalDbTarget({
    ...isolatedTarget,
    dbContainer: container(`supabase_db_${isolatedId}`, "a", 61422, "5432/tcp", "healthy"),
  }),
);
assert.equal(
  validateLocalDbTarget(
    targetInput({
      configBytes: config(61521, 61522),
      status: { API_URL: "http://127.0.0.1:61521", DB_URL: "postgres://127.0.0.1:61522" },
      dbContainer: container(`supabase_db_${projectId}`, "a", 61522, "5432/tcp", "healthy"),
      apiContainer: container(`supabase_kong_${projectId}`, "b", 61521, "8000/tcp"),
    }),
  ).apiPort,
  61521,
);
assert.doesNotThrow(() =>
  validateLocalDbTarget(
    targetInput({
      apiContainer: withBindings(
        container(`supabase_kong_${projectId}`, "b", 61421, "8000/tcp"),
        "8000/tcp",
        [
          { HostIp: "0.0.0.0", HostPort: "61421" },
          { HostIp: "::", HostPort: "61421" },
        ],
      ),
    }),
  ),
);
for (const apiBindings of [
  [
    { HostIp: "127.0.0.1", HostPort: "61421" },
    { HostIp: "192.0.2.10", HostPort: "61421" },
  ],
  [
    { HostIp: "127.0.0.1", HostPort: "61421" },
    { HostIp: "::1", HostPort: "61422" },
  ],
  null,
]) {
  expectFailure(() =>
    validateLocalDbTarget(
      targetInput({
        apiContainer: withBindings(
          container(`supabase_kong_${projectId}`, "b", 61421, "8000/tcp"),
          "8000/tcp",
          apiBindings,
        ),
      }),
    ),
  );
}
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
  const clock = virtualClock();
  const stable = waitForStableLocalDbTarget({
    discoverTarget: sequence([target(), target(), target()]),
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.deepEqual(stable, target());
  assert.deepEqual(clock.sleeps, [1000, 1000]);
}
{
  const clock = virtualClock();
  const replacement = target("c");
  const stable = waitForStableLocalDbTarget({
    discoverTarget: sequence([
      target(),
      retryable("db_unavailable", "database container is restarting"),
      replacement,
      replacement,
      replacement,
    ]),
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(stable.db.id, "c".repeat(64));
  assert.deepEqual(clock.sleeps, [1000, 1000, 1000, 1000]);
}
{
  const clock = virtualClock();
  const failure = capturedFailure(() =>
    waitForStableLocalDbTarget({
      discoverTarget: sequence([target(), target("c"), target(), target("c")]),
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 2500,
    }),
  );
  assert.match(failure.message, /did not stabilize before timeout/);
  assert.deepEqual(clock.sleeps, [1000, 1000, 500]);
}
{
  const transientFailures = [
    capturedFailure(() => validateLocalDbTarget(targetInput({ dbContainer: undefined }))),
    capturedFailure(() =>
      validateLocalDbTarget(
        targetInput({
          dbContainer: container(`supabase_db_${projectId}`, "a", 61422, "5432/tcp", "starting"),
        }),
      ),
    ),
    capturedFailure(() =>
      validateLocalDbTarget(
        targetInput({
          dbContainer: container(`supabase_db_${projectId}`, "a", 61422, "5432/tcp", "unhealthy"),
        }),
      ),
    ),
    capturedFailure(() =>
      validateLocalDbTarget(
        targetInput({
          dbContainer: container(
            `supabase_db_${projectId}`,
            "a",
            61422,
            "5432/tcp",
            "healthy",
            false,
          ),
        }),
      ),
    ),
  ];
  for (const failure of transientFailures) {
    assert.equal(failure instanceof LocalDbTargetError && failure.retryable, true);
  }
  const clock = virtualClock();
  assert.doesNotThrow(() =>
    waitForStableLocalDbTarget({
      discoverTarget: sequence([...transientFailures, target(), target(), target()]),
      now: clock.now,
      sleep: clock.sleep,
    }),
  );
}
for (const { name, discoverTarget } of [
  {
    name: "API identity drift",
    discoverTarget: () => {
      throw new LocalDbTargetError("api_identity", "API container identity changed");
    },
  },
  {
    name: "project drift",
    discoverTarget: () =>
      validateLocalDbTarget(targetInput({ configBytes: config(61421, 61422, "wrong") })),
  },
  {
    name: "status port drift",
    discoverTarget: () =>
      validateLocalDbTarget(
        targetInput({
          status: { API_URL: "http://127.0.0.1:61420", DB_URL: "postgres://127.0.0.1:61422" },
        }),
      ),
  },
  {
    name: "database mapping drift",
    discoverTarget: () =>
      validateLocalDbTarget(
        targetInput({
          dbContainer: container(`supabase_db_${projectId}`, "a", 61423, "5432/tcp", "healthy"),
        }),
      ),
  },
]) {
  const clock = virtualClock();
  expectFailure(
    () =>
      waitForStableLocalDbTarget({
        discoverTarget,
        now: clock.now,
        sleep: clock.sleep,
      }),
    /Refusing local database tests/,
  );
  assert.deepEqual(clock.sleeps, [], `${name} must fail before sleeping`);
}
{
  const clock = virtualClock();
  const acquisitionEvents = [];
  const stable = waitForStableLocalDbTarget({
    discoverTarget: () => {
      acquisitionEvents.push("discover");
      return target();
    },
    now: clock.now,
    sleep: clock.sleep,
  });
  const suite = suiteOperations(stable);
  runValidatedDbSuite(suite);
  assert.deepEqual(acquisitionEvents, ["discover", "discover", "discover"]);
  assert.equal(suite.events[0][0], "mkdir");
}
{
  const suite = suiteOperations(target(), {
    verifyTarget: (() => {
      let checks = 0;
      return () => {
        checks += 1;
        if (checks === 2)
          throw new Error("validated target changed after temporary directory creation");
      };
    })(),
  });
  assert.throws(() => runValidatedDbSuite(suite), /validated target changed/);
  assert.deepEqual(suite.events, [
    ["mkdir", expectedId],
    ["cleanup", expectedId, "/tmp/wp01-pgtap-safety"],
  ]);
}
{
  const suite = suiteOperations(target(), {
    executeSuite: (stableTarget, temporaryDirectory) => {
      suite.events.push(["sql", stableTarget.db.id, temporaryDirectory]);
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
  const suite = suiteOperations(target());
  runValidatedDbSuite(suite);
  assert.deepEqual(suite.events, [
    ["mkdir", expectedId],
    ["copy", expectedId, "/tmp/wp01-pgtap-safety"],
    ["sql", expectedId, "/tmp/wp01-pgtap-safety"],
    ["cleanup", expectedId, "/tmp/wp01-pgtap-safety"],
  ]);
}
{
  const clock = virtualClock();
  const failure = capturedFailure(() =>
    waitForStableLocalDbTarget({
      discoverTarget: sequence([
        retryable("db_unhealthy", "postgres://user:password@127.0.0.1:61422 is unhealthy"),
      ]),
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 1,
    }),
  );
  assert.match(failure.message, /manual inspection is required/);
  assert.doesNotMatch(failure.message, /password|postgres:\/\//i);
}
console.log("run-db-local orchestration safety: 14 passed");

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

const pgTapResult = (overrides = {}) => ({
  status: 0,
  signal: null,
  stdout: "1..1\nok 1 - valid\n",
  stderr: "",
  error: undefined,
  ...overrides,
});

{
  const evidenceRoot = mkdtempSync(join(tmpdir(), "db-tap-not-ok-"));
  const tap = [
    "1..1",
    "not ok 1 - Cycle owner can send an operator message",
    "# Failed test 'Cycle owner can send an operator message'",
    "# handling_cycle_expired",
    "",
  ].join("\n");
  try {
    const failure = capturedFailure(() =>
      executePgTapFile({
        evidenceRoot,
        path: "/tmp/active_new_responsibility_send.test.sql",
        runner: () => pgTapResult({ stdout: tap, stderr: "psql diagnostic\n" }),
        target: target(),
        testFile: "/candidate/active_new_responsibility_send.test.sql",
      }),
    );
    assert.match(failure.message, /pgTAP assertion failed #1/);
    const files = readdirSync(join(evidenceRoot, "db-tap"));
    assert.equal(files.length, 1);
    const evidence = JSON.parse(readFileSync(join(evidenceRoot, "db-tap", files[0]), "utf8"));
    assert.equal(evidence.process.stdout, tap);
    assert.equal(evidence.process.stderr, "psql diagnostic\n");
    assert.equal(evidence.process.exitCode, 0);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
}

{
  const evidenceRoot = mkdtempSync(join(tmpdir(), "db-tap-nonzero-"));
  try {
    const failure = capturedFailure(() =>
      executePgTapFile({
        evidenceRoot,
        path: "/tmp/partial.test.sql",
        runner: () =>
          pgTapResult({ status: 7, stdout: "1..2\nok 1 - partial\n", stderr: "query failed\n" }),
        target: target(),
        testFile: "/candidate/partial.test.sql",
      }),
    );
    assert.equal(failure instanceof PgTapProcessError, true);
    const [file] = readdirSync(join(evidenceRoot, "db-tap"));
    const evidence = JSON.parse(readFileSync(join(evidenceRoot, "db-tap", file), "utf8"));
    assert.equal(evidence.process.exitCode, 7);
    assert.equal(evidence.process.stdout, "1..2\nok 1 - partial\n");
    assert.equal(evidence.process.stderr, "query failed\n");
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
}

{
  const evidenceRoot = mkdtempSync(join(tmpdir(), "db-tap-write-failure-"));
  try {
    const failure = capturedFailure(() =>
      executePgTapFile({
        evidenceRoot,
        path: "/tmp/nonzero.test.sql",
        runner: () => pgTapResult({ status: 9, stderr: "primary SQL failure\n" }),
        target: target(),
        testFile: "/candidate/nonzero.test.sql",
        writeEvidence: () => {
          throw new Error("evidence disk unavailable");
        },
      }),
    );
    assert.equal(failure instanceof PgTapEvidenceError, true);
    assert.equal(failure.primaryFailure instanceof PgTapProcessError, true);
    assert.match(failure.message, /SQL execution failed.*evidence preservation also failed/i);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
}

{
  const evidenceRoot = mkdtempSync(join(tmpdir(), "db-tap-separate-processes-"));
  const moduleUrl = new URL("./run-db-local.mjs", import.meta.url).href;
  const childScript = `
    import { preservePgTapProcessEvidence } from ${JSON.stringify(moduleUrl)};
    preservePgTapProcessEvidence({
      evidenceRoot: process.env.RUN_EVIDENCE,
      result: { status: 0, signal: null, stdout: process.env.TAP_PAYLOAD, stderr: "", error: undefined },
      testFile: "/candidate/active_new_responsibility_send.test.sql"
    });
  `;
  try {
    const first = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
      encoding: "utf8",
      env: { ...process.env, RUN_EVIDENCE: evidenceRoot, TAP_PAYLOAD: "first invocation" },
    });
    assert.equal(first.status, 0, first.stderr);
    const directory = join(evidenceRoot, "db-tap");
    const [firstName] = readdirSync(directory);
    const firstBytes = readFileSync(join(directory, firstName));

    const second = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
      encoding: "utf8",
      env: { ...process.env, RUN_EVIDENCE: evidenceRoot, TAP_PAYLOAD: "second invocation" },
    });
    assert.equal(second.status, 0, second.stderr);
    const files = readdirSync(directory).sort();
    assert.equal(files.length, 2);
    assert.deepEqual(readFileSync(join(directory, firstName)), firstBytes);
    assert.notEqual(files[0], files[1]);
    const payloads = files.map(
      (name) => JSON.parse(readFileSync(join(directory, name), "utf8")).process.stdout,
    );
    assert.deepEqual(new Set(payloads), new Set(["first invocation", "second invocation"]));
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
}
