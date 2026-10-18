import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runResetWithVerifiedState } from "./wp01-shadow-113-to-116.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const projectId = "qmgkmsarzfjnqltljkjl";
const dbContainerName = `supabase_db_${projectId}`;
const apiContainerName = `supabase_kong_${projectId}`;
const supabaseCli = "C:\\Users\\Yarin\\scoop\\shims\\supabase.exe";
const version116 = "20261006211102";
const version117 = "20261013113744";
const failureMetadata = new WeakMap();
const approvedErrorCodes = new Set(["EACCES", "ENOENT", "EPERM", "ETIMEDOUT", "ERR_ASSERTION"]);
const approvedResourceLabels = new Set([
  "late-writer",
  "migration",
  "orchestration",
  "table-blocker",
  "writer",
]);
const approvedCleanupStages = new Set(["cancel", "cleanup", "drain", "end", "kill", "verify"]);

function reportableFailure(error, metadata) {
  if (error instanceof Error) failureMetadata.set(error, Object.freeze({ ...metadata }));
  return error;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 180_000,
    input: options.input,
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function startProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: options.env,
    windowsHide: true,
    stdio: [options.input === false ? "ignore" : "pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const completion = new Promise((resolveCompletion, rejectCompletion) => {
    child.once("error", rejectCompletion);
    child.once("close", (code) => {
      if (code === 0) {
        resolveCompletion({ stdout, stderr });
        return;
      }
      rejectCompletion(
        reportableFailure(
          new Error(`${command} exited with ${code}: ${stderr.trim() || stdout.trim()}`, {
            cause: { code, stderr, stdout },
          }),
          { category: "subprocess_failure", exitCode: code },
        ),
      );
    });
  });
  completion.catch(() => {});
  return {
    child,
    completion,
    getOutput: () => ({ stderr, stdout }),
    write: (statement) => child.stdin.write(statement),
  };
}

async function waitForOutput(process, marker, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!process.getOutput().stdout.includes(marker)) {
    if (process.child.exitCode !== null) await process.completion;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${marker}`);
    await delay(25);
  }
  return process.getOutput().stdout;
}

function startPsqlSession() {
  return startProcess("docker", [
    "exec",
    "-i",
    dbContainerName,
    "psql",
    "-X",
    "-qAt",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
  ]);
}

export async function waitForStrictBarrierState({
  readState,
  accept,
  timeoutMs = 15_000,
  intervalMs = 50,
  now = Date.now,
  sleep = delay,
}) {
  const deadline = now() + timeoutMs;
  let lastState;
  while (true) {
    const remainingBeforeRead = deadline - now();
    if (remainingBeforeRead <= 0) {
      throw new Error(`strict upgrade barrier observation timed out: ${JSON.stringify(lastState)}`);
    }
    lastState = await readState({ timeoutMs: remainingBeforeRead });
    if (now() > deadline) {
      throw new Error(`strict upgrade barrier observation timed out: ${JSON.stringify(lastState)}`);
    }
    if (accept(lastState)) return lastState;
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(`strict upgrade barrier observation timed out: ${JSON.stringify(lastState)}`);
    }
    await sleep(Math.min(intervalMs, remaining));
  }
}

export async function withDeadline(
  work,
  { label, timeoutMs = 15_000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout },
) {
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimer(
      () =>
        reject(
          reportableFailure(new Error(`${label} timed out after ${timeoutMs}ms`), {
            category: "timeout_failure",
            timeoutMs,
          }),
        ),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => work({ timeoutMs: Math.max(1, Math.floor(deadline - now())) }))
        .then((value) => {
          if (now() > deadline) {
            throw reportableFailure(
              new Error(`${label} completed after its ${timeoutMs}ms deadline`),
              { category: "timeout_failure", timeoutMs },
            );
          }
          return value;
        }),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimer(timer);
  }
}

function stagedCleanupError(resource, stage, cause) {
  return reportableFailure(
    new Error(`strict barrier cleanup failed at ${resource}:${stage}`, { cause }),
    { category: "cleanup_failure", resource, stage },
  );
}

export async function withStrictBarrierCleanup(work, cleanup) {
  let result;
  let primaryFailure;
  try {
    result = await work();
  } catch (error) {
    primaryFailure = error;
  }

  let cleanupResult;
  try {
    cleanupResult = await cleanup();
  } catch (error) {
    cleanupResult = {
      errors: [stagedCleanupError("orchestration", "cleanup", error)],
      quiescent: false,
    };
  }

  const cleanupErrors = [...(cleanupResult?.errors ?? [])];
  if (cleanupResult?.quiescent === false && cleanupErrors.length === 0) {
    cleanupErrors.push(
      reportableFailure(
        new Error(
          "strict barrier resources are not quiescent; inspect the owned sessions before manual cleanup",
        ),
        { category: "cleanup_not_quiescent" },
      ),
    );
  }
  if (primaryFailure && cleanupErrors.length === 0) throw primaryFailure;
  if (primaryFailure || cleanupErrors.length > 0) {
    const failures = primaryFailure ? [primaryFailure, ...cleanupErrors] : cleanupErrors;
    throw reportableFailure(
      new AggregateError(failures, "strict barrier work and cleanup did not complete safely", {
        cause: primaryFailure ?? cleanupErrors[0],
      }),
      { category: "aggregate_failure", hasPrimary: Boolean(primaryFailure) },
    );
  }
  return result;
}

export async function cleanupStrictBarrierResources({ resources, adapters, timeoutMs = 15_000 }) {
  const errors = [];
  let quiescent = true;

  for (const resource of resources) {
    const stages =
      resource.kind === "session" ? ["cancel", "end", "kill", "drain"] : ["kill", "drain"];
    for (const stage of stages) {
      try {
        await withDeadline(
          ({ timeoutMs: remainingTimeoutMs }) =>
            adapters[stage](resource, { timeoutMs: remainingTimeoutMs }),
          {
            label: `${resource.label}:${stage}`,
            timeoutMs,
          },
        );
      } catch (error) {
        errors.push(stagedCleanupError(resource.label, stage, error));
      }
    }

    try {
      const closed = await withDeadline(
        ({ timeoutMs: remainingTimeoutMs }) =>
          adapters.verify(resource, { timeoutMs: remainingTimeoutMs }),
        {
          label: `${resource.label}:verify`,
          timeoutMs,
        },
      );
      if (!closed) {
        quiescent = false;
        errors.push(
          stagedCleanupError(
            resource.label,
            "verify",
            new Error("owned process or PostgreSQL session is still active"),
          ),
        );
      }
    } catch (error) {
      quiescent = false;
      errors.push(stagedCleanupError(resource.label, "verify", error));
    }
  }

  return { errors, quiescent };
}

export async function runStrictCleanupReset({
  resetStarted,
  quiescent,
  resources = [],
  resetAction,
}) {
  if (!resetStarted) return { performed: false };
  if (!quiescent) {
    const ownedResources = resources
      .map(
        ({ applicationName, label, pid }) =>
          `${label}(pid=${pid ?? "unknown"},application=${applicationName ?? "unknown"})`,
      )
      .join(", ");
    throw reportableFailure(
      new Error(
        `strict barrier cleanup was not proven quiescent; do not reset. On the validated target, inspect and terminate only these owned resources: ${ownedResources || "no resource identity was captured"}. Then confirm their PostgreSQL sessions and child processes are absent before requesting a fresh Task Packet.`,
      ),
      { category: "manual_cleanup_required", resources },
    );
  }
  return { performed: true, value: await resetAction() };
}

function supabase(args) {
  return run(supabaseCli, args, { timeout: 300_000 });
}

function sql(statement, { timeoutMs = 60_000 } = {}) {
  return run(
    "docker",
    [
      "exec",
      "-i",
      dbContainerName,
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
    { input: statement, timeout: timeoutMs },
  ).trim();
}

function json(statement, options) {
  return JSON.parse(sql(statement, options));
}

const preM117AbsentObjectKeys = [
  "authority_evidence_relation",
  "authority_evidence_index",
  "acquire_authority_signature",
  "record_authority_signature",
  "private_message_signature",
  "public_message_token_signature",
  "public_sticker_token_signature",
  "public_media_token_signature",
  "public_locked_media_token_signature",
];

function assertCatalogObject(result) {
  assert.equal(typeof result, "object", "M117 catalog result must be an object");
  assert.notEqual(result, null, "M117 catalog result must not be null");
  assert.equal(Array.isArray(result), false, "M117 catalog result must not be an array");
}

export function assertPreM117ObjectCatalog(result) {
  assertCatalogObject(result);
  for (const key of preM117AbsentObjectKeys) {
    assert.ok(Object.hasOwn(result, key), `M116 catalog result must include ${key}`);
    assert.equal(result[key], null, `${key} must be absent before M117`);
  }
  assert.equal(
    result.strict_send_deployed_column,
    false,
    "strict-send runtime column must be absent before M117",
  );
  assert.equal(result.legacy_close_trigger, true, "legacy close trigger must exist before M117");
  assert.equal(
    result.public_message_token_anon_execute,
    null,
    "M117 overload ACL must be absent before M117",
  );
  assert.equal(
    result.public_message_token_authenticated_execute,
    null,
    "M117 overload ACL must be absent before M117",
  );
}

export function assertPostM117ObjectCatalog(result) {
  assertCatalogObject(result);
  for (const key of preM117AbsentObjectKeys) {
    assert.ok(Object.hasOwn(result, key), `M117 catalog result must include ${key}`);
    assert.equal(typeof result[key], "string", `${key} must exist after M117`);
    assert.ok(result[key].length > 0, `${key} must identify the M117 object`);
  }
  assert.equal(
    result.strict_send_deployed_column,
    true,
    "strict-send runtime column must exist after M117",
  );
  assert.equal(
    result.legacy_close_trigger,
    false,
    "legacy close trigger must be absent after M117",
  );
  assert.equal(
    result.public_message_token_anon_execute,
    false,
    "anon must not execute the strict send overload",
  );
  assert.equal(
    result.public_message_token_authenticated_execute,
    true,
    "authenticated must execute the strict send overload",
  );
}

export function readAuthorityEvidenceAfterM117(catalog, readCount) {
  assertPostM117ObjectCatalog(catalog);
  const count = readCount();
  assert.equal(typeof count, "number", "authority-evidence count must be numeric");
  assert.ok(
    Number.isInteger(count) && count >= 0,
    "authority-evidence count must be a non-negative integer",
  );
  return count;
}

export function assertCleanM117Evidence(catalog, count) {
  assert.equal(
    readAuthorityEvidenceAfterM117(catalog, () => count),
    0,
    "M117 cleanup must leave no authority evidence rows",
  );
}

function configPort(config, section, key = "port") {
  const sectionPattern = section.replaceAll(".", "\\.");
  const match = config.match(new RegExp(`\\[${sectionPattern}\\]([\\s\\S]*?)(?=\\n\\[|$)`));
  assert.ok(match, `missing [${section}] local configuration`);
  const port = match[1].match(new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)\\s*$`, "m"));
  assert.ok(port, `missing [${section}].${key} local configuration`);
  return Number(port[1]);
}

function assertLoopbackUrl(value, expectedPort, label) {
  const url = new URL(String(value));
  assert.ok(["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname));
  assert.equal(Number(url.port), expectedPort, `${label} must match local config`);
}

function inspectContainer(name, internalPort, expectedPort, requireHealthy = false) {
  const [info] = JSON.parse(run("docker", ["inspect", name]));
  assert.equal(info.Name, `/${name}`);
  assert.match(info.Id, /^[a-f0-9]{12,}$/i);
  assert.equal(info.State?.Running, true, `${name} must be running`);
  if (requireHealthy)
    assert.equal(info.State?.Health?.Status, "healthy", `${name} must be healthy`);
  const mappings = info.NetworkSettings?.Ports?.[internalPort] ?? [];
  assert.ok(
    mappings.some((entry) => Number(entry.HostPort) === expectedPort),
    `${name} port mapping drift`,
  );
  return { id: info.Id, name };
}

export class StrictTargetReadinessError extends Error {
  constructor(kind, message, options = {}) {
    super(message, options);
    this.name = "StrictTargetReadinessError";
    this.kind = kind;
  }
}

function inspectExpectedDatabaseContainer(dbPort) {
  let info;
  try {
    [info] = JSON.parse(run("docker", ["inspect", dbContainerName]));
  } catch (error) {
    throw new StrictTargetReadinessError(
      "db_unavailable",
      `${dbContainerName} is temporarily unavailable`,
      { cause: error },
    );
  }
  assert.equal(info.Name, `/${dbContainerName}`, "DB container name drift");
  assert.match(info.Id, /^[a-f0-9]{12,}$/i, "DB container ID is malformed");
  const mappings = info.NetworkSettings?.Ports?.["5432/tcp"] ?? [];
  assert.ok(
    mappings.some((entry) => Number(entry.HostPort) === dbPort),
    "DB port mapping drift",
  );
  if (info.State?.Running !== true) {
    throw new StrictTargetReadinessError("db_not_ready", `${dbContainerName} is not running`);
  }
  if (info.State?.Health?.Status !== "healthy") {
    throw new StrictTargetReadinessError(
      "db_not_ready",
      `${dbContainerName} is ${info.State?.Health?.Status ?? "unhealthy"}`,
    );
  }
  return { id: info.Id, name: dbContainerName };
}

function validateLocalTarget(expected) {
  const config = readFileSync(join(repoRoot, "supabase", "config.toml"));
  const text = config.toString("utf8");
  assert.match(text, new RegExp(`project_id\\s*=\\s*"${projectId}"`));
  const apiPort = configPort(text, "api");
  const dbPort = configPort(text, "db");
  const api = inspectContainer(apiContainerName, "8000/tcp", apiPort);
  const db = inspectExpectedDatabaseContainer(dbPort);
  let status;
  try {
    status = JSON.parse(supabase(["status", "--output", "json"]));
  } catch (error) {
    throw new StrictTargetReadinessError(
      "status_unavailable",
      "local Supabase status is temporarily unavailable",
      { cause: error },
    );
  }
  assertLoopbackUrl(status.API_URL, apiPort, "API URL");
  assertLoopbackUrl(status.DB_URL, dbPort, "DB URL");
  const target = {
    api,
    apiPort,
    configHash: createHash("sha256").update(config).digest("hex"),
    db,
    dbPort,
    projectId,
  };
  if (expected) {
    assert.equal(target.projectId, expected.projectId, "project identity drift");
    assert.equal(target.configHash, expected.configHash, "config identity drift");
    assert.equal(target.apiPort, expected.apiPort, "API port drift");
    assert.equal(target.dbPort, expected.dbPort, "DB port drift");
    assert.deepEqual(target.api, expected.api, "API container identity drift");
  }
  return target;
}

function isTransientTargetReadinessError(error) {
  return (
    error instanceof StrictTargetReadinessError &&
    ["db_unavailable", "db_not_ready", "status_unavailable"].includes(error.kind)
  );
}

function assertStableAcquisitionIdentity(reference, candidate) {
  assert.equal(
    candidate.projectId,
    reference.projectId,
    "project identity drift during target acquisition",
  );
  assert.equal(
    candidate.configHash,
    reference.configHash,
    "config identity drift during target acquisition",
  );
  assert.equal(candidate.apiPort, reference.apiPort, "API port drift during target acquisition");
  assert.equal(candidate.dbPort, reference.dbPort, "DB port drift during target acquisition");
  assert.deepEqual(
    candidate.api,
    reference.api,
    "API container identity drift during target acquisition",
  );
  assert.equal(
    candidate.db.name,
    reference.db.name,
    "DB container name drift during target acquisition",
  );
}

function defaultSleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
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
        if (current.db.id !== candidate.db.id) {
          candidate = current;
          stableSamples = 1;
        } else {
          stableSamples += 1;
        }
      }
      if (stableSamples === requiredSamples) return candidate;
    } catch (error) {
      if (!isTransientTargetReadinessError(error)) throw error;
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

function waitForHealthyTarget(expected, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (true) {
    try {
      return validateLocalTarget(expected);
    } catch (error) {
      lastError = error;
      if (!isTransientTargetReadinessError(error)) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `local target did not become healthy after reset: ${lastError?.message ?? "unknown"}`,
          { cause: lastError },
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(1_000, remaining));
    }
  }
}
export function runStrictReset(options) {
  return runResetWithVerifiedState(options);
}

export function validateStrictUpgradeTransition(before, after) {
  assert.equal(before.migrations, 116, "strict rehearsal must begin at migration 116");
  assert.equal(before.latest, version116, "strict rehearsal must begin at M116");
  assert.equal(after.migrations, 117, "strict rehearsal must finish at migration 117");
  assert.equal(after.latest, version117, "strict rehearsal must finish at M117");
  const added = after.versions.filter((version) => !before.versions.includes(version));
  assert.deepEqual(added, [version117], "strict migration up must add exactly M117");
}

const migrationDirectory = join(repoRoot, "supabase", "migrations");
const cleanResidueKeys = [
  "users",
  "profiles",
  "conversations",
  "messages",
  "work_items",
  "cycles",
  "authority_evidence",
  "credit_transactions",
  "sticker_attempts",
  "notifications",
  "analytics",
  "attachments",
  "reservations",
  "storage_objects",
  "waiting_locks",
];

export function expectedMigrationVersionsFromSource() {
  const entries = readdirSync(migrationDirectory, { withFileTypes: true });
  assert.ok(
    entries.every((entry) => entry.isFile()),
    "migration directory must contain files only",
  );

  const versions = [];
  const seen = new Set();
  for (const entry of entries) {
    const match = entry.name.match(/^(\d{14})_.+\.sql$/);
    assert.ok(match, `malformed migration filename: ${entry.name}`);
    const version = match[1];
    assert.ok(version <= version117, `unexpected migration after M117: ${entry.name}`);
    assert.equal(seen.has(version), false, `duplicate migration version: ${version}`);
    seen.add(version);
    versions.push(version);
  }

  versions.sort();
  assert.equal(versions.length, 117, "expected exactly 117 migrations through M117");
  assert.equal(versions.at(-1), version117, "M117 must be the final source migration");
  assert.equal(
    versions.filter((version) => version === version117).length,
    1,
    "M117 must appear exactly once in the source manifest",
  );
  return versions;
}

export function assertCurrentMigrationBaseline(migration, expectedVersions) {
  assert.equal(typeof migration, "object", "migration state must be an object");
  assert.notEqual(migration, null, "migration state must not be null");
  assert.equal(Array.isArray(migration), false, "migration state must not be an array");
  assert.ok(Array.isArray(expectedVersions), "expected migration versions must be an array");
  assert.ok(Array.isArray(migration.versions), "migration state must include a versions array");
  assert.equal(
    migration.migrations,
    expectedVersions.length,
    "cleanup migration count must match the source manifest",
  );
  assert.equal(migration.latest, version117, "cleanup latest migration must be M117");
  assert.equal(migration.includes117, true, "cleanup history must include M117");
  assert.deepEqual(
    migration.versions,
    expectedVersions,
    "cleanup migration versions must exactly match the source manifest",
  );
  assert.deepEqual(
    migration,
    {
      migrations: expectedVersions.length,
      latest: version117,
      versions: expectedVersions,
      includes117: true,
    },
    "cleanup migration state must not omit or add fields",
  );
}

export function assertCleanResidue(residue) {
  assert.equal(typeof residue, "object", "cleanup residue must be an object");
  assert.notEqual(residue, null, "cleanup residue must not be null");
  assert.equal(Array.isArray(residue), false, "cleanup residue must not be an array");
  assert.deepEqual(
    Object.keys(residue).sort(),
    [...cleanResidueKeys].sort(),
    "cleanup residue must include exactly the required counters",
  );
  for (const key of cleanResidueKeys) {
    assert.equal(typeof residue[key], "number", `cleanup residue ${key} must be numeric`);
    assert.equal(residue[key], 0, `cleanup residue ${key} must be zero`);
  }
}

function migrationState() {
  return json(`SELECT json_build_object(
    'migrations',(SELECT count(DISTINCT version) FROM supabase_migrations.schema_migrations),
    'latest',(SELECT max(version) FROM supabase_migrations.schema_migrations),
    'versions',(SELECT coalesce(json_agg(version ORDER BY version), '[]'::json) FROM supabase_migrations.schema_migrations),
    'includes117',(SELECT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='${version117}'))
  );`);
}

function basicResidueState() {
  return json(`SELECT json_build_object(
    'users',(SELECT count(*) FROM auth.users),
    'conversations',(SELECT count(*) FROM public.conversations),
    'messages',(SELECT count(*) FROM public.messages),
    'cycles',(SELECT count(*) FROM public.conversation_handling_cycles)
  );`);
}

function m117ObjectCatalog() {
  return json(`SELECT json_build_object(
    'authority_evidence_relation',to_regclass('private.handling_send_authority_evidence'),
    'authority_evidence_index',to_regclass('private.handling_send_authority_evidence_conversation_idx'),
    'strict_send_deployed_column',(SELECT EXISTS(
      SELECT 1 FROM pg_attribute attribute
      WHERE attribute.attrelid='private.handling_contract_runtime'::regclass
        AND attribute.attname='strict_send_deployed_at' AND NOT attribute.attisdropped
    )),
    'acquire_authority_signature',to_regprocedure('private.acquire_operator_send_authority(uuid,uuid)'),
    'record_authority_signature',to_regprocedure('private.record_operator_send_authority_evidence(uuid,uuid,uuid,uuid,uuid,text)'),
    'private_message_signature',to_regprocedure('private.send_operator_message(uuid,text)'),
    'public_message_token_signature',to_regprocedure('public.send_operator_message(uuid,text,uuid)'),
    'public_sticker_token_signature',to_regprocedure('public.send_operator_sticker_message(uuid,uuid,uuid,uuid)'),
    'public_media_token_signature',to_regprocedure('public.send_operator_media_message(uuid,text,text,uuid)'),
    'public_locked_media_token_signature',to_regprocedure('public.send_operator_locked_media_message(uuid,text,uuid)'),
    'legacy_close_trigger',(SELECT EXISTS(
      SELECT 1 FROM pg_trigger WHERE tgrelid='public.messages'::regclass AND tgname='close_handling_cycle_on_staff_message'
    )),
    'public_message_token_anon_execute',CASE
      WHEN to_regprocedure('public.send_operator_message(uuid,text,uuid)') IS NULL THEN NULL
      ELSE has_function_privilege('anon',to_regprocedure('public.send_operator_message(uuid,text,uuid)'),'EXECUTE')
    END,
    'public_message_token_authenticated_execute',CASE
      WHEN to_regprocedure('public.send_operator_message(uuid,text,uuid)') IS NULL THEN NULL
      ELSE has_function_privilege('authenticated',to_regprocedure('public.send_operator_message(uuid,text,uuid)'),'EXECUTE')
    END
  );`);
}

function authorityEvidenceCount(catalog) {
  return readAuthorityEvidenceAfterM117(
    catalog,
    () =>
      json(`SELECT json_build_object(
    'authority_evidence',(SELECT count(*) FROM private.handling_send_authority_evidence)
  );`).authority_evidence,
  );
}

function cleanResidueState() {
  const catalog = m117ObjectCatalog();
  const authorityEvidence = authorityEvidenceCount(catalog);
  const counters = json(`SELECT json_build_object(
    'users',(SELECT count(*) FROM auth.users),
    'profiles',(SELECT count(*) FROM public.profiles),
    'conversations',(SELECT count(*) FROM public.conversations),
    'messages',(SELECT count(*) FROM public.messages),
    'work_items',(SELECT count(*) FROM public.conversation_work_items),
    'cycles',(SELECT count(*) FROM public.conversation_handling_cycles),
    'credit_transactions',(SELECT count(*) FROM public.credit_transactions),
    'sticker_attempts',(SELECT count(*) FROM private.sticker_send_attempts),
    'notifications',(SELECT count(*) FROM public.notifications),
    'analytics',(SELECT count(*) FROM public.analytics_events),
    'attachments',(SELECT count(*) FROM public.message_attachments),
    'reservations',(SELECT count(*) FROM public.character_media_reservations),
    'storage_objects',(SELECT count(*) FROM storage.objects),
    'waiting_locks',(SELECT count(*) FROM pg_locks lock WHERE NOT lock.granted)
  );`);
  return {
    users: counters.users,
    profiles: counters.profiles,
    conversations: counters.conversations,
    messages: counters.messages,
    work_items: counters.work_items,
    cycles: counters.cycles,
    authority_evidence: authorityEvidence,
    credit_transactions: counters.credit_transactions,
    sticker_attempts: counters.sticker_attempts,
    notifications: counters.notifications,
    analytics: counters.analytics,
    attachments: counters.attachments,
    reservations: counters.reservations,
    storage_objects: counters.storage_objects,
    waiting_locks: counters.waiting_locks,
  };
}

function assertResetState(expectedState) {
  const migration = migrationState();
  const residue = basicResidueState();
  for (const [key, value] of Object.entries(expectedState)) {
    if (key === "evidence") continue;
    if (Object.hasOwn(migration, key)) {
      assert.deepEqual(migration[key], value, `reset migration state mismatch: ${key}`);
      continue;
    }
    assert.ok(Object.hasOwn(residue, key), `unsupported reset-state key: ${key}`);
    assert.deepEqual(residue[key], value, `reset residue state mismatch: ${key}`);
  }
  if (Object.hasOwn(expectedState, "evidence")) {
    assert.deepEqual(
      authorityEvidenceCount(m117ObjectCatalog()),
      expectedState.evidence,
      "reset state mismatch: evidence",
    );
  }
}

function reset(target, version, expectedState) {
  const result = runStrictReset({
    target,
    reset: () => supabase(["db", "reset", "--local", "--no-seed", "--version", version]),
    waitForReady: () => waitForHealthyTarget(target),
    expectedState,
    verifyState: (_readyTarget, expected) => assertResetState(expected),
  });
  return result.target;
}

const fixtureSql = `
BEGIN;
INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES
  ('00000000-0000-4000-8000-0000000c0001','authenticated','authenticated','wp01-strict-upgrade-client@example.invalid',clock_timestamp(),'{}','{}',clock_timestamp(),clock_timestamp()),
  ('00000000-0000-4000-8000-0000000c0002','authenticated','authenticated','wp01-strict-upgrade-atomic-client@example.invalid',clock_timestamp(),'{}','{}',clock_timestamp(),clock_timestamp()),
  ('00000000-0000-4000-8000-0000000c0003','authenticated','authenticated','wp01-strict-upgrade-barrier-client@example.invalid',clock_timestamp(),'{}','{}',clock_timestamp(),clock_timestamp()),
  ('00000000-0000-4000-8000-0000000c0011','authenticated','authenticated','wp01-strict-upgrade-operator@example.invalid',clock_timestamp(),'{}','{}',clock_timestamp(),clock_timestamp());
INSERT INTO public.user_roles(user_id,role) VALUES ('00000000-0000-4000-8000-0000000c0011','operator');
INSERT INTO public.operators(id,user_id,full_name,is_active,availability_status,presence_status,last_seen_at)
VALUES ('00000000-0000-4000-8000-0000000c0021','00000000-0000-4000-8000-0000000c0011','wp01 strict upgrade operator',true,'available','online',clock_timestamp());
INSERT INTO public.characters(id,name,is_active,is_visible,availability_status)
VALUES ('00000000-0000-4000-8000-0000000c0031','wp01 strict upgrade character',true,true,'available');
INSERT INTO public.character_operator_assignments(character_id,operator_id)
VALUES ('00000000-0000-4000-8000-0000000c0031','00000000-0000-4000-8000-0000000c0021');
INSERT INTO public.credit_wallets(user_id,balance,lifetime_earned,lifetime_spent)
VALUES ('00000000-0000-4000-8000-0000000c0001',20,20,0),('00000000-0000-4000-8000-0000000c0002',20,20,0),('00000000-0000-4000-8000-0000000c0011',20,20,0) ON CONFLICT (user_id) DO NOTHING;
INSERT INTO public.conversations(id,client_id,character_id,assigned_operator_id,status)
VALUES
  ('00000000-0000-4000-8000-0000000c0101','00000000-0000-4000-8000-0000000c0001','00000000-0000-4000-8000-0000000c0031','00000000-0000-4000-8000-0000000c0021','open'),
  ('00000000-0000-4000-8000-0000000c0102','00000000-0000-4000-8000-0000000c0002','00000000-0000-4000-8000-0000000c0031',NULL,'open'),
  ('00000000-0000-4000-8000-0000000c0103','00000000-0000-4000-8000-0000000c0003','00000000-0000-4000-8000-0000000c0031','00000000-0000-4000-8000-0000000c0021','open');
INSERT INTO public.conversation_work_items(id,conversation_id,client_id,character_id,status,responsible_operator_id,assigned_at,last_activity_at)
VALUES
  ('00000000-0000-4000-8000-0000000c0401','00000000-0000-4000-8000-0000000c0101','00000000-0000-4000-8000-0000000c0001','00000000-0000-4000-8000-0000000c0031','assigned','00000000-0000-4000-8000-0000000c0021',clock_timestamp(),clock_timestamp()),
  ('00000000-0000-4000-8000-0000000c0403','00000000-0000-4000-8000-0000000c0103','00000000-0000-4000-8000-0000000c0003','00000000-0000-4000-8000-0000000c0031','assigned','00000000-0000-4000-8000-0000000c0021',clock_timestamp(),clock_timestamp());
INSERT INTO public.conversation_handling_cycles(id,conversation_id,work_item_id,operator_id)
VALUES
  ('00000000-0000-4000-8000-0000000c0201','00000000-0000-4000-8000-0000000c0101','00000000-0000-4000-8000-0000000c0401','00000000-0000-4000-8000-0000000c0021'),
  ('00000000-0000-4000-8000-0000000c0203','00000000-0000-4000-8000-0000000c0103','00000000-0000-4000-8000-0000000c0403','00000000-0000-4000-8000-0000000c0021');
COMMIT;
`;

function asOperator(statement) {
  return json(`BEGIN;
    SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000c0011","role":"authenticated"}';
    ${statement}
    COMMIT;`);
}

function expectBusinessError(statement, expected) {
  assert.throws(() => asOperator(statement), new RegExp(expected));
}

function parsePid(output, label) {
  const match = output.match(new RegExp(`${label}:(\\d+)`));
  assert.ok(match, `missing ${label} backend pid`);
  return Number(match[1]);
}

function cutoverBarrierState(options) {
  return json(
    `SELECT coalesce((
    SELECT json_build_object(
      'pid',lock.pid,
      'granted',lock.granted,
      'mode',lock.mode,
      'blockers',pg_blocking_pids(lock.pid),
      'strict_column',(SELECT EXISTS(
        SELECT 1 FROM pg_attribute attribute
        WHERE attribute.attrelid='private.handling_contract_runtime'::regclass
          AND attribute.attname='strict_send_deployed_at' AND NOT attribute.attisdropped
      ))
    )
    FROM pg_locks lock
    WHERE lock.locktype='advisory' AND lock.classid=20261006 AND lock.objid=101
      AND lock.mode='ExclusiveLock'
    ORDER BY lock.granted
    LIMIT 1
  ), 'null'::json);`,
    options,
  );
}

function migrationHoldState(migrationPid, options) {
  return json(
    `SELECT json_build_object(
    'pid',${migrationPid},
    'barrier_granted',EXISTS(
      SELECT 1 FROM pg_locks lock
      WHERE lock.pid=${migrationPid} AND lock.locktype='advisory'
        AND lock.classid=20261006 AND lock.objid=101
        AND lock.mode='ExclusiveLock' AND lock.granted
    ),
    'waiting_lock',EXISTS(
      SELECT 1 FROM pg_locks lock WHERE lock.pid=${migrationPid} AND NOT lock.granted
    ),
    'blockers',pg_blocking_pids(${migrationPid}),
    'strict_column',(SELECT EXISTS(
      SELECT 1 FROM pg_attribute attribute
      WHERE attribute.attrelid='private.handling_contract_runtime'::regclass
        AND attribute.attname='strict_send_deployed_at' AND NOT attribute.attisdropped
    ))
  );`,
    options,
  );
}

function lateWriterState(lateWriterPid, options) {
  return json(
    `SELECT json_build_object(
    'pid',${lateWriterPid},
    'waiting_shared_barrier',EXISTS(
      SELECT 1 FROM pg_locks lock
      WHERE lock.pid=${lateWriterPid} AND lock.locktype='advisory'
        AND lock.classid=20261006 AND lock.objid=101
        AND lock.mode='ShareLock' AND NOT lock.granted
    ),
    'blockers',pg_blocking_pids(${lateWriterPid})
  );`,
    options,
  );
}

function quotedSqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function childIsClosed(resource) {
  return resource.process.child.exitCode !== null || resource.process.child.signalCode !== null;
}

function captureBackendIdentity(resource, requireApplicationName) {
  const identity = json(`SELECT json_build_object(
    'pid',pid,
    'backend_start',backend_start::text,
    'application_name',application_name
  ) FROM pg_stat_activity WHERE pid=${Number(resource.pid)};`);
  if (!identity || identity.pid !== resource.pid) {
    throw new Error(`${resource.label} backend identity was not found`);
  }
  if (requireApplicationName && identity.application_name !== resource.applicationName) {
    throw new Error(`${resource.label} backend application identity mismatch`);
  }
  resource.backendStart = identity.backend_start;
}

function remainingTimeout(deadline, now, label) {
  const remaining = Math.floor(deadline - now());
  if (remaining <= 0) throw new Error(`${label} timed out`);
  return remaining;
}

function ownedBackendPids(resource, executeJson, timeoutMs) {
  const pidPredicate =
    resource.pid && resource.backendStart
      ? ` OR (pid=${Number(resource.pid)} AND backend_start=${quotedSqlString(resource.backendStart)}::timestamptz)`
      : "";
  return executeJson(
    `SELECT coalesce(json_agg(pid ORDER BY pid), '[]'::json)
      FROM pg_stat_activity
      WHERE datname=current_database()
        AND (application_name=${quotedSqlString(resource.applicationName)}${pidPredicate});`,
    { timeoutMs },
  );
}

async function drainClosedProcess(resource) {
  try {
    await resource.process.completion;
  } catch (error) {
    if (!childIsClosed(resource)) throw error;
  }
  if (!childIsClosed(resource)) throw new Error(`${resource.label} child did not close`);
}

export function createStrictBarrierCleanupAdapters({
  executeJson = (statement, options) => json(statement, options),
  now = Date.now,
} = {}) {
  return {
    cancel: async (resource, { timeoutMs = 15_000 } = {}) => {
      const deadline = now() + timeoutMs;
      const ownedPids = ownedBackendPids(
        resource,
        executeJson,
        remainingTimeout(deadline, now, `${resource.label}:cancel`),
      );
      if (resource.pid && ownedPids.some((pid) => pid !== resource.pid)) {
        throw new Error(`${resource.label} backend ownership mismatch`);
      }
      for (const pid of ownedPids) {
        const cancellation = executeJson(
          `SELECT json_build_object('cancelled', pg_cancel_backend(${Number(pid)}));`,
          { timeoutMs: remainingTimeout(deadline, now, `${resource.label}:cancel`) },
        );
        const validCancellation =
          cancellation !== null &&
          typeof cancellation === "object" &&
          !Array.isArray(cancellation) &&
          Object.hasOwn(cancellation, "cancelled") &&
          cancellation.cancelled === true;
        if (!validCancellation) {
          throw new Error(`${resource.label} backend cancellation failed`);
        }
      }
    },
    end: async (resource) => {
      if (!childIsClosed(resource) && !resource.process.child.stdin.destroyed) {
        resource.process.child.stdin.end();
      }
    },
    kill: async (resource) => {
      if (!childIsClosed(resource) && !resource.process.child.kill()) {
        throw new Error(`${resource.label} child kill was not accepted`);
      }
    },
    drain: drainClosedProcess,
    verify: async (resource, { timeoutMs = 15_000 } = {}) =>
      childIsClosed(resource) && ownedBackendPids(resource, executeJson, timeoutMs).length === 0,
  };
}

async function finishSession(resource, statement) {
  resource.process.write(`${statement}\n\\q\n`);
  await withDeadline(() => resource.process.completion, {
    label: `${resource.label}:finish`,
  });
}

async function cancelSession(resource, adapters) {
  await withDeadline(({ timeoutMs }) => adapters.cancel(resource, { timeoutMs }), {
    label: `${resource.label}:cancel`,
  });
  await withDeadline(() => drainClosedProcess(resource), {
    label: `${resource.label}:drain`,
  });
}

async function proveUpgradeBarrier(cleanupState) {
  const resources = [];
  const runToken = `wp01_strict_${process.pid}_${Date.now()}`;
  const adapters = createStrictBarrierCleanupAdapters();
  const addSession = (label) => {
    const resource = {
      kind: "session",
      label,
      applicationName: `${runToken}_${label}`,
      process: startPsqlSession(),
    };
    resources.push(resource);
    cleanupState.quiescent = false;
    return resource;
  };
  let migrationResource;
  return withStrictBarrierCleanup(
    async () => {
      const writer = addSession("writer");
      writer.process.write(`SET application_name = ${quotedSqlString(writer.applicationName)};
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000c0011","role":"authenticated"}';
SELECT 'WRITER_PID:' || pg_backend_pid();
SELECT public.send_operator_message('00000000-0000-4000-8000-0000000c0103','pre-strict barrier writer');
\\echo WRITER_READY
`);
      writer.pid = parsePid(await waitForOutput(writer.process, "WRITER_READY"), "WRITER_PID");
      captureBackendIdentity(writer, true);

      const tableBlocker = addSession("table-blocker");
      tableBlocker.process
        .write(`SET application_name = ${quotedSqlString(tableBlocker.applicationName)};
BEGIN;
SELECT 1 FROM private.handling_contract_runtime WHERE singleton;
SELECT 'TABLE_BLOCKER_PID:' || pg_backend_pid();
\\echo TABLE_BLOCKER_READY
`);
      tableBlocker.pid = parsePid(
        await waitForOutput(tableBlocker.process, "TABLE_BLOCKER_READY"),
        "TABLE_BLOCKER_PID",
      );
      captureBackendIdentity(tableBlocker, true);

      migrationResource = {
        kind: "migration",
        label: "migration",
        applicationName: `${runToken}_migration`,
        process: startProcess(supabaseCli, ["migration", "up", "--local"], {
          input: false,
          env: { ...process.env, PGAPPNAME: `${runToken}_migration` },
        }),
      };
      resources.push(migrationResource);
      cleanupState.quiescent = false;
      const waitingForWriter = await waitForStrictBarrierState({
        readState: async ({ timeoutMs }) => cutoverBarrierState({ timeoutMs }),
        accept: (state) =>
          state?.granted === false &&
          state?.strict_column === false &&
          state?.blockers?.includes(writer.pid),
      });
      migrationResource.pid = waitingForWriter.pid;
      captureBackendIdentity(migrationResource, false);
      assert.equal(migrationState().latest, version116, "contract changed before writer drained");

      await finishSession(writer, "COMMIT;");
      const holdingExclusive = await waitForStrictBarrierState({
        readState: async ({ timeoutMs }) => migrationHoldState(waitingForWriter.pid, { timeoutMs }),
        accept: (state) =>
          state.barrier_granted === true &&
          state.waiting_lock === true &&
          state.blockers.includes(tableBlocker.pid) &&
          state.strict_column === false,
      });

      const lateWriter = addSession("late-writer");
      lateWriter.process
        .write(`SET application_name = ${quotedSqlString(lateWriter.applicationName)};
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000c0002","role":"authenticated"}';
SELECT 'LATE_WRITER_PID:' || pg_backend_pid();
SELECT public.send_client_message('00000000-0000-4000-8000-0000000c0102','blocked by strict barrier');
\\echo LATE_WRITER_DONE
`);
      lateWriter.pid = parsePid(
        await waitForOutput(lateWriter.process, "LATE_WRITER_PID"),
        "LATE_WRITER_PID",
      );
      captureBackendIdentity(lateWriter, true);
      const blockedLateWriter = await waitForStrictBarrierState({
        readState: async ({ timeoutMs }) => lateWriterState(lateWriter.pid, { timeoutMs }),
        accept: (state) =>
          state.waiting_shared_barrier === true && state.blockers.includes(waitingForWriter.pid),
      });
      await cancelSession(lateWriter, adapters);

      await finishSession(tableBlocker, "COMMIT;");
      await withDeadline(() => migrationResource.process.completion, {
        label: "migration:finish",
      });
      return { blockedLateWriter, holdingExclusive, waitingForWriter };
    },
    async () => {
      const cleanupResult = await cleanupStrictBarrierResources({ resources, adapters });
      cleanupState.quiescent = cleanupResult.quiescent;
      cleanupState.resources = resources.map(({ applicationName, label, pid }) => ({
        applicationName,
        label,
        pid,
      }));
      return cleanupResult;
    },
  );
}

function assertCleanBaseline() {
  const expectedVersions = expectedMigrationVersionsFromSource();
  assertCurrentMigrationBaseline(migrationState(), expectedVersions);
  assertCleanResidue(cleanResidueState());
}
async function main() {
  const originalTarget = acquireStableLocalTarget({ discoverTarget: () => validateLocalTarget() });
  let resetStarted = false;
  let primaryFailure;
  const barrierCleanupState = { quiescent: true, resources: [] };
  try {
    console.log(
      `Verified isolated local stack: API ${originalTarget.apiPort}, DB ${originalTarget.dbPort}`,
    );
    resetStarted = true;
    reset(originalTarget, version116, {
      migrations: 116,
      latest: version116,
      includes117: false,
      users: 0,
      conversations: 0,
      messages: 0,
      cycles: 0,
    });
    assertPreM117ObjectCatalog(m117ObjectCatalog());
    assert.deepEqual(
      json(`SELECT json_build_object(
      'migrations',(SELECT count(DISTINCT version) FROM supabase_migrations.schema_migrations),
      'latest',(SELECT max(version) FROM supabase_migrations.schema_migrations)
    );`),
      { migrations: 116, latest: version116 },
    );

    sql(fixtureSql);
    const beforeUpgrade = migrationState();
    const barrierTimeline = await proveUpgradeBarrier(barrierCleanupState);
    console.log(
      `Verified strict upgrade barrier: migration ${barrierTimeline.waitingForWriter.pid} waited for writer ${barrierTimeline.waitingForWriter.blockers[0]}; late writer waited for the exclusive barrier`,
    );
    const postCatalog = m117ObjectCatalog();
    assertPostM117ObjectCatalog(postCatalog);
    const upgraded = json(`SELECT json_build_object(
      'migrations',(SELECT count(DISTINCT version) FROM supabase_migrations.schema_migrations),
      'latest',(SELECT max(version) FROM supabase_migrations.schema_migrations),
      'mode',(SELECT mode FROM private.handling_contract_runtime WHERE singleton),
      'strict_deployed',(SELECT strict_send_deployed_at IS NOT NULL FROM private.handling_contract_runtime WHERE singleton),
      'legacy_trigger',(SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.messages'::regclass AND tgname='close_handling_cycle_on_staff_message')),
      'strict_overload',(SELECT to_regprocedure('public.send_operator_message(uuid,text,uuid)') IS NOT NULL)
    );`);
    assert.deepEqual(upgraded, {
      migrations: 117,
      latest: version117,
      mode: "legacy_shadow",
      strict_deployed: true,
      legacy_trigger: false,
      strict_overload: true,
    });
    validateStrictUpgradeTransition(beforeUpgrade, migrationState());
    assert.deepEqual(
      json(`SELECT json_build_object(
        'old_message_before_strict',(
          SELECT message.created_at < runtime.strict_send_deployed_at
          FROM public.messages message
          CROSS JOIN private.handling_contract_runtime runtime
          WHERE message.conversation_id='00000000-0000-4000-8000-0000000c0103'
            AND message.content='pre-strict barrier writer'
            AND runtime.singleton
        ),
        'old_message_evidence',(
          SELECT count(*) FROM private.handling_send_authority_evidence evidence
          WHERE evidence.conversation_id='00000000-0000-4000-8000-0000000c0103'
        ),
        'late_writer_messages',(
          SELECT count(*) FROM public.messages message
          WHERE message.conversation_id='00000000-0000-4000-8000-0000000c0102'
            AND message.content='blocked by strict barrier'
        )
      );`),
      { late_writer_messages: 0, old_message_before_strict: true, old_message_evidence: 0 },
    );

    const activeConversation = "00000000-0000-4000-8000-0000000c0101";
    const activeCycle = "00000000-0000-4000-8000-0000000c0201";
    const atomicConversation = "00000000-0000-4000-8000-0000000c0102";
    const before = json(
      `SELECT json_build_object('messages',(SELECT count(*) FROM public.messages),'evidence',(SELECT count(*) FROM private.handling_send_authority_evidence));`,
    );
    expectBusinessError(
      `SELECT public.send_operator_message('${activeConversation}','strict upgrade legacy');`,
      "handling_cycle_token_required",
    );
    expectBusinessError(
      `SELECT public.send_operator_message('${activeConversation}','strict upgrade missing token',NULL::uuid);`,
      "handling_cycle_token_invalid",
    );
    assert.deepEqual(
      json(
        `SELECT json_build_object('messages',(SELECT count(*) FROM public.messages),'evidence',(SELECT count(*) FROM private.handling_send_authority_evidence));`,
      ),
      before,
    );

    const cycleResult = asOperator(
      `SELECT public.send_operator_message('${activeConversation}','strict upgrade cycle token','${activeCycle}'::uuid);`,
    );
    assert.equal(cycleResult.cycle_id, activeCycle);
    assert.equal(cycleResult.authority_source, "cycle_token");
    assert.equal(cycleResult.claimed_now, false);
    const atomicResult = asOperator(
      `SELECT public.send_operator_message('${atomicConversation}','strict upgrade atomic claim',NULL::uuid);`,
    );
    assert.equal(atomicResult.authority_source, "atomic_claim_and_send");
    assert.equal(atomicResult.claimed_now, true);
    assert.match(atomicResult.cycle_id, /^[0-9a-f-]{36}$/i);

    assert.deepEqual(
      json(`SELECT json_build_object(
      'active_cycle_open',(SELECT ended_at IS NULL FROM public.conversation_handling_cycles WHERE id='${activeCycle}'),
      'active_evidence',(SELECT count(*) FROM private.handling_send_authority_evidence WHERE conversation_id='${activeConversation}'),
      'atomic_cycle_count',(SELECT count(*) FROM public.conversation_handling_cycles WHERE conversation_id='${atomicConversation}' AND ended_at IS NULL),
      'atomic_evidence',(SELECT count(*) FROM private.handling_send_authority_evidence WHERE conversation_id='${atomicConversation}'),
      'staff_messages',(SELECT count(*) FROM public.messages WHERE conversation_id IN ('${activeConversation}','${atomicConversation}') AND handling_effect='staff_response')
    );`),
      {
        active_cycle_open: true,
        active_evidence: 1,
        atomic_cycle_count: 1,
        atomic_evidence: 1,
        staff_messages: 2,
      },
    );

    console.log(
      "WP01.4 strict-send upgrade rehearsal passed: 116 -> 117; cycle token and atomic claim evidence verified",
    );
  } catch (error) {
    primaryFailure = error;
  }

  let finalCleanupFailure;
  try {
    await runStrictCleanupReset({
      resetStarted,
      quiescent: barrierCleanupState.quiescent,
      resources: barrierCleanupState.resources,
      resetAction: async () => {
        reset(originalTarget, version117, {
          migrations: 117,
          latest: version117,
          includes117: true,
          users: 0,
          conversations: 0,
          messages: 0,
          cycles: 0,
          evidence: 0,
        });
        assertCleanBaseline();
        console.log("Restored clean local 117-migration baseline");
      },
    });
  } catch (error) {
    finalCleanupFailure = reportableFailure(
      new Error("strict-send rehearsal final cleanup failed", {
        cause: error,
      }),
      { category: "final_cleanup_failure" },
    );
  }

  if (primaryFailure && finalCleanupFailure) {
    throw reportableFailure(
      new AggregateError(
        [primaryFailure, finalCleanupFailure],
        "strict-send rehearsal failed and final cleanup did not complete",
        { cause: primaryFailure },
      ),
      { category: "aggregate_failure", hasPrimary: true },
    );
  }
  if (primaryFailure) throw primaryFailure;
  if (finalCleanupFailure) throw finalCleanupFailure;
}

function validatedResourceIdentity(resource) {
  if (!resource || typeof resource !== "object") return null;
  const { applicationName, label, pid } = resource;
  if (!approvedResourceLabels.has(label) || label === "orchestration") return null;
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) return null;
  if (typeof applicationName !== "string" || applicationName.length > 128) return null;
  const match = /^wp01_strict_\d{1,20}_\d{1,20}_(late-writer|migration|table-blocker|writer)$/.exec(
    applicationName,
  );
  if (!match || match[1] !== label) return null;
  return `resource=${label} pid=${pid} application=${applicationName}`;
}

function validatedNumber(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}

function safeFailureDescriptor(error) {
  const metadata = failureMetadata.get(error);
  const parts = [];
  switch (metadata?.category) {
    case "aggregate_failure":
      parts.push("aggregate_failure");
      break;
    case "cleanup_failure":
      parts.push("cleanup_failure");
      if (approvedResourceLabels.has(metadata.resource))
        parts.push(`resource=${metadata.resource}`);
      if (approvedCleanupStages.has(metadata.stage)) parts.push(`stage=${metadata.stage}`);
      break;
    case "cleanup_not_quiescent":
      parts.push("cleanup_not_quiescent");
      break;
    case "final_cleanup_failure":
      parts.push("final_cleanup_failure");
      break;
    case "manual_cleanup_required": {
      parts.push("manual_cleanup_required", "action=do_not_reset");
      const resources = Array.isArray(metadata.resources)
        ? metadata.resources.map(validatedResourceIdentity).filter(Boolean)
        : [];
      parts.push(...resources);
      parts.push("verify_owned_sessions_and_processes_absent_before_fresh_task_packet");
      break;
    }
    case "subprocess_failure":
      parts.push("subprocess_failure");
      break;
    case "timeout_failure": {
      parts.push("timeout_failure");
      const timeoutMs = validatedNumber(metadata.timeoutMs, 3_600_000);
      if (timeoutMs !== null) parts.push(`timeout_ms=${timeoutMs}`);
      break;
    }
    default:
      parts.push(error instanceof AggregateError ? "aggregate_failure" : "unclassified_failure");
  }

  if (typeof error.code === "string" && approvedErrorCodes.has(error.code)) {
    parts.push(`code=${error.code}`);
  }
  const metadataExitCode = validatedNumber(metadata?.exitCode, 255);
  const errorExitCode = validatedNumber(error.exitCode, 255);
  const exitCode = metadataExitCode ?? errorExitCode;
  if (exitCode !== null) parts.push(`exit_code=${exitCode}`);
  return parts.join(" ");
}

function failureReportLines(error) {
  const queue = [{ error, label: error instanceof AggregateError ? "failure" : "primary" }];
  const seen = new Set();
  const lines = [];
  while (queue.length > 0 && lines.length < 32) {
    const current = queue.shift();
    if (!current?.error || seen.has(current.error)) continue;
    seen.add(current.error);
    lines.push(`${current.label}: ${safeFailureDescriptor(current.error)}`);

    if (current.error instanceof AggregateError) {
      const aggregateMetadata = failureMetadata.get(current.error);
      const hasPrimary = aggregateMetadata?.hasPrimary ?? true;
      current.error.errors.forEach((nested, index) => {
        queue.push({
          error: nested,
          label:
            hasPrimary && index === 0 ? "primary" : `cleanup[${hasPrimary ? index : index + 1}]`,
        });
      });
    }
    if (current.error.cause instanceof Error) {
      queue.push({ error: current.error.cause, label: `${current.label}.cause` });
    }
  }
  return lines;
}

export function reportStrictRehearsalFailure(error, write = console.error) {
  const prefix = "WP01.4 strict-send upgrade rehearsal failed";
  const output = [prefix, ...failureReportLines(error)].join("\n").slice(0, 4096);
  write(output);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    reportStrictRehearsalFailure(error);
    process.exitCode = 1;
  });
}
