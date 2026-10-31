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
- Final focused run: **PASS** — 12/12 tests.
- Covered states include initial loading/error/retry, cached refresh success/failure, empty history with genuine zero values, missing or mismatched operator context, delayed A-to-B responses, logout/unmount cleanup, subscription filters, invalidation, assignments, avatar, metrics, and chart history.

## Boundaries and limitations

- Browser RTL/mobile/desktop verification: **NOT VERIFIED**.
- Live Auth, Supabase, RLS, Realtime delivery, and production aggregation: **NOT VERIFIED**.
- Component tests use controlled query and subscription boundaries; they are not evidence of live integration.
- No scoring model, points model, gift behavior, purchasing event flow, payment claim, or backend contract was added or changed.
- WP08 as a whole and AC21–AC23 are not closed by this slice. Broader readiness still depends on WP02 presence work and WP07 purchase-event integration.
- Database, migrations, Security/RLS, dependencies, feature flags, and route structure: **None changed**.
- Local application, QA, Production, merge, and deploy: **NOT EXECUTED**.
