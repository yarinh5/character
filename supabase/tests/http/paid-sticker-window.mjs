import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";

const paid = "supabase/tests/http/paid_sticker.integration.test.ts";
export const PRODUCT_HTTP_FILES = Object.freeze([
  "supabase/tests/http/active_new_responsibility_send.integration.test.ts",
  "supabase/tests/http/admin_operations_snapshot.integration.test.ts",
  "supabase/tests/http/authorization_new.integration.test.ts",
  "supabase/tests/http/authorized_read_access_revocation.integration.test.ts",
  "supabase/tests/http/client_pii_archive.integration.test.ts",
  "supabase/tests/http/media_authorization.integration.test.ts",
  paid,
  "supabase/tests/http/wp11_admin_status.integration.test.ts",
]);
const project = "qmgkmsarzfjnqltljkjl";
const endpoint = "unix:///run/docker.sock";
const api = "http://127.0.0.1:60421";
const forbiddenEngine = "e4a8242c-6ed6-4be2-91d0-64ea7a7a1cfb";
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const stamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const pendingName = "paid-sticker-http-flag.pending.jsonl";
const eventSql =
  "SELECT json_build_object('notifications', (SELECT count(*) FROM public.notifications), 'analytics_events', (SELECT count(*) FROM public.analytics_events), 'audit_logs', (SELECT count(*) FROM public.audit_logs))::text;";

function requireProof(condition, reason) {
  if (!condition) throw new Error(`Paid-sticker HTTP: ${reason}.`);
}

export function isProductHttp(env) {
  return [
    "GATE_LEDGER",
    "PRODUCT_PROJECT_ID",
    "PRODUCT_HANDOFF_SHA256",
    "PRODUCT_EXPECTED_ENGINE_ID",
    "PRODUCT_DOCKER_CONTEXT",
    "PRODUCT_DOCKER_ENDPOINT",
    "PRODUCT_FORBIDDEN_ENGINE_ID",
  ].some((key) => Object.hasOwn(env, key));
}

function readBoundHandoff(path) {
  requireProof(lstatSync(path).isFile(), "the service-lane handoff is not a regular file");
  return readFileSync(path, "utf8");
}

function identity(env, cwd, config, realpath, readHandoff) {
  const run = env.RUN_ID ?? "";
  const root = `/srv/codex-product/verification/${run}/repository`;
  const evidence = `/srv/codex-product/evidence/${run}`;
  const handoff = posix.join(evidence, "service-lane-handoff-consumed.tsv");
  requireProof(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(run) &&
      /^[0-9a-f]{64}$/.test(env.PRODUCT_HANDOFF_SHA256 ?? "") &&
      env.INTEGRATION_RUN_ROOT === root &&
      cwd === root &&
      realpath(root) === root &&
      env.RUN_EVIDENCE === evidence &&
      realpath(evidence) === evidence &&
      env.GATE_LEDGER === posix.join(evidence, "gates.tsv") &&
      realpath(handoff) === handoff &&
      readHandoff(handoff) === `${run}\t${env.PRODUCT_HANDOFF_SHA256}\n`,
    "missing or mismatched Product run and service-lane handoff",
  );
  requireProof(
    env.PRODUCT_PROJECT_ID === project &&
      [...config.matchAll(/^project_id\s*=\s*"([^"]+)"\s*$/gm)].map((m) => m[1]).join(",") ===
        project,
    "the configured local project is not the admitted project",
  );
  const context = env.PRODUCT_DOCKER_CONTEXT;
  const engine = env.PRODUCT_EXPECTED_ENGINE_ID;
  requireProof(
    /^product-[a-z0-9-]+$/.test(context ?? "") &&
      env.DOCKER_CONTEXT === context &&
      env.PRODUCT_DOCKER_ENDPOINT === endpoint &&
      uuid.test(engine ?? "") &&
      engine !== forbiddenEngine &&
      env.PRODUCT_FORBIDDEN_ENGINE_ID === forbiddenEngine &&
      !["DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_CONFIG", "DOCKER_TLS"].some(
        (key) => env[key],
      ),
    "missing Product engine binding or conflicting Docker override",
  );
  return { run, evidence, context, engine };
}

function command(binary, args, env) {
  return execFileSync(binary, args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 15_000,
  });
}

function requiredCommand(invoke, binary, args, env, purpose) {
  try {
    return invoke(binary, args, env).trim();
  } catch {
    throw new Error(`Paid-sticker HTTP: ${purpose} failed.`);
  }
}

function parse(text, purpose) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Paid-sticker HTTP: invalid ${purpose} response.`);
  }
}

function containerIdentity(info, name, internal, published) {
  const ports = info?.NetworkSettings?.Ports?.[internal];
  const ips = new Set(ports?.map?.((entry) => entry?.HostIp));
  requireProof(
    info?.Name === "/" + name &&
      /^[0-9a-f]{64}$/.test(info.Id) &&
      info.Config?.Labels?.["com.supabase.cli.project"] === project &&
      info.State?.Running === true &&
      Number.isFinite(Date.parse(info.Created)) &&
      Number.isFinite(Date.parse(info.State.StartedAt)) &&
      Array.isArray(ports) &&
      ips.size === ports.length &&
      ports.every(
        (port) =>
          port?.HostPort === published &&
          ["127.0.0.1", "0.0.0.0", "::1", "::"].includes(port.HostIp),
      ) &&
      (ips.has("127.0.0.1") || ips.has("0.0.0.0")),
    "the running container generation or exact loopback port binding is unproven",
  );
  return { id: info.Id, created: info.Created, started: info.State.StartedAt };
}

function verifyStatus(status) {
  requireProof(
    typeof status?.API_URL === "string" &&
      typeof status.DB_URL === "string" &&
      /^http:\/\/(?:127\.0\.0\.1|localhost):60421\/?$/.test(status.API_URL) &&
      /^postgresql:\/\/[^/?#@]+@(?:127\.0\.0\.1|localhost):60422\/postgres$/.test(
        status?.DB_URL ?? "",
      ),
    "Supabase status did not identify the exact loopback API and DB",
  );
  requireProof(
    [status.ANON_KEY, status.SERVICE_ROLE_KEY].every(
      (key) => typeof key === "string" && key.length > 0 && !/\s/.test(key),
    ),
    "local anon and service-role auth are required for the named suite",
  );
}

const rowJson = `json_build_object('id', id, 'key', key, 'value', value, 'type', jsonb_typeof(value),
  'xmin', xmin::text, 'ctid', ctid::text,
  'updatedAt', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))`;
const flag = "key = 'stickers_enabled'";

function exactFlag(row) {
  requireProof(
    row?.key === "stickers_enabled" &&
      typeof row.id === "string" &&
      uuid.test(row.id) &&
      row.type === "boolean" &&
      typeof row.value === "boolean" &&
      /^\d+$/.test(row.xmin) &&
      typeof row.xmin === "string" &&
      /^\(\d+,\d+\)$/.test(row.ctid) &&
      typeof row.ctid === "string" &&
      typeof row.updatedAt === "string" &&
      stamp.test(row.updatedAt),
    "expected one existing stickers_enabled JSON boolean with a valid row generation",
  );
  return row;
}

function readFlag(query) {
  const rows = parse(
    query(`SELECT COALESCE(json_agg(row_value), '[]'::json) FROM
    (SELECT ${rowJson} AS row_value FROM public.system_settings WHERE ${flag}) AS flag_result;`),
    "flag read",
  );
  requireProof(
    Array.isArray(rows) && rows.length === 1,
    "expected one existing stickers_enabled row",
  );
  return exactFlag(rows[0]);
}

function updateFlag(query, from, value, updatedAt) {
  const updated = exactFlag(
    parse(
      query(`UPDATE public.system_settings
    SET value = '${value}'::jsonb, updated_at = '${updatedAt}'::timestamptz
    WHERE ${flag} AND id = '${from.id}'::uuid AND xmin::text = '${from.xmin}'
      AND ctid::text = '${from.ctid}' AND value = '${from.value}'::jsonb
      AND updated_at = '${from.updatedAt}'::timestamptz
    RETURNING ${rowJson};`),
      "flag update",
    ),
  );
  requireProof(
    updated.id === from.id &&
      updated.value === value &&
      updated.updatedAt === updatedAt &&
      updated.xmin !== from.xmin &&
      updated.ctid !== from.ctid,
    "the flag update did not return a new matching row generation",
  );
  return updated;
}

function syncDirectory(directory) {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function openFlagJournal(directory, initial) {
  const pending = posix.join(directory, pendingName);
  const archived = posix.join(directory, `paid-sticker-http-flag.${randomUUID()}.jsonl`);
  function write(record, flags) {
    const fd = openSync(pending, flags, 0o600);
    try {
      writeFileSync(fd, JSON.stringify(record) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  write(initial, "wx");
  syncDirectory(directory);
  return {
    append(record) {
      write(record, "a");
    },
    close() {
      renameSync(pending, archived);
      syncDirectory(directory);
    },
  };
}

function assertNotInterrupted(signal) {
  requireProof(!signal?.aborted, "the required suite was interrupted");
}

function hasPending(directory) {
  return Boolean(lstatSync(posix.join(directory, pendingName), { throwIfNoEntry: false }));
}

export async function runProductHttp({
  args,
  env,
  cwd,
  config,
  runVitest,
  signal,
  command: invoke = command,
  readHandoff = readBoundHandoff,
  realpath = realpathSync,
  journal = openFlagJournal,
  pending = hasPending,
  baseline = (label, query) => {
    const result = parse(query(eventSql), "HTTP event baseline");
    console.log(
      `HTTP event baseline ${label}: notifications=${result.notifications}, analytics_events=${result.analytics_events}, audit_logs=${result.audit_logs}`,
    );
    return result;
  },
}) {
  requireProof(
    args.length === PRODUCT_HTTP_FILES.length &&
      new Set(args).size === args.length &&
      PRODUCT_HTTP_FILES.every((path) => args.includes(path)),
    "the exact Product HTTP inventory must be selected without filters",
  );
  assertNotInterrupted(signal);
  const { run, evidence, context, engine } = identity(env, cwd, config, realpath, readHandoff);
  requireProof(!pending(evidence), "an earlier flag journal is pending; no suite was run");
  const localEnv = { ...env };
  delete localEnv.DOCKER_CONTEXT;
  delete localEnv.DOCKER_HOST;
  for (const key of Object.keys(localEnv)) {
    if (/^(?:HTTP|HTTPS|ALL)_PROXY$|^NODE_USE_ENV_PROXY$/i.test(key)) delete localEnv[key];
  }
  const runCommand = (binary, args, env, purpose) =>
    requiredCommand(invoke, binary, args, env, purpose);
  requireProof(
    runCommand(
      "docker",
      ["context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"],
      localEnv,
      "named context inspection",
    ) === endpoint,
    "the named context does not resolve to the admitted Unix socket",
  );
  const docker = (args, purpose) =>
    runCommand("docker", ["--host", endpoint, ...args], localEnv, purpose);
  const dbName = `supabase_db_${project}`;
  const apiName = `supabase_kong_${project}`;
  function discover() {
    requireProof(
      docker(["info", "--format", "{{.ID}}"], "engine inspection") === engine,
      "the observed Docker engine is not the admitted engine",
    );
    const pair = parse(
      docker(["inspect", "--type", "container", dbName, apiName], "container inspection"),
      "container inspection",
    );
    requireProof(
      Array.isArray(pair) && pair.length === 2,
      "the local DB and API selection is ambiguous",
    );
    return {
      db: containerIdentity(pair[0], dbName, "5432/tcp", "60422"),
      api: containerIdentity(pair[1], apiName, "8000/tcp", "60421"),
    };
  }
  const target = discover();
  const childEnv = { ...localEnv, DOCKER_HOST: endpoint };
  const status = parse(
    runCommand("supabase", ["status", "--output", "json"], childEnv, "local status"),
    "local status",
  );
  verifyStatus(status);
  function query(sql) {
    requireProof(
      isDeepStrictEqual(discover(), target),
      "the admitted DB or API generation changed",
    );
    return docker(
      [
        "exec",
        target.db.id,
        "psql",
        "-XqAt",
        "-h",
        "/var/run/postgresql",
        "-p",
        "5432",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `SET lock_timeout = '3s'; SET statement_timeout = '5s'; ${sql}`,
      ],
      "pinned local SQL",
    );
  }
  Object.assign(childEnv, {
    SUPABASE_LOCAL_URL: api,
    SUPABASE_LOCAL_API_PORT: "60421",
    SUPABASE_LOCAL_DB_CONTAINER: target.db.id,
    SUPABASE_LOCAL_PROJECT_ID: project,
    SUPABASE_LOCAL_ANON_KEY: status.ANON_KEY,
    SUPABASE_LOCAL_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    SUPABASE_LOCAL_PAID_STICKER_REQUIRED: "0",
  });
  const original = readFlag(query);
  const before = baseline("before", query);
  const others = args.filter((arg) => arg !== paid);
  let result = others.length
    ? await runVitest(others, {
        ...childEnv,
        SUPABASE_LOCAL_STICKERS_ENABLED: String(original.value),
      })
    : 0;
  assertNotInterrupted(signal);
  if (result === 0) {
    requireProof(
      isDeepStrictEqual(readFlag(query), original),
      "the original flag generation changed",
    );
    // A transient stamp lets finally identify our write even if its SQL reply was lost.
    const marker = new Date()
      .toISOString()
      .replace("Z", String(randomInt(1000)).padStart(3, "0") + "Z");
    requireProof(marker !== original.updatedAt, "the activation stamp equals the original stamp");
    const log = journal(evidence, {
      phase: "prepared",
      run,
      handoff: env.PRODUCT_HANDOFF_SHA256,
      engine,
      project,
      ...target,
      original,
      marker,
    });
    let enabled;
    try {
      assertNotInterrupted(signal);
      enabled = original.value ? original : updateFlag(query, original, true, marker);
      requireProof(
        enabled.value === true &&
          enabled.id === original.id &&
          enabled.updatedAt === (original.value ? original.updatedAt : marker) &&
          isDeepStrictEqual(readFlag(query), enabled),
        "enabled flag did not read back exactly",
      );
      log.append({ phase: "enabled", row: enabled });
      assertNotInterrupted(signal);
      result = await runVitest([paid], {
        ...childEnv,
        SUPABASE_LOCAL_PAID_STICKER_REQUIRED: "1",
        SUPABASE_LOCAL_STICKERS_ENABLED: "true",
      });
    } finally {
      const current = readFlag(query);
      let restored = current;
      if (!original.value && !isDeepStrictEqual(current, original)) {
        requireProof(
          current.id === original.id &&
            current.value === true &&
            current.updatedAt === marker &&
            (!enabled || isDeepStrictEqual(current, enabled)),
          "the active flag generation is not owned by this window",
        );
        restored = updateFlag(query, current, original.value, original.updatedAt);
      } else {
        requireProof(
          original.value ? isDeepStrictEqual(current, original) : !enabled,
          "the active flag changed before restoration",
        );
      }
      requireProof(
        restored.id === original.id &&
          restored.value === original.value &&
          restored.updatedAt === original.updatedAt &&
          isDeepStrictEqual(readFlag(query), restored),
        "the original flag did not read back exactly",
      );
      log.append({ phase: "restored", row: restored });
      // An unchanged original after a failed enable cannot rule out a late write.
      if (original.value || enabled || !isDeepStrictEqual(current, original)) log.close();
    }
    assertNotInterrupted(signal);
  }
  requireProof(
    isDeepStrictEqual(baseline("after", query), before),
    "HTTP fixture event residue changed the verified pre-suite baseline",
  );
  assertNotInterrupted(signal);
  return result;
}
