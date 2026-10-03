import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const status = spawnSync("supabase", ["status", "--output", "json"], {
  encoding: "utf8",
  windowsHide: true,
});

if (status.status !== 0) {
  console.error("Local Supabase status could not be read; no HTTP tests were run.");
  process.exit(status.status ?? 1);
}

let local;
try {
  local = JSON.parse(status.stdout);
} catch {
  console.error("Local Supabase status was not valid JSON; no HTTP tests were run.");
  process.exit(1);
}

const apiUrl = String(local.API_URL ?? "");
const dbUrl = String(local.DB_URL ?? "");
if (!apiUrl.includes(":60421") || !dbUrl.includes(":60422")) {
  console.error("Refusing HTTP tests because the local API/DB ports are not 60421/60422.");
  process.exit(1);
}

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
