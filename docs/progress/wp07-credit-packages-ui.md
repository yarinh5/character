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
