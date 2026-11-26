# WP07 — Existing credit packages UI reliability

Date: 2026-10-31 (Asia/Jerusalem)

## Source and boundary

Execution source: `WP07 — Existing Credit Packages UI Reliability`.
Requirements source: `Product Specification and Work Plan 2026-10-06.md`, R07 and the WP07 task that removes the misleading pre-payment purchase toast.

Approved baseline: `1301c802920578bdd201b01fcb6879f0ff68757a`, after PR #5. Work is isolated on `codex/wp07-credit-packages-ui`. The previous WP05 branch remains preserved. WP01.5 remains OPEN/PAUSED and its branch, worktree, snapshot and verification environment were not changed.

## KEEP / MODIFY / EXTEND

- KEEP: the existing client and admin routes, `credit_packages` catalog, query keys, active-only client filter, server ordering, package prices, UI components and `packages_viewed` analytics.
- KEEP: `ClientCreditsTab`, `CreditSettingsTab`, `admin_adjust_client_credits`, balances, ledger, credit rules and business defaults are unchanged.
- MODIFY: the client screen no longer presents a toast or button that claims a purchase request was recorded. It states that in-site purchase is unavailable and that no request or charge occurred; no contact details or future availability are invented.
- EXTEND: client and admin package reads distinguish initial loading, cached refresh, read error, stale cached data and true empty results. Retry performs only the existing catalog read.
- EXTEND: package create/update validates the existing schema limits, blocks synchronous duplicate submission, handles returned errors and thrown failures, and requires a verified returned row ID before success.
- EXTEND: a verified save closes the originating form and invalidates the existing admin and client catalog query keys. Refresh failure does not become a write failure or repeat the mutation.
- EXTEND: save completion is bound to the originating signed-in user and dialog instance. Closing, reopening, logout, user replacement or unmount suppresses stale UI completion without claiming that an already-sent database write was cancelled.
- REMOVE: only the false representation that a purchase request was recorded. No active business capability was removed.

## Preserved contracts

- Client query key: `["client-credit-packages"]`
- Admin query key: `["admin-credit-packages"]`
- Client filter: `is_active = true`
- Ordering: `sort_order ASC`, then `created_at DESC`
- Catalog writes continue to use the existing `credit_packages` insert/update API. The returned `id` is now requested and verified.
- No package action calls `admin_adjust_client_credits`; client balances, settings and other admin tabs are unchanged.

## Verification evidence

- RED: 44/44 focused cases failed before the product changes. The unsupported legacy currency cases also produced two uncaught `RangeError` failures.
- First GREEN run: 43/44 passed. The remaining failure was a Testing Library role lookup against Radix content intentionally hidden behind an open modal; the assertion was corrected to verify the rendered refresh text and disabled controls without weakening the behavior requirement.
- Focused component tests after that correction: 44/44 passed.
- Early typecheck: passed.
- Early lint: failed only on 1,073 Prettier/line-ending findings in the changed allowlisted files; formatting and final verification follow in the implementation report.
- Final focused component tests after formatting: 44/44 passed.
- Format check, lint and typecheck: passed.
- Full Vitest: 167 passed, 24 skipped (11 files passed, 6 skipped). jsdom emitted its existing unsupported document-navigation message.
- Production client and SSR build: passed. Existing `punycode` deprecation and large-chunk warnings remain.
- Git diff and delivery evidence are recorded in the final implementation report.

Browser RTL/mobile/desktop: **NOT VERIFIED**. No isolated existing preview or fixture for these authenticated routes was found. No live backend, new browser harness or test infrastructure was introduced. Component tests with mocked I/O do not prove live Auth/Supabase integration or browser layout.

## Deferred work and limitations

No payment processing, persisted purchase request, approved manual-contact route, new support channel or credit allocation flow was introduced. The choice between an approved manual contact route and a persisted handled request remains open.

Gifts, the 50/10/10 credit rules, locked-image purchase/open behavior, payment integration, AC17–AC20 and AC33 remain out of scope. This slice does not complete WP07.

Database, migrations, Security and RLS changes: None. Local DB, QA, Production, merge and deploy: NOT EXECUTED.

## Connected Gifts and credit contracts — offline draft, 2026-11-05

- The existing sticker catalog now marks canonical Gifts while preserving historical sticker rows.
  A paid attachment snapshots the exact Gift ID, name and price; a different or merely more
  expensive Gift cannot open it.
- Purchase, 60-second open and media resolution are separate server operations with separate
  idempotency keys. One purchase charges the snapshotted price once, creates one Gift message and
  one reward event; a new purchase can create a new open session while a retry cannot charge again.
- Client Credit and Operator Point ledgers are separate. The Gift debit uses the existing allowed
  `sticker_spend` transaction type with an attachment-specific reason and binds the message-sticker
  row to its payer and charge transaction.
- Signup 50, client text 10 and client image 10 are represented by the server-side settings/writers
  in this migration chain. The previously removed false package-purchase claim is not restored; an
  approved purchase/allocation channel remains a separate product dependency.
- Gift catalog loading is lazy in the existing operator picker. A Gift read failure cannot block
  ordinary media selection, and retry is read-only.

Focused component tests pass on the local draft. The DB/RLS/concurrency suite for exact Gift,
idempotency, charging, 60-second sessions and reward events is written and **NOT RUN**. Live DB,
Edge, signed URLs, Auth, concurrency and browser verification remain **NOT VERIFIED**; WP07 and
AC17–AC20/AC33 are not closed.

## Efficiency and responsive UX evidence — 2026-11-05

- The Gift catalog is loaded lazily only for paid-open selection. Purchase and open retain separate
  pending/idempotency paths, so retry does not create a duplicate charge or hold the whole chat UI.
  Attachment access is read in bounded batches and late per-attachment responses cannot replace a
  newer request.
- Offline tests cover exact Gift selection, purchase/open separation, idempotency arguments,
  pending controls and access refresh behavior. Live DB concurrency and signed-media access remain
  **NOT RUN**.
- Browser layout/focus, production catalog volume, live ledger contention and signed-URL latency
  require later authorized measurement. No claim that the flow is faster is made.

## Persisted credit requests — offline draft, 2026-11-05

- The client can now create a persisted, idempotent credit request without claiming that payment or
  allocation already occurred. Admin approval is a separate RPC that locks the request, writes one
  wallet transaction and returns the authoritative balance; rejection never credits the wallet.
- The admin list is bounded and resolves profiles in one batch rather than one request per row.
  Both client and admin actions use synchronous duplicate-submit guards and validate returned rows.
- Focused component regressions cover request creation, canonical approval and malformed results.
  DB/RLS/concurrency cases are written and **NOT RUN**. Payment processing remains absent, and live
  wallet contention, Auth/RLS and browser behavior remain **NOT VERIFIED**.

## Manual credit request acceptance (2026-11-26)

- Reproduced a blocked admin workflow with 100 older rejected requests and two new pending ones.
  The oldest-first query applied its limit to all statuses, hiding both actionable requests.
- The initial view now fetches only pending requests in arrival order. Resolved requests have their
  own bounded history, with the latest decisions first. Resolution refreshes both views and the
  client balances; an unverified RPC response no longer claims that the balance did not change.
- Browser and DB evidence from a fresh synthetic local stack: two requests left the wallet at 20.
  Admin approval credited 25 once, rejection created no transaction, and both decisions were
  audited. Create and approval replays returned the original records. The opposite decision and
  resolution by clients were denied, and a different client could not read the requests.
- The live WP07/WP11 pgTAP file passed 67/67; focused UI tests passed 48/48, the full suite passed
  830/830, and typecheck passed. The task-owned stack was removed and the previous Docker inventory
  was unchanged. No payment provider, concurrent credit resolutions, production catalog, or
  integrated Product acceptance was tested in this run.
