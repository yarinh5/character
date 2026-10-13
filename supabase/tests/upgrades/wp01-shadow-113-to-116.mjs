import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 180_000,
    input: options.input,
  });
}

function supabase(args) {
  return run("supabase", args, { timeout: 300_000 });
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
  const status = JSON.parse(supabase(["status", "--output", "json"]));
  const [db] = JSON.parse(run("docker", ["inspect", container]));
  const [api] = JSON.parse(run("docker", ["inspect", apiContainer]));
  return validateLocalTarget({ config, status, db, api });
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
      const localTarget = assertLocalTarget();
      console.log(
        `Verified isolated local stack: API ${localTarget.apiPort}, DB ${localTarget.dbPort}`,
      );
      return localTarget;
    },
    verifyTarget: assertLocalTargetIdentity,
    resetTo113: (target) => {
      console.log(`Resetting the isolated local stack through migration ${version113}`);
      assertLocalTargetIdentity(target);
      return resetAndWait({
        target,
        reset: () => supabase(["db", "reset", "--local", "--no-seed", "--version", version113]),
        waitForReady: rebindLocalTargetAfterDatabaseReset,
      });
    },
    upgrade: (target) => {
      assertLocalTargetIdentity(target);

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

      console.log("Applying migrations 114-116 through the local migration runner");
      supabase(["migration", "up", "--local"]);
      const backfill = json("SELECT private.backfill_handling_shadow_batch(1000);");
      assert.equal(backfill.initialized_count, 6);
      assert.equal(backfill.remaining_count, 0);

      const after = json(postUpgradeStateSql);
      assert.equal(after.migrations, 116);
      assert.equal(after.latest, version116);
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
      console.log("Restoring a clean local 116-migration baseline");
      assertLocalTargetIdentity(target);
      resetAndWait({
        target,
        reset: () => supabase(["db", "reset", "--local", "--no-seed"]),
        waitForReady: rebindLocalTargetAfterDatabaseReset,
      });
      const clean = json(`SELECT json_build_object(
    'migrations',(SELECT count(DISTINCT version) FROM supabase_migrations.schema_migrations),
    'latest',(SELECT max(version) FROM supabase_migrations.schema_migrations),
    'users',(SELECT count(*) FROM auth.users),
    'conversations',(SELECT count(*) FROM public.conversations),
    'messages',(SELECT count(*) FROM public.messages),
    'cycles',(SELECT count(*) FROM public.conversation_handling_cycles)
      );`);
      assert.deepEqual(clean, {
        migrations: 116,
        latest: version116,
        users: 0,
        conversations: 0,
        messages: 0,
        cycles: 0,
      });
      if (!completed) console.error("WP01 upgrade rehearsal failed before clean-baseline restore");
    },
    reportCleanupFailure: (error) => {
      console.error(`WP01 clean-baseline restore also failed: ${error.message}`);
    },
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
