import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireStableLocalTarget,
  assertCopiedConfigMatches,
  assertMigrationAbsenceResult,
  assertExactUpgradeDifference,
  assertBeforeVersionsInManifest,
  buildThroughVersionManifest,
  assertIsolatedMigrationManifest,
  createIsolatedUpgradeWorkdir,
  runResetWithVerifiedState,
  assertImmutableTargetSnapshot,
  inspectReadyTargetSnapshot,
  assertValidatedTargetIdentity,
  rebindTargetAfterDatabaseReset,
  ResetReadinessError,
  resetAndWait,
  runValidatedUpgrade,
  waitForValidatedTargetAfterReset,
  validateLocalTarget,
} from "./wp01-shadow-113-to-116.mjs";

const projectId = "qmgkmsarzfjnqltljkjl";

function targetFixture({
  apiHost = "127.0.0.1",
  apiPort = 61421,
  dbPort = 61422,
  dbHostPort = dbPort,
  project = projectId,
} = {}) {
  return {
    config: `[api]\nport = ${apiPort}\n\n[db]\nport = ${dbPort}\n\nproject_id = "${project}"\n`,
    status: {
      API_URL: `http://${apiHost}:${apiPort}`,
      DB_URL: `postgresql://127.0.0.1:${dbPort}/postgres`,
    },
    db: {
      Id: "a".repeat(64),
      Name: `/supabase_db_${projectId}`,
      State: { Running: true, Health: { Status: "healthy" } },
      NetworkSettings: { Ports: { "5432/tcp": [{ HostPort: String(dbHostPort) }] } },
    },
    api: {
      Id: "b".repeat(64),
      Name: `/supabase_kong_${projectId}`,
      State: { Running: true, Health: { Status: "healthy" } },
      NetworkSettings: { Ports: { "8000/tcp": [{ HostPort: String(apiPort) }] } },
    },
  };
}

test("validates only matching loopback project mappings", () => {
  const target = validateLocalTarget(targetFixture());
  assert.equal(target.projectId, projectId);
  assert.equal(target.apiPort, 61421);
  assert.equal(target.dbPort, 61422);
  assert.equal(target.dbContainer.id, "a".repeat(64));
  assert.equal(target.apiContainer.id, "b".repeat(64));
  assert.match(target.configHash, /^[a-f0-9]{64}$/);

  const rebound = {
    ...target,
    dbContainer: { ...target.dbContainer, id: "c".repeat(64) },
  };
  assert.deepEqual(rebindTargetAfterDatabaseReset(target, rebound), rebound);
  assert.throws(() =>
    rebindTargetAfterDatabaseReset(target, { ...rebound, configHash: "0".repeat(64) }),
  );

  assert.throws(() => validateLocalTarget(targetFixture({ project: "other_project" })));
  assert.throws(() => validateLocalTarget(targetFixture({ apiHost: "example.invalid" })));
  assert.throws(() => validateLocalTarget(targetFixture({ dbHostPort: 61423 })));
});

test("does not mutate or clean up when target validation fails", () => {
  const calls = [];

  assert.throws(() =>
    runValidatedUpgrade({
      validateTarget: () => {
        throw new Error("target rejected");
      },
      resetTo113: () => calls.push("reset"),
      upgrade: () => calls.push("upgrade"),
      cleanup: () => calls.push("cleanup"),
    }),
  );

  assert.deepEqual(calls, []);
});

test("does not reset when config or project identity changes before mutation", () => {
  const target = validateLocalTarget(targetFixture());

  for (const changedTarget of [
    { ...target, configHash: "0".repeat(64) },
    { ...target, projectId: "other_project" },
  ]) {
    const calls = [];
    assert.throws(
      () =>
        runValidatedUpgrade({
          validateTarget: () => target,
          verifyTarget: (actualTarget) =>
            assertValidatedTargetIdentity(actualTarget, changedTarget),
          resetTo113: () => calls.push("reset"),
          upgrade: () => calls.push("upgrade"),
          cleanup: () => calls.push("cleanup"),
        }),
      /validated local target identity changed/,
    );
    assert.deepEqual(calls, []);
  }
});

test("does not clean up against a changed target", () => {
  const target = validateLocalTarget(targetFixture());
  const changedTarget = { ...target, configHash: "0".repeat(64) };
  const calls = [];

  assert.throws(
    () =>
      runValidatedUpgrade({
        validateTarget: () => target,
        verifyTarget: (actualTarget) => {
          const currentTarget = calls.includes("upgrade") ? changedTarget : target;
          assertValidatedTargetIdentity(actualTarget, currentTarget);
        },
        resetTo113: () => calls.push("reset"),
        upgrade: () => calls.push("upgrade"),
        cleanup: () => calls.push("cleanup"),
      }),
    /validated local target identity changed/,
  );
  assert.deepEqual(calls, ["reset", "upgrade"]);
});

test("cleans up the validated target after reset begins or succeeds", () => {
  const target = validateLocalTarget(targetFixture());
  const resetFailureCalls = [];

  assert.throws(() =>
    runValidatedUpgrade({
      validateTarget: () => target,
      verifyTarget: (actualTarget) => assertValidatedTargetIdentity(actualTarget, target),
      resetTo113: (actualTarget) => {
        resetFailureCalls.push(["reset", actualTarget]);
        throw new Error("reset failed");
      },
      upgrade: () => resetFailureCalls.push(["upgrade", target]),
      cleanup: (actualTarget) => resetFailureCalls.push(["cleanup", actualTarget]),
    }),
  );
  assert.deepEqual(resetFailureCalls, [
    ["reset", target],
    ["cleanup", target],
  ]);

  const successCalls = [];
  const reboundTarget = {
    ...target,
    dbContainer: { ...target.dbContainer, id: "c".repeat(64) },
  };
  runValidatedUpgrade({
    validateTarget: () => target,
    verifyTarget: (actualTarget) => {
      assert.ok(actualTarget === target || actualTarget === reboundTarget);
    },
    resetTo113: (actualTarget) => {
      successCalls.push(["reset", actualTarget]);
      return reboundTarget;
    },
    upgrade: (actualTarget) => successCalls.push(["upgrade", actualTarget]),
    cleanup: (actualTarget) => successCalls.push(["cleanup", actualTarget]),
  });
  assert.deepEqual(successCalls, [
    ["reset", target],
    ["upgrade", reboundTarget],
    ["cleanup", reboundTarget],
  ]);
});

test("requires a healthy DB container before accepting a target", () => {
  const fixture = targetFixture();
  fixture.db.State.Health.Status = "starting";
  assert.throws(() => validateLocalTarget(fixture), /must be healthy/);
});

test("requires three stable initial samples before any mutation callback", () => {
  const target = validateLocalTarget(targetFixture());
  const events = [];
  let clock = 0;
  let samples = 0;

  const acquired = acquireStableLocalTarget({
    discoverTarget: () => {
      samples += 1;
      events.push(`sample-${samples}`);
      return target;
    },
    now: () => clock,
    sleep: (milliseconds) => {
      events.push("sleep");
      clock += milliseconds;
    },
  });

  runValidatedUpgrade({
    validateTarget: () => acquired,
    verifyTarget: (actualTarget) => assertValidatedTargetIdentity(actualTarget, target),
    resetTo113: () => {
      events.push("reset");
    },
    upgrade: () => {
      events.push("upgrade");
    },
    cleanup: () => {
      events.push("cleanup");
    },
  });

  assert.equal(samples, 3);
  assert.deepEqual(events, [
    "sample-1",
    "sleep",
    "sample-2",
    "sleep",
    "sample-3",
    "reset",
    "upgrade",
    "cleanup",
  ]);
});

test("resets the initial stability streak only when the DB container is recreated", () => {
  const original = validateLocalTarget(targetFixture());
  const recreated = {
    ...original,
    dbContainer: { ...original.dbContainer, id: "c".repeat(64) },
  };
  const sequence = [original, original, recreated, recreated, recreated];
  const sleeps = [];
  let clock = 0;

  const acquired = acquireStableLocalTarget({
    discoverTarget: () => sequence.shift(),
    now: () => clock,
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
  });

  assert.deepEqual(acquired, recreated);
  assert.deepEqual(sleeps, [1_000, 1_000, 1_000, 1_000]);
});

test("retries only transient initial absence and status failures", () => {
  const target = validateLocalTarget(targetFixture());
  const sequence = [
    new ResetReadinessError("db_unavailable", "DB container is absent"),
    new ResetReadinessError("status_unavailable", "local status is unavailable"),
    target,
    target,
    target,
  ];
  let clock = 0;
  let sleeps = 0;

  assert.deepEqual(
    acquireStableLocalTarget({
      discoverTarget: () => {
        const next = sequence.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      now: () => clock,
      sleep: (milliseconds) => {
        sleeps += 1;
        clock += milliseconds;
      },
    }),
    target,
  );
  assert.equal(sleeps, 4);
});

test("fails closed on immutable initial drift without allowing another retry", () => {
  const target = validateLocalTarget(targetFixture());
  const drifted = { ...target, configHash: "0".repeat(64) };
  let samples = 0;
  let sleeps = 0;

  assert.throws(
    () =>
      acquireStableLocalTarget({
        discoverTarget: () => {
          samples += 1;
          return samples === 1 ? target : drifted;
        },
        sleep: () => {
          sleeps += 1;
        },
      }),
    /config identity changed/,
  );
  assert.equal(samples, 2);
  assert.equal(sleeps, 1);
});
test("times out initial acquisition without permitting reset, fixture, upgrade, or cleanup", () => {
  const calls = [];
  let clock = 0;

  assert.throws(
    () =>
      runValidatedUpgrade({
        validateTarget: () =>
          acquireStableLocalTarget({
            deadlineMilliseconds: 2_000,
            discoverTarget: () => {
              throw new ResetReadinessError("db_not_ready", "DB starting");
            },
            now: () => clock,
            sleep: (milliseconds) => {
              clock += milliseconds;
            },
          }),
        resetTo113: () => calls.push("reset"),
        upgrade: () => calls.push("upgrade"),
        cleanup: () => calls.push("cleanup"),
      }),
    /did not remain stable/,
  );

  assert.deepEqual(calls, []);
});
test("waits for a recreated DB to transition from starting to healthy", () => {
  const target = validateLocalTarget(targetFixture());
  const rebound = { ...target, dbContainer: { ...target.dbContainer, id: "c".repeat(64) } };
  const sleeps = [];
  let clock = 0;
  let discoveries = 0;
  const result = waitForValidatedTargetAfterReset(target, {
    discoverTarget: () => {
      discoveries += 1;
      if (discoveries === 1) throw new ResetReadinessError("db_not_ready", "DB starting");
      return rebound;
    },
    now: () => clock,
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
  });
  assert.deepEqual(result, rebound);
  assert.equal(discoveries, 2);
  assert.deepEqual(sleeps, [1_000]);
});

test("waits through temporarily unavailable status before healthy readiness", () => {
  const target = validateLocalTarget(targetFixture());
  const sleeps = [];
  let clock = 0;
  let attempts = 0;
  const result = waitForValidatedTargetAfterReset(target, {
    discoverTarget: () => {
      attempts += 1;
      if (attempts === 1) {
        throw new ResetReadinessError("status_unavailable", "local status temporarily unavailable");
      }
      return target;
    },
    now: () => clock,
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
  });
  assert.deepEqual(result, target);
  assert.deepEqual(sleeps, [1_000]);
});

test("uses a wall-clock deadline and retains the final readiness cause", () => {
  const target = validateLocalTarget(targetFixture());
  const sleeps = [];
  let clock = 0;
  let error;
  try {
    waitForValidatedTargetAfterReset(target, {
      deadlineMilliseconds: 2_000,
      discoverTarget: () => {
        throw new ResetReadinessError("db_not_ready", "DB unhealthy");
      },
      now: () => clock,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
    });
  } catch (caught) {
    error = caught;
  }
  assert.match(error.message, /within 2000ms after reset; manual cleanup is required/);
  assert.equal(error.cause.kind, "db_not_ready");
  assert.deepEqual(sleeps, [1_000, 1_000]);
});

test("fails immediately on immutable identity, API, and DB mapping drift", () => {
  const target = validateLocalTarget(targetFixture());
  for (const failure of [
    () => {
      throw new Error("config identity changed");
    },
    () => ({ ...target, apiContainer: { ...target.apiContainer, id: "d".repeat(64) } }),
    () => ({ ...target, dbContainer: { ...target.dbContainer, name: "other-db" } }),
  ]) {
    let sleeps = 0;
    assert.throws(
      () =>
        waitForValidatedTargetAfterReset(target, {
          discoverTarget: failure,
          sleep: () => {
            sleeps += 1;
          },
        }),
      /manual cleanup is required/,
    );
    assert.equal(sleeps, 0);
  }

  let sleeps = 0;
  assert.throws(
    () =>
      waitForValidatedTargetAfterReset(target, {
        assertImmutableTarget: () => {
          throw new Error("config drift while status is unavailable");
        },
        discoverTarget: () => {
          throw new ResetReadinessError("status_unavailable", "temporarily unavailable");
        },
        sleep: () => {
          sleeps += 1;
        },
      }),
    /config drift while status is unavailable/,
  );
  assert.equal(sleeps, 0);
});

test("uses the same health-aware wait for reset and cleanup before callbacks", () => {
  const target = validateLocalTarget(targetFixture());
  const calls = [];
  let clock = 0;
  const waitForReady = (actualTarget) =>
    waitForValidatedTargetAfterReset(actualTarget, {
      discoverTarget: () => {
        if (calls.filter(([name]) => name === "ready").length === 0) {
          calls.push(["ready", actualTarget]);
          throw new ResetReadinessError("db_not_ready", "DB restarting");
        }
        return actualTarget;
      },
      now: () => clock,
      sleep: (milliseconds) => {
        calls.push(["sleep", milliseconds]);
        clock += milliseconds;
      },
    });

  resetAndWait({
    target,
    reset: (actualTarget) => calls.push(["reset-113", actualTarget]),
    waitForReady,
  });
  resetAndWait({
    target,
    reset: (actualTarget) => calls.push(["cleanup-116", actualTarget]),
    waitForReady: (actualTarget) => {
      calls.push(["cleanup-ready", actualTarget]);
      return waitForValidatedTargetAfterReset(actualTarget, {
        discoverTarget: () => actualTarget,
        now: () => clock,
        sleep: () => assert.fail("healthy readiness must not sleep"),
      });
    },
  });
  assert.deepEqual(
    calls.map(([name]) => name),
    ["reset-113", "ready", "sleep", "cleanup-116", "cleanup-ready"],
  );
});

test("rejects API and configured DB drift before a readiness retry", () => {
  const target = validateLocalTarget(targetFixture());
  const apiDrift = targetFixture();
  apiDrift.api.Id = "d".repeat(64);
  assert.throws(
    () => assertImmutableTargetSnapshot(target, { config: apiDrift.config, api: apiDrift.api }),
    /API container identity changed/,
  );

  const configDrift = targetFixture();
  configDrift.config = configDrift.config.replace("port = 61422", "port = 61423");
  assert.throws(
    () =>
      assertImmutableTargetSnapshot(target, { config: configDrift.config, api: configDrift.api }),
    /local config identity changed/,
  );
});

test("does not execute upgrade callbacks before healthy readiness", () => {
  const target = validateLocalTarget(targetFixture());
  const calls = [];
  let clock = 0;
  let discoveries = 0;

  runValidatedUpgrade({
    validateTarget: () => target,
    verifyTarget: (actualTarget) => assertValidatedTargetIdentity(actualTarget, target),
    resetTo113: (actualTarget) =>
      resetAndWait({
        target: actualTarget,
        reset: () => calls.push("reset"),
        waitForReady: (readyTarget) =>
          waitForValidatedTargetAfterReset(readyTarget, {
            discoverTarget: () => {
              discoveries += 1;
              if (discoveries === 1) {
                throw new ResetReadinessError("db_not_ready", "DB starting");
              }
              return readyTarget;
            },
            now: () => clock,
            sleep: (milliseconds) => {
              calls.push("sleep");
              clock += milliseconds;
            },
          }),
      }),
    upgrade: () => calls.push("upgrade"),
    cleanup: () => calls.push("cleanup"),
  });

  assert.deepEqual(calls, ["reset", "sleep", "upgrade", "cleanup"]);
});

test("rejects wrong DB mapping before an unavailable status can retry", () => {
  const fixture = targetFixture();
  const target = validateLocalTarget(fixture);
  const wrongDb = targetFixture({ dbHostPort: 61423 }).db;
  let statusCalls = 0;
  let sleeps = 0;

  let error;
  try {
    waitForValidatedTargetAfterReset(target, {
      discoverTarget: () =>
        inspectReadyTargetSnapshot(target, {
          api: fixture.api,
          config: fixture.config,
          db: wrongDb,
          readStatus: () => {
            statusCalls += 1;
            throw new Error("local status unavailable");
          },
        }),
      sleep: () => {
        sleeps += 1;
      },
    });
  } catch (caught) {
    error = caught;
  }
  assert.match(error.cause.message, /5432\/tcp must match config\.toml/);
  assert.equal(statusCalls, 0);
  assert.equal(sleeps, 0);
});

test("builds the full manifest through M116 and rejects malformed, duplicate, or missing required migrations", () => {
  const names = [
    "20260512194305_initial.sql",
    "20261006211051_wp01_authority_barrier_expand.sql",
    "20261006211056_wp01_handling_shadow_metadata.sql",
    "20261006211102_wp01_handling_reconciliation_readiness.sql",
    "20261013113744_wp01_cycle_bound_operator_send.sql",
  ];
  const manifest = buildThroughVersionManifest(names);
  assert.deepEqual(
    manifest.map((entry) => entry.version),
    ["20260512194305", "20261006211051", "20261006211056", "20261006211102"],
  );
  assert.throws(() => buildThroughVersionManifest(names.slice(0, 3)));
  assert.throws(() => buildThroughVersionManifest([...names, "20261006211051_duplicate.sql"]));
  assert.throws(() => buildThroughVersionManifest([...names, "invalid.sql"]));
});

test("rejects copied manifest hash/config drift and M117 in the temporary manifest", () => {
  const expected = buildThroughVersionManifest([
    "20260512194305_initial.sql",
    "20261006211051_wp01_authority_barrier_expand.sql",
    "20261006211056_wp01_handling_shadow_metadata.sql",
    "20261006211102_wp01_handling_reconciliation_readiness.sql",
    "20261013113744_wp01_cycle_bound_operator_send.sql",
  ]);
  const hashes = new Map(expected.map((entry) => [entry.name, `${entry.version}-hash`]));
  const copied = expected.map((entry) => ({ ...entry, hash: hashes.get(entry.name) }));
  assert.doesNotThrow(() =>
    assertIsolatedMigrationManifest(copied, { expectedManifest: expected, expectedHashes: hashes }),
  );
  assert.throws(() =>
    assertIsolatedMigrationManifest(
      [
        ...copied,
        {
          name: "20261013113744_wp01_cycle_bound_operator_send.sql",
          version: "20261013113744",
          hash: "extra",
        },
      ],
      { expectedManifest: expected, expectedHashes: hashes },
    ),
  );
  assert.throws(() =>
    assertIsolatedMigrationManifest([{ ...copied[0], hash: "wrong" }, ...copied.slice(1)], {
      expectedManifest: expected,
      expectedHashes: hashes,
    }),
  );
  assert.doesNotThrow(() =>
    assertCopiedConfigMatches(Buffer.from("active"), Buffer.from("active")),
  );
  assert.throws(() => assertCopiedConfigMatches(Buffer.from("active"), Buffer.from("drift")));
});

test("requires applied history to be present and accepts only the exact M114-M116 difference", () => {
  const manifest = buildThroughVersionManifest([
    "20260512194305_initial.sql",
    "20261006211051_wp01_authority_barrier_expand.sql",
    "20261006211056_wp01_handling_shadow_metadata.sql",
    "20261006211102_wp01_handling_reconciliation_readiness.sql",
  ]);
  assert.doesNotThrow(() => assertBeforeVersionsInManifest(["20260512194305"], manifest));
  assert.throws(() => assertBeforeVersionsInManifest(["20260512194305", "missing"], manifest));
  assert.doesNotThrow(() =>
    assertExactUpgradeDifference(
      ["20260512194305"],
      ["20260512194305", "20261006211051", "20261006211056", "20261006211102"],
    ),
  );
  assert.throws(() =>
    assertExactUpgradeDifference(
      ["20260512194305"],
      ["20260512194305", "20261006211051", "20261006211102"],
    ),
  );
  assert.throws(() =>
    assertExactUpgradeDifference(
      ["20260512194305"],
      ["20260512194305", "20261006211051", "20261006211056", "20261006211102", "20261013113744"],
    ),
  );
});

test("copies every source migration through M116 and removes the workdir on success and failure", () => {
  const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "wp01-shadow-temp-"));
  const sourceConfig = readFileSync(join(sourceRoot, "supabase", "config.toml"));
  try {
    const isolated = createIsolatedUpgradeWorkdir({ sourceRoot, temporaryRoot });
    try {
      assert.equal(isolated.manifest.length, 116);
      assert.equal(isolated.manifest.at(-1).version, "20261006211102");
      assert.equal(
        isolated.manifest.some((entry) => entry.version === "20261013113744"),
        false,
      );
      assert.equal(readdirSync(join(isolated.workdir, "supabase", "migrations")).length, 116);
      assert.deepEqual(readFileSync(join(sourceRoot, "supabase", "config.toml")), sourceConfig);
    } finally {
      isolated.destroy();
    }
    assert.equal(existsSync(isolated.workdir), false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
test("requires an explicit boolean M117-absence result encoded as JSON", () => {
  assert.doesNotThrow(() => assertMigrationAbsenceResult({ m117_present: false }));
  assert.throws(() => assertMigrationAbsenceResult({ m117_present: true }));
  assert.throws(() => assertMigrationAbsenceResult({}));
  assert.throws(() => assertMigrationAbsenceResult({ m117_present: "false" }));
  assert.throws(() => assertMigrationAbsenceResult(JSON.parse("f")));
  assert.throws(() => JSON.parse(""));
  assert.throws(() => JSON.parse("not-json"));
});
