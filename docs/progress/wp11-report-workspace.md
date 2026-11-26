# WP11 — Existing reports and audit workspace

## Scope and baseline

- Baseline: `16cd9285686b3d9a77534838c0613fea328a8c98`.
- Branch: `codex/wp11-report-workspace`, isolated worktree `wp11-report-workspace/character`.
- WP08 remains on its separate branch at `4bf36379e3aa56d0f53e8e7b10f8ed9063f35911`. WP01.5 remains OPEN/PAUSED and untouched.
- KEEP: existing routes, server authorization, report statuses, RPCs, client blocking contract, audit writes and conversation links.
- MODIFY/EXTEND: the existing reports and audit screens. NEW: two component suites and this record only. No new backend or business lifecycle.

## Implemented behavior

- Independent client-report, operator-report and reporter-enrichment read states, explicit retries, retained cached rows and refresh warnings. Missing reporter profiles are distinguished from enrichment failure; blocking is disabled if the reporter cannot be verified.
- Search and loaded-result counts, client status and operator source filters, reset controls, full multiline detail and missing-conversation handling.
- Status changes validate both returned report ID and requested status. Synchronous per-report/per-reporter locks prevent conflicting duplicate submissions. No mutation retry or optimistic server confirmation.
- Blocking requires explicit confirmation identifying the reporter; only the existing server function is called and only `ok:true` confirms success. Ambiguous failures warn of possible partial changes and require checking the client before retry.
- Dialog instances isolate old completions from another or reopened dialog. Confirmed writes invalidate the matching report/profile/audit queries and, for blocking, client queries; subsequent read failures remain refresh failures.
- Auth session/user identity and admin role gate both screens. Identity changes remount local state; queries are identity-scoped and unmount guards suppress late write effects/toasts.
- Audit action filtering uses the existing server contract; report/client status labels and previous/new status metadata are displayed. The 200-row limit and loaded-only search are explicit; empty results do not prove absence from history.
- Existing components/layout retained with RTL selectors, scrollable multiline dialogs, keyboard cancellation and focus restoration.

## Verification evidence

- Real screen components, Router, QueryClient and dialogs; controlled boundaries for auth, Supabase and server functions.
- Initial suite: FAIL, 17 passed / 13 failed. The auth test boundary initially did not notify real Router descendants; selectors also needed normalization/scoping for multiline text and duplicate close labels.
- Second suite: FAIL, 25 passed / 5 failed; corrected selectors without removing assertions.
- Then PASS, 30/30; expanded coverage PASS, 35/35.
- Typecheck initially FAIL because role queries used an unsupported `exact` option; removed the redundant option (role names already match exactly). Subsequent typecheck PASS.
- Final focused suite: PASS, 36/36 including keyboard cancellation/focus restoration.
- Final gates: format:check, lint:changed, typecheck and client/SSR build PASS; full Vitest PASS, 203 passed / 24 existing skipped. Both diff checks PASS. The suite excludes the separate unmerged WP08 slice by design.
- Non-blocking build/test notices: deprecated punycode, large chunks and jsdom document navigation. Generated route-tree content matched HEAD after build and is excluded from delivery.
- No added skips or timeout increases.

## Remaining acceptance and boundaries

- Browser RTL/mobile/desktop and live Auth/Supabase/RLS integration: NOT VERIFIED. Component tests do not prove server permissions or a real block/audit transaction.
- Server blocking remains non-atomic. No backend correction or live blocking was performed.
- Operator reports remain read-only with no invented treatment status.
- Audit remains a limited window, without full pagination, entity filtering or global aggregation. Existing server-side actor enrichment behavior is unchanged.
- WP11 as a whole and AC27 are not complete. Return to live integration/browser verification in an explicitly authorized isolated environment; broader lifecycle/aggregation requires a separate approved packet.
- DB/migrations/RLS/flags: None changed. Application to Local/QA/Production, runtime services, PR, merge and deploy: NOT EXECUTED.
- Locked dependency installation reported 42 vulnerabilities (2 low, 20 moderate, 14 high, 6 critical). No dependency or lockfile changes were made in this slice.

## Audit-history pagination completion — 2026-11-04

- Baseline: merged `main` at `652047682250f3f2bcbf7a921ba843cbde721d44`, isolated on
  `codex/product-completion`. The existing report workflow and authorization boundary are preserved;
  WP01.5 remains paused and untouched.
- The previous 200-row terminal window is replaced by server-side keyset pagination ordered by
  `(created_at DESC, id DESC)`. The server reads one look-ahead row, returns an opaque next cursor
  from the last displayed row, and retains the existing action filter and actor enrichment.
- The current audit screen appends pages without duplicating IDs. Local search remains explicitly
  limited to loaded rows. A failed next-page read keeps all prior pages visible, reports the scoped
  failure and retries the same cursor; changing action starts at the first page of that filtered
  history. Ordinary refresh still retains cached rows on failure.
- RED reproduced the old array-only response and missing continuation path. The final focused audit
  workflow passes 11/11, including cursor forwarding, append, next-page failure/retry, filter reset,
  identity replacement and late-response isolation. Typecheck passes on the same snapshot.
- Consolidated final gates on this local snapshot: five focused WP04/WP11 suites pass 98/98; full
  Vitest passes 393 tests with 24 existing skips; format, changed-file lint, typecheck and client/SSR
  build pass. Existing jsdom navigation, `punycode` and large-chunk notices remain non-failing.
- No backend schema, migration, grant, RLS policy, dependency or runtime environment changed. The
  existing admin server authorization and audit table remain the data boundary.
- Browser RTL/mobile/desktop and live Auth/Supabase/RLS integration remain **NOT VERIFIED**. This
  closes the misleading terminal 200-row UI window, not WP11 as a whole or AC27 acceptance.
- Focused completion review: PostgreSQL/PostgREST can serialize `timestamptz` cursors with an
  explicit numeric offset (for example `+00:00`), while the initial Zod cursor validator accepted
  only the default UTC form. The validator now accepts ISO datetime offsets without weakening the
  UUID cursor or keyset ordering contract, and the paging regression fixture forwards the offset
  form through the real screen. The server query itself was not run against a live Supabase
  instance, so keyset syntax, authorization and production history coverage remain **NOT VERIFIED**.

## Efficiency and responsive UX evidence — 2026-11-05

- Audit history uses server-side keyset pagination and one look-ahead row, appends without duplicate
  IDs and retries the failed cursor without discarding loaded pages or filters. Identity changes
  invalidate the active request generation; local search is explicitly limited to loaded rows.
- Offline tests cover cursor forwarding, page append, failed-page retry, filter reset and late
  identity completion. The production PostgREST query was not executed.
- Live query plans on large audit tables, browser scrolling/focus and production enrichment cost
  remain **NOT VERIFIED**. No comparative performance claim is made.

## Deletion workflow preparation — offline draft, 2026-11-05

- Account deletion now starts as an idempotent request and requires a one-time, expiring token hash
  prepared and verified by a service boundary. Database, Storage and Auth are separate resumable
  steps; completion and failure are recorded independently and no partial run is presented as full
  deletion.
- Admin conversation deletion requires an explicit reason and confirmation and creates a separate
  database-content/Storage/finalize workflow. Closing or hiding a conversation does not substitute
  for this request. The existing admin screen reports that the request is recorded, not completed.
- Both destructive workflows remain blocked while the P04 retention policy flags are false. No
  email was sent, no worker was run and no content, Auth identity, Storage object, ledger, delivery
  or catalog asset was deleted.
- Component coverage verifies account-request idempotency and malformed-result handling. DB/RLS and
  step-transition tests are written and **NOT RUN**; live email-provider integration, actual
  anonymization, Storage/Auth recovery and browser confirmation remain **NOT VERIFIED**. WP10,
  AC25–AC26 and AC34 are not closed.

## WP10 / P04 deletion lifecycle — implemented offline, 2026-11-11

- The Product Owner decision now has a forward-only database contract. Account confirmation records
  an immutable server `confirmed_at`, blocks new business activity, opens a seven-day cancellation
  window and anchors the 30-day active-system content deadline to confirmation. Cancellation consumes
  a separate one-time Supabase Auth email challenge bound to the account and request, then signs the
  UI out again; revoked sessions are never restored.
- Account and conversation work now uses bounded attempts, leases, claim tokens and completion
  evidence. A stale worker cannot complete a renewed claim. Conversation deletion blocks normal
  client/operator/admin content access immediately and records a seven-day physical-deletion target.
- Retention rules are versioned. The fenced `retention_minimization` RPC now processes approved,
  independent classes without waiting for financial classification: predecessor-minimized personal
  content, internal credits/levels, safety reports with an authoritative closure anchor, blocks and
  admin audit. Each class records an anchor, due date, outcome and sanitized evidence. Missing anchors,
  targeted holds, `pending_legal` financial records and `provider_unverified` backups stay protected
  with explicit reason codes; they are not reported as minimized. Their fenced evidence is persisted
  as `retention_conditions_pending`, the step remains incomplete and dependent Auth deletion stays blocked.
- The UI now calls the account-deletion request Edge boundary rather than only creating a database
  row. Verification claims `session_revocation`, calls the Supabase Auth provider and persists
  completion/failure with the same claim token. Cancellation has a separate request/confirm pair and
  therefore does not trust the blocked pre-deletion session by itself. The authorized worker calls
  fenced DB operations, deletes only exact manifested Storage paths and verifies absence, performs
  provider Auth soft deletion, and records finalization evidence. The worker now calls the real fenced
  retention RPC and persists either completion or a fenced blocking result. Amounts, balances, rights, idempotency and
  ledger rows are preserved; only approved free text/direct metadata is minimized. The worker and
  scheduler remain disabled, and financial classification remains pending without blocking unrelated
  categories.
- Conversation-deletion Gift visibility now targets canonical `gift_attachment_purchases` and its
  `gift_message_id` relation; WP10 has no dependency on removed `message_gifts`.
- Irreversible account deletion, conversation deletion and scheduling remain disabled by default.
  Provider configuration still requires the two approved redirect URLs, Supabase Auth mail delivery,
  service credentials and a separately authorized worker trigger. No migration was applied, no
  verification email was sent, no Auth session was revoked, and no DB or Storage object was deleted.
  DB/Auth/Storage/provider behavior and legal/accounting classification are **NOT RUN / NOT VERIFIED**;
  this offline implementation does not close WP10, AC25–AC26 or AC34.

Consolidated offline gate on the final local snapshot: focused completion suites passed, full Vitest
passed **441** tests with **27** service-oriented skips, and format, changed-file lint (warnings only),
typecheck and client/SSR build passed. Live DB/RLS/concurrency/Auth/Storage/Realtime/browser evidence
remains **NOT RUN / NOT VERIFIED** and these results do not close WP10–WP11 or product delivery.

## P06 / WP12 launch-readiness decision intake — 2026-11-11

P06 is **PRODUCT DECISIONS APPROVED**. The approved launch model is open self-registration without
invites for eligible users aged 18 or older, with email verification, registration abuse/bot
protection, rate limiting and an authorized, audited server-side ability to stop registrations or
dangerous operations during an incident. The planning target is 30,000 registered users and 100
operators. Concurrency scenarios are 300/30, 1,000/100 and 2,000/100 clients/operators; the last is a
boundary scenario, not an automatic first-launch condition. The five-active-conversation operator
limit is unchanged. None of these capacities has been measured by this documentation package.

Recovery targets are RTO up to four hours and DB RPO up to 15 minutes. Storage and backup coverage
still require separate provider definition and verification. Access after restore must remain blocked
until the ledger is reconciled, uncertain financial operations are stopped and completed deletions
are replayed. Business incident ownership belongs to the founders and a deputy, with ordinary support
targeted within one business day; this does not create automatic 24/7 technical on-call coverage.

### Focused implementation remainder

| Area | Existing path and demonstrated behavior | Classification / remaining gap |
| --- | --- | --- |
| Registration, email verification and age | **IMPLEMENTED OFFLINE:** the UI uses a server function, which obtains a one-time DB admission nonce; the Auth hook enforces the nonce and the server setting. New accounts are business-ineligible until authoritative email confirmation and a server-computed onboarding age of 18–120. | **תצורת ספק + קבלה חיה:** migration/hook apply, email delivery and direct Auth rejection are not verified. The age value remains a declaration validated by server rules, not identity-document proof. |
| Repeated signup-credit abuse | **IMPLEMENTED OFFLINE:** the creation trigger no longer grants; activation after verified eligibility calls an atomic helper protected by a private reservation and wallet lock. Legacy accounts are not backfilled. | **פער חיצוני:** per-account idempotency is covered in code, but bot/multi-account prevention is not complete without a separately selected provider/abuse policy. |
| Registration rate limiting / automation defense | **IMPLEMENTED OFFLINE on the controlled path:** admission issuance has a bounded 15-minute per-email-digest window and stores no plaintext email in limiter rows. Direct Auth creation lacks the required server nonce. | **תצורת ספק:** no trusted-proxy source-address contract or bot provider is configured; IP/fingerprint controls and multi-email attacks remain open. |
| Stop registrations / dangerous operations | **IMPLEMENTED OFFLINE for registration:** `allow_new_registrations` is fail-closed in the Auth hook. Admin pause/resume requires a reason, writes audit and cannot be changed through the generic settings RLS path. | **מחוץ ל־P06-A:** broader dangerous-operation incident gates were intentionally not added. Hook/provider apply and live authorization remain unverified. |
| Support and incident escalation | **קיים בקוד חלקית:** admin notifications, operational alerts, reports and audit views exist. | **חסר מימוש + החלטה משלימה:** no dedicated support intake/escalation workflow or routing contract was found. Founder/deputy names, support address/form, alert channels, support hours and escalation procedure are still required. |
| Recovery gating, reconciliation and deletion replay | **IMPLEMENTED OFFLINE:** `20261111190000_p06_restore_recovery_gate.sql` מוסיף אירוע/גרסה, חסימת שרת ו־RLS, ראיות reconciliation, קליטת deletion ledger חיצוני, claim/fencing ל־replay כבוי ואישור/שחרור דו־שלבי. `process-restore-recovery` מאמת envelope חיצוני לפני mutation ומבצע staging בלבד. | **תצורת ספק ואימות חי:** מקור lock/manifest חיצוני, reconciliation מול מקורות עסקאות, ביטול sessions/Realtime/Signed URLs, אישור replay בלתי הפיך, PITR/Storage/Auth ותרגיל RTO/RPO עדיין חסרים. אין לסמן פתוח על סמך DB משוחזר בלבד. |

### P06-A registration admission and eligibility — implemented Offline 2026-11-11

- `20261111160000_p06a_registration_eligibility.sql` adds a fail-closed Auth admission hook, a short-lived
  one-time admission nonce, a bounded per-normalized-email-digest limiter, server-owned eligibility and
  an audited Admin pause/resume RPC. Direct Auth signup without the server nonce is rejected by the hook.
- New P06-A accounts remain ineligible for business RPCs and receive no signup bonus until Auth has an
  authoritative `email_confirmed_at` and the canonical onboarding profile has a server-computed age of
  18–120. A private reservation plus wallet locking makes the 50-credit grant atomic and idempotent.
  Existing accounts are deliberately not backfilled or granted again.
- `register.tsx` now uses the server function and reports paused/pending/error states without claiming
  activation or credit success. Admin registration changes require a reason and use the audited RPC.
  Trusted Admin-created operator/user flows carry service-owned `app_metadata`; client metadata is not
  accepted as a role, verification or eligibility assertion.
- Offline Vitest, SQL-contract checks and typecheck cover the controlled path. A pgTAP suite is written
  for paused admission, unverified/eligible users, retry and legacy preservation, but is **NOT RUN**.
  Migration apply, Auth-hook/provider configuration, email delivery, live concurrency and direct Auth
  rejection are **NOT VERIFIED LIVE**.
- Residual gap: the limiter does not use a caller IP because no trusted-proxy source contract exists.
  No bot provider/fingerprinting was selected, and per-email limiting plus email verification does not
  prove multi-account prevention. Provider bot controls, quotas and live abuse acceptance remain WP12.

### Deliberately separate remaining decisions and gates

- WP10 `retention_minimization` is **IMPLEMENTED OFFLINE** for P04-approved record classes. Financial
  transaction classification remains `pending_legal`; safety records without a closure anchor and
  targeted holds remain protected, while backup expiry remains provider-unverified. Live DB/RLS,
  concurrency, worker and expiry processing are still NOT VERIFIED and the scheduler stays disabled.
- Final legal terms/privacy content and production email/Auth configuration are not supplied or
  verified. P06 is a product decision, not legal approval.
- Founder/deputy names, support addresses or form, alert routes and support hours are not yet supplied.
- Provider services, quotas, PITR/Storage coverage and costs require separate approval. No capacity,
  RTO/RPO or public readiness was verified here.
- Recommended next unblocked package: apply and verify P06-A in an isolated Auth/DB environment,
  including hook wiring, email confirmation, DB concurrency and the written pgTAP suite. Bot-provider
  selection, trusted-proxy/IP policy, live Auth configuration and load/recovery acceptance remain
  separate gates.

## Consolidated Product Completion offline verification — 2026-11-07

- Verified snapshot: branch `codex/product-completion` at base HEAD
  `652047682250f3f2bcbf7a921ba843cbde721d44`, including the preserved local Product Completion
  delta. Staging remained empty; no service runtime, migration apply or Git delivery was performed.
- Final local gates on that exact working tree passed: changed-file format, changed-file lint with
  seven non-failing existing React warnings, TypeScript typecheck, full Vitest **454 passed / 27
  skipped**, client/SSR build, concurrency-harness syntax and both Git diff checks.
- The skips and unexecuted server suites are not acceptance evidence. Live DB/RLS, HTTP, Edge,
  Storage, Realtime, concurrency, browser RTL/responsive/accessibility, upgrade/backfill and
  migration-application gates remain **NOT RUN / NOT VERIFIED**.
- The dedicated Deno decoder test was not run because Deno is not installed in this environment and
  installing it is outside this offline package. P01 was subsequently closed for new regular
  `view_once` attachments with a server-timed 60-second window while preserving legacy rows. P03,
  P04 and P05 remain the explicit decisions that gate authoritative historical backfill,
  destructive retention and final SLA/alert semantics respectively. This verification does not close Product, WP01.5 or
  any WP whose acceptance requires those live or business gates.
- Follow-on WP04 legacy-image preservation was verified on 2026-11-08. The final local gates pass:
  format, lint with the same seven non-failing warnings, typecheck, full Vitest **456 passed / 27
  skipped**, and client/SSR build. Focused profile/onboarding regressions pass 46/46. Live and
  business-decision boundaries above are unchanged.

## 2026-11-25 local continuation: operator report moderation

- Cause: operator-submitted client reports had no moderation lifecycle; the Admin screen only listed
  them, and the operations snapshot counted every persisted row as open.
- A forward WP11 migration adds open/in-progress/decided/closed state, bounded decision and optional
  global-action notes, an admin-only versioned update RPC with audit, and an unresolved-only snapshot
  count. The Admin screen now supports the transition and checks the returned report ID, status and
  next version before claiming success. A global-action note documents an action; it does not execute
  one. Existing customer-report behavior is unchanged.
- Focused UI and SQL-contract tests were added. PostgreSQL/pgTAP live and Product acceptance remain
  **NOT RUN** for this revision; offline checks alone do not close WP11 or Product.
- R10 notification gap: a separate forward migration now routes newly submitted operator reports to
  admins through the existing `new_report` preference and notification channel. The notification
  contains a report ID and generic text, not the client's notes or identity. This is covered by a
  structural regression and a written pgTAP case, but live delivery remains **NOT RUN**.

## 2026-11-25 WP11 report-history pagination

- Cause: the admin reports workspace made one unpaged read per report source and had no continuation control. Older rows could be unreachable when a response is capped. The audit-log workspace's cursor pagination did not cover reports.
- Both report sources now use bounded 100-row pages with a one-row lookahead and stable descending `(created_at, id)` cursors. Client reports keep table RLS; a new forward-only operator-report RPC keeps the old row shape, requires admin authorization, rejects partial cursors and invalid page sizes, and caps output at 101. The old RPC remains available. Profile enrichment is batched rather than sent as one growing ID list.
- The UI keeps loaded rows after a later page fails, offers an explicit continuation retry, and updates/invalidate the paged cache after moderation. Search and counts explicitly describe loaded rows rather than claiming a global total.
- RED reproduced the missing continuation. Final focused UI tests passed 32/32; full UI tests 676/676; DB Offline tests 101/101; typecheck, scoped lint and client/SSR build passed. The written pgTAP case and the PostgREST keyset filter still require live verification. No migration was applied; Product acceptance remains open.

## 2026-11-26 local report submission, notification and moderation

- On a clean local project with 174 committed migrations and no seed, two authenticated
  workers could see the same synthetic client in outreach candidates. A real worker submitted
  a report and then placed an idempotent local block. Only that worker lost the candidate;
  the other worker retained access and the client stayed globally active. This did not
  exercise NEW allocation or rerun WP02.
- An admin opened the report from in-app notifications, saved in-progress and closed with an
  explanation. The readback and audit confirmed versions 2 and 3 and the exact admin actor.
  A client could not read the report list; an operator could not moderate. Escape returned focus
  to the moderation button in the 530px RTL viewport. This was an in-app journey, not external
  notification delivery.
- The browser exposed two notifications for one report. The old analytics trigger also emitted
  a notification under a different type, bypassing the report preference, while the newer
  notifier also addressed blocked admins. The forward correction keeps the original analytics
  event and one preference-aware notification for active admins. No historical notifications,
  report permissions or moderation behavior changed. Live RED failed three assertions;
  final moderation and paging TAP passed 23/23 and 14/14. Another authenticated report after the
  migration produced exactly one notification through the real API. Offline checks passed 8/8.
- Evidence: `F:/project love/character/.codex-task/wp11-report-20261126-01/REPORT.md`.
  Cleanup verified unchanged prior inventory and no task listeners. This is scoped AC27 evidence,
  not full WP11, AC31 or Product acceptance.
