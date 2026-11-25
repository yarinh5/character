import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const allowedHostIps = new Set(["127.0.0.1", "::1", "0.0.0.0", "::"]);
const evidenceInvocationId = randomUUID();
let evidenceSequence = 0;

export class PortBindingContractError extends Error {}
export class DockerInspectQueryError extends Error {}
export class PortBindingEvidenceError extends Error {
  constructor(message, { cause, primaryFailure = null } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.primaryFailure = primaryFailure;
  }
}

function contractFailure(message) {
  throw new PortBindingContractError(message);
}

export function validatePublishedPortBindings(bindings, expectedPort, label) {
  if (!Number.isInteger(expectedPort) || expectedPort < 1 || expectedPort > 65535) {
    contractFailure(`${label} expected host port is invalid`);
  }
  if (!Array.isArray(bindings) || bindings.length === 0) {
    contractFailure(`${label} has no published port bindings`);
  }
  const expectedHostPort = String(expectedPort);
  const seen = new Set();
  for (const binding of bindings) {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      contractFailure(`${label} has a malformed published port binding`);
    }
    if (typeof binding.HostIp !== "string" || !allowedHostIps.has(binding.HostIp)) {
      contractFailure(`${label} has an unauthorized published host address`);
    }
    if (typeof binding.HostPort !== "string" || binding.HostPort !== expectedHostPort) {
      contractFailure(`${label} has an unauthorized published host port`);
    }
    const identity = `${binding.HostIp}\u0000${binding.HostPort}`;
    if (seen.has(identity)) {
      contractFailure(`${label} has a duplicate published port binding`);
    }
    seen.add(identity);
  }
  return bindings.map(({ HostIp, HostPort }) => ({ HostIp, HostPort }));
}

function sanitizeStderr(value) {
  return String(value ?? "")
    .replace(/:\/\/[^@\s]+@/g, "://<redacted>@")
    .replace(/\b(password|secret|token)=\S+/gi, "$1=<redacted>")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, 4096);
}

function filteredBindings(container, internalPort) {
  const value = container?.NetworkSettings?.Ports?.[internalPort];
  if (!Array.isArray(value)) return value === null ? null : { malformed: typeof value };
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { malformed: entry === null ? "null" : typeof entry };
    }
    return {
      HostIp: typeof entry.HostIp === "string" ? entry.HostIp : null,
      HostPort: typeof entry.HostPort === "string" ? entry.HostPort : null,
    };
  });
}

function prepareEvidencePath(evidenceRoot, evidencePrefix, targetKind) {
  if (typeof evidenceRoot !== "string" || evidenceRoot.length === 0) {
    throw new PortBindingEvidenceError("RUN_EVIDENCE is required for Docker port evidence");
  }
  const root = lstatSync(evidenceRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new PortBindingEvidenceError("RUN_EVIDENCE is not a private directory");
  }
  const directory = join(evidenceRoot, "port-bindings");
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  const directoryState = lstatSync(directory);
  if (!directoryState.isDirectory() || directoryState.isSymbolicLink()) {
    throw new PortBindingEvidenceError("port binding evidence path is not a directory");
  }
  evidenceSequence += 1;
  const sequence = String(evidenceSequence).padStart(4, "0");
  return join(
    directory,
    `${evidencePrefix}-${evidenceInvocationId}-${sequence}-${targetKind}.json`,
  );
}

export function captureDockerInspectForPortValidation({
  configPath,
  cwd,
  evidencePrefix,
  evidenceRoot,
  expectedHostPort,
  internalPort,
  name,
  runner = spawnSync,
  targetKind,
  timeout,
  writeEvidence = writeFileSync,
}) {
  let evidencePath;
  try {
    evidencePath = prepareEvidencePath(evidenceRoot, evidencePrefix, targetKind);
  } catch (error) {
    if (error instanceof PortBindingEvidenceError) throw error;
    throw new PortBindingEvidenceError("failed to prepare Docker port evidence", { cause: error });
  }
  const options = {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...(timeout === undefined ? {} : { timeout }),
  };
  let result;
  try {
    result = runner("docker", ["inspect", name], options);
  } catch (error) {
    result = { status: null, signal: null, stdout: "", stderr: "", error };
  }
  let container;
  let parseFailure;
  if (result?.status === 0 && !result.error) {
    try {
      const parsed = JSON.parse(result.stdout);
      if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0]) {
        throw new Error("inspect result must contain exactly one container");
      }
      [container] = parsed;
    } catch {
      parseFailure = "invalid_docker_inspect_json";
    }
  }
  const evidence = {
    schemaVersion: 1,
    runner: evidencePrefix,
    invocationId: evidenceInvocationId,
    targetKind,
    containerName: name,
    containerId: typeof container?.Id === "string" ? container.Id : null,
    configPath,
    internalPort,
    expectedHostPort,
    bindings: filteredBindings(container, internalPort),
    query: {
      exitCode: Number.isInteger(result?.status) ? result.status : null,
      signal: typeof result?.signal === "string" ? result.signal : null,
      timedOut: result?.error?.code === "ETIMEDOUT",
      errorCode: typeof result?.error?.code === "string" ? result.error.code : null,
      stderr: sanitizeStderr(result?.stderr),
      parseFailure: parseFailure ?? null,
    },
  };
  const primaryFailure =
    result?.status !== 0 || result.error
      ? new DockerInspectQueryError(`${name} Docker inspect query failed`)
      : parseFailure
        ? new DockerInspectQueryError(`${name} Docker inspect output is invalid`)
        : null;
  try {
    writeEvidence(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    throw new PortBindingEvidenceError("failed to preserve Docker port evidence", {
      cause: error,
      primaryFailure,
    });
  }
  if (primaryFailure) throw primaryFailure;
  return container;
}
