# WP11 — Existing Operator Directory and Monitoring Workspace

## Scope and baseline

- Baseline: `9596bcee73de0ce95e1f858407108a3c097c7267`.
- Branch: `codex/wp11-operator-workspace`, isolated worktree `wp11-operator-workspace/character`.
- KEEP: `/admin/operators`, all existing management actions and payloads, assignment model, RPCs, query-key prefixes, invalidation prefixes, Realtime tables, performance calculations and `AnalyticsContent`.
- MODIFY: the existing list shell, read states, admin identity lifecycle, monitoring dialog and performance dialog.
- EXTEND: loaded-list name/email search, active/inactive filtering, reset and loaded-result count.
- NEW: one focused component suite and this progress record. REMOVE: none.
- WP01.5 remains OPEN/PAUSED and was not opened or changed.

## Implemented behavior

- Added a verified admin gate that requires completed Auth initialization, matching session/user IDs and the admin role before any workspace query or Realtime subscription starts.
- Identity-scoped all workspace query keys while preserving their existing prefixes. Performance keys additionally include the selected operator. Identity loss or replacement remounts the workspace, closes dialogs, removes the old channel and prevents old cached rows from rendering in the new workspace.
- Added loaded-list search by name/email, active/inactive filtering, reset and an explicit “filtered out of loaded rows” count. Archive mode and the existing management actions remain in the same route.
- Distinguished initial loading, initial error, true empty, filtered no-results, background refresh, cached refresh failure and recovery. Cached rows remain visible with a bounded manual retry.
- Kept the three monitoring RPCs independent. A failed presence, NEW queue or SLA read no longer hides successful sources or turns unavailable data into zero.
- Missing operator presence is rendered as unavailable rather than offline, zero conversations or an endless skeleton. Cached monitoring information remains visible with a refresh warning and source-specific retry.
- Kept monitoring read-only. No claim, release, requeue, cycle mutation or permission-bypassing link was added.
- Reused `fetchOperatorPerformance` and `AnalyticsContent`. The dialog distinguishes loading, initial error, cached refresh error, missing operator and a real existing operator with no activity; selected-operator identity prevents A data from appearing for B.
- Preserved all existing write functions and payloads. The active-state regression verifies the existing `adminUpdateOperator` payload, while create, invite, promote, assignments, credits, reset, archive, restore and conversion remain unchanged.
- Preserved Realtime tables and invalidation prefixes; the channel name now carries the verified admin identity and is removed on unmount.

## Verification evidence

- Baseline before changes: full Vitest PASS, `247 passed / 24 skipped` across `16 passed / 6 skipped` files.
- TDD RED: the focused run produced `11 failed / 1 passed` in the new suite while all `18` existing operator-performance state tests passed. Failures matched the missing Auth gate, filtering, retries, cached states, unavailable monitoring and selected-operator isolation.
- Focused GREEN: `30/30` tests passed across `admin-operator-workspace` and `operator-performance-states`.
- Typecheck initially failed only on an overly narrow test fixture literal; after correcting the fixture type, typecheck passed.
- `format:check` initially failed on formatting, and `lint:changed` exposed four existing ternary-expression lint errors once the route became a changed file. Prettier plus behavior-preserving `if/else` rewrites resolved them; subsequent format/lint passed.
- Final full Vitest: `260 passed / 24 skipped` across `17 passed / 6 skipped` files.
- Final `format:check`, `lint:changed`, `typecheck`, client/SSR build and both diff checks passed.
- Non-blocking notices: jsdom document navigation, deprecated `punycode`, and the existing large client chunk warning. The build-generated route-tree file had no content diff and was restored outside the delivery allowlist.

## Boundaries and remaining acceptance

- Search, filters and counts describe only the rows returned by `adminListOperators`; they are not global counts and no pagination or server filtering was added.
- `adminListOperators` still cannot expose an independent enrichment error for each successful partial response. The UI does not invent an unavailable state the server contract does not provide.
- Existing presence, NEW queue and SLA data are preserved but do not prove the unmerged WP01–WP02 contracts or their authorization behavior.
- Browser RTL/mobile/desktop verification: **NOT VERIFIED**. No isolated browser harness existed in this packet, and none was added.
- Live Auth/Supabase/RLS integration: **NOT VERIFIED**. Component tests mock I/O boundaries and do not prove server authorization or live Realtime behavior.
- DB, migrations, RLS, RPC signatures, dependencies, flags and route tree: none changed. Local/QA/Production application and deploy: not executed.
- Locked dependency installation reported 42 vulnerabilities (2 low, 20 moderate, 14 high, 6 critical). Dependency remediation is outside this allowlist.
- Implemented and component-tested on the feature branch does not mean merged, live-connected or product-delivered. WP11 as a whole is not complete; browser and authorized live integration evidence require a separate approved gate.
