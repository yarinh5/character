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

## Consolidated-plan delta — 2026-11-04

- The current merged model was checked only at its direct WP05 boundaries. It still stores one
  `character_id` and one `media_tag_id` on each asset and reserves the asset itself, while the target
  contract requires reusable asset↔character/tag relationships plus delivery uniqueness by
  `asset + client` across characters.
- The existing picker, reservation, attachment, secure-view, admin ingest/tag/delete and historical
  rights paths are interdependent. A safe change therefore requires one coordinated forward-only
  schema/RPC/backfill package with DB/HTTP/concurrency evidence; a UI-only or partial table change
  would introduce a competing source of truth and was not made.
- P01 still blocks only the regular-image viewing-window policy. It does not redefine the approved
  locked-image 60-second window, but that independent rule was not altered here.
- Return condition: approve the coordinated WP05 migration package and its offline contract tests,
  then run the separate authorized live DB/HTTP/concurrency gate. Current UI tests do not establish
  AC12, AC13 or AC33. WP01.5 remains paused and untouched.

## Canonical media delivery offline package — 2026-11-05

The coordinated WP05 draft now extends the existing paths instead of introducing a parallel media
model:

- Canonical join tables represent asset-to-character and asset-to-tag assignments, while the legacy
  primary fields remain a coherent compatibility pair. Duplicate inputs are normalized, invalid
  cross-character tags are rejected, and a global asset may intentionally have empty canonical
  assignments.
- A durable delivery ledger and active-reservation uniqueness use `asset + client`. Asset status is
  no longer consumed globally. Historical attachments are backfilled deterministically; later
  duplicate historical deliveries are retained as explicit private conflict evidence rather than
  deleted or invented.
- Reserve, standard send, locked send and release follow the same conversation → expiry → asset
  (when needed) → reservation lock order. Message, attachment, delivery and reservation consumption
  remain inside the existing transactional send RPC. Retry of a consumed reservation returns the
  existing message.
- Admin tag counts/deletion use canonical tag assignments. Assignment changes and legacy tag
  assignment remain audited. Hard delete remains blocked by reservations, deliveries, historical
  attachments, global visibility or shared character assignments.
- The existing admin dialog can add or remove the current character, preserve tags belonging to
  other characters, toggle the general catalog and filter by any canonical tag. A successful write
  followed by failed refresh is reported separately and cached data/draft controls remain usable.
- The existing operator picker filters every canonical tag, keeps cached catalog data with a retry
  warning after refresh failure, removes delivered assets after a successful refresh, and clears old
  conversation data before accepting a new conversation result. No direct Realtime/RLS exposure was
  added for the canonical tables.

Offline component evidence covers multi-tag filtering, shared tags, add/remove assignment behavior,
failed refresh with cache, retry recovery, catalog removal after delivery, stale conversation
completion and already-delivered errors. The DB and HTTP suites were extended with behavioral cases
for two clients, cross-character duplicate delivery, idempotent/concurrent sends from separate
sessions, release/expiry, canonical assignment normalization, permissions and historical backfill
contracts. Those DB/HTTP cases are **NOT RUN** in this no-runtime package.

Final offline verification on this revision: WP05 focused component/lifecycle suites **71/71**;
preserved profile/audit regression suites **61/61**; full Vitest **415 passed / 27 skipped**; format,
lint, typecheck and client/SSR build **PASS**. The skipped suites include the intentionally disabled
live-service paths and are not counted as evidence for the migration, RLS, HTTP, Storage or Realtime
contracts.

P01 remains open, so the regular-image viewing-window policy was not changed. Locked-image behavior,
legacy attachment rights, upload/processing and paid-open contracts are preserved. Live migration,
RLS, Storage, HTTP, Realtime, browser RTL/mobile/desktop, QA and Production remain **NOT VERIFIED / NOT
EXECUTED**. This is an offline implementation package and does not close WP05, AC12, AC13 or AC33.

## Efficiency and responsive UX evidence — 2026-11-05

- Catalog and tag reads request the fields consumed by the existing dialogs, keep verified cached
  rows during refresh failure, and scope late completions to the active character/conversation.
  Gift data is loaded only when the paid-open mode is selected. Reservation/send controls expose
  local pending states and prevent duplicate reservation/send work.
- Offline regressions cover read call boundaries, cached refresh/retry, late conversation results,
  selection preservation and pending actions. Canonical assignment/delivery indexes were added only
  for the concrete join, client-delivery and active-reservation access paths; migrations are **NOT
  APPLIED**.
- Live query plans, catalog size behavior, image loading/layout in a browser and the need for a
  future server cursor for very large per-character catalogs remain **NOT VERIFIED**. No measured
  speed improvement is claimed.

## Ownership binding, catalog invalidation and P01 proposal — offline draft, 2026-11-05

- New reservations are bound to the active handling-cycle authority and cannot be sent after that
  cycle ends or ownership changes. Existing active reservations are backfilled only when an active
  matching cycle exists; expired-cycle cleanup remains server-side.
- A bounded per-character/global catalog version feed invalidates the open picker without exposing
  private delivery history. The picker removes its Realtime channel on close, conversation change
  and unmount; live publication/RLS delivery is **NOT VERIFIED**.
- The proposed regular-image 60-second contract is present behind a disabled server flag. New rows
  can be version-bound only after signed activation, while legacy attachments retain the seven-second
  contract. Locked, client-upload and Gift access paths are unchanged. No flag was enabled and no
  migration was applied.
- Offline component coverage verifies the server-authorized 60-second rendering path and existing
  picker lifecycle. The DB policy/default tests are written and **NOT RUN**; P01 approval and live
  signed-media verification are still required before activation.

## P01 policy decision — offline activation draft, 2026-11-10

- P01 now adopts the documented recommendation: a new regular `view_once` attachment receives a
  60-second window from the first authorized open recorded by the server. Failed opens, refreshes,
  retries and signed-URL issuance do not restart or extend the window.
- The migration enables this policy for new rows and retains the `legacy` policy version and
  seven-second behavior for existing rows. Gift/locked-image sessions and the separate 24-hour
  client-upload contract are unchanged.
- Direct Node regressions cover the setting, trigger binding, server-clock start and absence of a
  legacy rewrite. The pgTAP expectation is updated but remains **NOT RUN**; live DB/Edge/signed-URL
  acceptance is still required before Product acceptance.

## Regular-media live follow-up, 2026-11-26

On `97f6de0`, a synthetic client opened a new view-once image through the
actual chat, Edge signer and private Storage. It decoded on open and reload;
the server opening time, 60-second deadline and balance did not change.
After expiry the chat showed the seen state without an image or open control.
A fresh signature returned 404 and Storage rejected a previously successful URL.

Three PostgreSQL suites passed 106/106, including delivery to a different
client and same-client uniqueness. Evidence:
`F:/project love/character/.codex-task/wp05-regular-20261126-01/REPORT.md`.
This covers live P01 viewing and sequential DB delivery checks, not exact
subsecond cutoff, historical seven-second rows, new concurrent send,
the picker/admin journey, or Product PASS.

## Concurrent delivery over HTTP, 2026-11-26

On `6ad1622`, two independently authenticated operator sessions issued
parallel reservations for the same global asset and client through two
different characters. One won; the other returned the expected reservation
conflict. Two concurrent sends of the winning reservation returned the
same message, one original and one replay. A fresh reserve through the
other character was denied after delivery, and the same asset was sent
successfully to a second client. PostgreSQL showed exactly two deliveries,
two attachments and two linked messages for two clients, without an active
reservation or credit debit. The asset remained available.

Evidence: `F:/project love/character/.codex-task/wp05-send-20261126-01/REPORT.md`.
This is direct AC12/AC13 HTTP evidence on a disposable stack, not the formal
Product HTTP suite or an operator picker/admin browser journey.

## Operator picker and recipient browser, 2026-11-26

The actual mobile picker reserved media but could not show its preview: the
resolver still required the old global `reserved` stock state. The forward
migration authorizes a preview from the owned reservation, current handling
authority and catalog scope without changing the asset's global inventory.
The picker restores opener focus, and the chat translates current media and
sticker send results into its write scope only after validating read scope.

At 375px, keyboard selection decoded the private preview, cancellation
released the reservation and restored focus, and a confirmed send closed
the picker. The synthetic recipient saw the caption and decoded the image.
PostgreSQL confirmed one delivery, one consumed reservation and no debit for
the final test image. Final pgTAP: 38/38 plus 77 related checks. Full Vitest:
821/821; typecheck passed. Evidence:
`F:/project love/character/.codex-task/wp05-picker-20261126-01/REPORT.md`.
Admin browser workflow, formal Product and launch acceptance remain open.
