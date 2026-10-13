import assert from "node:assert/strict";
import test from "node:test";

import {
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
