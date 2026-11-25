import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createWriteStream, promises as fsPromises } from "node:fs";
import { access, mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Writable } from "node:stream";

import {
  CollectorError,
  ProductServiceLogCollector,
  createDockerBoundary,
  parseArguments,
  validateEvidenceRoot,
} from "./product-service-log-collector.mjs";

const PROJECT_ID = "product-verify";
const SERVICE_CONTAINERS = Object.freeze({
  storage: "storage-id",
  kong: "kong-id",
  db: "db-id",
  auth: "auth-id",
  edge_runtime: "edge-id",
});

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.kills = [];
    this.closed = false;
    this.killBehavior = null;
  }

  finish(code = 0, signal = null) {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("close", code, signal));
  }

  kill(signal) {
    this.kills.push(signal);
    if (this.killBehavior) return this.killBehavior(signal, this);
    this.finish(0, signal);
    return true;
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function inspectFor(service, containerId, projectId = PROJECT_ID, running = true) {
  return {
    Id: containerId,
    Name: `/supabase_${service}_${projectId}`,
    Config: { Labels: { "com.supabase.cli.project": projectId } },
    State: { Running: running },
  };
}

function containerEvent(
  containerId,
  name,
  projectId = PROJECT_ID,
  action = "start",
  { eventId = containerId, image = "shared-test-image", time = 1_700_000_000 } = {},
) {
  return {
    Action: action,
    id: eventId,
    time,
    Actor: {
      ID: containerId,
      Attributes: {
        "com.docker.compose.project": projectId,
        "com.supabase.cli.project": projectId,
        image,
        name,
      },
    },
  };
}

class FakeBoundary {
  constructor({ inventory = [], inspect = new Map(), failVerifyAt = null } = {}) {
    this.inventory = inventory;
    this.inspect = inspect;
    this.failVerifyAt = failVerifyAt;
    this.verifyCount = 0;
    this.eventChildren = [];
    this.logChildren = [];
    this.logCalls = [];
    this.inspectCalls = [];
    this.nextPid = 1000;
  }

  async verifyTarget() {
    this.verifyCount += 1;
    if (this.verifyCount === this.failVerifyAt) {
      throw new CollectorError("docker_engine_mismatch", "engine changed");
    }
  }

  async listContainerIds() {
    if (this.inventory instanceof Error) throw this.inventory;
    return [...this.inventory];
  }

  async inspectContainer(_config, containerId) {
    this.inspectCalls.push(containerId);
    const value = this.inspect.get(containerId);
    if (typeof value === "function") return value();
    if (value instanceof Error) throw value;
    if (!value) throw new CollectorError("container_missing", "missing");
    return value;
  }

  openEvents() {
    const child = new FakeChild(this.nextPid++);
    this.eventChildren.push(child);
    return child;
  }

  openLogs(_config, containerId) {
    const child = new FakeChild(this.nextPid++);
    this.logChildren.push(child);
    this.logCalls.push(containerId);
    return child;
  }
}

async function makeHarness(options = {}) {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "product-log-collector-"));
  const logs = [];
  const errors = [];
  const config = {
    runId: "test-run",
    evidenceRoot,
    context: "approved-context",
    endpoint: "unix:///approved/docker.sock",
    engineId: "approved-engine",
    projectId: PROJECT_ID,
    uid: 1001,
    gid: 1001,
    maxEventReconnects: 1,
    maxLogReconnects: 1,
    shutdownTimeoutMs: 5_000,
    ...options.config,
  };
  const boundary = options.boundary ?? new FakeBoundary();
  const collector = new ProductServiceLogCollector({
    config,
    boundary,
    validateEvidence: options.validateEvidence ?? (async () => {}),
    logger: {
      log(value) {
        logs.push(value);
      },
      error(value) {
        errors.push(value);
      },
    },
    createOutputStream: options.createOutputStream,
    deadlineFactory: options.deadlineFactory,
    fsApi: options.fsApi,
  });
  return { evidenceRoot, config, boundary, collector, logs, errors };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

test("requires every target and reconnect binding explicitly", () => {
  assert.throws(
    () => parseArguments(["--run-id", "run-only"]),
    (error) => error.code === "missing_argument",
  );
  const config = parseArguments([
    "--run-id",
    "run-1",
    "--evidence-root",
    "/private/evidence",
    "--context",
    "isolated",
    "--endpoint",
    "unix:///var/run/docker.sock",
    "--engine-id",
    "engine-1",
    "--project-id",
    "project-1",
    "--uid",
    "1001",
    "--gid",
    "1001",
    "--max-event-reconnects",
    "1",
    "--max-log-reconnects",
    "1",
    "--shutdown-timeout-ms",
    "5000",
  ]);
  assert.equal(config.engineId, "engine-1");
  assert.equal(config.maxLogReconnects, 1);
  assert.equal(config.shutdownTimeoutMs, 5_000);
});

test("production subprocess boundary is replaceable and real Docker is blocked", async () => {
  let invocations = 0;
  const boundary = createDockerBoundary({
    spawnImpl() {
      invocations += 1;
      throw new Error("REAL_DOCKER_BLOCKED");
    },
  });
  await assert.rejects(
    boundary.verifyTarget({
      context: "approved-context",
      endpoint: "unix:///approved/docker.sock",
      engineId: "approved-engine",
    }),
    /REAL_DOCKER_BLOCKED/u,
  );
  assert.equal(invocations, 1);
});

test("stop owns a pending docker inspect capture and reports no active discovery child", async () => {
  const inspectSpawned = deferred();
  const captureChildren = [];
  let eventChild;
  let inspectChild;
  let nextPid = 2000;
  const boundary = createDockerBoundary({
    spawnImpl(executable, args) {
      assert.equal(executable, "docker");
      const child = new FakeChild(nextPid++);
      if (args.includes("events")) {
        eventChild = child;
        return child;
      }
      captureChildren.push(child);
      if (args.includes("context")) {
        queueMicrotask(() => {
          child.stdout.write(
            `${JSON.stringify({ Endpoints: { docker: { Host: "unix:///approved/docker.sock" } } })}\n`,
          );
          child.finish(0);
        });
      } else if (args.includes("info")) {
        queueMicrotask(() => {
          child.stdout.write("approved-engine\n");
          child.finish(0);
        });
      } else if (args.includes("ps")) {
        queueMicrotask(() => {
          child.stdout.write("db-id\n");
          child.finish(0);
        });
      } else if (args.includes("inspect")) {
        inspectChild = child;
        inspectSpawned.resolve();
      } else {
        throw new Error(`unexpected synthetic Docker arguments: ${args.join(" ")}`);
      }
      return child;
    },
  });
  const harness = await makeHarness({ boundary });
  const startPromise = harness.collector.start();
  await inspectSpawned.promise;
  const stopPromise = harness.collector.stop("test");
  try {
    const summary = await stopPromise;
    assert.deepEqual(inspectChild.kills, ["SIGINT"]);
    assert.equal(inspectChild.closed, true);
    assert.deepEqual(summary.activeChildPids, []);
    assert.equal(summary.complete, false);
    await assert.rejects(startPromise, (error) => error.code === "collector_stopping");
    assert.equal(eventChild.closed, true);
    assert.equal(
      captureChildren.every((child) => child.closed),
      true,
    );
  } finally {
    inspectChild?.finish(0);
    eventChild?.finish(0);
    await Promise.allSettled([startPromise, stopPromise]);
  }
});

test("startup discovery error is preserved while the owned getfacl child is closed", async () => {
  const discoveryErrored = deferred();
  let discoveryChild;
  const fsApi = Object.create(fsPromises);
  fsApi.stat = async () => ({
    isDirectory: () => true,
    uid: 1001,
    gid: 1001,
    mode: 0o40700,
  });
  const validateEvidence = (config, processControl) =>
    validateEvidenceRoot(config, {
      fsApi,
      platform: "linux",
      ...processControl,
      spawnImpl(executable, args) {
        assert.equal(executable, "getfacl");
        assert.deepEqual(args.slice(0, 3), ["-cp", "--absolute-names", config.evidenceRoot]);
        discoveryChild = new FakeChild(3000);
        queueMicrotask(() => {
          discoveryChild.emit("error", new Error("synthetic getfacl spawn failure"));
          discoveryErrored.resolve();
        });
        return discoveryChild;
      },
    });
  const harness = await makeHarness({ validateEvidence });
  const startPromise = harness.collector.start();
  await discoveryErrored.promise;
  try {
    await assert.rejects(startPromise, /synthetic getfacl spawn failure/u);
    assert.deepEqual(discoveryChild.kills, ["SIGINT"]);
    assert.equal(discoveryChild.closed, true);
    const summary = await harness.collector.waitForStop();
    assert.deepEqual(summary.activeChildPids, []);
    assert.equal(summary.complete, false);
  } finally {
    discoveryChild?.finish(1);
    await Promise.allSettled([startPromise]);
  }
});

test("normally completed discovery captures leave no owned process behind", async () => {
  const captureChildren = [];
  let eventChild;
  let nextPid = 4000;
  const boundary = createDockerBoundary({
    spawnImpl(executable, args) {
      assert.equal(executable, "docker");
      const child = new FakeChild(nextPid++);
      if (args.includes("events")) {
        eventChild = child;
        return child;
      }
      captureChildren.push(child);
      queueMicrotask(() => {
        if (args.includes("context")) {
          child.stdout.write(
            `${JSON.stringify({ Endpoints: { docker: { Host: "unix:///approved/docker.sock" } } })}\n`,
          );
        } else if (args.includes("info")) {
          child.stdout.write("approved-engine\n");
        }
        child.finish(0);
      });
      return child;
    },
  });
  const harness = await makeHarness({ boundary });
  await harness.collector.start();
  const summary = await harness.collector.stop("test");
  assert.equal(captureChildren.length, 3);
  assert.equal(
    captureChildren.every((child) => child.closed),
    true,
  );
  assert.equal(
    captureChildren.every((child) => child.kills.length === 0),
    true,
  );
  assert.deepEqual(summary.activeChildPids, []);
  assert.equal(eventChild.closed, true);
});

test("stop fences a pending inspect and prevents a late log child", async () => {
  const inspectStarted = deferred();
  const inspectResult = deferred();
  const inspect = new Map([
    [
      "db-id",
      async () => {
        inspectStarted.resolve();
        return inspectResult.promise;
      },
    ],
  ]);
  const boundary = new FakeBoundary({ inventory: ["db-id"], inspect });
  const harness = await makeHarness({ boundary });
  const startPromise = harness.collector.start();
  await inspectStarted.promise;
  const checkpoint = deferred();
  const stopPromise = harness.collector.stop("test");
  queueMicrotask(() => checkpoint.resolve("checkpoint"));
  try {
    assert.equal(
      await Promise.race([stopPromise.then(() => "stopped"), checkpoint.promise]),
      "checkpoint",
    );
    inspectResult.resolve(inspectFor("db", "db-id"));
    await assert.rejects(startPromise, (error) => error.code === "collector_stopping");
    await stopPromise;
    assert.equal(boundary.logChildren.length, 0);
  } finally {
    inspectResult.resolve(inspectFor("db", "db-id"));
    for (const child of boundary.logChildren) child.finish();
    await Promise.allSettled([startPromise, stopPromise]);
  }
});

test("start failure after opening events uses the shared stop path", async () => {
  const boundary = new FakeBoundary({ inventory: new Error("synthetic inventory failure") });
  const harness = await makeHarness({ boundary });
  await assert.rejects(harness.collector.start(), /synthetic inventory failure/u);
  assert.deepEqual(boundary.eventChildren[0].kills, ["SIGINT"]);
  assert.equal(boundary.eventChildren[0].closed, true);
  const summary = await harness.collector.waitForStop();
  assert.equal(summary.complete, false);
});

test("stop waits for a delayed owned event child close", async () => {
  const boundary = new FakeBoundary();
  const deadlineRequested = deferred();
  const deadlineRelease = deferred();
  const harness = await makeHarness({
    boundary,
    deadlineFactory() {
      deadlineRequested.resolve();
      return { promise: deadlineRelease.promise, cancel() {} };
    },
  });
  await harness.collector.start();
  const killObserved = deferred();
  boundary.eventChildren[0].killBehavior = () => {
    killObserved.resolve();
    return true;
  };
  const stopPromise = harness.collector.stop("test");
  await killObserved.promise;
  await deadlineRequested.promise;
  let stopped = false;
  void stopPromise.then(() => {
    stopped = true;
  });
  assert.equal(stopped, false);
  boundary.eventChildren[0].finish(0, "SIGINT");
  await stopPromise;
});

test("stream write failure publishes unhealthy state while its child remains open", async () => {
  const inspect = new Map([["storage-id", inspectFor("storage", "storage-id")]]);
  const boundary = new FakeBoundary({ inventory: ["storage-id"], inspect });
  const writeFailed = deferred();
  let failedOneStream = false;
  const createOutputStream = (filePath, options) => {
    if (!failedOneStream && filePath.endsWith(".stdout.log")) {
      failedOneStream = true;
      const writer = new Writable({
        write(_chunk, _encoding, callback) {
          writeFailed.resolve();
          callback(new Error("synthetic write failure"));
        },
      });
      queueMicrotask(() => writer.emit("open", 1));
      return writer;
    }
    return createWriteStream(filePath, options);
  };
  const harness = await makeHarness({ boundary, createOutputStream });
  await harness.collector.start();
  boundary.logChildren[0].stdout.write("raw must remain private\n");
  await writeFailed.promise;
  await harness.collector.waitForUnhealthy();
  try {
    await access(path.join(harness.evidenceRoot, "collector-failed.json"));
    assert.equal(boundary.logChildren[0].closed, false);
  } finally {
    await harness.collector.stop("test");
  }
});

test("coverage gap makes the documented health gate fail before stop", async () => {
  const boundary = new FakeBoundary();
  const harness = await makeHarness({ boundary });
  await harness.collector.start();
  boundary.eventChildren[0].stdout.write("not-json\n");
  await harness.collector.waitForUnhealthy();
  try {
    assert.equal(
      harness.collector.gaps.some((gap) => gap.code === "event_json_invalid"),
      true,
    );
    await access(path.join(harness.evidenceRoot, "collector-failed.json"));
    assert.equal(boundary.eventChildren[0].closed, false);
  } finally {
    await harness.collector.stop("test");
  }
});

test("health-signal persistence failure stops the collector instead of appearing healthy", async () => {
  const boundary = new FakeBoundary();
  const failedSignalAttempted = deferred();
  const fsApi = Object.create(fsPromises);
  fsApi.open = async (filePath, ...args) => {
    if (filePath.endsWith("collector-failed.json")) {
      failedSignalAttempted.resolve();
      const error = new Error("synthetic health signal write failure");
      error.code = "EIO";
      throw error;
    }
    return fsPromises.open(filePath, ...args);
  };
  const harness = await makeHarness({ boundary, fsApi });
  await harness.collector.start();
  boundary.eventChildren[0].stdout.write("not-json\n");
  await failedSignalAttempted.promise;
  const summary = await harness.collector.waitForStop();
  assert.equal(boundary.eventChildren[0].closed, true);
  assert.ok(
    summary.failures.some((failure) => failure.code === "health_signal_persistence_failed"),
  );
  assert.equal(summary.complete, false);
});

test("shutdown deadline escalates only owned children and cannot report complete", async () => {
  const boundary = new FakeBoundary();
  const deadlineRequested = deferred();
  const deadlineRelease = deferred();
  const sigkillObserved = deferred();
  const unrelated = new FakeChild(9999);
  let deadlineCalls = 0;
  const harness = await makeHarness({
    boundary,
    deadlineFactory() {
      deadlineCalls += 1;
      if (deadlineCalls === 1) {
        deadlineRequested.resolve();
        return { promise: deadlineRelease.promise, cancel() {} };
      }
      return { promise: new Promise(() => {}), cancel() {} };
    },
  });
  await harness.collector.start();
  boundary.eventChildren[0].killBehavior = (signal, child) => {
    if (signal === "SIGKILL") {
      sigkillObserved.resolve();
      child.finish(null, signal);
    }
    return true;
  };
  const stopPromise = harness.collector.stop("test");
  await deadlineRequested.promise;
  deadlineRelease.resolve();
  await sigkillObserved.promise;
  const summary = await stopPromise;
  assert.deepEqual(boundary.eventChildren[0].kills, ["SIGINT", "SIGKILL"]);
  assert.deepEqual(unrelated.kills, []);
  assert.ok(summary.gaps.some((gap) => gap.code === "shutdown_timeout"));
  assert.deepEqual(summary.activeChildPids, []);
  assert.equal(summary.complete, false);
});

test("event-before-inventory race deduplicates IDs, follows replacements, and ignores foreign containers", async () => {
  const inspect = new Map([
    ["storage-id", inspectFor("storage", "storage-id")],
    ["storage-replacement", inspectFor("storage", "storage-replacement")],
    ["foreign-id", inspectFor("storage", "foreign-id", "foreign-project")],
  ]);
  const boundary = new FakeBoundary({ inventory: ["storage-id"], inspect });
  const harness = await makeHarness({ boundary });
  await harness.collector.start();
  boundary.eventChildren[0].stdout.write(
    `${JSON.stringify(containerEvent("storage-id", `supabase_storage_${PROJECT_ID}`))}\n${JSON.stringify(
      containerEvent("storage-replacement", `supabase_storage_${PROJECT_ID}`),
    )}\n${JSON.stringify(
      containerEvent("foreign-id", "supabase_storage_foreign-project", "foreign-project"),
    )}\n`,
  );
  await tick();
  assert.deepEqual(boundary.logCalls.sort(), ["storage-id", "storage-replacement"]);
  const summary = await harness.collector.stop("test");
  assert.deepEqual(summary.segments.map((segment) => segment.containerId).sort(), [
    "storage-id",
    "storage-replacement",
  ]);
  assert.notEqual(summary.segments[0].stdout.file, summary.segments[1].stdout.file);
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.observedServices, ["storage"]);
  assert.ok(summary.missingServices.includes("db"));
});

test("event classification ignores project helpers but keeps missing required services fail-closed", async () => {
  const missing = new Error("gone");
  const inspect = new Map([
    ["helper-id", missing],
    ["storage-id", missing],
  ]);
  const boundary = new FakeBoundary({ inspect });
  const harness = await makeHarness({ boundary });
  await harness.collector.start();
  const helperLifecycle = ["create", "start", "die", "destroy"]
    .map((action) => JSON.stringify(containerEvent("helper-id", "serene_mendel", PROJECT_ID, action)))
    .join("\n");
  boundary.eventChildren[0].stdout.write(
    `${helperLifecycle}\n${JSON.stringify(
      containerEvent("storage-id", `supabase_storage_${PROJECT_ID}`),
    )}\n`,
  );
  await tick();
  const summary = await harness.collector.stop("test");
  assert.equal(
    summary.gaps.some(
      (gap) => gap.code === "container_disappeared_before_attach" && gap.containerId === "helper-id",
    ),
    false,
  );
  assert.equal(
    summary.gaps.some(
      (gap) => gap.code === "container_disappeared_before_attach" && gap.containerId === "storage-id",
    ),
    true,
  );
  assert.deepEqual(boundary.inspectCalls, ["storage-id"]);
  assert.deepEqual(boundary.logCalls, []);
  assert.equal(summary.complete, false);
});

test("project helper lifecycle is retained with explicit logs-not-collected status", async () => {
  const boundary = new FakeBoundary();
  const harness = await makeHarness({ boundary });
  await harness.collector.start();
  const actions = ["create", "start", "die", "destroy"];
  boundary.eventChildren[0].stdout.write(
    `${actions
      .map((action, index) =>
        JSON.stringify(
          containerEvent("helper-id", "serene_mendel", PROJECT_ID, action, {
            time: 1_700_000_000 + index,
          }),
        ),
      )
      .join("\n")}\n`,
  );
  await tick();
  const summary = await harness.collector.stop("test");
  assert.equal(summary.nonRequiredContainers.length, 1);
  const [helper] = summary.nonRequiredContainers;
  assert.equal(helper.containerId, "helper-id");
  assert.equal(helper.name, "serene_mendel");
  assert.equal(helper.projectId, PROJECT_ID);
  assert.equal(helper.requiredServiceCoverage, false);
  assert.deepEqual(helper.logCapture, {
    status: "not_collected",
    reason: "outside_required_service_coverage",
  });
  assert.deepEqual(
    helper.lifecycle.map(({ action, eventTimeSeconds }) => ({ action, eventTimeSeconds })),
    actions.map((action, index) => ({ action, eventTimeSeconds: 1_700_000_000 + index })),
  );
  assert.ok(helper.lifecycle.every(({ observedAt }) => typeof observedAt === "string"));
  assert.deepEqual(boundary.inspectCalls, []);
  assert.deepEqual(boundary.logCalls, []);
  assert.equal(summary.segments.some((segment) => segment.containerId === "helper-id"), false);
  assert.equal(
    summary.gaps.some((gap) => gap.containerId === "helper-id"),
    false,
  );
});

test("helper and required service sharing an image remain separate by exact identity", async () => {
  const inspect = new Map([["storage-id", inspectFor("storage", "storage-id")]]);
  const boundary = new FakeBoundary({ inspect });
  const harness = await makeHarness({ boundary });
  await harness.collector.start();
  boundary.eventChildren[0].stdout.write(
    `${JSON.stringify(
      containerEvent("helper-id", "serene_mendel", PROJECT_ID, "start", {
        image: "identical-image",
      }),
    )}\n${JSON.stringify(
      containerEvent("storage-id", `supabase_storage_${PROJECT_ID}`, PROJECT_ID, "start", {
        image: "identical-image",
      }),
    )}\n`,
  );
  await tick();
  const summary = await harness.collector.stop("test");
  assert.deepEqual(boundary.inspectCalls, ["storage-id"]);
  assert.deepEqual(boundary.logCalls, ["storage-id"]);
  assert.deepEqual(summary.observedServices, ["storage"]);
  assert.equal(summary.segments.some((segment) => segment.containerId === "helper-id"), false);
  assert.equal(summary.complete, false);
});

test("contradictory container IDs remain fail-closed before inspect", async () => {
  const inspect = new Map([["storage-id", inspectFor("storage", "storage-id")]]);
  const boundary = new FakeBoundary({ inspect });
  const harness = await makeHarness({ boundary });
  await harness.collector.start();
  boundary.eventChildren[0].stdout.write(
    `${JSON.stringify(
      containerEvent("storage-id", `supabase_storage_${PROJECT_ID}`, PROJECT_ID, "start", {
        eventId: "different-id",
      }),
    )}\n`,
  );
  await tick();
  const summary = await harness.collector.stop("test");
  assert.ok(
    summary.gaps.some(
      (gap) =>
        gap.code === "event_container_identity_ambiguous" &&
        gap.containerId === "storage-id" &&
        gap.reason === "container_id_conflict",
    ),
  );
  assert.deepEqual(boundary.inspectCalls, []);
  assert.deepEqual(boundary.logCalls, []);
  assert.deepEqual(summary.observedServices, []);
  assert.equal(summary.complete, false);
});

test("contradictory project labels remain fail-closed before inspect", async () => {
  const inspect = new Map([["storage-id", inspectFor("storage", "storage-id")]]);
  const boundary = new FakeBoundary({ inspect });
  const harness = await makeHarness({ boundary });
  await harness.collector.start();
  const event = containerEvent("storage-id", `supabase_storage_${PROJECT_ID}`);
  event.Actor.Attributes["com.docker.compose.project"] = "different-project";
  boundary.eventChildren[0].stdout.write(`${JSON.stringify(event)}\n`);
  await tick();
  const summary = await harness.collector.stop("test");
  assert.ok(
    summary.gaps.some(
      (gap) =>
        gap.code === "event_container_identity_ambiguous" &&
        gap.containerId === "storage-id" &&
        gap.reason === "project_label_conflict",
    ),
  );
  assert.deepEqual(boundary.inspectCalls, []);
  assert.deepEqual(boundary.logCalls, []);
  assert.deepEqual(summary.observedServices, []);
  assert.equal(summary.complete, false);
});

test("ambiguous event identity remains a fail-closed evidence gap", async () => {
  const boundary = new FakeBoundary();
  const harness = await makeHarness({ boundary });
  await harness.collector.start();
  boundary.eventChildren[0].stdout.write(`${JSON.stringify({ Actor: { ID: "unknown-id" } })}\n`);
  await tick();
  const summary = await harness.collector.stop("test");
  assert.ok(
    summary.gaps.some(
      (gap) => gap.code === "event_container_identity_ambiguous" && gap.containerId === "unknown-id",
    ),
  );
  assert.deepEqual(boundary.inspectCalls, []);
  assert.equal(summary.complete, false);
});

test("engine mismatch blocks startup and engine drift blocks event reconnect", async () => {
  const startupBoundary = new FakeBoundary({ failVerifyAt: 1 });
  const startup = await makeHarness({ boundary: startupBoundary });
  await assert.rejects(
    startup.collector.start(),
    (error) => error.code === "docker_engine_mismatch",
  );
  assert.equal(startupBoundary.eventChildren.length, 0);

  const driftBoundary = new FakeBoundary({ failVerifyAt: 2 });
  const drift = await makeHarness({ boundary: driftBoundary });
  await drift.collector.start();
  driftBoundary.eventChildren[0].finish(1);
  await tick();
  assert.equal(driftBoundary.eventChildren.length, 1);
  const summary = await drift.collector.stop("test");
  assert.ok(summary.failures.some((failure) => failure.code === "docker_engine_mismatch"));
  assert.equal(summary.complete, false);
});

test("missing container before attach and unavailable logs are explicit gaps", async () => {
  const missing = new Error("gone");
  const inspect = new Map([
    ["gone-id", missing],
    ["db-id", inspectFor("db", "db-id")],
  ]);
  const boundary = new FakeBoundary({ inventory: ["gone-id", "db-id"], inspect });
  boundary.openLogs = (_config, containerId) => {
    if (containerId === "db-id") throw new Error("logs unavailable");
    throw new Error("unexpected");
  };
  const harness = await makeHarness({ boundary });
  await harness.collector.start();
  const summary = await harness.collector.stop("test");
  assert.ok(summary.gaps.some((gap) => gap.code === "container_disappeared_before_attach"));
  assert.ok(summary.gaps.some((gap) => gap.code === "logs_unavailable"));
  assert.ok(summary.failures.some((failure) => failure.code === "logs_open_failed"));
});

test("asynchronous Docker log process error is sanitized and cannot complete evidence", async () => {
  const inspect = new Map([["db-id", inspectFor("db", "db-id")]]);
  const boundary = new FakeBoundary({ inventory: ["db-id"], inspect });
  const harness = await makeHarness({ boundary });
  await harness.collector.start();
  boundary.logChildren[0].emit("error", new Error("synthetic spawn failure"));
  boundary.logChildren[0].finish(1);
  await Promise.allSettled([...harness.collector.segmentPromises]);
  const summary = await harness.collector.stop("test");
  assert.ok(summary.gaps.some((gap) => gap.code === "log_process_error"));
  assert.equal(
    summary.gaps.some((gap) => gap.code === "log_process_close_unavailable"),
    false,
  );
  assert.ok(summary.failures.some((failure) => failure.code === "log_process_error"));
  assert.equal(summary.segments[0].exitCode, 1);
  assert.equal(summary.complete, false);
});

test("bounded log reconnect records the disconnect and exhausts without false completion", async () => {
  const inspect = new Map([["db-id", inspectFor("db", "db-id")]]);
  const boundary = new FakeBoundary({ inventory: ["db-id"], inspect });
  const harness = await makeHarness({ boundary });
  await harness.collector.start();
  boundary.logChildren[0].finish(2);
  await Promise.allSettled([...harness.collector.segmentPromises]);
  assert.equal(boundary.logChildren.length, 2);
  boundary.logChildren[1].finish(2);
  await Promise.allSettled([...harness.collector.segmentPromises]);
  const summary = await harness.collector.stop("test");
  assert.equal(boundary.logChildren.length, 2);
  assert.ok(
    summary.gaps.some((gap) => gap.code === "log_stream_disconnected"),
    JSON.stringify(summary.gaps),
  );
  assert.ok(summary.failures.some((failure) => failure.code === "log_reconnect_exhausted"));
  assert.equal(summary.complete, false);
});

test("stdout and stderr are streamed to separate exclusive files with exact hashes", async () => {
  const inspect = new Map([["storage-id", inspectFor("storage", "storage-id")]]);
  const boundary = new FakeBoundary({ inventory: ["storage-id"], inspect });
  const harness = await makeHarness({ boundary });
  await harness.collector.start();
  boundary.logChildren[0].stdout.write("public service line\n");
  boundary.logChildren[0].stderr.write("private diagnostic line\n");
  const summary = await harness.collector.stop("test");
  const segment = summary.segments[0];
  assert.equal(segment.pid, boundary.logChildren[0].pid);
  assert.equal(segment.stdout.sha256, hash("public service line\n"));
  assert.equal(segment.stderr.sha256, hash("private diagnostic line\n"));
  assert.equal(segment.stdout.bytes, Buffer.byteLength("public service line\n"));
  assert.equal(segment.stderr.bytes, Buffer.byteLength("private diagnostic line\n"));
  assert.equal(
    await readFile(path.join(harness.evidenceRoot, segment.stdout.file), "utf8"),
    "public service line\n",
  );
  assert.equal(
    await readFile(path.join(harness.evidenceRoot, segment.stderr.file), "utf8"),
    "private diagnostic line\n",
  );
  assert.equal(
    harness.logs.some((line) => line.includes("private diagnostic")),
    false,
  );
});

test("exclusive persistence failure is preserved without printing raw output", async () => {
  const inspect = new Map([["storage-id", inspectFor("storage", "storage-id")]]);
  const boundary = new FakeBoundary({ inventory: [], inspect });
  const harness = await makeHarness({ boundary });
  const collisionDirectory = path.join(
    harness.evidenceRoot,
    "service-logs",
    "storage",
    "storage-id",
  );
  await mkdir(collisionDirectory, { recursive: true });
  await writeFile(path.join(collisionDirectory, "segment-0001.stdout.log"), "existing", "utf8");
  await harness.collector.start();
  boundary.eventChildren[0].stdout.write(
    `${JSON.stringify(containerEvent("storage-id", `supabase_storage_${PROJECT_ID}`))}\n`,
  );
  await tick();
  const summary = await harness.collector.stop("test");
  assert.ok(summary.gaps.some((gap) => gap.code === "log_persistence_failed"));
  assert.ok(summary.failures.some((failure) => failure.code === "log_persistence_failed"));
  assert.equal(
    [...harness.logs, ...harness.errors].some((line) => line.includes("existing")),
    false,
  );
  assert.equal(summary.complete, false);
});

test("stream close failure is preserved as an evidence failure", async () => {
  const inspect = new Map([["storage-id", inspectFor("storage", "storage-id")]]);
  const boundary = new FakeBoundary({ inventory: ["storage-id"], inspect });
  let failedOneStream = false;
  const createOutputStream = (filePath, options) => {
    if (!failedOneStream && filePath.endsWith(".stdout.log")) {
      failedOneStream = true;
      const writer = new Writable({
        write(chunk, _encoding, callback) {
          callback(null, chunk);
        },
        final(callback) {
          callback(new Error("synthetic close failure"));
        },
      });
      queueMicrotask(() => writer.emit("open", 1));
      return writer;
    }
    return createWriteStream(filePath, options);
  };
  const harness = await makeHarness({ boundary, createOutputStream });
  await harness.collector.start();
  boundary.logChildren[0].stdout.write("captured before close failure\n");
  const summary = await harness.collector.stop("test");
  assert.ok(summary.gaps.some((gap) => gap.code === "log_persistence_failed"));
  assert.ok(summary.failures.some((failure) => failure.code === "log_persistence_failed"));
  assert.equal(summary.complete, false);
});

test("graceful stop signals only children created by the collector", async () => {
  const inspect = new Map(
    Object.entries(SERVICE_CONTAINERS).map(([service, id]) => [id, inspectFor(service, id)]),
  );
  const boundary = new FakeBoundary({ inventory: Object.values(SERVICE_CONTAINERS), inspect });
  const harness = await makeHarness({ boundary });
  const unrelated = new FakeChild(9999);
  await harness.collector.start();
  const summary = await harness.collector.stop("test");
  const repeatedSummary = await harness.collector.stop("repeated");
  assert.equal(repeatedSummary, summary);
  assert.equal(summary.complete, true);
  assert.deepEqual(summary.missingServices, []);
  for (const segment of summary.segments) {
    assert.equal(segment.stdout.bytes, 0);
    assert.equal(segment.stderr.bytes, 0);
    assert.equal(segment.stdout.sha256, hash(""));
    assert.equal(segment.stderr.sha256, hash(""));
  }
  for (const child of [...boundary.eventChildren, ...boundary.logChildren]) {
    assert.deepEqual(child.kills, ["SIGINT"]);
  }
  assert.deepEqual(unrelated.kills, []);
});

test("unsafe evidence symlink is rejected before any process is opened", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "collector-path-"));
  const real = path.join(parent, "real");
  const linked = path.join(parent, "linked");
  await mkdir(real);
  try {
    await symlink(real, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`symlink unavailable: ${error.code}`);
    return;
  }
  await assert.rejects(
    validateEvidenceRoot(
      { evidenceRoot: linked, uid: 1001, gid: 1001 },
      {
        platform: "linux",
        spawnImpl: () => {
          throw new Error("process boundary must not open");
        },
      },
    ),
    (error) => error.code === "unsafe_evidence_path",
  );
});

test("partial capture can never report complete", async () => {
  const inspect = new Map([["auth-id", inspectFor("auth", "auth-id")]]);
  const boundary = new FakeBoundary({ inventory: ["auth-id"], inspect });
  const harness = await makeHarness({ boundary });
  await harness.collector.start();
  const summary = await harness.collector.stop("test");
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.observedServices, ["auth"]);
  assert.equal(summary.missingServices.length, 4);
  const persisted = JSON.parse(
    await readFile(path.join(harness.evidenceRoot, "collector-summary.json"), "utf8"),
  );
  assert.equal(persisted.complete, false);
  assert.equal((await readdir(harness.evidenceRoot)).includes("collector-ready.json"), true);
});
