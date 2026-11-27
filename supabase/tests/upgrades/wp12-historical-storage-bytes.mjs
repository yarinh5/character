import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import {
  discoverConcurrencyTarget,
  resolveConcurrencyBinding,
} from "../concurrency/local-target.mjs";

const phase = process.argv[2];
assert.ok(phase === "seed" || phase === "verify", "expected seed or verify phase");
assert.ok(process.env.PRODUCT_TEST_PROJECT_ID, "isolated project pin required");
assert.ok(process.env.PRODUCT_TEST_ENGINE_ID, "isolated Engine pin required");

const binding = resolveConcurrencyBinding();
const target = discoverConcurrencyTarget(binding, { healthy: true });
const migrationCount = Number(
  execFileSync(
    "docker",
    [
      "exec",
      target.dbId,
      "psql",
      "-X",
      "-qAt",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "SELECT count(*) FROM supabase_migrations.schema_migrations",
    ],
    { encoding: "utf8", timeout: 30_000 },
  ).trim(),
);
assert.equal(migrationCount, phase === "seed" ? 113 : 184, "wrong upgrade phase");

const status = JSON.parse(
  execFileSync("supabase", ["status", "--output", "json"], {
    encoding: "utf8",
    timeout: 30_000,
  }),
);
assert.ok(status.SERVICE_ROLE_KEY, "local service key unavailable");
assert.ok(status.ANON_KEY, "local anonymous key unavailable");
const apiUrl = new URL(status.API_URL);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(apiUrl.hostname));
assert.equal(Number(apiUrl.port), target.apiPort);

const client = createClient(apiUrl.toString(), status.SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const storage = client.storage.from("character-media");
const anonymousStorage = createClient(apiUrl.toString(), status.ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
}).storage.from("character-media");
const bytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9S7eEAAAAASUVORK5CYII=",
  "base64",
);
const paths = [
  "wp12-rehearsal/legacy-source.png",
  "wp12-rehearsal/legacy-preview.png",
  "wp12-rehearsal/legacy-teaser.png",
  "wp12-rehearsal/legacy-delivery.png",
];

for (const path of paths) {
  if (phase === "seed") {
    const uploaded = await storage.upload(path, bytes, {
      contentType: "image/png",
      upsert: false,
    });
    assert.ifError(uploaded.error);
  }
  const downloaded = await storage.download(path);
  assert.ifError(downloaded.error);
  assert.ok(downloaded.data, `${path} has no response body`);
  const actual = Buffer.from(await downloaded.data.arrayBuffer());
  assert.deepEqual(actual, bytes, `${path} changed across the upgrade`);
  if (phase === "verify") {
    const anonymous = await anonymousStorage.download(path);
    assert.ok(anonymous.error && !anonymous.data, `${path} leaked to an anonymous reader`);
  }
  process.stdout.write(
    JSON.stringify({
      phase,
      migrationCount,
      path,
      bytes: actual.length,
      sha256: createHash("sha256").update(actual).digest("hex"),
    }) + "\n",
  );
}
