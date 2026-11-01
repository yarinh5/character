# WP11 — Existing Character Catalog Workspace

## Scope

- Baseline: `fe212493b41f06b703bdbd9db5485948cf92d0a4`
- Branch: `codex/wp11-character-workspace`
- KEEP: existing route, data contracts, media dialog, upload/storage contract, and route tree.
- EXTEND: the existing admin character catalog with reliable read, filter, edit, create, city, visibility, and avatar states.
- MODIFY: `admin.characters.tsx` and the optional lifecycle contract of `AvatarUpload`.
- NEW: focused route and avatar lifecycle regression suites plus this progress record.
- REMOVE: none.

## Implemented

- Added a verified admin identity gate and identity-scoped query keys. Unmount or identity replacement invalidates local completions and notifications.
- Separated the character list from assignment and conversation counters. Each read has its own loading, error, retry, and refresh state; unavailable counters are not rendered as zero.
- Added loaded-row search, activity and visibility filters, result counts, reset, and distinct empty/no-results states.
- Added shared per-character locks for save and visibility operations, double-submit prevention, returned-row verification, and retained drafts after failure.
- Update payloads contain only edited fields, preserving untouched null and legacy values. Create keeps the existing defaults and validates the returned identifier.
- Ambiguous create failures require an explicit list check before another attempt. Successful mutation and failed refresh are reported separately.
- Preserved legacy city labels, added city read retry, and kept city creation as an explicit, separately confirmed RPC operation with local duplicate and returned-row validation.
- Added avatar upload-state coordination so save is disabled during upload, `null` remains an explicit removal request, and opted-in late upload completions are cancelled after unmount.
- Preserved the existing character media dialog and its selected-character association.

## Verification

- TDD RED: the first focused run produced 15 failed and 1 passed test, demonstrating the missing read, write, locking, identity, and avatar lifecycle behavior.
- Focused GREEN: `19/19` tests passed across the character workspace and avatar lifecycle suites.
- Full Vitest: `239 passed / 24 skipped` across `16 passed / 6 skipped` test files.
- `format:check`, `lint:changed`, `typecheck`, and the production build passed.
- React review: component structure, hook lifecycles, query identity isolation, interactive labels, and per-character operation locks were checked; no blocking finding remained.

## Boundaries and limitations

- Browser RTL/mobile/desktop verification: **NOT VERIFIED**. Evidence is component/jsdom and build verification only.
- Live Auth/Supabase integration: **NOT VERIFIED**. No remote runtime, Docker, QA, or Production environment was used.
- No backend, schema, migration, RLS, RPC signature, dependency, flag, or route-tree change was made.
- The UI admin guard is not a replacement for server authorization or RLS.
- Character creation and city creation remain separate, non-atomic operations.
- A successfully uploaded storage object is not automatically deleted if a later character write fails.
- Counters describe the currently loaded query result; they are not a full-history or aggregation guarantee.
- WP11 as a whole is not declared complete. WP01.5 remains OPEN/PAUSED and was not touched.
