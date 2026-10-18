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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const projectId = "qmgkmsarzfjnqltljkjl";
const container = "supabase_db_qmgkmsarzfjnqltljkjl";
const apiContainer = "supabase_kong_qmgkmsarzfjnqltljkjl";
const version113 = "20261005120910";
const version116 = "20261006211102";
const fixturePath = join(repoRoot, "supabase", "tests", "upgrades", "wp01-shadow-113-fixture.sql");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    windowsHide: true,
    stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 180_000,
    input: options.input,
  });
}

function supabase(args, options = {}) {
  return run("supabase", args, { timeout: 300_000, ...options });
}

function sql(statement) {
  return run(
    "docker",
    [
      "exec",
      "-i",
      container,
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
    { input: statement, timeout: 60_000 },
  ).trim();
}

function json(statement) {
  return JSON.parse(sql(statement));
}

export function assertMigrationAbsenceResult(result) {
  assert.equal(typeof result, "object", "migration absence result must be an object");
  assert.notEqual(result, null, "migration absence result must not be null");
  assert.equal(Array.isArray(result), false, "migration absence result must not be an array");
  assert.ok(
    Object.hasOwn(result, "m117_present"),
    "migration absence result must include m117_present",
  );
  assert.equal(typeof result.m117_present, "boolean", "m117_present must be a boolean");
  assert.equal(
    result.m117_present,
    false,
    "M117 must be absent from the isolated migration history",
  );
}

function configPort(config, section) {
  const sectionPattern = section.replaceAll(".", "\\.");
  const match = config.match(new RegExp(`\\[${sectionPattern}\\]([\\s\\S]*?)(?=\\n\\[|$)`));
  assert.ok(match, `missing [${section}] local configuration`);
  const port = match[1].match(/^\s*port\s*=\s*(\d+)\s*$/m);
  assert.ok(port, `missing [${section}].port local configuration`);
  return Number(port[1]);
}

function assertLoopbackUrl(value, expectedPort, label) {
  const url = new URL(String(value));
  assert.ok(
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname),
    `${label} must use a loopback host`,
  );
  assert.equal(Number(url.port), expectedPort, `${label} must match config.toml`);
}

function assertDockerPort(info, name, internalPort, expectedPort, { requireHealthy = false } = {}) {
  assert.equal(info.Name, `/${name}`);
  assert.equal(info.State?.Running, true, `${name} must be running`);
  if (requireHealthy) {
    assert.equal(info.State?.Health?.Status, "healthy", `${name} must be healthy`);
  }
  assert.match(info.Id, /^[a-f0-9]{12,}$/i, `${name} must have a Docker ID`);
  const published = info.NetworkSettings?.Ports?.[internalPort] ?? [];
  assert.ok(
    published.some((entry) => Number(entry.HostPort) === expectedPort),
    `${name} ${internalPort} must match config.toml`,
  );
  return { id: info.Id, name };
}

export function validateLocalTarget({ config, status, db, api }) {
  const configText = Buffer.isBuffer(config) ? config.toString("utf8") : String(config);
  assert.match(configText, new RegExp(`project_id\\s*=\\s*"${projectId}"`));
  const apiPort = configPort(configText, "api");
  const dbPort = configPort(configText, "db");
  assertLoopbackUrl(status.API_URL, apiPort, "local API URL");
  assertLoopbackUrl(status.DB_URL, dbPort, "local DB URL");
  return {
    apiContainer: assertDockerPort(api, apiContainer, "8000/tcp", apiPort),
    apiPort,
    configHash: createHash("sha256").update(config).digest("hex"),
    dbContainer: assertDockerPort(db, container, "5432/tcp", dbPort, { requireHealthy: true }),
    dbPort,
    projectId,
  };
}

function assertLocalTarget() {
  const config = readFileSync(join(repoRoot, "supabase", "config.toml"));
  const configText = config.toString("utf8");
  assert.match(configText, new RegExp(`project_id\\s*=\\s*"${projectId}"`));
  const apiPort = configPort(configText, "api");
  const dbPort = configPort(configText, "db");
  const [api] = JSON.parse(run("docker", ["inspect", apiContainer]));
  const verifiedApi = assertDockerPort(api, apiContainer, "8000/tcp", apiPort);

  let db;
  try {
    [db] = JSON.parse(run("docker", ["inspect", container]));
  } catch (error) {
    throw new ResetReadinessError("db_unavailable", `${container} is temporarily unavailable`, {
      cause: error,
    });
  }
  const verifiedDb = assertExpectedDatabaseContainer(db, dbPort);

  let status;
  try {
    status = JSON.parse(supabase(["status", "--output", "json"]));
  } catch (error) {
    throw new ResetReadinessError(
      "status_unavailable",
      "local Supabase status is temporarily unavailable",
      { cause: error },
    );
  }
  assertLoopbackUrl(status.API_URL, apiPort, "local API URL");
  assertLoopbackUrl(status.DB_URL, dbPort, "local DB URL");
  return {
    apiContainer: verifiedApi,
    apiPort,
    configHash: createHash("sha256").update(config).digest("hex"),
    dbContainer: verifiedDb,
    dbPort,
    projectId,
  };
}
export function assertValidatedTargetIdentity(target, currentTarget) {
  assert.deepEqual(
    currentTarget,
    target,
    "validated local target identity changed; manual cleanup is required for the original target",
  );
}

export function rebindTargetAfterDatabaseReset(target, currentTarget) {
  assert.equal(currentTarget.projectId, target.projectId);
  assert.equal(currentTarget.configHash, target.configHash);
  assert.equal(currentTarget.apiPort, target.apiPort);
  assert.equal(currentTarget.dbPort, target.dbPort);
  assert.deepEqual(currentTarget.apiContainer, target.apiContainer);
  assert.equal(currentTarget.dbContainer.name, target.dbContainer.name);
  return currentTarget;
}

export class ResetReadinessError extends Error {
  constructor(kind, message, options = {}) {
    super(message, options);
    this.name = "ResetReadinessError";
    this.kind = kind;
  }
}

function manualCleanupError(target, message, cause) {
  return new Error(
    `${message}; manual cleanup is required for ${target.dbContainer.name} (${target.dbContainer.id}) and ${target.apiContainer.name} (${target.apiContainer.id})`,
    { cause },
  );
}

export function assertImmutableTargetSnapshot(target, { config, api }) {
  const configText = Buffer.isBuffer(config) ? config.toString("utf8") : String(config);
  assert.match(configText, new RegExp(`project_id\\s*=\\s*"${projectId}"`));
  const apiPort = configPort(configText, "api");
  const dbPort = configPort(configText, "db");
  const configHash = createHash("sha256").update(config).digest("hex");
  assert.equal(configHash, target.configHash, "local config identity changed");
  assert.equal(apiPort, target.apiPort, "local API port changed");
  assert.equal(dbPort, target.dbPort, "local DB port changed");
  assert.deepEqual(
    assertDockerPort(api, apiContainer, "8000/tcp", apiPort),
    target.apiContainer,
    "local API container identity changed",
  );
  return { apiPort, dbPort };
}

function assertImmutableLocalTarget(target) {
  const config = readFileSync(join(repoRoot, "supabase", "config.toml"));
  const [api] = JSON.parse(run("docker", ["inspect", apiContainer]));
  return assertImmutableTargetSnapshot(target, { config, api });
}

function assertExpectedDatabaseContainer(db, dbPort) {
  assert.equal(db.Name, `/${container}`, "local DB container name changed");
  assert.match(db.Id, /^[a-f0-9]{12,}$/i, `${container} must have a Docker ID`);
  const published = db.NetworkSettings?.Ports?.["5432/tcp"] ?? [];
  assert.ok(
    published.some((entry) => Number(entry.HostPort) === dbPort),
    `${container} 5432/tcp must match config.toml`,
  );
  if (db.State?.Running !== true) {
    throw new ResetReadinessError("db_not_ready", `${container} is not running`);
  }
  if (db.State?.Health?.Status !== "healthy") {
    throw new ResetReadinessError(
      "db_not_ready",
      `${container} is ${db.State?.Health?.Status ?? "unhealthy"}`,
    );
  }
  return assertDockerPort(db, container, "5432/tcp", dbPort, { requireHealthy: true });
}

export function inspectReadyTargetSnapshot(
  target,
  {
    config,
    api,
    db,
    identity = assertImmutableTargetSnapshot(target, { config, api }),
    readStatus,
  },
) {
  assert.ok(typeof readStatus === "function", "a local status reader is required");
  const dbContainer = assertExpectedDatabaseContainer(db, identity.dbPort);
  let status;
  try {
    status = readStatus();
  } catch (error) {
    throw new ResetReadinessError(
      "status_unavailable",
      "local Supabase status is temporarily unavailable",
      { cause: error },
    );
  }
  assertLoopbackUrl(status.API_URL, identity.apiPort, "local API URL");
  assertLoopbackUrl(status.DB_URL, identity.dbPort, "local DB URL");
  return rebindTargetAfterDatabaseReset(target, { ...target, dbContainer });
}

function inspectReadyLocalTarget(target) {
  const config = readFileSync(join(repoRoot, "supabase", "config.toml"));
  const [api] = JSON.parse(run("docker", ["inspect", apiContainer]));
  const identity = assertImmutableTargetSnapshot(target, { config, api });
  let db;
  try {
    [db] = JSON.parse(run("docker", ["inspect", container]));
  } catch (error) {
    throw new ResetReadinessError("db_unavailable", `${container} is temporarily unavailable`, {
      cause: error,
    });
  }
  return inspectReadyTargetSnapshot(target, {
    api,
    config,
    db,
    identity,
    readStatus: () => JSON.parse(supabase(["status", "--output", "json"])),
  });
}
function assertLocalTargetIdentity(target) {
  try {
    assertValidatedTargetIdentity(target, assertLocalTarget());
  } catch (error) {
    throw manualCleanupError(target, "validated local target identity changed", error);
  }
}

function defaultSleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function isTransientResetReadinessError(error) {
  return (
    error instanceof ResetReadinessError &&
    ["db_unavailable", "db_not_ready", "status_unavailable"].includes(error.kind)
  );
}

function assertStableAcquisitionIdentity(reference, candidate) {
  assert.equal(
    candidate.projectId,
    reference.projectId,
    "project identity changed during target acquisition",
  );
  assert.equal(
    candidate.configHash,
    reference.configHash,
    "config identity changed during target acquisition",
  );
  assert.equal(candidate.apiPort, reference.apiPort, "API port changed during target acquisition");
  assert.equal(candidate.dbPort, reference.dbPort, "DB port changed during target acquisition");
  assert.deepEqual(
    candidate.apiContainer,
    reference.apiContainer,
    "API container identity drift during target acquisition",
  );
  assert.equal(
    candidate.dbContainer.name,
    reference.dbContainer.name,
    "DB container name changed during target acquisition",
  );
}

export function acquireStableLocalTarget({
  discoverTarget,
  deadlineMilliseconds = 120_000,
  intervalMilliseconds = 1_000,
  now = Date.now,
  sleep = defaultSleep,
  requiredSamples = 3,
} = {}) {
  assert.ok(typeof discoverTarget === "function", "a local target discovery function is required");
  assert.ok(
    Number.isFinite(deadlineMilliseconds) && deadlineMilliseconds >= 0,
    "deadline must be non-negative",
  );
  assert.ok(
    Number.isFinite(intervalMilliseconds) && intervalMilliseconds > 0,
    "polling interval must be positive",
  );
  assert.equal(
    requiredSamples,
    3,
    "local target acquisition requires exactly three stable samples",
  );

  const deadline = now() + deadlineMilliseconds;
  let candidate;
  let stableSamples = 0;
  let lastError;

  while (true) {
    try {
      const current = discoverTarget();
      if (!candidate) {
        candidate = current;
        stableSamples = 1;
      } else {
        assertStableAcquisitionIdentity(candidate, current);
        if (current.dbContainer.id !== candidate.dbContainer.id) {
          candidate = current;
          stableSamples = 1;
        } else {
          stableSamples += 1;
        }
      }
      if (stableSamples === requiredSamples) return candidate;
    } catch (error) {
      if (!isTransientResetReadinessError(error)) throw error;
      candidate = undefined;
      stableSamples = 0;
      lastError = error;
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(
        `local target did not remain stable for ${requiredSamples} samples within ${deadlineMilliseconds}ms: ${lastError?.message ?? "insufficient stable samples"}`,
        { cause: lastError },
      );
    }
    sleep(Math.min(intervalMilliseconds, remaining));
  }
}
export function waitForValidatedTargetAfterReset(
  target,
  {
    assertImmutableTarget = () => {},
    deadlineMilliseconds = 120_000,
    discoverTarget,
    now = Date.now,
    sleep = defaultSleep,
    intervalMilliseconds = 1_000,
  } = {},
) {
  assert.ok(
    typeof assertImmutableTarget === "function",
    "an immutable target assertion is required",
  );
  assert.ok(typeof discoverTarget === "function", "a target discovery function is required");
  assert.ok(
    Number.isFinite(deadlineMilliseconds) && deadlineMilliseconds >= 0,
    "deadline must be non-negative",
  );
  assert.ok(
    Number.isFinite(intervalMilliseconds) && intervalMilliseconds > 0,
    "polling interval must be positive",
  );

  const deadline = now() + deadlineMilliseconds;
  let lastError;
  while (true) {
    assertImmutableTarget(target);
    try {
      return rebindTargetAfterDatabaseReset(target, discoverTarget());
    } catch (error) {
      lastError = error;
      if (!isTransientResetReadinessError(error)) {
        throw manualCleanupError(
          target,
          "validated local target identity changed after reset",
          error,
        );
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw manualCleanupError(
          target,
          `local DB did not become ready within ${deadlineMilliseconds}ms after reset`,
          lastError,
        );
      }
      sleep(Math.min(intervalMilliseconds, remaining));
    }
  }
}

export function resetAndWait({ target, reset, waitForReady }) {
  reset(target);
  return waitForReady(target);
}

function rebindLocalTargetAfterDatabaseReset(target) {
  return waitForValidatedTargetAfterReset(target, {
    assertImmutableTarget: assertImmutableLocalTarget,
    discoverTarget: () => inspectReadyLocalTarget(target),
  });
}
export function runValidatedUpgrade({
  validateTarget,
  verifyTarget,
  resetTo113,
  upgrade,
  cleanup,
  reportCleanupFailure = () => {},
}) {
  let target = validateTarget();
  let restoreRequired = false;
  let failure;

  try {
    verifyTarget(target);
    restoreRequired = true;
    target = resetTo113(target) ?? target;
    return upgrade(target);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (restoreRequired) {
      try {
        verifyTarget(target);
        cleanup(target);
      } catch (cleanupError) {
        if (!failure) throw cleanupError;
        reportCleanupFailure(cleanupError);
      }
    }
  }
}

const expectedUpgradeVersions = ["20261006211051", "20261006211056", "20261006211102"];

export function buildThroughVersionManifest(fileNames, cutoffVersion = version116) {
  const versions = new Set();
  const parsed = fileNames.map((name) => {
    const match = /^(\d{14})_(.+)\.sql$/.exec(name);
    assert.ok(match, `invalid migration filename: ${name}`);
    assert.ok(!versions.has(match[1]), `duplicate migration version: ${match[1]}`);
    versions.add(match[1]);
    return { name, version: match[1] };
  });
  const manifest = parsed
    .filter((entry) => entry.version <= cutoffVersion)
    .sort((left, right) => left.version.localeCompare(right.version));
  for (const version of expectedUpgradeVersions) {
    assert.ok(
      manifest.some((entry) => entry.version === version),
      `missing required migration: ${version}`,
    );
  }
  assert.ok(
    !manifest.some((entry) => entry.version >= "20261013113744"),
    "manifest must exclude M117 and later migrations",
  );
  return manifest;
}

export function assertBeforeVersionsInManifest(beforeVersions, manifest) {
  const manifestVersions = new Set(manifest.map((entry) => entry.version));
  for (const version of beforeVersions) {
    assert.ok(
      manifestVersions.has(version),
      `applied migration is missing from temporary manifest: ${version}`,
    );
  }
}

export function assertExactUpgradeDifference(beforeVersions, afterVersions) {
  const before = new Set(beforeVersions);
  const after = new Set(afterVersions);
  assert.equal(before.size, beforeVersions.length, "before migration history contains duplicates");
  assert.equal(after.size, afterVersions.length, "after migration history contains duplicates");
  for (const version of before)
    assert.ok(after.has(version), `migration disappeared during upgrade: ${version}`);
  const added = [...after].filter((version) => !before.has(version)).sort();
  assert.deepEqual(added, expectedUpgradeVersions, "upgrade must add exactly M114-M116");
  return added;
}

export function assertCopiedConfigMatches(sourceConfig, copiedConfig) {
  assert.deepEqual(
    copiedConfig,
    sourceConfig,
    "temporary config.toml must match the active config byte-for-byte",
  );
}
export function assertIsolatedMigrationManifest(files, { expectedManifest, expectedHashes } = {}) {
  const expected =
    expectedManifest ??
    files.map((file) => ({ name: file.name, version: /^(\d{14})_/.exec(file.name)?.[1] }));
  const normalizedExpected = expected
    .map((file) => ({ name: file.name, version: file.version }))
    .sort((left, right) => left.version.localeCompare(right.version));
  const normalizedActual = files
    .map((file) => ({
      name: file.name,
      version: file.version ?? /^(\d{14})_/.exec(file.name)?.[1],
    }))
    .sort((left, right) => left.version.localeCompare(right.version));
  assert.deepEqual(
    normalizedActual,
    normalizedExpected,
    "temporary migration manifest differs from the expected full-through-M116 manifest",
  );
  if (expectedHashes) {
    for (const file of files) {
      assert.equal(
        file.hash,
        expectedHashes.get(file.name),
        `isolated migration hash mismatch: ${file.name}`,
      );
    }
  }
}

export function createIsolatedUpgradeWorkdir({
  sourceRoot = repoRoot,
  temporaryRoot = tmpdir(),
} = {}) {
  const workdir = mkdtempSync(join(temporaryRoot, "wp01-shadow-113-116-"));
  const sourceSupabase = join(sourceRoot, "supabase");
  const destinationSupabase = join(workdir, "supabase");
  const sourceMigrations = join(sourceSupabase, "migrations");
  const destinationMigrations = join(destinationSupabase, "migrations");
  try {
    const sourceNames = readdirSync(sourceMigrations);
    for (const name of sourceNames) {
      assert.ok(
        lstatSync(join(sourceMigrations, name)).isFile(),
        `migration source must be a regular file: ${name}`,
      );
    }
    const manifest = buildThroughVersionManifest(sourceNames);
    const sourceConfig = readFileSync(join(sourceSupabase, "config.toml"));
    mkdirSync(destinationMigrations, { recursive: true });
    copyFileSync(join(sourceSupabase, "config.toml"), join(destinationSupabase, "config.toml"));
    const expectedHashes = new Map();
    for (const entry of manifest) {
      const source = join(sourceMigrations, entry.name);
      const bytes = readFileSync(source);
      expectedHashes.set(entry.name, createHash("sha256").update(bytes).digest("hex"));
      copyFileSync(source, join(destinationMigrations, entry.name));
    }
    const copiedConfig = readFileSync(join(destinationSupabase, "config.toml"));
    assertCopiedConfigMatches(sourceConfig, copiedConfig);
    const copiedManifest = readdirSync(destinationMigrations).map((name) => ({
      name,
      version: /^(\d{14})_/.exec(name)?.[1],
      hash: createHash("sha256")
        .update(readFileSync(join(destinationMigrations, name)))
        .digest("hex"),
    }));
    assertIsolatedMigrationManifest(copiedManifest, { expectedManifest: manifest, expectedHashes });
    return {
      workdir,
      manifest,
      destroy: () => rmSync(workdir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(workdir, { recursive: true, force: true });
    throw error;
  }
}
export class ResetResultError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ResetResultError";
    this.kind = "fatal_failure";
  }
}

export function isLocalStorageReadinessTimeout(error) {
  const diagnostics = `${error?.stderr ?? ""}\n${error?.message ?? ""}`;
  return (
    diagnostics.includes("/storage/v1/bucket") && diagnostics.includes("context deadline exceeded")
  );
}

export function runResetWithVerifiedState({
  target,
  reset,
  waitForReady,
  expectedState,
  verifyState,
}) {
  let resetError;
  try {
    reset(target);
  } catch (error) {
    resetError = error;
  }

  if (resetError && !isLocalStorageReadinessTimeout(resetError)) {
    throw new ResetResultError("local reset failed before state verification", {
      cause: resetError,
    });
  }

  let readyTarget;
  try {
    readyTarget = waitForReady(target);
  } catch (error) {
    throw new ResetResultError("local reset did not reach a verified healthy target", {
      cause: error,
    });
  }

  try {
    verifyState(readyTarget, expectedState);
  } catch (error) {
    throw new ResetResultError("local reset state did not match the expected baseline", {
      cause: error,
    });
  }

  return {
    kind: resetError ? "state_verified_after_local_service_timeout" : "clean_success",
    target: readyTarget,
  };
}
const resetStateSql = `SELECT json_build_object(
  'migrations',(SELECT count(DISTINCT version) FROM supabase_migrations.schema_migrations),
  'latest',(SELECT max(version) FROM supabase_migrations.schema_migrations),
  'm117',(SELECT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261013113744')),
  'users',(SELECT count(*) FROM auth.users),
  'profiles',(SELECT count(*) FROM public.profiles),
  'conversations',(SELECT count(*) FROM public.conversations),
  'messages',(SELECT count(*) FROM public.messages),
  'cycles',(SELECT count(*) FROM public.conversation_handling_cycles),
  'work_items',(SELECT count(*) FROM public.conversation_work_items),
  'ledger',(SELECT count(*) FROM public.credit_transactions),
  'notifications',(SELECT count(*) FROM public.notifications),
  'analytics',(SELECT count(*) FROM public.analytics_events)
);`;

function verifyResetState(_target, expected) {
  assert.deepEqual(json(resetStateSql), expected);
}

function resetLocal(target, version, expectedState) {
  const result = runResetWithVerifiedState({
    target,
    reset: () => {
      const args = ["db", "reset", "--local", "--no-seed"];
      if (version) args.push("--version", version);
      supabase(args);
    },
    waitForReady: () => rebindLocalTargetAfterDatabaseReset(target),
    expectedState,
    verifyState: verifyResetState,
  });
  return result.target;
}
function readMigrationVersions() {
  return json(
    "SELECT coalesce(json_agg(version ORDER BY version), '[]'::json) FROM supabase_migrations.schema_migrations;",
  );
}
const preUpgradeStateSql = `SELECT json_build_object(
  'migrations',(SELECT count(DISTINCT version) FROM supabase_migrations.schema_migrations),
  'latest',(SELECT max(version) FROM supabase_migrations.schema_migrations),
  'users',(SELECT count(*) FROM auth.users),
  'conversations',(SELECT count(*) FROM public.conversations),
  'messages',(SELECT count(*) FROM public.messages),
  'cycles',(SELECT count(*) FROM public.conversation_handling_cycles),
  'work_items',(SELECT count(*) FROM public.conversation_work_items)
);`;

const postUpgradeStateSql = `SELECT json_build_object(
  'migrations',(SELECT count(DISTINCT version) FROM supabase_migrations.schema_migrations),
  'latest',(SELECT max(version) FROM supabase_migrations.schema_migrations),
  'mode',(SELECT mode FROM private.handling_contract_runtime WHERE singleton),
  'initialized',(SELECT count(*) FROM public.conversations WHERE handling_state_initialized),
  'classified',(SELECT count(*) FROM public.messages WHERE handling_sequence IS NOT NULL AND handling_effect IS NOT NULL),
  'client_only_needs',(SELECT needs_handling FROM public.conversations WHERE id='00000000-0000-4000-8000-0000000b0101'),
  'qualifying_response_needs',(SELECT needs_handling FROM public.conversations WHERE id='00000000-0000-4000-8000-0000000b0102'),
  'historical_no_cycle_effect',(SELECT handling_effect FROM public.messages WHERE id='00000000-0000-4000-8000-0000000b0304'),
  'closed_needs',(SELECT needs_handling FROM public.conversations WHERE id='00000000-0000-4000-8000-0000000b0104'),
  'closed_new_items',(SELECT count(*) FROM public.conversation_work_items WHERE conversation_id='00000000-0000-4000-8000-0000000b0104' AND status='new'),
  'active_cycle_effect',(SELECT handling_effect FROM public.messages WHERE id='00000000-0000-4000-8000-0000000b0306'),
  'active_cycle_projection_consistent',(SELECT active_cycle_projection_consistent FROM private.get_handling_shadow_reconciliation() WHERE conversation_id='00000000-0000-4000-8000-0000000b0105'),
  'admin_ambiguity_effect',(SELECT handling_effect FROM public.messages WHERE id='00000000-0000-4000-8000-0000000b0307'),
  'unresolved_admin',(SELECT count(*) FROM private.handling_reconciliation_issues WHERE message_id='00000000-0000-4000-8000-0000000b0307' AND status='unresolved'),
  'unresolved_total',(SELECT count(*) FROM private.handling_reconciliation_issues WHERE status='unresolved' AND can_change_canonical_state),
  'reconciliation_rows',(SELECT count(*) FROM private.get_handling_shadow_reconciliation()),
  'consistent_reconciliation_rows',(SELECT count(*) FROM private.get_handling_shadow_reconciliation() WHERE shadow_consistent),
  'readiness',(SELECT row_to_json(readiness) FROM private.get_handling_cutover_readiness() readiness)
);`;

function main() {
  let completed = false;

  runValidatedUpgrade({
    validateTarget: () => {
      const localTarget = acquireStableLocalTarget({ discoverTarget: assertLocalTarget });
      console.log(
        `Verified isolated local stack: API ${localTarget.apiPort}, DB ${localTarget.dbPort}`,
      );
      return localTarget;
    },
    verifyTarget: assertLocalTargetIdentity,
    resetTo113: (target) => {
      console.log(`Resetting the isolated local stack through migration ${version113}`);
      assertLocalTargetIdentity(target);
      return resetLocal(target, version113, {
        migrations: 113,
        latest: version113,
        m117: false,
        users: 0,
        profiles: 0,
        conversations: 0,
        messages: 0,
        cycles: 0,
        work_items: 0,
        ledger: 0,
        notifications: 0,
        analytics: 0,
      });
    },
    upgrade: (target) => {
      assertLocalTargetIdentity(target);

      const beforeVersions = readMigrationVersions();
      assert.equal(beforeVersions.length, 113);
      assert.equal(beforeVersions.at(-1), version113);
      const isolated = createIsolatedUpgradeWorkdir();
      try {
        assertBeforeVersionsInManifest(beforeVersions, isolated.manifest);
        sql(readFileSync(fixturePath, "utf8"));
        const before = json(preUpgradeStateSql);
        assert.deepEqual(before, {
          migrations: 113,
          latest: version113,
          users: 8,
          conversations: 6,
          messages: 7,
          cycles: 2,
          work_items: 4,
        });

        console.log(
          "Applying exactly M114-M116 through a full-through-M116 isolated local migration workdir",
        );
        supabase(["--workdir", isolated.workdir, "migration", "up", "--local"]);
        const afterVersions = readMigrationVersions();
        assertExactUpgradeDifference(beforeVersions, afterVersions);
        assert.equal(afterVersions.length, 116);
        assert.equal(afterVersions.at(-1), version116);
        assert.equal(afterVersions.includes("20261013113744"), false);
      } finally {
        isolated.destroy();
      }
      const backfill = json("SELECT private.backfill_handling_shadow_batch(1000);");
      assert.equal(backfill.initialized_count, 6);
      assert.equal(backfill.remaining_count, 0);

      const after = json(postUpgradeStateSql);
      assert.equal(after.migrations, 116);
      assert.equal(after.latest, version116);
      assertMigrationAbsenceResult(
        json(`SELECT json_build_object(
        'm117_present',
        EXISTS (
          SELECT 1
          FROM supabase_migrations.schema_migrations
          WHERE version = '20261013113744'
        )
      );`),
      );
      assert.equal(after.mode, "legacy_shadow");
      assert.equal(after.initialized, 6);
      assert.equal(after.classified, 7);
      assert.equal(after.client_only_needs, true);
      assert.equal(after.qualifying_response_needs, false);
      assert.equal(after.historical_no_cycle_effect, "none");
      assert.equal(after.closed_needs, true);
      assert.equal(after.closed_new_items, 0);
      assert.equal(after.active_cycle_effect, "client_request");
      assert.equal(after.active_cycle_projection_consistent, true);
      assert.equal(after.admin_ambiguity_effect, "unclassified");
      assert.equal(after.unresolved_admin, 1);
      assert.equal(after.unresolved_total, 1);
      assert.equal(after.reconciliation_rows, 6);
      assert.equal(after.consistent_reconciliation_rows, 6);
      assert.equal(after.readiness.mode, "legacy_shadow");
      assert.equal(after.readiness.unresolved_fallback_no_cycle_writes, 1);
      assert.equal(after.readiness.unresolved_state_changing_effects, 1);
      assert.equal(after.readiness.post_deploy_business_writes_missing_metadata, 0);
      assert.equal(after.readiness.uninitialized_conversations, 0);
      assert.equal(after.readiness.inconsistent_conversations, 0);
      assert.equal(after.readiness.shadow_consistent, false);
      assert.equal(after.readiness.cutover_authorized, false);

      completed = true;
      console.log(
        `WP01 upgrade rehearsal passed: 113 -> 116; initialized=${after.initialized}; classified=${after.classified}; unresolved_admin=${after.unresolved_admin}`,
      );
    },
    cleanup: (target) => {
      console.log("Restoring a clean local 117-migration baseline");
      assertLocalTargetIdentity(target);
      resetLocal(target, undefined, {
        migrations: 117,
        latest: "20261013113744",
        m117: true,
        users: 0,
        profiles: 0,
        conversations: 0,
        messages: 0,
        cycles: 0,
        work_items: 0,
        ledger: 0,
        notifications: 0,
        analytics: 0,
      });
      if (!completed) console.error("WP01 upgrade rehearsal failed before clean-baseline restore");
    },
    reportCleanupFailure: (error) => {
      console.error(`WP01 clean-baseline restore also failed: ${error.message}`);
    },
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
