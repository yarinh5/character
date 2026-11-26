import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertRestoredMigrationVersions,
  loadApprovedRestoreMigrationVersions,
} from "./wp01-shadow-113-to-116.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const SUPABASE_CLI_EXECUTABLE = "supabase";
const projectId = "qmgkmsarzfjnqltljkjl";
const dbName = `supabase_db_${projectId}`;
const apiName = `supabase_kong_${projectId}`;
const m117 = "20261013113744";
const m118 = "20261019071718";
const failureMetadata = new WeakMap();
const approvedStages = new Set([
  "cleanup_reset",
  "migration_up",
  "preflight",
  "reset_m117",
  "verification",
]);
const approvedOperations = new Set([
  "preflight",
  "reset_m117_identity_before",
  "reset_m117_invoke",
  "reset_m117_discover_after",
  "reset_m117_state",
  "migration_up_identity_before",
  "migration_up_invoke",
  "migration_up_identity_after",
  "post_upgrade_state",
  "post_upgrade_catalog",
  "cleanup_identity_before",
  "cleanup_invoke",
  "cleanup_discover_after",
  "cleanup_state",
  "cleanup_residue",
]);
const approvedSubprocesses = new Set([
  "supabase_db_reset_m117",
  "supabase_migration_up",
  "supabase_db_reset_m118",
]);
const approvedAssertionCategories = new Set([
  "catalog",
  "identity",
  "manifest",
  "residue",
  "state",
]);
const approvedReasonCodes = new Set([
  "container_unavailable",
  "database_connection_failed",
  "migration_command_failed",
  "process_spawn_failed",
  "subprocess_signal",
  "subprocess_timeout",
  "unknown",
]);
const approvedDiagnosticSources = new Set([
  "error_code",
  "none",
  "process_state",
  "stderr",
  "stdout",
]);
const approvedDiagnosticGaps = new Set([
  "none",
  "output_missing",
  "output_oversized",
  "output_unavailable",
  "reason_unrecognized",
]);
const diagnosticOutputLimit = 16_384;
const diagnosticMarkers = [
  {
    reasonCode: "container_unavailable",
    pattern: /(?:no such container|container[^\r\n]{0,120}is not running)/i,
  },
  {
    reasonCode: "database_connection_failed",
    pattern: /(?:connection (?:refused|failed)|could not connect|database is not running)/i,
  },
  {
    reasonCode: "migration_command_failed",
    pattern:
      /(?:(?:migration|migrations|migrate)[^\r\n]{0,160}(?:failed|failure|error)|(?:failed|failure|error)[^\r\n]{0,160}(?:migration|migrations|migrate))/i,
  },
];
const primaryOperationPlan = [
  "preflight",
  "reset_m117_identity_before",
  "reset_m117_invoke",
  "reset_m117_discover_after",
  "reset_m117_state",
  "migration_up_identity_before",
  "migration_up_invoke",
  "migration_up_identity_after",
  "post_upgrade_state",
  "post_upgrade_catalog",
];
const cleanupOperationPlan = [
  "cleanup_identity_before",
  "cleanup_invoke",
  "cleanup_discover_after",
  "cleanup_state",
  "cleanup_residue",
];

export function createAttributionTrace(
  relation = "primary",
  clock = () => new Date(),
  plannedOperations = [],
) {
  assert.ok(relation === "primary" || relation === "cleanup");
  assert.ok(plannedOperations.every((operation) => approvedOperations.has(operation)));
  return {
    relation,
    clock,
    operations: plannedOperations.map((operation) => ({
      relation,
      operation,
      started: false,
      completed: false,
      startedAtUtc: null,
      completedAtUtc: null,
      durationMs: null,
      subprocessInvoked: false,
      subprocess: null,
      assertionCategory: null,
    })),
  };
}

function isoUtc(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function numericExitCode(error) {
  if (Number.isInteger(error?.status)) return error.status;
  if (Number.isInteger(error?.exitCode)) return error.exitCode;
  return null;
}

function approvedSignal(error) {
  const signal = typeof error?.signal === "string" ? error.signal : null;
  return signal && /^SIG[A-Z0-9]{1,16}$/.test(signal) ? signal : null;
}

function diagnosticOutput(value) {
  if (value === undefined || value === null) return { state: "missing", text: "" };
  if (typeof value === "string") return { state: "available", text: value };
  if (Buffer.isBuffer(value)) return { state: "available", text: value.toString("utf8") };
  return { state: "unavailable", text: "" };
}

function closedDiagnosis(reasonCode, source, gap) {
  assert.ok(approvedReasonCodes.has(reasonCode));
  assert.ok(approvedDiagnosticSources.has(source));
  assert.ok(approvedDiagnosticGaps.has(gap));
  return Object.freeze({
    reasonCode,
    diagnostic: Object.freeze({ source, gap }),
  });
}

function diagnoseSubprocessFailure(error) {
  if (error?.code === "ETIMEDOUT" || error?.killed === true) {
    return closedDiagnosis("subprocess_timeout", "process_state", "none");
  }
  if (approvedSignal(error)) {
    return closedDiagnosis("subprocess_signal", "process_state", "none");
  }
  if (error?.code === "ENOENT" || error?.code === "ENOEXEC") {
    return closedDiagnosis("process_spawn_failed", "error_code", "none");
  }
  if (error?.code === "ECONNREFUSED") {
    return closedDiagnosis("database_connection_failed", "error_code", "none");
  }

  const stderr = diagnosticOutput(error?.stderr);
  const stdout = diagnosticOutput(error?.stdout);
  if (stderr.state === "unavailable" || stdout.state === "unavailable") {
    return closedDiagnosis("unknown", "none", "output_unavailable");
  }
  const outputBytes =
    Buffer.byteLength(stderr.text, "utf8") + Buffer.byteLength(stdout.text, "utf8");
  if (outputBytes > diagnosticOutputLimit) {
    return closedDiagnosis("unknown", "none", "output_oversized");
  }
  for (const [source, text] of [
    ["stderr", stderr.text],
    ["stdout", stdout.text],
  ]) {
    for (const marker of diagnosticMarkers) {
      if (marker.pattern.test(text)) return closedDiagnosis(marker.reasonCode, source, "none");
    }
  }
  if (stderr.text.length === 0 && stdout.text.length === 0) {
    return closedDiagnosis("unknown", "none", "output_missing");
  }
  return closedDiagnosis(
    "unknown",
    stderr.text.length > 0 ? "stderr" : "stdout",
    "reason_unrecognized",
  );
}

function sanitizedDiagnosis(value) {
  if (!value || !approvedReasonCodes.has(value.reasonCode)) return null;
  const diagnostic = value.diagnostic;
  if (
    !diagnostic ||
    Object.keys(diagnostic).length !== 2 ||
    !approvedDiagnosticSources.has(diagnostic.source) ||
    !approvedDiagnosticGaps.has(diagnostic.gap)
  ) {
    return null;
  }
  if (
    (value.reasonCode === "unknown" && diagnostic.gap === "none") ||
    (value.reasonCode !== "unknown" && diagnostic.gap !== "none")
  ) {
    return null;
  }
  return {
    reasonCode: value.reasonCode,
    diagnostic: { source: diagnostic.source, gap: diagnostic.gap },
  };
}

function operationCategory(error, subprocess) {
  if (subprocess) return "subprocess_failure";
  if (error?.code === "ERR_ASSERTION") return "assertion_failure";
  return "operation_failure";
}

export async function runAttributedOperation(
  { trace, operation, subprocess = null, assertionCategory = null, timeoutMs = null, summarize },
  action,
) {
  assert.ok(trace && Array.isArray(trace.operations), "attribution trace is required");
  assert.ok(approvedOperations.has(operation), "unapproved attribution operation");
  assert.ok(subprocess === null || approvedSubprocesses.has(subprocess), "unapproved subprocess");
  assert.ok(
    assertionCategory === null || approvedAssertionCategories.has(assertionCategory),
    "unapproved assertion category",
  );
  const started = trace.clock();
  const startedMs = started.valueOf();
  const event = trace.operations.find(
    (candidate) => candidate.operation === operation && !candidate.started,
  ) ?? {
    relation: trace.relation,
    operation,
  };
  Object.assign(event, {
    started: true,
    completed: false,
    startedAtUtc: isoUtc(started),
    completedAtUtc: null,
    durationMs: null,
    subprocessInvoked: subprocess !== null,
    subprocess,
    assertionCategory,
  });
  if (!trace.operations.includes(event)) trace.operations.push(event);
  try {
    const result = await action();
    const completed = trace.clock();
    event.completed = true;
    event.completedAtUtc = isoUtc(completed);
    event.durationMs = Math.max(0, completed.valueOf() - startedMs);
    const summary = typeof summarize === "function" ? summarize(result) : null;
    if (summary && typeof summary === "object") Object.assign(event, summary);
    return result;
  } catch (error) {
    const completed = trace.clock();
    event.completedAtUtc = isoUtc(completed);
    event.durationMs = Math.max(0, completed.valueOf() - startedMs);
    const exitCode = numericExitCode(error);
    const signal = approvedSignal(error);
    if (exitCode !== null) event.exitCode = exitCode;
    if (signal !== null) event.signal = signal;
    if (
      subprocess &&
      Number.isInteger(timeoutMs) &&
      timeoutMs > 0 &&
      (error?.code === "ETIMEDOUT" || error?.killed === true)
    ) {
      event.timeoutMs = timeoutMs;
    }
    const diagnosis = subprocess ? diagnoseSubprocessFailure(error) : null;
    if (diagnosis) Object.assign(event, diagnosis);
    reportable(error, {
      category: operationCategory(error, subprocess),
      relation: trace.relation,
      operation,
      assertionCategory,
      exitCode,
      signal,
      timeoutMs: event.timeoutMs ?? null,
      reasonCode: diagnosis?.reasonCode ?? null,
      diagnostic: diagnosis?.diagnostic ?? null,
    });
    throw error;
  }
}

function reportable(error, metadata) {
  if (error instanceof Error) failureMetadata.set(error, Object.freeze({ ...metadata }));
  return error;
}

export function stageFailure(stage, error, trace, relation = "primary") {
  const failedOperation = trace?.operations.findLast(
    (event) => event.started === true && event.completed === false,
  )?.operation;
  return reportable(new Error("read-access rehearsal stage failed", { cause: error }), {
    category: "stage_failure",
    stage,
    relation,
    operation: failedOperation,
    trace: trace?.operations ?? [],
  });
}

function sanitizeOperation(event) {
  if (!event || !approvedOperations.has(event.operation)) return null;
  const sanitized = {
    relation: event.relation === "cleanup" ? "cleanup" : "primary",
    operation: event.operation,
    started: event.started === true,
    completed: event.completed === true,
    startedAtUtc: event.startedAtUtc === null ? null : isoUtc(event.startedAtUtc),
    completedAtUtc: event.completedAtUtc === null ? null : isoUtc(event.completedAtUtc),
    durationMs:
      Number.isInteger(event.durationMs) && event.durationMs >= 0 ? event.durationMs : null,
    subprocessInvoked: event.subprocessInvoked === true,
  };
  if (approvedSubprocesses.has(event.subprocess)) sanitized.subprocess = event.subprocess;
  if (approvedAssertionCategories.has(event.assertionCategory)) {
    sanitized.assertionCategory = event.assertionCategory;
  }
  if (Number.isInteger(event.exitCode)) sanitized.exitCode = event.exitCode;
  if (typeof event.signal === "string" && /^SIG[A-Z0-9]{1,16}$/.test(event.signal)) {
    sanitized.signal = event.signal;
  }
  if (Number.isInteger(event.timeoutMs) && event.timeoutMs > 0) {
    sanitized.timeoutMs = event.timeoutMs;
  }
  const diagnosis = sanitizedDiagnosis(event);
  if (diagnosis) Object.assign(sanitized, diagnosis);
  if (typeof event.dbIdentityChanged === "boolean") {
    sanitized.dbIdentityChanged = event.dbIdentityChanged;
  }
  if (typeof event.dbRunning === "boolean") sanitized.dbRunning = event.dbRunning;
  if (
    typeof event.dbHealth === "string" &&
    /^(healthy|unhealthy|starting|none|unknown)$/.test(event.dbHealth)
  ) {
    sanitized.dbHealth = event.dbHealth;
  }
  if (Number.isInteger(event.migrationCount) && event.migrationCount >= 0) {
    sanitized.migrationCount = event.migrationCount;
  }
  return sanitized;
}

export function reportReadAccessRehearsalFailure(error) {
  const failures = [];
  const operations = [];
  const operationKeys = new Set();
  const seen = new Set();
  const visit = (value, relation = "primary") => {
    if (!(value instanceof Error) || seen.has(value) || failures.length >= 24) return;
    seen.add(value);
    const metadata = failureMetadata.get(value) ?? {};
    const effectiveRelation = metadata.relation === "cleanup" ? "cleanup" : relation;
    const failure = {
      category:
        typeof metadata.category === "string" && /^[a-z_]{1,48}$/.test(metadata.category)
          ? metadata.category
          : "unknown_failure",
      relation: effectiveRelation,
    };
    if (typeof metadata.stage === "string" && approvedStages.has(metadata.stage)) {
      failure.stage = metadata.stage;
    }
    if (Number.isInteger(metadata.exitCode)) failure.exitCode = metadata.exitCode;
    if (Number.isInteger(metadata.timeoutMs) && metadata.timeoutMs > 0) {
      failure.timeoutMs = metadata.timeoutMs;
    }
    if (approvedOperations.has(metadata.operation)) failure.operation = metadata.operation;
    if (approvedAssertionCategories.has(metadata.assertionCategory)) {
      failure.assertionCategory = metadata.assertionCategory;
    }
    if (typeof metadata.signal === "string" && /^SIG[A-Z0-9]{1,16}$/.test(metadata.signal)) {
      failure.signal = metadata.signal;
    }
    const diagnosis = sanitizedDiagnosis(metadata);
    if (diagnosis) Object.assign(failure, diagnosis);
    failures.push(failure);
    for (const rawEvent of Array.isArray(metadata.trace) ? metadata.trace : []) {
      const event = sanitizeOperation(rawEvent);
      if (!event) continue;
      const key = `${event.relation}:${event.operation}:${event.startedAtUtc}`;
      if (!operationKeys.has(key)) {
        operationKeys.add(key);
        operations.push(event);
      }
    }
    if (value instanceof AggregateError) {
      for (const nested of value.errors.slice(0, 20)) visit(nested, effectiveRelation);
    }
    visit(value.cause, effectiveRelation);
  };
  visit(error);
  return JSON.stringify({
    failures:
      failures.length > 0 ? failures : [{ category: "unknown_failure", relation: "primary" }],
    operations,
    guidance: "Inspect only the verified local WP01.5 target; never reset after identity drift.",
  });
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    windowsHide: true,
    stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    input: options.input,
    timeout: options.timeout ?? 180_000,
  });
}
function supabase(args, options = {}) {
  return run(SUPABASE_CLI_EXECUTABLE, args, { timeout: 240_000, ...options });
}
function inspect(name, internalPort, expectedPort, requireHealthy) {
  const info = JSON.parse(run("docker", ["inspect", name]))[0];
  assert.equal(info.Name, `/${name}`);
  assert.match(info.Id, /^[a-f0-9]{12,}$/i);
  assert.equal(info.State?.Running, true, `${name} must be running`);
  if (requireHealthy) assert.equal(info.State?.Health?.Status, "healthy");
  const mappings = info.NetworkSettings?.Ports?.[internalPort] ?? [];
  assert.ok(mappings.some((entry) => Number(entry.HostPort) === expectedPort));
  return {
    id: info.Id,
    name,
    internalPort,
    hostPort: expectedPort,
    running: info.State?.Running === true,
    health: typeof info.State?.Health?.Status === "string" ? info.State.Health.Status : "none",
  };
}
function port(config, section) {
  const block = config.match(
    new RegExp(`\\[${section.replaceAll(".", "\\.")}\\]([\\s\\S]*?)(?=\\n\\[|$)`),
  );
  assert.ok(block, `missing ${section} config`);
  return Number(block[1].match(/^\s*port\s*=\s*(\d+)\s*$/m)?.[1]);
}
export function discoverReadAccessTarget() {
  const config = readFileSync(join(root, "supabase", "config.toml"));
  const text = config.toString("utf8");
  assert.match(text, new RegExp(`project_id\\s*=\\s*"${projectId}"`));
  const dbPort = port(text, "db");
  const apiPort = port(text, "api");
  const cliVersion = run(SUPABASE_CLI_EXECUTABLE, ["--version"]).trim();
  assert.equal(cliVersion, "2.95.4");
  const dockerContext = run("docker", ["context", "show"]).trim();
  const {
    PRODUCT_DOCKER_CONTEXT: productContext,
    PRODUCT_DOCKER_ENDPOINT: productEndpoint,
    PRODUCT_EXPECTED_ENGINE_ID: expectedEngine,
    PRODUCT_FORBIDDEN_ENGINE_ID: forbiddenEngine,
  } = process.env;
  const productBound = [productContext, productEndpoint, expectedEngine, forbiddenEngine].some(
    (value) => value !== undefined,
  );
  const engineIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  let dockerEndpoint = null;
  if (productBound) {
    // These values are bound by the Product entrypoint; discovery does not select another target.
    for (const key of ["DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) {
      assert.ok(!process.env[key], `${key} override is not permitted in Product`);
    }
    assert.match(
      productContext ?? "",
      /^[a-z0-9][a-z0-9_.-]*$/i,
      "missing or invalid Product context",
    );
    assert.ok(
      !["default", "desktop-linux"].includes(productContext),
      "Product requires its own named context",
    );
    assert.equal(process.env.DOCKER_CONTEXT, productContext, "Product DOCKER_CONTEXT mismatch");
    assert.equal(dockerContext, productContext, "Product Docker context drift");
    assert.equal(
      productEndpoint,
      "unix:///run/docker.sock",
      "Product requires the local Docker socket",
    );
    assert.match(
      expectedEngine ?? "",
      engineIdPattern,
      "missing or invalid Product expected engine ID",
    );
    assert.match(
      forbiddenEngine ?? "",
      engineIdPattern,
      "missing or invalid Product forbidden engine ID",
    );
    assert.notEqual(
      expectedEngine.toLowerCase(),
      forbiddenEngine.toLowerCase(),
      "Product cannot bind the shared engine",
    );
    dockerEndpoint = run("docker", [
      "context",
      "inspect",
      productContext,
      "--format",
      "{{.Endpoints.docker.Host}}",
    ]).trim();
    assert.equal(dockerEndpoint, productEndpoint, "Product Docker endpoint drift");
  } else if (dockerContext === "default") {
    assert.equal(process.env.DOCKER_HOST, "unix:///var/run/docker.sock");
  } else {
    assert.equal(dockerContext, "desktop-linux");
  }

  const dockerEngineId = run("docker", ["info", "--format", "{{.ID}}"]).trim();
  assert.match(dockerEngineId, /^[0-9a-f-]{36}$/i);
  if (productBound) {
    assert.notEqual(
      dockerEngineId.toLowerCase(),
      forbiddenEngine.toLowerCase(),
      "Product reached the shared engine",
    );
    assert.equal(dockerEngineId, expectedEngine, "Product Docker engine drift");
  } else if (dockerContext === "default") {
    assert.equal(dockerEngineId, process.env.CODEX_ISOLATED_DOCKER_ENGINE_ID);
  }
  const status = JSON.parse(supabase(["status", "--output", "json"]));
  for (const [label, value, expectedPort] of [
    ["DB", status.DB_URL, dbPort],
    ["API", status.API_URL, apiPort],
  ]) {
    const url = new URL(value);
    assert.ok(["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname));
    assert.equal(Number(url.port), expectedPort, `${label} endpoint drift`);
  }
  return {
    api: inspect(apiName, "8000/tcp", apiPort, false),
    apiPort,
    cliVersion,
    configHash: createHash("sha256").update(config).digest("hex"),
    db: inspect(dbName, "5432/tcp", dbPort, true),
    dbPort,
    dockerContext,
    dockerEndpoint,
    dockerEngineId,
    projectId,
  };
}

export function assertFrozenReadAccessTarget(reference, candidate, options = {}) {
  for (const field of [
    "projectId",
    "configHash",
    "cliVersion",
    "dockerContext",
    "dockerEndpoint",
    "dockerEngineId",
    "apiPort",
    "dbPort",
  ]) {
    assert.equal(candidate[field], reference[field], `${field} drift`);
  }
  for (const field of ["id", "name", "internalPort", "hostPort"]) {
    assert.equal(candidate.api[field], reference.api[field], "API identity drift");
  }
  assert.equal(candidate.db.name, reference.db.name, "DB name drift");
  assert.equal(candidate.db.internalPort, reference.db.internalPort, "DB internal port drift");
  assert.equal(candidate.db.hostPort, reference.db.hostPort, "DB mapping drift");
  if (!options.allowDbRebind) assert.equal(candidate.db.id, reference.db.id, "DB identity drift");
  return candidate;
}

function identitySummary(reference, candidate) {
  return {
    dbIdentityChanged: reference.db.id !== candidate.db.id,
    dbRunning: candidate.db.running === true,
    dbHealth: ["healthy", "unhealthy", "starting", "none"].includes(candidate.db.health)
      ? candidate.db.health
      : "unknown",
  };
}

export async function runVerifiedReadAccessMutation({
  frozen,
  discover,
  mutate,
  trace = null,
  operations = {},
}) {
  const before = trace
    ? await runAttributedOperation(
        {
          trace,
          operation: operations.identityBefore,
          assertionCategory: "identity",
          summarize: (candidate) => identitySummary(frozen, candidate),
        },
        async () => assertFrozenReadAccessTarget(frozen, await discover()),
      )
    : assertFrozenReadAccessTarget(frozen, await discover());
  const result = trace
    ? await runAttributedOperation(
        {
          trace,
          operation: operations.invoke,
          subprocess: operations.subprocess,
          timeoutMs: 240_000,
        },
        mutate,
      )
    : await mutate();
  if (trace) {
    await runAttributedOperation(
      {
        trace,
        operation: operations.identityAfter,
        assertionCategory: "identity",
        summarize: (candidate) => identitySummary(before, candidate),
      },
      async () => assertFrozenReadAccessTarget(before, await discover()),
    );
  } else {
    assertFrozenReadAccessTarget(frozen, await discover());
  }
  return { frozen, result };
}

export async function runVerifiedReadAccessReset({
  frozen,
  discover,
  reset,
  trace = null,
  operations = {},
}) {
  if (trace) {
    await runAttributedOperation(
      {
        trace,
        operation: operations.identityBefore,
        assertionCategory: "identity",
        summarize: (candidate) => identitySummary(frozen, candidate),
      },
      async () => assertFrozenReadAccessTarget(frozen, await discover()),
    );
  } else {
    assertFrozenReadAccessTarget(frozen, await discover());
  }
  const result = trace
    ? await runAttributedOperation(
        {
          trace,
          operation: operations.invoke,
          subprocess: operations.subprocess,
          timeoutMs: 240_000,
        },
        reset,
      )
    : await reset();
  const candidate = trace
    ? await runAttributedOperation(
        {
          trace,
          operation: operations.discoverAfter,
          assertionCategory: "identity",
          summarize: (next) => identitySummary(frozen, next),
        },
        async () => {
          const next = await discover();
          return assertFrozenReadAccessTarget(frozen, next, { allowDbRebind: true });
        },
      )
    : await discover();
  if (!trace) assertFrozenReadAccessTarget(frozen, candidate, { allowDbRebind: true });
  return { frozen: candidate, result };
}

function sql(frozen, statement) {
  assertFrozenReadAccessTarget(frozen, discoverReadAccessTarget());
  return run(
    "docker",
    [
      "exec",
      "-i",
      frozen.db.id,
      "psql",
      "-X",
      "-qAt",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: statement },
  );
}
function json(frozen, statement) {
  return JSON.parse(sql(frozen, statement).trim().split(/\r?\n/).at(-1));
}
function state(frozen) {
  return json(
    frozen,
    `SELECT json_build_object(
    'count',(SELECT count(DISTINCT version) FROM supabase_migrations.schema_migrations),
    'latest',(SELECT max(version) FROM supabase_migrations.schema_migrations),
    'versions',(SELECT coalesce(json_agg(version ORDER BY version), '[]'::json) FROM supabase_migrations.schema_migrations),
    'm117',(SELECT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='${m117}')),
    'm118',(SELECT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='${m118}'))
  );`,
  );
}

export function buildReadAccessResetArgs(version) {
  const args = ["db", "reset", "--local", "--no-seed"];
  if (version !== undefined && version !== null) {
    assert.match(version, /^\d{14}$/u, "migration version must contain 14 digits");
    args.push("--version", version);
  }
  return args;
}

async function reset(frozen, version, trace, phase) {
  const isCleanup = phase === "cleanup";
  return runVerifiedReadAccessReset({
    frozen,
    discover: discoverReadAccessTarget,
    reset: () => supabase(buildReadAccessResetArgs(version)),
    trace,
    operations: {
      identityBefore: isCleanup ? "cleanup_identity_before" : "reset_m117_identity_before",
      invoke: isCleanup ? "cleanup_invoke" : "reset_m117_invoke",
      discoverAfter: isCleanup ? "cleanup_discover_after" : "reset_m117_discover_after",
      subprocess: isCleanup ? "supabase_db_reset_m118" : "supabase_db_reset_m117",
    },
  });
}

export function buildReadAccessMigrationManifest(fileNames) {
  assert.ok(Array.isArray(fileNames), "migration filenames must be an array");
  const seen = new Set();
  const entries = fileNames
    .map((name) => {
      const match = /^(\d{14})_.+\.sql$/u.exec(name);
      assert.ok(match, `malformed migration filename: ${name}`);
      assert.equal(seen.has(match[1]), false, `duplicate migration version: ${match[1]}`);
      seen.add(match[1]);
      return { name, version: match[1] };
    })
    .filter(({ version }) => version <= m118)
    .sort((left, right) => left.version.localeCompare(right.version));
  assert.equal(entries.length, 118, "read-access rehearsal must contain M001-M118 only");
  assert.equal(entries.at(-1)?.version, m118, "read-access rehearsal must end at M118");
  assert.deepEqual(
    entries.filter(({ version }) => version > m117).map(({ version }) => version),
    [m118],
  );
  return entries;
}

function verifySourceManifest() {
  const migrationsDirectory = join(root, "supabase", "migrations");
  const names = readdirSync(migrationsDirectory).sort();
  for (const name of names) {
    assert.ok(
      lstatSync(join(migrationsDirectory, name)).isFile(),
      `migration source must be a regular file: ${name}`,
    );
  }
  return buildReadAccessMigrationManifest(names);
}

function createReadAccessUpgradeWorkdir(manifest) {
  const workdir = mkdtempSync(join(tmpdir(), "wp01-read-access-117-118-"));
  const destinationSupabase = join(workdir, "supabase");
  const destinationMigrations = join(destinationSupabase, "migrations");
  try {
    mkdirSync(destinationMigrations, { recursive: true });
    const sourceConfig = join(root, "supabase", "config.toml");
    const copiedConfig = join(destinationSupabase, "config.toml");
    copyFileSync(sourceConfig, copiedConfig);
    assert.deepEqual(readFileSync(copiedConfig), readFileSync(sourceConfig));
    for (const entry of manifest) {
      const source = join(root, "supabase", "migrations", entry.name);
      const destination = join(destinationMigrations, entry.name);
      copyFileSync(source, destination);
      assert.equal(
        createHash("sha256").update(readFileSync(destination)).digest("hex"),
        createHash("sha256").update(readFileSync(source)).digest("hex"),
        `isolated migration hash mismatch: ${entry.name}`,
      );
    }
    return { workdir, destroy: () => rmSync(workdir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(workdir, { recursive: true, force: true });
    throw error;
  }
}

export function assertReadAccessMigrationState(actual, expectedVersions) {
  assert.equal(typeof actual, "object", "migration state must be an object");
  assert.notEqual(actual, null, "migration state must not be null");
  assert.equal(Array.isArray(actual), false, "migration state must not be an array");
  assert.deepEqual(
    Object.keys(actual).sort(),
    ["count", "latest", "m117", "m118", "versions"].sort(),
    "migration state must contain exactly the required fields",
  );
  assertRestoredMigrationVersions(actual.versions, expectedVersions);
  assert.equal(actual.count, expectedVersions.length, "migration count must match history");
  assert.equal(actual.latest, expectedVersions.at(-1), "latest migration must match history");
  assert.equal(actual.m117, expectedVersions.includes(m117), "M117 presence must match history");
  assert.equal(actual.m118, expectedVersions.includes(m118), "M118 presence must match history");
}

function verifyM118Contract(frozen) {
  const catalog = json(
    frozen,
    `SELECT json_build_object(
    'access_table',to_regclass('public.user_conversation_access_versions') IS NOT NULL,
    'presence_table',to_regclass('public.conversation_presence_states') IS NOT NULL,
    'read_rpc',to_regprocedure('public.get_conversation_read_access(uuid)') IS NOT NULL,
    'presence_rpc',to_regprocedure('public.set_conversation_presence(uuid,text,text,boolean,boolean)') IS NOT NULL,
    'status_rpc',to_regprocedure('public.update_operator_conversation_status(uuid,public.conversation_status)') IS NOT NULL,
    'anon_read',has_function_privilege('anon','public.get_conversation_read_access(uuid)','EXECUTE'),
    'direct_presence_write',has_table_privilege('authenticated','public.conversation_presence_states','INSERT'),
    'direct_status_write',has_column_privilege('authenticated','public.conversations','status','UPDATE'),
    'mode',(SELECT mode FROM private.handling_contract_runtime WHERE singleton)
  );`,
  );
  assert.deepEqual(catalog, {
    access_table: true,
    presence_table: true,
    read_rpc: true,
    presence_rpc: true,
    status_rpc: true,
    anon_read: false,
    direct_presence_write: false,
    direct_status_write: false,
    mode: "legacy_shadow",
  });
  return catalog;
}

export async function runReadAccessUpgradeRehearsal() {
  const approvedMigrationVersions = loadApprovedRestoreMigrationVersions();
  const primaryTrace = createAttributionTrace("primary", () => new Date(), primaryOperationPlan);
  let frozen;
  let primary;
  let upgradeWorkdir;
  let versionsThrough117;
  let versionsThrough118;
  try {
    frozen = await runAttributedOperation(
      { trace: primaryTrace, operation: "preflight", assertionCategory: "manifest" },
      async () => {
        const manifest = verifySourceManifest();
        versionsThrough118 = manifest.map(({ version }) => version);
        versionsThrough117 = versionsThrough118.filter((version) => version <= m117);
        upgradeWorkdir = createReadAccessUpgradeWorkdir(manifest);
        return discoverReadAccessTarget();
      },
    );
    ({ frozen } = await reset(frozen, m117, primaryTrace, "primary"));
    await runAttributedOperation(
      {
        trace: primaryTrace,
        operation: "reset_m117_state",
        assertionCategory: "state",
        summarize: (actual) => ({ migrationCount: actual.count }),
      },
      async () => {
        const actual = state(frozen);
        assertReadAccessMigrationState(actual, versionsThrough117);
        assert.equal(
          json(
            frozen,
            "SELECT json_build_object('access',to_regclass('public.user_conversation_access_versions')); ",
          ).access,
          null,
        );
        return actual;
      },
    );
    ({ frozen } = await runVerifiedReadAccessMutation({
      frozen,
      discover: discoverReadAccessTarget,
      mutate: () =>
        supabase(["migration", "up", "--local", "--workdir", upgradeWorkdir.workdir], {
          cwd: upgradeWorkdir.workdir,
        }),
      trace: primaryTrace,
      operations: {
        identityBefore: "migration_up_identity_before",
        invoke: "migration_up_invoke",
        identityAfter: "migration_up_identity_after",
        subprocess: "supabase_migration_up",
      },
    }));
    await runAttributedOperation(
      {
        trace: primaryTrace,
        operation: "post_upgrade_state",
        assertionCategory: "state",
        summarize: (actual) => ({ migrationCount: actual.count }),
      },
      async () => {
        const actual = state(frozen);
        assertReadAccessMigrationState(actual, versionsThrough118);
        return actual;
      },
    );
    await runAttributedOperation(
      { trace: primaryTrace, operation: "post_upgrade_catalog", assertionCategory: "catalog" },
      async () => verifyM118Contract(frozen),
    );
    console.log("WP01.5 upgrade rehearsal passed: 117 -> 118; read/revocation contract verified");
  } catch (error) {
    primary = stageFailure(frozen ? "verification" : "preflight", error, primaryTrace, "primary");
  }

  let cleanup;
  if (frozen) {
    const cleanupTrace = createAttributionTrace("cleanup", () => new Date(), cleanupOperationPlan);
    try {
      ({ frozen } = await reset(frozen, null, cleanupTrace, "cleanup"));
      await runAttributedOperation(
        {
          trace: cleanupTrace,
          operation: "cleanup_state",
          assertionCategory: "state",
          summarize: (actual) => ({ migrationCount: actual.count }),
        },
        async () => {
          const actual = state(frozen);
          assertReadAccessMigrationState(actual, approvedMigrationVersions);
          return actual;
        },
      );
      await runAttributedOperation(
        { trace: cleanupTrace, operation: "cleanup_residue", assertionCategory: "residue" },
        async () => {
          const residue = json(
            frozen,
            "SELECT json_build_object('users',(SELECT count(*) FROM auth.users),'conversations',(SELECT count(*) FROM public.conversations),'messages',(SELECT count(*) FROM public.messages));",
          );
          assert.deepEqual(residue, { users: 0, conversations: 0, messages: 0 });
          return residue;
        },
      );
      console.log(
        `Restored clean local ${approvedMigrationVersions.length}-migration approved baseline`,
      );
    } catch (error) {
      cleanup = stageFailure("cleanup_reset", error, cleanupTrace, "cleanup");
    }
  }
  upgradeWorkdir?.destroy();
  if (primary && cleanup) throw new AggregateError([primary, cleanup]);
  if (primary) throw primary;
  if (cleanup) throw cleanup;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  runReadAccessUpgradeRehearsal().catch((error) => {
    console.error(reportReadAccessRehearsalFailure(error));
    process.exitCode = 1;
  });
}
