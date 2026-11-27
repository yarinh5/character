import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  discoverConcurrencyTarget,
  resolveConcurrencyBinding,
  validateConcurrencyTarget,
} from "./local-target.mjs";

const qa = "qmgkmsarzfjnqltljkjl";
const projectId = "isolated-concurrency";
const engineId = "11111111-2222-4333-8444-555555555555";
const binding = { projectId, engineId };
const config = `project_id = "${projectId}"
[api]
port = 61421
[db]
port = 61422
`;
const status = {
  API_URL: "http://127.0.0.1:61421",
  DB_URL: "postgresql://127.0.0.1:61422/postgres",
};
function container(kind, overrides = {}) {
  const db = kind === "db";
  return {
    Name: `/supabase_${kind}_${projectId}`,
    Id: (db ? "d" : "a").repeat(64),
    Config: { Labels: { "com.supabase.cli.project": projectId } },
    State: { Running: true, Health: { Status: "healthy" } },
    NetworkSettings: {
      Ports: { [db ? "5432/tcp" : "8000/tcp"]: [{ HostPort: db ? "61422" : "61421" }] },
    },
    ...overrides,
  };
}
const evidence = () => ({
  binding,
  config,
  status,
  engineId,
  db: container("db"),
  api: container("kong"),
});

test("requires paired non-QA project and Engine pins", () => {
  assert.deepEqual(resolveConcurrencyBinding({}), { projectId: qa, engineId: null });
  assert.deepEqual(
    resolveConcurrencyBinding({
      PRODUCT_TEST_PROJECT_ID: projectId,
      PRODUCT_TEST_ENGINE_ID: engineId,
    }),
    binding,
  );
  for (const env of [
    { PRODUCT_TEST_PROJECT_ID: projectId },
    { PRODUCT_TEST_ENGINE_ID: engineId },
    { PRODUCT_TEST_PROJECT_ID: qa, PRODUCT_TEST_ENGINE_ID: engineId },
    { PRODUCT_TEST_PROJECT_ID: "../qa", PRODUCT_TEST_ENGINE_ID: engineId },
    { PRODUCT_TEST_PROJECT_ID: projectId, PRODUCT_TEST_ENGINE_ID: "" },
  ])
    assert.throws(() => resolveConcurrencyBinding(env), /pins are required together/);
});

test("all five entrypoints reject a partial pin before Docker or SQL", () => {
  const env = { ...process.env };
  delete env.PRODUCT_TEST_ENGINE_ID;
  for (const runner of [
    "claim-concurrency.mjs",
    "cycle-bound-send-concurrency.mjs",
    "handling-shadow-concurrency.mjs",
    "product-completion-review-concurrency.mjs",
    "read-access-revocation-concurrency.mjs",
  ]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(runner, import.meta.url))], {
      env: { ...env, PRODUCT_TEST_PROJECT_ID: projectId },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 1, runner);
    assert.match(result.stderr, /pins are required together/, runner);
  }
});

test("validates pinned config, engine, exact labels, IDs, status, and ports", () => {
  assert.deepEqual(validateConcurrencyTarget({ ...evidence(), healthy: true }), {
    dbId: "d".repeat(64),
    apiId: "a".repeat(64),
    dbPort: 61422,
    apiPort: 61421,
  });
  for (const drift of [
    { config: config.replace(projectId, qa) },
    { engineId: "22222222-2222-4333-8444-555555555555" },
    { db: container("db", { Config: { Labels: { "com.supabase.cli.project": qa } } }) },
    { api: container("kong", { Name: `/supabase_kong_${qa}` }) },
    { db: container("db", { Id: "bad" }) },
    { status: { ...status, DB_URL: "postgresql://remote:61422/postgres" } },
    { db: container("db", { State: { Running: false } }) },
  ])
    assert.throws(() => validateConcurrencyTarget({ ...evidence(), ...drift, healthy: true }));
});

test("discovery stops on an Engine mismatch before inspecting containers", () => {
  const calls = [];
  assert.throws(
    () =>
      discoverConcurrencyTarget(binding, {
        readConfig: () => config,
        command: (program, args) => {
          calls.push([program, ...args]);
          return "22222222-2222-4333-8444-555555555555";
        },
      }),
    /Engine ID mismatch/,
  );
  assert.deepEqual(calls, [["docker", "info", "--format", "{{.ID}}"]]);
});
