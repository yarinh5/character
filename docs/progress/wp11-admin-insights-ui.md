# WP11 — Existing Admin Dashboard and Analytics Reliability

## Scope and baseline

- Baseline: `ae3bccc93e9886fa9d8acfccc9e3697c3cb5b06f` (`origin/main`, after PR #12).
- Branch: `codex/wp11-admin-insights-ui`; isolated worktree `wp11-admin-insights-ui/character`.
- KEEP: the existing dashboard and analytics routes, current query/RPC sources, recent-conversation limit of 8, snapshot polling every 30 seconds, navigation destinations, formulas and server contracts.
- MODIFY/EXTEND: authenticated identity lifecycle, identity-scoped cache and Realtime, read/refresh/error/retry states, date and response validation, zero-value charts, metric wording and coverage disclosures.
- NEW: three focused component suites and this progress record. REMOVE: none.
- WP01.5 remains OPEN/PAUSED and was not opened, executed or changed.

## Implemented behavior

- Dashboard, analytics and operations snapshot wait for initialized Auth with an admin role and matching `user.id` / `session.user.id`. Query keys, component instances and the dashboard Realtime channel are scoped by that verified administrator identity; logout or replacement hides old UI and prevents late results from appearing in the new context.
- Dashboard aggregate reads now verify every Supabase result and required count. A failed initial read does not invent zeroes or an empty list, while a failed refresh retains verified cached data and exposes one bounded manual retry. The independent server-analytics source has its own initial and cached-refresh states and retry.
- F1 correction: recent-conversation rows now validate every field and nested relation consumed by the render, including contract-valid nullable values. Dashboard analytics validates consumed entries in `topCharacters`, `topOperatorsByAvailablePoints` and `lowBalanceUsers`; all required numbers must be finite. Malformed entries fail the existing source query instead of being coerced, filtered or displayed, so previously verified cache remains authoritative during a failed refresh.
- The dashboard retains the 8-row recent-conversation query and existing links. Verified zero activity renders at zero height. Labels now distinguish profiles created today, consumed credits and historical operator credit balances.
- Advanced analytics keeps draft dates local until explicit apply, rejects missing, impossible and reversed dates, and displays the actual range returned by the server. Identity and range are part of the cache key, so a newer request remains authoritative when older requests complete later.
- Analytics responses are validated before consumed fields render. Initial and cached-refresh failures have separate retry states, verified zero activity renders at zero height, and consumed credits / historical points are not described as revenue or a new points engine.
- The analytics coverage note states that each existing source is capped at 10,000 rows, that the server may apply a shorter range, and that the server-returned range is authoritative; the view is not presented as a complete historical report.
- The operations snapshot retains the existing admin RPC, fields, links and 30-second polling. It validates all consumed metrics, handles malformed timestamps without crashing, preserves cached metrics across refresh failure and identifies outreach as historical 24-hour activity rather than current ONLINE state.

## Metric sources and known coverage

- Dashboard counts come from `user_roles` client rows, profiles created since the local start of day, active characters and the latest 8 conversations. These sources are independent of the server analytics and snapshot RPC.
- Dashboard analytics retains its existing 14-day activity window, current-month historical operator payout inputs and current wallet/profile joins. Existing server-side source-error coverage is unchanged and remains a documented backend debt outside this frontend allowlist.
- Advanced analytics uses the current server function and its returned range, with up to 10,000 rows per source. It does not provide complete aggregation beyond those caps.
- Operations snapshot retains the current RPC definitions and its 24-hour outreach window. No RPC, schema, RLS or authorization contract changed.

## Verification evidence

- TDD RED: the first focused run failed all `21/21` initial regressions on the intended identity, cache isolation, error/retry, validation, zero-chart, label and polling-lifecycle gaps. A malformed timestamp also reproduced the prior render crash.
- Focused GREEN was extended with explicit malformed dashboard-analytics and stale-Realtime-callback coverage; the final focused command passed `22/22`.
- Delivery snapshot: full Vitest passed `339` tests with `24` existing skips (`24` passed / `6` skipped files); format, changed-file lint, typecheck and the client/SSR production build passed.
- The first format check identified six changed TS/TSX files and passed after scoped Prettier formatting. Full Vitest retained the existing non-failing jsdom document-navigation notice; build retained the existing `punycode` deprecation and chunk-size advisory.
- F1 correction RED: the first expanded dashboard run failed nine tests; eight were the intended missing-validation failures and one was an imprecise valid-data selector. After correcting only that selector, the controlled RED was `8 failed / 8 passed` in the dashboard suite.
- F1 correction focused GREEN: all three required suites passed `31/31`, including malformed initial/refresh responses, retained cache, retry recovery, source independence and legal `null`/zero values.
- F1 correction delivery snapshot: full Vitest passed `348` tests with `24` existing skips (`24` passed / `6` skipped files); format, changed-file lint and the client/SSR production build passed. The first typecheck exposed only missing TypeScript narrowing after a dynamic array check; explicit local narrowing fixed it and the rerun passed.

## Boundaries and remaining acceptance

- Component tests render the real routes/components with mocked Auth, Supabase, server functions and navigation. They do not prove browser behavior, live authorization, RLS, Realtime delivery or production-scale aggregation.
- Browser RTL/mobile/desktop: **NOT VERIFIED**. No browser runtime was started.
- Live Auth/Supabase/RLS/Realtime integration: **NOT VERIFIED**. No product network, SQL, Docker or Supabase runtime was used.
- No backend, RPC, schema, migration, RLS, Auth provider, dependency, lockfile, workflow, route or layout changed.
- Local/QA/Production application and deploy: not executed.
- WP11 as a whole is not complete and no product-delivery claim is made.
