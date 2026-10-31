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
