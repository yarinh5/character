#!/usr/bin/env bash

set -o nounset -o pipefail
umask 077

usage() {
  printf '%s\n' \
    'usage: product-linux-execution.sh <prepare-user|install-cli-root|continue-user|environment-user|finalize-user> [options]' >&2
  exit 64
}

ORIGINAL_ARGUMENTS=("$@")
PHASE="${1-}"
test -n "$PHASE" || usage
shift

RUN_ID=''
SOURCE_ROOT=''
VERIFICATION_BASE=''
EVIDENCE_BASE=''
APPROVED_UID=''
APPROVED_GID=''
INSTALL_ROOT='/opt/codex-product/supabase-2.95.4'
APPROVED_INSTALL_ROOT='/opt/codex-product/supabase-2.95.4'
APPROVED_CLI_BINARY_SHA='0b47b526a2d93a9e3f29a82b2f4ac556fa983a8c67e89c2862ade94fd6220f09'
EXPECTED_SOURCE_FILES='536'
EXPECTED_DELTA_FILES='48'
EXECUTION_PACKAGE_SHA=''
PRODUCT_SOURCE_MANIFEST_SHA=''
FULL_MANIFEST_SHA=''
DELTA_MANIFEST_SHA=''
CHECKSUM_MANIFEST_SHA=''
METADATA_SHA=''
COLLECTOR_SHA=''
COLLECTOR_TEST_SHA=''
CLI_ARCHIVE_URL=''
CLI_CHECKSUMS_URL=''
CLI_ARCHIVE_SHA=''
CLI_CHECKSUMS_SHA=''
CURL_COMMAND='/usr/bin/curl'
INSTALL_COMMAND='/usr/bin/install'
RM_COMMAND='/usr/bin/rm'
SLEEP_COMMAND='/usr/bin/sleep'
DOCKER_CONTEXT_NAME=''
DOCKER_ENDPOINT=''
EXPECTED_ENGINE_ID=''
FORBIDDEN_ENGINE_ID=''
PROJECT_ID=''
PORT_RANGE_START=''
PORT_RANGE_END=''

while test "$#" -gt 0; do
  case "$1" in
    --run-id) RUN_ID="${2-}"; shift 2 ;;
    --source-root) SOURCE_ROOT="${2-}"; shift 2 ;;
    --verification-base) VERIFICATION_BASE="${2-}"; shift 2 ;;
    --evidence-base) EVIDENCE_BASE="${2-}"; shift 2 ;;
    --approved-uid) APPROVED_UID="${2-}"; shift 2 ;;
    --approved-gid) APPROVED_GID="${2-}"; shift 2 ;;
    --install-root) INSTALL_ROOT="${2-}"; shift 2 ;;
    --expected-source-files) EXPECTED_SOURCE_FILES="${2-}"; shift 2 ;;
    --expected-delta-files) EXPECTED_DELTA_FILES="${2-}"; shift 2 ;;
    --execution-package-sha) EXECUTION_PACKAGE_SHA="${2-}"; shift 2 ;;
    --product-source-manifest-sha) PRODUCT_SOURCE_MANIFEST_SHA="${2-}"; shift 2 ;;
    --full-manifest-sha) FULL_MANIFEST_SHA="${2-}"; shift 2 ;;
    --delta-manifest-sha) DELTA_MANIFEST_SHA="${2-}"; shift 2 ;;
    --checksum-manifest-sha) CHECKSUM_MANIFEST_SHA="${2-}"; shift 2 ;;
    --metadata-sha) METADATA_SHA="${2-}"; shift 2 ;;
    --collector-sha) COLLECTOR_SHA="${2-}"; shift 2 ;;
    --collector-test-sha) COLLECTOR_TEST_SHA="${2-}"; shift 2 ;;
    --cli-archive-url) CLI_ARCHIVE_URL="${2-}"; shift 2 ;;
    --cli-checksums-url) CLI_CHECKSUMS_URL="${2-}"; shift 2 ;;
    --cli-archive-sha) CLI_ARCHIVE_SHA="${2-}"; shift 2 ;;
    --cli-checksums-sha) CLI_CHECKSUMS_SHA="${2-}"; shift 2 ;;
    --curl-command) CURL_COMMAND="${2-}"; shift 2 ;;
    --install-command) INSTALL_COMMAND="${2-}"; shift 2 ;;
    --rm-command) RM_COMMAND="${2-}"; shift 2 ;;
    --sleep-command) SLEEP_COMMAND="${2-}"; shift 2 ;;
    --docker-context) DOCKER_CONTEXT_NAME="${2-}"; shift 2 ;;
    --docker-endpoint) DOCKER_ENDPOINT="${2-}"; shift 2 ;;
    --expected-engine-id) EXPECTED_ENGINE_ID="${2-}"; shift 2 ;;
    --forbidden-engine-id) FORBIDDEN_ENGINE_ID="${2-}"; shift 2 ;;
    --project-id) PROJECT_ID="${2-}"; shift 2 ;;
    --port-range-start) PORT_RANGE_START="${2-}"; shift 2 ;;
    --port-range-end) PORT_RANGE_END="${2-}"; shift 2 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage ;;
  esac
done

for required_value in \
  "$RUN_ID" "$VERIFICATION_BASE" "$EVIDENCE_BASE" "$APPROVED_UID" "$APPROVED_GID"; do
  test -n "$required_value" || usage
done

RUN_PARENT="$VERIFICATION_BASE/$RUN_ID"
RUN_ROOT="$RUN_PARENT/repository"
MANIFEST_ROOT="$RUN_PARENT/manifests"
RUN_EVIDENCE="$EVIDENCE_BASE/$RUN_ID"
PRIMARY_FAILURE="$RUN_EVIDENCE/primary-failure.tsv"
SECONDARY_FAILURES="$RUN_EVIDENCE/secondary-failures.tsv"
CLI_BACKUP_STATE="$RUN_EVIDENCE/cli-latest-backup.state.tsv"
CLI_BACKUP_STATE_PENDING="$RUN_EVIDENCE/cli-latest-backup.state.pending.tsv"

record_primary() {
  gate="$1"
  code="$2"
  detail="$3"
  if test -d "$RUN_EVIDENCE" && test ! -s "$PRIMARY_FAILURE"; then
    printf '%s\t%s\t%s\n' "$gate" "$code" "$detail" >"$PRIMARY_FAILURE"
  fi
  printf '%s: %s (exit %s)\n' "$gate" "$detail" "$code" >&2
}

stop_primary() {
  record_primary "$1" "$2" "$3"
  exit "$2"
}

append_secondary() {
  gate="$1"
  code="$2"
  detail="$3"
  if test -d "$RUN_EVIDENCE"; then
    printf '%s\t%s\t%s\n' "$gate" "$code" "$detail" >>"$SECONDARY_FAILURES"
  fi
}

require_regular_path() {
  path="$1"
  gate="$2"
  test -f "$path" && test ! -L "$path" || stop_primary "$gate" 65 "missing or linked file: $path"
}

require_hash() {
  expected="$1"
  path="$2"
  gate="$3"
  require_regular_path "$path" "$gate"
  actual="$(sha256sum "$path" | awk '{print $1}')"
  test "$actual" = "$expected" || stop_primary "$gate" 66 "SHA-256 mismatch: $path"
}

validate_existing_cli_install() {
  test "$INSTALL_ROOT" = "$APPROVED_INSTALL_ROOT" || stop_primary cli.install-target 85 'CLI install root differs from approved path'
  validated_cli_binary="$INSTALL_ROOT/supabase"
  test -d "$INSTALL_ROOT" && test ! -L "$INSTALL_ROOT" || stop_primary cli.install-target 85 'linked or replaced CLI install root'
  resolved_root="$(realpath -e "$INSTALL_ROOT")"
  rc=$?
  test "$rc" -eq 0 && test "$resolved_root" = "$INSTALL_ROOT" || stop_primary cli.install-target 85 'linked or replaced CLI install root'
  test -e "$validated_cli_binary" || stop_primary cli.install-target 85 'existing CLI install is incomplete'
  require_regular_path "$validated_cli_binary" cli.install-target
  resolved_binary="$(realpath -e "$validated_cli_binary")"
  rc=$?
  test "$rc" -eq 0 && test "$resolved_binary" = "$validated_cli_binary" || stop_primary cli.install-target 85 'linked or replaced CLI binary'
  test "$(stat -c '%u:%g' "$INSTALL_ROOT")" = '0:0' || stop_primary cli.install-owner 85 'CLI install root ownership mismatch'
  test "$(stat -c '%a' "$INSTALL_ROOT")" = '755' || stop_primary cli.install-mode 85 'CLI install root mode mismatch'
  test "$(stat -c '%u:%g' "$validated_cli_binary")" = '0:0' || stop_primary cli.install-owner 85 'CLI binary ownership mismatch'
  test "$(stat -c '%a' "$validated_cli_binary")" = '755' || stop_primary cli.install-mode 85 'CLI binary mode mismatch'
  validated_cli_hash="$(sha256sum "$validated_cli_binary" | awk '{print $1}')"
  test "$validated_cli_hash" = "$APPROVED_CLI_BINARY_SHA" || stop_primary cli.install-hash 66 'installed CLI SHA-256 mismatch'
}

write_manifest_paths() {
  awk '{
    path = $0
    sub(/^[0-9a-f]{64} [ *]/, "", path)
    print path
  }' "$MANIFEST_ROOT/integration-target-full.sha256"
}

verify_runtime_snapshot() {
  created_migration="$1"
  immutable_manifest="$RUN_EVIDENCE/snapshot-runtime.immutable.sha256"
  awk '
    {
      path = $0
      sub(/^[0-9a-f]{64} [ *]/, "", path)
      if (path == "supabase/.temp/cli-latest") {
        mutable += 1
        next
      }
      print $0
    }
    END { if (mutable != 1) exit 2 }
  ' "$MANIFEST_ROOT/integration-target-full.sha256" >"$immutable_manifest"
  rc=$?
  test "$rc" -eq 0 || stop_primary snapshot.runtime-manifest "$rc" 'mutable snapshot entry is missing or duplicated'

  immutable_count="$(wc -l <"$immutable_manifest")"
  test "$immutable_count" -eq "$((EXPECTED_SOURCE_FILES - 1))" || \
    stop_primary snapshot.runtime-count 98 "expected $((EXPECTED_SOURCE_FILES - 1)) immutable files, observed $immutable_count"
  sha256sum --check "$immutable_manifest" \
    >"$RUN_EVIDENCE/snapshot-runtime.verify.stdout" \
    2>"$RUN_EVIDENCE/snapshot-runtime.verify.stderr"
  rc=$?
  test "$rc" -eq 0 || stop_primary snapshot.runtime-hashes "$rc" 'immutable runtime snapshot verification failed'

  cli_backup="$RUN_EVIDENCE/pre-mutation-bytes/supabase/.temp/cli-latest"
  require_regular_path "$cli_backup" snapshot.runtime-backup
  expected_cli_hash="$(awk '
    {
      path = $0
      sub(/^[0-9a-f]{64} [ *]/, "", path)
      if (path == "supabase/.temp/cli-latest") print substr($0, 1, 64)
    }
  ' "$MANIFEST_ROOT/integration-target-full.sha256")"
  sha256sum "$cli_backup" >"$RUN_EVIDENCE/snapshot-runtime.cli-latest-backup.sha256"
  actual_cli_backup_hash="$(awk '{print $1}' "$RUN_EVIDENCE/snapshot-runtime.cli-latest-backup.sha256")"
  test "$actual_cli_backup_hash" = "$expected_cli_hash" || \
    stop_primary snapshot.runtime-backup-hash 100 'pre-mutation cli-latest backup differs from the approved manifest'
  stat -c '%a|%u|%g|%s|%Y|%n' "$cli_backup" \
    >"$RUN_EVIDENCE/snapshot-runtime.cli-latest-backup.stat"

  require_regular_path supabase/.temp/cli-latest snapshot.runtime-mutable
  sha256sum supabase/.temp/cli-latest >"$RUN_EVIDENCE/snapshot-runtime.cli-latest.sha256"
  stat -c '%a|%u|%g|%s|%Y|%n' supabase/.temp/cli-latest \
    >"$RUN_EVIDENCE/snapshot-runtime.cli-latest.stat"

  find . -type f -printf '%P\n' | LC_ALL=C sort >"$RUN_EVIDENCE/source-paths.runtime.txt"
  comm -13 "$RUN_EVIDENCE/manifest-paths.txt" "$RUN_EVIDENCE/source-paths.runtime.txt" \
    >"$RUN_EVIDENCE/snapshot-runtime.added-paths.txt"
  while IFS= read -r added_path; do
    test -n "$added_path" || continue
    case "$added_path" in
      node_modules/*)
        grep -Fqx -- "$added_path" "$RUN_EVIDENCE/npm-ci.paths.added.txt" || \
          grep -Fqx -- "$added_path" "$RUN_EVIDENCE/npm-rebuild.paths.added.txt" || \
          stop_primary snapshot.runtime-paths 99 "unattributed runtime path: $added_path"
        ;;
      "$created_migration")
        grep -Fqx -- "$added_path" "$RUN_EVIDENCE/migration-new.paths.added.txt" || \
          stop_primary snapshot.runtime-paths 99 "unattributed runtime path: $added_path"
        ;;
      supabase/.temp/*)
        grep -Fqx -- "$added_path" "$RUN_EVIDENCE/cli-version.paths.added.txt" || \
          grep -Fqx -- "$added_path" "$RUN_EVIDENCE/migration-new.paths.added.txt" || \
          stop_primary snapshot.runtime-paths 99 "unattributed runtime path: $added_path"
        ;;
      *) stop_primary snapshot.runtime-paths 99 "unexpected runtime path: $added_path" ;;
    esac
  done <"$RUN_EVIDENCE/snapshot-runtime.added-paths.txt"
}

validate_common_identity() {
  test "$(id -u)" = "$APPROVED_UID" || stop_primary identity 67 'unexpected uid'
  test "$(id -g)" = "$APPROVED_GID" || stop_primary identity 68 'unexpected gid'
  case ":$PATH:" in *:/mnt/c/*) stop_primary path 69 'PATH contains /mnt/c executable path' ;; esac
  test -n "${DOCKER_HOST-}" && stop_primary docker.override 42 'DOCKER_HOST is non-empty'
  test -n "${DOCKER_TLS_VERIFY-}" && stop_primary docker.override 42 'DOCKER_TLS_VERIFY is non-empty'
  test -n "${DOCKER_CERT_PATH-}" && stop_primary docker.override 42 'DOCKER_CERT_PATH is non-empty'
}

bind_approved_docker_context() {
  test -n "$DOCKER_CONTEXT_NAME" || stop_primary environment.arguments 64 'missing bound Docker context'
  case "${DOCKER_CONTEXT-}" in
    ''|"$DOCKER_CONTEXT_NAME") ;;
    *) stop_primary docker.override 42 'DOCKER_CONTEXT conflicts with approved context' ;;
  esac
  export DOCKER_CONTEXT="$DOCKER_CONTEXT_NAME"
}

prepare_user() {
  test -n "$SOURCE_ROOT" || usage
  for expected in \
    "$EXECUTION_PACKAGE_SHA" "$PRODUCT_SOURCE_MANIFEST_SHA" "$FULL_MANIFEST_SHA" \
    "$DELTA_MANIFEST_SHA" "$CHECKSUM_MANIFEST_SHA" "$METADATA_SHA" \
    "$COLLECTOR_SHA" "$COLLECTOR_TEST_SHA" "$CLI_ARCHIVE_SHA" "$CLI_CHECKSUMS_SHA" \
    "$CLI_ARCHIVE_URL" "$CLI_CHECKSUMS_URL"; do
    test -n "$expected" || usage
  done

  validate_common_identity
  test ! -e "$RUN_PARENT" || stop_primary target.exists 70 'verification target already exists'
  test ! -e "$RUN_EVIDENCE" || stop_primary evidence.exists 71 'evidence target already exists'
  test -d "$VERIFICATION_BASE" && test ! -L "$VERIFICATION_BASE" || stop_primary target.parent 72 'unsafe verification base'
  test -d "$EVIDENCE_BASE" && test ! -L "$EVIDENCE_BASE" || stop_primary evidence.parent 73 'unsafe evidence base'

  "$INSTALL_COMMAND" -d -m 0700 "$RUN_PARENT" "$RUN_ROOT" "$MANIFEST_ROOT" "$RUN_EVIDENCE"
  rc=$?
  test "$rc" -eq 0 || stop_primary target.create "$rc" 'failed to create run directories'
  : >"$PRIMARY_FAILURE"
  : >"$SECONDARY_FAILURES"
  printf '%s\t%s\n' 'not-required' 'prepare-failed-before-cli-backup' >"$CLI_BACKUP_STATE"
  printf '%q\n' "$0" "${ORIGINAL_ARGUMENTS[@]}" >"$RUN_EVIDENCE/invocation.argv.txt"
  sha256sum "$0" >"$RUN_EVIDENCE/execution-artifact.sha256"

  cp -a --no-preserve=ownership,mode -- "$SOURCE_ROOT/repository/." "$RUN_ROOT/"
  rc=$?
  test "$rc" -eq 0 || stop_primary snapshot.copy "$rc" 'repository copy failed'
  cp -a --no-preserve=ownership,mode -- "$SOURCE_ROOT/evidence/manifests/." "$MANIFEST_ROOT/"
  rc=$?
  test "$rc" -eq 0 || stop_primary manifest.copy "$rc" 'manifest copy failed'

  require_hash "$EXECUTION_PACKAGE_SHA" "$RUN_ROOT/integration/EXECUTION-PACKAGE.md" manifest.execution-package
  require_hash "$PRODUCT_SOURCE_MANIFEST_SHA" "$MANIFEST_ROOT/product-source-files.json" manifest.product-source
  require_hash "$FULL_MANIFEST_SHA" "$MANIFEST_ROOT/integration-target-full-files.json" manifest.full
  require_hash "$DELTA_MANIFEST_SHA" "$MANIFEST_ROOT/integration-target-delta.json" manifest.delta
  require_hash "$CHECKSUM_MANIFEST_SHA" "$MANIFEST_ROOT/integration-target-full.sha256" manifest.checksum
  require_hash "$METADATA_SHA" "$MANIFEST_ROOT/snapshot-metadata.json" manifest.metadata
  require_hash "$COLLECTOR_SHA" "$RUN_ROOT/integration/tools/product-service-log-collector.mjs" manifest.collector
  require_hash "$COLLECTOR_TEST_SHA" "$RUN_ROOT/integration/tools/product-service-log-collector.test.mjs" manifest.collector-test

  cd "$RUN_ROOT" || stop_primary snapshot.cwd 74 'cannot enter repository copy'
  sha256sum --check "$MANIFEST_ROOT/integration-target-full.sha256" \
    >"$RUN_EVIDENCE/snapshot.verify.stdout" 2>"$RUN_EVIDENCE/snapshot.verify.stderr"
  rc=$?
  test "$rc" -eq 0 || stop_primary snapshot.hashes "$rc" 'snapshot checksum verification failed'
  find . -type f -printf '%P\n' | LC_ALL=C sort >"$RUN_EVIDENCE/source-paths.before.txt"
  source_count="$(wc -l <"$RUN_EVIDENCE/source-paths.before.txt")"
  test "$source_count" = "$EXPECTED_SOURCE_FILES" || stop_primary snapshot.count 75 "expected $EXPECTED_SOURCE_FILES files, observed $source_count"
  write_manifest_paths | LC_ALL=C sort >"$RUN_EVIDENCE/manifest-paths.txt"
  manifest_count="$(wc -l <"$RUN_EVIDENCE/manifest-paths.txt")"
  test "$manifest_count" = "$EXPECTED_SOURCE_FILES" || stop_primary snapshot.manifest-count 75 "expected $EXPECTED_SOURCE_FILES manifest paths, observed $manifest_count"
  cmp --silent "$RUN_EVIDENCE/source-paths.before.txt" "$RUN_EVIDENCE/manifest-paths.txt" || \
    stop_primary snapshot.paths 75 'snapshot paths differ from the approved manifest'

  delta_count="$(node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!value || !Array.isArray(value.files)) process.exit(2);
    process.stdout.write(String(value.files.length));
  ' "$MANIFEST_ROOT/integration-target-delta.json")"
  rc=$?
  test "$rc" -eq 0 || stop_primary manifest.delta-json "$rc" 'delta manifest is not valid JSON with a files array'
  test "$delta_count" = "$EXPECTED_DELTA_FILES" || stop_primary manifest.delta-count 76 "expected $EXPECTED_DELTA_FILES delta entries, observed $delta_count"

  cli_backup="$RUN_EVIDENCE/pre-mutation-bytes/supabase/.temp/cli-latest"
  require_regular_path supabase/.temp/cli-latest cli.backup-source
  "$INSTALL_COMMAND" -d -m 0700 "$RUN_EVIDENCE/pre-mutation-bytes/supabase/.temp"
  cp --preserve=mode,timestamps -- supabase/.temp/cli-latest "$cli_backup"
  rc=$?
  test "$rc" -eq 0 || stop_primary cli.backup "$rc" 'cli-latest backup failed'
  require_regular_path "$cli_backup" cli.backup
  sha256sum supabase/.temp/cli-latest >"$RUN_EVIDENCE/pre-mutation-cli-latest.sha256"
  stat -c '%a|%u|%g|%s|%Y|%n' supabase/.temp/cli-latest >"$RUN_EVIDENCE/pre-mutation-cli-latest.stat"
  sha256sum "$cli_backup" >"$RUN_EVIDENCE/pre-mutation-cli-latest-backup.sha256"
  source_cli_hash="$(awk '{print $1}' "$RUN_EVIDENCE/pre-mutation-cli-latest.sha256")"
  backup_cli_hash="$(awk '{print $1}' "$RUN_EVIDENCE/pre-mutation-cli-latest-backup.sha256")"
  test "$backup_cli_hash" = "$source_cli_hash" || stop_primary cli.backup-hash 66 'cli-latest backup hash differs from source'
  cmp --silent supabase/.temp/cli-latest "$cli_backup" || stop_primary cli.backup-bytes 66 'cli-latest backup bytes differ from source'
  printf '%s\t%s\n' 'required' "$backup_cli_hash" >"$CLI_BACKUP_STATE_PENDING"
  mv -- "$CLI_BACKUP_STATE_PENDING" "$CLI_BACKUP_STATE"
  rc=$?
  test "$rc" -eq 0 || stop_primary cli.backup-state "$rc" 'cannot publish cli-latest backup state'

  test "$(node --version)" = 'v22.13.0' || stop_primary tool.node 77 'Node version mismatch'
  test "$(npm --version)" = '10.9.2' || stop_primary tool.npm 78 'npm version mismatch'
  deno_version="$(deno --version | sed -n '1s/^deno \([^ ]*\).*/\1/p')"
  test "$deno_version" = '2.1.4' || stop_primary tool.deno 79 'Deno version mismatch'
  command -v getfacl >/dev/null || stop_primary tool.acl 80 'getfacl missing'
  command -v unzip >/dev/null || stop_primary tool.unzip 81 'unzip missing'

  if test -e "$INSTALL_ROOT" || test -L "$INSTALL_ROOT"; then
    validate_existing_cli_install
    printf '%s  %s\n' "$validated_cli_hash" "$validated_cli_binary" >"$RUN_EVIDENCE/supabase-prepare-reuse.sha256"
    printf 'prepare-user reused_verified\n'
    return 0
  fi

  provisioning="$RUN_EVIDENCE/provisioning/supabase-2.95.4"
  "$INSTALL_COMMAND" -d -m 0700 "$provisioning"
  "$CURL_COMMAND" --fail --location --proto '=https' --tlsv1.2 \
    --output "$provisioning/supabase_linux_amd64.tar.gz" "$CLI_ARCHIVE_URL" \
    >"$provisioning/download-archive.stdout" 2>"$provisioning/download-archive.stderr"
  rc=$?
  test "$rc" -eq 0 || stop_primary cli.download.archive "$rc" 'archive download failed'
  require_regular_path "$provisioning/supabase_linux_amd64.tar.gz" cli.archive-present

  "$CURL_COMMAND" --fail --location --proto '=https' --tlsv1.2 \
    --output "$provisioning/supabase_2.95.4_checksums.txt" "$CLI_CHECKSUMS_URL" \
    >"$provisioning/download-checksums.stdout" 2>"$provisioning/download-checksums.stderr"
  rc=$?
  test "$rc" -eq 0 || stop_primary cli.download.checksums "$rc" 'checksums download failed'
  require_hash "$CLI_CHECKSUMS_SHA" "$provisioning/supabase_2.95.4_checksums.txt" cli.checksums-hash
  require_hash "$CLI_ARCHIVE_SHA" "$provisioning/supabase_linux_amd64.tar.gz" cli.archive-hash

  grep -F '  supabase_linux_amd64.tar.gz' "$provisioning/supabase_2.95.4_checksums.txt" \
    >"$provisioning/supabase_linux_amd64.selected.sha256"
  rc=$?
  test "$rc" -eq 0 || stop_primary cli.checksum-entry "$rc" 'archive checksum entry missing'
  test "$(wc -l <"$provisioning/supabase_linux_amd64.selected.sha256")" = '1' || stop_primary cli.checksum-entry 82 'archive checksum entry is not unique'
  (cd "$provisioning" && sha256sum --check --strict supabase_linux_amd64.selected.sha256) \
    >"$provisioning/archive.verify.txt" 2>"$provisioning/archive.verify.stderr"
  rc=$?
  test "$rc" -eq 0 || stop_primary cli.archive-checksum "$rc" 'archive checksum verification failed'

  "$INSTALL_COMMAND" -d -m 0700 "$provisioning/extract"
  tar -tzf "$provisioning/supabase_linux_amd64.tar.gz" >"$provisioning/archive.list.txt" 2>"$provisioning/archive.list.stderr"
  rc=$?
  test "$rc" -eq 0 || stop_primary cli.archive-list "$rc" 'archive listing failed'
  test "$(sed 's#^\./##' "$provisioning/archive.list.txt" | grep -xc 'supabase')" = '1' || stop_primary cli.archive-shape 83 'archive must contain one supabase executable'
  tar -xzf "$provisioning/supabase_linux_amd64.tar.gz" --no-same-owner --no-same-permissions \
    -C "$provisioning/extract" supabase >"$provisioning/archive.extract.stdout" 2>"$provisioning/archive.extract.stderr"
  rc=$?
  test "$rc" -eq 0 || stop_primary cli.archive-extract "$rc" 'archive extraction failed'
  require_regular_path "$provisioning/extract/supabase" cli.extracted-binary
  sha256sum "$provisioning/extract/supabase" >"$provisioning/extracted-binary.sha256"
  printf '%s\n' 'ready' >"$provisioning/prepare.complete"
  printf 'prepare-user PASS\n'
}

install_cli_root() {
  test "$(id -u)" = '0' || stop_primary cli.install.identity 84 'install-cli-root requires uid 0'
  installed_binary="$INSTALL_ROOT/supabase"
  if test -e "$INSTALL_ROOT" || test -L "$INSTALL_ROOT"; then
    validate_existing_cli_install
    printf '%s  %s\n' "$validated_cli_hash" "$validated_cli_binary" >"$RUN_EVIDENCE/supabase-installed.sha256"
    chown "$APPROVED_UID:$APPROVED_GID" "$RUN_EVIDENCE/supabase-installed.sha256"
    printf 'install-cli-root reused_verified\n'
    return 0
  fi

  test "$INSTALL_ROOT" = "$APPROVED_INSTALL_ROOT" || stop_primary cli.install-target 85 'CLI install root differs from approved path'
  provisioning="$RUN_EVIDENCE/provisioning/supabase-2.95.4"
  require_regular_path "$provisioning/prepare.complete" cli.install-ready
  require_regular_path "$provisioning/extract/supabase" cli.install-source
  "$INSTALL_COMMAND" -d -o root -g root -m 0755 "$INSTALL_ROOT"
  rc=$?
  test "$rc" -eq 0 || stop_primary cli.install-directory "$rc" 'CLI install directory failed'
  "$INSTALL_COMMAND" -o root -g root -m 0755 "$provisioning/extract/supabase" "$INSTALL_ROOT/supabase"
  rc=$?
  test "$rc" -eq 0 || stop_primary cli.install-binary "$rc" 'CLI binary install failed'
  installed_hash="$(sha256sum "$installed_binary" | awk '{print $1}')"
  test "$installed_hash" = "$APPROVED_CLI_BINARY_SHA" || stop_primary cli.install-hash 66 'installed CLI SHA-256 mismatch'
  printf '%s  %s\n' "$installed_hash" "$installed_binary" >"$RUN_EVIDENCE/supabase-installed.sha256"
  chown "$APPROVED_UID:$APPROVED_GID" "$RUN_EVIDENCE/supabase-installed.sha256"
  printf 'install-cli-root PASS\n'
}

continue_user() {
  validate_common_identity
  bind_approved_docker_context
  require_regular_path "$INSTALL_ROOT/supabase" cli.installed
  cd "$RUN_ROOT" || stop_primary continue.cwd 86 'cannot enter repository copy'
  before_cli="$(sha256sum supabase/.temp/cli-latest | awk '{print $1}')"
  find supabase/.temp -type f -printf 'supabase/.temp/%P\n' | LC_ALL=C sort \
    >"$RUN_EVIDENCE/cli-version.paths.before.txt"
  version="$($INSTALL_ROOT/supabase --version)"
  rc=$?
  test "$rc" -eq 0 || stop_primary cli.version "$rc" 'supabase --version failed'
  test "$version" = '2.95.4' || stop_primary cli.version 87 "unexpected CLI version: $version"
  printf '%s\n' "$version" >"$RUN_EVIDENCE/supabase-version.txt"
  find supabase/.temp -type f -printf 'supabase/.temp/%P\n' | LC_ALL=C sort \
    >"$RUN_EVIDENCE/cli-version.paths.after.txt"
  comm -13 "$RUN_EVIDENCE/cli-version.paths.before.txt" "$RUN_EVIDENCE/cli-version.paths.after.txt" \
    >"$RUN_EVIDENCE/cli-version.paths.added.txt"

  find . -type f -printf '%P\n' | LC_ALL=C sort >"$RUN_EVIDENCE/npm-ci.paths.before.txt"
  npm ci --ignore-scripts --audit=false >"$RUN_EVIDENCE/npm-ci.stdout" 2>"$RUN_EVIDENCE/npm-ci.stderr"
  rc=$?
  test "$rc" -eq 0 || stop_primary npm.ci "$rc" 'npm ci failed'
  find . -type f -printf '%P\n' | LC_ALL=C sort >"$RUN_EVIDENCE/npm-ci.paths.after.txt"
  comm -13 "$RUN_EVIDENCE/npm-ci.paths.before.txt" "$RUN_EVIDENCE/npm-ci.paths.after.txt" \
    >"$RUN_EVIDENCE/npm-ci.paths.added.txt"
  find . -type f -printf '%P\n' | LC_ALL=C sort >"$RUN_EVIDENCE/npm-rebuild.paths.before.txt"
  npm rebuild esbuild sharp workerd >"$RUN_EVIDENCE/npm-rebuild.stdout" 2>"$RUN_EVIDENCE/npm-rebuild.stderr"
  rc=$?
  test "$rc" -eq 0 || stop_primary npm.rebuild "$rc" 'approved lifecycle rebuild failed'
  find . -type f -printf '%P\n' | LC_ALL=C sort >"$RUN_EVIDENCE/npm-rebuild.paths.after.txt"
  comm -13 "$RUN_EVIDENCE/npm-rebuild.paths.before.txt" "$RUN_EVIDENCE/npm-rebuild.paths.after.txt" \
    >"$RUN_EVIDENCE/npm-rebuild.paths.added.txt"

  find supabase/migrations -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort >"$RUN_EVIDENCE/migrations.before.txt"
  find . -type f -printf '%P\n' | LC_ALL=C sort >"$RUN_EVIDENCE/migration-new.paths.before.txt"
  "$INSTALL_ROOT/supabase" migration new product_completion_read_access_gate \
    >"$RUN_EVIDENCE/migration-new.stdout" 2>"$RUN_EVIDENCE/migration-new.stderr"
  rc=$?
  test "$rc" -eq 0 || stop_primary migration.new "$rc" 'migration creation failed'
  find . -type f -printf '%P\n' | LC_ALL=C sort >"$RUN_EVIDENCE/migration-new.paths.after.txt"
  comm -13 "$RUN_EVIDENCE/migration-new.paths.before.txt" "$RUN_EVIDENCE/migration-new.paths.after.txt" \
    >"$RUN_EVIDENCE/migration-new.paths.added.txt"
  find supabase/migrations -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort >"$RUN_EVIDENCE/migrations.after.txt"
  comm -13 "$RUN_EVIDENCE/migrations.before.txt" "$RUN_EVIDENCE/migrations.after.txt" >"$RUN_EVIDENCE/migration.created.txt"
  test "$(wc -l <"$RUN_EVIDENCE/migration.created.txt")" = '1' || stop_primary migration.count 88 'migration command did not create exactly one file'
  created_migration="supabase/migrations/$(cat "$RUN_EVIDENCE/migration.created.txt")"
  case "$created_migration" in supabase/migrations/*_product_completion_read_access_gate.sql) ;; *) stop_primary migration.name 89 'unexpected migration name' ;; esac
  cp integration/candidate-migrations/product_completion_read_access_gate.sql "$created_migration"
  rc=$?
  test "$rc" -eq 0 || stop_primary migration.copy "$rc" 'candidate migration copy failed'
  cmp --silent integration/candidate-migrations/product_completion_read_access_gate.sql "$created_migration" || stop_primary migration.bytes 90 'materialized migration differs from candidate'
  printf '%s\n' 'node_modules' "$created_migration" >"$RUN_EVIDENCE/run-created-paths.txt"
  printf '%s\n' "$before_cli" >"$RUN_EVIDENCE/cli-latest.before-hash.txt"
  verify_runtime_snapshot "$created_migration"
  if test -e deno.lock || test -L deno.lock; then
    require_regular_path deno.lock deno-lock.before-path
    printf '%s\n' 'pre-existing' >"$RUN_EVIDENCE/deno-lock.before-state.txt"
    sha256sum deno.lock >"$RUN_EVIDENCE/deno-lock.before.sha256"
    stat -c '%a|%u|%g|%s|%Y|%n' deno.lock >"$RUN_EVIDENCE/deno-lock.before.stat"
  else
    printf '%s\n' 'absent' >"$RUN_EVIDENCE/deno-lock.before-state.txt"
  fi
  printf '%s\n' 'ready' >"$RUN_EVIDENCE/continue.complete"
  printf 'continue-user PASS\n'
}

environment_user() {
  validate_common_identity
  bind_approved_docker_context
  require_regular_path "$RUN_EVIDENCE/continue.complete" environment.prerequisite

  for environment_value in \
    "$DOCKER_CONTEXT_NAME" "$DOCKER_ENDPOINT" "$EXPECTED_ENGINE_ID" \
    "$FORBIDDEN_ENGINE_ID" "$PROJECT_ID" "$PORT_RANGE_START" "$PORT_RANGE_END"; do
    test -n "$environment_value" || stop_primary environment.arguments 64 'missing bound environment argument'
  done
  case "$PORT_RANGE_START:$PORT_RANGE_END" in
    *[!0-9:]*|:*|*:) stop_primary environment.arguments 64 'invalid bound port range' ;;
  esac
  test "$PORT_RANGE_START" -le "$PORT_RANGE_END" || stop_primary environment.arguments 64 'invalid bound port range'
  case "$PROJECT_ID" in *[!a-z0-9]*) stop_primary environment.arguments 64 'invalid bound project id' ;; esac

  docker context inspect "$DOCKER_CONTEXT_NAME" \
    --format '{{json .Endpoints.docker.Host}}' \
    >"$RUN_EVIDENCE/docker-endpoint.json"
  rc=$?
  test "$rc" -eq 0 || stop_primary environment.context "$rc" 'docker context inspection failed'

  observed_endpoint="$(docker context inspect "$DOCKER_CONTEXT_NAME" \
    --format '{{.Endpoints.docker.Host}}')"
  rc=$?
  test "$rc" -eq 0 || stop_primary environment.context "$rc" 'docker endpoint inspection failed'
  test "$observed_endpoint" = "$DOCKER_ENDPOINT" || stop_primary environment.endpoint 1 'docker endpoint mismatch'

  : >"$RUN_EVIDENCE/engine-stability.txt"
  for sample in 1 2 3; do
    observed_engine="$(docker info --format '{{.ID}}')"
    rc=$?
    test "$rc" -eq 0 || stop_primary environment.engine "$rc" 'docker engine inspection failed'
    test "$observed_engine" = "$EXPECTED_ENGINE_ID" || stop_primary environment.engine-id 1 'unexpected docker engine id'
    test "$observed_engine" != "$FORBIDDEN_ENGINE_ID" || stop_primary environment.engine-id 1 'forbidden docker engine id'
    observed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    rc=$?
    test "$rc" -eq 0 || stop_primary environment.evidence "$rc" 'engine timestamp failed'
    printf '%s %s\n' "$observed_at" "$observed_engine" >>"$RUN_EVIDENCE/engine-stability.txt"
    if test "$sample" != '3'; then
      "$SLEEP_COMMAND" 15
      rc=$?
      test "$rc" -eq 0 || stop_primary environment.stability "$rc" 'engine stability wait failed'
    fi
  done

  docker version --format '{{.Client.Version}}/{{.Server.Version}}' \
    >"$RUN_EVIDENCE/docker-versions.txt"
  rc=$?
  test "$rc" -eq 0 || stop_primary environment.inventory-version "$rc" 'docker version inventory failed'
  docker ps -a --no-trunc --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}' \
    >"$RUN_EVIDENCE/containers-before.txt"
  rc=$?
  test "$rc" -eq 0 || stop_primary environment.inventory-containers "$rc" 'docker container inventory failed'
  docker volume ls --format '{{.Name}}' >"$RUN_EVIDENCE/volumes-before.txt"
  rc=$?
  test "$rc" -eq 0 || stop_primary environment.inventory-volumes "$rc" 'docker volume inventory failed'
  docker network ls --no-trunc --format '{{.ID}}|{{.Name}}|{{.Driver}}' \
    >"$RUN_EVIDENCE/networks-before.txt"
  rc=$?
  test "$rc" -eq 0 || stop_primary environment.inventory-networks "$rc" 'docker network inventory failed'
  ss -ltn >"$RUN_EVIDENCE/listeners-before.txt"
  rc=$?
  test "$rc" -eq 0 || stop_primary environment.inventory-listeners "$rc" 'listener inventory failed'

  if awk -F '|' -v project="$PROJECT_ID" '$2 ~ ("^supabase_.*_" project "$") { found = 1 } END { exit found ? 0 : 1 }' \
    "$RUN_EVIDENCE/containers-before.txt"; then
    stop_primary environment.residue 1 'run project container already exists'
  fi
  if awk -v project="$PROJECT_ID" '$0 ~ ("^supabase_.*_" project "$") { found = 1 } END { exit found ? 0 : 1 }' \
    "$RUN_EVIDENCE/volumes-before.txt"; then
    stop_primary environment.residue 1 'run project volume already exists'
  fi
  if awk -F '|' -v project="$PROJECT_ID" '$2 ~ ("^supabase_.*_" project "$") { found = 1 } END { exit found ? 0 : 1 }' \
    "$RUN_EVIDENCE/networks-before.txt"; then
    stop_primary environment.residue 1 'run project network already exists'
  fi
  if awk -v first="$PORT_RANGE_START" -v last="$PORT_RANGE_END" '
    NR == 1 && $1 == "State" { next }
    {
      address = $4
      sub(/^.*:/, "", address)
      if (address ~ /^[0-9]+$/ && address + 0 >= first && address + 0 <= last) found = 1
    }
    END { exit found ? 0 : 1 }
  ' "$RUN_EVIDENCE/listeners-before.txt"; then
    stop_primary environment.residue 1 'run port already has a listener'
  fi

  printf 'environment-user PASS\n'
}

finalize_user() {
  cleanup_rc=0
  primary_rc=0
  primary_gate=''
  if test -s "$PRIMARY_FAILURE"; then
    primary_gate="$(awk -F '\t' 'NR==1 {print $1}' "$PRIMARY_FAILURE")"
    primary_rc="$(awk -F '\t' 'NR==1 {print $2}' "$PRIMARY_FAILURE")"
    case "$primary_rc" in ''|*[!0-9]*) primary_rc=1 ;; esac
  fi

  test -d "$RUN_PARENT" && test ! -L "$RUN_PARENT" || {
    append_secondary cleanup.target 91 'run target missing or linked'
    cleanup_rc=91
  }
  if test "$cleanup_rc" -eq 0; then
    resolved="$(realpath -e "$RUN_PARENT")"
    test "$resolved" = "$RUN_PARENT" || { append_secondary cleanup.path 92 'resolved target mismatch'; cleanup_rc=92; }
    test "$(stat -c '%u:%g' "$RUN_PARENT")" = "$APPROVED_UID:$APPROVED_GID" || { append_secondary cleanup.owner 93 'run target ownership mismatch'; cleanup_rc=93; }
    case "$RUN_PARENT" in "$VERIFICATION_BASE/$RUN_ID") ;; *) append_secondary cleanup.scope 94 'run target outside approved scope'; cleanup_rc=94 ;; esac
  fi

  if test "$cleanup_rc" -eq 0 && test -d "$RUN_ROOT"; then
    cd "$RUN_ROOT" || { append_secondary cleanup.cwd 95 'cannot enter repository copy'; cleanup_rc=95; }
  fi
  if test "$cleanup_rc" -eq 0; then
    cli_backup="$RUN_EVIDENCE/pre-mutation-bytes/supabase/.temp/cli-latest"
    cli_backup_hash_evidence="$RUN_EVIDENCE/pre-mutation-cli-latest-backup.sha256"
    cli_source_hash_evidence="$RUN_EVIDENCE/pre-mutation-cli-latest.sha256"
    cli_source_stat_evidence="$RUN_EVIDENCE/pre-mutation-cli-latest.stat"
    if test ! -f "$CLI_BACKUP_STATE" || test -L "$CLI_BACKUP_STATE"; then
      append_secondary cleanup.cli-backup-state 104 'cli-latest backup state is missing or linked'
      cleanup_rc=104
    else
      cli_backup_state_lines="$(awk 'END {print NR}' "$CLI_BACKUP_STATE")"
      if test "$cli_backup_state_lines" != '1'; then
        append_secondary cleanup.cli-backup-state 104 'cli-latest backup state must contain exactly one record'
        cleanup_rc=104
      fi
    fi
    if test "$cleanup_rc" -eq 0; then
      IFS="$(printf '\t')" read -r cli_backup_state cli_backup_state_value cli_backup_state_extra <"$CLI_BACKUP_STATE"
      case "$cli_backup_state" in
        not-required)
          if test "$cli_backup_state_value" != 'prepare-failed-before-cli-backup' || test -n "$cli_backup_state_extra"; then
            append_secondary cleanup.cli-backup-state 104 'invalid cli-latest not-required state'
            cleanup_rc=104
          else
            case "$primary_gate" in
              snapshot.copy|manifest.copy|manifest.execution-package|manifest.product-source|manifest.full|manifest.delta|manifest.checksum|manifest.metadata|manifest.collector|manifest.collector-test|snapshot.cwd|snapshot.hashes|snapshot.count|snapshot.manifest-count|snapshot.paths|manifest.delta-json|manifest.delta-count|cli.backup-source|cli.backup|cli.backup-hash|cli.backup-bytes|cli.backup-state) ;;
              *) append_secondary cleanup.cli-backup-state 104 'not-required cli-latest restore lacks a proven pre-backup primary failure'; cleanup_rc=104 ;;
            esac
          fi
          if test "$cleanup_rc" -eq 0 && { \
               test -e "$cli_backup" || test -L "$cli_backup" || \
               test -e "$cli_backup_hash_evidence" || test -L "$cli_backup_hash_evidence" || \
               test -e "$cli_source_hash_evidence" || test -L "$cli_source_hash_evidence" || \
               test -e "$cli_source_stat_evidence" || test -L "$cli_source_stat_evidence" || \
               test -e "$CLI_BACKUP_STATE_PENDING" || test -L "$CLI_BACKUP_STATE_PENDING"; \
             }; then
            append_secondary cleanup.cli-backup-state 104 'cli-latest backup artifacts contradict not-required state'
            cleanup_rc=104
          fi
          if test "$cleanup_rc" -eq 0; then
            printf '%s\t%s\t%s\n' 'not-applicable' 'prepare-failed-before-cli-backup' "$primary_gate" \
              >"$RUN_EVIDENCE/cli-latest-restore.result.txt"
          fi
          ;;
        required)
          case "$cli_backup_state_value" in
            ''|*[!0-9a-f]*) append_secondary cleanup.cli-backup-state 104 'invalid required cli-latest backup hash'; cleanup_rc=104 ;;
            *)
              test "${#cli_backup_state_value}" -eq 64 || {
                append_secondary cleanup.cli-backup-state 104 'invalid required cli-latest backup hash length'
                cleanup_rc=104
              }
              ;;
          esac
          test -z "$cli_backup_state_extra" || {
            append_secondary cleanup.cli-backup-state 104 'invalid required cli-latest backup state fields'
            cleanup_rc=104
          }
          if test "$cleanup_rc" -eq 0 && { test ! -f "$cli_backup" || test -L "$cli_backup"; }; then
            append_secondary cleanup.cli-backup-path 105 'required cli-latest backup is missing or linked'
            cleanup_rc=105
          fi
          for cli_backup_evidence in "$cli_backup_hash_evidence" "$cli_source_hash_evidence" "$cli_source_stat_evidence"; do
            if test "$cleanup_rc" -eq 0 && { test ! -f "$cli_backup_evidence" || test -L "$cli_backup_evidence"; }; then
              append_secondary cleanup.cli-backup-evidence 106 "required cli-latest backup evidence is missing or linked: $cli_backup_evidence"
              cleanup_rc=106
            fi
          done
          if test "$cleanup_rc" -eq 0; then
            recorded_backup_hash="$(awk 'NR==1 {print $1}' "$cli_backup_hash_evidence")"
            recorded_source_hash="$(awk 'NR==1 {print $1}' "$cli_source_hash_evidence")"
            test "$recorded_backup_hash" = "$cli_backup_state_value" && \
              test "$recorded_source_hash" = "$cli_backup_state_value" || {
                append_secondary cleanup.cli-backup-state 104 'cli-latest backup state hash contradicts backup evidence'
                cleanup_rc=104
              }
          fi
          if test "$cleanup_rc" -eq 0; then
            sha256sum --check "$cli_backup_hash_evidence" \
              >"$RUN_EVIDENCE/cli-latest-backup.verify.stdout" \
              2>"$RUN_EVIDENCE/cli-latest-backup.verify.stderr"
            rc=$?
            test "$rc" -eq 0 || { append_secondary cleanup.cli-backup-hash "$rc" 'cli-latest backup hash verification failed'; cleanup_rc="$rc"; }
          fi
          if test "$cleanup_rc" -eq 0; then
            cp --preserve=mode,timestamps -- "$cli_backup" supabase/.temp/cli-latest
            rc=$?
            test "$rc" -eq 0 || { append_secondary cleanup.restore-cli "$rc" 'cli-latest restore failed'; cleanup_rc="$rc"; }
          fi
          if test "$cleanup_rc" -eq 0; then
            cmp --silent supabase/.temp/cli-latest "$cli_backup"
            rc=$?
            test "$rc" -eq 0 || { append_secondary cleanup.restore-cli-bytes "$rc" 'cli-latest restored bytes differ'; cleanup_rc="$rc"; }
          fi
          if test "$cleanup_rc" -eq 0; then
            sha256sum --check "$cli_source_hash_evidence" \
              >"$RUN_EVIDENCE/cli-latest-restored.verify.stdout" \
              2>"$RUN_EVIDENCE/cli-latest-restored.verify.stderr"
            rc=$?
            test "$rc" -eq 0 || { append_secondary cleanup.restore-cli-hash "$rc" 'cli-latest restored hash differs'; cleanup_rc="$rc"; }
          fi
          if test "$cleanup_rc" -eq 0; then
            printf '%s\n' 'restored-and-verified' >"$RUN_EVIDENCE/cli-latest-restore.result.txt"
          fi
          ;;
        *)
          append_secondary cleanup.cli-backup-state 104 'unknown cli-latest backup state'
          cleanup_rc=104
          ;;
      esac
    fi
  fi
  if test "$cleanup_rc" -eq 0 && test -f "$RUN_EVIDENCE/continue.complete"; then
    deno_lock_state_file="$RUN_EVIDENCE/deno-lock.before-state.txt"
    if test ! -f "$deno_lock_state_file" || test -L "$deno_lock_state_file"; then
      append_secondary cleanup.deno-lock-state 101 'Deno lock ownership state is missing or linked'
      cleanup_rc=101
    else
      deno_lock_state="$(cat "$deno_lock_state_file")"
      case "$deno_lock_state" in
        pre-existing)
          if test ! -f deno.lock || test -L deno.lock; then
            append_secondary cleanup.deno-lock-path 102 'pre-existing deno.lock is missing or linked'
            cleanup_rc=102
          else
            sha256sum --check "$RUN_EVIDENCE/deno-lock.before.sha256" \
              >"$RUN_EVIDENCE/deno-lock.pre-existing.verify.stdout" \
              2>"$RUN_EVIDENCE/deno-lock.pre-existing.verify.stderr"
            rc=$?
            test "$rc" -eq 0 || {
              append_secondary cleanup.deno-lock-bytes "$rc" 'pre-existing deno.lock changed during the run'
              cleanup_rc="$rc"
            }
          fi
          ;;
        absent)
          if test -e deno.lock || test -L deno.lock; then
            if test ! -f deno.lock || test -L deno.lock; then
              append_secondary cleanup.deno-lock-path 102 'run-created deno.lock is not a regular unlinked file'
              cleanup_rc=102
            else
              mkdir -p "$RUN_EVIDENCE/run-output"
              rc=$?
              test "$rc" -eq 0 || {
                append_secondary cleanup.deno-lock-evidence "$rc" 'cannot create private Deno lock evidence directory'
                cleanup_rc="$rc"
              }
            fi
            if test "$cleanup_rc" -eq 0; then
              cp --preserve=mode,timestamps -- deno.lock "$RUN_EVIDENCE/run-output/deno.lock"
              rc=$?
              test "$rc" -eq 0 || {
                append_secondary cleanup.deno-lock-evidence "$rc" 'cannot preserve run-created deno.lock'
                cleanup_rc="$rc"
              }
            fi
            if test "$cleanup_rc" -eq 0; then
              sha256sum deno.lock >"$RUN_EVIDENCE/deno-lock.run-created.sha256"
              sha256sum "$RUN_EVIDENCE/run-output/deno.lock" >"$RUN_EVIDENCE/deno-lock.evidence.sha256"
              cmp --silent deno.lock "$RUN_EVIDENCE/run-output/deno.lock"
              rc=$?
              test "$rc" -eq 0 || {
                append_secondary cleanup.deno-lock-evidence-bytes "$rc" 'preserved deno.lock bytes differ'
                cleanup_rc="$rc"
              }
            fi
            if test "$cleanup_rc" -eq 0; then
              printf '%s\n' 'deno.lock' >>"$RUN_EVIDENCE/run-created-paths.txt"
              "$RM_COMMAND" -- deno.lock
              rc=$?
              test "$rc" -eq 0 || {
                append_secondary cleanup.deno-lock-remove "$rc" 'run-created deno.lock removal failed'
                cleanup_rc="$rc"
              }
            fi
            if test "$cleanup_rc" -eq 0 && { test -e deno.lock || test -L deno.lock; }; then
              append_secondary cleanup.deno-lock-residue 103 'run-created deno.lock remains after removal'
              cleanup_rc=103
            fi
          fi
          ;;
        *)
          append_secondary cleanup.deno-lock-state 101 'invalid Deno lock ownership state'
          cleanup_rc=101
          ;;
      esac
    fi
  fi
  if test "$cleanup_rc" -eq 0 && test -f "$MANIFEST_ROOT/integration-target-full.sha256"; then
    sha256sum --check "$MANIFEST_ROOT/integration-target-full.sha256" \
      >"$RUN_EVIDENCE/snapshot-final.verify.stdout" 2>"$RUN_EVIDENCE/snapshot-final.verify.stderr"
    rc=$?
    test "$rc" -eq 0 || { append_secondary cleanup.snapshot "$rc" 'final snapshot verification failed'; cleanup_rc="$rc"; }
  fi

  if test "$cleanup_rc" -eq 0; then
    cd "$VERIFICATION_BASE" || { append_secondary cleanup.parent 96 'cannot enter verification base'; cleanup_rc=96; }
  fi
  if test "$cleanup_rc" -eq 0; then
    "$RM_COMMAND" -rf --one-file-system -- "$RUN_PARENT"
    rc=$?
    test "$rc" -eq 0 || { append_secondary cleanup.remove "$rc" 'run target removal failed'; cleanup_rc="$rc"; }
  fi
  if test "$cleanup_rc" -eq 0; then
    test ! -e "$RUN_PARENT" || { append_secondary cleanup.residue 97 'run target still exists'; cleanup_rc=97; }
  fi

  if test -d "$RUN_EVIDENCE"; then
    printf 'primary=%s cleanup=%s\n' "$primary_rc" "$cleanup_rc" >"$RUN_EVIDENCE/finalize.result.txt"
    find "$RUN_EVIDENCE" -type f ! -name evidence-files.final.sha256 -print0 \
      | LC_ALL=C sort -z | xargs -0 sha256sum >"$RUN_EVIDENCE/evidence-files.final.sha256"
  fi

  test "$primary_rc" -eq 0 || exit "$primary_rc"
  test "$cleanup_rc" -eq 0 || exit "$cleanup_rc"
  printf 'finalize-user PASS\n'
}

case "$PHASE" in
  prepare-user) prepare_user ;;
  install-cli-root) install_cli_root ;;
  continue-user) continue_user ;;
  environment-user) environment_user ;;
  finalize-user) finalize_user ;;
  *) usage ;;
esac
