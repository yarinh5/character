import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectId = "qmgkmsarzfjnqltljkjl";
const dbContainer = `supabase_db_${projectId}`;
const apiContainer = `supabase_kong_${projectId}`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function configPort(config, section) {
  const sectionPattern = section.replaceAll(".", "\\.");
  const match = config.match(new RegExp(`\\[${sectionPattern}\\]([\\s\\S]*?)(?=\\n\\[|$)`));
  if (!match) fail(`Refusing HTTP tests: missing [${section}] local configuration.`);
  const port = match[1].match(/^\s*port\s*=\s*(\d+)\s*$/m);
  if (!port) fail(`Refusing HTTP tests: missing [${section}].port local configuration.`);
  return Number(port[1]);
}

function assertLoopbackUrl(value, expectedPort, label) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    fail(`Refusing HTTP tests: ${label} is not a valid local URL.`);
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    fail(`Refusing HTTP tests: ${label} is not loopback.`);
  }
  if (Number(url.port) !== expectedPort) {
    fail(`Refusing HTTP tests: ${label} does not match config.toml.`);
  }
}

function assertDockerPort(name, internalPort, expectedPort) {
  let info;
  try {
    [info] = JSON.parse(
      execFileSync("docker", ["inspect", name], { encoding: "utf8", windowsHide: true }),
    );
  } catch {
    fail(`Refusing HTTP tests: ${name} could not be verified as this local project.`);
  }
  const published = info?.NetworkSettings?.Ports?.[internalPort] ?? [];
  if (
    info?.Name !== `/${name}` ||
    info?.State?.Running !== true ||
    !published.some((entry) => Number(entry.HostPort) === expectedPort)
  ) {
    fail(`Refusing HTTP tests: ${name} does not match the configured local port mapping.`);
  }
}

const status = spawnSync("supabase", ["status", "--output", "json"], {
  encoding: "utf8",
  windowsHide: true,
});

if (status.status !== 0) {
  fail("Local Supabase status could not be read; no HTTP tests were run.");
}

let local;
try {
  local = JSON.parse(status.stdout);
} catch {
  fail("Local Supabase status was not valid JSON; no HTTP tests were run.");
}

const apiUrl = String(local.API_URL ?? "");
const dbUrl = String(local.DB_URL ?? "");
const config = readFileSync(resolve("supabase", "config.toml"), "utf8");
if (!new RegExp(`project_id\\s*=\\s*"${projectId}"`).test(config)) {
  fail("Refusing HTTP tests: config.toml is not the expected local project.");
}
const apiPort = configPort(config, "api");
const dbPort = configPort(config, "db");
assertLoopbackUrl(apiUrl, apiPort, "local API URL");
assertLoopbackUrl(dbUrl, dbPort, "local DB URL");
assertDockerPort(dbContainer, "5432/tcp", dbPort);
assertDockerPort(apiContainer, "8000/tcp", apiPort);
console.log(`Verified isolated local stack: API ${apiPort}, DB ${dbPort}`);

let stickersEnabled = "unknown";
try {
  const settingsResponse = await fetch(
    `${apiUrl}/rest/v1/system_settings?select=key,value&key=eq.stickers_enabled`,
    {
      headers: {
        apikey: String(local.SERVICE_ROLE_KEY ?? ""),
        Authorization: `Bearer ${String(local.SERVICE_ROLE_KEY ?? "")}`,
      },
    },
  );
  if (settingsResponse.ok) {
    const settings = await settingsResponse.json();
    stickersEnabled =
      String(settings?.[0]?.value ?? "").replaceAll('"', "") === "true" ? "true" : "false";
  }
} catch {
  stickersEnabled = "unknown";
}

const vitestBin = resolve("node_modules/vitest/vitest.mjs");
const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [vitestBin, "run", ...args], {
  env: {
    ...process.env,
    SUPABASE_LOCAL_URL: apiUrl,
    SUPABASE_LOCAL_ANON_KEY: String(local.ANON_KEY ?? ""),
    SUPABASE_LOCAL_SERVICE_ROLE_KEY: String(local.SERVICE_ROLE_KEY ?? ""),
    SUPABASE_LOCAL_STICKERS_ENABLED: stickersEnabled,
  },
  stdio: "inherit",
  windowsHide: true,
});

process.exit(result.status ?? 1);
