import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectId = "qmgkmsarzfjnqltljkjl";
const dbContainerName = `supabase_db_${projectId}`;
const apiContainerName = `supabase_kong_${projectId}`;
const runnerDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(runnerDirectory, "..", "..");
const configPath = join(repositoryRoot, "supabase", "config.toml");
const databaseTestsDirectory = join(runnerDirectory, "database", "v4_3");

function fail(message) {
  throw new Error(`Refusing local database tests: ${message}`);
}

export class LocalDbTargetError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(`Refusing local database tests: ${message}`);
    this.code = code;
    this.retryable = retryable;
  }
}

function targetFailure(code, message, options) {
  throw new LocalDbTargetError(code, message, options);
}

function command(commandName, args, options = {}) {
  return execFileSync(commandName, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    ...options,
  });
}

function readConfiguredPort(configText, section) {
  let activeSection;
  for (const line of configText.split(/\r?\n/)) {
    const sectionMatch = line.match(/^\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      activeSection = sectionMatch[1];
      continue;
    }
    if (activeSection === section) {
      const portMatch = line.match(/^port\s*=\s*(\d+)\s*$/);
      if (portMatch) return Number(portMatch[1]);
    }
  }
  fail(`missing ${section}.port in supabase/config.toml`);
}

function readConfiguredProjectId(configText) {
  const projectMatch = configText.match(/^project_id\s*=\s*"([^"]+)"\s*$/m);
  if (!projectMatch || projectMatch[1] !== projectId) {
    fail("supabase/config.toml project identity does not match this repository");
  }
  return projectMatch[1];
}

function parseLoopbackUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} is not a valid URL`);
  }
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    fail(`${label} is not a loopback endpoint`);
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`${label} has no explicit valid port`);
  }
  return port;
}

function mappedHostPort(container, containerPort) {
  const bindings = container.NetworkSettings?.Ports?.[containerPort];
  if (!Array.isArray(bindings) || bindings.length !== 1) return null;
  const [binding] = bindings;
  if (
    !binding ||
    (binding.HostIp !== "127.0.0.1" &&
      binding.HostIp !== "::1" &&
      binding.HostIp !== "0.0.0.0" &&
      binding.HostIp !== "::") ||
    !/^\d+$/.test(binding.HostPort)
  )
    return null;
  return Number(binding.HostPort);
}

function validateContainer(
  container,
  expectedName,
  expectedPort,
  containerPort,
  healthRequired,
  targetKind,
) {
  const retryableDbState = targetKind === "db";
  if (!container || container.Name !== `/${expectedName}`) {
    targetFailure(`${targetKind}_identity`, `${expectedName} container identity does not match`, {
      retryable: retryableDbState,
    });
  }
  if (!/^[a-f0-9]{64}$/i.test(container.Id ?? "")) {
    targetFailure(`${targetKind}_id`, `${expectedName} container ID is invalid`);
  }
  if (container.State?.Running !== true) {
    targetFailure(`${targetKind}_running`, `${expectedName} is not running`, {
      retryable: retryableDbState,
    });
  }
  if (healthRequired && container.State?.Health?.Status !== "healthy") {
    targetFailure(`${targetKind}_health`, `${expectedName} is not healthy`, {
      retryable: retryableDbState,
    });
  }
  if (mappedHostPort(container, containerPort) !== expectedPort) {
    targetFailure(
      `${targetKind}_mapping`,
      `${expectedName} port mapping does not match supabase/config.toml`,
    );
  }
  return { id: container.Id, name: expectedName };
}

export function validateLocalDbTarget({ configBytes, status, dbContainer, apiContainer }) {
  const configText = Buffer.isBuffer(configBytes) ? configBytes.toString("utf8") : configBytes;
  const configuredProjectId = readConfiguredProjectId(configText);
  const apiPort = readConfiguredPort(configText, "api");
  const dbPort = readConfiguredPort(configText, "db");
  if (
    parseLoopbackUrl(status?.API_URL, "Supabase API URL") !== apiPort ||
    parseLoopbackUrl(status?.DB_URL, "Supabase database URL") !== dbPort
  )
    fail("Supabase status ports do not match supabase/config.toml");
  return {
    projectId: configuredProjectId,
    configHash: createHash("sha256").update(configBytes).digest("hex"),
    apiPort,
    dbPort,
    api: validateContainer(apiContainer, apiContainerName, apiPort, "8000/tcp", false, "api"),
    db: validateContainer(dbContainer, dbContainerName, dbPort, "5432/tcp", true, "db"),
  };
}

export function assertValidatedTargetIdentity(target, currentTarget) {
  try {
    assert.deepEqual(currentTarget, target);
  } catch {
    fail("validated local stack identity changed before database test execution");
  }
}

function inspectContainer(name, targetKind) {
  try {
    return JSON.parse(command("docker", ["inspect", name]))[0];
  } catch {
    targetFailure(`${targetKind}_unavailable`, `${name} is unavailable`, {
      retryable: targetKind === "db",
    });
  }
}

function readLocalStatus() {
  const result = spawnSync("supabase", ["status", "--output", "json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    targetFailure("status_unavailable", "local Supabase status is unavailable", {
      retryable: true,
    });
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    targetFailure("status_invalid", "local Supabase status is not valid JSON", { retryable: true });
  }
}

export function discoverLocalDbTarget() {
  const configBytes = readFileSync(configPath);
  return validateLocalDbTarget({
    configBytes,
    status: readLocalStatus(),
    dbContainer: inspectContainer(dbContainerName, "db"),
    apiContainer: inspectContainer(apiContainerName, "api"),
  });
}

function targetsMatch(left, right) {
  try {
    assert.deepEqual(left, right);
    return true;
  } catch {
    return false;
  }
}

function sanitizeTargetCause(error) {
  const message = error instanceof Error ? error.message : "local target discovery failed";
  return message
    .replace(/:\/\/[^\s]+/g, "<endpoint>")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function sleepSynchronously(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function waitForStableLocalDbTarget({
  discoverTarget,
  now = Date.now,
  sleep = sleepSynchronously,
  timeoutMs = 120_000,
  pollMs = 1_000,
  requiredStableSamples = 3,
}) {
  if (typeof discoverTarget !== "function") fail("local target discovery callback is required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) fail("target stability timeout is invalid");
  if (!Number.isInteger(pollMs) || pollMs < 1) fail("target stability polling interval is invalid");
  if (!Number.isInteger(requiredStableSamples) || requiredStableSamples < 3) {
    fail("target stability requires at least three samples");
  }

  const deadline = now() + timeoutMs;
  let stableTarget;
  let stableSamples = 0;
  let lastTransientCause;

  while (true) {
    try {
      const currentTarget = discoverTarget();
      stableSamples = targetsMatch(stableTarget, currentTarget) ? stableSamples + 1 : 1;
      stableTarget = currentTarget;
      if (stableSamples >= requiredStableSamples) return stableTarget;
    } catch (error) {
      if (!(error instanceof LocalDbTargetError) || !error.retryable) throw error;
      stableTarget = undefined;
      stableSamples = 0;
      lastTransientCause = error;
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      const cause = sanitizeTargetCause(lastTransientCause);
      fail(
        `local target did not stabilize before timeout; manual inspection is required (${cause})`,
      );
    }
    sleep(Math.min(pollMs, remaining));
  }
}

function listDatabaseTests() {
  const testFiles = readdirSync(databaseTestsDirectory)
    .filter((name) => name.endsWith(".test.sql"))
    .sort()
    .map((name) => join(databaseTestsDirectory, name));
  if (testFiles.length === 0) fail("no pgTAP test files were found");
  return testFiles;
}

function assertTemporaryDirectory(path) {
  if (!/^\/tmp\/wp01-pgtap-[0-9a-f-]+$/i.test(path)) {
    fail("temporary test directory is outside the approved container path");
  }
}

function dockerExec(target, args, options = {}) {
  return command("docker", ["exec", target.db.id, ...args], options);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

function createTemporaryDirectory(target) {
  const temporaryDirectory = `/tmp/wp01-pgtap-${randomUUID()}`;
  assertTemporaryDirectory(temporaryDirectory);
  dockerExec(target, ["mkdir", "-p", temporaryDirectory]);
  return temporaryDirectory;
}

function copyTestFiles(target, temporaryDirectory, testFiles) {
  for (const testFile of testFiles) {
    command("docker", [
      "cp",
      testFile,
      `${target.db.id}:${temporaryDirectory}/${basename(testFile)}`,
    ]);
  }
}

function sanitizeTapReason(error) {
  const reason = error instanceof Error ? error.message : "invalid pgTAP output";
  return reason
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7e]/g, "?")
    .trim()
    .slice(0, 240);
}

export function formatDbSuiteFailure(testFile, error) {
  return `pgTAP assertions failed in ${basename(testFile)}: ${sanitizeTapReason(error)}`;
}

export function validateTapOutput(output) {
  const lines = String(output)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  if (lines.length === 0) fail("pgTAP produced empty output");

  const plans = [];
  const ids = new Set();
  for (const line of lines) {
    if (/^Bail out!/i.test(line)) fail("pgTAP bailed out");

    if (/^1\.\./.test(line)) {
      const plan = line.match(/^1\.\.(\d+)(?:\s+#\s*.*)?$/);
      if (!plan) fail("pgTAP plan is malformed");
      plans.push(Number(plan[1]));
      continue;
    }

    if (/^not ok(?:\s|$)/.test(line)) {
      const assertion = line.match(/^not ok(?:\s+(\d+))?(?:\s+-\s+[^#]*)?(?:\s+#\s*.*)?$/);
      if (!assertion) fail("pgTAP failed assertion is malformed");
      const id = assertion[1] ? ` #${assertion[1]}` : "";
      fail(`pgTAP assertion failed${id}`);
    }

    if (/^ok(?:\s|$)/.test(line)) {
      const assertion = line.match(/^ok\s+(\d+)(?:(?:\s+-\s+|\s+#\s*).*)?$/);
      if (!assertion) fail("pgTAP assertion is malformed or missing an ID");
      const id = Number(assertion[1]);
      if (!Number.isInteger(id) || id < 1) fail("pgTAP assertion ID is invalid");
      if (ids.has(id)) fail("pgTAP contains a duplicate assertion ID");
      ids.add(id);
    }
  }

  if (plans.length !== 1) fail("pgTAP must contain exactly one plan");
  const expected = plans[0];
  if (!Number.isInteger(expected) || expected < 1) fail("pgTAP plan is invalid");
  for (const id of ids) {
    if (id > expected) fail("pgTAP assertion ID is outside its plan");
  }
  if (ids.size !== expected) fail("pgTAP assertion IDs do not match its plan");
  for (let id = 1; id <= expected; id += 1) {
    if (!ids.has(id)) fail("pgTAP is missing an assertion ID");
  }
  return expected;
}
function executePgTap(target, temporaryDirectory, testFiles) {
  let assertionCount = 0;
  for (const testFile of testFiles) {
    const path = `${temporaryDirectory}/${basename(testFile)}`;
    let output;
    try {
      output = dockerExec(target, [
        "psql",
        "-X",
        "-qAt",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        path,
      ]);
    } catch (error) {
      throw new Error(`pgTAP SQL execution failed in ${basename(testFile)}.`, { cause: error });
    }
    try {
      assertionCount += validateTapOutput(output);
    } catch (error) {
      throw new Error(formatDbSuiteFailure(testFile, error), { cause: error });
    }
  }
  return assertionCount;
}

function removeTemporaryDirectory(target, temporaryDirectory) {
  if (!temporaryDirectory) return;
  assertTemporaryDirectory(temporaryDirectory);
  dockerExec(target, ["rm", "-rf", "--", temporaryDirectory]);
}

export function runValidatedDbSuite(operations) {
  const target = operations.target;
  if (!target) fail("a stable validated local target is required before database test execution");
  let temporaryDirectory;
  let mutationStarted = false;
  let primaryError;
  try {
    operations.verifyTarget(target);
    temporaryDirectory = operations.createTemporaryDirectory(target);
    mutationStarted = true;
    operations.verifyTarget(target);
    operations.copyTestFiles(target, temporaryDirectory);
    operations.verifyTarget(target);
    return operations.executeSuite(target, temporaryDirectory);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (mutationStarted) {
      try {
        operations.cleanupTemporaryFiles(target, temporaryDirectory);
      } catch (cleanupError) {
        operations.reportCleanupError?.(cleanupError);
        if (!primaryError) throw cleanupError;
      }
    }
  }
}

function main() {
  const testFiles = listDatabaseTests();
  const target = waitForStableLocalDbTarget({ discoverTarget: discoverLocalDbTarget });
  const assertionCount = runValidatedDbSuite({
    target,
    verifyTarget: (expectedTarget) =>
      assertValidatedTargetIdentity(expectedTarget, discoverLocalDbTarget()),
    createTemporaryDirectory,
    copyTestFiles: (expectedTarget, temporaryDirectory) =>
      copyTestFiles(expectedTarget, temporaryDirectory, testFiles),
    executeSuite: (expectedTarget, temporaryDirectory) =>
      executePgTap(expectedTarget, temporaryDirectory, testFiles),
    cleanupTemporaryFiles: removeTemporaryDirectory,
    reportCleanupError: () => console.error("Local database test temporary-file cleanup failed."),
  });
  console.log(
    `pgTAP passed: ${assertionCount}/${assertionCount}; validated DB container ${target.db.id.slice(0, 12)}.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Local database tests failed.");
    process.exitCode = 1;
  }
}
