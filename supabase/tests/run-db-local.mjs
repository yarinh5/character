import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DockerInspectQueryError,
  PortBindingContractError,
  PortBindingEvidenceError,
  captureDockerInspectForPortValidation,
  validatePublishedPortBindings,
} from "./local-docker-port-contract.mjs";

const projectId = "qmgkmsarzfjnqltljkjl";
const dbContainerName = `supabase_db_${projectId}`;
const apiContainerName = `supabase_kong_${projectId}`;
const runnerDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(runnerDirectory, "..", "..");
const configPath = join(repositoryRoot, "supabase", "config.toml");
const databaseTestsDirectory = join(runnerDirectory, "database", "v4_3");
const pgTapEvidenceInvocationId = randomUUID();
let pgTapEvidenceSequence = 0;

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

export class PgTapProcessError extends Error {}
export class PgTapEvidenceError extends Error {
  constructor(message, { cause, primaryFailure = null } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.primaryFailure = primaryFailure;
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
  try {
    validatePublishedPortBindings(
      container.NetworkSettings?.Ports?.[containerPort],
      expectedPort,
      `${expectedName} ${containerPort}`,
    );
  } catch (error) {
    if (!(error instanceof PortBindingContractError)) throw error;
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

function inspectContainer(name, targetKind, expectedHostPort, internalPort) {
  try {
    return captureDockerInspectForPortValidation({
      configPath,
      cwd: repositoryRoot,
      evidencePrefix: "db-local",
      evidenceRoot: process.env.RUN_EVIDENCE,
      expectedHostPort,
      internalPort,
      name,
      targetKind,
    });
  } catch (error) {
    if (error instanceof PortBindingEvidenceError) throw error;
    if (!(error instanceof DockerInspectQueryError)) throw error;
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
  const configText = configBytes.toString("utf8");
  const apiPort = readConfiguredPort(configText, "api");
  const dbPort = readConfiguredPort(configText, "db");
  return validateLocalDbTarget({
    configBytes,
    status: readLocalStatus(),
    dbContainer: inspectContainer(dbContainerName, "db", dbPort, "5432/tcp"),
    apiContainer: inspectContainer(apiContainerName, "api", apiPort, "8000/tcp"),
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

function preparePgTapEvidencePath(evidenceRoot, testFile) {
  if (typeof evidenceRoot !== "string" || evidenceRoot.length === 0) {
    throw new PgTapEvidenceError("RUN_EVIDENCE is required for pgTAP evidence");
  }
  const root = lstatSync(evidenceRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new PgTapEvidenceError("RUN_EVIDENCE is not a private directory");
  }
  const directory = join(evidenceRoot, "db-tap");
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  const directoryState = lstatSync(directory);
  if (!directoryState.isDirectory() || directoryState.isSymbolicLink()) {
    throw new PgTapEvidenceError("pgTAP evidence path is not a directory");
  }
  const fileName = basename(testFile);
  if (!/^[A-Za-z0-9._-]+\.test\.sql$/.test(fileName)) {
    throw new PgTapEvidenceError("pgTAP test filename is invalid for evidence");
  }
  pgTapEvidenceSequence += 1;
  const sequence = String(pgTapEvidenceSequence).padStart(4, "0");
  return join(
    directory,
    `db-tap-${pgTapEvidenceInvocationId}-${sequence}-${fileName}.json`,
  );
}

function normalizePgTapProcessResult(result) {
  const text = (value) => {
    if (typeof value === "string") return value;
    if (Buffer.isBuffer(value)) return value.toString("utf8");
    return "";
  };
  return {
    status: Number.isInteger(result?.status) ? result.status : null,
    signal: typeof result?.signal === "string" ? result.signal : null,
    stdout: text(result?.stdout),
    stderr: text(result?.stderr),
    error: result?.error,
  };
}

export function preservePgTapProcessEvidence({
  evidenceRoot,
  result,
  testFile,
  writeEvidence = writeFileSync,
}) {
  let evidencePath;
  try {
    evidencePath = preparePgTapEvidencePath(evidenceRoot, testFile);
  } catch (error) {
    if (error instanceof PgTapEvidenceError) throw error;
    throw new PgTapEvidenceError("failed to prepare pgTAP evidence", { cause: error });
  }
  const normalized = normalizePgTapProcessResult(result);
  const evidence = {
    schemaVersion: 1,
    invocationId: pgTapEvidenceInvocationId,
    sequence: pgTapEvidenceSequence,
    testFile: basename(testFile),
    process: {
      exitCode: normalized.status,
      signal: normalized.signal,
      timedOut: normalized.error?.code === "ETIMEDOUT",
      errorCode:
        typeof normalized.error?.code === "string" ? normalized.error.code : null,
      stdout: normalized.stdout,
      stderr: normalized.stderr,
    },
  };
  try {
    writeEvidence(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    throw new PgTapEvidenceError("failed to preserve pgTAP evidence", { cause: error });
  }
  return evidencePath;
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

export function executePgTapFile({
  evidenceRoot,
  path,
  runner = spawnSync,
  target,
  testFile,
  writeEvidence = writeFileSync,
}) {
  const args = [
    "exec",
    target.db.id,
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
  ];
  const options = {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  };
  let result;
  try {
    result = runner("docker", args, options);
  } catch (error) {
    result = { status: null, signal: null, stdout: "", stderr: "", error };
  }
  const normalized = normalizePgTapProcessResult(result);
  let primaryFailure =
    normalized.status !== 0 || normalized.signal !== null || normalized.error
      ? new PgTapProcessError(`pgTAP SQL execution failed in ${basename(testFile)}.`)
      : null;
  let evidenceFailure;
  try {
    preservePgTapProcessEvidence({ evidenceRoot, result: normalized, testFile, writeEvidence });
  } catch (error) {
    evidenceFailure = error;
  }
  if (evidenceFailure) {
    if (!primaryFailure) {
      try {
        validateTapOutput(normalized.stdout);
      } catch (error) {
        primaryFailure = new Error(formatDbSuiteFailure(testFile, error), { cause: error });
      }
    }
    throw new PgTapEvidenceError(
      primaryFailure
        ? `${primaryFailure.message} pgTAP evidence preservation also failed.`
        : `pgTAP evidence preservation failed in ${basename(testFile)}.`,
      { cause: evidenceFailure, primaryFailure },
    );
  }
  if (primaryFailure) throw primaryFailure;
  try {
    return validateTapOutput(normalized.stdout);
  } catch (error) {
    throw new Error(formatDbSuiteFailure(testFile, error), { cause: error });
  }
}

function executePgTap(target, temporaryDirectory, testFiles) {
  let assertionCount = 0;
  for (const testFile of testFiles) {
    const path = `${temporaryDirectory}/${basename(testFile)}`;
    assertionCount += executePgTapFile({
      evidenceRoot: process.env.RUN_EVIDENCE,
      path,
      target,
      testFile,
    });
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
