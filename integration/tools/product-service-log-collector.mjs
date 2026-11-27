#!/usr/bin/env node

import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const PROJECT_LABEL = "com.supabase.cli.project";
const SERVICE_NAMES = Object.freeze({
  storage: (projectId) => `supabase_storage_${projectId}`,
  kong: (projectId) => `supabase_kong_${projectId}`,
  db: (projectId) => `supabase_db_${projectId}`,
  auth: (projectId) => `supabase_auth_${projectId}`,
  edge_runtime: (projectId) => `supabase_edge_runtime_${projectId}`,
});
const REQUIRED_SERVICES = Object.freeze(Object.keys(SERVICE_NAMES));
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export class CollectorError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "CollectorError";
    this.code = code;
    this.details = details;
  }
}

function isoNow(now = () => new Date()) {
  return now().toISOString();
}

function sanitizeError(error) {
  return {
    code: error?.code ?? "collector_error",
    message: String(error?.message ?? error)
      .replace(/[\r\n]+/g, " ")
      .slice(0, 500),
  };
}

function assertSafeId(label, value) {
  if (!SAFE_ID.test(value ?? "")) {
    throw new CollectorError("invalid_argument", `${label} is not a safe explicit identifier`);
  }
  return value;
}

function parseNonNegativeInteger(label, value) {
  if (!/^(0|[1-9]\d*)$/.test(value ?? "")) {
    throw new CollectorError("invalid_argument", `${label} must be a non-negative integer`);
  }
  return Number(value);
}

function parsePositiveInteger(label, value) {
  const parsed = parseNonNegativeInteger(label, value);
  if (parsed === 0) {
    throw new CollectorError("invalid_argument", `${label} must be greater than zero`);
  }
  return parsed;
}

function defaultDeadlineFactory(timeoutMs) {
  let timer;
  return {
    promise: new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
    cancel() {
      clearTimeout(timer);
    },
  };
}

export function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new CollectorError("invalid_arguments", `invalid argument pair at ${key ?? "end"}`);
    }
    if (values.has(key)) {
      throw new CollectorError("invalid_arguments", `duplicate argument ${key}`);
    }
    values.set(key, value);
  }

  const required = [
    "--run-id",
    "--evidence-root",
    "--context",
    "--endpoint",
    "--engine-id",
    "--project-id",
    "--uid",
    "--gid",
    "--max-event-reconnects",
    "--max-log-reconnects",
    "--shutdown-timeout-ms",
  ];
  for (const key of required) {
    if (!values.has(key)) {
      throw new CollectorError("missing_argument", `${key} is required`);
    }
  }
  if (values.size !== required.length) {
    const unexpected = [...values.keys()].filter((key) => !required.includes(key));
    throw new CollectorError(
      "unexpected_argument",
      `unexpected arguments: ${unexpected.join(", ")}`,
    );
  }

  return {
    runId: assertSafeId("run ID", values.get("--run-id")),
    evidenceRoot: path.resolve(values.get("--evidence-root")),
    context: assertSafeId("Docker context", values.get("--context")),
    endpoint: values.get("--endpoint"),
    engineId: assertSafeId("Engine ID", values.get("--engine-id")),
    projectId: assertSafeId("project ID", values.get("--project-id")),
    uid: parseNonNegativeInteger("UID", values.get("--uid")),
    gid: parseNonNegativeInteger("GID", values.get("--gid")),
    maxEventReconnects: parseNonNegativeInteger(
      "max event reconnects",
      values.get("--max-event-reconnects"),
    ),
    maxLogReconnects: parseNonNegativeInteger(
      "max log reconnects",
      values.get("--max-log-reconnects"),
    ),
    shutdownTimeoutMs: parsePositiveInteger(
      "shutdown timeout",
      values.get("--shutdown-timeout-ms"),
    ),
  };
}

async function runCapture(executable, args, options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn;
  options.assertCanSpawn?.();
  const child = spawnImpl(executable, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  options.trackChild?.(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code, signal] = await once(child, "close");
  if (code !== 0) {
    throw new CollectorError("process_failed", `${executable} exited nonzero`, {
      executable,
      args,
      code,
      signal,
      stderr: stderr.slice(0, 500),
    });
  }
  return stdout;
}

function dockerEnvironment(source = process.env) {
  const environment = { ...source };
  for (const key of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "DOCKER_API_VERSION",
  ]) {
    delete environment[key];
  }
  return environment;
}

export function createDockerBoundary({ spawnImpl = spawn, env = process.env } = {}) {
  const childEnvironment = dockerEnvironment(env);
  const dockerArgs = (context, args) => ["--context", context, ...args];
  const capture = (context, args, processControl) =>
    runCapture("docker", dockerArgs(context, args), {
      spawnImpl,
      env: childEnvironment,
      ...processControl,
    });
  const open = (context, args) =>
    spawnImpl("docker", dockerArgs(context, args), {
      env: childEnvironment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

  return {
    async verifyTarget(config, processControl) {
      const contextJson = JSON.parse(
        await capture(
          config.context,
          ["context", "inspect", config.context, "--format", "{{json .}}"],
          processControl,
        ),
      );
      const actualEndpoint = contextJson?.Endpoints?.docker?.Host;
      if (actualEndpoint !== config.endpoint) {
        throw new CollectorError(
          "docker_endpoint_mismatch",
          "Docker endpoint does not match approval",
          {
            expected: config.endpoint,
            actual: actualEndpoint ?? null,
          },
        );
      }
      const actualEngineId = (
        await capture(config.context, ["info", "--format", "{{.ID}}"], processControl)
      ).trim();
      if (actualEngineId !== config.engineId) {
        throw new CollectorError(
          "docker_engine_mismatch",
          "Docker Engine ID does not match approval",
          {
            expected: config.engineId,
            actual: actualEngineId || null,
          },
        );
      }
    },
    async listContainerIds(config, processControl) {
      const output = await capture(
        config.context,
        [
          "ps",
          "-a",
          "--no-trunc",
          "--filter",
          `label=${PROJECT_LABEL}=${config.projectId}`,
          "--format",
          "{{.ID}}",
        ],
        processControl,
      );
      return output
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .filter(Boolean);
    },
    async inspectContainer(config, containerId, processControl) {
      const output = await capture(
        config.context,
        ["inspect", "--format", "{{json .}}", containerId],
        processControl,
      );
      return JSON.parse(output);
    },
    openEvents(config, since) {
      return open(config.context, [
        "events",
        "--since",
        since,
        "--format",
        "{{json .}}",
        "--filter",
        "type=container",
        "--filter",
        `label=${PROJECT_LABEL}=${config.projectId}`,
      ]);
    },
    openLogs(config, containerId) {
      return open(config.context, [
        "logs",
        "--follow",
        "--timestamps",
        "--tail",
        "all",
        containerId,
      ]);
    },
  };
}

async function assertNoSymlinks(absolutePath, fsApi = fs) {
  const parsed = path.parse(absolutePath);
  let current = parsed.root;
  for (const part of absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fsApi.lstat(current);
    if (stat.isSymbolicLink()) {
      throw new CollectorError(
        "unsafe_evidence_path",
        `evidence path contains a symbolic link: ${current}`,
      );
    }
  }
}

function parsePosixAcl(output, expectedUid, expectedGid) {
  const entries = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const allowed = new Set(["user::rwx", "group::---", "other::---"]);
  if (entries.some((entry) => entry.startsWith("default:") || !allowed.has(entry))) {
    throw new CollectorError(
      "unsafe_evidence_acl",
      "evidence root has an unexpected POSIX ACL entry",
    );
  }
  if (![...allowed].every((entry) => entries.includes(entry))) {
    throw new CollectorError("unsafe_evidence_acl", "evidence root ACL is incomplete");
  }
  return { uid: expectedUid, gid: expectedGid, entries };
}

export async function validateEvidenceRoot(
  config,
  { fsApi = fs, platform = process.platform, spawnImpl = spawn, trackChild, assertCanSpawn } = {},
) {
  if (platform !== "linux") {
    throw new CollectorError("unsupported_platform", "collector must run on Linux");
  }
  if (!path.isAbsolute(config.evidenceRoot)) {
    throw new CollectorError("unsafe_evidence_path", "evidence root must be absolute");
  }
  await assertNoSymlinks(config.evidenceRoot, fsApi);
  const real = await fsApi.realpath(config.evidenceRoot);
  if (path.resolve(real) !== path.resolve(config.evidenceRoot)) {
    throw new CollectorError("unsafe_evidence_path", "evidence root does not resolve to itself");
  }
  const stat = await fsApi.stat(config.evidenceRoot);
  if (!stat.isDirectory()) {
    throw new CollectorError("unsafe_evidence_path", "evidence root is not a directory");
  }
  if (stat.uid !== config.uid || stat.gid !== config.gid) {
    throw new CollectorError(
      "unsafe_evidence_owner",
      "evidence root owner does not match approval",
      {
        expectedUid: config.uid,
        expectedGid: config.gid,
        actualUid: stat.uid,
        actualGid: stat.gid,
      },
    );
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw new CollectorError("unsafe_evidence_mode", "evidence root must have mode 0700");
  }
  const acl = await runCapture("getfacl", ["-cp", "--absolute-names", config.evidenceRoot], {
    spawnImpl,
    env: process.env,
    trackChild,
    assertCanSpawn,
  });
  return parsePosixAcl(acl, config.uid, config.gid);
}

async function writeJsonExclusive(filePath, value, fsApi = fs) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await fsApi.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function serviceFromInspect(inspect, projectId) {
  const labels = inspect?.Config?.Labels ?? {};
  if (labels[PROJECT_LABEL] !== projectId) {
    return null;
  }
  const name = String(inspect?.Name ?? "").replace(/^\//u, "");
  for (const [service, makeName] of Object.entries(SERVICE_NAMES)) {
    if (name === makeName(projectId)) {
      return service;
    }
  }
  return null;
}

function classifyContainerEvent(event, projectId) {
  const actorId = typeof event?.Actor?.ID === "string" ? event.Actor.ID : null;
  const eventId = typeof event?.id === "string" ? event.id : null;
  const candidateId = actorId ?? eventId;
  if (actorId && eventId && actorId !== eventId) {
    return {
      kind: "ambiguous",
      containerId: SAFE_ID.test(actorId) ? actorId : null,
      reason: "container_id_conflict",
    };
  }
  if (!candidateId || !SAFE_ID.test(candidateId)) {
    return { kind: "ambiguous", containerId: null, reason: "container_id_missing_or_unsafe" };
  }
  const attributes = event?.Actor?.Attributes;
  const eventProject =
    typeof attributes?.[PROJECT_LABEL] === "string" ? attributes[PROJECT_LABEL] : null;
  const composeProject =
    typeof attributes?.["com.docker.compose.project"] === "string"
      ? attributes["com.docker.compose.project"]
      : null;
  const name = typeof attributes?.name === "string" ? attributes.name.replace(/^\//u, "") : null;
  let service = null;
  if (name) {
    for (const [candidate, makeName] of Object.entries(SERVICE_NAMES)) {
      if (name === makeName(projectId)) {
        service = candidate;
        break;
      }
    }
  }
  if (eventProject === projectId && composeProject && composeProject !== projectId) {
    return {
      kind: "ambiguous",
      containerId: candidateId,
      reason: "project_label_conflict",
    };
  }
  if (eventProject === projectId && service) {
    return { kind: "required", containerId: candidateId, name, service };
  }
  if (eventProject === projectId && name) {
    return { kind: "non_target", containerId: candidateId, name };
  }
  if (eventProject && eventProject !== projectId && name && !service) {
    return { kind: "foreign", containerId: candidateId };
  }
  return {
    kind: "ambiguous",
    containerId: candidateId,
    reason: !eventProject
      ? "project_label_missing"
      : !name
        ? "container_name_missing"
        : "identity_conflict",
  };
}

class StreamCapture {
  constructor({ filePath, stream, fsApi = fs, createOutputStream = createWriteStream }) {
    this.filePath = filePath;
    this.stream = stream;
    this.fsApi = fsApi;
    this.hash = createHash("sha256");
    this.bytes = 0;
    this.failure = null;
    this.writer = createOutputStream(filePath, { flags: "wx", mode: 0o600 });
    this.opened = once(this.writer, "open");
    this.done = this.#run();
    this.done.catch(() => {});
  }

  async #run() {
    await this.opened;
    try {
      const meter = new Transform({
        transform: (chunk, _encoding, callback) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          this.hash.update(buffer);
          this.bytes += buffer.length;
          callback(null, buffer);
        },
      });
      await pipeline(this.stream, meter, this.writer);
      return {
        path: this.filePath,
        bytes: this.bytes,
        sha256: this.hash.digest("hex"),
      };
    } catch (error) {
      this.failure = error;
      this.writer.destroy();
      throw error;
    }
  }
}

function lineReader(stream, onLine, onFailure) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      Promise.resolve(onLine(line)).catch(onFailure);
    }
  });
  stream.on("end", () => {
    if (buffer.trim()) Promise.resolve(onLine(buffer)).catch(onFailure);
  });
}

export class ProductServiceLogCollector {
  constructor({
    config,
    boundary = createDockerBoundary(),
    validateEvidence = validateEvidenceRoot,
    fsApi = fs,
    now = () => new Date(),
    logger = console,
    createOutputStream = createWriteStream,
    deadlineFactory = defaultDeadlineFactory,
  }) {
    this.config = config;
    this.boundary = boundary;
    this.validateEvidence = validateEvidence;
    this.fsApi = fsApi;
    this.now = now;
    this.logger = logger;
    this.createOutputStream = createOutputStream;
    this.deadlineFactory = deadlineFactory;
    this.startedAt = null;
    this.stoppedAt = null;
    this.evidenceValidated = false;
    this.stopping = false;
    this.ready = false;
    this.failures = [];
    this.gaps = [];
    this.segments = [];
    this.nonRequiredContainers = new Map();
    this.observedServices = new Set();
    this.pendingAttachments = new Map();
    this.attachedContainerIds = new Set();
    this.children = new Set();
    this.childClosePromises = new Map();
    this.eventReconnects = 0;
    this.logReconnects = new Map();
    this.eventChildren = [];
    this.eventProcesses = [];
    this.logChildren = new Map();
    this.segmentPromises = new Set();
    this.healthPublicationPromise = null;
    this.healthSignalWriteFailed = false;
    this.processControl = {
      assertCanSpawn: () => this.#ensureRunning(),
      trackChild: (child) => this.#trackChild(child),
    };
    this.firstUnhealthyPromise = new Promise((resolve) => {
      this.resolveFirstUnhealthy = resolve;
    });
    this.stopPromise = new Promise((resolve) => {
      this.resolveStopped = resolve;
    });
  }

  #publishUnhealthy() {
    if (!this.evidenceValidated) return Promise.resolve(false);
    if (this.healthPublicationPromise) return this.healthPublicationPromise;
    const failedPath = path.join(this.config.evidenceRoot, "collector-failed.json");
    this.healthPublicationPromise = (async () => {
      try {
        await writeJsonExclusive(
          failedPath,
          { runId: this.config.runId, complete: false, failures: this.failures, gaps: this.gaps },
          this.fsApi,
        );
        return true;
      } catch (writeError) {
        if (writeError?.code === "EEXIST") return true;
        this.healthSignalWriteFailed = true;
        this.failures.push({
          at: isoNow(this.now),
          code: "health_signal_persistence_failed",
          message: "collector health signal could not be persisted",
          cause: sanitizeError(writeError),
          persistence: true,
        });
        queueMicrotask(() => void this.stop("health_signal_persistence_failed"));
        return false;
      }
    })();
    this.resolveFirstUnhealthy(this.healthPublicationPromise);
    return this.healthPublicationPromise;
  }

  async #persistFailure(error) {
    const failure = { at: isoNow(this.now), ...sanitizeError(error) };
    this.failures.push(failure);
    await this.#publishUnhealthy();
    return failure;
  }

  #recordGap(code, details = {}) {
    this.gaps.push({ at: isoNow(this.now), code, ...details });
    return this.#publishUnhealthy();
  }

  #ensureRunning() {
    if (this.stopping) {
      throw new CollectorError("collector_stopping", "collector is stopping");
    }
  }

  #recordNonRequiredContainerEvent(event, classification) {
    const existing = this.nonRequiredContainers.get(classification.containerId);
    const record = existing ?? {
      containerId: classification.containerId,
      name: classification.name,
      projectId: this.config.projectId,
      requiredServiceCoverage: false,
      logCapture: {
        status: "not_collected",
        reason: "outside_required_service_coverage",
      },
      lifecycle: [],
    };
    const rawAction = event?.Action ?? event?.status;
    const action =
      typeof rawAction === "string" && /^[A-Za-z0-9_.:-]{1,64}$/u.test(rawAction)
        ? rawAction
        : "unknown";
    const eventTimeSeconds =
      Number.isSafeInteger(event?.time) && event.time >= 0 ? event.time : null;
    record.lifecycle.push({ action, eventTimeSeconds, observedAt: isoNow(this.now) });
    this.nonRequiredContainers.set(classification.containerId, record);
  }

  #trackChild(child) {
    if (this.childClosePromises.has(child)) return this.childClosePromises.get(child);
    this.children.add(child);
    const closed = new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    this.childClosePromises.set(child, closed);
    void closed.then(() => {
      this.children.delete(child);
      this.childClosePromises.delete(child);
    });
    return closed;
  }

  async #verifyTarget() {
    await this.boundary.verifyTarget(this.config, this.processControl);
  }

  async start() {
    try {
      this.#ensureRunning();
      await this.validateEvidence(this.config, this.processControl);
      this.evidenceValidated = true;
      this.startedAt = isoNow(this.now);
      await this.#verifyTarget();
      this.#ensureRunning();
      await this.#startEvents(0);
      const inventory = await this.boundary.listContainerIds(this.config, this.processControl);
      this.#ensureRunning();
      await Promise.all(
        inventory.map((containerId) => this.#attachContainer(containerId, "inventory")),
      );
      this.#ensureRunning();
      await writeJsonExclusive(
        path.join(this.config.evidenceRoot, "collector-ready.json"),
        {
          runId: this.config.runId,
          ready: true,
          readyAt: isoNow(this.now),
          context: this.config.context,
          endpoint: this.config.endpoint,
          engineId: this.config.engineId,
          projectId: this.config.projectId,
          requiredServices: REQUIRED_SERVICES,
        },
        this.fsApi,
      );
      this.#ensureRunning();
      this.ready = true;
      this.logger.log(JSON.stringify({ event: "collector_ready", runId: this.config.runId }));
      return this;
    } catch (error) {
      await this.#persistFailure(error);
      await this.stop("start_failure");
      throw error;
    }
  }

  async #startEvents(attempt) {
    this.#ensureRunning();
    if (attempt > 0) await this.#verifyTarget();
    this.#ensureRunning();
    const child = this.boundary.openEvents(this.config, this.startedAt);
    const childClosed = this.#trackChild(child);
    this.eventChildren.push(child);
    const eventProcess = {
      attempt,
      pid: child.pid ?? null,
      startedAt: isoNow(this.now),
      endedAt: null,
      exitCode: null,
      signal: null,
    };
    this.eventProcesses.push(eventProcess);
    child.once("error", (error) => {
      this.#recordGap("event_process_error", { attempt, error: sanitizeError(error) });
      void this.#persistFailure(
        new CollectorError("event_process_error", "Docker event process failed", {
          attempt,
          cause: sanitizeError(error),
        }),
      );
    });
    lineReader(
      child.stdout,
      async (line) => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          this.#recordGap("event_json_invalid");
          return;
        }
        const classification = classifyContainerEvent(event, this.config.projectId);
        if (classification.kind === "required") {
          await this.#attachContainer(classification.containerId, "event");
        } else if (classification.kind === "non_target") {
          this.#recordNonRequiredContainerEvent(event, classification);
        } else if (classification.kind === "ambiguous") {
          await this.#recordGap("event_container_identity_ambiguous", {
            containerId: classification.containerId,
            reason: classification.reason,
          });
        }
      },
      (error) =>
        this.#persistFailure(
          new CollectorError(
            "event_stream_read_failed",
            "event stream read failed",
            sanitizeError(error),
          ),
        ),
    );
    child.stderr.resume();
    void childClosed.then(async ({ code, signal }) => {
      eventProcess.endedAt = isoNow(this.now);
      eventProcess.exitCode = code;
      eventProcess.signal = signal;
      if (this.stopping) return;
      this.#recordGap("event_stream_disconnected", { attempt, exitCode: code, signal });
      if (this.eventReconnects >= this.config.maxEventReconnects) {
        await this.#persistFailure(
          new CollectorError("event_reconnect_exhausted", "event stream reconnect limit exhausted"),
        );
        return;
      }
      this.eventReconnects += 1;
      try {
        await this.#startEvents(this.eventReconnects);
        const inventory = await this.boundary.listContainerIds(this.config, this.processControl);
        await Promise.all(
          inventory.map((id) => this.#attachContainer(id, "event_reconnect_inventory")),
        );
      } catch (error) {
        await this.#persistFailure(error);
      }
    });
  }

  async #attachContainer(containerId, source) {
    if (this.stopping) return;
    if (this.attachedContainerIds.has(containerId)) return;
    if (this.pendingAttachments.has(containerId)) return this.pendingAttachments.get(containerId);
    const pending = this.#attachContainerInner(containerId, source).finally(() => {
      this.pendingAttachments.delete(containerId);
    });
    this.pendingAttachments.set(containerId, pending);
    return pending;
  }

  async #attachContainerInner(containerId, source) {
    if (this.stopping) return;
    let inspect;
    try {
      inspect = await this.boundary.inspectContainer(this.config, containerId, this.processControl);
    } catch (error) {
      this.#recordGap("container_disappeared_before_attach", { containerId, source });
      return;
    }
    if (this.stopping) return;
    const service = serviceFromInspect(inspect, this.config.projectId);
    if (!service) return;
    this.attachedContainerIds.add(containerId);
    this.observedServices.add(service);
    this.logReconnects.set(containerId, 0);
    await this.#startLogSegment({ containerId, service, source, attempt: 0 });
  }

  async #startLogSegment({ containerId, service, source, attempt }) {
    this.#ensureRunning();
    if (attempt > 0) await this.#verifyTarget();
    this.#ensureRunning();
    const segmentNumber =
      this.segments.filter((segment) => segment.containerId === containerId).length + 1;
    const directory = path.join(this.config.evidenceRoot, "service-logs", service, containerId);
    await this.fsApi.mkdir(directory, { recursive: true, mode: 0o700 });
    this.#ensureRunning();
    const stem = `segment-${String(segmentNumber).padStart(4, "0")}`;
    let child;
    try {
      child = this.boundary.openLogs(this.config, containerId);
    } catch (error) {
      this.#recordGap("logs_unavailable", { containerId, service, attempt });
      await this.#persistFailure(
        new CollectorError("logs_open_failed", `logs unavailable for ${service}`, { containerId }),
      );
      return;
    }
    const childClosed = this.#trackChild(child);
    this.logChildren.set(`${containerId}:${attempt}`, child);
    child.once("error", (error) => {
      this.#recordGap("log_process_error", {
        containerId,
        service,
        attempt,
        error: sanitizeError(error),
      });
      void this.#persistFailure(
        new CollectorError("log_process_error", `Docker log process failed for ${service}`, {
          containerId,
          attempt,
          cause: sanitizeError(error),
        }),
      );
    });
    const segment = {
      service,
      containerId,
      pid: child.pid ?? null,
      source,
      attempt,
      detectedAt: isoNow(this.now),
      captureStartedAt: isoNow(this.now),
      endedAt: null,
      exitCode: null,
      signal: null,
      stdout: null,
      stderr: null,
      complete: false,
    };
    this.segments.push(segment);
    const stdoutCapture = new StreamCapture({
      filePath: path.join(directory, `${stem}.stdout.log`),
      stream: child.stdout,
      fsApi: this.fsApi,
      createOutputStream: this.createOutputStream,
    });
    const stderrCapture = new StreamCapture({
      filePath: path.join(directory, `${stem}.stderr.log`),
      stream: child.stderr,
      fsApi: this.fsApi,
      createOutputStream: this.createOutputStream,
    });
    let captureFailurePublication = null;
    const reportCaptureFailure = (error) => {
      if (!captureFailurePublication) {
        captureFailurePublication = (async () => {
          await this.#recordGap("log_persistence_failed", { containerId, service, attempt });
          await this.#persistFailure(
            new CollectorError(
              "log_persistence_failed",
              `could not persist ${service} logs`,
              sanitizeError(error),
            ),
          );
        })();
      }
      return captureFailurePublication;
    };
    void stdoutCapture.done.catch((error) => reportCaptureFailure(error));
    void stderrCapture.done.catch((error) => reportCaptureFailure(error));
    try {
      await Promise.all([stdoutCapture.opened, stderrCapture.opened]);
    } catch (error) {
      await reportCaptureFailure(error);
      try {
        child.kill("SIGINT");
      } catch {}
      throw error;
    }
    const completion = (async () => {
      let code = null;
      let signal = null;
      try {
        ({ code, signal } = await childClosed);
      } catch (error) {
        this.#recordGap("log_process_close_unavailable", {
          containerId,
          service,
          attempt,
          error: sanitizeError(error),
        });
      }
      this.logChildren.delete(`${containerId}:${attempt}`);
      segment.endedAt = isoNow(this.now);
      segment.exitCode = code;
      segment.signal = signal;
      try {
        const [stdout, stderr] = await Promise.all([stdoutCapture.done, stderrCapture.done]);
        segment.stdout = {
          bytes: stdout.bytes,
          sha256: stdout.sha256,
          file: path.relative(this.config.evidenceRoot, stdout.path),
        };
        segment.stderr = {
          bytes: stderr.bytes,
          sha256: stderr.sha256,
          file: path.relative(this.config.evidenceRoot, stderr.path),
        };
        segment.complete = true;
        await writeJsonExclusive(path.join(directory, `${stem}.json`), segment, this.fsApi);
      } catch (error) {
        segment.complete = false;
        await reportCaptureFailure(error);
      }
      if (!this.stopping)
        await this.#handleLogDisconnect({ containerId, service, source, attempt, code, signal });
    })();
    this.segmentPromises.add(completion);
    void completion.then(
      () => this.segmentPromises.delete(completion),
      () => this.segmentPromises.delete(completion),
    );
  }

  async #handleLogDisconnect({ containerId, service, source, attempt, code, signal }) {
    let inspect;
    try {
      inspect = await this.boundary.inspectContainer(this.config, containerId, this.processControl);
    } catch {
      if (code !== 0) {
        this.#recordGap("container_logs_ended_nonzero_after_removal", {
          containerId,
          service,
          exitCode: code,
          signal,
        });
      }
      return;
    }
    if (!serviceFromInspect(inspect, this.config.projectId) || inspect?.State?.Running === false) {
      if (code !== 0) {
        this.#recordGap("container_logs_ended_nonzero", {
          containerId,
          service,
          exitCode: code,
          signal,
        });
      }
      return;
    }
    const reconnects = this.logReconnects.get(containerId) ?? 0;
    this.#recordGap("log_stream_disconnected", {
      containerId,
      service,
      attempt,
      exitCode: code,
      signal,
    });
    if (reconnects >= this.config.maxLogReconnects) {
      await this.#persistFailure(
        new CollectorError(
          "log_reconnect_exhausted",
          `log reconnect limit exhausted for ${service}`,
          {
            containerId,
          },
        ),
      );
      return;
    }
    this.logReconnects.set(containerId, reconnects + 1);
    try {
      await this.#startLogSegment({
        containerId,
        service,
        source,
        attempt: reconnects + 1,
      });
    } catch (error) {
      await this.#persistFailure(error);
    }
  }

  #signalOwnedChildren(signal) {
    for (const child of [...this.children]) {
      try {
        child.kill(signal);
      } catch (error) {
        void this.#recordGap("child_stop_failed", {
          pid: child.pid ?? null,
          signal,
          error: sanitizeError(error),
        });
      }
    }
  }

  async #drainOwnedChildren(signal) {
    this.#signalOwnedChildren(signal);
    while (
      this.pendingAttachments.size > 0 ||
      this.childClosePromises.size > 0 ||
      this.segmentPromises.size > 0
    ) {
      const pending = [
        ...this.pendingAttachments.values(),
        ...this.childClosePromises.values(),
        ...this.segmentPromises,
      ];
      await Promise.allSettled(pending);
      this.#signalOwnedChildren(signal);
    }
  }

  async #withShutdownDeadline(operation) {
    const deadline = this.deadlineFactory(this.config.shutdownTimeoutMs);
    try {
      return await Promise.race([
        operation.then(() => ({ timedOut: false })),
        deadline.promise.then(() => ({ timedOut: true })),
      ]);
    } finally {
      deadline.cancel?.();
    }
  }

  async stop(reason = "signal") {
    if (this.stopping) return this.stopPromise;
    this.stopping = true;
    const graceful = await this.#withShutdownDeadline(this.#drainOwnedChildren("SIGINT"));
    if (graceful.timedOut) {
      await this.#recordGap("shutdown_timeout", {
        phase: "graceful",
        timeoutMs: this.config.shutdownTimeoutMs,
      });
      await this.#persistFailure(
        new CollectorError("shutdown_timeout", "collector children did not close after SIGINT"),
      );
      const forced = await this.#withShutdownDeadline(this.#drainOwnedChildren("SIGKILL"));
      if (forced.timedOut) {
        await this.#recordGap("shutdown_timeout", {
          phase: "forced",
          timeoutMs: this.config.shutdownTimeoutMs,
          activeChildPids: [...this.children].map((child) => child.pid ?? null),
          pendingAttachments: this.pendingAttachments.size,
        });
        await this.#persistFailure(
          new CollectorError(
            "shutdown_force_timeout",
            "collector could not confirm closure of every owned child",
          ),
        );
      }
    }
    this.stoppedAt = isoNow(this.now);
    const missingServices = REQUIRED_SERVICES.filter(
      (service) => !this.observedServices.has(service),
    );
    if (missingServices.length > 0) {
      await this.#recordGap("required_services_not_observed", { services: missingServices });
    }
    const summary = {
      runId: this.config.runId,
      ready: this.ready,
      reason,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      context: this.config.context,
      endpoint: this.config.endpoint,
      engineId: this.config.engineId,
      projectId: this.config.projectId,
      observedServices: [...this.observedServices].sort(),
      missingServices,
      nonRequiredContainers: [...this.nonRequiredContainers.values()].sort((left, right) =>
        left.containerId.localeCompare(right.containerId),
      ),
      eventProcesses: this.eventProcesses,
      segments: this.segments,
      gaps: this.gaps,
      failures: this.failures,
      activeChildPids: [...this.children].map((child) => child.pid ?? null),
      pendingAttachments: this.pendingAttachments.size,
      complete:
        this.ready &&
        missingServices.length === 0 &&
        this.gaps.length === 0 &&
        this.failures.length === 0 &&
        this.children.size === 0 &&
        this.pendingAttachments.size === 0 &&
        this.segmentPromises.size === 0 &&
        this.segments.every((segment) => segment.complete),
    };
    if (this.evidenceValidated) {
      try {
        await writeJsonExclusive(
          path.join(this.config.evidenceRoot, "collector-summary.json"),
          summary,
          this.fsApi,
        );
      } catch (error) {
        summary.complete = false;
        summary.failures.push({ at: isoNow(this.now), ...sanitizeError(error), persistence: true });
      }
    }
    this.resolveStopped(summary);
    return summary;
  }

  waitForStop() {
    return this.stopPromise;
  }

  waitForUnhealthy() {
    return this.firstUnhealthyPromise;
  }

  recordFailure(error) {
    return this.#persistFailure(error);
  }
}

async function main() {
  const config = parseArguments(process.argv.slice(2));
  const collector = new ProductServiceLogCollector({ config });
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    const summary = await collector.stop(signal);
    process.exitCode = summary.complete ? 0 : 1;
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
  try {
    await collector.start();
    const summary = await collector.waitForStop();
    process.exitCode = summary.complete ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ event: "collector_failed", ...sanitizeError(error) })}\n`,
    );
    await collector.waitForStop();
    process.exitCode = 1;
  }
}

const isDirect =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) {
  void main();
}
