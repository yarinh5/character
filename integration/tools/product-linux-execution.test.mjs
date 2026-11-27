import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PRODUCT_HTTP_FILES,
  runProductHttp,
} from "../../supabase/tests/http/paid-sticker-window.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const artifact = join(here, "product-linux-execution.sh");
const executionPackage = join(here, "..", "EXECUTION-PACKAGE.md");
const bash =
  process.env.GIT_BASH ??
  (process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash");
const environmentContract = Object.freeze({
  context: "product-linux-unix-a6e50de2",
  endpoint: "unix:///run/docker.sock",
  expectedEngineId: "a6e50de2-c013-4dd4-b12e-c966081e1f40",
  forbiddenEngineId: "e4a8242c-6ed6-4be2-91d0-64ea7a7a1cfb",
  projectId: "qmgkmsarzfjnqltljkjl",
  portRangeStart: "60420",
  portRangeEnd: "60430",
});

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function write(path, value, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
  if (mode) chmodSync(path, mode);
}

function bashRun(args, options = {}) {
  return spawnSync(bash, ["--noprofile", "--norc", ...args], {
    encoding: "utf8",
    timeout: 30_000,
    ...options,
  });
}

function getExecutionPackageShellBlock(name) {
  const source = readFileSync(executionPackage, "utf8");
  const start = `# ${name}:start`;
  const end = `# ${name}:end`;
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end);
  assert.notEqual(startIndex, -1, `missing ${start} marker`);
  assert.notEqual(endIndex, -1, `missing ${end} marker`);
  assert.ok(endIndex > startIndex, `${name} markers are out of order`);
  return source.slice(startIndex + start.length, endIndex).trim();
}

function toPosix(path) {
  if (process.platform !== "win32") return path;
  const result = bashRun(["-c", 'cygpath -u "$1"', "--", path]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function currentIdentity() {
  const uid = bashRun(["-c", "id -u"]);
  const gid = bashRun(["-c", "id -g"]);
  assert.equal(uid.status, 0, uid.stderr);
  assert.equal(gid.status, 0, gid.stderr);
  return { uid: uid.stdout.trim(), gid: gid.stdout.trim() };
}

function makeFixture({
  deltaCount = 48,
  expectedDeltaCount = 48,
  preexistingDenoLock = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "product-execution-artifact-"));
  const source = join(root, "source with spaces");
  const repository = join(source, "repository");
  const manifests = join(source, "evidence", "manifests");
  const verification = join(root, "verification with spaces");
  const evidence = join(root, "evidence with spaces");
  const fakeBin = join(root, "fake bin");
  const downloads = join(root, "download fixtures");
  const actionLog = join(root, "actions.log");
  const installRoot = join(root, "approved-install", "supabase-2.95.4");
  const installTarget = join(installRoot, "supabase");
  const dockerConfig = join(root, "docker config");
  const bashEnv = join(root, "offline-process-boundaries.sh");
  const runId = "offline-case";
  const runRepository = join(verification, runId, "repository");
  const backupTarget = join(
    evidence,
    runId,
    "pre-mutation-bytes",
    "supabase",
    ".temp",
    "cli-latest",
  );
  mkdirSync(verification, { recursive: true });
  mkdirSync(evidence, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(downloads, { recursive: true });
  write(
    join(dockerConfig, "config.json"),
    JSON.stringify({
      currentContext: "desktop-linux",
      contexts: { "desktop-linux": "npipe://./pipe/dockerDesktopLinuxEngine" },
    }) + "\n",
  );

  write(join(repository, "integration", "EXECUTION-PACKAGE.md"), "fixture execution package\n");
  write(
    join(repository, "integration", "tools", "product-service-log-collector.mjs"),
    "// collector\n",
  );
  write(
    join(repository, "integration", "tools", "product-service-log-collector.test.mjs"),
    "// collector test\n",
  );
  cpSync(artifact, join(repository, "integration", "tools", "product-linux-execution.sh"));
  write(
    join(
      repository,
      "integration",
      "candidate-migrations",
      "product_completion_read_access_gate.sql",
    ),
    "select 1;\n",
  );
  write(join(repository, "supabase", ".temp", "cli-latest"), "2.95.4\n");
  write(join(repository, "supabase", "config.toml"), "project_id = 'fixture'\n");
  write(join(repository, "package-lock.json"), "{}\n");
  if (preexistingDenoLock) write(join(repository, "deno.lock"), "pre-existing lock\n");

  const repoFiles = [
    "integration/EXECUTION-PACKAGE.md",
    "integration/candidate-migrations/product_completion_read_access_gate.sql",
    "integration/tools/product-linux-execution.sh",
    "integration/tools/product-service-log-collector.mjs",
    "integration/tools/product-service-log-collector.test.mjs",
    "package-lock.json",
    "supabase/.temp/cli-latest",
    "supabase/config.toml",
  ];
  if (preexistingDenoLock) repoFiles.push("deno.lock");
  repoFiles.sort();
  write(
    join(manifests, "integration-target-full.sha256"),
    repoFiles.map((path) => `${sha256(join(repository, ...path.split("/")))}  ${path}`).join("\n") +
      "\n",
  );
  write(join(manifests, "product-source-files.json"), "[]\n");
  write(join(manifests, "integration-target-full-files.json"), "[]\n");
  write(
    join(manifests, "integration-target-delta.json"),
    JSON.stringify({
      files: Array.from({ length: deltaCount }, (_, index) => ({ path: `p${index}` })),
    }),
  );
  write(join(manifests, "snapshot-metadata.json"), "{}\n");

  const build = join(downloads, "build");
  write(
    join(build, "supabase"),
    `#!/usr/bin/env bash
set -o nounset
printf 'supabase:%s:%s\\n' "\${DOCKER_CONTEXT-}" "$*" >>"$ACTION_LOG"
case "\${1-}" in
  --version)
    test "$TEST_SCENARIO" = 'cli-version-fail' && exit 76
    printf '2.95.4\\n'
    printf 'runtime-cli-state\\n' >supabase/.temp/cli-latest
    ;;
  migration)
    test "\${2-}" = new
    test -n "\${3-}"
    mkdir -p supabase/migrations
    printf '%s\\n' '-- fixture migration' >"supabase/migrations/20261108202205_\${3}.sql"
    ;;
  *) exit 90 ;;
esac
`,
    0o755,
  );
  const archive = join(downloads, "supabase_linux_amd64.tar.gz");
  const tar = bashRun([
    "-c",
    'tar -czf "$1" -C "$2" supabase',
    "--",
    toPosix(archive),
    toPosix(build),
  ]);
  assert.equal(tar.status, 0, tar.stderr);
  const badArchive = join(downloads, "bad.tar.gz");
  write(badArchive, "not the approved archive\n");
  const checksums = join(downloads, "supabase_2.95.4_checksums.txt");
  write(checksums, `${sha256(archive)}  supabase_linux_amd64.tar.gz\n`);

  write(
    join(fakeBin, "curl"),
    `#!/usr/bin/env bash
set -o nounset
out=''
url=''
while test "$#" -gt 0; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  *supabase_linux_amd64.tar.gz)
    printf 'curl:archive\\n' >>"$ACTION_LOG"
    { test "$TEST_SCENARIO" = curl22 || test "$TEST_SCENARIO" = prepare-existing-valid-curl22; } && exit 22
    test "$TEST_SCENARIO" = archive-missing && exit 0
    if test "$TEST_SCENARIO" = checksum-bad; then cp "$FIXTURE_BAD_ARCHIVE" "$out"; else cp "$FIXTURE_ARCHIVE" "$out"; fi
    ;;
  *checksums.txt)
    printf 'curl:checksums\\n' >>"$ACTION_LOG"
    cp "$FIXTURE_CHECKSUMS" "$out"
    ;;
  *) exit 90 ;;
esac
`,
    0o755,
  );
  write(
    join(fakeBin, "deno"),
    "#!/usr/bin/env bash\nprintf 'deno 2.1.4 (stable, release, x86_64-unknown-linux-gnu)\\nv8 fixture\\ntypescript fixture\\n'\n",
    0o755,
  );
  write(join(fakeBin, "getfacl"), "#!/usr/bin/env bash\nexit 0\n", 0o755);
  write(join(fakeBin, "unzip"), "#!/usr/bin/env bash\nexit 0\n", 0o755);
  write(
    join(fakeBin, "npm"),
    `#!/usr/bin/env bash
set -o nounset
case "\${1-}" in
  --version) printf '10.9.2\\n' ;;
  ci)
    printf 'npm:%s\\n' "$*" >>"$ACTION_LOG"
    mkdir -p node_modules
    printf 'installed\\n' >node_modules/.fixture
    printf 'runtime-cli-state\\n' >supabase/.temp/cli-latest
    test "$TEST_SCENARIO" = runtime-immutable-drift && printf 'drift\\n' >supabase/config.toml
    if test "$TEST_SCENARIO" = runtime-untracked-temp; then
      mkdir -p supabase/.temp
      printf 'rogue\\n' >supabase/.temp/untracked
    fi
    test "$TEST_SCENARIO" = runtime-unexpected-path && printf 'rogue\\n' >unexpected.txt
    exit 0
    ;;
  rebuild)
    printf 'npm:%s\\n' "$*" >>"$ACTION_LOG"
    exit 0
    ;;
  *) exit 91 ;;
esac
`,
    0o755,
  );
  write(
    join(fakeBin, "install"),
    `#!/usr/bin/env bash
set -o errexit -o nounset
directory=false
while test "$#" -gt 0; do
  case "$1" in
    -d) directory=true; shift ;;
    -m|-o|-g) shift 2 ;;
    *) break ;;
  esac
done
if "$directory"; then
  /usr/bin/mkdir -p -- "$@"
  exit 0
fi
test "$#" -eq 2
source_path="$1"
target_path="$2"
if test -d "$target_path"; then
  target_path="$target_path/$(basename "$source_path")"
else
  /usr/bin/mkdir -p -- "$(dirname "$target_path")"
fi
if test "$target_path" = "$INSTALL_TARGET"; then printf 'install:binary\\n' >>"$ACTION_LOG"; fi
/usr/bin/cp -- "$source_path" "$target_path"
`,
    0o755,
  );
  write(
    join(fakeBin, "id"),
    `#!/usr/bin/env bash
case "$TEST_SCENARIO" in
  install-*) test "\${1-}" = '-u' && { printf '0\\n'; exit 0; } ;;
esac
exec /usr/bin/id "$@"
`,
    0o755,
  );
  write(
    join(fakeBin, "stat"),
    `#!/usr/bin/env bash
if test "$#" -eq 3 && test "$1" = '-c' && { test "$3" = "$INSTALL_ROOT_POSIX" || test "$3" = "$INSTALL_TARGET"; }; then
  case "$2" in
    '%u:%g')
      { test "$TEST_SCENARIO" = 'install-existing-wrong-owner' || test "$TEST_SCENARIO" = 'prepare-existing-wrong-owner'; } && printf '1001:1001\\n' || printf '0:0\\n'
      exit 0
      ;;
    '%a')
      { test "$TEST_SCENARIO" = 'install-existing-wrong-mode' || test "$TEST_SCENARIO" = 'prepare-existing-wrong-mode'; } && printf '775\\n' || printf '755\\n'
      exit 0
      ;;
  esac
fi
exec /usr/bin/stat "$@"
`,
    0o755,
  );
  write(
    join(fakeBin, "sha256sum"),
    `#!/usr/bin/env bash
if test "$#" -eq 1 && test "$1" = "$INSTALL_TARGET"; then
  if test "$TEST_SCENARIO" = 'install-existing-wrong-hash' || test "$TEST_SCENARIO" = 'prepare-existing-wrong-hash'; then
    printf '%064d  %s\\n' 0 "$1"
  else
    printf '%s  %s\\n' '0b47b526a2d93a9e3f29a82b2f4ac556fa983a8c67e89c2862ade94fd6220f09' "$1"
  fi
  exit 0
fi
exec /usr/bin/sha256sum "$@"
`,
    0o755,
  );
  write(join(fakeBin, "chown"), "#!/usr/bin/env bash\nexit 0\n", 0o755);
  write(
    join(fakeBin, "docker"),
    `#!/usr/bin/env bash
set -o nounset
printf 'docker:%s\\n' "$*" >>"$ACTION_LOG"
case "\${1-}:\${2-}" in
  context:inspect)
    test "\${DOCKER_CONTEXT-}" = '${environmentContract.context}' || exit 34
    test "$TEST_SCENARIO" = environment-context-fail && exit 31
    case "\${5-}" in
      '{{json .Endpoints.docker.Host}}') printf '"${environmentContract.endpoint}"\\n' ;;
      '{{.Endpoints.docker.Host}}')
        test "$TEST_SCENARIO" = environment-endpoint-mismatch && printf 'tcp://127.0.0.1:29999\\n' || printf '${environmentContract.endpoint}\\n'
        ;;
      *) exit 35 ;;
    esac
    ;;
  info:--format)
    test "$TEST_SCENARIO" = environment-engine-command-fail && exit 32
    test "$TEST_SCENARIO" = environment-engine-mismatch && { printf 'different-engine\\n'; exit 0; }
    test "$TEST_SCENARIO" = environment-forbidden-engine && { printf '${environmentContract.forbiddenEngineId}\\n'; exit 0; }
    printf '${environmentContract.expectedEngineId}\\n'
    ;;
  version:--format) printf 'fixture-client/fixture-server\\n' ;;
  ps:-a)
    test "$TEST_SCENARIO" = environment-inventory-fail && exit 33
    test "$TEST_SCENARIO" = environment-container-residue && printf 'container-id|supabase_db_${environmentContract.projectId}|fixture|running\\n'
    exit 0
    ;;
  volume:ls)
    test "$TEST_SCENARIO" = environment-volume-residue && printf 'supabase_db_${environmentContract.projectId}\\n'
    exit 0
    ;;
  network:ls)
    test "$TEST_SCENARIO" = environment-network-residue && printf 'network-id|supabase_network_${environmentContract.projectId}|bridge\\n'
    exit 0
    ;;
  *) exit 36 ;;
esac
`,
    0o755,
  );
  write(
    join(fakeBin, "sleep"),
    '#!/usr/bin/env bash\nprintf \'sleep:%s\\n\' "$*" >>"$ACTION_LOG"\nexit 0\n',
    0o755,
  );
  write(
    join(fakeBin, "ss"),
    `#!/usr/bin/env bash
printf 'ss:%s\\n' "$*" >>"$ACTION_LOG"
test "$TEST_SCENARIO" = environment-ss-fail && exit 37
printf 'State Recv-Q Send-Q Local Address:Port Peer Address:Port\\n'
test "$TEST_SCENARIO" = environment-listener-residue && printf 'LISTEN 0 4096 127.0.0.1:60425 0.0.0.0:*\\n'
exit 0
`,
    0o755,
  );
  write(
    bashEnv,
    `sync() {
  if test "$TEST_SCENARIO" = outer-primary-sync-fail; then
    return 1
  fi
  ${process.platform === "win32" ? 'test -f "$1"' : '/usr/bin/sync "$@"'}
}
id() {
  case "$TEST_SCENARIO" in
    install-*) test "\${1-}" = '-u' && { printf '0\\n'; return 0; } ;;
  esac
  /usr/bin/id "$@"
}
stat() {
  if test "$#" -eq 3 && test "$1" = '-c' && { test "$3" = "$INSTALL_ROOT_POSIX" || test "$3" = "$INSTALL_TARGET"; }; then
    case "$2" in
      '%u:%g') { test "$TEST_SCENARIO" = 'install-existing-wrong-owner' || test "$TEST_SCENARIO" = 'prepare-existing-wrong-owner'; } && printf '1001:1001\\n' || printf '0:0\\n'; return 0 ;;
      '%a') { test "$TEST_SCENARIO" = 'install-existing-wrong-mode' || test "$TEST_SCENARIO" = 'prepare-existing-wrong-mode'; } && printf '775\\n' || printf '755\\n'; return 0 ;;
    esac
  fi
  /usr/bin/stat "$@"
}
sha256sum() {
  if test "$#" -eq 1 && test "$1" = "$INSTALL_TARGET"; then
    if test "$TEST_SCENARIO" = 'install-existing-wrong-hash' || test "$TEST_SCENARIO" = 'prepare-existing-wrong-hash'; then
      printf '%064d  %s\\n' 0 "$1"
    else
      printf '%s  %s\\n' '0b47b526a2d93a9e3f29a82b2f4ac556fa983a8c67e89c2862ade94fd6220f09' "$1"
    fi
    return 0
  fi
  /usr/bin/sha256sum "$@"
}
cp() {
  if builtin test "$TEST_SCENARIO" = 'restore-cli-fail' &&
     builtin test "\${1-}" = '--preserve=mode,timestamps' &&
     builtin test "\${2-}" = '--' &&
     builtin test "\${3-}" = "$BACKUP_TARGET"; then
    return 17
  fi
  /usr/bin/cp "$@"
}
chown() { return 0; }
test() {
  case "$TEST_SCENARIO" in
    install-wrong-bound-root) ;;
    install-*|prepare-existing-*)
      if builtin test "$#" -eq 3 && builtin test "$1" = "$INSTALL_ROOT_POSIX" &&
         builtin test "$2" = '=' && builtin test "$3" = '/opt/codex-product/supabase-2.95.4'; then
        return 0
      fi
      ;;
  esac
  if builtin test "$TEST_SCENARIO" = 'install-existing-linked-binary' &&
     builtin test "$#" -eq 3 && builtin test "$1" = '!' && builtin test "$2" = '-L' && builtin test "$3" = "$INSTALL_TARGET"; then
    return 1
  fi
  if builtin test "$TEST_SCENARIO" = 'prepare-existing-linked-binary' &&
     builtin test "$#" -eq 3 && builtin test "$1" = '!' && builtin test "$2" = '-L' && builtin test "$3" = "$INSTALL_TARGET"; then
    return 1
  fi
  if builtin test "$TEST_SCENARIO" = 'runtime-backup-linked' &&
     builtin test "$#" -eq 3 && builtin test "$1" = '!' && builtin test "$2" = '-L' && builtin test "$3" = "$BACKUP_TARGET"; then
    return 1
  fi
  if builtin test "$TEST_SCENARIO" = 'deno-lock-linked' &&
     builtin test "$#" -eq 3 && builtin test "$1" = '!' && builtin test "$2" = '-L' && builtin test "$3" = "$DENO_LOCK_TARGET"; then
    return 1
  fi
  if builtin test "$TEST_SCENARIO" = 'deno-lock-linked' &&
     builtin test "$#" -eq 2 && builtin test "$1" = '-L' && builtin test "$2" = "$DENO_LOCK_TARGET"; then
    return 0
  fi
  builtin test "$@"
}
`,
    0o600,
  );
  write(
    join(fakeBin, "rm"),
    `#!/usr/bin/env bash
printf 'rm:%s\\n' "$*" >>"$ACTION_LOG"
test "$TEST_SCENARIO" = cleanup-fail && exit 9
exec /usr/bin/rm "$@"
`,
    0o755,
  );

  const hashes = {
    execution: sha256(join(repository, "integration", "EXECUTION-PACKAGE.md")),
    productSource: sha256(join(manifests, "product-source-files.json")),
    full: sha256(join(manifests, "integration-target-full-files.json")),
    delta: sha256(join(manifests, "integration-target-delta.json")),
    checksum: sha256(join(manifests, "integration-target-full.sha256")),
    metadata: sha256(join(manifests, "snapshot-metadata.json")),
    collector: sha256(
      join(repository, "integration", "tools", "product-service-log-collector.mjs"),
    ),
    collectorTest: sha256(
      join(repository, "integration", "tools", "product-service-log-collector.test.mjs"),
    ),
    archive: sha256(archive),
    checksums: sha256(checksums),
  };
  const { uid, gid } = currentIdentity();
  const posix = {
    source: toPosix(source),
    verification: toPosix(verification),
    evidence: toPosix(evidence),
    fakeBin: toPosix(fakeBin),
    actionLog: toPosix(actionLog),
    archive: toPosix(archive),
    badArchive: toPosix(badArchive),
    checksums: toPosix(checksums),
    installRoot: toPosix(installRoot),
    installTarget: toPosix(installTarget),
  };
  const bashPath = bashRun(["-c", "printf '%s' \"$PATH\""]).stdout;
  const common = [
    "--run-id",
    runId,
    "--source-root",
    posix.source,
    "--verification-base",
    posix.verification,
    "--evidence-base",
    posix.evidence,
    "--approved-uid",
    uid,
    "--approved-gid",
    gid,
    "--install-root",
    posix.installRoot,
    "--expected-source-files",
    String(repoFiles.length),
    "--expected-delta-files",
    String(expectedDeltaCount),
    "--execution-package-sha",
    hashes.execution,
    "--product-source-manifest-sha",
    hashes.productSource,
    "--full-manifest-sha",
    hashes.full,
    "--delta-manifest-sha",
    hashes.delta,
    "--checksum-manifest-sha",
    hashes.checksum,
    "--metadata-sha",
    hashes.metadata,
    "--collector-sha",
    hashes.collector,
    "--collector-test-sha",
    hashes.collectorTest,
    "--cli-archive-url",
    "https://fixture.invalid/supabase_linux_amd64.tar.gz",
    "--cli-checksums-url",
    "https://fixture.invalid/supabase_2.95.4_checksums.txt",
    "--cli-archive-sha",
    hashes.archive,
    "--cli-checksums-sha",
    hashes.checksums,
    "--curl-command",
    `${posix.fakeBin}/curl`,
    "--install-command",
    `${posix.fakeBin}/install`,
    "--rm-command",
    `${posix.fakeBin}/rm`,
  ];
  const environmentArgs = [
    "--docker-context",
    environmentContract.context,
    "--docker-endpoint",
    environmentContract.endpoint,
    "--expected-engine-id",
    environmentContract.expectedEngineId,
    "--forbidden-engine-id",
    environmentContract.forbiddenEngineId,
    "--project-id",
    environmentContract.projectId,
    "--port-range-start",
    environmentContract.portRangeStart,
    "--port-range-end",
    environmentContract.portRangeEnd,
    "--sleep-command",
    `${posix.fakeBin}/sleep`,
  ];
  common.push(...environmentArgs);
  const env = { ...process.env };
  delete env.Path;
  Object.assign(env, {
    PATH: `${posix.fakeBin}:${bashPath}`,
    ACTION_LOG: posix.actionLog,
    FIXTURE_ARCHIVE: posix.archive,
    FIXTURE_BAD_ARCHIVE: posix.badArchive,
    FIXTURE_CHECKSUMS: posix.checksums,
    INSTALL_ROOT_POSIX: posix.installRoot,
    INSTALL_TARGET: posix.installTarget,
    BACKUP_TARGET: toPosix(backupTarget),
    DENO_LOCK_TARGET: "deno.lock",
    DOCKER_CONFIG: toPosix(dockerConfig),
    BASH_ENV: toPosix(bashEnv),
  });
  return {
    root,
    source,
    repository,
    runRepository,
    verification,
    evidence,
    runId,
    common,
    environmentArgs,
    env,
    actionLog,
    installRoot,
    installTarget,
    backupTarget,
    dockerConfig,
  };
}

function execute(fixture, phase, scenario, environmentOverrides = {}, extraArguments = []) {
  const env = { ...fixture.env, TEST_SCENARIO: scenario };
  for (const [name, value] of Object.entries(environmentOverrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return bashRun([artifact, phase, ...fixture.common, ...extraArguments], { env });
}

function actions(fixture) {
  return existsSync(fixture.actionLog)
    ? readFileSync(fixture.actionLog, "utf8").trim().split(/\r?\n/)
    : [];
}

function prepareEnvironmentGateFixture(fixture) {
  const prepare = execute(fixture, "prepare-user", "success");
  assert.equal(prepare.status, 0, prepare.stderr);
  const install = execute(fixture, "install-cli-root", "install-missing");
  assert.equal(install.status, 0, install.stderr);
  const continuation = execute(fixture, "continue-user", "success");
  assert.equal(continuation.status, 0, continuation.stderr);
}

function executeEnvironmentGate(fixture, scenario, environmentOverrides = {}) {
  return execute(fixture, "environment-user", scenario, environmentOverrides);
}

test("the fixed environment phase accepts missing Docker overrides", () => {
  const fixture = makeFixture();
  try {
    prepareEnvironmentGateFixture(fixture);
    const result = executeEnvironmentGate(fixture, "success", {
      DOCKER_HOST: undefined,
      DOCKER_TLS_VERIFY: undefined,
      DOCKER_CERT_PATH: undefined,
    });
    assert.equal(
      result.status,
      0,
      JSON.stringify({
        stderr: result.stderr,
        signal: result.signal,
        error: result.error?.message,
        actions: actions(fixture),
      }),
    );
    assert.match(result.stdout, /environment-user PASS/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the fixed environment phase accepts empty Docker overrides", () => {
  const fixture = makeFixture();
  try {
    prepareEnvironmentGateFixture(fixture);
    const result = executeEnvironmentGate(fixture, "success", {
      DOCKER_HOST: "",
      DOCKER_TLS_VERIFY: "",
      DOCKER_CERT_PATH: "",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /environment-user PASS/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the fixed environment phase rejects a conflicting external Docker context", () => {
  const fixture = makeFixture();
  try {
    prepareEnvironmentGateFixture(fixture);
    const secret = 'other-$HOME "context" \\ with spaces';
    const result = executeEnvironmentGate(fixture, "success", {
      DOCKER_HOST: "",
      DOCKER_TLS_VERIFY: "",
      DOCKER_CERT_PATH: "",
      DOCKER_CONTEXT: secret,
    });
    assert.equal(result.status, 42);
    assert.match(
      result.stderr,
      /docker\.override: DOCKER_CONTEXT conflicts with approved context \(exit 42\)/,
    );
    assert.equal(
      actions(fixture).some((entry) => entry.startsWith("docker:")),
      false,
    );
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const variable of ["DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) {
  test(`the fixed environment phase rejects non-empty ${variable} without clearing it`, () => {
    const fixture = makeFixture();
    try {
      prepareEnvironmentGateFixture(fixture);
      const secret = 'literal $HOME "quote" \\ backslash and spaces';
      const result = executeEnvironmentGate(fixture, "success", {
        DOCKER_HOST: "",
        DOCKER_TLS_VERIFY: "",
        DOCKER_CERT_PATH: "",
        [variable]: secret,
      });
      assert.equal(result.status, 42);
      assert.match(result.stderr, /docker\.override: .* is non-empty \(exit 42\)/);
      assert.equal(
        actions(fixture).some((entry) => entry.startsWith("docker:")),
        false,
      );
      assert.equal(result.stdout.includes(secret), false);
      assert.equal(result.stderr.includes(secret), false);
      const primary = readFileSync(
        join(fixture.evidence, fixture.runId, "primary-failure.tsv"),
        "utf8",
      );
      assert.match(primary, /^docker\.override\t42\t/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("the fixed environment phase performs the complete context engine stability and inventory gate", () => {
  const fixture = makeFixture();
  try {
    prepareEnvironmentGateFixture(fixture);
    const result = executeEnvironmentGate(fixture, "success", {
      DOCKER_HOST: undefined,
      DOCKER_TLS_VERIFY: undefined,
      DOCKER_CERT_PATH: undefined,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /environment-user PASS/);
    const observed = actions(fixture);
    assert.equal(observed.filter((entry) => entry.startsWith("docker:context inspect ")).length, 2);
    assert.equal(observed.filter((entry) => entry.startsWith("docker:info ")).length, 3);
    assert.equal(observed.filter((entry) => entry === "sleep:15").length, 2);
    assert.equal(observed.filter((entry) => entry.startsWith("docker:version ")).length, 1);
    assert.equal(observed.filter((entry) => entry.startsWith("docker:ps ")).length, 1);
    assert.equal(observed.filter((entry) => entry.startsWith("docker:volume ls ")).length, 1);
    assert.equal(observed.filter((entry) => entry.startsWith("docker:network ls ")).length, 1);
    assert.equal(observed.filter((entry) => entry === "ss:-ltn").length, 1);
    const runEvidence = join(fixture.evidence, fixture.runId);
    assert.equal(
      readFileSync(join(runEvidence, "engine-stability.txt"), "utf8").trim().split(/\r?\n/).length,
      3,
    );
    for (const name of [
      "docker-endpoint.json",
      "docker-versions.txt",
      "containers-before.txt",
      "volumes-before.txt",
      "networks-before.txt",
      "listeners-before.txt",
    ])
      assert.equal(existsSync(join(runEvidence, name)), true, name);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const failure of [
  {
    scenario: "environment-context-fail",
    status: 31,
    gate: "environment.context",
    forbiddenAction: "docker:info ",
  },
  {
    scenario: "environment-endpoint-mismatch",
    status: 1,
    gate: "environment.endpoint",
    forbiddenAction: "docker:info ",
  },
  {
    scenario: "environment-engine-command-fail",
    status: 32,
    gate: "environment.engine",
    forbiddenAction: "docker:version ",
  },
  {
    scenario: "environment-engine-mismatch",
    status: 1,
    gate: "environment.engine-id",
    forbiddenAction: "docker:version ",
  },
  {
    scenario: "environment-forbidden-engine",
    status: 1,
    gate: "environment.engine-id",
    forbiddenAction: "docker:version ",
  },
  {
    scenario: "environment-inventory-fail",
    status: 33,
    gate: "environment.inventory-containers",
    forbiddenAction: "docker:volume ls ",
  },
  {
    scenario: "environment-container-residue",
    status: 1,
    gate: "environment.residue",
    forbiddenAction: "canary:",
  },
  {
    scenario: "environment-listener-residue",
    status: 1,
    gate: "environment.residue",
    forbiddenAction: "canary:",
  },
]) {
  test(`the fixed environment phase stops ${failure.scenario} before dependent work`, () => {
    const fixture = makeFixture();
    try {
      prepareEnvironmentGateFixture(fixture);
      const result = executeEnvironmentGate(fixture, failure.scenario, {
        DOCKER_HOST: "",
        DOCKER_TLS_VERIFY: "",
        DOCKER_CERT_PATH: "",
      });
      assert.equal(result.status, failure.status, result.stderr);
      assert.doesNotMatch(result.stdout, /environment-user PASS/);
      const primary = readFileSync(
        join(fixture.evidence, fixture.runId, "primary-failure.tsv"),
        "utf8",
      );
      assert.match(
        primary,
        new RegExp(`^${failure.gate.replaceAll(".", "\\.")}\\t${failure.status}\\t`),
      );
      assert.equal(
        actions(fixture).some((entry) => entry.startsWith(failure.forbiddenAction)),
        false,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("successful finalization preserves an environment gate primary failure", () => {
  const fixture = makeFixture();
  try {
    prepareEnvironmentGateFixture(fixture);
    const gate = executeEnvironmentGate(fixture, "environment-engine-command-fail", {
      DOCKER_HOST: "",
      DOCKER_TLS_VERIFY: "",
      DOCKER_CERT_PATH: "",
    });
    assert.equal(gate.status, 32, gate.stderr);
    const finalize = execute(fixture, "finalize-user", "success");
    assert.equal(finalize.status, 32, finalize.stderr);
    assert.equal(
      readFileSync(join(fixture.evidence, fixture.runId, "finalize.result.txt"), "utf8"),
      "primary=32 cleanup=0\n",
    );
    assert.equal(existsSync(join(fixture.verification, fixture.runId)), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function documentedDenoVersionGate() {
  const document = readFileSync(executionPackage, "utf8");
  const match = document.match(
    /<!-- product-deno-version-gate:start -->\s*```bash\s*([\s\S]*?)\s*```\s*<!-- product-deno-version-gate:end -->/,
  );
  assert.ok(match, "documented Deno version gate must be present between the stable markers");
  return match[1];
}

function executionPackageText() {
  return readFileSync(executionPackage, "utf8");
}

function markedBashBlock(marker) {
  const document = executionPackageText();
  const expression = new RegExp(
    `<!-- ${marker}:start -->\\s*\\x60\\x60\\x60bash\\s*([\\s\\S]*?)\\s*\\x60\\x60\\x60\\s*<!-- ${marker}:end -->`,
  );
  const match = document.match(expression);
  assert.ok(match, `documented ${marker} block must be present between stable markers`);
  return match[1];
}

function repositoryFiles(root, predicate) {
  const generatedRoots = new Set(["node_modules", "dist", "dist-ssr", ".wrangler", ".git"]);
  const result = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (directory === root && generatedRoots.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (predicate(path)) result.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
  visit(root);
  return result.sort();
}

function productVitestInventory() {
  const repository = resolve(here, "..", "..");
  const block = markedBashBlock("product-vitest-gate");
  const command = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("npm exec -- vitest run "));
  assert.ok(command, "Product Vitest command must be present in the marked block");
  const selectedRoots = command.slice("npm exec -- vitest run ".length).trim().split(/\s+/);
  const testFiles = repositoryFiles(repository, (path) =>
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path),
  );
  const selected = testFiles.filter((path) =>
    selectedRoots.some((root) => path === root || path.startsWith(`${root}/`)),
  );
  return { command, selected, testFiles };
}

function markedShellRegion(marker) {
  const document = executionPackageText();
  const expression = new RegExp(`# ${marker}:start\\r?\\n([\\s\\S]*?)\\r?\\n# ${marker}:end`);
  const match = document.match(expression);
  assert.ok(match, `documented ${marker} shell region must be present between stable markers`);
  return match[1];
}

function documentedCollectorOwnershipScript(marker) {
  const block = markedShellRegion(marker);
  const match = block.match(/node --input-type=module -e '([\s\S]*?)'\s+"\$PRODUCT_COLLECTOR_PID"/);
  assert.ok(match, `documented ${marker} block must invoke the inline ownership check`);
  return match[1];
}

function runCollectorOwnershipScript(
  marker,
  { pid = "4242", ppid = "3131", runId = "run-owned", argv },
) {
  const root = mkdtempSync(join(tmpdir(), "product collector ownership "));
  try {
    write(join(root, pid, "status"), `Name:\tnode\nPPid:\t${ppid}\n`);
    write(join(root, pid, "cmdline"), Buffer.from(argv.join("\0") + "\0"));
    return spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        documentedCollectorOwnershipScript(marker),
        pid,
        ppid,
        runId,
        root,
      ],
      { encoding: "utf8" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runCollectorShellBlock(
  marker,
  {
    pidFile = "4242",
    parentMode = "valid",
    argv = [
      "/usr/bin/node",
      "integration/tools/product-service-log-collector.mjs",
      "--run-id",
      "run-owned",
    ],
    primary = "",
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "product collector shell guard "));
  const evidence = join(root, "evidence");
  const procRoot = join(root, "proc");
  const fakeBin = join(root, "fake bin");
  const actionLog = join(root, "actions.log");
  const nodeResultLog = join(root, "node-result.log");
  const primaryFailure = join(evidence, "primary-failure.tsv");
  const secondaryFailures = join(evidence, "secondary-failures.tsv");
  const gateLedger = join(evidence, "gates.tsv");
  const pid = "4242";
  try {
    mkdirSync(join(evidence, "service-log-collector"), { recursive: true });
    write(join(evidence, "service-log-collector.pid"), `${pidFile}\n`);
    write(join(evidence, "service-log-collector", "collector-ready.json"), "{}\n");
    write(join(procRoot, pid, "cmdline"), Buffer.from(argv.join("\0") + "\0"));
    write(primaryFailure, primary);
    write(secondaryFailures, "");
    write(gateLedger, "");
    write(
      join(fakeBin, "node"),
      [
        "#!/usr/bin/env bash",
        "printf 'node\\n' >>\"$ACTION_LOG\"",
        'if test "$FAKE_PARENT_MODE" = valid; then owner_ppid="$FAKE_EXPECTED_PPID"; else owner_ppid=999999; fi',
        'printf \'Name:\\tnode\\nPPid:\\t%s\\n\' "$owner_ppid" >"$FAKE_PROC_ROOT/4242/status"',
        'args=("$@")',
        'args[$((${#args[@]} - 1))]="$(cygpath -w "$FAKE_PROC_ROOT")"',
        '"$REAL_NODE" "${args[@]}"',
        "node_rc=$?",
        'printf \'%s\\n\' "$node_rc" >"$NODE_RESULT_LOG"',
        'exit "$node_rc"',
        "",
      ].join("\n"),
      0o755,
    );
    const inheritedPath = bashRun(["-c", "printf '%s' \"$PATH\""]).stdout;
    const script = `
set +e
export FAKE_EXPECTED_PPID="$$"
kill() {
  printf 'kill:%s\\n' "$*" >>"$ACTION_LOG"
  return 0
}
wait() {
  printf 'wait:%s\\n' "$*" >>"$ACTION_LOG"
  return 0
}
${markedShellRegion(marker)}
if test "\${PRODUCT_SERVICE_LANE_ALLOWED:-0}" = '1'; then
  printf 'service:start\\n' >>"$ACTION_LOG"
fi
printf 'allowed=%s\\n' "\${PRODUCT_SERVICE_LANE_ALLOWED:-unset}"
`;
    const result = bashRun(["-c", script], {
      env: {
        ...process.env,
        PATH: `${toPosix(fakeBin)}:${inheritedPath}`,
        ACTION_LOG: toPosix(actionLog),
        APPROVED_UID: "1001",
        APPROVED_GID: "1001",
        FAKE_PARENT_MODE: parentMode,
        FAKE_PROC_ROOT: toPosix(procRoot),
        GATE_LEDGER: toPosix(gateLedger),
        NODE_RESULT_LOG: toPosix(nodeResultLog),
        PRIMARY_FAILURE: toPosix(primaryFailure),
        PRODUCT_COLLECTOR_PID: pid,
        REAL_NODE: toPosix(process.execPath),
        RUN_EVIDENCE: toPosix(evidence),
        RUN_ID: "run-owned",
        SECONDARY_FAILURES: toPosix(secondaryFailures),
      },
    });
    return {
      result,
      actions: existsSync(actionLog)
        ? readFileSync(actionLog, "utf8").trim().split(/\r?\n/).filter(Boolean)
        : [],
      primary: readFileSync(primaryFailure, "utf8"),
      secondary: readFileSync(secondaryFailures, "utf8"),
      ledger: readFileSync(gateLedger, "utf8"),
      nodeResult: existsSync(nodeResultLog)
        ? readFileSync(nodeResultLog, "utf8").trim()
        : "not-run",
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runDocumentedDenoVersionGate({ stdout, exitCode }) {
  const root = mkdtempSync(join(tmpdir(), "product deno version gate "));
  const fakeBin = join(root, "fake bin");
  const fakeDeno = join(fakeBin, "deno");
  try {
    write(
      fakeDeno,
      '#!/usr/bin/env bash\nprintf \'%s\' "$FAKE_DENO_STDOUT"\nexit "$FAKE_DENO_EXIT"\n',
      0o755,
    );
    const inheritedPath = bashRun(["-c", "printf '%s' \"$PATH\""]).stdout;
    return bashRun(["-c", documentedDenoVersionGate()], {
      env: {
        ...process.env,
        PATH: `${toPosix(fakeBin)}:${inheritedPath}`,
        FAKE_DENO_STDOUT: stdout,
        FAKE_DENO_EXIT: String(exitCode),
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the fixed artifact parses as a whole", () => {
  const result = bashRun(["-n", artifact]);
  assert.equal(result.status, 0, result.stderr);
});

test("the documented Deno gate accepts the observed build-suffixed 2.1.4 output", () => {
  const result = runDocumentedDenoVersionGate({
    stdout:
      "deno 2.1.4 (stable, release, x86_64-unknown-linux-gnu)\nv8 fixture\ntypescript fixture\n",
    exitCode: 0,
  });
  assert.equal(result.status, 0, result.stderr);
});

for (const stdout of [
  "deno 2.1.3 (stable, release, x86_64-unknown-linux-gnu)\n",
  "deno 2.1.40 (stable, release, x86_64-unknown-linux-gnu)\n",
  "",
  "not-deno 2.1.4\n",
]) {
  test(`the documented Deno gate rejects invalid stdout ${JSON.stringify(stdout)}`, () => {
    const result = runDocumentedDenoVersionGate({ stdout, exitCode: 0 });
    assert.notEqual(result.status, 0);
  });
}

test("the documented Deno gate rejects a nonzero process exit even with valid-looking stdout", () => {
  const result = runDocumentedDenoVersionGate({ stdout: "deno 2.1.4 (stable)\n", exitCode: 9 });
  assert.notEqual(result.status, 0);
});

test("the Product Vitest gate selects the complete Product inventory and excludes separate suites", () => {
  const { command, selected, testFiles } = productVitestInventory();
  assert.equal(command, "npm exec -- vitest run src");
  assert.ok(selected.includes("src/lib/slaMonitoring.test.ts"));
  assert.ok(selected.includes("src/components/ui/dialog.test.tsx"));
  assert.deepEqual(
    selected,
    testFiles.filter((path) => path.startsWith("src/")),
  );
  assert.ok(selected.includes("src/test/client-withdraw-like.test.tsx"));
  assert.ok(selected.includes("src/test/client-liked-entries.test.tsx"));
  assert.ok(selected.includes("src/test/admin-dashboard-aggregate.test.ts"));
  assert.ok(selected.includes("src/test/admin-mobile-navigation.test.tsx"));
  assert.ok(selected.includes("src/test/support-route-retry.test.tsx"));
  assert.ok(selected.includes("src/test/deletion-storage-verification.test.ts"));
  assert.ok(selected.includes("src/test/http-fixture-target.test.ts"));
  assert.equal(selected.length, 85);

  const http = testFiles.filter((path) => path.startsWith("supabase/tests/http/"));
  assert.deepEqual(http, PRODUCT_HTTP_FILES);
  assert.ok(http.every((path) => !selected.includes(path)));

  const repository = resolve(here, "..", "..");
  const nodeTest = repositoryFiles(repository, (path) => {
    if (!/\.[cm]?[jt]sx?$/.test(path)) return false;
    return readFileSync(path, "utf8").includes("node:test");
  });
  assert.deepEqual(nodeTest, [
    "integration/tools/product-linux-execution.test.mjs",
    "integration/tools/product-service-log-collector.test.mjs",
    "supabase/tests/concurrency/local-target.safety.mjs",
    "supabase/tests/concurrency/read-access-revocation-concurrency.orchestration.safety.mjs",
    "supabase/tests/database/v4_3/cycle_bound_operator_send.offline.test.mjs",
    "supabase/tests/database/v4_3/handling_claim_expiry.offline.test.mjs",
    "supabase/tests/database/v4_3/handling_shadow_foundation.offline.test.mjs",
    "supabase/tests/database/v4_3/p03_p07_profile_images.offline.test.mjs",
    "supabase/tests/database/v4_3/p05_sla_presence.offline.test.mjs",
    "supabase/tests/database/v4_3/wp03_outreach_retirement.offline.test.mjs",
    "supabase/tests/database/v4_3/wp05_regular_media_policy.offline.test.mjs",
    "supabase/tests/database/v4_3/wp06b_media_cleanup.offline.test.mjs",
    "supabase/tests/database/v4_3/wp08_operator_points_migration.offline.test.mjs",
    "supabase/tests/database/v4_3/wp09_client_levels_migration.offline.test.mjs",
    "supabase/tests/database/v4_3/wp10_deletion_retention.offline.test.mjs",
    "supabase/tests/database/v4_3/wp10_retention_minimization.offline.test.mjs",
    "supabase/tests/database/v4_3/wp11_admin_completion_exception_cases.offline.test.mjs",
    "supabase/tests/database/v4_3/wp11_admin_role_transition.offline.test.mjs",
    "supabase/tests/database/v4_3/wp11_operator_report_moderation.offline.test.mjs",
    "supabase/tests/database/v4_3/wp11_operator_report_page.offline.test.mjs",
    "supabase/tests/database/v4_3/wp11_server_analytics.offline.test.mjs",
    "supabase/tests/local-docker-port-contract.test.mjs",
    "supabase/tests/upgrades/wp01-read-access-117-to-118.orchestration.safety.mjs",
    "supabase/tests/upgrades/wp01-shadow-113-to-116.orchestration.safety.mjs",
    "supabase/tests/upgrades/wp01-strict-send-116-to-117.orchestration.safety.mjs",
  ]);
  assert.ok(nodeTest.every((path) => !selected.includes(path)));

  const executionText = executionPackageText();
  assert.ok(
    executionText.includes("supabase/tests/local-docker-port-contract.test.mjs"),
    "the approved port-binding contract test must be documented in the node:test inventory",
  );
  const commandMatch = executionText.match(
    /^\| `http\.1` \/ `http\.2`\s*\| `npm run test:http -- ([^`]+)`/m,
  );
  assert.ok(commandMatch, "missing the exact shared HTTPx2 command");
  assert.deepEqual(commandMatch[1].split(/\s+/), http);
  for (const command of [
    "node --test supabase/tests/database/v4_3/p03_p07_profile_images.offline.test.mjs",
    "node --test supabase/tests/database/v4_3/p05_sla_presence.offline.test.mjs",
    "node --test supabase/tests/database/v4_3/wp03_outreach_retirement.offline.test.mjs",
    "node supabase/tests/database/v4_3/p06_configuration_connections.offline.test.mjs",
    "node supabase/tests/database/v4_3/p06_restore_recovery.offline.test.mjs",
    "node supabase/tests/database/v4_3/p06_support_first_response.offline.test.mjs",
    "node supabase/tests/database/v4_3/p06_support_incidents.offline.test.mjs",
    "node supabase/tests/database/v4_3/p06a_registration_eligibility.offline.test.mjs",
    "node --test supabase/tests/database/v4_3/wp05_regular_media_policy.offline.test.mjs",
    "node --test supabase/tests/database/v4_3/wp06b_media_cleanup.offline.test.mjs",
    "node --test supabase/tests/database/v4_3/wp08_operator_points_migration.offline.test.mjs",
    "node --test supabase/tests/database/v4_3/wp09_client_levels_migration.offline.test.mjs",
    "node --test supabase/tests/database/v4_3/wp10_deletion_retention.offline.test.mjs",
    "node --test supabase/tests/database/v4_3/wp10_retention_minimization.offline.test.mjs",
    "node --test supabase/tests/database/v4_3/wp11_server_analytics.offline.test.mjs",
  ]) {
    assert.ok(executionText.includes(command), `missing integrated offline command: ${command}`);
  }
  const wp11Gate = executionText
    .split(/\r?\n/)
    .find((line) =>
      line.startsWith(
        "node --test supabase/tests/database/v4_3/wp11_server_analytics.offline.test.mjs",
      ),
    );
  assert.ok(wp11Gate, "missing the exact WP11 Offline command");
  assert.deepEqual(
    wp11Gate.trim().split(/\s+/).slice(2).sort(),
    nodeTest.filter((path) =>
      /^supabase\/tests\/database\/v4_3\/wp11_.*\.offline\.test\.mjs$/.test(path),
    ),
    "the existing WP11 command must include all five WP11 Node test files",
  );
});

test("Product HTTP rejects incomplete or substituted file inventories before any runtime", async () => {
  const runtime = () => assert.fail("inventory rejection reached a runtime boundary");
  const withoutWp11 = PRODUCT_HTTP_FILES.filter((path) => !path.includes("wp11_admin_status"));
  for (const args of [
    withoutWp11,
    [...withoutWp11, withoutWp11[0]],
    [...withoutWp11, "supabase/tests/http/invented.integration.test.ts"],
    [...PRODUCT_HTTP_FILES, "--testNamePattern=paid"],
  ]) {
    await assert.rejects(
      runProductHttp({ args, env: {}, cwd: "", config: "", realpath: runtime, invoke: runtime }),
      /exact Product HTTP inventory/,
    );
  }
  await assert.rejects(
    runProductHttp({
      args: [...PRODUCT_HTTP_FILES].reverse(),
      env: {},
      cwd: "",
      config: "",
      realpath: runtime,
      invoke: runtime,
    }),
    /missing or mismatched Product run and service-lane handoff/,
  );
});

for (const marker of [
  "product-collector-owner-before-readiness",
  "product-collector-owner-before-stop",
]) {
  test(`${marker} accepts only the direct collector child owned by the managing shell`, () => {
    const result = runCollectorOwnershipScript(marker, {
      argv: [
        "/usr/bin/node",
        "integration/tools/product-service-log-collector.mjs",
        "--run-id",
        "run-owned",
      ],
    });
    assert.equal(result.status, 0, result.stderr);
  });

  test(`${marker} rejects a saved Bash wrapper PID`, () => {
    const result = runCollectorOwnershipScript(marker, {
      argv: ["/usr/bin/bash", "--noprofile", "--norc", "-s", "--"],
    });
    assert.notEqual(result.status, 0);
  });
}

test("the connected readiness guard blocks service work when the PID file differs", () => {
  const outcome = runCollectorShellBlock("product-collector-owner-before-readiness", {
    pidFile: "5151",
  });
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.match(outcome.result.stdout, /allowed=0/);
  assert.deepEqual(outcome.actions, []);
  assert.match(outcome.primary, /^collector\.readiness\t71$/m);
});

for (const scenario of [
  { name: "PPid", parentMode: "wrong" },
  {
    name: "entrypoint",
    argv: ["/usr/bin/node", "integration/tools/not-the-collector.mjs", "--run-id", "run-owned"],
  },
  {
    name: "RUN_ID",
    argv: [
      "/usr/bin/node",
      "integration/tools/product-service-log-collector.mjs",
      "--run-id",
      "wrong-run",
    ],
  },
]) {
  test(`the connected readiness guard blocks service work for a wrong ${scenario.name}`, () => {
    const outcome = runCollectorShellBlock("product-collector-owner-before-readiness", scenario);
    assert.equal(outcome.result.status, 0, outcome.result.stderr);
    assert.match(outcome.result.stdout, /allowed=0/);
    assert.deepEqual(outcome.actions, ["node"]);
    assert.match(outcome.primary, /^collector\.readiness\t71$/m);
  });
}

test("the connected stop guard reaches only the simulated kill and wait for verified ownership", () => {
  const outcome = runCollectorShellBlock("product-collector-owner-before-stop");
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.deepEqual(
    outcome.actions,
    ["node", "kill:-0 4242", "kill:-INT 4242", "wait:4242"],
    `nodeResult=${outcome.nodeResult} stderr=${outcome.result.stderr}`,
  );
  assert.equal(outcome.secondary, "");
});

test("the connected stop guard preserves the primary failure and records rejected ownership", () => {
  const primary = "service.start\t52\n";
  const outcome = runCollectorShellBlock("product-collector-owner-before-stop", {
    parentMode: "wrong",
    primary,
  });
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.deepEqual(outcome.actions, ["node"]);
  assert.equal(outcome.primary, primary);
  assert.match(outcome.secondary, /^collector\.ownership\tpid-file=0\towner=71$/m);
});

test("the connected stop guard never signals a PID that differs from the saved PID", () => {
  const outcome = runCollectorShellBlock("product-collector-owner-before-stop", {
    pidFile: "5151",
  });
  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.deepEqual(outcome.actions, []);
  assert.match(outcome.secondary, /^collector\.ownership\tpid-file=1\towner=71$/m);
});

test("collector finalization is parsed before service mutation and invoked by a short same-shell call", () => {
  const document = executionPackageText();
  const definition = markedShellRegion("product-collector-stop-function");
  const invocation = markedShellRegion("product-collector-stop-call");
  const root = mkdtempSync(join(tmpdir(), "product collector finalization "));
  const evidence = join(root, "evidence");
  const secondaryFailures = join(evidence, "secondary-failures.tsv");
  try {
    assert.ok(
      document.indexOf("# product-collector-stop-function:start") <
        document.indexOf("docker events --since"),
      "collector finalization must be parsed before the first service-lane mutation",
    );
    assert.equal(invocation.trim(), "product_stop_collector_and_verify_summary");
    mkdirSync(join(evidence, "service-log-collector"), { recursive: true });
    write(join(evidence, "service-log-collector.pid"), "5151\n");
    write(
      join(evidence, "service-log-collector", "collector-summary.json"),
      JSON.stringify({ complete: true, gaps: [], failures: [], missingServices: [] }) + "\n",
    );
    write(secondaryFailures, "");
    const result = bashRun(
      [
        "-c",
        `
set +e
${definition}
printf 'service-mutation-simulated\\n'
${invocation}
printf 'collector-summary-rc=%s\\n' "$collector_summary_rc"
`,
      ],
      {
        env: {
          ...process.env,
          PRODUCT_COLLECTOR_PID: "4242",
          RUN_EVIDENCE: toPosix(evidence),
          RUN_ID: "run-owned",
          SECONDARY_FAILURES: toPosix(secondaryFailures),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /service-mutation-simulated/);
    assert.match(result.stdout, /collector-summary-rc=0/);
    assert.match(
      readFileSync(secondaryFailures, "utf8"),
      /^collector\.ownership\tpid-file=1\towner=71$/m,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Deno decoder gate ignores the root package.json manual node_modules mode", () => {
  const document = executionPackageText();
  assert.match(
    document,
    /(?:^|\r?\n)deno test --node-modules-dir=none --allow-read supabase\/functions\/client-media-finalize\/image-validation\.deno-test\.ts(?:\r?\n|$)/,
  );
});

test("success uses the artifact itself with paths containing spaces", () => {
  const fixture = makeFixture();
  try {
    const prepare = execute(fixture, "prepare-user", "success");
    assert.equal(prepare.status, 0, prepare.stderr);
    assert.deepEqual(actions(fixture), ["curl:archive", "curl:checksums"]);
    const extracted = join(
      fixture.evidence,
      fixture.runId,
      "provisioning",
      "supabase-2.95.4",
      "extract",
      "supabase",
    );
    assert.ok(existsSync(extracted));
    const finalize = execute(fixture, "finalize-user", "success");
    assert.equal(finalize.status, 0, finalize.stderr);
    assert.ok(!existsSync(join(fixture.verification, fixture.runId)));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("prepare-user rejects an extra source path before any download or mutation", () => {
  const fixture = makeFixture();
  try {
    write(join(fixture.repository, "unexpected-before-mutation.txt"), "unexpected\n");

    const prepare = execute(fixture, "prepare-user", "success");

    assert.notEqual(prepare.status, 0);
    assert.match(prepare.stderr, /snapshot\.count|snapshot\.paths/);
    assert.deepEqual(actions(fixture), []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("continue-user binds the approved Docker context before every Supabase CLI invocation without changing Docker config", () => {
  const fixture = makeFixture();
  try {
    const dockerConfigPath = join(fixture.dockerConfig, "config.json");
    const dockerConfigBefore = readFileSync(dockerConfigPath);
    assert.equal(execute(fixture, "prepare-user", "success").status, 0);
    assert.equal(execute(fixture, "install-cli-root", "install-missing").status, 0);

    const continued = execute(fixture, "continue-user", "success", {
      DOCKER_CONTEXT: undefined,
      DOCKER_HOST: undefined,
      DOCKER_TLS_VERIFY: undefined,
      DOCKER_CERT_PATH: undefined,
    });

    assert.equal(continued.status, 0, continued.stderr);
    const supabaseActions = actions(fixture).filter((entry) => entry.startsWith("supabase:"));
    assert.deepEqual(supabaseActions, [
      `supabase:${environmentContract.context}:--version`,
      `supabase:${environmentContract.context}:migration new product_completion_read_access_gate`,
    ]);
    assert.deepEqual(readFileSync(dockerConfigPath), dockerConfigBefore);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("continue-user accepts an already approved Docker context without changing global configuration", () => {
  const fixture = makeFixture();
  try {
    const dockerConfigPath = join(fixture.dockerConfig, "config.json");
    const dockerConfigBefore = readFileSync(dockerConfigPath);
    assert.equal(execute(fixture, "prepare-user", "success").status, 0);
    assert.equal(execute(fixture, "install-cli-root", "install-missing").status, 0);

    const continued = execute(fixture, "continue-user", "success", {
      DOCKER_CONTEXT: environmentContract.context,
      DOCKER_HOST: undefined,
      DOCKER_TLS_VERIFY: undefined,
      DOCKER_CERT_PATH: undefined,
    });

    assert.equal(continued.status, 0, continued.stderr);
    assert.deepEqual(readFileSync(dockerConfigPath), dockerConfigBefore);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("continue-user rejects a conflicting Docker context before the first Supabase CLI invocation", () => {
  const fixture = makeFixture();
  try {
    assert.equal(execute(fixture, "prepare-user", "success").status, 0);
    assert.equal(execute(fixture, "install-cli-root", "install-missing").status, 0);

    const continued = execute(fixture, "continue-user", "success", {
      DOCKER_CONTEXT: "desktop-linux",
      DOCKER_HOST: undefined,
      DOCKER_TLS_VERIFY: undefined,
      DOCKER_CERT_PATH: undefined,
    });

    assert.equal(continued.status, 42);
    assert.match(
      continued.stderr,
      /docker\.override: DOCKER_CONTEXT conflicts with approved context \(exit 42\)/,
    );
    assert.equal(
      actions(fixture).some((entry) => entry.startsWith("supabase:")),
      false,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const variable of ["DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) {
  test(`continue-user still rejects non-empty ${variable} before the first Supabase CLI invocation`, () => {
    const fixture = makeFixture();
    try {
      assert.equal(execute(fixture, "prepare-user", "success").status, 0);
      assert.equal(execute(fixture, "install-cli-root", "install-missing").status, 0);

      const continued = execute(fixture, "continue-user", "success", {
        DOCKER_CONTEXT: undefined,
        DOCKER_HOST: undefined,
        DOCKER_TLS_VERIFY: undefined,
        DOCKER_CERT_PATH: undefined,
        [variable]: "forbidden-value",
      });

      assert.equal(continued.status, 42);
      assert.match(continued.stderr, /docker\.override: .* is non-empty \(exit 42\)/);
      assert.equal(
        actions(fixture).some((entry) => entry.startsWith("supabase:")),
        false,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("continue-user preserves a Supabase version failure and stops without retry or fallback", () => {
  const fixture = makeFixture();
  try {
    assert.equal(execute(fixture, "prepare-user", "success").status, 0);
    assert.equal(execute(fixture, "install-cli-root", "install-missing").status, 0);

    const continued = execute(fixture, "continue-user", "cli-version-fail", {
      DOCKER_CONTEXT: undefined,
      DOCKER_HOST: undefined,
      DOCKER_TLS_VERIFY: undefined,
      DOCKER_CERT_PATH: undefined,
    });

    assert.equal(continued.status, 76);
    assert.match(continued.stderr, /cli\.version: supabase --version failed \(exit 76\)/);
    assert.deepEqual(
      actions(fixture).filter((entry) => entry.startsWith("supabase:")),
      [`supabase:${environmentContract.context}:--version`],
    );
    assert.equal(existsSync(join(fixture.evidence, fixture.runId, "continue.complete")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("continue-user accepts the documented cli-latest mutation and verifies the runtime snapshot", () => {
  const fixture = makeFixture();
  try {
    const prepare = execute(fixture, "prepare-user", "success");
    assert.equal(prepare.status, 0, prepare.stderr);
    const install = execute(fixture, "install-cli-root", "install-missing");
    assert.equal(install.status, 0, install.stderr);

    const continued = execute(fixture, "continue-user", "success");

    assert.equal(continued.status, 0, continued.stderr);
    assert.ok(
      actions(fixture).includes("npm:ci --ignore-scripts --audit=false"),
      "continue-user must disable npm's automatic audit during dependency materialization",
    );
    assert.ok(
      actions(fixture).includes("npm:rebuild esbuild sharp workerd"),
      "continue-user must retain the explicit lifecycle allowlist",
    );
    assert.ok(
      existsSync(join(fixture.evidence, fixture.runId, "snapshot-runtime.verify.stdout")),
      "the real continue-user path must publish the runtime snapshot result",
    );
    assert.ok(
      existsSync(
        join(fixture.evidence, fixture.runId, "snapshot-runtime.cli-latest-backup.sha256"),
      ),
      "the real continue-user path must publish the verified pre-mutation backup hash",
    );
    assert.equal(
      readFileSync(join(fixture.runRepository, "supabase", ".temp", "cli-latest"), "utf8"),
      "runtime-cli-state\n",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("continue-user rejects a missing cli-latest backup before service gates", () => {
  const fixture = makeFixture();
  try {
    assert.equal(execute(fixture, "prepare-user", "success").status, 0);
    assert.equal(execute(fixture, "install-cli-root", "install-missing").status, 0);
    rmSync(fixture.backupTarget);

    const continued = execute(fixture, "continue-user", "success");

    assert.notEqual(continued.status, 0);
    assert.match(continued.stderr, /snapshot\.runtime-backup/);
    assert.ok(!existsSync(join(fixture.evidence, fixture.runId, "continue.complete")));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("continue-user rejects a cli-latest backup that differs from the authoritative manifest", () => {
  const fixture = makeFixture();
  try {
    assert.equal(execute(fixture, "prepare-user", "success").status, 0);
    assert.equal(execute(fixture, "install-cli-root", "install-missing").status, 0);
    write(fixture.backupTarget, "tampered backup\n");

    const continued = execute(fixture, "continue-user", "success");

    assert.notEqual(continued.status, 0);
    assert.match(continued.stderr, /snapshot\.runtime-backup-hash/);
    assert.ok(!existsSync(join(fixture.evidence, fixture.runId, "continue.complete")));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("continue-user rejects a linked cli-latest backup before service gates", () => {
  const fixture = makeFixture();
  try {
    assert.equal(execute(fixture, "prepare-user", "success").status, 0);
    assert.equal(execute(fixture, "install-cli-root", "install-missing").status, 0);

    const continued = execute(fixture, "continue-user", "runtime-backup-linked");

    assert.notEqual(continued.status, 0);
    assert.match(continued.stderr, /snapshot\.runtime-backup/);
    assert.ok(!existsSync(join(fixture.evidence, fixture.runId, "continue.complete")));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("continue-user rejects immutable source drift after the mutable CLI operation", () => {
  const fixture = makeFixture();
  try {
    assert.equal(execute(fixture, "prepare-user", "success").status, 0);
    assert.equal(execute(fixture, "install-cli-root", "install-missing").status, 0);

    const continued = execute(fixture, "continue-user", "runtime-immutable-drift");

    assert.notEqual(continued.status, 0);
    assert.match(continued.stderr, /snapshot\.runtime-hashes/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("continue-user rejects runtime output that was not attributed to an authorized command", () => {
  const fixture = makeFixture();
  try {
    assert.equal(execute(fixture, "prepare-user", "success").status, 0);
    assert.equal(execute(fixture, "install-cli-root", "install-missing").status, 0);

    const continued = execute(fixture, "continue-user", "runtime-untracked-temp");

    assert.notEqual(continued.status, 0);
    assert.match(continued.stderr, /snapshot\.runtime-paths/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("finalization restores cli-latest before requiring the exact full snapshot", () => {
  const fixture = makeFixture();
  try {
    assert.equal(execute(fixture, "prepare-user", "success").status, 0);
    assert.equal(execute(fixture, "install-cli-root", "install-missing").status, 0);
    assert.equal(execute(fixture, "continue-user", "success").status, 0);

    const finalized = execute(fixture, "finalize-user", "success");

    assert.equal(finalized.status, 0, finalized.stderr);
    assert.ok(!existsSync(join(fixture.verification, fixture.runId)));
    assert.match(
      readFileSync(join(fixture.evidence, fixture.runId, "snapshot-final.verify.stdout"), "utf8"),
      /OK/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Finalize preserves a known outer failure before removing the run target", () => {
  const fixture = makeFixture();
  try {
    prepareEnvironmentGateFixture(fixture);
    const evidence = join(fixture.evidence, fixture.runId);
    const ledger = join(evidence, "primary-failure.tsv");
    assert.equal(readFileSync(ledger, "utf8"), "");

    const finalized = execute(fixture, "finalize-user", "success", {}, [
      "--outer-primary",
      "04-repeat-source-fence:99",
    ]);
    assert.equal(finalized.status, 99, finalized.stderr);
    assert.equal(
      readFileSync(ledger, "utf8"),
      "outer.04-repeat-source-fence\t99\touter-runner failure\n",
    );
    assert.equal(
      readFileSync(join(evidence, "finalize.result.txt"), "utf8"),
      "primary=99 cleanup=0\n",
    );
    assert.match(
      readFileSync(join(evidence, "evidence-files.final.sha256"), "utf8"),
      /primary-failure\.tsv/,
    );
    assert.equal(existsSync(join(fixture.verification, fixture.runId)), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Finalize stops on malformed or conflicting outer failure without cleaning up", () => {
  const fixture = makeFixture();
  try {
    prepareEnvironmentGateFixture(fixture);
    const evidence = join(fixture.evidence, fixture.runId);
    const ledger = join(evidence, "primary-failure.tsv");
    const first = "environment.residue\t42\texisting artifact failure\n";
    write(ledger, first);
    const before = actions(fixture);

    for (const outer of [
      "01-environment-gate:256",
      "01-environment-gate:0",
      "01-environment-gate:99",
    ]) {
      const finalized = execute(fixture, "finalize-user", "success", {}, [
        "--outer-primary",
        outer,
      ]);
      assert.equal(finalized.status, 64, finalized.stderr);
      assert.match(finalized.stderr, /outer primary/);
      assert.equal(readFileSync(ledger, "utf8"), first);
      assert.equal(existsSync(join(evidence, "finalize.result.txt")), false);
      assert.equal(existsSync(join(fixture.verification, fixture.runId)), true);
      assert.deepEqual(actions(fixture), before);
    }

    const finalized = execute(fixture, "finalize-user", "success", {}, [
      "--outer-primary",
      "01-environment-gate:42",
    ]);
    assert.equal(finalized.status, 42, finalized.stderr);
    assert.equal(readFileSync(ledger, "utf8"), first);
    assert.equal(
      readFileSync(join(evidence, "finalize.result.txt"), "utf8"),
      "primary=42 cleanup=0\n",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Finalize leaves the run intact when the outer failure cannot be synced", () => {
  const fixture = makeFixture();
  try {
    prepareEnvironmentGateFixture(fixture);
    const before = actions(fixture);
    const outer = ["--outer-primary", "04-repeat-source-fence:99"];
    for (const [scenario, args] of [
      ["outer-primary-sync-fail", outer],
      ["outer-primary-sync-fail", outer],
      ["success", []],
      ["success", ["--outer-primary", "01-environment-gate:99"]],
    ]) {
      const finalized = execute(fixture, "finalize-user", scenario, {}, args);
      assert.equal(finalized.status, 64, finalized.stderr);
      assert.match(finalized.stderr, /cleanup not attempted/);
    }
    assert.equal(existsSync(join(fixture.evidence, fixture.runId, "finalize.result.txt")), false);
    assert.equal(existsSync(join(fixture.verification, fixture.runId)), true);
    assert.deepEqual(actions(fixture), before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an outer failure cannot authorize Finalize's pre-backup exception", () => {
  const fixture = makeFixture();
  try {
    write(join(fixture.repository, "unexpected-before-backup.txt"), "unexpected\n");
    assert.equal(execute(fixture, "prepare-user", "success").status, 75);
    const evidence = join(fixture.evidence, fixture.runId);
    const ledger = join(evidence, "primary-failure.tsv");
    const backupState = join(evidence, "cli-latest-backup.state.tsv");
    const originalState = readFileSync(backupState);
    write(ledger, "");
    write(backupState, "required\t" + "0".repeat(64) + "\n");
    const outer = ["--outer-primary", "snapshot.count:75"];
    assert.equal(
      execute(fixture, "finalize-user", "outer-primary-sync-fail", {}, outer).status,
      64,
    );
    write(backupState, originalState);
    assert.match(readFileSync(ledger, "utf8"), /^outer\.snapshot\.count\t75\t/);

    const finalized = execute(fixture, "finalize-user", "success", {}, outer);
    assert.equal(finalized.status, 75, finalized.stderr);
    assert.equal(
      readFileSync(join(evidence, "finalize.result.txt"), "utf8"),
      "primary=75 cleanup=104\n",
    );
    assert.equal(existsSync(join(fixture.verification, fixture.runId)), true);
    assert.ok(!actions(fixture).some((action) => action.startsWith("rm:")));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("finalization marks cli-latest restore not applicable after snapshot.count fails before backup", () => {
  const fixture = makeFixture();
  try {
    write(join(fixture.repository, "unexpected-before-backup.txt"), "unexpected\n");

    const prepare = execute(fixture, "prepare-user", "success");
    assert.equal(prepare.status, 75, prepare.stderr);
    assert.ok(!existsSync(fixture.backupTarget));

    const finalized = execute(fixture, "finalize-user", "success");

    assert.equal(finalized.status, 75, finalized.stderr);
    const evidence = join(fixture.evidence, fixture.runId);
    assert.equal(
      readFileSync(join(evidence, "finalize.result.txt"), "utf8"),
      "primary=75 cleanup=0\n",
    );
    assert.equal(
      readFileSync(join(evidence, "cli-latest-restore.result.txt"), "utf8"),
      "not-applicable\tprepare-failed-before-cli-backup\tsnapshot.count\n",
    );
    assert.equal(readFileSync(join(evidence, "secondary-failures.tsv"), "utf8"), "");
    assert.ok(!existsSync(join(fixture.verification, fixture.runId)));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("finalization fails closed when a required cli-latest backup is missing", () => {
  const fixture = makeFixture();
  try {
    assert.equal(execute(fixture, "prepare-user", "success").status, 0);
    rmSync(fixture.backupTarget);

    const finalized = execute(fixture, "finalize-user", "success");

    assert.notEqual(finalized.status, 0);
    assert.match(
      readFileSync(join(fixture.evidence, fixture.runId, "secondary-failures.tsv"), "utf8"),
      /cleanup\.cli-backup-path/,
    );
    assert.ok(existsSync(join(fixture.verification, fixture.runId)));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const [label, mutateState] of [
  ["missing", (path) => rmSync(path)],
  [
    "ambiguous",
    (path) => write(path, "required\t" + "0".repeat(64) + "\nrequired\t" + "0".repeat(64) + "\n"),
  ],
]) {
  test(`finalization rejects ${label} cli-latest backup state evidence`, () => {
    const fixture = makeFixture();
    try {
      assert.equal(execute(fixture, "prepare-user", "success").status, 0);
      const statePath = join(fixture.evidence, fixture.runId, "cli-latest-backup.state.tsv");
      mutateState(statePath);

      const finalized = execute(fixture, "finalize-user", "success");

      assert.notEqual(finalized.status, 0);
      assert.match(
        readFileSync(join(fixture.evidence, fixture.runId, "secondary-failures.tsv"), "utf8"),
        /cleanup\.cli-backup-state/,
      );
      assert.ok(existsSync(join(fixture.verification, fixture.runId)));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("finalization validates required backup bytes before restoring cli-latest", () => {
  const fixture = makeFixture();
  try {
    assert.equal(execute(fixture, "prepare-user", "success").status, 0);
    write(join(fixture.runRepository, "supabase", ".temp", "cli-latest"), "runtime-cli-state\n");
    write(fixture.backupTarget, "corrupt-backup\n");

    const finalized = execute(fixture, "finalize-user", "success");

    assert.notEqual(finalized.status, 0);
    assert.match(
      readFileSync(join(fixture.evidence, fixture.runId, "secondary-failures.tsv"), "utf8"),
      /cleanup\.cli-backup-hash/,
    );
    assert.equal(
      readFileSync(join(fixture.runRepository, "supabase", ".temp", "cli-latest"), "utf8"),
      "runtime-cli-state\n",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("finalization rejects partial required cli-latest backup evidence", () => {
  const fixture = makeFixture();
  try {
    assert.equal(execute(fixture, "prepare-user", "success").status, 0);
    rmSync(join(fixture.evidence, fixture.runId, "pre-mutation-cli-latest-backup.sha256"));

    const finalized = execute(fixture, "finalize-user", "success");

    assert.notEqual(finalized.status, 0);
    assert.match(
      readFileSync(join(fixture.evidence, fixture.runId, "secondary-failures.tsv"), "utf8"),
      /cleanup\.cli-backup-evidence/,
    );
    assert.ok(existsSync(join(fixture.verification, fixture.runId)));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("finalization rejects backup artifacts that contradict a not-required state", () => {
  const fixture = makeFixture();
  try {
    write(join(fixture.repository, "unexpected-before-backup.txt"), "unexpected\n");
    assert.equal(execute(fixture, "prepare-user", "success").status, 75);
    write(fixture.backupTarget, "partial-backup\n");

    const finalized = execute(fixture, "finalize-user", "success");

    assert.equal(finalized.status, 75);
    assert.match(
      readFileSync(join(fixture.evidence, fixture.runId, "secondary-failures.tsv"), "utf8"),
      /cleanup\.cli-backup-state/,
    );
    assert.match(
      readFileSync(join(fixture.evidence, fixture.runId, "finalize.result.txt"), "utf8"),
      /cleanup=[1-9]/,
    );
    assert.ok(existsSync(join(fixture.verification, fixture.runId)));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const [label, primaryRecord] of [
  ["missing primary failure", ""],
  ["post-backup primary gate", "cli.version\t76\tsupabase --version failed\n"],
]) {
  test(`finalization rejects not-required state with ${label}`, () => {
    const fixture = makeFixture();
    try {
      write(join(fixture.repository, "unexpected-before-backup.txt"), "unexpected\n");
      assert.equal(execute(fixture, "prepare-user", "success").status, 75);
      write(join(fixture.evidence, fixture.runId, "primary-failure.tsv"), primaryRecord);

      const finalized = execute(fixture, "finalize-user", "success");

      assert.notEqual(finalized.status, 0);
      assert.match(
        readFileSync(join(fixture.evidence, fixture.runId, "secondary-failures.tsv"), "utf8"),
        /cleanup\.cli-backup-state/,
      );
      assert.ok(existsSync(join(fixture.verification, fixture.runId)));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("a real cli-latest restore failure stays secondary to the primary failure", () => {
  const fixture = makeFixture();
  try {
    const prepare = execute(fixture, "prepare-user", "curl22");
    assert.equal(prepare.status, 22);

    const finalized = execute(fixture, "finalize-user", "restore-cli-fail");

    assert.equal(finalized.status, 22);
    const evidence = join(fixture.evidence, fixture.runId);
    assert.match(
      readFileSync(join(evidence, "primary-failure.tsv"), "utf8"),
      /cli\.download\.archive\t22/,
    );
    assert.match(
      readFileSync(join(evidence, "secondary-failures.tsv"), "utf8"),
      /cleanup\.restore-cli\t17/,
    );
    assert.equal(
      readFileSync(join(evidence, "finalize.result.txt"), "utf8"),
      "primary=22 cleanup=17\n",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("finalization preserves and attributes a newly created deno.lock before removing it", () => {
  const fixture = makeFixture();
  try {
    assert.equal(execute(fixture, "prepare-user", "success").status, 0);
    assert.equal(execute(fixture, "install-cli-root", "install-missing").status, 0);
    assert.equal(execute(fixture, "continue-user", "success").status, 0);
    const evidence = join(fixture.evidence, fixture.runId);
    assert.equal(readFileSync(join(evidence, "deno-lock.before-state.txt"), "utf8"), "absent\n");

    write(join(fixture.runRepository, "deno.lock"), "generated lock bytes\n");
    const finalized = execute(fixture, "finalize-user", "success");

    assert.equal(finalized.status, 0, finalized.stderr);
    assert.equal(
      readFileSync(join(evidence, "run-output", "deno.lock"), "utf8"),
      "generated lock bytes\n",
    );
    assert.match(
      readFileSync(join(evidence, "deno-lock.run-created.sha256"), "utf8"),
      /^[0-9a-f]{64} [ *]deno\.lock\n$/,
    );
    assert.match(
      readFileSync(join(evidence, "deno-lock.evidence.sha256"), "utf8"),
      /^[0-9a-f]{64} [ *].*run-output\/deno\.lock\n$/,
    );
    assert.ok(!existsSync(join(fixture.verification, fixture.runId)));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("finalization does not delete or overwrite a deno.lock that existed before the Deno gate", () => {
  const fixture = makeFixture({ preexistingDenoLock: true });
  try {
    assert.equal(execute(fixture, "prepare-user", "success").status, 0);
    assert.equal(execute(fixture, "install-cli-root", "install-missing").status, 0);
    assert.equal(execute(fixture, "continue-user", "success").status, 0);
    const evidence = join(fixture.evidence, fixture.runId);
    assert.equal(
      readFileSync(join(evidence, "deno-lock.before-state.txt"), "utf8"),
      "pre-existing\n",
    );

    const finalized = execute(fixture, "finalize-user", "cleanup-fail");

    assert.equal(finalized.status, 9, finalized.stderr);
    assert.equal(
      readFileSync(join(fixture.runRepository, "deno.lock"), "utf8"),
      "pre-existing lock\n",
    );
    assert.ok(!actions(fixture).some((action) => action.includes("deno.lock")));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("finalization rejects changed bytes for a pre-existing deno.lock", () => {
  const fixture = makeFixture({ preexistingDenoLock: true });
  try {
    assert.equal(execute(fixture, "prepare-user", "success").status, 0);
    assert.equal(execute(fixture, "install-cli-root", "install-missing").status, 0);
    assert.equal(execute(fixture, "continue-user", "success").status, 0);
    write(join(fixture.runRepository, "deno.lock"), "changed lock bytes\n");

    const finalized = execute(fixture, "finalize-user", "success");

    assert.notEqual(finalized.status, 0);
    assert.match(
      readFileSync(join(fixture.evidence, fixture.runId, "secondary-failures.tsv"), "utf8"),
      /cleanup\.deno-lock-bytes/,
    );
    assert.equal(
      readFileSync(join(fixture.runRepository, "deno.lock"), "utf8"),
      "changed lock bytes\n",
    );
    assert.ok(existsSync(join(fixture.verification, fixture.runId)));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("finalization rejects a missing pre-existing deno.lock without removing the run target", () => {
  const fixture = makeFixture({ preexistingDenoLock: true });
  try {
    assert.equal(execute(fixture, "prepare-user", "success").status, 0);
    assert.equal(execute(fixture, "install-cli-root", "install-missing").status, 0);
    assert.equal(execute(fixture, "continue-user", "success").status, 0);
    rmSync(join(fixture.runRepository, "deno.lock"));

    const finalized = execute(fixture, "finalize-user", "success");

    assert.notEqual(finalized.status, 0);
    assert.match(
      readFileSync(join(fixture.evidence, fixture.runId, "secondary-failures.tsv"), "utf8"),
      /cleanup\.deno-lock-path/,
    );
    assert.ok(existsSync(join(fixture.verification, fixture.runId)));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("finalization rejects a linked deno.lock created after the Deno gate boundary", () => {
  const fixture = makeFixture();
  try {
    assert.equal(execute(fixture, "prepare-user", "success").status, 0);
    assert.equal(execute(fixture, "install-cli-root", "install-missing").status, 0);
    assert.equal(execute(fixture, "continue-user", "success").status, 0);
    // Windows test hosts may not grant symlink creation; the fixture makes the
    // artifact's real `test ! -L` boundary report this exact path as linked.
    write(join(fixture.runRepository, "deno.lock"), "linked-path simulation\n");

    const finalized = execute(fixture, "finalize-user", "deno-lock-linked");

    assert.notEqual(finalized.status, 0);
    assert.match(
      readFileSync(join(fixture.evidence, fixture.runId, "secondary-failures.tsv"), "utf8"),
      /cleanup\.deno-lock-path/,
    );
    assert.ok(existsSync(join(fixture.verification, fixture.runId)));
    assert.ok(!existsSync(join(fixture.evidence, fixture.runId, "run-output", "deno.lock")));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("prepare-user and install-cli-root reuse a verified CLI without downloads when curl would return 504", () => {
  const fixture = makeFixture();
  try {
    write(fixture.installTarget, "existing approved binary bytes\n", 0o755);
    const before = readFileSync(fixture.installTarget, "utf8");

    const prepare = execute(fixture, "prepare-user", "prepare-existing-valid-curl22");

    assert.equal(prepare.status, 0, prepare.stderr);
    assert.match(prepare.stdout, /prepare-user reused_verified/);
    assert.deepEqual(actions(fixture), []);
    assert.match(
      readFileSync(join(fixture.evidence, fixture.runId, "supabase-prepare-reuse.sha256"), "utf8"),
      /0b47b526a2d93a9e3f29a82b2f4ac556fa983a8c67e89c2862ade94fd6220f09/,
    );

    const install = execute(fixture, "install-cli-root", "install-existing-valid");

    assert.equal(install.status, 0, install.stderr);
    assert.match(install.stdout, /install-cli-root reused_verified/);
    assert.equal(readFileSync(fixture.installTarget, "utf8"), before);
    assert.deepEqual(actions(fixture), []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("verified CLI reuse records a required backup without relying on prepare.complete", () => {
  const fixture = makeFixture();
  try {
    write(fixture.installTarget, "existing approved binary bytes\n", 0o755);

    const prepare = execute(fixture, "prepare-user", "prepare-existing-valid-curl22");

    assert.equal(prepare.status, 0, prepare.stderr);
    const evidence = join(fixture.evidence, fixture.runId);
    assert.ok(!existsSync(join(evidence, "provisioning", "supabase-2.95.4", "prepare.complete")));
    assert.match(
      readFileSync(join(evidence, "cli-latest-backup.state.tsv"), "utf8"),
      /^required\t[0-9a-f]{64}\n$/,
    );

    const finalized = execute(fixture, "finalize-user", "success");

    assert.equal(finalized.status, 0, finalized.stderr);
    assert.equal(
      readFileSync(join(evidence, "cli-latest-restore.result.txt"), "utf8"),
      "restored-and-verified\n",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const scenario of [
  "prepare-existing-wrong-hash",
  "prepare-existing-wrong-owner",
  "prepare-existing-wrong-mode",
  "prepare-existing-linked-binary",
]) {
  test(scenario + " blocks prepare reuse before download or overwrite", () => {
    const fixture = makeFixture();
    try {
      write(fixture.installTarget, "untrusted existing bytes\n", 0o755);
      const before = readFileSync(fixture.installTarget, "utf8");

      const prepare = execute(fixture, "prepare-user", scenario);

      assert.notEqual(prepare.status, 0);
      assert.equal(readFileSync(fixture.installTarget, "utf8"), before);
      assert.deepEqual(actions(fixture), []);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("prepare-user blocks an incomplete existing CLI root instead of downloading or repairing it", () => {
  const fixture = makeFixture();
  try {
    mkdirSync(fixture.installRoot, { recursive: true });

    const prepare = execute(fixture, "prepare-user", "prepare-existing-partial");

    assert.notEqual(prepare.status, 0);
    assert.match(prepare.stderr, /existing CLI install is incomplete/);
    assert.deepEqual(actions(fixture), []);
    assert.ok(!existsSync(fixture.installTarget));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("prepare-user blocks a replaced CLI install-root path before download", () => {
  const fixture = makeFixture();
  try {
    const realRoot = join(fixture.root, "replacement prepare install root");
    write(join(realRoot, "supabase"), "replacement bytes\n", 0o755);
    mkdirSync(dirname(fixture.installRoot), { recursive: true });
    symlinkSync(realRoot, fixture.installRoot, "junction");

    const prepare = execute(fixture, "prepare-user", "prepare-existing-valid");

    assert.notEqual(prepare.status, 0);
    assert.match(prepare.stderr, /linked or replaced CLI install root/);
    assert.deepEqual(actions(fixture), []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("install-cli-root revalidates and rejects a CLI changed after prepare-user", () => {
  const fixture = makeFixture();
  try {
    write(fixture.installTarget, "existing approved binary bytes\n", 0o755);
    const prepare = execute(fixture, "prepare-user", "prepare-existing-valid");
    assert.equal(prepare.status, 0, prepare.stderr);
    const before = readFileSync(fixture.installTarget, "utf8");

    const install = execute(fixture, "install-cli-root", "install-existing-wrong-hash");

    assert.notEqual(install.status, 0);
    assert.match(install.stderr, /installed CLI SHA-256 mismatch/);
    assert.equal(readFileSync(fixture.installTarget, "utf8"), before);
    assert.deepEqual(actions(fixture), []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("install-cli-root reuses only an existing verified regular binary without overwrite", () => {
  const fixture = makeFixture();
  try {
    const prepare = execute(fixture, "prepare-user", "success");
    assert.equal(prepare.status, 0, prepare.stderr);
    write(fixture.installTarget, "existing approved binary bytes\n", 0o755);
    const before = readFileSync(fixture.installTarget, "utf8");

    const install = execute(fixture, "install-cli-root", "install-existing-valid");

    assert.equal(install.status, 0, install.stderr);
    assert.match(install.stdout, /install-cli-root reused_verified/);
    assert.equal(readFileSync(fixture.installTarget, "utf8"), before);
    assert.deepEqual(actions(fixture), ["curl:archive", "curl:checksums"]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const scenario of [
  "install-existing-wrong-hash",
  "install-existing-wrong-owner",
  "install-existing-wrong-mode",
]) {
  test(`${scenario} blocks reuse without overwrite`, () => {
    const fixture = makeFixture();
    try {
      const prepare = execute(fixture, "prepare-user", "success");
      assert.equal(prepare.status, 0, prepare.stderr);
      write(fixture.installTarget, "untrusted existing bytes\n", 0o755);
      const before = readFileSync(fixture.installTarget, "utf8");

      const install = execute(fixture, "install-cli-root", scenario);

      assert.notEqual(install.status, 0);
      assert.equal(readFileSync(fixture.installTarget, "utf8"), before);
      assert.deepEqual(actions(fixture), ["curl:archive", "curl:checksums"]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("an existing partial install is blocked instead of repaired", () => {
  const fixture = makeFixture();
  try {
    const prepare = execute(fixture, "prepare-user", "success");
    assert.equal(prepare.status, 0, prepare.stderr);
    mkdirSync(fixture.installRoot, { recursive: true });

    const install = execute(fixture, "install-cli-root", "install-existing-partial");

    assert.notEqual(install.status, 0);
    assert.match(install.stderr, /existing CLI install is incomplete/);
    assert.ok(!existsSync(fixture.installTarget));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a replaced install-root path is blocked before reuse", () => {
  const fixture = makeFixture();
  try {
    const prepare = execute(fixture, "prepare-user", "success");
    assert.equal(prepare.status, 0, prepare.stderr);
    const realRoot = join(fixture.root, "replacement install root");
    write(join(realRoot, "supabase"), "replacement bytes\n", 0o755);
    mkdirSync(dirname(fixture.installRoot), { recursive: true });
    symlinkSync(realRoot, fixture.installRoot, "junction");

    const install = execute(fixture, "install-cli-root", "install-existing-valid");

    assert.notEqual(install.status, 0);
    assert.match(install.stderr, /linked or replaced CLI install root/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a linked CLI binary is blocked before reuse", () => {
  const fixture = makeFixture();
  try {
    const prepare = execute(fixture, "prepare-user", "success");
    assert.equal(prepare.status, 0, prepare.stderr);
    write(fixture.installTarget, "replacement bytes\n", 0o755);

    const install = execute(fixture, "install-cli-root", "install-existing-linked-binary");

    assert.notEqual(install.status, 0);
    assert.match(install.stderr, /missing or linked file|linked or replaced CLI binary/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("install-cli-root rejects an install root outside the exact approved path", () => {
  const fixture = makeFixture();
  try {
    const prepare = execute(fixture, "prepare-user", "success");
    assert.equal(prepare.status, 0, prepare.stderr);

    const install = execute(fixture, "install-cli-root", "install-wrong-bound-root");

    assert.notEqual(install.status, 0);
    assert.match(install.stderr, /CLI install root differs from approved path/);
    assert.ok(!existsSync(fixture.installTarget));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a missing install target keeps the verified installation path", () => {
  const fixture = makeFixture();
  try {
    const prepare = execute(fixture, "prepare-user", "success");
    assert.equal(prepare.status, 0, prepare.stderr);

    const install = execute(fixture, "install-cli-root", "install-missing");

    assert.equal(install.status, 0, install.stderr);
    assert.match(install.stdout, /install-cli-root PASS/);
    assert.ok(existsSync(fixture.installTarget));
    assert.deepEqual(actions(fixture), ["curl:archive", "curl:checksums", "install:binary"]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const scenario of ["curl22", "archive-missing", "checksum-bad"]) {
  test(`${scenario} blocks dependent checksum/extract work`, () => {
    const fixture = makeFixture();
    try {
      const prepare = execute(fixture, "prepare-user", scenario);
      assert.notEqual(prepare.status, 0);
      const observed = actions(fixture);
      if (scenario === "curl22" || scenario === "archive-missing") {
        assert.deepEqual(observed, ["curl:archive"]);
      } else {
        assert.deepEqual(observed, ["curl:archive", "curl:checksums"]);
      }
      const extracted = join(
        fixture.evidence,
        fixture.runId,
        "provisioning",
        "supabase-2.95.4",
        "extract",
        "supabase",
      );
      assert.ok(!existsSync(extracted));
      const primary = readFileSync(
        join(fixture.evidence, fixture.runId, "primary-failure.tsv"),
        "utf8",
      );
      assert.ok(primary.trim().length > 0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("invalid delta count fails before curl", () => {
  const fixture = makeFixture({ deltaCount: 47 });
  try {
    const prepare = execute(fixture, "prepare-user", "success");
    assert.notEqual(prepare.status, 0);
    assert.deepEqual(actions(fixture), []);
    assert.match(prepare.stderr, /manifest\.delta-count/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("cleanup failure remains secondary and does not replace the primary exit", () => {
  const fixture = makeFixture();
  try {
    const prepare = execute(fixture, "prepare-user", "curl22");
    assert.equal(prepare.status, 22);
    const finalize = execute(fixture, "finalize-user", "cleanup-fail");
    assert.equal(finalize.status, 22);
    const primary = readFileSync(
      join(fixture.evidence, fixture.runId, "primary-failure.tsv"),
      "utf8",
    );
    const secondary = readFileSync(
      join(fixture.evidence, fixture.runId, "secondary-failures.tsv"),
      "utf8",
    );
    assert.match(primary, /cli\.download\.archive\t22/);
    assert.match(secondary, /cleanup\.remove\t9/);
    assert.ok(existsSync(join(fixture.verification, fixture.runId)));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("successful cleanup preserves the primary nonzero exit", () => {
  const fixture = makeFixture();
  try {
    const prepare = execute(fixture, "prepare-user", "curl22");
    assert.equal(prepare.status, 22);
    const finalize = execute(fixture, "finalize-user", "success");
    assert.equal(finalize.status, 22);
    const primary = readFileSync(
      join(fixture.evidence, fixture.runId, "primary-failure.tsv"),
      "utf8",
    );
    assert.match(primary, /cli\.download\.archive\t22/);
    assert.ok(!existsSync(join(fixture.verification, fixture.runId)));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("documented service and cleanup Docker binding is fail-closed and inherited by every command family", () => {
  const root = mkdtempSync(join(tmpdir(), "product-docker-context-contract-"));
  try {
    const fakeBin = join(root, "fake bin");
    const actionLog = join(root, "actions.log");
    mkdirSync(fakeBin, { recursive: true });
    for (const executable of ["docker", "supabase", "node"]) {
      write(
        join(fakeBin, executable),
        `#!/bin/sh\nprintf '%s|%s|%s\\n' '${executable}' "\${DOCKER_CONTEXT-}" "$*" >>"$ACTION_LOG"\n`,
        0o755,
      );
    }

    const bindBlock = getExecutionPackageShellBlock("product-docker-context-bind");
    const cleanupBlock = getExecutionPackageShellBlock("product-docker-context-cleanup-guard");
    const representativeCommands = `
docker create canary
docker events --since now
node integration/tools/product-service-log-collector.mjs --context "$PRODUCT_DOCKER_CONTEXT" --endpoint "$PRODUCT_DOCKER_ENDPOINT"
supabase start
supabase db reset
supabase functions serve
supabase stop
docker info
`;
    const baseEnv = {
      ...process.env,
      PATH: `${fakeBin};${process.env.PATH ?? ""}`,
      ACTION_LOG: actionLog,
      DOCKER_HOST: "",
      DOCKER_TLS_VERIFY: "",
      DOCKER_CERT_PATH: "",
      DOCKER_CONTEXT: "",
    };
    const accepted = bashRun(["-c", `${bindBlock}\n${representativeCommands}`], { env: baseEnv });
    assert.equal(accepted.status, 0, accepted.stderr);
    const records = readFileSync(actionLog, "utf8").trim().split("\n");
    assert.equal(records.length, 8);
    for (const record of records) {
      assert.equal(record.split("|")[1], environmentContract.context, record);
    }
    assert.match(records[2], new RegExp(`--context ${environmentContract.context}`));
    assert.match(
      records[2],
      new RegExp(`--endpoint ${environmentContract.endpoint.replaceAll("/", "\\/")}`),
    );
    assert.ok(!records.some((record) => /(^|\|)docker\|[^|]*\|context use(?:\s|$)/.test(record)));

    const hostileValues = ["other-context", "$HOME", "quote'\"", "back\\slash value"];
    for (const [key, value] of [
      ["DOCKER_HOST", hostileValues[1]],
      ["DOCKER_TLS_VERIFY", hostileValues[2]],
      ["DOCKER_CERT_PATH", hostileValues[3]],
      ["DOCKER_CONTEXT", hostileValues[0]],
    ]) {
      writeFileSync(actionLog, "");
      const rejected = bashRun(["-c", `${bindBlock}\ndocker info`], {
        env: { ...baseEnv, [key]: value },
      });
      assert.equal(rejected.status, 42, `${key}: ${rejected.stderr}`);
      assert.equal(rejected.stdout, "");
      assert.equal(rejected.stderr, "");
      assert.equal(readFileSync(actionLog, "utf8"), "");
    }

    writeFileSync(actionLog, "");
    const cleanupAccepted = bashRun(
      ["-c", `${bindBlock}\n${cleanupBlock}\ntest "$cleanup_context_rc" -eq 0 && docker info`],
      { env: baseEnv },
    );
    assert.equal(cleanupAccepted.status, 0, cleanupAccepted.stderr);
    assert.match(
      readFileSync(actionLog, "utf8"),
      new RegExp(`docker\\|${environmentContract.context}\\|info`),
    );

    writeFileSync(actionLog, "");
    const cleanupRejected = bashRun(
      [
        "-c",
        `${bindBlock}\nDOCKER_CONTEXT=other-context\n${cleanupBlock}\ntest "$cleanup_context_rc" -eq 0 && docker info`,
      ],
      { env: baseEnv },
    );
    assert.notEqual(cleanupRejected.status, 0);
    assert.equal(readFileSync(actionLog, "utf8"), "");

    const packageText = readFileSync(executionPackage, "utf8");
    assert.doesNotMatch(packageText, /^\s*docker context use(?:\s|$)/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
