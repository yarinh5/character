import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DockerInspectQueryError,
  PortBindingEvidenceError,
  captureDockerInspectForPortValidation,
  validatePublishedPortBindings,
} from "./local-docker-port-contract.mjs";

function evidenceRoot() {
  return mkdtempSync(join(tmpdir(), "product-port-evidence-"));
}

function inspectResult(bindings, overrides = {}) {
  return {
    status: 0,
    signal: null,
    stderr: "",
    stdout: JSON.stringify([
      {
        Id: "a".repeat(64),
        Name: "/supabase_kong_qmgkmsarzfjnqltljkjl",
        Config: { Env: ["SECRET=must-not-be-written"] },
        NetworkSettings: { Ports: { "8000/tcp": bindings } },
      },
    ]),
    ...overrides,
  };
}

const separateProcessCaptureScript = String.raw`
const [moduleUrl, evidenceRoot] = process.argv.slice(1);
const {
  captureDockerInspectForPortValidation,
  validatePublishedPortBindings,
} = await import(moduleUrl);
const container = captureDockerInspectForPortValidation({
  configPath: "/workspace/supabase/config.toml",
  cwd: "/workspace",
  evidencePrefix: "db-local",
  evidenceRoot,
  expectedHostPort: 60422,
  internalPort: "5432/tcp",
  name: "supabase_db_qmgkmsarzfjnqltljkjl",
  runner: () => ({
    status: 0,
    signal: null,
    stderr: "",
    stdout: JSON.stringify([{
      Id: "b".repeat(64),
      NetworkSettings: {
        Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "60422" }] },
      },
    }]),
  }),
  targetKind: "db",
});
validatePublishedPortBindings(
  container.NetworkSettings.Ports["5432/tcp"],
  60422,
  "database",
);
`;

test("keeps evidence from two separate DB runner processes in the same root", () => {
  const root = evidenceRoot();
  const moduleUrl = new URL("./local-docker-port-contract.mjs", import.meta.url).href;
  const runCapture = () =>
    spawnSync(
      process.execPath,
      ["--input-type=module", "-e", separateProcessCaptureScript, moduleUrl, root],
      { encoding: "utf8", windowsHide: true },
    );
  try {
    const first = runCapture();
    assert.equal(first.status, 0, first.stderr);
    const [firstName] = readdirSync(join(root, "port-bindings"));
    const firstBytes = readFileSync(join(root, "port-bindings", firstName));

    const second = runCapture();
    assert.equal(second.status, 0, second.stderr);
    const names = readdirSync(join(root, "port-bindings")).sort();
    assert.equal(names.length, 2);
    assert.notEqual(names[0], names[1]);
    const invocationIds = names.map(
      (name) => JSON.parse(readFileSync(join(root, "port-bindings", name), "utf8")).invocationId,
    );
    assert.equal(new Set(invocationIds).size, 2);
    assert.deepEqual(readFileSync(join(root, "port-bindings", firstName)), firstBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts only complete authorized binding sets without coercion", () => {
  assert.deepEqual(
    validatePublishedPortBindings(
      [
        { HostIp: "0.0.0.0", HostPort: "60421" },
        { HostIp: "::", HostPort: "60421" },
      ],
      60421,
      "Kong",
    ),
    [
      { HostIp: "0.0.0.0", HostPort: "60421" },
      { HostIp: "::", HostPort: "60421" },
    ],
  );
  for (const bindings of [
    [],
    null,
    [{ HostIp: "", HostPort: "60421" }],
    [{ HostIp: "192.0.2.10", HostPort: "60421" }],
    [{ HostIp: "127.0.0.1", HostPort: 60421 }],
    [{ HostIp: "127.0.0.1", HostPort: "060421" }],
    [
      { HostIp: "127.0.0.1", HostPort: "60421" },
      { HostIp: "::1", HostPort: "60422" },
    ],
    [
      { HostIp: "127.0.0.1", HostPort: "60421" },
      { HostIp: "127.0.0.1", HostPort: "60421" },
    ],
  ]) {
    assert.throws(() => validatePublishedPortBindings(bindings, 60421, "Kong"));
  }
});

test("preserves filtered inspect evidence before a binding validation failure", () => {
  const root = evidenceRoot();
  const calls = [];
  try {
    const container = captureDockerInspectForPortValidation({
      configPath: "/workspace/supabase/config.toml",
      cwd: "/workspace",
      evidencePrefix: "db-local",
      evidenceRoot: root,
      expectedHostPort: 60421,
      internalPort: "8000/tcp",
      name: "supabase_kong_qmgkmsarzfjnqltljkjl",
      runner: (command, args, options) => {
        calls.push({ command, args, options });
        return inspectResult([
          { HostIp: "127.0.0.1", HostPort: "60421" },
          { HostIp: "192.0.2.10", HostPort: "60421" },
        ]);
      },
      targetKind: "api",
    });
    assert.throws(() =>
      validatePublishedPortBindings(container.NetworkSettings.Ports["8000/tcp"], 60421, "Kong"),
    );
    assert.deepEqual(calls[0].args, ["inspect", "supabase_kong_qmgkmsarzfjnqltljkjl"]);
    const [file] = readdirSync(join(root, "port-bindings"));
    const text = readFileSync(join(root, "port-bindings", file), "utf8");
    const evidence = JSON.parse(text);
    assert.equal(evidence.query.exitCode, 0);
    assert.equal(evidence.containerId, "a".repeat(64));
    assert.deepEqual(evidence.bindings, [
      { HostIp: "127.0.0.1", HostPort: "60421" },
      { HostIp: "192.0.2.10", HostPort: "60421" },
    ]);
    assert.doesNotMatch(text, /SECRET|must-not-be-written/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blocks the query when the private evidence root is unavailable", () => {
  let invoked = false;
  assert.throws(
    () =>
      captureDockerInspectForPortValidation({
        configPath: "/workspace/supabase/config.toml",
        cwd: "/workspace",
        evidencePrefix: "db-local",
        evidenceRoot: join(tmpdir(), `missing-product-evidence-root-${process.pid}-${Date.now()}`),
        expectedHostPort: 60421,
        internalPort: "8000/tcp",
        name: "supabase_kong_qmgkmsarzfjnqltljkjl",
        runner: () => {
          invoked = true;
          return inspectResult([{ HostIp: "127.0.0.1", HostPort: "60421" }]);
        },
        targetKind: "api",
      }),
    PortBindingEvidenceError,
  );
  assert.equal(invoked, false);
});

test("keeps a Docker query failure separate when evidence preservation also fails", () => {
  const root = evidenceRoot();
  try {
    assert.throws(
      () =>
        captureDockerInspectForPortValidation({
          configPath: "/workspace/supabase/config.toml",
          cwd: "/workspace",
          evidencePrefix: "db-local",
          evidenceRoot: root,
          expectedHostPort: 60421,
          internalPort: "8000/tcp",
          name: "supabase_kong_qmgkmsarzfjnqltljkjl",
          runner: () => ({
            status: 127,
            signal: null,
            stdout: "",
            stderr: "docker missing",
          }),
          targetKind: "api",
          writeEvidence: () => {
            throw new Error("simulated evidence write failure");
          },
        }),
      (error) =>
        error instanceof PortBindingEvidenceError &&
        error.primaryFailure instanceof DockerInspectQueryError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blocks caller continuation when successful query evidence cannot be saved", () => {
  const root = evidenceRoot();
  let continued = false;
  try {
    assert.throws(() => {
      const container = captureDockerInspectForPortValidation({
        configPath: "/workspace/supabase/config.toml",
        cwd: "/workspace",
        evidencePrefix: "db-local",
        evidenceRoot: root,
        expectedHostPort: 60422,
        internalPort: "5432/tcp",
        name: "supabase_db_qmgkmsarzfjnqltljkjl",
        runner: () => inspectResult([{ HostIp: "127.0.0.1", HostPort: "60422" }]),
        targetKind: "db",
        writeEvidence: () => {
          throw new Error("simulated evidence write failure");
        },
      });
      validatePublishedPortBindings(container.NetworkSettings.Ports["5432/tcp"], 60422, "database");
      continued = true;
    }, PortBindingEvidenceError);
    assert.equal(continued, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: "exit 127",
    result: { status: 127, signal: null, stdout: "", stderr: "docker missing" },
    expected: { exitCode: 127, timedOut: false, parseFailure: null },
  },
  {
    name: "timeout",
    result: {
      status: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "timed out",
      error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
    },
    expected: { exitCode: null, timedOut: true, parseFailure: null },
  },
  {
    name: "invalid JSON",
    result: { status: 0, signal: null, stdout: "not-json", stderr: "" },
    expected: { exitCode: 0, timedOut: false, parseFailure: "invalid_docker_inspect_json" },
  },
]) {
  test(`preserves ${scenario.name} before rejecting the query`, () => {
    const root = evidenceRoot();
    try {
      assert.throws(
        () =>
          captureDockerInspectForPortValidation({
            configPath: "/workspace/supabase/config.toml",
            cwd: "/workspace",
            evidencePrefix: "upgrade-113-116",
            evidenceRoot: root,
            expectedHostPort: 60421,
            internalPort: "8000/tcp",
            name: "supabase_kong_qmgkmsarzfjnqltljkjl",
            runner: () => scenario.result,
            targetKind: "api",
            timeout: 180_000,
          }),
        DockerInspectQueryError,
      );
      const [file] = readdirSync(join(root, "port-bindings"));
      const evidence = JSON.parse(readFileSync(join(root, "port-bindings", file), "utf8"));
      assert.deepEqual(
        {
          exitCode: evidence.query.exitCode,
          timedOut: evidence.query.timedOut,
          parseFailure: evidence.query.parseFailure,
        },
        scenario.expected,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
