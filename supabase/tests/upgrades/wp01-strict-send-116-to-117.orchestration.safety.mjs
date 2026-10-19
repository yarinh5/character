import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireStableLocalTarget,
  assertCleanM117Evidence,
  assertCleanResidue,
  assertCurrentMigrationBaseline,
  assertPostM117ObjectCatalog,
  assertPreM117ObjectCatalog,
  cleanupStrictBarrierResources,
  createStrictBarrierCleanupAdapters,
  expectedMigrationVersionsFromSource,
  readAuthorityEvidenceAfterM117,
  reportStrictRehearsalFailure,
  runStrictCleanupReset,
  runStrictReset,
  validateStrictUpgradeTransition,
  waitForStrictBarrierState,
  withDeadline,
  withStrictBarrierCleanup,
} from "./wp01-strict-send-116-to-117.mjs";

const target = {
  projectId: "qmgkmsarzfjnqltljkjl",
  configHash: "a".repeat(64),
  apiPort: 61421,
  dbPort: 61422,
  api: { id: "b".repeat(64), name: "supabase_kong_qmgkmsarzfjnqltljkjl" },
  db: { id: "c".repeat(64), name: "supabase_db_qmgkmsarzfjnqltljkjl" },
};

test("requires M117 to acquire the exclusive cutover barrier before schema changes", () => {
  const migration = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "migrations",
      "20261013113744_wp01_cycle_bound_operator_send.sql",
    ),
    "utf8",
  );
  const executable = migration
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("--"));

  assert.equal(executable[0], "SELECT private.acquire_handling_cutover_barrier();");
  assert.ok(
    migration.indexOf("SELECT private.acquire_handling_cutover_barrier();") <
      migration.indexOf("ALTER TABLE private.handling_contract_runtime"),
  );
});

test("waits for observed lock state, enforces timeout, and always performs cleanup", async () => {
  let clock = 0;
  let reads = 0;
  const observed = await waitForStrictBarrierState({
    readState: async () => ({ blocked: ++reads >= 3 }),
    accept: (state) => state.blocked,
    timeoutMs: 10,
    intervalMs: 2,
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
  });
  assert.deepEqual(observed, { blocked: true });
  assert.equal(reads, 3);

  clock = 0;
  await assert.rejects(() =>
    waitForStrictBarrierState({
      readState: async () => ({ blocked: false }),
      accept: (state) => state.blocked,
      timeoutMs: 3,
      intervalMs: 2,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    }),
  );

  const events = [];
  await assert.rejects(() =>
    withStrictBarrierCleanup(
      async () => {
        events.push("work");
        throw new Error("primary failure");
      },
      async () => {
        events.push("cleanup");
      },
    ),
  );
  assert.deepEqual(events, ["work", "cleanup"]);
});

test("preserves the primary failure when strict barrier cleanup also fails", async () => {
  const primaryFailure = new Error("primary failure");
  const cleanupFailure = new Error("cleanup failure");

  await assert.rejects(
    () =>
      withStrictBarrierCleanup(
        async () => {
          throw primaryFailure;
        },
        async () => {
          throw cleanupFailure;
        },
      ),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.errors[0], primaryFailure);
      assert.equal(error.errors[1].cause, cleanupFailure);
      assert.match(error.errors[1].message, /orchestration:cleanup/);
      return true;
    },
  );
});

function cleanupHarness({
  failures = new Set(),
  failureMessages = new Map(),
  openResources = new Set(),
  hanging = new Set(),
} = {}) {
  const events = [];
  const step = (stage) => async (resource) => {
    const key = `${resource.label}:${stage}`;
    events.push(key);
    if (hanging.has(key)) return new Promise(() => {});
    if (failures.has(key)) {
      throw new Error(failureMessages.get(key) ?? `${key} injected failure`);
    }
    return undefined;
  };
  return {
    adapters: {
      cancel: step("cancel"),
      drain: step("drain"),
      end: step("end"),
      kill: step("kill"),
      verify: async (resource) => {
        const key = `${resource.label}:verify`;
        events.push(key);
        if (failures.has(key)) {
          throw new Error(failureMessages.get(key) ?? `${key} injected failure`);
        }
        return !openResources.has(resource.label);
      },
    },
    events,
  };
}

const cleanupResources = [
  { kind: "session", label: "writer" },
  { kind: "session", label: "table-blocker" },
  { kind: "migration", label: "migration" },
];

test("strict cleanup attempts every resource and aggregates cancel, end, kill, and drain failures", async () => {
  const harness = cleanupHarness({
    failures: new Set(["writer:cancel", "writer:end", "table-blocker:drain", "migration:kill"]),
  });
  const result = await cleanupStrictBarrierResources({
    resources: cleanupResources,
    adapters: harness.adapters,
    timeoutMs: 20,
  });

  assert.equal(result.quiescent, true);
  assert.equal(result.errors.length, 4);
  assert.deepEqual(harness.events, [
    "writer:cancel",
    "writer:end",
    "writer:kill",
    "writer:drain",
    "writer:verify",
    "table-blocker:cancel",
    "table-blocker:end",
    "table-blocker:kill",
    "table-blocker:drain",
    "table-blocker:verify",
    "migration:kill",
    "migration:drain",
    "migration:verify",
  ]);

  const primaryFailure = new Error("primary failure");
  await assert.rejects(
    () =>
      withStrictBarrierCleanup(
        async () => {
          throw primaryFailure;
        },
        async () => result,
      ),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.errors[0], primaryFailure);
      assert.equal(error.errors.length, 5);
      return true;
    },
  );
});

test("strict cleanup bounds a child that never closes and still verifies every resource", async () => {
  const harness = cleanupHarness({
    hanging: new Set(["writer:drain"]),
    openResources: new Set(["writer"]),
  });
  const result = await cleanupStrictBarrierResources({
    resources: cleanupResources,
    adapters: harness.adapters,
    timeoutMs: 5,
  });

  assert.equal(result.quiescent, false);
  assert.equal(result.errors.length, 2);
  assert.equal(harness.events.includes("writer:verify"), true);
  assert.equal(harness.events.includes("table-blocker:verify"), true);
  assert.equal(harness.events.includes("migration:verify"), true);

  let resets = 0;
  await assert.rejects(() =>
    runStrictCleanupReset({
      resetStarted: true,
      quiescent: result.quiescent,
      resetAction: async () => {
        resets += 1;
      },
    }),
  );
  assert.equal(resets, 0);
});

test("strict final cleanup never resets before quiescence and preserves the success path", async () => {
  let resets = 0;
  await assert.rejects(
    () =>
      runStrictCleanupReset({
        resetStarted: true,
        quiescent: false,
        resetAction: async () => {
          resets += 1;
        },
      }),
    /do not reset/,
  );
  assert.equal(resets, 0);

  const skipped = await runStrictCleanupReset({
    resetStarted: false,
    quiescent: false,
    resetAction: async () => {
      resets += 1;
    },
  });
  assert.deepEqual(skipped, { performed: false });
  assert.equal(resets, 0);

  const completed = await runStrictCleanupReset({
    resetStarted: true,
    quiescent: true,
    resetAction: async () => {
      resets += 1;
      return "clean";
    },
  });
  assert.deepEqual(completed, { performed: true, value: "clean" });
  assert.equal(resets, 1);
});

test("strict resource cleanup keeps the unchanged success path clean", async () => {
  const harness = cleanupHarness();
  const result = await cleanupStrictBarrierResources({
    resources: cleanupResources,
    adapters: harness.adapters,
    timeoutMs: 20,
  });
  assert.deepEqual(result, { errors: [], quiescent: true });
});

function cancellationAdapter(response) {
  const calls = [];
  const adapters = createStrictBarrierCleanupAdapters({
    executeJson: (statement, options) => {
      calls.push({ options, statement });
      if (statement.includes("pg_stat_activity")) return [731];
      if (response instanceof Error) throw response;
      return response;
    },
  });
  return { adapters, calls };
}

const ownedCancellationResource = {
  applicationName: "wp01_strict_test_writer",
  backendStart: "2026-10-18 09:00:00+00",
  kind: "session",
  label: "writer",
  pid: 731,
};

test("real cancellation adapter accepts only explicit JSON true and passes its timeout budget", async () => {
  const harness = cancellationAdapter({ cancelled: true });
  await harness.adapters.cancel(ownedCancellationResource, { timeoutMs: 37 });

  assert.match(harness.calls[1].statement, /json_build_object\s*\(\s*'cancelled'/i);
  assert.equal(harness.calls[1].options.timeoutMs > 0, true);
  assert.equal(harness.calls[1].options.timeoutMs <= 37, true);
});

test("real cancellation adapter rejects false, null, malformed, and missing cancellation results", async () => {
  for (const response of [
    { cancelled: false },
    null,
    "malformed",
    {},
    new SyntaxError("malformed JSON"),
  ]) {
    const harness = cancellationAdapter(response);
    await assert.rejects(() =>
      harness.adapters.cancel(ownedCancellationResource, { timeoutMs: 37 }),
    );
  }
});

test("entrypoint reporter uses safe categories for primary and production cleanup failures", async () => {
  const sensitiveValues = [
    "url-password",
    "json-password",
    "json-api-key",
    "raw-child-output",
    "nested-secret",
    "unknown-code-secret",
    "cleanup-password",
    "cleanup-api-key",
  ];
  const primary = new Error(
    'postgresql://runner:url-password@localhost:5432/postgres {"password":"json-password","apikey":"json-api-key"} raw-child-output',
  );
  primary.code = "ETIMEDOUT";
  primary.exitCode = 17;
  primary.stdout = "raw-child-output";
  primary.stderr = "raw-child-output";
  const nested = new Error(`nested-secret ${"x".repeat(10_000)}`);
  nested.code = "unknown-code-secret";
  primary.cause = nested;
  nested.cause = primary;

  const cleanup = cleanupHarness({
    failures: new Set(["writer:cancel", "migration:drain"]),
    failureMessages: new Map([
      ["writer:cancel", "postgresql://cleanup:cleanup-password@localhost/db"],
      ["migration:drain", '{"apikey":"cleanup-api-key"}'],
    ]),
  });
  const cleanupResult = await cleanupStrictBarrierResources({
    resources: cleanupResources,
    adapters: cleanup.adapters,
    timeoutMs: 20,
  });
  const failure = new AggregateError([primary, ...cleanupResult.errors], "raw-child-output", {
    cause: primary,
  });
  const lines = [];

  reportStrictRehearsalFailure(failure, (line) => lines.push(line));
  const output = lines.join("\n");

  assert.match(output, /primary: unclassified_failure/);
  assert.match(output, /code=ETIMEDOUT/);
  assert.match(output, /exit_code=17/);
  assert.match(output, /cleanup_failure resource=writer stage=cancel/);
  assert.match(output, /cleanup_failure resource=migration stage=drain/);
  assert.match(output, /cause: unclassified_failure/);
  for (const sensitive of sensitiveValues) assert.doesNotMatch(output, new RegExp(sensitive, "i"));
  assert.doesNotMatch(output, /postgresql:\/\/|password|apikey|stdout|stderr/i);
  assert.equal(output.length <= 4096, true);

  let cleanupOnlyFailure;
  try {
    await withStrictBarrierCleanup(
      async () => "completed",
      async () => cleanupResult,
    );
  } catch (error) {
    cleanupOnlyFailure = error;
  }
  const cleanupOnlyLines = [];
  reportStrictRehearsalFailure(cleanupOnlyFailure, (line) => cleanupOnlyLines.push(line));
  const cleanupOnlyOutput = cleanupOnlyLines.join("\n");
  assert.match(cleanupOnlyOutput, /cleanup\[1\]: cleanup_failure resource=writer stage=cancel/);
  assert.doesNotMatch(cleanupOnlyOutput, /primary: cleanup_failure/);
});

test("manual cleanup reporting includes only validated owned resource identities", async () => {
  let failure;
  try {
    await runStrictCleanupReset({
      resetStarted: true,
      quiescent: false,
      resources: [
        {
          applicationName: "wp01_strict_123_456_writer",
          label: "writer",
          pid: 731,
        },
        {
          applicationName: "postgresql://runner:manual-secret@localhost/postgres",
          label: "writer;apikey=manual-api-key",
          pid: "731; DROP TABLE users",
        },
      ],
      resetAction: async () => assert.fail("reset must remain blocked"),
    });
  } catch (error) {
    failure = error;
  }
  const lines = [];
  reportStrictRehearsalFailure(failure, (line) => lines.push(line));
  const output = lines.join("\n");

  assert.match(output, /manual_cleanup_required/);
  assert.match(output, /resource=writer pid=731 application=wp01_strict_123_456_writer/);
  assert.doesNotMatch(output, /manual-secret|manual-api-key|DROP TABLE|postgresql:\/\//i);
});

test("the executable entrypoint uses the tested reporter and preserves a nonzero exit", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "wp01-strict-send-116-to-117.mjs"),
    "utf8",
  );
  assert.match(
    source,
    /main\(\)\.catch\(\(error\) => \{\s*reportStrictRehearsalFailure\(error\);\s*process\.exitCode = 1;/,
  );
});

test("deadline rejects synchronous work that returns after budget and passes remaining timeout", async () => {
  let clock = 0;
  let receivedTimeout;

  await assert.rejects(
    () =>
      withDeadline(
        (budget = {}) => {
          receivedTimeout = budget.timeoutMs;
          clock = 11;
          return "late success";
        },
        {
          label: "synchronous executor",
          timeoutMs: 10,
          now: () => clock,
          setTimer: () => 1,
          clearTimer: () => {},
        },
      ),
    /deadline|timed out/i,
  );
  assert.equal(receivedTimeout, 10);
});

function storageTimeout() {
  const error = new Error("local reset failed");
  error.stderr = "/storage/v1/bucket: context deadline exceeded";
  return error;
}

test("accepts a nonzero reset only after a verified expected state", () => {
  const result = runStrictReset({
    target,
    reset: () => {
      throw storageTimeout();
    },
    expectedState: { migrations: 116, latest: "20261006211102", includes117: false },
    waitForReady: () => target,
    verifyState: () => {},
  });
  assert.equal(result.kind, "state_verified_after_local_service_timeout");
});

test("rejects unsafe reset recoveries and an upgrade that adds more than M117", () => {
  for (const input of [
    { error: new Error("generic reset failure"), verifyState: () => {} },
    {
      error: storageTimeout(),
      verifyState: () => {
        throw new Error("latest mismatch");
      },
    },
    {
      error: storageTimeout(),
      waitForReady: () => {
        throw new Error("DB unhealthy");
      },
      verifyState: () => {},
    },
  ]) {
    assert.throws(() =>
      runStrictReset({
        target,
        reset: () => {
          throw input.error;
        },
        expectedState: { migrations: 116, latest: "20261006211102", includes117: false },
        waitForReady: input.waitForReady ?? (() => target),
        verifyState: input.verifyState,
      }),
    );
  }
  assert.doesNotThrow(() =>
    validateStrictUpgradeTransition(
      {
        migrations: 116,
        latest: "20261006211102",
        versions: ["20261006211051", "20261006211056", "20261006211102"],
      },
      {
        migrations: 117,
        latest: "20261013113744",
        versions: ["20261006211051", "20261006211056", "20261006211102", "20261013113744"],
      },
    ),
  );
  assert.throws(() =>
    validateStrictUpgradeTransition(
      {
        migrations: 116,
        latest: "20261006211102",
        versions: ["20261006211051", "20261006211056", "20261006211102"],
      },
      {
        migrations: 118,
        latest: "unexpected",
        versions: [
          "20261006211051",
          "20261006211056",
          "20261006211102",
          "20261013113744",
          "unexpected",
        ],
      },
    ),
  );
});
test("rejects mapping drift before reset state verification and never invokes an upgrade callback", () => {
  let upgraded = false;
  assert.throws(() =>
    runStrictReset({
      target,
      reset: () => {
        throw storageTimeout();
      },
      expectedState: { migrations: 116, latest: "20261006211102", includes117: false },
      waitForReady: () => {
        throw new Error("API container identity drift");
      },
      verifyState: () => {
        upgraded = true;
      },
    }),
  );
  assert.equal(upgraded, false);
});

test("requires M117 for the final cleanup baseline", () => {
  assert.throws(() =>
    validateStrictUpgradeTransition(
      {
        migrations: 116,
        latest: "20261006211102",
        versions: ["20261006211051", "20261006211056", "20261006211102"],
      },
      {
        migrations: 117,
        latest: "20261013113744",
        versions: ["20261006211051", "20261006211056", "20261006211102", "wrong"],
      },
    ),
  );
});
test("requires three stable target samples before strict reset work can begin", () => {
  const calls = [];
  let clock = 0;
  let samples = 0;
  const acquired = acquireStableLocalTarget({
    discoverTarget: () => {
      samples += 1;
      calls.push(`sample-${samples}`);
      return target;
    },
    now: () => clock,
    sleep: (milliseconds) => {
      calls.push("sleep");
      clock += milliseconds;
    },
  });

  runStrictReset({
    target: acquired,
    reset: () => calls.push("reset"),
    expectedState: {},
    waitForReady: () => acquired,
    verifyState: () => calls.push("verify"),
  });

  assert.equal(samples, 3);
  assert.deepEqual(calls, [
    "sample-1",
    "sleep",
    "sample-2",
    "sleep",
    "sample-3",
    "reset",
    "verify",
  ]);
});

test("resets the strict acquisition streak for DB replacement and rejects API drift", () => {
  const recreated = { ...target, db: { ...target.db, id: "d".repeat(64) } };
  const sequence = [target, recreated, recreated, recreated];
  let clock = 0;
  let sleeps = 0;
  assert.deepEqual(
    acquireStableLocalTarget({
      discoverTarget: () => sequence.shift(),
      now: () => clock,
      sleep: (milliseconds) => {
        sleeps += 1;
        clock += milliseconds;
      },
    }),
    recreated,
  );
  assert.equal(sleeps, 3);

  let driftSleeps = 0;
  assert.throws(
    () =>
      acquireStableLocalTarget({
        discoverTarget: (() => {
          let count = 0;
          return () =>
            count++ === 0 ? target : { ...target, api: { ...target.api, id: "e".repeat(64) } };
        })(),
        sleep: () => {
          driftSleeps += 1;
        },
      }),
    /API container identity drift/,
  );
  assert.equal(driftSleeps, 1);
});
const preM117Catalog = {
  authority_evidence_relation: null,
  authority_evidence_index: null,
  strict_send_deployed_column: false,
  acquire_authority_signature: null,
  record_authority_signature: null,
  private_message_signature: null,
  public_message_token_signature: null,
  public_sticker_token_signature: null,
  public_media_token_signature: null,
  public_locked_media_token_signature: null,
  legacy_close_trigger: true,
  public_message_token_anon_execute: null,
  public_message_token_authenticated_execute: null,
};

const postM117Catalog = {
  authority_evidence_relation: "private.handling_send_authority_evidence",
  authority_evidence_index: "private.handling_send_authority_evidence_conversation_idx",
  strict_send_deployed_column: true,
  acquire_authority_signature: "private.acquire_operator_send_authority(uuid,uuid)",
  record_authority_signature:
    "private.record_operator_send_authority_evidence(uuid,uuid,uuid,uuid,uuid,text)",
  private_message_signature: "private.send_operator_message(uuid,text)",
  public_message_token_signature: "public.send_operator_message(uuid,text,uuid)",
  public_sticker_token_signature: "public.send_operator_sticker_message(uuid,uuid,uuid,uuid)",
  public_media_token_signature: "public.send_operator_media_message(uuid,text,text,uuid)",
  public_locked_media_token_signature: "public.send_operator_locked_media_message(uuid,text,uuid)",
  legacy_close_trigger: false,
  public_message_token_anon_execute: false,
  public_message_token_authenticated_execute: true,
};

test("accepts only catalog-safe M116 absence for every M117-created object", () => {
  assert.doesNotThrow(() => assertPreM117ObjectCatalog(preM117Catalog));
  assert.throws(() =>
    assertPreM117ObjectCatalog({
      ...preM117Catalog,
      authority_evidence_relation: "private.handling_send_authority_evidence",
    }),
  );
  assert.throws(() =>
    assertPreM117ObjectCatalog({
      ...preM117Catalog,
      public_message_token_signature: "public.send_operator_message(uuid,text,uuid)",
    }),
  );
  const missing = { ...preM117Catalog };
  delete missing.authority_evidence_relation;
  assert.throws(() => assertPreM117ObjectCatalog(missing));
  assert.throws(() => JSON.parse("not-json"));
});

test("requires M117 objects before evidence row queries and requires cleanup emptiness", () => {
  assert.doesNotThrow(() => assertPostM117ObjectCatalog(postM117Catalog));
  let readerCalled = false;
  assert.throws(() =>
    readAuthorityEvidenceAfterM117(
      { ...postM117Catalog, authority_evidence_relation: null },
      () => {
        readerCalled = true;
        return 0;
      },
    ),
  );
  assert.equal(readerCalled, false);
  assert.equal(
    readAuthorityEvidenceAfterM117(postM117Catalog, () => 2),
    2,
  );
  assert.doesNotThrow(() => assertCleanM117Evidence(postM117Catalog, 0));
  assert.throws(() => assertCleanM117Evidence(postM117Catalog, 1));
});
function exactCleanupMigrationState() {
  const versions = expectedMigrationVersionsFromSource();
  return {
    migrations: versions.length,
    latest: "20261013113744",
    versions,
    includes117: true,
  };
}

function exactCleanResidue() {
  return {
    users: 0,
    profiles: 0,
    conversations: 0,
    messages: 0,
    work_items: 0,
    cycles: 0,
    authority_evidence: 0,
    credit_transactions: 0,
    sticker_attempts: 0,
    notifications: 0,
    analytics: 0,
    attachments: 0,
    reservations: 0,
    storage_objects: 0,
    waiting_locks: 0,
  };
}

test("requires the exact M117 migration history during cleanup", () => {
  const exact = exactCleanupMigrationState();
  assert.doesNotThrow(() => assertCurrentMigrationBaseline(exact, exact.versions));

  const cases = [
    { name: "missing M117", state: { ...exact, includes117: false } },
    { name: "missing version", state: { ...exact, versions: exact.versions.slice(1) } },
    {
      name: "additional version",
      state: { ...exact, versions: [...exact.versions, "99999999999999"] },
    },
    {
      name: "duplicate version",
      state: {
        ...exact,
        versions: [...exact.versions.slice(0, -1), exact.versions.at(-1), exact.versions.at(-1)],
      },
    },
    {
      name: "reordered versions",
      state: {
        ...exact,
        versions: [...exact.versions.slice(0, -2), exact.versions.at(-1), exact.versions.at(-2)],
      },
    },
    { name: "wrong count", state: { ...exact, migrations: exact.migrations - 1 } },
    { name: "wrong latest", state: { ...exact, latest: "20261006211102" } },
  ];

  for (const { name, state } of cases) {
    assert.throws(() => assertCurrentMigrationBaseline(state, exact.versions), name);
  }

  const missingVersions = { ...exact };
  delete missingVersions.versions;
  assert.throws(() => assertCurrentMigrationBaseline(missingVersions, exact.versions));
});

test("requires every cleanup residue counter to be numeric zero", () => {
  const clean = exactCleanResidue();
  assert.doesNotThrow(() => assertCleanResidue(clean));

  for (const key of Object.keys(clean)) {
    assert.throws(() => assertCleanResidue({ ...clean, [key]: 1 }), key);
  }
  assert.throws(() => assertCleanResidue({ ...clean, users: "0" }));
  assert.throws(() => assertCleanResidue({ ...clean, waiting_locks: 1 }));
  assert.equal(Object.hasOwn(clean, "advisory_locks"), false);
  assert.throws(() => assertCleanResidue({ ...clean, advisory_locks: 0 }));
  assert.throws(() => assertCleanResidue({ ...clean, unexpected_counter: 0 }));
});
