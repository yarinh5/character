# Production Readiness and Observability Runbook

## 1. Scope And Current Decision

- Production deployment remains deferred. This runbook is a repeatable readiness process, not a deployment authorization.
- QA Supabase project: `qmgkmsarzfjnqltljkjl`.
- Production application host, Supabase project, and accountable owner are **Unknown**.
- Closed V2 product contracts remain closed: Gifts stay removed; Stickers remain the monetized gift-like mechanic; Credits, payouts, NEW/ONLINE responsibility, Paid Image per-open sessions, Media Tags, hard delete, and Client PII archive are not reopened by this runbook.

## 2. Source And Environment Matrix

| Environment | App host | Supabase project | Current state | Owner | Release notes |
| --- | --- | --- | --- | --- | --- |
| Local | `http://127.0.0.1:5173` | QA-connected development | Development and QA only | Engineering / QA | Use `127.0.0.1` consistently; do not mix with `localhost`. |
| QA | N/A | `qmgkmsarzfjnqltljkjl` | Migration baseline safe; verified Edge inventory | Database Owner / QA | Current feature-flag defaults are recorded below. |
| Production | Unknown | Unknown | Deployment deferred | Unknown | Establish identifiers, access, and owner before any release decision. |

Document snapshot:

- Local HEAD: `dfdb8b8fab270f1d4af39ea4d2d6018431653421`.
- `origin/main`: `e4d836a49241d52dbd9b8589fe479e8ea312ca7a`.
- Local commits not yet pushed at snapshot: `87d1776`, `c2a4b63`, `dfdb8b8`.
- `supabase/.temp/cli-latest` is local metadata and must never enter staging, a commit, or a release.

## 3. Migration Baseline

See [Migration Baseline Manifest.md](</F:/project love/character/Migration Baseline Manifest.md>). The operating rules are:

- QA can continue from its present migration history; no history repair is justified.
- An existing Production environment needs a read-only migration inventory and baseline reconciliation before deployment.
- A fresh Production environment needs a disposable clean-project rehearsal of the complete local migration chain.
- Migrations are rollback-forward only. Historical migrations, including Gift removal, are immutable.

## 4. Edge Function Inventory

All verified non-Gift QA functions are `ACTIVE`, have `verify_jwt=true`, and matched their local source exactly after normalizing line endings and trailing whitespace. Deploy only when a target-environment parity check requires it.

| Function | QA version | Last local source commit | Rollback evidence |
| --- | ---: | --- | --- |
| `media-view-url` | v7 | `bbeb7c7` | Prior source: `da07452`; depends on current media resolver contracts. |
| `admin-media-upload-intent` | v1 | `1224908` | Current source recoverable; depends on media ingest RPCs. |
| `process-character-media` | v2 | `bb80e91` | Prior source: `1224908`; depends on render and locked-derivative RPCs. |
| `delete-character-media` | v1 | `63efc69` | Current source recoverable; depends on V2-30 hard-delete RPCs. |
| `admin-sticker-upload-intent` | v3 | `34cb456` | Prior source: `7eafb76`; depends on sticker ingest RPCs. |
| `process-sticker-media` | v4 | `34cb456` | Prior source: `ee9dfe4`; depends on sticker processing RPCs. |
| `delete-sticker-media` | v1 | `34cb456` | Current source recoverable; depends on sticker hard-delete RPCs. |

`admin-gift-upload-intent`, `finalize-gift-media`, and `delete-gift-media` remain ACTIVE in QA as legacy artifacts. They have no active callers, database contracts, or Storage bucket dependencies. Retirement is **Operationally Blocked** by deletion permissions. Do not restore Gifts or remove historical Gift migrations.

## 5. Feature Flags

Every flag change requires explicit Product Owner approval, a QA preflight, and a documented rollback action.

| Flag | Expected QA/release default | Activation prerequisites | Rollback |
| --- | --- | --- | --- |
| `stickers_enabled` | `true` | Sticker catalog, pricing, debit, and payout QA complete | Set to approved prior value and verify catalog/send guards. |
| `mandatory_onboarding_enabled` | `false` | Client QA, redirect-loop, completion, and legacy-client tests | Set `false`; verify client routes recover. |
| `locked_images_enabled` | `false` | Locked derivative, access, and media rendering QA | Set `false`; verify standard media remains accessible. |
| `credits_enabled` | `true` | Wallet, ledger, and financial invariant checks | Set only under financial owner approval; preserve ledger evidence. |
| `scoring_enabled` | `true` | Client-message credit and streak regression checks | Restore approved prior value and verify scoring guards. |
| `gifts_enabled` | Absent | Not applicable: Gifts are removed | Do not recreate the setting. |

## 6. Security Status

- No verified security vulnerability was found in the V3-1 security triage.
- Cross-user role lookup was hardened and private helper grants were narrowed.
- RLS deny-all internal tables are intentional where no policy is required.
- Remaining guarded `SECURITY DEFINER` advisories are informational unless a concrete exploit condition is demonstrated.
- Leaked-password protection remains disabled and **Operationally Blocked** by missing Dashboard/Auth access. Do not enable it without the approved QA plan and setting confirmation.

## 7. Observability Matrix

| Signal | Source | Role owner | Retention | Current alerting | Operational gap | Severity |
| --- | --- | --- | --- | --- | --- | --- |
| App/runtime errors | Browser console and application runtime | Engineering / QA | Unknown | Manual | No verified external error monitor | High |
| Edge failures | Supabase Edge Function logs | Engineering / Database Owner | Unknown | Manual | No verified alert routing | High |
| Administrative mutations | `audit_logs` | Operations/Auth Owner | Unknown | On-demand review | Retention and review cadence unknown | Medium |
| Product events | `analytics_events` | Product Owner / Engineering | Unknown | On-demand review | Event dashboard and retention unknown | Medium |
| User-facing events | `notifications` | Product Owner / Operations/Auth Owner | Unknown | Bell only | No verified escalation path | Medium |
| Financial invariants | `credit_transactions`, wallet invariants | Database Owner / Product Owner | Known in ledger, retention unknown | Manual QA/query | No automatic invariant alert | Critical |
| NEW/SLA lifecycle | Queue RPCs, lifecycle analytics, and QA cron | Operations/Auth Owner | QA cron history: 14 days | QA scheduler/manual UI indicators | Production scheduler is not provisioned | High |
| Outreach lifecycle | Outreach attempts and analytics events | Operations/Auth Owner | Unknown | On-demand review | No operational alerting | Medium |
| Media hard delete | Edge response and `audit_logs` | Engineering / Database Owner | Unknown | Manual | No automatic Storage-delete failure alert | High |
| Migration state | Supabase migration history | Database Owner | Known in project history | Manual reconciliation | No release dashboard | Medium |

## 8. V3-3 QA SLA Scheduler

### Environment

- QA project: `qmgkmsarzfjnqltljkjl`.
- Production scheduler: disabled and not provisioned.

### Approved QA Jobs

| Job | Schedule | Owner/database | Command or retention |
| --- | --- | --- | --- |
| `qa_v3_3_new_sla_critical_each_minute` | `* * * * *` | `postgres` / `postgres` | `SELECT private.run_new_sla_critical_scheduler();` |
| `qa_v3_3_cron_history_cleanup_daily` | `17 3 * * *` UTC | `postgres` / `postgres` | Removes `cron.job_run_details` older than 14 days. Expected history size is approximately 20,000 rows. |

### Safety Contracts

- Transaction-scoped advisory lock, with no wait when another run holds the lock.
- `45` second statement timeout and a deterministic, bounded batch of `100` work items.
- `FOR UPDATE SKIP LOCKED`, eligibility revalidation, and semantic notification deduplication.
- Dashboard reads remain side-effect free.

### Live QA Result

- The SLA Bell appeared 41 seconds after the 15-minute threshold for five eligible recipients.
- No semantic duplicate groups or SLA-warning Bells were created.
- Claim and close prevented further alerts, and the scheduler made no ledger changes.
- Hebrew notification literals were repaired, and V3-3-D QA notification artifacts were cleaned.

### Monitoring

- Inspect scheduled jobs with `SELECT jobname, active, schedule, command, database, username FROM cron.job ORDER BY jobname;`.
- Inspect recent execution status and duration with `SELECT jobid, status, start_time, end_time, end_time - start_time AS duration FROM cron.job_run_details ORDER BY start_time DESC LIMIT 100;`.
- Check semantic duplicates by grouping `notifications` on the SLA-critical dedupe key and investigating any group with a count greater than one.
- Stop on failed runs, duplicate Bells, an ineligible recipient, or any unexpected ledger mutation.

### Rollback

- Unschedule the product job with `SELECT cron.unschedule('qa_v3_3_new_sla_critical_each_minute');`.
- Unschedule the retention job separately with `SELECT cron.unschedule('qa_v3_3_cron_history_cleanup_daily');`.
- Do not drop `pg_cron` until confirming that no jobs remain.
- Database changes are rollback-forward only; do not reverse applied migrations destructively.

### Known Limitation

- A true two-session advisory-lock test remains environmentally blocked and is required before any Production scheduler activation.
- Production remains `NO-GO` without explicit Owner approval.

## 9. Known Monitoring Gaps

- No verified external application error monitoring.
- No verified alert routing or retention policy.
- Production SLA scheduling is not provisioned; QA scheduling remains the only active scheduler path.
- No automatic financial-invariant alert.
- No automatic Storage hard-delete failure alert.
- Performance advisors and load targets require a separate evidence-based phase.

## 10. Pre-Deploy Checklist

- [ ] Product Owner explicitly approves a Production deploy.
- [ ] Production project, app host, Database Owner, Operations/Auth Owner, and rollback authority are identified.
- [ ] Source is pushed, repository is clean, and local-only metadata is excluded.
- [ ] Production migration baseline is reconciled read-only.
- [ ] Required secrets are confirmed present without exposing values.
- [ ] Feature flags and their approved release values are recorded.
- [ ] Edge source/version/JWT parity is compared for the target environment.
- [ ] `npx tsc --noEmit --pretty false` and `npm run build` pass from the release commit.
- [ ] Isolated Admin, Operator A, Operator B, and Client QA sessions are available.
- [ ] Rollback authority and owner contact path are confirmed.

## 11. Deployment Order

Planning sequence only; each step requires its own approval gate:

1. Apply approved database migrations.
2. Verify schema/API reload and migration history.
3. Deploy only Edge Functions whose target parity check requires deployment.
4. Deploy the application.
5. Change feature flags only under separate approval.
6. Run the smoke-test matrix.
7. Observe logs, ledgers, queue behavior, and audit evidence for an approved window.

## 12. Smoke Test Matrix

Use isolated Admin, Operator A, Operator B, and Client QA sessions. Stop immediately for RLS/IDOR exposure, wrong financial debit or payout, duplicate message/transaction, media URL/path leakage, broken NEW ownership, failed Auth flow, or missing audit evidence.

| Area | Actors | Expected result |
| --- | --- | --- |
| Login and authorization | All roles | Each role reaches only allowed routes and data. |
| NEW / SLA | Client, Operators A/B, Admin | Client message enters NEW; claim/release/timeout ownership and SLA states are correct. |
| ONLINE | Client, Operator | Assigned outreach succeeds once; reply returns through NEW. |
| Blocks and reports | Operators A/B, Admin | Block affects only its operator; report is visible to Admin with audit evidence. |
| Text credits and streak | Client, Operator | Approved client-message credit and max-three streak rules hold. |
| Stickers | Client, Operator | Free/paid sticker behavior, debit, and responsible-operator payout are correct. |
| Media | Client, Operator, Admin | Permanent, View Once, and Paid Open work; no unapproved reopen or path leak. |
| Media hard delete | Admin, Operator | Unused asset deletes; in-use asset returns `media_asset_in_use`; picker refreshes. |
| Client PII archive | Admin, Client | Archived identity is neutral, actions are blocked, and audit evidence exists. |
| Admin hardening | Admin, non-admin | Sensitive actions succeed only for Admin and create audit evidence. |
| Dashboard reads | Admin, Operator | Reads do not create notifications. |

## 13. Rollback Runbook

1. Stop traffic or disable the affected approved flow before financial repair.
2. Preserve `audit_logs`, ledger, transaction, and relevant Edge-log evidence.
3. Roll back application source only to an approved Git commit.
4. Roll back an Edge Function only from a known-good source/version after target contract verification.
5. Do not perform destructive database rollback. Correct schema defects with a rollback-forward migration.
6. Disable an approved feature flag where applicable, then verify the guard and user route recovery.
7. Never reset a shared environment.

## 14. Open Operational Blockers

- Production environment and accountable owner are unknown.
- Legacy Gift-function deletion permission is unavailable.
- Auth Dashboard access for leaked-password-protection QA is unavailable.
- External monitoring ownership and alert routing are undefined.
- Production scheduler activation requires explicit Owner approval and a true two-session advisory-lock test.
- Representative load targets are undefined.

## 15. Go/No-Go Template

| Dependency | Owner | Status | Evidence | Blocker | Approval |
| --- | --- | --- | --- | --- | --- |
| Production identifiers and owners |  |  |  |  |  |
| Migration baseline |  |  |  |  |  |
| Secrets and Edge parity |  |  |  |  |  |
| Feature flags |  |  |  |  |  |
| Build and source state |  |  |  |  |  |
| Multi-session smoke test |  |  |  |  |  |
| Financial invariants |  |  |  |  |  |
| Observability window |  |  |  |  |  |
| Rollback authority |  |  |  |  |  |

Final decision: `GO` / `NO-GO` / `QA-only continuation`
