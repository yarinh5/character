# WP04 — Existing profile editing and discovery UI

Date: 2026-10-31 (Asia/Jerusalem)

## Source and boundary

Execution source: `WP04 — Existing Profile Editing and Discovery UI, First Independent Slice`.
Requirements: `Product Specification and Work Plan 2026-10-06.md`, gaps D–E, R04 and WP04, subject to the approved slice and later decisions.

Approved baseline: `0107fcca6f18b5af450ed49011129197126d0bb5` (the WP03 merge).
`origin/main` matched this baseline at preflight. Work is isolated on `codex/wp04-profile-discovery-ui` in the dedicated WP04 worktree; the WP03 branch was not reused. WP01.5 remains OPEN/PAUSED and its worktree and snapshot were not changed.

## KEEP / EXTEND / MODIFY / NEW

- KEEP: existing routes, cards, form controls, avatar upload, account summary/security, wallet and notifications. Discovery hook, RPCs, query keys, filter semantics, Swipe, favorites, recycling and canonical conversation creation remain unchanged.
- EXTEND: profile editing now loads and saves `bio`, `relationship_status` and `smoking_status` through the existing `client_profiles` update filtered by the signed-in `user_id`. Options/labels match onboarding, and newly entered bio is limited to 1000 characters. Untouched null, empty and unknown legacy values are preserved, including existing interests/preferences.
- MODIFY: required profile reads must succeed before the form is writable; missing required rows, returned errors and exceptions show a generic retryable error. Saves verify both returned user rows, keep input on failure and use a synchronous lock plus `finally` to prevent duplicate requests and stuck saving state. The two existing server updates are independent; no atomicity is claimed.
- MODIFY: profile state is keyed to the authenticated user, with cleanup guards for late reads, saves and avatar responses. A response for an old user cannot populate the next user's form or show a stale save toast.
- MODIFY: an avatar completion that arrives during an active profile save is queued locally and written only after both active form writes settle. The queue distinguishes removal (`null`) from no request, coalesces callbacks with the latest choice winning, and is discarded when the keyed user form unmounts. A failed avatar write keeps the choice for an explicit retry, reports the failure and does not report the combined save as successful.
- MODIFY: Discovery distinguishes loading, background refresh, errors (including cached data), unfiltered empty and filtered no-results. Filtered no-results resets to `EMPTY_DISCOVERY_FILTERS`; retry uses the existing refetch and is disabled while fetching. No reason for an unfiltered empty response is inferred.
- NEW: two focused test files and this progress record only. No business capability was removed.

## Contract evidence

The existing generated types include all three nullable client-profile fields. The existing schema grants authenticated clients SELECT/UPDATE of their own profile; the later active-account policy retains the ownership predicate and active/non-archived account boundary. No grants, RLS, schema or generated types were changed.

The existing onboarding RPC also changes other fields and completion state, so it is not used here. Profile updates contain only display name/avatar and the five editable client-profile fields. Age, birth date, city, multiple images, consents, onboarding step/completion, flags and other preference fields are not written.

Returned row verification uses the existing Supabase update path with `select("user_id").maybeSingle()`. A successful HTTP response with no matching row or a different user row is not treated as a successful save. This is component-level verification, not live authorization evidence.

## Verification

- Focused Vitest/Testing Library coverage: 39 cases for field loading/editing, exact payloads, preservation, null/legacy, read errors/missing rows, retry, partial/zero-row/wrong-row/thrown saves, double submit, bio limits, serialized avatar callbacks and late identity responses; Discovery empty/filter reset/loading/refetch/cached-error and preserved callbacks.
- Avatar concurrency regression coverage uses the real profile screen with mocked I/O: completion during two pending form writes, partial form failure, `null` removal, last-choice-wins coalescing, identity switch/logout cancellation, and visible explicit recovery after an avatar write failure.
- First focused run: 29 passed; three additional edge cases were then added and all are included in the full suite.
- Avatar correction RED: the delayed completion test failed because only the two original form writes occurred; no queued avatar write was issued.
- Final focused run after the avatar correction: 39 passed. Final format, lint and typecheck passed.
- Full suite: 112 passed, 24 skipped (8 files passed, 6 skipped).
- TypeScript and production client/SSR build passed.
- Initial lint found only Prettier issues in a test mock chain; the file was formatted again and lint passed. No test failure was suppressed.
- Build warnings: existing large-bundle warning and `punycode` deprecation; Vitest reports jsdom's unsupported document navigation in the existing routing tests.
- Required final format/lint/typecheck and both Git diff checks are recorded in the final implementation report.

Browser UI verification (RTL, mobile and desktop): **NOT VERIFIED**. No existing isolated browser fixture/preview was found. The product routes require authenticated Supabase reads, and the repository has no backend-free browser entrypoint. No remote session, production data, prototype route or replacement test infrastructure was introduced. The test fixtures are explicitly demonstration data with mocked I/O and do not prove browser layout, server authorization or integration.

## Delivery states

This is the documentation snapshot before Git delivery; the final report records the exact commit and verified remote SHA separately.

| State                           | At this snapshot                                                               |
| ------------------------------- | ------------------------------------------------------------------------------ |
| Code                            | Implemented in the isolated WP04 worktree                                      |
| Tested                          | Component tests, full Vitest, typecheck and build passed; browser NOT VERIFIED |
| Committed                       | Original slice committed; avatar correction pending its authorized new commit  |
| Pushed                          | Original slice pushed; avatar correction pending push and remote SHA check     |
| Merged                          | NO                                                                             |
| Integrated / product acceptance | NO                                                                             |
| Delivered / deployed            | NO                                                                             |

## Deferred work

This slice does not close full WP04 or AC09–AC11. Server gate/rollout, Leads and deduplication/visibility, distance/presence, multiple profile images and continuous canonical conversation/history remain separate work. No claim, ownership, capacity, timeout, pricing, permissions, backend retirement, HTTP-2 investigation or WP01.6 work was performed.

Database/migration/security/RLS changes: None. Application in Local, QA and Production: NOT EXECUTED. Merge and product acceptance remain with Team Lead review.
