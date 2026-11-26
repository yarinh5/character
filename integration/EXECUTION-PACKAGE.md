# Product Completion integration execution package

## 1. Prepared revision and evidence boundary

This directory is a non-Git integration candidate assembled on 2026-11-06 UTC. It does not
modify either source worktree and it is not a delivery branch.

- Product Completion source: `codex/product-completion` at
  `652047682250f3f2bcbf7a921ba843cbde721d44`, including its approved local and untracked files.
- WP01.5 source: `codex/wp01-read-access` at
  `73966dd79265510352e65dcd1408d57be1b8bddc`, bound by the authoritative 34-file manifest.
- Local `origin/main` observed during preparation: `652047682250f3f2bcbf7a921ba843cbde721d44`.
  Server freshness is **NOT VERIFIED** because no fetch or network read was authorized.
- The preparation target has no `.git`, shared worktree metadata, secrets, `.env`, `node_modules`,
  database volume, or raw service capture.

The source manifests, deletion manifests and final target delta manifest are under
`../evidence/manifests`. The delta manifest must be regenerated after every approved edit and all
of its hashes must match before execution.

## 2. Integration order and reconciled contracts

1. Start from the exact Product Completion source manifest, not from its HEAD alone.
2. Overlay the 34 WP01.5 manifest entries except the four semantic overlaps.
3. Use the reconciled versions of:
   - `src/components/chat/MessageAttachment.tsx`
   - `src/hooks/useMessageAttachmentAccessMap.ts`
   - `src/integrations/supabase/types.ts`
   - `supabase/tests/http/media_authorization.integration.test.ts`
4. Preserve Product Completion Gift, `client_24h`, regular 60-second, idempotent finalize, and
   cleanup contracts. Preserve WP01.5 access-generation fencing and fail-closed UI behavior.
5. Apply all historical migrations in timestamp order. Then create a new forward-only migration
   from `integration/candidate-migrations/product_completion_read_access_gate.sql`.
   Do not edit either historical migration.
6. The new migration must be last because
   `20261105230000_wp05_regular_media_60s_policy.sql` redefines both attachment access functions
   after WP01.5. The candidate wraps the final Product implementation and gates it through
   `private.can_user_read_conversation` without changing its 11-column RPC result.
7. Serve/deploy `client-media-upload-intent`, `client-media-finalize`, `media-view-url`, and
   `cleanup-client-media` together. Activate the scheduled cleanup only after those functions,
   migrations, buckets, and secrets are verified.

An already-issued signed URL is not revocable. Revocation acceptance therefore requires denial
of all new access/RPC/media-view requests after the access-version commit; an existing URL may
remain usable only until its original short expiry.

## 3. Acceptance matrix

| Requirement                                       | Direct evidence path                                                                                                                                          | Future command                                         | PASS condition                                                                                                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WP01.5 authorization + Product attachment fields  | `authorized_read_access_revocation.test.sql`, `authorized_read_access_revocation.integration.test.ts`, `media_authorization.integration.test.ts`              | DB and targeted HTTP commands below                    | Owner/admin/current assigned operator allowed; revoked/foreign/anonymous denied; Gift/24h/60s fields remain present; new URL denied after revoke                                                                  |
| Stale release, capacity, heartbeat, cycle fencing | `wp02_handling_allocation.test.sql`, `product-completion-review-concurrency.mjs`                                                                              | DB + Product concurrency                               | Current cycle is never released from stale selection; capacity <=5; refreshed heartbeat/message wins; lock-order scenarios finish without deadlock                                                                |
| Gift Pool and sum-preserving allocation           | `wp07_wp08_gift_points.test.sql`, `product-completion-review-concurrency.mjs`                                                                                 | DB + Product concurrency                               | One eligible snapshot, deterministic remainder, no duplicate event allocation, actual allocation sum equals recorded sum                                                                                          |
| Client Gift levels and historical backfill        | `wp07_wp11_completion.test.sql`                                                                                                                               | DB pass 1 and DB pass 2                                | Started purchases do not count; canonical linkage counts once; replay/open/update are fenced; legacy events promote without a second count; repeated Admin backfill is idempotent, isolated and notification-free |
| Real image decoder and metadata removal           | `image-validation.deno-test.ts`                                                                                                                               | Deno command                                           | Corrupt signature rejected; pixel ceiling enforced; valid image becomes WebP; sensitive metadata absent                                                                                                           |
| Finalize/replay/ambiguous response                | `client-media-finalize-orchestration.test.ts`, `client-media-upload.test.tsx`, `media_authorization.integration.test.ts`                                      | focused Vitest + targeted HTTP                         | One upload/message/charge; same key replays same result; ambiguous response remains recoverable and is not destructively cleaned                                                                                  |
| Upload ambiguity and stale worker fencing         | `client-media-finalize-orchestration.test.ts`, `wp06_client_media_uploads.test.sql`, `product-completion-review-concurrency.mjs`                              | focused Vitest + DB + Product concurrency              | Late/stale worker cannot own or delete newer artifact; ambiguous Storage result has a durable cleanup path                                                                                                        |
| Expiry cleanup and worker replacement             | `wp06_client_media_uploads.test.sql`, `media_authorization.integration.test.ts`                                                                               | DB + targeted HTTP                                     | 24h entitlement expires independently of physical cleanup; <=25 claims; old token rejected; source/preview removed before durable `deleted` result                                                                |
| Cleanup scheduling                                | `.github/workflows/client-media-cleanup.yml`, `client-media-cleanup-schedule.test.ts`, `validate-client-media-cleanup-result.mjs`                             | focused Vitest, then separate GitHub activation review | Missing/false repository gate skips schedule; approved dispatch remains separate; a 2xx response passes only for complete, consistent zero-failure counts                                                         |
| RLS/Storage direct access                         | WP01.5 DB/HTTP tests and Product media HTTP test                                                                                                              | DB + targeted HTTP                                     | Direct client Storage access denied; RLS hides revoked rows; service-only resolvers are not executable by anon/authenticated                                                                                      |
| Leads and profile-image lifecycle                 | `p03_p07_profile_images.offline.test.mjs`, `wp04_profile_discovery_leads.test.sql`, `profile_image_management.test.sql`, full `src` Vitest                    | direct Offline + DBx2 + Product Vitest                 | One lead per client/character without reopening a closed lead; profile-image limit, ordering, primary fallback, ownership and safe cleanup contracts pass                                                         |
| Conversation SLA, presence and first response     | `p05_sla_presence.offline.test.mjs`, `p05_sla_presence_alerts.test.sql`, `p06_support_first_response.offline.test.mjs`, `p06_support_first_response.test.sql` | direct Offline + DBx2 + Product Vitest                 | Seven-minute alert and heartbeat rules remain distinct from the snapshotted support first-response target; duplicate/retry paths do not rewrite either event                                                      |
| Account/conversation deletion and retention       | `wp10_deletion_retention.offline.test.mjs`, `wp10_retention_minimization.offline.test.mjs`, matching pgTAP files                                              | direct Offline + DBx2 + Edge route readiness           | Cancellation/claim fencing, holds, partial minimization and fail-closed irreversible gates pass; no real deletion, scheduler or external delivery is enabled                                                      |
| Registration eligibility                          | `p06a_registration_eligibility.offline.test.mjs`, `p06a_registration_eligibility.test.sql`, full `src` Vitest                                                 | direct Offline + DBx2 + Product Vitest                 | Registration gate, authoritative email/18+ eligibility and once-only credit grant pass; missing bot/provider configuration remains fail-closed                                                                    |
| Support incidents and configuration               | `p06_support_incidents.offline.test.mjs`, `p06_configuration_connections.offline.test.mjs`, `p06_support_incidents.test.sql`, full `src` Vitest               | direct Offline + DBx2 + Product Vitest                 | Ticket ownership, internal-note separation, delivery states, admin version guards and missing-provider states are truthful                                                                                        |
| Restore-recovery gate                             | `p06_restore_recovery.offline.test.mjs`, `p06_restore_recovery.test.sql`, full `src` Vitest                                                                   | direct Offline + DBx2 + Product Vitest                 | Missing external lock/deletion/transaction authority keeps business activity blocked; replay/release remain disabled                                                                                              |

The DB, HTTP, Edge, Storage and concurrency rows above are **NOT RUN** in this preparation package.
The current offline checks do not prove their PASS conditions.

## 4. Future Linux execution target and immutable prerequisites

Every command in this section is a **future command** and requires a separate runtime or
installation authorization. No command in this section was executed while preparing this revision.
The preparation directory is source/evidence only and must never be used as a runtime directory.

Product verification is independent of WP01.5 completion. Product may start when its own isolated
Linux target, manifests, engine identity and clean-state gates pass. WP01.5 remains **OPEN**, outside
this package and without runtime authorization. Its Windows PowerShell 5.1 orchestrator, 34-file
snapshot, 13-tool manifest and B1-B7 plan are not copied, edited or invoked here. Product success
does not close WP01.5.

### Fixed preparation and finalization artifact

The preparation and finalization shell commands are frozen in
`integration/tools/product-linux-execution.sh` (SHA-256
`075e634061c79fb86e26f6eb033c236fa2ddc2cbf77f8955736d4b28957400ad`). The file is UTF-8
without a BOM and uses LF only. It replaces runtime construction of a Bash payload for the
`prepare-user`, `install-cli-root`, `continue-user`, `environment-user`, and `finalize-user` phases. The Product service
and acceptance commands later in this document remain separate approved commands; this artifact
does not replace them or change their order.

The future Windows dispatcher must keep the already-verified PowerShell `ProcessStartInfo` /
`ArgumentList` boundary and invoke the file directly through:

```text
wsl.exe -d Codex-WP015-Product-Verify-20261106 -u codex-product -- /bin/bash --noprofile --norc -n <SCRIPT_PATH>
wsl.exe -d Codex-WP015-Product-Verify-20261106 -u codex-product -- /bin/bash --noprofile --norc <SCRIPT_PATH> prepare-user <FIXED_ARGV>
wsl.exe -d Codex-WP015-Product-Verify-20261106 -u root -- /bin/bash --noprofile --norc <SCRIPT_PATH> install-cli-root <FIXED_ARGV>
wsl.exe -d Codex-WP015-Product-Verify-20261106 -u codex-product -- /bin/bash --noprofile --norc <SCRIPT_PATH> continue-user <FIXED_ARGV>
wsl.exe -d Codex-WP015-Product-Verify-20261106 -u codex-product -- /bin/bash --noprofile --norc <SCRIPT_PATH> environment-user <FIXED_ARGV>
wsl.exe -d Codex-WP015-Product-Verify-20261106 -u codex-product -- /bin/bash --noprofile --norc <SCRIPT_PATH> finalize-user <FIXED_ARGV>
```

`<SCRIPT_PATH>` must be the path to these exact bytes in the approved preparation snapshot.
`<FIXED_ARGV>` is the ordered, non-secret argument vector recorded with the derived bindings for
this revision; a future authorization may replace only the approved run identifier and approved
UID/GID literals before the first invocation. Do not use `-lc`, `eval`, an indirect expansion, or a
second quoting layer. Before any mutation, compare the script hash, run `bash -n` on the same path,
and preserve the script bytes, hash, filtered argv, and non-secret values in private run evidence.
The current immutable snapshot has 573 files and 135 delta records. It contains the approved Product
source plus the protected read-access overlays and the integration-only execution files; it is not a
copy of either source worktree alone.

The phases preserve one primary failure record. After identity, snapshot and private-evidence gates,
`prepare-user` first checks the exact approved CLI target. A verified existing CLI records
`supabase-prepare-reuse.sha256`, returns `prepare-user reused_verified`, and skips archive/checksum
download and extraction without skipping any preceding preparation gate. If the target is absent,
the verified download path remains unchanged. If the install root exists but is partial, linked,
replaced or mismatched, preparation stops without download, overwrite, deletion or repair. A failed
archive download prevents checksum download and extraction; a missing archive or bad checksum
prevents extraction and installation; any preparation failure prevents Docker and Product tests.
Before `continue-user` invokes the Supabase binary for `--version` or migration creation, the fixed
artifact rejects any non-empty `DOCKER_HOST`, `DOCKER_TLS_VERIFY`, or `DOCKER_CERT_PATH`, rejects an
external `DOCKER_CONTEXT` that differs from the bound approved literal, and exports that literal only
in the phase process environment. This prevents Docker's global `currentContext` from selecting a
different endpoint during Supabase CLI initialization. It does not edit Docker configuration and is
not a substitute for the later endpoint and Engine identity gate.
`prepare-user` records `cli-latest-backup.state.tsv` as `not-required` before the snapshot gates.
Only a byte-identical, regular, non-linked backup with matching source and backup hashes can replace
that state atomically with `required`. `finalize-user` treats the former state as restore
**NOT APPLICABLE** only when the primary-failure record identifies an allowed pre-backup gate and no
backup or partial backup evidence exists. A missing primary failure, a later gate or an interrupted
state remains fail-closed. The latter state requires
the complete evidence set, validates the backup hash before copying it, restores `cli-latest`, and
then validates bytes and the original checksum. Missing, linked, partial, corrupt, unknown or
contradictory required state remains a cleanup failure. The state is independent of
`provisioning/prepare.complete`, so verified CLI reuse follows the same restore contract.
`finalize-user` also validates ownership and the exact run target before deletion, and records
cleanup failures separately without replacing the primary exit.
Immediately after the runtime snapshot gate and before the Deno command is eligible to run,
`continue-user` records whether the exact repository-root `deno.lock` path was absent or was an
existing regular non-link file. An existing lock is hashed at that boundary and must remain
byte-identical through finalization; it is never treated as run output, overwritten or removed.
When the path was absent, finalization may attribute only a newly created regular non-link
`deno.lock` to this run. It first copies the bytes to private `run-output/deno.lock` evidence,
records hashes for the source and evidence copy, verifies the copies match, and only then removes
that exact path before the final full-snapshot check. A missing or linked state marker, linked lock,
changed pre-existing bytes, evidence failure or removal residue is a cleanup failure and preserves
the run target for review; no `*.lock` exclusion is permitted.
The delta count is parsed by Node's JSON parser rather than text matching. The future run must use
`/usr/bin/curl`, `/usr/bin/install`, and `/usr/bin/rm`; the configurable command paths exist only so
the direct Offline test can supply harmless fakes.

Both `prepare-user` and `install-cli-root` may reuse the already-installed binary only at the bound path
`/opt/codex-product/supabase-2.95.4/supabase`. Reuse requires a regular, non-linked file under a
non-linked, non-replaced install directory; root ownership and mode `0755` on both directory and
binary; and SHA-256
`0b47b526a2d93a9e3f29a82b2f4ac556fa983a8c67e89c2862ade94fd6220f09`.
`install-cli-root` repeats the complete validation at its own boundary, so a CLI changed after
preparation is rejected. A match records installed-byte evidence and returns
`install-cli-root reused_verified` without overwrite. Any existing partial or mismatched target
stops the phase without deletion or repair. A missing target continues through the existing verified
download, extraction and installation path without retry.

For one future authorized continuation, invoke only the existing dispatcher parameter with an
explicit preparation budget:

```powershell
& 'F:\project love\character\.codex-task\product-successor-connected-package-20261125-01\dispatcher\product-linux-dispatcher.ps1' -Action ContinueUser -RunId '<APPROVED_RUN_ID>' -TimeoutMs 600000
```

`600000` ms is a proposed outer bound for the complete `continue-user` preparation phase. It is not
a measured completion time, a proven fix for the observed `SIGHUP`, or a change to the dispatcher's
global default, test timeouts, assertions, retries, or any other gate budget. Live continuation
compatibility remains **NOT VERIFIED** and requires a separate authorization.

Historical evidence remains distinct:

- `authorized-01`: `curl` reported HTTP 504 / exit 22. The old shell continued into dependent
  checksum/extract work and ultimately returned zero. The evidence does not establish the cause of
  the 504.
- `authorized-02`: the preparation payload failed parsing after mutations; its full bytes were not
  preserved and are not reconstructed here. Initial cleanup also used the wrong working directory.
  The fixed artifact, syntax gate, explicit working directories, and exact-target cleanup replace
  that runtime-built payload for any future authorization.

Offline evidence for this revision is limited to Git Bash syntax and simulated command boundaries.
Linux distro parsing, ACL enforcement, installation, cleanup, Docker, Supabase, and Product runtime
remain **NOT VERIFIED** until separately authorized execution of these exact bytes.

The future Product execution copy must be an absolute path inside the local Linux filesystem, such
as `<LINUX_EXECUTION_ROOT>`, and must not be under `/mnt/c`, another host mount, a synchronized path,
the preparation target or either source worktree. Node, npm, Supabase CLI, Docker CLI, Deno and all
tests run in that same Linux environment. The Docker daemon must interpret the same Linux paths used
by the clients and runners.

### A. Required values and tool provenance

The following values are fixed for the proposed Linux lane. `<RUN_ID>`, `<APPROVED_UID>` and
`<APPROVED_GID>` are the only approval fields left open. They have no fallback and must be replaced
by approved literals before execution; a missing, empty or current-user-derived value stops the run:

| Placeholder                         | Required meaning                                                                                                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<RUN_ID>`                          | Unique approved run identifier used in resource and evidence ownership                                                                                                                                                            |
| Linux execution root                | `/srv/codex-product/verification/<RUN_ID>/repository` on the local Linux filesystem                                                                                                                                               |
| Linux manifest root                 | `/srv/codex-product/verification/<RUN_ID>/manifests`, mounted/readable as read-only during execution                                                                                                                              |
| Private evidence root               | `/srv/codex-product/evidence`, outside the execution copy and manifests                                                                                                                                                           |
| `<APPROVED_UID>` / `<APPROVED_GID>` | Numeric identity authorized to execute and collect evidence                                                                                                                                                                       |
| Docker context / endpoint           | `product-linux-unix-a6e50de2` / `unix:///run/docker.sock`; both must be observed exactly from inside the approved Linux runner. The global `desktop-linux` context and its mTLS endpoint remain unchanged.                        |
| Mount/copy canary image             | `docker.io/library/alpine@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c`                                                                                                                                |
| Loopback canary image               | `docker.io/library/nginx@sha256:583b7f2fce1cdb8da5ad5c39ebd3c33b98b87d493190e548bdee1fa8c619c311`; the pinned index contains Linux `amd64` child digest `sha256:bb8f722b4be005fcd7827816a136ab779fd40185d85b5171be915cc7fc0575c7` |
| Canary port                         | `61901`, loopback only; future listener inspection must prove it is free                                                                                                                                                          |
| Lifecycle allowlist                 | package names `esbuild`, `sharp`, and `workerd` only, at the versions already locked in `package-lock.json`                                                                                                                       |
| `<CONTAINER_ID>`                    | Exact run-owned container ID captured from the accepted engine inventory; never a name-only guess                                                                                                                                 |

Tool versions for the Product lane are fixed as follows:

| Tool              | Required Linux x86_64 artifact                                                                         | Publisher verification required before installation                                                                                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node + npm        | `https://nodejs.org/dist/v22.13.0/node-v22.13.0-linux-x64.tar.xz`; Node `22.13.0` bundles npm `10.9.2` | Verify the archive against the signed official `SHASUMS256.txt` / `.asc`; expected archive SHA-256 is `3ff0d57063c33313d73d0bdcebc4c778ad6be948234584694a042c6fe57164f6`, then require `node --version` = `v22.13.0` and `npm --version` = `10.9.2`                                                                                                           |
| Supabase CLI      | `https://github.com/supabase/cli/releases/download/v2.95.4/supabase_linux_amd64.tar.gz`                | Download `https://github.com/supabase/cli/releases/download/v2.95.4/supabase_2.95.4_checksums.txt`; require checksum-file SHA-256 `d9f63bef2e5caa9a564f21a22d88be143d7fe401f81782a8e61dd1d9d9385476`, its exact `supabase_linux_amd64.tar.gz` entry, and archive SHA-256 `01a3b8f5861d108a934937cae88e8d503093c3f7d3aa32d959f69b099b4f9ef3` before extraction |
| Deno              | `https://github.com/denoland/deno/releases/download/v2.1.4/deno-x86_64-unknown-linux-gnu.zip`          | Verify against the matching official `deno-x86_64-unknown-linux-gnu.zip.sha256sum` asset before extraction, then require `deno --version` = `2.1.4`                                                                                                                                                                                                           |
| Docker CLI/server | No version is approved by this document                                                                | Record exact client/server versions and compatibility during the future preflight                                                                                                                                                                                                                                                                             |

A Windows executable hash is not valid proof for a Linux executable. The future target must first
prove `uname -m` is `x86_64`; another architecture stops provisioning. No artifact was downloaded or
installed in this preparation step. The checksum files/signatures and downloaded bytes must be
stored in private provisioning evidence before use; a missing checksum entry or signature/checksum
failure stops installation.

Official provenance used for this decision:

- Node archive and signed sums: `https://nodejs.org/en/download/archive/v22.13.0` and
  `https://nodejs.org/dist/v22.13.0/SHASUMS256.txt.asc`.
- Supabase CLI v2.95.4 release metadata, checksums and archive contract:
  `https://github.com/supabase/cli/releases/tag/v2.95.4` and the tag's `.goreleaser.yml`
  at commit `fac4104d03f9f4b72df7892bde060057d6354649`.
- Deno manual artifact/checksum contract:
  `https://github.com/denoland/docs/blob/main/runtime/getting_started/installation.md`.
- Alpine Official Image tag/index digest:
  `https://hub.docker.com/_/alpine/tags?name=3.21.3&page=1`.
- NGINX Official Image metadata and build sources: Docker Hub tag `1.30.6-alpine`, Official Images
  commit `4b9f658be76820b24e4ef4605413a5c08707a512`, `stable/alpine/Dockerfile` SHA-256
  `09fd90b6cb9eb388a9ccf7b1a452de2f94ed5b01123beab02dce2560f9c273aa`, inherited
  `stable/alpine-slim/Dockerfile` SHA-256
  `b7641577d4118be19a03e2d8ac6a6e3ae1aeba5baa29fd5351efc4d4f9da9bb3`, and
  `entrypoint/docker-entrypoint.sh` SHA-256
  `3372fd90162da30d09f62c245e9c6bfd620fb0bb5b48ab54b16e804c2b9e8aae`.

Future shell setup, from Bash in a clean non-debug shell (`set -x` must remain disabled):

```bash
set +o errexit
set -o nounset -o pipefail
umask 077
export PATH='/opt/codex-product/node-v22.13.0-linux-x64/bin:/opt/codex-product/deno-2.1.4:/opt/codex-product/supabase-2.95.4:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

export RUN_ID='<RUN_ID>'
export INTEGRATION_RUN_ROOT="/srv/codex-product/verification/$RUN_ID/repository"
export INTEGRATION_MANIFEST_ROOT="/srv/codex-product/verification/$RUN_ID/manifests"
export PRIVATE_EVIDENCE_ROOT='/srv/codex-product/evidence'
export APPROVED_UID='<APPROVED_UID>'
export APPROVED_GID='<APPROVED_GID>'
# product-docker-context-bind:start
case "${DOCKER_HOST-}" in '') ;; *) exit 42 ;; esac
case "${DOCKER_TLS_VERIFY-}" in '') ;; *) exit 42 ;; esac
case "${DOCKER_CERT_PATH-}" in '') ;; *) exit 42 ;; esac
case "${DOCKER_CONTEXT-}" in ''|'product-linux-unix-a6e50de2') ;; *) exit 42 ;; esac
export PRODUCT_DOCKER_CONTEXT='product-linux-unix-a6e50de2'
export PRODUCT_DOCKER_ENDPOINT='unix:///run/docker.sock'
export DOCKER_CONTEXT="$PRODUCT_DOCKER_CONTEXT"
# product-docker-context-bind:end
export PRODUCT_EXPECTED_ENGINE_ID='a6e50de2-c013-4dd4-b12e-c966081e1f40'
export PRODUCT_FORBIDDEN_ENGINE_ID='e4a8242c-6ed6-4be2-91d0-64ea7a7a1cfb'
export PRODUCT_PROJECT_ID='qmgkmsarzfjnqltljkjl'
export CANARY_IMAGE='docker.io/library/alpine@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c'
export LOOPBACK_CANARY_IMAGE='docker.io/library/nginx@sha256:583b7f2fce1cdb8da5ad5c39ebd3c33b98b87d493190e548bdee1fa8c619c311'
export CANARY_PORT='61901'
export APPROVED_LIFECYCLE_PACKAGE_LIST='esbuild sharp workerd'

test -n "$RUN_ID"
test "${INTEGRATION_RUN_ROOT#/}" != "$INTEGRATION_RUN_ROOT"
test "${INTEGRATION_MANIFEST_ROOT#/}" != "$INTEGRATION_MANIFEST_ROOT"
test "${PRIVATE_EVIDENCE_ROOT#/}" != "$PRIVATE_EVIDENCE_ROOT"
case "$INTEGRATION_RUN_ROOT" in /mnt/*) exit 41 ;; esac
test "$INTEGRATION_RUN_ROOT" != "$PRIVATE_EVIDENCE_ROOT"
test "$APPROVED_UID" != '<APPROVED_UID>'
test "$APPROVED_GID" != '<APPROVED_GID>'
```

`errexit` is intentionally disabled. Every future gate records its own exit code and then follows the
explicit branch table below; an early shell exit must not bypass evidence preservation or cleanup.
This is an operator procedure, not a new persisted wrapper or a change to any runner.

### B. Private evidence boundary

Create one new run directory outside both repository and execution copy. The executing process must
already have the approved UID/GID; the commands must not accept the current identity automatically.

```bash
test "$(id -u)" = "$APPROVED_UID"
test "$(id -g)" = "$APPROVED_GID"
test ! -e "$PRIVATE_EVIDENCE_ROOT/$RUN_ID"
install -d -m 0700 "$PRIVATE_EVIDENCE_ROOT/$RUN_ID"
export RUN_EVIDENCE="$PRIVATE_EVIDENCE_ROOT/$RUN_ID"
test ! -L "$RUN_EVIDENCE"
test "$(stat -c '%u' "$RUN_EVIDENCE")" = "$APPROVED_UID"
test "$(stat -c '%g' "$RUN_EVIDENCE")" = "$APPROVED_GID"
test "$(stat -c '%a' "$RUN_EVIDENCE")" = '700'
command -v getfacl >/dev/null
namei -l "$RUN_EVIDENCE" >"$RUN_EVIDENCE/parent-path.txt"
getfacl -cp --absolute-names "$RUN_EVIDENCE" >"$RUN_EVIDENCE/acl.txt"
findmnt -T "$RUN_EVIDENCE" >"$RUN_EVIDENCE/filesystem.txt"
printf '%s\n' 'product-evidence-canary-v1' >"$RUN_EVIDENCE/canary.txt"
test "$(cat "$RUN_EVIDENCE/canary.txt")" = 'product-evidence-canary-v1'
sha256sum "$RUN_EVIDENCE/canary.txt" >"$RUN_EVIDENCE/canary.sha256"
```

PASS requires no symlink/reparse-equivalent component, approved owner/group, mode `0700`, no named
ACL entry granting another identity, and no writable parent controlled by an unapproved identity.
The filesystem source/type from `findmnt -T "$RUN_EVIDENCE"` must show an approved local filesystem,
not a host share, network share or synchronized mount. Raw status output, credentials and service
logs remain inside this directory. Public reports contain only sanitized categories, timestamps,
sizes and hashes.

Linux mode bits are not equivalent to Windows ACLs. `root` and identities with access to the Docker
daemon remain privileged and can bypass ordinary file isolation; their membership and authorization
must be recorded as part of the target approval. Evidence-capture failure is secondary and must not
replace the primary test failure.

### C. Snapshot, mutable bytes and run-output fencing

The approved source snapshot is exactly the 573 files in `integration-target-full.sha256`. It is distinct
from future run-owned additions and from existing bytes that a CLI may mutate:

| Class                       | Exact contract                                                                                                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approved source snapshot    | All 573 manifest paths and hashes; no missing, extra or mismatched source file before mutation                                                                                                                                         |
| Expected future additions   | `node_modules/**`; one recorded `supabase/migrations/*_product_completion_read_access_gate.sql`; `.product-canary`; `dist/**`; `.wrangler/**`. Each path must first appear in a before/after inventory for the command that creates it |
| Existing mutable path       | `supabase/.temp/cli-latest` (currently an approved 8-byte source file). Back up bytes, metadata and hash before any Supabase CLI command, including `supabase --version`                                                               |
| Runtime-generated CLI state | Any other path created under `supabase/.temp/**` is accepted only when its exact relative path is captured as the delta of one authorized CLI invocation; it is run output, never a new source file                                    |

Before any installation, version command or mutation:

```bash
printf '%s\t%s\n' 'not-required' 'prepare-failed-before-cli-backup' \
  >"$RUN_EVIDENCE/cli-latest-backup.state.tsv"
cd "$INTEGRATION_RUN_ROOT"
test "$(pwd -P)" = "$INTEGRATION_RUN_ROOT"
test ! -L "$INTEGRATION_RUN_ROOT"
sha256sum --check "$INTEGRATION_MANIFEST_ROOT/integration-target-full.sha256"
find . -type f -printf '%P\n' | LC_ALL=C sort >"$RUN_EVIDENCE/source-paths.before.txt"
test "$(wc -l <"$RUN_EVIDENCE/source-paths.before.txt")" = '573'
sed -E 's/^[0-9a-f]{64} [ *]//' \
  "$INTEGRATION_MANIFEST_ROOT/integration-target-full.sha256" \
  | LC_ALL=C sort >"$RUN_EVIDENCE/manifest-paths.txt"
cmp --silent "$RUN_EVIDENCE/source-paths.before.txt" "$RUN_EVIDENCE/manifest-paths.txt"

install -d -m 0700 "$RUN_EVIDENCE/pre-mutation-bytes/supabase/.temp"
cp --preserve=mode,timestamps -- \
  supabase/.temp/cli-latest \
  "$RUN_EVIDENCE/pre-mutation-bytes/supabase/.temp/cli-latest"
sha256sum supabase/.temp/cli-latest \
  >"$RUN_EVIDENCE/pre-mutation-cli-latest.sha256"
stat -c '%a|%u|%g|%s|%Y|%n' supabase/.temp/cli-latest \
  >"$RUN_EVIDENCE/pre-mutation-cli-latest.stat"
sha256sum "$RUN_EVIDENCE/pre-mutation-bytes/supabase/.temp/cli-latest" \
  >"$RUN_EVIDENCE/pre-mutation-cli-latest-backup.sha256"
# After the source and backup hashes and bytes match, publish atomically:
# required<TAB><the verified 64-character backup SHA-256>
sha256sum integration/candidate-migrations/product_completion_read_access_gate.sql \
  supabase/config.toml package-lock.json \
  >"$RUN_EVIDENCE/pre-mutation-critical-files.sha256"
```

PASS before mutation requires all 573 bytes and paths plus the delta/full/metadata bindings to
match. Checking only the 54-record delta is insufficient. `continue-user` then runs the fixed runtime
snapshot gate: it derives and verifies the 537 immutable manifest entries; requires the exact saved
`pre-mutation-bytes/supabase/.temp/cli-latest` backup to be a regular non-link file whose bytes
match the authoritative manifest entry; requires the live mutable `supabase/.temp/cli-latest` path
to remain a regular non-link file; and compares every additional file with the exact additions
recorded by the CLI, install and migration commands. Its evidence is `snapshot-runtime.*`; a failed
or missing result stops startup. The backup is compared with the manifest, not with the live mutable
file. Do not repeat the full 573-entry
checksum after an authorized CLI invocation, because that would incorrectly compare the documented
mutable path with its pre-mutation bytes.

After every future mutating command, capture sorted before/after inventories and their exact set
difference. At finalization remove only paths recorded as created by this run and matching one of the
five expected-addition classes above; never delete by a repository-wide glob. A valid `required`
state first requires the complete backup evidence and verifies the backup itself, then restores
`supabase/.temp/cli-latest` from the saved bytes and requires both `cmp --silent` and the original
SHA-256 before the full 573-entry checksum is required again. A valid `not-required` state produces
`not-applicable<TAB>prepare-failed-before-cli-backup<TAB><primary-gate>` evidence and performs no backup comparison;
the same state with any backup artifact is contradictory and fails closed. This restores files, not
database or volume state.

### D. Environment and engine gate

No Docker environment override may silently supersede the approved context. The same fail-closed
context binding used before the first Supabase CLI invocation is repeated at the independent
`environment-user` process boundary. After `continue-user` passes and before any canary or service
command, invoke the fixed dispatcher action below. It
executes the byte-bound `environment-user` phase under the approved identity and PATH, requires the
fixed `continue.complete` prerequisite, and receives the context, endpoint, expected and forbidden
Engine IDs, project ID and port range as literal bound arguments. It does not rely on exports from a
previous shell. Any non-empty `DOCKER_HOST`, `DOCKER_TLS_VERIFY`, or `DOCKER_CERT_PATH`, or a
non-empty external `DOCKER_CONTEXT` other than the approved literal, stops with exit 42 before the
first Docker command without printing or clearing its value:

```powershell
& 'F:\project love\character\.codex-task\product-successor-connected-package-20261125-01\dispatcher\product-linux-dispatcher.ps1' -Action EnvironmentGate -RunId '<APPROVED_RUN_ID>'
```

Only a structured result with `timedOut=false`, `exitCode=0`, and stdout exactly
`environment-user PASS` permits canaries or services. Do not reconstruct any part of this gate in
PowerShell, JavaScript or an ad-hoc Bash payload. The fixed phase performs both context inspections,
requires endpoint `unix:///run/docker.sock`, samples Engine ID three times with the two existing
15-second intervals, rejects the forbidden Engine ID, and records `docker-endpoint.json`,
`engine-stability.txt`, `docker-versions.txt`, `containers-before.txt`, `volumes-before.txt`,
`networks-before.txt` and `listeners-before.txt` inside the private run evidence boundary. It also
requires no resource name matching `supabase_*_qmgkmsarzfjnqltljkjl` and no listener on
`60420-60430`; foreign resources remain recorded and untouched. Command failure codes are preserved
as the primary failure, mismatches/residue return 1, and successful finalization cannot replace that
primary failure.

The three observations are one defined stability gate, not retries. Any unavailable endpoint,
changed ID, forbidden ID or unknown result stops the run; there is no automatic restart or repair.

The mount and copy canaries keep the reviewed official Alpine `3.21.3` index digest and commands that
already passed. Loopback alone uses the pinned official NGINX `1.30.6-alpine` index above. The
Official Images manifest lists `amd64`; its pinned build installs NGINX, retains `/bin/sh`, exposes
port `80`, and defines an entrypoint that ultimately executes the supplied command. The future
preflight must prove both pinned images resolve for `linux/amd64` and that port `61901` is unoccupied.
This preparation verifies metadata and source only; live image compatibility is **NOT VERIFIED**.
All three canaries use synthetic bytes only:

```bash
test "${CANARY_IMAGE#*@sha256:}" != "$CANARY_IMAGE"
test "$CANARY_IMAGE" = 'docker.io/library/alpine@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c'
test "${LOOPBACK_CANARY_IMAGE#*@sha256:}" != "$LOOPBACK_CANARY_IMAGE"
test "$LOOPBACK_CANARY_IMAGE" = 'docker.io/library/nginx@sha256:583b7f2fce1cdb8da5ad5c39ebd3c33b98b87d493190e548bdee1fa8c619c311'
test "$CANARY_PORT" = '61901'
! ss -ltnH | awk '{print $4}' | grep -Eq '(^|:)61901$'
printf '%s\n' 'product-linux-mount-canary-v1' >"$INTEGRATION_RUN_ROOT/.product-canary"
sha256sum "$INTEGRATION_RUN_ROOT/.product-canary" >"$RUN_EVIDENCE/product-canary.sha256"

mount_name="product-mount-$RUN_ID"
mount_id="$(docker create --name "$mount_name" --mount \
  "type=bind,src=$INTEGRATION_RUN_ROOT,dst=/workspace,readonly" \
  "$CANARY_IMAGE" sh -c 'sha256sum /workspace/.product-canary')"
printf '%s\n' "$mount_id" >"$RUN_EVIDENCE/canary-mount.id"
docker start --attach "$mount_id"

copy_name="product-copy-$RUN_ID"
copy_id="$(docker create --name "$copy_name" "$CANARY_IMAGE" \
  sh -c 'sha256sum /tmp/product-canary')"
printf '%s\n' "$copy_id" >"$RUN_EVIDENCE/canary-copy.id"
docker cp "$INTEGRATION_RUN_ROOT/.product-canary" "$copy_id:/tmp/product-canary"
docker start --attach "$copy_id"

loop_name="product-loopback-$RUN_ID"
docker pull --platform linux/amd64 "$LOOPBACK_CANARY_IMAGE" \
  >"$RUN_EVIDENCE/loopback-image-pull.stdout" \
  2>"$RUN_EVIDENCE/loopback-image-pull.stderr"
test "$(docker image inspect "$LOOPBACK_CANARY_IMAGE" --format '{{.Os}}/{{.Architecture}}')" = 'linux/amd64'
docker image inspect "$LOOPBACK_CANARY_IMAGE" \
  >"$RUN_EVIDENCE/loopback-image.inspect.json"
loop_id="$(docker run --detach --name "$loop_name" --publish "127.0.0.1:$CANARY_PORT:80" \
  --entrypoint /bin/sh "$LOOPBACK_CANARY_IMAGE" -c \
  'printf %s loopback-v2 >/usr/share/nginx/html/index.html && exec nginx -g "daemon off;"')"
printf '%s\n' "$loop_id" >"$RUN_EVIDENCE/canary-loopback.id"
loopback_ready=0
for loopback_sample in $(seq 1 10); do
  loopback_state="$(docker inspect --format '{{.State.Status}}/{{.State.ExitCode}}' "$loop_id")"
  case "$loopback_state" in running/*) ;; *) break ;; esac
  if curl --fail --silent --show-error --connect-timeout 1 --max-time 1 \
       "http://127.0.0.1:$CANARY_PORT/" \
       >"$RUN_EVIDENCE/loopback-response.pending" \
       2>>"$RUN_EVIDENCE/loopback-readiness.stderr"; then
    test "$(cat "$RUN_EVIDENCE/loopback-response.pending")" = 'loopback-v2' || break
    mv "$RUN_EVIDENCE/loopback-response.pending" "$RUN_EVIDENCE/loopback-response.txt"
    loopback_ready=1
    break
  fi
  test "$loopback_sample" = '10' || sleep 1
done
docker inspect "$loop_id" >"$RUN_EVIDENCE/canary-loopback.inspect.json"
docker logs --timestamps "$loop_id" >"$RUN_EVIDENCE/canary-loopback.logs.txt" \
  2>"$RUN_EVIDENCE/canary-loopback.logs.stderr"
test "$loopback_ready" = '1'
```

The readiness loop makes at most ten one-second HTTP probes with at most nine one-second waits, so its
request/wait budget is at most 19 seconds. It never restarts or recreates the container. Capture image
ID/digest, exit state, logs and filtered inspect before removing only the three run-owned containers.
Revalidate Engine ID before each removal. Do not prune or remove images, volumes or networks.

### E. Future tool and dependency materialization

The approved target architecture is Linux `x86_64`. Provisioning is a separate future authorization.
Artifact acquisition must use the literal URLs in section A and store the archives plus publisher
checksum/signature files in private evidence. The verifier must:

```bash
test "$(uname -m)" = 'x86_64'
# Node: verify SHASUMS256.txt.asc with the approved Node release-key set, then:
printf '%s  %s\n' \
  '3ff0d57063c33313d73d0bdcebc4c778ad6be948234584694a042c6fe57164f6' \
  'node-v22.13.0-linux-x64.tar.xz' | sha256sum --check --strict
# Supabase: download only the pinned v2.95.4 release artifacts into private provisioning evidence:
SUPABASE_PROVISIONING_DIR="$RUN_EVIDENCE/provisioning/supabase-2.95.4"
install -d -m 0700 "$SUPABASE_PROVISIONING_DIR"
(
  cd "$SUPABASE_PROVISIONING_DIR"
  curl --fail --location --proto '=https' --tlsv1.2 \
    --output supabase_linux_amd64.tar.gz \
    'https://github.com/supabase/cli/releases/download/v2.95.4/supabase_linux_amd64.tar.gz'
  curl --fail --location --proto '=https' --tlsv1.2 \
    --output supabase_2.95.4_checksums.txt \
    'https://github.com/supabase/cli/releases/download/v2.95.4/supabase_2.95.4_checksums.txt'
  printf '%s  %s\n' \
    'd9f63bef2e5caa9a564f21a22d88be143d7fe401f81782a8e61dd1d9d9385476' \
    'supabase_2.95.4_checksums.txt' | sha256sum --check --strict
  grep -F '  supabase_linux_amd64.tar.gz' supabase_2.95.4_checksums.txt \
    >supabase_linux_amd64.selected.sha256
  test "$(wc -l <supabase_linux_amd64.selected.sha256)" = '1'
  printf '%s  %s\n' \
    '01a3b8f5861d108a934937cae88e8d503093c3f7d3aa32d959f69b099b4f9ef3' \
    'supabase_linux_amd64.tar.gz' | cmp --silent - supabase_linux_amd64.selected.sha256
  sha256sum --check --strict supabase_linux_amd64.selected.sha256
  install -d -m 0700 extract
  test "$(tar -tzf supabase_linux_amd64.tar.gz | sed 's#^\./##' | grep -xc 'supabase')" = '1'
  tar -xzf supabase_linux_amd64.tar.gz --no-same-owner --no-same-permissions \
    -C extract supabase
  test -f extract/supabase
)
# A separately authorized root provisioning step installs this verified byte sequence only:
install -d -o root -g root -m 0755 /opt/codex-product/supabase-2.95.4
install -o root -g root -m 0755 "$SUPABASE_PROVISIONING_DIR/extract/supabase" \
  /opt/codex-product/supabase-2.95.4/supabase
# Deno: verify the publisher's matching single-asset checksum file:
sha256sum --check --strict deno-x86_64-unknown-linux-gnu.zip.sha256sum
```

An absent filename, unsigned/unapproved Node key, checksum mismatch or architecture mismatch stops
provisioning. These verification commands were **NOT EXECUTED** here.

The Deno environment gate must execute the following exact command block. It reuses the artifact's
existing first-token decoder while preserving the `deno --version` exit status separately. The
comparison is exact: build metadata after `2.1.4` is allowed, while an empty/malformed value,
`2.1.40`, any other version, or a nonzero Deno exit stops the gate.

<!-- product-deno-version-gate:start -->

```bash
deno_version_output="$(deno --version)"
deno_rc=$?
test "$deno_rc" -eq 0 || exit "$deno_rc"
deno_version="$(printf '%s\n' "$deno_version_output" | sed -n '1s/^deno \([^ ]*\).*/\1/p')"
test -n "$deno_version" || exit 1
test "$deno_version" = '2.1.4'
```

<!-- product-deno-version-gate:end -->

| CWD                          | Future command                           | Prerequisite and side effect                                                                                             | PASS / stop condition                                                                                                                               |
| ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$INTEGRATION_RUN_ROOT`      | `node --version`                         | Approved installed artifact; read-only                                                                                   | Exactly `v22.13.0`                                                                                                                                  |
| same                         | `npm --version`                          | Read-only                                                                                                                | Exactly `10.9.2`                                                                                                                                    |
| same, after section C backup | `supabase --version`                     | May rewrite existing `supabase/.temp/cli-latest`; capture before/after bytes, hash and path delta in the disposable copy | Exactly `2.95.4`; only the documented mutable path may change, and finalization restores it                                                         |
| same                         | Exact documented Deno version gate above | Read-only                                                                                                                | Deno exits 0 and its decoded version token is exactly `2.1.4`; record cache location without printing credentials                                   |
| same                         | `npm ci --ignore-scripts --audit=false`  | Separate network/install authorization; writes run-owned `node_modules`                                                  | Lockfile unchanged; exit 0; lifecycle scripts did not run; npm's automatic advisory-resolution phase did not run                                    |
| same                         | `npm rebuild esbuild sharp workerd`      | Separate lifecycle authorization; runs only the locked package-name scripts                                              | All locked `esbuild` instances (`0.25.12`, `0.27.7`, `0.27.3`), `sharp@0.34.5` and `workerd@1.20260518.1` complete; no other lifecycle package runs |

`package-lock.json` marks install scripts for the three `esbuild` copies, `sharp`, `workerd` and the
optional macOS-only `fsevents`. The Vite config uses the Cloudflare build plugin, which reaches the
`workerd`/`sharp` path, while Vite and Wrangler reach the locked `esbuild` copies. Therefore the
minimal Linux allowlist is `esbuild sharp workerd`; `fsevents` is excluded. Do not silently rerun
`--audit=false` applies only to dependency materialization: npm 10 enables its automatic audit report
by default, and the failed authorized-01 attempt reached that advisory-resolution path immediately
before Windows recorded system commit exhaustion. The Product package has no audit acceptance gate,
so this flag does not skip a Product assertion or alter the lockfile. It removes that unrelated,
resource-intensive install subphase; it is not proof that host memory pressure is resolved and does
not authorize an `npm audit` or `audit fix`. `npm ci` must not run with scripts enabled. If a required dependency cannot operate with this allowlist, stop and
request approval for that exact package and script.

Materialize the reviewed forward-only migration only after the dependency stage passes:

```bash
cd "$INTEGRATION_RUN_ROOT"
find supabase/migrations -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort \
  >"$RUN_EVIDENCE/migrations.before.txt"
supabase migration new product_completion_read_access_gate
find supabase/migrations -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort \
  >"$RUN_EVIDENCE/migrations.after.txt"
comm -13 "$RUN_EVIDENCE/migrations.before.txt" "$RUN_EVIDENCE/migrations.after.txt" \
  >"$RUN_EVIDENCE/migration.created.txt"
test "$(wc -l <"$RUN_EVIDENCE/migration.created.txt")" = '1'
created_migration="supabase/migrations/$(cat "$RUN_EVIDENCE/migration.created.txt")"
case "$created_migration" in supabase/migrations/*_product_completion_read_access_gate.sql) ;; *) exit 43 ;; esac
cp integration/candidate-migrations/product_completion_read_access_gate.sql "$created_migration"
cmp --silent integration/candidate-migrations/product_completion_read_access_gate.sql "$created_migration"
sha256sum integration/candidate-migrations/product_completion_read_access_gate.sql \
  "$created_migration" >"$RUN_EVIDENCE/materialized-migration.sha256"
```

This writes exactly one new migration in the disposable execution copy. It does not apply it.

### F. Exit-code ledger and branch discipline

Do not use `set -e`. Every future command is run as a named gate with stdout/stderr already directed
to private evidence. The following is the literal inline pattern; it is repeated around each command
and is not saved or sourced as a wrapper:

```bash
export GATE_LEDGER="$RUN_EVIDENCE/gates.tsv"
export PRIMARY_FAILURE="$RUN_EVIDENCE/primary-failure.tsv"
export SECONDARY_FAILURES="$RUN_EVIDENCE/secondary-failures.tsv"
: >"$GATE_LEDGER"
: >"$PRIMARY_FAILURE"
: >"$SECONDARY_FAILURES"

gate='offline.focused' # replace with the table's exact gate id
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
npm exec -- vitest run src/test/message-attachment-access-generation.test.tsx \
  >"$RUN_EVIDENCE/$gate.stdout" 2>"$RUN_EVIDENCE/$gate.stderr"
gate_rc=$?
ended="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\t%s\t%s\t%s\n' "$gate" "$started" "$ended" "$gate_rc" >>"$GATE_LEDGER"
if test "$gate_rc" -ne 0 && test ! -s "$PRIMARY_FAILURE"; then
  printf '%s\t%s\n' "$gate" "$gate_rc" >"$PRIMARY_FAILURE"
fi
```

After any nonzero result, do not execute the next command mechanically. Apply this branch table and
then run the finalization commands in section 6 regardless of whether another independent group is
allowed:

| Failed gate                                     | Dependent work stopped                            | Work that may continue only after the stated revalidation                                                                                                |
| ----------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| source/identity/context/engine/port/canary      | All mutation and service work                     | None                                                                                                                                                     |
| install or migration materialization            | All tests requiring that output; all service work | Other already-materialized offline checks only when their inputs still hash correctly                                                                    |
| one offline Vitest/typecheck/build/Deno gate    | That gate only                                    | Other offline gates after source hashes and target identity still match                                                                                  |
| `service.start`                                 | Reset, Edge, DB, concurrency, HTTP                | None; capture inventory and finalize owned resources                                                                                                     |
| `service.reset` or migration application        | DB, concurrency, Edge/HTTP                        | None; schema is unknown, so capture and finalize                                                                                                         |
| DB pass 1                                       | DB pass 2, concurrency and HTTP                   | Unrelated offline groups only; pass 2 is not a retry                                                                                                     |
| a concurrency suite                             | Remaining service gates                           | Another concurrency suite only when the existing runner's postflight proves no run-owned sessions, locks or fixtures and engine/schema checks still pass |
| Edge serve/readiness                            | HTTP and Storage-dependent gates                  | DB/concurrency only when schema, engine and fixtures remain proven                                                                                       |
| HTTP pass 1                                     | HTTP pass 2 and scheduler evidence                | Unrelated offline groups only; pass 2 is not a retry                                                                                                     |
| evidence persistence, collector stop or cleanup | No new gate                                       | Preserve the first gate failure; append this failure to `secondary-failures.tsv` and stop further destructive cleanup if ownership is uncertain          |

DBx2 and HTTPx2 remain two preplanned identical invocations. The second invocation is permitted only
after the first passed and its residue/baseline checks passed. No failed invocation is rerun, and no
timeout, assertion or skip changes.

### G. Independent offline gates

```bash
cd "$INTEGRATION_RUN_ROOT"
npm exec -- vitest run src/test/message-attachment-access-generation.test.tsx src/test/product-completion-read-access-integration.test.ts src/test/client-media-cleanup-schedule.test.ts src/test/client-media-finalize-orchestration.test.ts src/test/client-media-upload.test.tsx src/test/gift-attachment-flow.test.tsx src/test/regular-media-window.test.tsx src/test/operator-chat-readonly.test.tsx src/test/conversation-presence-revocation.test.tsx
npm run typecheck
node --test supabase/tests/database/v4_3/p03_p07_profile_images.offline.test.mjs
node --test supabase/tests/database/v4_3/p05_sla_presence.offline.test.mjs
node --test supabase/tests/database/v4_3/wp03_outreach_retirement.offline.test.mjs
node supabase/tests/database/v4_3/p06_configuration_connections.offline.test.mjs
node supabase/tests/database/v4_3/p06_restore_recovery.offline.test.mjs
node supabase/tests/database/v4_3/p06_support_first_response.offline.test.mjs
node supabase/tests/database/v4_3/p06_support_incidents.offline.test.mjs
node supabase/tests/database/v4_3/p06a_registration_eligibility.offline.test.mjs
node --test supabase/tests/database/v4_3/wp05_regular_media_policy.offline.test.mjs
node --test supabase/tests/database/v4_3/wp06b_media_cleanup.offline.test.mjs
node --test supabase/tests/database/v4_3/wp08_operator_points_migration.offline.test.mjs
node --test supabase/tests/database/v4_3/wp09_client_levels_migration.offline.test.mjs
node --test supabase/tests/database/v4_3/wp10_deletion_retention.offline.test.mjs
node --test supabase/tests/database/v4_3/wp10_retention_minimization.offline.test.mjs
node --test supabase/tests/database/v4_3/wp11_server_analytics.offline.test.mjs supabase/tests/database/v4_3/wp11_admin_completion_exception_cases.offline.test.mjs supabase/tests/database/v4_3/wp11_admin_role_transition.offline.test.mjs supabase/tests/database/v4_3/wp11_operator_report_moderation.offline.test.mjs supabase/tests/database/v4_3/wp11_operator_report_page.offline.test.mjs
```

<!-- product-vitest-gate:start -->

```bash
npm exec -- vitest run src
```

<!-- product-vitest-gate:end -->

```bash
npm run build
deno test --node-modules-dir=none --allow-read supabase/functions/client-media-finalize/image-validation.deno-test.ts
```

Each command is a separate gate. PASS requires exit 0, expected inventory and no new skip. The Deno
test uses the production ImageMagick WASM import. `--node-modules-dir=none` prevents the repository's
root `package.json` from forcing Deno 2 into manual `node_modules` resolution for the pinned `npm:`
specifier. An empty Deno cache requires pre-approved network access to the pinned
`npm:@imagemagick/magick-wasm@0.0.30` module before this gate can run; that authorization must be
settled before the next live attempt. The exact `deno.lock` ownership state recorded by
`continue-user` governs preservation and cleanup after this command; the lock is not excluded from
integrity checks. The Product Vitest gate is limited to the complete `src` tree.
The current candidate inventory is deliberately split as follows:

| Inventory                                               | Count | Gate                                                               |
| ------------------------------------------------------- | ----: | ------------------------------------------------------------------ |
| Product Offline tests under `src/**`                    |    82 | `npm exec -- vitest run src`                                       |
| HTTP integration tests under `supabase/tests/http/**`   |     8 | the separate HTTP runner in section H                              |
| Deno decoder test                                       |     1 | the explicit `deno test --node-modules-dir=none ...` command above |
| Direct Offline DB/migration contract files              |    22 | nineteen files in section G, plus three direct packaging regressions |
| `node:test` tools/orchestration/migration safety suites |    24 | their explicit Node package/orchestration commands; never Vitest   |

The Product inventory includes `src/lib/slaMonitoring.test.ts`, `src/components/ui/dialog.test.tsx`
and both `src/test/client-withdraw-like.test.tsx` and `src/test/client-liked-entries.test.tsx`. The 24 `node:test` suites comprise the two files under
`integration/tools`, four orchestration-safety files, 17 direct Offline database/migration
contracts, and the approved shared port-binding contract at
`supabase/tests/local-docker-port-contract.test.mjs`. Five additional direct contracts are plain
Node programs rather than `node:test` suites. This revision adds the exact node:test inventory path
`supabase/tests/database/v4_3/handling_shadow_foundation.offline.test.mjs` plus
`supabase/tests/database/v4_3/handling_claim_expiry.offline.test.mjs` and the forward-only
shared writer barrier correction; live migration/pgTAP acceptance remains separate. The cycle-bound operator-send fixture revision adds
`supabase/tests/database/v4_3/cycle_bound_operator_send.offline.test.mjs` as a direct packaging regression.
None of these files is browser-bundled by Vitest.
Record command, UTC start/end, exit code, tested hashes and sanitized output. Offline failure does not
block another independent offline gate, but no command is automatically retried and no
timeout/assertion/skip is changed.

### H. Product service lane

Before startup, repeat the source/addition fence and invoke the same fixed dispatcher
`EnvironmentGate` action again; do not copy or reconstruct its context, endpoint, Engine ID,
inventory or port commands. Then repeat the canaries. Start the run-owned Docker event stream before
the first service command; events are
resource-lifecycle evidence only and are not service stdout/stderr. Then start the reviewed collector
and wait for its fail-closed ready record before `supabase start`:

Run the collector start, readiness checks, service gates and final collector `kill`/`wait` in one
continuous non-interactive Bash process. Do not wrap the background launch in an outer interactive
shell or in `bash -c`: `$!` must be the direct `node` child of the same shell whose `$$` is recorded
and whose `wait` drains it. The exact external command used in authorized-07 was not preserved; its
evidence proves only that the recorded PID identified a Bash wrapper, so this instruction does not
claim to reconstruct that missing invocation.

That same continuous shell must first execute the `product-docker-context-bind` block from section A.
The exported `DOCKER_CONTEXT` is inherited by every `docker`, `supabase`, event, canary and cleanup
process; the collector additionally receives the identical context and endpoint as explicit arguments.
Never run `docker context use`, and never fall back to the Docker CLI default target.

```bash
# Parse collector drain and summary handling before the first service-lane mutation. The later
# finalization path invokes this function in this same managing shell so PPID and wait ownership
# remain unchanged, while no large collector-cleanup body is delivered through late stdin.
# product-collector-stop-function:start
product_stop_collector_and_verify_summary() {
# product-collector-owner-before-stop:start
  collector_stop_pid_file_rc=0
  if test "$(cat "$RUN_EVIDENCE/service-log-collector.pid" 2>/dev/null)" = "$PRODUCT_COLLECTOR_PID"; then
    :
  else
    collector_stop_pid_file_rc=$?
  fi

  collector_stop_owner_rc=71
  if test "$collector_stop_pid_file_rc" -eq 0; then
    node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const [pid, expectedPpid, expectedRunId, procRoot = "/proc"] = process.argv.slice(1);
    try {
      if (!/^[1-9][0-9]*$/.test(pid) || !/^[1-9][0-9]*$/.test(expectedPpid)) process.exit(71);
      const status = readFileSync(`${procRoot}/${pid}/status`, "utf8");
      const parent = status.match(/^PPid:[\t ]*([0-9]+)$/m)?.[1];
      const argv = readFileSync(`${procRoot}/${pid}/cmdline`)
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
      const entrypoint = argv.indexOf("integration/tools/product-service-log-collector.mjs");
      const runId = argv.indexOf("--run-id");
      if (
        parent !== expectedPpid ||
        entrypoint < 1 ||
        !/(^|\/)node$/.test(argv[entrypoint - 1] ?? "") ||
        runId < 0 ||
        argv[runId + 1] !== expectedRunId
      ) process.exit(71);
    } catch {
      process.exit(71);
    }
  ' "$PRODUCT_COLLECTOR_PID" "$$" "$RUN_ID" /proc
    collector_stop_owner_rc=$?
  fi

  if test "$collector_stop_pid_file_rc" -eq 0 && test "$collector_stop_owner_rc" -eq 0; then
    if test -n "${PRODUCT_COLLECTOR_PID-}" && \
       kill -0 "$PRODUCT_COLLECTOR_PID" 2>/dev/null; then
      kill -INT "$PRODUCT_COLLECTOR_PID" 2>/dev/null
      collector_stop_rc=$?
      wait "$PRODUCT_COLLECTOR_PID" 2>/dev/null
      collector_wait_rc=$?
      if test "$collector_stop_rc" -ne 0 || test "$collector_wait_rc" -ne 0; then
        printf 'PRODUCT_COLLECTOR_PID\tstop=%s\twait=%s\n' \
          "$collector_stop_rc" "$collector_wait_rc" >>"$SECONDARY_FAILURES"
      fi
    else
      printf 'PRODUCT_COLLECTOR_PID\tmissing-before-drain\n' >>"$SECONDARY_FAILURES"
    fi
  else
    printf 'collector.ownership\tpid-file=%s\towner=%s\n' \
      "$collector_stop_pid_file_rc" "$collector_stop_owner_rc" >>"$SECONDARY_FAILURES"
  fi
# product-collector-owner-before-stop:end
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const summary = JSON.parse(readFileSync(process.argv[1], "utf8"));
    if (summary.complete !== true || summary.gaps.length || summary.failures.length || summary.missingServices.length) process.exit(1);
  ' "$RUN_EVIDENCE/service-log-collector/collector-summary.json"
  collector_summary_rc=$?
  test "$collector_summary_rc" -eq 0 || \
    printf 'collector.summary\t%s\n' "$collector_summary_rc" >>"$SECONDARY_FAILURES"
}
# product-collector-stop-function:end

cd "$INTEGRATION_RUN_ROOT"
docker events --since "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >"$RUN_EVIDENCE/docker-events.jsonl" 2>"$RUN_EVIDENCE/docker-events.stderr" &
export PRODUCT_EVENTS_PID="$!"
printf '%s\n' "$PRODUCT_EVENTS_PID" >"$RUN_EVIDENCE/docker-events.pid"

install -d -m 0700 "$RUN_EVIDENCE/service-log-collector"
node integration/tools/product-service-log-collector.mjs \
  --run-id "$RUN_ID" \
  --evidence-root "$RUN_EVIDENCE/service-log-collector" \
  --context "$PRODUCT_DOCKER_CONTEXT" \
  --endpoint "$PRODUCT_DOCKER_ENDPOINT" \
  --engine-id "$PRODUCT_EXPECTED_ENGINE_ID" \
  --project-id "$PRODUCT_PROJECT_ID" \
  --uid "$APPROVED_UID" \
  --gid "$APPROVED_GID" \
  --max-event-reconnects 1 \
  --max-log-reconnects 1 \
  --shutdown-timeout-ms 5000 \
  >"$RUN_EVIDENCE/service-log-collector.control.stdout" \
  2>"$RUN_EVIDENCE/service-log-collector.control.stderr" &
export PRODUCT_COLLECTOR_PID="$!"
printf '%s\n' "$PRODUCT_COLLECTOR_PID" >"$RUN_EVIDENCE/service-log-collector.pid"

# product-collector-owner-before-readiness:start
collector_pid_file_rc=0
if test "$(cat "$RUN_EVIDENCE/service-log-collector.pid" 2>/dev/null)" = "$PRODUCT_COLLECTOR_PID"; then
  :
else
  collector_pid_file_rc=$?
fi

collector_owner_rc=71
if test "$collector_pid_file_rc" -eq 0; then
  node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const [pid, expectedPpid, expectedRunId, procRoot = "/proc"] = process.argv.slice(1);
  try {
    if (!/^[1-9][0-9]*$/.test(pid) || !/^[1-9][0-9]*$/.test(expectedPpid)) process.exit(71);
    const status = readFileSync(`${procRoot}/${pid}/status`, "utf8");
    const parent = status.match(/^PPid:[\t ]*([0-9]+)$/m)?.[1];
    const argv = readFileSync(`${procRoot}/${pid}/cmdline`)
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    const entrypoint = argv.indexOf("integration/tools/product-service-log-collector.mjs");
    const runId = argv.indexOf("--run-id");
    if (
      parent !== expectedPpid ||
      entrypoint < 1 ||
      !/(^|\/)node$/.test(argv[entrypoint - 1] ?? "") ||
      runId < 0 ||
      argv[runId + 1] !== expectedRunId
    ) process.exit(71);
  } catch {
    process.exit(71);
  }
' "$PRODUCT_COLLECTOR_PID" "$$" "$RUN_ID" /proc
  collector_owner_rc=$?
fi

collector_ready=0
if test "$collector_pid_file_rc" -eq 0 && test "$collector_owner_rc" -eq 0; then
  for collector_sample in $(seq 1 30); do
    if test -s "$RUN_EVIDENCE/service-log-collector/collector-failed.json"; then break; fi
    if ! kill -0 "$PRODUCT_COLLECTOR_PID" 2>/dev/null; then break; fi
    if test -s "$RUN_EVIDENCE/service-log-collector/collector-ready.json"; then
      collector_ready=1
      break
    fi
    sleep 1
  done
fi

collector_readiness_rc=0
if test "$collector_pid_file_rc" -ne 0 || \
   test "$collector_owner_rc" -ne 0 || \
   test "$collector_ready" -ne 1 || \
   test -e "$RUN_EVIDENCE/service-log-collector/collector-failed.json" || \
   ! kill -0 "$PRODUCT_COLLECTOR_PID" 2>/dev/null; then
  collector_readiness_rc=71
fi

if test "$collector_readiness_rc" -eq 0; then
  export PRODUCT_SERVICE_LANE_ALLOWED=1
else
  export PRODUCT_SERVICE_LANE_ALLOWED=0
  printf 'collector.readiness\t%s\tpid-file=%s\towner=%s\n' \
    "$collector_readiness_rc" "$collector_pid_file_rc" "$collector_owner_rc" >>"$GATE_LEDGER"
  if test ! -s "$PRIMARY_FAILURE"; then
    printf 'collector.readiness\t%s\n' "$collector_readiness_rc" >"$PRIMARY_FAILURE"
  fi
fi
# product-collector-owner-before-readiness:end
```

No service-dependent command may be dispatched unless
`PRODUCT_SERVICE_LANE_ALLOWED` is exactly `1`. A zero value follows the section F branch discipline:
preserve `primary-failure.tsv`, skip every service command, and continue only with ownership-safe
finalization. This branch is the enforcing guard; the individual PID and ownership checks are not
relied on through shell `errexit`.

The helper entrypoint is `integration/tools/product-service-log-collector.mjs`, SHA-256
`77be2c6405a25cd103c398643d761995f7ef925e95947e12e7035caaae1ce83a`. It accepts no implicit
Docker target, strips Docker environment overrides from children, revalidates context endpoint and
Engine ID before every reconnect, and binds only exact Storage, Kong, DB, Auth and Edge Runtime names
whose project label equals `$PRODUCT_PROJECT_ID`. It starts its own filtered event subscription before
inventory, deduplicates by full container ID and attaches `docker logs --follow --timestamps --tail
all` to replacements. Raw stdout/stderr are streamed into separate exclusive mode-`0600` files under
the protected root; console output and public metadata remain sanitized. Any attach, persistence,
engine or coverage gap immediately publishes `collector-failed.json` and makes the final summary
incomplete. If that health signal itself cannot be persisted, the helper initiates its common stop
path, so the process check also fails closed.

Project-labelled containers whose exact names are outside those five required services are recorded
by full container ID in `collector-summary.json` under `nonRequiredContainers`. The record contains
only sanitized lifecycle action/time metadata and an explicit `logCapture.status=not_collected` with
reason `outside_required_service_coverage`; it neither claims a service segment nor expands required
coverage. Missing or contradictory event identity remains an immediate fail-closed coverage gap
before inspect.

Short-lived `getfacl`, Docker context, engine, inventory and inspect processes use the same owned-child
set as event/log processes. Once stop begins no additional discovery child may start; an owned
discovery child that remains open is signalled and included in the bounded shutdown result.

Before every new service-dependent gate or group, repeat these three literal checks. Failure before
startup blocks startup. Failure during the run blocks every new service-dependent group, preserves
the first product failure separately, and proceeds only to ownership-safe finalization; it never
authorizes restart, retry, repair or a context fallback:

```bash
kill -0 "$PRODUCT_COLLECTOR_PID"
test -s "$RUN_EVIDENCE/service-log-collector/collector-ready.json"
test ! -e "$RUN_EVIDENCE/service-log-collector/collector-failed.json"
```

The 30 samples are only a bounded collector-readiness gate. They are not a service retry and do not
prove Docker/Linux compatibility. With the ready record present, execute the following gates one at
a time with the section F ledger pattern and branch table:

| Gate id                        | Exact future command                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `service.start`                | `supabase start`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `service.reset`                | `supabase db reset --local --no-seed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `upgrade.shadow-113-116`       | `npm run test:upgrade:wp01`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `db.1` / `db.2`                | `npm run test:db` (same inventory, two planned successful invocations)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `concurrency.claim`            | `npm run test:concurrency`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `concurrency.handling`         | `npm run test:handling-concurrency`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `concurrency.cycle-bound-send` | `npm run test:cycle-bound-send-concurrency`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `concurrency.read-access`      | `npm run test:read-access-concurrency`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `concurrency.product`          | `node supabase/tests/concurrency/product-completion-review-concurrency.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `http.1` / `http.2`            | `npm run test:http -- supabase/tests/http/active_new_responsibility_send.integration.test.ts supabase/tests/http/admin_operations_snapshot.integration.test.ts supabase/tests/http/authorization_new.integration.test.ts supabase/tests/http/authorized_read_access_revocation.integration.test.ts supabase/tests/http/client_pii_archive.integration.test.ts supabase/tests/http/media_authorization.integration.test.ts supabase/tests/http/paid_sticker.integration.test.ts supabase/tests/http/wp11_admin_status.integration.test.ts` (the complete eight-file HTTP inventory, two planned successful invocations) |

`supabase start` and `supabase db reset --local --no-seed` mutate only the accepted isolated stack.
Reset destroys and recreates the disposable local database, applies every migration including the
materialized gate, and deliberately does not load seed data. `upgrade.shadow-113-116` performs its
own destructive versioned reset/migration rehearsal inside the same isolated project. Before that
rehearsal mutates the database, the runner captures the complete canonical migration-version list
from the already verified frozen-candidate evidence plus the separately materialized, byte-verified
gate migration. Cleanup must restore that exact ordered list: a missing, extra, duplicate or replaced
version fails even when `count` and `latest` happen to match. The existing schema/data reset
invariants remain independently required; migration-list equality alone is not database identity.
Before either the supported upgrade rehearsal or DB runner validates a Docker-published port, the
shared direct inspect boundary writes a filtered record to `$RUN_EVIDENCE/port-bindings`. The record
contains the inspected container ID, active config path and expected HostPort, the exact internal
`8000/tcp` or `5432/tcp` key, every returned `HostIp`/`HostPort` pair, and the query exit/stderr state;
it never records full inspect output or Env. The accepted contract is at least one binding, with
every binding using the config-derived port and one of `127.0.0.1`, `::1`, `0.0.0.0`, or `::`.
Unauthorized adjacent entries, missing/malformed data and exact duplicates fail closed. Evidence
preparation or persistence failure blocks the Docker query or validation and cannot become PASS.
Each runner process creates one invocation UUID and includes it in every filtered binding-evidence
filename and record that it writes. The per-process sequence follows that UUID, so the separate
planned `db.1` and `db.2` processes retain distinct immutable records in the same directory while
exclusive `wx` creation continues to fail closed on any real filename collision.
Before each pgTAP result is parsed or its process status is validated, the DB runner writes the
available full stdout/stderr and structured process status to an immutable record under
`$RUN_EVIDENCE/db-tap`. Each runner process uses its own invocation UUID plus a local sequence and
test basename, so `db.1` and `db.2` cannot overwrite one another. Evidence persistence failure is a
blocking secondary failure and preserves any already-known SQL process or TAP failure as primary.
The two later upgrade runners, `test:upgrade:wp01-strict-send` and
`test:upgrade:wp01-read-access`, now resolve the PATH-bound `supabase` executable used by the
approved Linux environment. Their orchestration regressions pass Offline, but the runners remain
outside this live run order and are **NOT RUN LIVE**. Revalidate endpoint and Engine ID after
start, reset, the supported upgrade rehearsal, DBx2, concurrency and HTTPx2; an unknown schema,
fixture, session or lock state stops dependent work.
Run the five concurrency commands serially and never overlap them with DB or HTTP.

#### Edge serving and readiness

Supabase's official CLI reference defines `supabase functions serve` with no function name as “Serve
all Functions locally.” The config reference defines missing `functions.<name>.enabled` and
`verify_jwt` values as `true`. Therefore the three unlisted Product directories are not disabled by
their missing sections. No code/config change and no `--no-verify-jwt` flag is required.

After `service.start` and `service.reset` pass, serve all functions from the repository root as one
run-owned foreground process redirected to private evidence. The HTTP acceptance includes expired
client media cleanup. Enable it explicitly for this verified, disposable Product DB and Storage
only; the worker remains disabled by default. Do not use this setting against QA, a restore target,
or a shared stack.

```bash
cd "$INTEGRATION_RUN_ROOT"
edge_acceptance_env="$RUN_EVIDENCE/edge-local-acceptance.env"
(umask 077; set -o noclobber; printf '%s\n' 'CLIENT_MEDIA_CLEANUP_ENABLED=true' >"$edge_acceptance_env") || exit 1
supabase functions serve --env-file "$edge_acceptance_env" \
  >"$RUN_EVIDENCE/edge-serve.stdout" \
  2>"$RUN_EVIDENCE/edge-serve.stderr" &
export PRODUCT_EDGE_SERVE_PID="$!"
printf '%s\n' "$PRODUCT_EDGE_SERVE_PID" >"$RUN_EVIDENCE/edge-serve.pid"

edge_ready=0
for readiness_sample in $(seq 1 60); do
  ready_count=0
  for function_name in \
    account-deletion-cancel account-deletion-cancel-request account-deletion-request \
    account-deletion-verify admin-media-upload-intent admin-sticker-upload-intent \
    cleanup-client-media client-media-finalize client-media-upload-intent \
    delete-character-media delete-sticker-media media-view-url process-character-media \
    process-deletion-workflows process-restore-recovery process-sticker-media \
    product-configuration-status; do
    status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
      --request POST "http://127.0.0.1:60421/functions/v1/$function_name")"
    test "$status" = '401' && ready_count=$((ready_count + 1))
  done
  if test "$ready_count" = '17'; then edge_ready=1; break; fi
  sleep 1
done
test "$edge_ready" = '1'
```

The 60 samples are one bounded readiness gate, not test retries. A `401` proves the route is served
and JWT enforcement rejects an unauthenticated POST; it does not prove authorized behavior. The
subsequent HTTP tests must prove authorized user/service-role paths. The local stack injects
`SUPABASE_URL`, publishable/anon and service-role/secret variables; the acceptance env file contains
only the non-secret cleanup opt-in. Raw status/secrets remain private. A missing function,
bucket (`client-media`/`character-media`), injected variable, permission or decoder stops
HTTP/Storage-dependent work. Finalization sends `INT` to the saved Edge PID and records `wait` as a
secondary failure if needed.

PASS requires: DB inventory passed twice; five concurrency suites passed with barriers and zero
owned residue; all seventeen Edge routes passed the unauthenticated 401 readiness check; the complete
eight-file HTTP inventory passed twice; direct Storage/RLS denial; one message/charge; same-key replay; real decode;
expiry/cleanup; unchanged event-residue counters; and verified fixture, session and lock cleanup.

Official behavior sources:

- `https://supabase.com/docs/reference/cli/introduction` (`supabase functions serve`).
- `https://supabase.com/docs/guides/local-development/cli/config` (function defaults).
- `https://supabase.com/docs/guides/functions/secrets` (local injected variables and env files).
- `https://supabase.com/docs/guides/functions/auth-headers` (default JWT check).

### I. Scheduler activation and deactivation — separate GitHub approval

The workflow is inert in this non-Git snapshot. Its scheduled job runs only when repository variable
`CLIENT_MEDIA_CLEANUP_SCHEDULE_ENABLED` is exactly `true`; a missing, empty or other value skips it.
Manual `workflow_dispatch` is separate and requires `execute_cleanup=true`.

Activation order:

1. deliver the reviewed workflow/helper and deploy the accepted migrations and Edge functions;
2. configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as repository secrets, leaving the
   schedule variable absent/false;
3. dispatch once with `execute_cleanup=true` and accept only a 2xx response whose body contains
   non-negative safe-integer `claimed`, `deleted`, `failed`, satisfies
   `claimed = deleted + failed`, and has `failed = 0`;
4. inspect backlog and run evidence, then set `CLIENT_MEDIA_CLEANUP_SCHEDULE_ENABLED=true` in a
   separately approved repository-settings action.

HTTP/curl failure remains the primary failure; the validator is not invoked in that branch. On a
2xx response, malformed JSON, missing/invalid counts, inconsistent counts, or `failed > 0` fails the
run without printing the raw response. There is no same-run retry.

To suspend scheduling, set the variable to `false` or remove it. To retire the workflow, first
suspend it, verify no run is active, then remove/disable the workflow and revoke its credentials in
separately approved actions. A five-minute cron is best-effort GitHub scheduling, not a five-minute
execution SLA. One serialized run claims at most 25 rows; backlog observation remains operational
evidence, not a timing guarantee.

## 5. Failure boundaries, evidence, cleanup and restoration

Source/full-manifest mismatch, context/endpoint/Engine ID drift, unknown DB state, migration failure,
unready Edge routes, unsafe cleanup state or foreign resource stops every dependent mutation. There
is no automatic engine restart, repair, context switch, fallback, retry, timeout change or assertion
change. Independent continuation is exactly the section F branch table.

The future execution operator must enter finalization after success or failure. The following
commands are run with `errexit` still disabled so each secondary result is recorded. They are not an
authorization to execute now:

```bash
# 1. Stop only the explicit Edge serve child; keep events and the approved service-log collector
# running through plain service stop so they capture replacement and shutdown output.
if test -n "${PRODUCT_EDGE_SERVE_PID-}" && \
   kill -0 "$PRODUCT_EDGE_SERVE_PID" 2>/dev/null; then
  kill -INT "$PRODUCT_EDGE_SERVE_PID" 2>/dev/null
  edge_stop_rc=$?
  wait "$PRODUCT_EDGE_SERVE_PID" 2>/dev/null
  edge_wait_rc=$?
  if test "$edge_stop_rc" -ne 0 || test "$edge_wait_rc" -ne 0; then
    printf 'PRODUCT_EDGE_SERVE_PID\tstop=%s\twait=%s\n' \
      "$edge_stop_rc" "$edge_wait_rc" >>"$SECONDARY_FAILURES"
  fi
fi

# 2. Revalidate the exact cleanup target. Failure stops destructive cleanup.
# product-docker-context-cleanup-guard:start
cleanup_context_rc=0
case "${DOCKER_HOST-}" in '') ;; *) cleanup_context_rc=42 ;; esac
case "${DOCKER_TLS_VERIFY-}" in '') ;; *) cleanup_context_rc=42 ;; esac
case "${DOCKER_CERT_PATH-}" in '') ;; *) cleanup_context_rc=42 ;; esac
case "${DOCKER_CONTEXT-}" in 'product-linux-unix-a6e50de2') ;; *) cleanup_context_rc=42 ;; esac
test "${PRODUCT_DOCKER_CONTEXT-}" = 'product-linux-unix-a6e50de2' || cleanup_context_rc=42
test "${PRODUCT_DOCKER_ENDPOINT-}" = 'unix:///run/docker.sock' || cleanup_context_rc=42
if test "$cleanup_context_rc" -eq 0; then
  export DOCKER_CONTEXT="$PRODUCT_DOCKER_CONTEXT"
fi
# product-docker-context-cleanup-guard:end

if test "$cleanup_context_rc" -eq 0; then
  cleanup_endpoint="$(docker context inspect "$PRODUCT_DOCKER_CONTEXT" \
    --format '{{.Endpoints.docker.Host}}')"
  cleanup_context_rc=$?
fi
if test "$cleanup_context_rc" -eq 0; then
  test "$cleanup_endpoint" = "$PRODUCT_DOCKER_ENDPOINT"
  cleanup_context_rc=$?
fi
if test "$cleanup_context_rc" -eq 0; then
  cleanup_engine="$(docker info --format '{{.ID}}')"
  cleanup_context_rc=$?
fi
if test "$cleanup_context_rc" -eq 0; then
  test "$cleanup_engine" = "$PRODUCT_EXPECTED_ENGINE_ID" && \
    test "$cleanup_engine" != "$PRODUCT_FORBIDDEN_ENGINE_ID"
  cleanup_context_rc=$?
fi
if test "$cleanup_context_rc" -eq 0; then
  docker ps -a --no-trunc \
    --filter "label=com.supabase.cli.project=$PRODUCT_PROJECT_ID" \
    --format '{{.ID}}|{{.Names}}|{{.Labels}}|{{.Status}}' \
    >"$RUN_EVIDENCE/run-owned-containers.pre-stop.txt"
  cleanup_context_rc=$?
fi
# Compare these IDs with the event/collector ownership ledger before continuing.

# 3. Stop only the accepted project using the plain command from its exact CWD.
if test "$cleanup_context_rc" -eq 0; then
  cd "$INTEGRATION_RUN_ROOT"
  supabase stop >"$RUN_EVIDENCE/service-stop.stdout" 2>"$RUN_EVIDENCE/service-stop.stderr"
  service_stop_rc=$?
  printf 'service.stop\t%s\n' "$service_stop_rc" >>"$GATE_LEDGER"
  if test "$service_stop_rc" -ne 0; then
    printf 'service.stop\t%s\n' "$service_stop_rc" >>"$SECONDARY_FAILURES"
  fi
else
  printf 'cleanup.context\t%s\n' "$cleanup_context_rc" >>"$SECONDARY_FAILURES"
fi

# 4. After plain stop, call the already-parsed same-shell collector drain and summary function.
# product-collector-stop-call:start
product_stop_collector_and_verify_summary
# product-collector-stop-call:end

# 5. Stop the separately recorded lifecycle event stream after collector drain.
if test -n "${PRODUCT_EVENTS_PID-}" && kill -0 "$PRODUCT_EVENTS_PID" 2>/dev/null; then
  kill -INT "$PRODUCT_EVENTS_PID" 2>/dev/null
  events_stop_rc=$?
  wait "$PRODUCT_EVENTS_PID" 2>/dev/null
  events_wait_rc=$?
  if test "$events_stop_rc" -ne 0 || test "$events_wait_rc" -ne 0; then
    printf 'PRODUCT_EVENTS_PID\tstop=%s\twait=%s\n' \
      "$events_stop_rc" "$events_wait_rc" >>"$SECONDARY_FAILURES"
  fi
fi

find "$RUN_EVIDENCE" -type f ! -name 'evidence-files.post-stop.sha256' -print0 \
  | LC_ALL=C sort -z | xargs -0 sha256sum \
  >"$RUN_EVIDENCE/evidence-files.post-stop.sha256"

# 6. Remove only saved canary IDs after matching name and accepted engine again.
for canary_record in "$RUN_EVIDENCE"/canary-*.id; do
  test -f "$canary_record" || continue
  canary_id="$(cat "$canary_record")"
  case "$(docker inspect --format '{{.Name}}' "$canary_id")" in
    /product-mount-$RUN_ID|/product-copy-$RUN_ID|/product-loopback-$RUN_ID) ;;
    *) printf 'canary.ownership\t1\n' >>"$SECONDARY_FAILURES"; continue ;;
  esac
  test "$(docker info --format '{{.ID}}')" = "$PRODUCT_EXPECTED_ENGINE_ID" || break
  docker rm --force "$canary_id" \
    >"$RUN_EVIDENCE/canary-$canary_id.remove.stdout" \
    2>"$RUN_EVIDENCE/canary-$canary_id.remove.stderr"
  canary_remove_rc=$?
  test "$canary_remove_rc" -eq 0 || \
    printf 'canary.remove.%s\t%s\n' "$canary_id" "$canary_remove_rc" \
      >>"$SECONDARY_FAILURES"
done
```

Before service stop, the reviewed collector must be actively capturing Storage, Kong, DB, Auth and
Edge logs for every recorded container ID, including replacement instances. It remains active through
plain stop, then receives one `SIGINT`. The helper fences new children, drains pending attachments and
only its own event/log children, closes and hashes every segment, and writes the exclusive summary
before the evidence-wide hash above. The graceful drain is limited by
`--shutdown-timeout-ms 5000`; on expiry the helper sends `SIGKILL` only to children it created and
records an incomplete summary rather than claiming success. A missing process, nonzero exit, gap,
failure, missing required service or incomplete segment prevents a PASS. Docker events are lifecycle
evidence but never substitute for stdout/stderr. No collector or Docker command is automatically
retried.

File restoration uses the exact run deltas, not broad repository cleanup:

```bash
cd "$INTEGRATION_RUN_ROOT"
# First validate cli-latest-backup.state.tsv. A required state must match the
# complete regular, non-linked backup evidence before the copy is attempted.
sha256sum --check "$RUN_EVIDENCE/pre-mutation-cli-latest-backup.sha256"
cp --preserve=mode,timestamps -- \
  "$RUN_EVIDENCE/pre-mutation-bytes/supabase/.temp/cli-latest" \
  supabase/.temp/cli-latest
cmp --silent supabase/.temp/cli-latest \
  "$RUN_EVIDENCE/pre-mutation-bytes/supabase/.temp/cli-latest"
sha256sum --check "$RUN_EVIDENCE/pre-mutation-cli-latest.sha256"

# A not-required state is accepted only when no backup or partial backup
# evidence exists, and records restore as NOT APPLICABLE instead of comparing
# against a file that was never created.

# Each recorded addition is checked against its literal class before removal.
while IFS= read -r relative_path; do
  case "$relative_path" in
    .product-canary|node_modules|dist|.wrangler|supabase/migrations/*_product_completion_read_access_gate.sql|supabase/.temp/*) ;;
    *) printf 'restore.unapproved-path\t%s\n' "$relative_path" >>"$SECONDARY_FAILURES"; continue ;;
  esac
  absolute_path="$INTEGRATION_RUN_ROOT/$relative_path"
  test "${absolute_path#"$INTEGRATION_RUN_ROOT"/}" != "$absolute_path" || exit 46
  test ! -L "$absolute_path" || exit 47
  rm -rf -- "$absolute_path"
done <"$RUN_EVIDENCE/run-created-top-level-paths.txt"

sha256sum --check "$INTEGRATION_MANIFEST_ROOT/integration-target-full.sha256"
find . -type f -printf '%P\n' | LC_ALL=C sort >"$RUN_EVIDENCE/source-paths.after.txt"
cmp --silent "$RUN_EVIDENCE/source-paths.after.txt" "$RUN_EVIDENCE/manifest-paths.txt"
```

`run-created-top-level-paths.txt` must contain the exact top-level additions derived from the saved
per-command inventories, not user input and not a glob. Generated `.temp` files are listed by exact
relative path. `node_modules`, `dist` and `.wrangler` are eligible only when absent in the 573-file
before inventory and recorded as created by this run. The materialized migration name must match the
single saved `migration.created.txt` entry. If target identity, ownership ledger or an exact removal
path is uncertain, preserve the primary failure and owned resources and stop destructive cleanup.

Finally hash the ledger, sanitized summaries and all private evidence again. The run verdict is PASS
only when every required gate is 0, `primary-failure.tsv` and `secondary-failures.tsv` are empty,
collector coverage is complete, plain stop succeeded, restoration re-established all 573 bytes and
paths, and no run-owned container/listener/session/lock/fixture remains. A cleanup or evidence failure
never replaces the first gate failure. File restoration is not database rollback; the final report
must state the remaining database/volume state.

## 6. Current preparation result and remaining prerequisites

- This revision prepares Product for a future same-environment Linux execution. It does not prove
  that the previously observed isolated engine is currently available.
- This correction replaces the two disproved runtime assumptions only: the v2.95.4 Linux archive and
  checksum names now match release metadata, while loopback uses a separate pinned NGINX image whose
  executable, entrypoint, `amd64` child and port are traced to official metadata/build sources.
  Mount/copy keep the previously reviewed Alpine digest and commands unchanged.
- The corrected Supabase download/extraction and NGINX loopback commands are documentation-only in
  this revision. Their live compatibility is **NOT VERIFIED** and no prior result is attributed to
  them.
- Product no longer depends on WP01.5 PASS. WP01.5 remains OPEN, outside this package and NOT RUN.
- Required future versions and official Linux x86_64 artifact/checksum mechanisms are now explicit:
  Node `22.13.0` with npm `10.9.2`, Supabase CLI `2.95.4` and Deno `2.1.4`. Their bytes/checksum files
  remain future provisioning evidence and were not downloaded.
- Linux roots, Docker context/endpoint, Engine IDs, Alpine digest, canary port `61901` and the npm
  lifecycle allowlist are explicit. `<RUN_ID>` and a separately approved numeric UID/GID remain
  required approval inputs. Current engine/endpoint/port/artifact availability is **UNKNOWN** until
  the future preflight and has no fallback.
- The future full manifest contains 573 files and the integration delta contains 135 records. This
  revision includes the approved P03/P05/P06/P07/WP06-B/WP10 implementation and tests while
  preserving the protected read-access overlays, and refreshes the dispatcher identity chain to the
  resulting artifact/binding revision. Scheduler and dependencies are unchanged.
- The existing historical results remain bound to their prior document/delta hashes. They are not
  evidence for this revision.
- Product behavior results from older snapshots remain historical only. This preparation revision
  runs only syntax, manifest, binding and direct package regressions; Product Vitest/typecheck/build,
  Deno and live service gates require the separately authorized attempt.
- DB/HTTP/Edge/Storage/concurrency, Deno decoder, Docker/WSL, Product runtime, WP01.5, B1-B7,
  migration application, scheduler activation, Git Delivery, QA/Production and deploy are
  **NOT EXECUTED**.
- Edge serving is planned as `supabase functions serve` from the execution root, with the local
  acceptance env file described in the Edge readiness gate above. Official CLI/config
  documentation establishes all-function serving and default `enabled=true`/`verify_jwt=true`; all
  seventeen routes must pass the bounded unauthenticated `401` readiness gate before authenticated HTTP.
- **Preparation verdict: PREPARATION READY SUBJECT TO EXPLICIT PRE-RUN SANITIZATION AUTHORIZATION.** The focused collector
  and its direct offline tests now implement the section H contract and the document records the exact
  entrypoint/hash and lifecycle. Linux Docker targeting, real replacement capture, live service logs,
  DB/HTTP/Edge/Storage and cleanup are still **NOT VERIFIED** and remain mandatory future preflight or
  acceptance evidence. This readiness statement is not permission to execute the package.

### Integrated run order and per-process budgets

The proposed identifier is `<NEW_APPROVED_RUN_ID>`. Its Windows and Linux run and
evidence targets must be proved absent again before execution; the identifier is not reserved by this
document. Each budget below applies to one process only, never to the complete sequence. A timeout is
a failed gate and is not permission to retry or increase a test's internal timeout.

The Windows dispatcher-side evidence target is
`C:\Users\Yarin\AppData\Local\CodexProductPrivateEvidence\<RUN_ID>`. Before creating it, revalidate
that the parent is a non-reparse directory owned by the approved Windows SID, has a protected DACL,
and grants inherited FullControl only to that SID and SYSTEM. The existing Linux raw-evidence root
remains `/srv/codex-product/evidence/<RUN_ID>` with the package's ownership/mode/mount checks. Failure
to establish either boundary stops before mutation; evidence is not redirected to a weaker fallback.

The preparation repository currently matches the approved 573-file manifest. No pre-run deletion or
sanitization is authorized by this package. Any extra, missing or mismatched path stops before
`EntryGate` without cleanup or fallback.

| Order | Gate / exact command family                                                          |                                                 External process budget |
| ----: | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------: |
|     1 | binding/hash check, `bash -n`, dispatcher `EntryGate`                                |                                                          60,000 ms each |
|     2 | dispatcher `PrepareUser`                                                             |                                                              300,000 ms |
|     3 | dispatcher `InstallCliRoot`                                                          |                                                              300,000 ms |
|     4 | dispatcher `ContinueUser`                                                            |                                                              600,000 ms |
|     5 | dispatcher `EnvironmentGate` and each three-sample identity observation              |                                                          60,000 ms each |
|     6 | each mount/copy/loopback canary process                                              | 120,000 ms each; the documented probe loops retain their smaller bounds |
|     7 | focused Vitest; each direct Offline Node contract; typecheck; build                  |                                                         600,000 ms each |
|     8 | full `npm exec -- vitest run src` and Deno decoder                                   |                                                         900,000 ms each |
|     9 | collector launch and bounded readiness                                               |                                                              120,000 ms |
|    10 | `supabase start`; `supabase db reset --local --no-seed`; supported upgrade rehearsal |                                                         900,000 ms each |
|    11 | each DB pass, each concurrency command and each HTTP pass                            |                                                         900,000 ms each |
|    12 | Edge serve launch plus its bounded readiness gate                                    |                                                              180,000 ms |
|    13 | dispatcher `FinalizeUser` and each ownership-safe cleanup process                    |                                                         600,000 ms each |

The order is: immutable identity/evidence/snapshot gates; dependencies and canaries; all independent
Offline gates; collector; service start; destructive no-seed reset and the supported upgrade
rehearsal; DB pass 1 and pass 2; the five serial concurrency suites; Edge readiness; HTTP pass 1 and
pass 2; evidence drain, owned cleanup, byte restoration and the final 573-file snapshot. Section F's
dependency table governs every nonzero result.

### Integrated coverage, inputs and external blockers

| Domain                           | Existing command / input                                                                                                                                       | Expected observable result                                                                                                                                                   | Dependency or honest gap                                                                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Points, levels and backfill      | direct WP08/WP09 contracts; DBx2 loads `wp07_wp08_gift_points.test.sql` and `wp07_wp11_completion.test.sql`; Product concurrency fixtures                      | canonical completed events count once; legacy promotion and repeated backfill do not duplicate points, rewards or notifications                                              | disposable migrated DB                                                                                                                                                                              |
| Leads and profile images         | `p03_p07_profile_images.offline.test.mjs`; DBx2 fixtures in `wp04_profile_discovery_leads.test.sql` and `profile_image_management.test.sql`; full `src` Vitest | closed leads remain closed on a later like; image limit/order/primary fallback and ownership rules pass                                                                      | Storage deletion is accepted only through the existing HTTP/Edge path; no real user media outside fixtures                                                                                          |
| Conversation SLA and presence    | `p05_sla_presence.offline.test.mjs`; DBx2 `p05_sla_presence_alerts.test.sql`; full `src` Vitest                                                                | 420-second alert deduplication and assigned live-heartbeat availability pass                                                                                                 | no scheduler is enabled; tests invoke the existing function directly                                                                                                                                |
| Support first response           | `p06_support_first_response.offline.test.mjs`; DBx2 `p06_support_first_response.test.sql`; Product concurrency; full `src` Vitest                              | schedule snapshot, closures, DST/cross-midnight rules and first client-visible human response remain immutable under retry/concurrency                                       | no external support delivery is sent                                                                                                                                                                |
| Media/finalize/cleanup           | focused and full Vitest; Deno decoder; DBx2 WP05/WP06/WP06-B; HTTPx2 and Edge/Storage fixtures                                                                 | real decoder 4/4, one message/charge, fenced cleanup, active-reference protection and direct access denial                                                                   | Deno pinned module download is permitted only by the runtime approval; scheduler remains disabled                                                                                                   |
| Deletion and retention           | WP10 direct contracts; DBx2 WP10 pgTAP; readiness for account-deletion and deletion-worker Edge functions                                                      | cancellation/claims/holds/partial minimization fail closed and never report partial work as complete                                                                         | no real Auth/Storage deletion, email, irreversible replay or scheduler; financial classification remains a policy blocker where recorded                                                            |
| Registration                     | `p06a_registration_eligibility.offline.test.mjs`; DBx2 pgTAP; full `src` Vitest; Auth hook applied by migrations                                               | registration pause, authoritative eligibility and once-only credit grant pass                                                                                                | bot provider, trusted proxy and real SMTP/email verification are configuration/provider gaps, not accepted integrations                                                                             |
| Support and incidents            | P06 support/config direct contracts; DBx2 pgTAP; full `src` Vitest                                                                                             | ownership, internal/client separation, version guards and truthful delivery states pass                                                                                      | legal content, support contacts/calendar completion and external delivery adapter may remain NOT_CONFIGURED                                                                                         |
| Restore recovery                 | `p06_restore_recovery.offline.test.mjs`; DBx2 pgTAP; full `src` Vitest                                                                                         | missing external lock, deletion authority or transaction source keeps business operations blocked                                                                            | external recovery authority, authoritative deletion feed and transaction source are absent; Import/Release/Replay stay disabled                                                                     |
| Edge and Storage                 | `supabase functions serve`, seventeen-route unauthenticated 401 readiness, then HTTPx2 existing fixtures                                                       | every route is served with JWT enforcement; existing authorized media and Storage/RLS cases pass twice                                                                       | readiness 401 is not authorized behavior; only existing HTTP fixtures count as live acceptance                                                                                                      |
| Realtime                         | existing DB presence/access-generation and Product UI tests only                                                                                               | database generation/presence contracts pass                                                                                                                                  | no current Product Linux command proves live Realtime reconnect/revoke; WP01.5 B1-B7 remains separate and NOT RUN                                                                                   |
| Browser/mobile/RTL/accessibility | full `npm exec -- vitest run src`                                                                                                                              | existing component and keyboard assertions pass                                                                                                                              | no existing live browser/mobile runner is in this package; jsdom/Vitest is not live browser acceptance                                                                                              |
| Upgrade                          | `npm run test:upgrade:wp01`                                                                                                                                    | supported 113-to-116 isolated rehearsal completes; cleanup restores the pre-captured full ordered candidate-plus-gate migration list and the existing schema/data invariants | strict-send and read-access upgrade runners now use the PATH-bound `supabase` executable and pass their Offline orchestration regressions; they are not added to this live run order, and live restore verification remains a separate gate |

### Sensitive operations requiring the runtime authorization

The single future authorization must explicitly allow: an exact 573-file snapshot recheck; starting
the named distro; creating the new
run/evidence directories; verified CLI reuse or, only if absent, the two pinned Supabase CLI downloads
and root installation; `npm ci --ignore-scripts --audit=false` plus only the documented `esbuild`, `sharp` and
`workerd` lifecycle allowlist; the pinned Deno ImageMagick module/cache download; the pinned Alpine,
NGINX and Supabase image pulls; run-owned canary containers; `supabase start`; destructive
`supabase db reset --local --no-seed`; the supported isolated upgrade rehearsal; migrations in the
disposable database; fixture-only Auth users, rows, balances and Storage objects; Edge serving;
DBx2, five concurrency suites and HTTPx2; and ownership-proved stop/removal/restoration.

The authorization does not include real user deletion, non-fixture balance changes, scheduler
activation, recovery Import/Release/Replay, external email/support/incident delivery, provider
configuration, WP01.5, host-engine resources, prune, Git or deploy. Missing provider/policy inputs may
be tested for correct fail-closed behavior but cannot be reported as integration acceptance.

### Requested one-run authorization text

Authorize one Product verification attempt with proposed `RUN_ID`
`<NEW_APPROVED_RUN_ID>`, subject to rechecking that its Windows evidence directory,
Linux run root and Linux evidence target are absent. Use only distro
`Codex-WP015-Product-Verify-20261106`, user `codex-product` (`1001:1001`), Docker context
`product-linux-unix-a6e50de2`, endpoint `unix:///run/docker.sock` and Engine ID
`a6e50de2-c013-4dd4-b12e-c966081e1f40`; no fallback or global context change. Approve the sensitive
operations and pinned network access listed immediately above, including image pulls, verified CLI
download/install only if absent, approved npm lifecycle dependencies, the pinned Deno module,
disposable migrations, no-seed reset, supported upgrade rehearsal, fixture-only Auth/Storage/data
mutation, Edge serving, DBx2, five concurrency suites and HTTPx2. Apply the per-process budgets in the
table above, with `ContinueUser` fixed at 600,000 ms. Do not retry a failed gate or change code,
commands, assertions or timeouts during the attempt. Preserve primary failure separately from
collector/cleanup failures; clean only resources proven to belong to this run and Engine; restore
saved bytes and verify the final 573-file snapshot. Do not run real deletion, scheduler,
recovery replay/release, external email, WP01.5, Git or deploy. Return one consolidated report and
stop. This authorization text is a proposal and is not active until the user explicitly grants it.


### Connected continuation — 23 November 2026

This 557/98 revision preserves the approved text-send legacy-lock contract, server expiry
enforcement for new claims and allocation, replay semantics, and the handling fixture corrections.
The expiry migration is included as source only; it has not been applied by packaging.
There are 68 Product Vitest files and 20 exact node:test paths. Product commands, budgets,
canary order and Finalize remain unchanged. Offline package verification is not live acceptance.

The preceding 557/98 release isolated the three legacy-claim Client message UUIDs. This 557/99 successor changes only the WP02 allocation fixture and package references; its 33 planned assertions include automatic resumption after capacity frees. The external fixture regression is not a Product command. All Product commands and guards are unchanged.

### Consent acceptance candidate: 24 November 2026

The 559/103 successor preserves WP02 and includes the seven approved consent, registration and
concurrency-inventory paths. The separate Unlike feature is not included. No integrated WP02
authorization or isolated ingress is established. The read-access discovery helper requires
`desktop-linux`, while the service lane pins `product-linux-unix-a6e50de2`. Neither identity
has been changed. Offline verification does not authorize Product execution or resolve either blocker.

### Client Remove Like successor: 24 November 2026

This 562-file, 111-delta revision adds the reviewed client Remove Like action and its regression
to the consent acceptance parent. The full src inventory is 69; the 20-command Product catalog,
CLI exclusion and authorization requirements do not change. Neither live WP04 nor WP02 is verified.

### Discovery filters and liked entries: 24 November 2026

The combined 565-file, 115-delta successor includes the empty-filter discovery migration and
fixture plus the client liked-profile list. The full src inventory is 70. The 20 Product commands,
single CLI exclusion, authorization requirements and outstanding Product blockers are unchanged.

### Product successor connected package: 25 November 2026

This 573-file, 135-delta offline successor imports exactly the 25 paths in the task-local allowlist. The Product src inventory is 71 files. The historical 565-file package remains failed; this package does not revise that verdict.

WP12's paid-sticker HTTP window is packaged for integrated acceptance, not live accepted. A hard SIGKILL after temporary flag activation can prevent in-process restoration. A pending private journal must fail closed, and old Product volume residue must block reuse. Restoration is not guaranteed after hard process loss. A successful full Product HTTP gate must show both paid cases actually ran without skip and the original flag and timestamp were restored on the proved target. No watchdog or automatic recovery is added.

No Product or runtime authorization is implied. The native binding outside this package is a separate handoff.
