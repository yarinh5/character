import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import {
  SUPABASE_CLI_EXECUTABLE,
  assertReadAccessMigrationState,
  assertFrozenReadAccessTarget,
  buildReadAccessMigrationManifest,
  buildReadAccessResetArgs,
  createAttributionTrace,
  discoverReadAccessTarget,
  reportReadAccessRehearsalFailure,
  runAttributedOperation,
  runVerifiedReadAccessMutation,
  runVerifiedReadAccessReset,
  stageFailure,
} from "./wp01-read-access-117-to-118.mjs";

test("uses the PATH-bound Supabase CLI for the Linux-capable rehearsal", () => {
  assert.equal(SUPABASE_CLI_EXECUTABLE, "supabase");
});

test("isolates the 117 to 118 scenario and restores the full approved baseline", () => {
  const names = readdirSync(new URL("../../migrations", import.meta.url));
  const manifest = buildReadAccessMigrationManifest(names);
  const versions = manifest.map(({ version }) => version);
  assert.equal(versions.length, 118);
  assert.equal(versions.at(-1), "20261019071718");
  assert.ok(names.some((name) => name.startsWith("202611")));

  const base = ["db", "reset", "--local", "--no-seed"];
  assert.deepEqual(buildReadAccessResetArgs(), base);
  assert.deepEqual(buildReadAccessResetArgs("20261013113744"), [
    ...base,
    "--version",
    "20261013113744",
  ]);
  assert.throws(() => buildReadAccessResetArgs("latest"), /migration version/);
});

test("rejects a restored migration list with the same count and latest but different content", () => {
  const expected = ["20261013113744", "20261019071718", "20261101000000"];
  const actual = {
    count: 3,
    latest: "20261101000000",
    versions: ["20261013113744", "20261019071717", "20261101000000"],
    m117: true,
    m118: false,
  };
  assert.throws(() => assertReadAccessMigrationState(actual, expected), /migration history/);
});

function target(overrides = {}) {
  return {
    api: {
      id: "a".repeat(64),
      name: "api",
      internalPort: "8000/tcp",
      hostPort: 61421,
      running: true,
      health: "none",
    },
    apiPort: 61421,
    cliVersion: "2.95.4",
    configHash: "c".repeat(64),
    db: {
      id: "d".repeat(64),
      name: "db",
      internalPort: "5432/tcp",
      hostPort: 61422,
      running: true,
      health: "healthy",
    },
    dbPort: 61422,
    dockerContext: "desktop-linux",
    projectId: "qmgkmsarzfjnqltljkjl",
    ...overrides,
  };
}

function parsed(error) {
  return JSON.parse(reportReadAccessRehearsalFailure(error));
}

async function attributedSubprocessReport(error, options = {}) {
  const trace = createAttributionTrace("primary");
  let observed;
  try {
    await runAttributedOperation(
      {
        trace,
        operation: options.operation ?? "reset_m117_invoke",
        subprocess: options.subprocess ?? "supabase_db_reset_m117",
        timeoutMs: options.timeoutMs ?? 240_000,
      },
      async () => {
        throw error;
      },
    );
  } catch (caught) {
    observed = caught;
  }
  assert.ok(observed);
  const reportedError = stageFailure("verification", observed, trace, "primary");
  return { trace, report: parsed(reportedError), error: reportedError };
}

test("discovery retains running and DB-health guards without requiring API health", (t) => {
  const config = readFileSync(new URL("../../config.toml", import.meta.url), "utf8");
  const configuredPort = (section) =>
    Number(config.match(new RegExp(`\\[${section}\\][\\s\\S]*?\\nport\\s*=\\s*(\\d+)`))[1]);
  const apiPort = configuredPort("api");
  const dbPort = configuredPort("db");
  let apiRunning = true;
  let dbRunning = true;
  let dbHealth = "healthy";
  const mock = t.mock.method(childProcess, "execFileSync", (command, args) => {
    if (args[0] === "--version") {
      assert.equal(command, SUPABASE_CLI_EXECUTABLE);
      return "2.95.4";
    }
    if (args[0] === "context") return "desktop-linux";
    if (args[0] === "status") {
      return JSON.stringify({
        API_URL: `http://127.0.0.1:${apiPort}`,
        DB_URL: `postgresql://127.0.0.1:${dbPort}/postgres`,
      });
    }
    assert.equal(args[0], "inspect");
    const isDb = args[1] === "supabase_db_qmgkmsarzfjnqltljkjl";
    return JSON.stringify([
      {
        Name: `/${args[1]}`,
        Id: (isDb ? "d" : "a").repeat(64),
        State: {
          Running: isDb ? dbRunning : apiRunning,
          Health: { Status: isDb ? dbHealth : "unhealthy" },
        },
        NetworkSettings: {
          Ports: {
            [isDb ? "5432/tcp" : "8000/tcp"]: [{ HostPort: String(isDb ? dbPort : apiPort) }],
          },
        },
      },
    ]);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(discoverReadAccessTarget().api.health, "unhealthy");
    apiRunning = false;
    assert.throws(() => discoverReadAccessTarget(), /must be running/);
    apiRunning = true;
    dbRunning = false;
    assert.throws(() => discoverReadAccessTarget(), /must be running/);
    dbRunning = true;
    dbHealth = "starting";
    assert.throws(() => discoverReadAccessTarget(), /healthy/);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("API health telemetry changes preserve mutation order and reset-only DB rebind", async () => {
  const before = target();
  const order = [];
  let discoveries = 0;
  const discover = async () => {
    order.push("discover");
    return target({
      api: { ...before.api, health: discoveries++ % 2 ? "unhealthy" : "starting" },
    });
  };
  await runVerifiedReadAccessMutation({
    frozen: before,
    discover,
    mutate: async () => order.push("mutate"),
  });
  assert.deepEqual(order, ["discover", "mutate", "discover"]);
  const rebound = target({
    api: { ...before.api, health: "healthy" },
    db: { ...before.db, id: "e".repeat(64) },
  });
  assert.throws(() => assertFrozenReadAccessTarget(before, rebound), /DB identity drift/);
  const resetOrder = [];
  let resetDiscoveries = 0;
  const result = await runVerifiedReadAccessReset({
    frozen: before,
    discover: async () => {
      resetOrder.push("discover");
      return resetDiscoveries++ === 0
        ? target({ api: { ...before.api, health: "starting" } })
        : rebound;
    },
    reset: async () => resetOrder.push("reset"),
  });
  assert.deepEqual(resetOrder, ["discover", "reset", "discover"]);
  assert.equal(result.frozen.db.id, rebound.db.id);
});

for (const [field, changed] of [
  ["id", "b".repeat(64)],
  ["name", "other-api"],
  ["internalPort", "9999/tcp"],
  ["hostPort", 9999],
]) {
  test(`API ${field} drift blocks both migration and reset before invocation`, async () => {
    const before = target();
    const candidate = target({ api: { ...before.api, [field]: changed } });
    let mutations = 0;
    const mutate = async () => mutations++;
    await assert.rejects(
      runVerifiedReadAccessMutation({ frozen: before, discover: async () => candidate, mutate }),
      /API identity drift/,
    );
    await assert.rejects(
      runVerifiedReadAccessReset({
        frozen: before,
        discover: async () => candidate,
        reset: mutate,
      }),
      /API identity drift/,
    );
    assert.equal(mutations, 0);
  });
}

test("target drift before a migration causes zero mutation", async () => {
  let mutations = 0;
  await assert.rejects(
    runVerifiedReadAccessMutation({
      frozen: target(),
      discover: async () => target({ apiPort: 9999 }),
      mutate: async () => {
        mutations += 1;
      },
    }),
    /apiPort drift/,
  );
  assert.equal(mutations, 0);
});

test("target drift before cleanup reset causes zero reset", async () => {
  let resets = 0;
  await assert.rejects(
    runVerifiedReadAccessReset({
      frozen: target(),
      discover: async () => target({ dockerContext: "default" }),
      reset: async () => {
        resets += 1;
      },
    }),
    /dockerContext drift/,
  );
  assert.equal(resets, 0);
});

test("only a successful reset may rebind the verified database ID", async () => {
  const before = target();
  const after = target({
    db: { ...before.db, id: "e".repeat(64) },
  });
  let calls = 0;
  const result = await runVerifiedReadAccessReset({
    frozen: before,
    discover: async () => (calls++ === 0 ? before : after),
    reset: async () => "ok",
  });
  assert.equal(result.frozen.db.id, after.db.id);
  assert.throws(() => assertFrozenReadAccessTarget(before, after), /DB identity drift/);
});

test("reporter never emits raw nested subprocess or credential text", () => {
  const secret = "postgresql://user:password@127.0.0.1/db apikey=secret raw stderr";
  const error = new AggregateError([new Error(secret, { cause: new Error(`nested ${secret}`) })]);
  const output = reportReadAccessRehearsalFailure(error);
  assert.doesNotMatch(output, /password|apikey|stderr|postgresql:\/\//i);
  assert.match(output, /unknown_failure/);
});

test("a successful reset invocation followed by discovery failure is represented separately", async () => {
  let discoveries = 0;
  let resets = 0;
  const trace = createAttributionTrace("primary");
  let observed;
  try {
    await runVerifiedReadAccessReset({
      frozen: target(),
      discover: async () => {
        discoveries += 1;
        if (discoveries === 1) return target();
        throw new Error("synthetic discovery failure");
      },
      reset: async () => {
        resets += 1;
        return "ok";
      },
      trace,
      operations: {
        identityBefore: "reset_m117_identity_before",
        invoke: "reset_m117_invoke",
        discoverAfter: "reset_m117_discover_after",
        subprocess: "supabase_db_reset_m117",
      },
    });
  } catch (error) {
    observed = error;
  }
  assert.ok(observed);
  assert.equal(resets, 1);
  const invoke = trace.operations.find((event) => event.operation === "reset_m117_invoke");
  const discovery = trace.operations.find(
    (event) => event.operation === "reset_m117_discover_after",
  );
  assert.equal(invoke.completed, true);
  assert.equal(Object.hasOwn(invoke, "exitCode"), false, "unknown is not reported as exit 0");
  assert.equal(discovery.completed, false);
  assert.equal(parsed(observed).failures[0].operation, "reset_m117_discover_after");
});

test("cleanup identity drift is attributed and causes zero reset invocations", async () => {
  let resets = 0;
  const trace = createAttributionTrace("cleanup");
  let observed;
  try {
    await runVerifiedReadAccessReset({
      frozen: target(),
      discover: async () => target({ dockerContext: "default" }),
      reset: async () => {
        resets += 1;
      },
      trace,
      operations: {
        identityBefore: "cleanup_identity_before",
        invoke: "cleanup_invoke",
        discoverAfter: "cleanup_discover_after",
        subprocess: "supabase_db_reset_m118",
      },
    });
  } catch (error) {
    observed = error;
  }
  assert.ok(observed);
  assert.equal(resets, 0);
  const failure = parsed(observed).failures[0];
  assert.equal(failure.relation, "cleanup");
  assert.equal(failure.operation, "cleanup_identity_before");
});

test("numeric subprocess exit code is preserved without raw output", async () => {
  const trace = createAttributionTrace("primary");
  const failure = new Error("secret stderr apikey=do-not-print");
  failure.status = 17;
  let observed;
  try {
    await runAttributedOperation(
      {
        trace,
        operation: "migration_up_invoke",
        subprocess: "supabase_migration_up",
      },
      async () => {
        throw failure;
      },
    );
  } catch (error) {
    observed = error;
  }
  const output = reportReadAccessRehearsalFailure(observed);
  assert.match(output, /"exitCode":17/);
  assert.match(output, /"operation":"migration_up_invoke"/);
  assert.doesNotMatch(output, /secret|apikey|stderr|do-not-print/i);
});

test("recognized subprocess output produces a closed safe reason without raw canaries", async () => {
  const failure = new Error("wrapped password=do-not-print", {
    cause: new Error("nested apikey=do-not-print"),
  });
  failure.status = 17;
  failure.stdout = "SYNTHETIC_STDOUT_CANARY";
  failure.stderr = Buffer.from(
    "ERROR: migration command failed SYNTHETIC_STDERR_CANARY postgresql://secret",
  );
  const { report } = await attributedSubprocessReport(failure);
  const subprocessFailure = report.failures.find(
    (entry) => entry.category === "subprocess_failure",
  );
  const operation = report.operations.find((entry) => entry.operation === "reset_m117_invoke");
  assert.deepEqual(
    [subprocessFailure.reasonCode, subprocessFailure.diagnostic],
    ["migration_command_failed", { source: "stderr", gap: "none" }],
  );
  assert.deepEqual(
    [operation.reasonCode, operation.diagnostic],
    ["migration_command_failed", { source: "stderr", gap: "none" }],
  );
  assert.doesNotMatch(
    JSON.stringify(report),
    /password|apikey|postgresql|SYNTHETIC_(?:STDOUT|STDERR)_CANARY/i,
  );
});

test("unrecognized nonzero output remains unknown with an explicit diagnostic gap", async () => {
  const failure = new Error("wrapped secret");
  failure.status = 1;
  failure.stderr = "SYNTHETIC_UNRECOGNIZED_CANARY";
  const { report } = await attributedSubprocessReport(failure);
  const subprocessFailure = report.failures.find(
    (entry) => entry.category === "subprocess_failure",
  );
  assert.equal(subprocessFailure.reasonCode, "unknown");
  assert.deepEqual(subprocessFailure.diagnostic, {
    source: "stderr",
    gap: "reason_unrecognized",
  });
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_UNRECOGNIZED_CANARY/);
});

test("timeout and signal use process facts rather than output text", async () => {
  const timeout = new Error("secret timeout output");
  timeout.status = 1;
  timeout.code = "ETIMEDOUT";
  timeout.killed = true;
  timeout.stderr = "SYNTHETIC_TIMEOUT_CANARY";
  const timeoutReport = (await attributedSubprocessReport(timeout)).report;
  const timeoutFailure = timeoutReport.failures.find(
    (entry) => entry.category === "subprocess_failure",
  );
  assert.equal(timeoutFailure.reasonCode, "subprocess_timeout");
  assert.deepEqual(timeoutFailure.diagnostic, { source: "process_state", gap: "none" });
  assert.equal(timeoutFailure.timeoutMs, 240_000);

  const signal = new Error("secret signal output");
  signal.signal = "SIGTERM";
  signal.stderr = "SYNTHETIC_SIGNAL_CANARY";
  const signalReport = (await attributedSubprocessReport(signal)).report;
  const signalFailure = signalReport.failures.find(
    (entry) => entry.category === "subprocess_failure",
  );
  assert.equal(signalFailure.reasonCode, "subprocess_signal");
  assert.deepEqual(signalFailure.diagnostic, { source: "process_state", gap: "none" });
  assert.equal(signalFailure.signal, "SIGTERM");
});

test("missing malformed and oversized output produce distinct closed gaps", async () => {
  const cases = [
    [{ status: 1 }, "output_missing"],
    [{ status: 1, stderr: { secret: "SYNTHETIC_OBJECT_CANARY" } }, "output_unavailable"],
    [{ status: 1, stderr: `migration failed ${"x".repeat(20_000)}` }, "output_oversized"],
  ];
  for (const [properties, gap] of cases) {
    const failure = new Error("wrapped SYNTHETIC_WRAPPED_CANARY");
    Object.assign(failure, properties);
    const { report } = await attributedSubprocessReport(failure);
    const subprocessFailure = report.failures.find(
      (entry) => entry.category === "subprocess_failure",
    );
    assert.equal(subprocessFailure.reasonCode, "unknown");
    assert.equal(subprocessFailure.diagnostic.gap, gap);
    assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_(?:OBJECT|WRAPPED)_CANARY/);
  }
});

test("successful subprocess operations do not invent failure diagnostics", async () => {
  const trace = createAttributionTrace("primary");
  await runAttributedOperation(
    {
      trace,
      operation: "reset_m117_invoke",
      subprocess: "supabase_db_reset_m117",
      timeoutMs: 240_000,
    },
    async () => "ok",
  );
  const operation = trace.operations.find((entry) => entry.operation === "reset_m117_invoke");
  assert.equal(operation.completed, true);
  assert.equal(Object.hasOwn(operation, "reasonCode"), false);
  assert.equal(Object.hasOwn(operation, "diagnostic"), false);
});

test("assertion and migration invocation failures remain distinguishable", async () => {
  const assertionTrace = createAttributionTrace("primary");
  let assertionError;
  try {
    await runAttributedOperation(
      {
        trace: assertionTrace,
        operation: "post_upgrade_state",
        assertionCategory: "state",
      },
      async () => assert.equal(117, 118),
    );
  } catch (error) {
    assertionError = error;
  }
  const invocationTrace = createAttributionTrace("primary");
  let invocationError;
  try {
    await runAttributedOperation(
      {
        trace: invocationTrace,
        operation: "migration_up_invoke",
        subprocess: "supabase_migration_up",
      },
      async () => {
        const error = new Error("synthetic invocation failure");
        error.status = 9;
        throw error;
      },
    );
  } catch (error) {
    invocationError = error;
  }
  const assertionFailure = parsed(assertionError).failures[0];
  const invocationFailure = parsed(invocationError).failures[0];
  assert.deepEqual(
    [assertionFailure.category, assertionFailure.operation, assertionFailure.assertionCategory],
    ["assertion_failure", "post_upgrade_state", "state"],
  );
  assert.deepEqual(
    [invocationFailure.category, invocationFailure.operation, invocationFailure.exitCode],
    ["subprocess_failure", "migration_up_invoke", 9],
  );
});

test("nested cleanup failure keeps cleanup relation and secrets out of output", async () => {
  const cleanupTrace = createAttributionTrace("cleanup");
  let cleanupError;
  try {
    await runAttributedOperation(
      {
        trace: cleanupTrace,
        operation: "cleanup_residue",
        assertionCategory: "residue",
      },
      async () => {
        throw new Error("postgresql://user:password@host/db apikey=secret raw stderr");
      },
    );
  } catch (error) {
    cleanupError = error;
  }
  const output = reportReadAccessRehearsalFailure(
    new AggregateError([new Error("primary secret token"), new AggregateError([cleanupError])]),
  );
  assert.match(output, /"relation":"cleanup"/);
  assert.match(output, /"operation":"cleanup_residue"/);
  assert.doesNotMatch(output, /password|apikey|stderr|postgresql:\/\/|token/i);
});

test("mutation helpers invoke each authorized mutation once and preserve order", async () => {
  const resetOrder = [];
  let resetCalls = 0;
  await runVerifiedReadAccessReset({
    frozen: target(),
    discover: async () => {
      resetOrder.push("discover");
      return target();
    },
    reset: async () => {
      resetOrder.push("reset");
      resetCalls += 1;
    },
    trace: createAttributionTrace("primary"),
    operations: {
      identityBefore: "reset_m117_identity_before",
      invoke: "reset_m117_invoke",
      discoverAfter: "reset_m117_discover_after",
      subprocess: "supabase_db_reset_m117",
    },
  });
  assert.equal(resetCalls, 1);
  assert.deepEqual(resetOrder, ["discover", "reset", "discover"]);

  const migrationOrder = [];
  let migrationCalls = 0;
  await runVerifiedReadAccessMutation({
    frozen: target(),
    discover: async () => {
      migrationOrder.push("discover");
      return target();
    },
    mutate: async () => {
      migrationOrder.push("migration");
      migrationCalls += 1;
    },
    trace: createAttributionTrace("primary"),
    operations: {
      identityBefore: "migration_up_identity_before",
      invoke: "migration_up_invoke",
      identityAfter: "migration_up_identity_after",
      subprocess: "supabase_migration_up",
    },
  });
  assert.equal(migrationCalls, 1);
  assert.deepEqual(migrationOrder, ["discover", "migration", "discover"]);
});

test("stage attribution selects the started failure instead of a later not-invoked operation", async () => {
  const trace = createAttributionTrace("primary", () => new Date(), [
    "migration_up_invoke",
    "migration_up_identity_after",
    "post_upgrade_state",
  ]);
  let operationError;
  try {
    await runAttributedOperation(
      {
        trace,
        operation: "migration_up_invoke",
        subprocess: "supabase_migration_up",
      },
      async () => {
        const error = new Error("synthetic migration failure");
        error.status = 7;
        throw error;
      },
    );
  } catch (error) {
    operationError = error;
  }
  const output = parsed(stageFailure("verification", operationError, trace, "primary"));
  assert.equal(output.failures[0].operation, "migration_up_invoke");
  assert.deepEqual(
    output.operations.map(({ operation, started }) => [operation, started]),
    [
      ["migration_up_invoke", true],
      ["migration_up_identity_after", false],
      ["post_upgrade_state", false],
    ],
  );
});

const fixturePath = process.env.WP015_UPGRADE_EVIDENCE_FIXTURE;
if (fixturePath) {
  const failure = new Error("wrapped SYNTHETIC_FIXTURE_SECRET");
  failure.status = 19;
  failure.stderr = Buffer.from(
    "ERROR: migration command failed SYNTHETIC_FIXTURE_STDERR postgresql://secret",
  );
  const { error } = await attributedSubprocessReport(failure);
  const report = reportReadAccessRehearsalFailure(error);
  assert.doesNotMatch(report, /SYNTHETIC_FIXTURE|postgresql|secret/i);
  writeFileSync(fixturePath, report, { encoding: "utf8", flag: "wx" });
}
