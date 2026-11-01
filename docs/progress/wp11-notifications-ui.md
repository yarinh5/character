# WP11 — Existing Notifications and Preferences

## Scope and baseline

- Baseline: `bd6d26c02b9f58956dfa6186f072e747768727f3` (`origin/main`, after PR #11).
- Branch: `codex/wp11-notifications-ui`; isolated worktree `wp11-notifications-ui/character`.
- KEEP: the existing `NotificationBell` placements, `NotificationSettingsCard` consumers, notification types, role mappings, links, 20-row window and current Supabase contracts.
- MODIFY/EXTEND: authenticated identity lifecycle, read/refresh/error states, write-result handling, race guards, manual retry, accessibility and mobile popover bounds.
- NEW: two focused component suites and this progress record. REMOVE: none.
- WP01.5 remains OPEN/PAUSED and was not opened, executed or changed.

## Implemented behavior

- Both components wait for initialized Auth with matching `user.id` and `session.user.id`. Preferences additionally require the supplied role to match the authenticated role; a missing or mismatched role never falls back to admin options.
- Logout, identity mismatch, user replacement and unmount hide prior state immediately, invalidate old reads/writes and clean the previous notification channel. Request generations and sequence numbers prevent older same-user and previous-user completions from overwriting newer state or emitting stale toasts.
- The bell distinguishes initial loading/error, confirmed empty, background refresh and cached refresh failure. A failed refresh keeps the verified 20-row window visible with one retry warning that clears after recovery. The unread badge describes only that loaded window.
- INSERT and UPDATE Realtime events retain the existing user filter and trigger guarded refreshes. Links and popover closing on navigation remain unchanged; the popover is viewport-bounded and long text wraps.
- Mark-all-read retains `user_id` and `is_read=false` filters, blocks same-tick double submission and verifies both returned errors and rejected promises. It never changes local unread state before a verification read. Zero updated rows are treated as a possible no-op and verified by that read; a successful update followed by failed refresh is reported separately.
- Preferences distinguish loading, read failure, unavailable table, confirmed missing row, ready, saving and save failure. Missing rows use the existing defaults without automatic upsert; unavailable-table messaging exposes no SQL or migration details.
- A switch change upserts only `user_id`, the changed boolean field and `updated_at`. The returned row must match the user and requested value before success; its verified values refresh the local settings. Failure or malformed data rolls back, reports failure and offers a read-only reload without automatic write retry.
- `email_enabled` remains disabled. Existing client/operator/admin option mappings and all backend defaults, RLS and event-generation behavior remain unchanged.

## Verification evidence

- TDD RED: the first focused run failed `24/26` assertions on the intended identity, read-state, write-result, payload and accessibility gaps; two already-supported behaviors passed. The rejection case also exposed the old unhandled promise rejection.
- GREEN: the two new component suites passed `26/26`.
- React review RED/GREEN: the unavailable-table state initially lacked its required read retry; the focused regression failed, then passed after adding the same bounded manual retry without enabling switches or writes.
- Required focused regression command passed `59/59` across notification bell, notification settings, client profile editing and operator ONLINE routing.
- Typecheck initially failed on the computed upsert payload type; the payload was bound to the generated `notification_settings.Insert` type without broadening the write. The rerun passed.
- Delivery snapshot: the required focused command passed `59/59`; full Vitest passed `317` tests with `24` existing skips (`21` passed / `6` skipped files); format, changed-file lint, typecheck and the client/SSR production build passed.
- The first format check reported the four changed TS/TSX files and passed after scoped Prettier formatting. Full Vitest retained the existing non-failing jsdom document-navigation notice; build retained the `punycode` deprecation and chunk-size advisory.

## Boundaries and remaining acceptance

- Component tests render the real components and mock only Auth, Supabase I/O and navigation. They verify chains, filters, payloads and Realtime handlers/cleanup, but do not prove live delivery, RLS enforcement or cross-browser behavior.
- Browser RTL/mobile/desktop: **NOT VERIFIED**. No browser harness or runtime service was added.
- Live Auth/Supabase/RLS/Realtime integration: **NOT VERIFIED**. No product network, SQL, Docker or Supabase runtime was used.
- No backend, schema, migration, RLS, dependency, lockfile, layout, route, email/push, SLA, ownership, claim or notification-generation change was made.
- Local/QA/Production application and deploy: not executed.
- `npm ci` reported 42 existing dependency vulnerabilities (2 low, 20 moderate, 14 high, 6 critical). Remediation is outside this allowlist.
- WP11 as a whole is not complete and no product-delivery claim is made.
