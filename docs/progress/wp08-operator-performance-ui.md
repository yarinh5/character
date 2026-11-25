# WP08 — Operator Performance UI Readiness

## Delivery snapshot

- Baseline: `16cd9285686b3d9a77534838c0613fea328a8c98`
- Branch: `codex/wp08-operator-performance-ui`
- Scope: existing operator performance route, focused component regressions, and this progress record.
- WP01.5 remains OPEN/PAUSED and was not modified.

## Implemented

- **KEEP:** the existing performance query function, calculations, cards, history table, chart, assigned-character rendering, Realtime table filters, and channel cleanup.
- **MODIFY:** the existing query now distinguishes initial loading, initial failure, unavailable/mismatched summaries, background refresh, and cached-data refresh failure.
- **EXTEND:** retry actions use the existing query refetch path; cached data remains visible during refresh and refresh failure.
- Query identity now includes both operator row ID and user ID so late results cannot cross operator sessions. The existing invalidation prefix, `['operator-performance', operator.id]`, remains compatible.
- Missing operator context cannot start a performance query or subscription. Logout, operator replacement, and unmount remove the previous channel and prevent stale UI from being reused.
- Error text is intentionally generic; backend error details are not rendered to the operator.

## Regression evidence

- Initial TDD run: **RED** — 11 failed / 1 passed, exposing the missing read states and a missing test-environment `ResizeObserver` stub.
- Intermediate runs: **RED** — 7 passed / 5 failed, then 11 passed / 1 failed while assertions were aligned with the real component transition.
- Original slice focused run: **PASS** — 12/12 tests.
- Covered states include initial loading/error/retry, cached refresh success/failure, empty history with genuine zero values, missing or mismatched operator context, delayed A-to-B responses, logout/unmount cleanup, subscription filters, invalidation, assignments, avatar, metrics, and chart history.

## Session identity correction

- Correction starts from `997e44e53c90182a0f1bed331bfa0d29072474b1`; the existing commit and original tests are preserved.
- The earlier operator-only tests did not cover a changed Auth session while the layout still retained the previous operator.
- **MODIFY:** the route reads the existing `useAuth` session and initialization state. An effective operator exists only after Auth initialization and when `session.user.id` matches `contextOperator.user_id`.
- Query enablement, query identity, cached-data rendering, retry visibility, and subscriptions all use that effective operator. Mismatch or logout immediately hides old data and removes the old channel; late results cannot populate the active view.
- **KEEP:** query prefix/invalidation, Realtime filters, fetch implementation, calculations, layout and Auth provider. This is a UI identity guard, not a replacement for server authorization.
- **EXTEND:** independent Auth/operator mocks cover cached A during session A-to-B mismatch, logout with stale A context, delayed refresh completion, invalidation while mismatched, subsequent valid B, initial mismatch/no session, and Auth initialization.
- **FAIL (RED):** 5 new regressions failed while the original 12 passed. Cached A remained visible and reads started without a matching ready session.
- **PASS (GREEN):** all 17 focused component tests passed after the guard was added.
- Correction gates: `npm.cmd run format:check`, `npm.cmd run lint:changed`, `npm.cmd run typecheck`, and `npm.cmd run build` **PASS**. `npm.cmd test`: **PASS**, 184 passed; **SKIPPED**, 24 existing tests. Both `git diff --check` and `git diff --cached --check` **PASS**. Build warnings: deprecated `punycode` and large chunks; tests emitted the jsdom navigation notice. No new skips or timeout changes.
- Scoped acceptance: session guard, stale-cache isolation, late-response isolation and channel cleanup are **PASS** at the component boundary. Browser/live integration remain **NOT VERIFIED**; return to them in an authorized isolated environment before product acceptance.

## Boundaries and limitations

- Browser RTL/mobile/desktop verification: **NOT VERIFIED**.
- Live Auth, Supabase, RLS, Realtime delivery, and production aggregation: **NOT VERIFIED**.
- Component tests use controlled query and subscription boundaries; they are not evidence of live integration.
- No scoring model, points model, gift behavior, purchasing event flow, payment claim, or backend contract was added or changed.
- WP08 as a whole and AC21–AC23 are not closed by this slice. Broader readiness still depends on WP02 presence work and WP07 purchase-event integration.
- Database, migrations, Security/RLS, dependencies, feature flags, and route structure: **None changed**.
- Local application, QA, Production, merge, and deploy: **NOT EXECUTED**.

## Canonical Operator Points and Gift Pool — offline draft, 2026-11-05

- Operator Points now use a dedicated decimal wallet and immutable transaction ledger. New eligible
  score events credit this ledger once and no longer mirror a monetary-looking payout into Client
  Credits. Admin correction requires an explicit reason and cannot create a negative balance.
- The existing response scorer remains the source for text and media. The established operator
  Sticker/Gift path now emits into that same score-event stream, so it participates in the shared
  conversation streak instead of a browser-side calculation. Admin messages do not earn points.
- Each successful Gift purchase emits one private reward event. Eligible operators are snapshotted
  from active, online, fresh-heartbeat rows and deduplicated by operator ID. The ten-percent pool is
  divided in six-decimal micro-units with deterministic UUID-order remainder assignment.
- A zero-eligible snapshot records zero distributed points and the full pool as unallocated; it does
  not create later allocations. For non-empty snapshots the allocation sum equals the original
  pool. Purchase/event and per-operator uniqueness prevent duplicate reward under retry.
- Operator and Admin performance screens now read the Operator Point wallet/transactions rather
  than Client Credit wallets, preserving session isolation and the existing error/cache states.

Focused component tests pass on the draft. The DB/concurrency suite covers the 100-credit/two-worker
case, exact Gift purchase/open, canonical Sticker score event and zero-eligible evidence, but is
written only and **NOT RUN**. P03 is now decided and implemented Offline: only completed text,
image and Gift messages count once; the bounded historical backfill accepts only confidently
classified events and creates no financial/reward entries or historical notifications. Live
DB/RLS/concurrency/Realtime and browser integration remain
**NOT VERIFIED**; AC21–AC23 are not closed.

## Efficiency and responsive UX evidence — 2026-11-05

- Performance reads remain server-sourced and identity-scoped; the browser does not recompute the
  points ledger. Valid cached metrics stay visible during refresh failure, old identity results are
  rejected, and Realtime channels are removed when the effective operator changes or unmounts.
  Point-history access uses the concrete operator/created-at index added by the draft migration.
- Offline component regressions cover cached refresh/retry, identity mismatch, late results,
  subscription cleanup and genuine zero values. DB reward/concurrency cases are written but **NOT
  RUN**.
- Live aggregation cost, Realtime delivery rate, chart rendering on target devices and production
  query plans remain **NOT VERIFIED**; no comparative performance statement is made.

## Client level projection — offline implementation, 2026-11-11

- Client levels are projected server-side from deduplicated qualifying message events, with the
  approved ranges L1 0–4, L2 5–24, L3 25–68, L4 69–250 and L5 251+. The browser is not a scoring
  source of truth.
- Text, completed client attachments, completed Gifts and explicit legacy Sticker events share one
  message identity. The Gift trigger now covers `started` to `purchased` even when the canonical
  message link was stored earlier. Gift open/replay and legacy promotion do not increment twice.
  Each upward transition is unique and emits one transition notification.
- Admin backfill is bounded, resumable and idempotent and intentionally emits no historical
  transition notifications. Boundary and schema cases are written for pgTAP and **NOT RUN**; live
  trigger ordering, concurrency, RLS and backfill volume remain **NOT VERIFIED**.
