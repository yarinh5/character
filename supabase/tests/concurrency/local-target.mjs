import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const qaProject = "qmgkmsarzfjnqltljkjl";

export function resolveConcurrencyBinding(env = process.env) {
  const projectId = env.PRODUCT_TEST_PROJECT_ID;
  const engineId = env.PRODUCT_TEST_ENGINE_ID;
  if (projectId === undefined && engineId === undefined)
    return { projectId: qaProject, engineId: null };
  assert.ok(
    typeof projectId === "string" &&
      /^[a-z0-9][a-z0-9-]{2,62}$/.test(projectId) &&
      projectId !== qaProject &&
      typeof engineId === "string" &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(engineId),
    "isolated non-QA project and Engine pins are required together",
  );
  return { projectId, engineId };
}

function configuredValue(config, section, key) {
  const block = section
    ? config.match(new RegExp(`\\[${section}\\]([\\s\\S]*?)(?=\\n\\[|$)`))?.[1]
    : config.split(/^\[/m)[0];
  const value = block?.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)\\s*$`, "m"))?.[1];
  assert.ok(value, `missing ${section}.${key} in config.toml`);
  return Number(value);
}

function assertContainer(info, name, port, expectedPort, projectId, healthy, pinned) {
  assert.equal(info?.Name, `/${name}`, `${name} identity mismatch`);
  assert.match(info?.Id ?? "", /^[a-f0-9]{64}$/i, `${name} ID invalid`);
  if (pinned)
    assert.equal(
      info?.Config?.Labels?.["com.supabase.cli.project"],
      projectId,
      `${name} project label mismatch`,
    );
  assert.equal(info?.State?.Running, true, `${name} must be running`);
  if (healthy) assert.equal(info?.State?.Health?.Status, "healthy", `${name} must be healthy`);
  assert.ok(
    (info?.NetworkSettings?.Ports?.[port] ?? []).some(
      (entry) => Number(entry.HostPort) === expectedPort,
    ),
    `${name} port mapping mismatch`,
  );
}

export function validateConcurrencyTarget({
  binding,
  config,
  status,
  engineId,
  db,
  api,
  healthy = false,
}) {
  assert.equal(
    config.match(/^project_id\s*=\s*"([^"]+)"\s*$/m)?.[1],
    binding.projectId,
    "config project mismatch",
  );
  if (binding.engineId !== null)
    assert.equal(engineId, binding.engineId, "Docker Engine ID mismatch");
  const dbPort = configuredValue(config, "db", "port");
  const apiPort = configuredValue(config, "api", "port");
  for (const [value, port] of [
    [status?.DB_URL, dbPort],
    [status?.API_URL, apiPort],
  ]) {
    const url = new URL(value);
    assert.ok(
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
      "status must be loopback",
    );
    assert.equal(Number(url.port), port, "status port mismatch");
  }
  const pinned = binding.engineId !== null;
  assertContainer(
    db,
    `supabase_db_${binding.projectId}`,
    "5432/tcp",
    dbPort,
    binding.projectId,
    healthy,
    pinned,
  );
  assertContainer(
    api,
    `supabase_kong_${binding.projectId}`,
    "8000/tcp",
    apiPort,
    binding.projectId,
    false,
    pinned,
  );
  return { dbId: db.Id, apiId: api.Id, dbPort, apiPort };
}

export function discoverConcurrencyTarget(
  binding,
  { command = execFileSync, readConfig = readFileSync, healthy = false } = {},
) {
  const run = (program, args) =>
    command(program, args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
  const config = readConfig(join(root, "supabase", "config.toml"), "utf8");
  assert.equal(
    config.match(/^project_id\s*=\s*"([^"]+)"\s*$/m)?.[1],
    binding.projectId,
    "config project mismatch",
  );
  const engineId =
    binding.engineId === null ? null : run("docker", ["info", "--format", "{{.ID}}"]).trim();
  if (binding.engineId !== null)
    assert.equal(engineId, binding.engineId, "Docker Engine ID mismatch");
  const status = JSON.parse(run("supabase", ["status", "--output", "json"]));
  const inspect = (name) => JSON.parse(run("docker", ["inspect", name]))[0];
  return validateConcurrencyTarget({
    binding,
    config,
    status,
    engineId,
    db: inspect(`supabase_db_${binding.projectId}`),
    api: inspect(`supabase_kong_${binding.projectId}`),
    healthy,
  });
}
