# WP11 — Existing Admin Dashboard and Analytics Reliability

## Scope and baseline

- Baseline: `ae3bccc93e9886fa9d8acfccc9e3697c3cb5b06f` (`origin/main`, after PR #12).
- Branch: `codex/wp11-admin-insights-ui`; isolated worktree `wp11-admin-insights-ui/character`.
- KEEP: the existing dashboard and analytics routes, current query/RPC sources, recent-conversation limit of 8, snapshot polling every 30 seconds, navigation destinations, formulas and server contracts.
- MODIFY/EXTEND: authenticated identity lifecycle, identity-scoped cache and Realtime, read/refresh/error/retry states, date and response validation, zero-value charts, metric wording and coverage disclosures.
- NEW: three focused component suites and this progress record. REMOVE: none.
- WP01.5 remains OPEN/PAUSED and was not opened, executed or changed.

## Implemented behavior

### P05 operational wait alerts — implemented Offline

- The authoritative event is the existing `(conversation_id, pending_since)` cycle while `needs_handling=true`; additional client messages, claim, requeue and read do not reset or resolve it.
- The target is 420 seconds, measured continuously 24/7 from server time. Existing 5/15-minute risk metrics remain reporting signals and no longer form a second automatic alert path.
- The existing scheduler entry point now calls the operational wait emitter. External scheduler configuration and a live invocation remain required; opening an admin screen is not the emission mechanism.
- Notifications carry one semantic event key per recipient. A successful business response changes active notification metadata to `resolved` without deleting history or forcing `is_read`.
- The bell renders active/resolved state and the wait duration captured at emission. Live DB, Realtime delivery and scheduler verification are still pending.

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

## Operator Points source alignment — offline draft, 2026-11-05

The existing dashboard and advanced analytics server functions now read operator balances and
reward events from `operator_point_wallets` and `operator_point_transactions`. Client Credit spend,
manual Client Credit adjustments and low Client Credit balances remain on the Client Credit ledger.
Historical payout-like Client Credit rows are no longer presented as current Operator Points. This
is a source-alignment change only; no new SLA formula, financial-revenue claim or browser-side points
calculation was introduced. P05 still blocks final SLA/alert semantics, and live DB aggregation,
Realtime and browser integration remain **NOT VERIFIED**.

## Efficiency and responsive UX evidence — 2026-11-05

- Dashboard sections retain independent reads and failure states, so one source does not block the
  full screen. Identity-scoped caches reject stale completions and preserve verified data through a
  failed refresh. Existing recent-conversation and advanced-analytics source caps remain explicit;
  no browser-side unbounded history fetch was introduced by this package.
- Offline tests cover request identity, retained cache, retry, malformed responses and Realtime
  cleanup. They do not measure latency or production aggregation cost.
- Live query plans, production-scale aggregation, browser chart/layout responsiveness and Realtime
  fan-out remain **NOT VERIFIED**. The documented 10,000-row analytics caps are coverage limits, not
  performance evidence.

## Independent operational wait metric — offline draft, 2026-11-05

- A server-owned wait cycle starts from the existing `pending_since`, is not reset by additional
  client messages in the same cycle, and ends when handling is cleared. The seven-minute target is
  independent of the 180-second ownership inactivity release.
- Alert emission is once per wait cycle. The dashboard reads a dedicated aggregate RPC in its own
  identity-scoped query, so failure does not hide the existing operations snapshot and cached data
  remains visible after refresh failure.
- Focused component coverage verifies the server result, independent failure and existing polling
  cleanup. DB trigger/alert cases are written and **NOT RUN**; scheduler wiring, live Realtime and
  browser behavior remain **NOT VERIFIED**.
- The same operations area now reads a separate server aggregate for unresolved allocation
  evidence, failed/unallocated Gift rewards, failed media cleanup and blocked/failed deletion
  workflows. Failure of this aggregate does not hide the established snapshot or wait metric, and
  the display does not label Client Credits as monetary revenue.
