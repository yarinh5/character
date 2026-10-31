# WP05 — Existing admin media UI: search and reliable read states

Date: 2026-10-31 (Asia/Jerusalem)

## Source and boundary

Execution source: `WP05 — Existing Admin Media UI: Search and Reliable Read States`.
Requirements source: `Product Specification and Work Plan 2026-10-06.md`, R05 and WP05, limited by this approved frontend slice.

Approved baseline: `fe35586c69ebe8cbdd62524acb301280cfede8eb` (WP04 merge). `origin/main` matched the baseline at preflight. Work is isolated on `codex/wp05-admin-media-ui` in a dedicated managed worktree. WP01.5 remains OPEN/PAUSED and its worktree and snapshot were not changed.

## KEEP / EXTEND / MODIFY

- KEEP: `CharacterMediaDialog`, its admin caller, the existing assets/tags RPCs and query keys, upload and processing, tag creation/edit/delete/assignment, pricing, disable/restore/hard-delete, and `useMediaViewUrl` contracts.
- EXTEND: the returned asset list can be searched locally by trimmed, case-insensitive `display_name`, safely treating a null name as an empty value. Search and the existing single-tag filter are combined.
- MODIFY: initial loading, cached refresh, read failure, true empty and filtered no-results are distinct. Assets and tags each have an explicit read-only retry; retry does not call a mutation, upload or processing path.
- MODIFY: cached data remains visible during refresh and on refetch failure, with a stale-data warning. A failed tags read is not represented as an empty tags result, and tag drafts/selection are reconciled only after a successful tags result.
- MODIFY: locked preview errors are visible and retry through the existing preview `refresh` contract. Search, tag selection, drafts and destructive-dialog state are isolated when the character changes or the dialog is reopened.
- REMOVE: None. No business capability or existing action was removed.

## Preserved contracts

The read RPC names, parameters and query keys remain unchanged:

- `get_admin_character_media_assets({ _character_id })` / `["admin-character-media", character.id]`
- `get_admin_media_tags({ _character_id })` / `["admin-character-media-tags", character.id]`

The existing mutation, function, upload and processing paths were not rewritten. A focused regression verifies the existing `disable_character_media_asset({ _asset_id })` signature, while search and read retry assert that no mutation or Edge invocation occurs. The caller, generated types, `useMediaViewUrl`, dependencies and backend were not changed.

## Verification

- RED: before the component change, 8 of 10 focused cases failed on missing accessible loading/search/retry/preview-error states; the existing character query isolation and disable signature cases passed.
- Focused Vitest/Testing Library: 11/11 passed for initial loading, true empty, combined search/tag and null name, no-results/reset, cached refresh failure/retry, assets/tags failures and read-only retry, tag-draft preservation, locked-preview error/refresh, character-switch late response, close/reopen isolation and the existing disable signature.
- Format check passed.
- Initial lint completed with two hook dependency warnings for fallback arrays. Stable typed empty constants replaced them; lint retry passed without warnings.
- Typecheck passed before and after the lint correction.
- Full Vitest: 123 passed, 24 skipped (9 files passed, 6 skipped). jsdom reported its existing unsupported document navigation message.
- Production client and SSR build passed. Existing `punycode` deprecation and large-chunk warnings remain.
- Final Git diff checks and delivery evidence are recorded in the implementation report.

Browser RTL/mobile/desktop: **NOT VERIFIED**. No existing isolated Storybook, Playwright or local authenticated fixture for the admin media dialog was found. The product route requires Auth and Supabase data. No remote backend, demo product data or replacement browser harness was introduced. Component tests with mocked I/O do not prove browser layout, live authorization or integration.

## Delivery snapshot

This record is written before the authorized Git delivery. The final implementation report is authoritative for the commit, push and remote SHA.

| State          | Status at this snapshot                                       |
| -------------- | ------------------------------------------------------------- |
| Code           | Implemented in the isolated WP05 worktree                     |
| Tests          | Focused/full Vitest, format, lint, typecheck and build passed |
| Browser        | NOT VERIFIED                                                  |
| Commit / push  | Pending final scoped diff review and delivery gates           |
| Merge / deploy | NOT EXECUTED                                                  |

## Deferred work

This slice does not implement the WP05 target media model or close WP05, AC12, AC13 or AC33. Many-to-many asset-to-character/tag relationships, global catalog behavior, delivery uniqueness by `asset + client`, reservation conversion, Realtime catalog synchronization, legacy migration/backfill and the P01 regular-image viewing policy remain separate backend/product work.

Database, migrations, Security and RLS changes: None. Local DB, QA, Production, merge and deploy: NOT EXECUTED.
