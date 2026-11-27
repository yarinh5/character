# WP04 — Existing profile editing and discovery UI

Date: 2026-10-31 (Asia/Jerusalem)

## Source and boundary

Execution source: `WP04 — Existing Profile Editing and Discovery UI, First Independent Slice`.
Requirements: `Product Specification and Work Plan 2026-10-06.md`, gaps D–E, R04 and WP04, subject to the approved slice and later decisions.

Approved baseline: `0107fcca6f18b5af450ed49011129197126d0bb5` (the WP03 merge).
`origin/main` matched this baseline at preflight. Work is isolated on `codex/wp04-profile-discovery-ui` in the dedicated WP04 worktree; the WP03 branch was not reused. WP01.5 remains OPEN/PAUSED and its worktree and snapshot were not changed.

## Character profile and favorites workflow — 2026-11-01

### P05 authoritative availability — implemented Offline

- Discovery already used `private.character_live_availability`; profile, favorites and client chat now use the same server contract.
- A character is available only when its configured state permits it and at least one assigned operator is active, connected (`presence_status=online`) and inside the existing heartbeat TTL.
- Conversation assignment or a Realtime participant alone does not establish availability. Client chat polls the authoritative RPC every 30 seconds and exposes loading, error and explicit retry states.
- The RPC only reports active, visible requested characters and does not grant conversation read/send access. Live expiry and multi-operator behavior remain DB/HTTP acceptance work.

This follow-up slice starts from approved `main` baseline
`68a93f8dcd4026a5754b53af5db400da52668e36` on the isolated branch
`codex/wp04-character-favorites-ui`. The profile editing and Discovery work described below was
already merged before this slice; it is preserved. This slice extends only the existing client
character profile, favorites list, favorites hook and card.

### KEEP / MODIFY / EXTEND

- KEEP: the existing routes, profile gallery and content, Like meaning, favorite ordering,
  active/visible character filters, `client_hidden_at`/conversation status filters, query-key
  prefixes and the existing `set_character_favorite` and `start_or_get_conversation` contracts.
- MODIFY: both screens now wait for an initialized matching Client Auth/session identity. Reads,
  cached views and actions are scoped by identity (including a logout/re-auth generation) and
  character. Late completions cannot navigate, toast, roll back another identity or continue the
  old favorites enrichment chain.
- MODIFY: profile and favorites reads validate only fields consumed by these views, including
  nullable character relations and finite numbers. Verified missing/empty results remain distinct
  from malformed payloads and read failures. Cached data stays visible after a refresh failure with
  one disabled-while-fetching retry path.
- MODIFY: favorite writes use a synchronous lock and validate `character_id`, `is_favorite` and
  `idempotent`. Explicit failure restores only the captured cache. An ambiguous transport or
  unverifiable result triggers read reconciliation without an automatic write retry. A confirmed
  mutation followed by refresh failure is reported separately, and retry performs only the read.
- EXTEND: the favorite card links its image and name to the existing character profile without
  nesting the remove/chat actions. Conversation actions retain direct navigation for a verified
  existing profile conversation and the existing RPC elsewhere, validate UUID results, and lock
  before profile telemetry or any other await.
- EXTEND: focused component/hook regressions cover Auth loading/mismatch/logout, identity and route
  switches, malformed and legal-null payloads, cached refresh recovery, idempotent/explicit/
  ambiguous favorite outcomes, isolated rollback, post-mutation refresh failure, same-tick double
  clicks, pending telemetry, invalid conversation IDs and suppression of late navigation/toasts.

### Verification and remaining boundary

- Initial RED on the approved baseline: 13 of the new regressions failed while the existing
  Discovery suite remained green. The failures matched the missing Auth matching, response
  validation, cached refresh warning, synchronous locks, late-completion guards and profile link.
- Current focused result: 26/26 passed across
  `client-character-profile`, `client-favorites-workflow` and the preserved
  `client-discovery-states` suites. Full Vitest: 365 passed / 24 skipped (26 files passed, 6
  skipped). Format, changed-file lint, typecheck and the client/SSR production build passed on the
  final snapshot. The build retained the existing large-chunk and `punycode` deprecation warnings;
  Vitest retained jsdom's existing unsupported document-navigation notice.
- Browser RTL/mobile/desktop and live Auth/Supabase/RLS integration: **NOT VERIFIED**. The repository
  has no isolated backend-free browser path for these authenticated routes, and no harness or live
  environment was introduced.
- No backend, RPC, schema, migration, RLS, generated type, dependency, workflow or runtime-service
  change was made. This UI evidence does not prove server authorization, canonical conversation
  history, WP04 completion or AC09–AC11.
- Return condition: before accepting access/conversation integration, re-verify the relevant
  WP01–WP02 contracts and run an authorized end-to-end flow. WP01.5 remains OPEN/PAUSED.

### Favorites lifecycle and response-contract correction — 2026-11-02

- F1: profile and favorites actions now require a currently mounted identity/character scope after
  every awaited boundary. Unmount, logout, identity replacement, character A→B→A and StrictMode
  cleanup invalidate old work. Pending and refresh state is keyed to the active identity, and an old
  completion cannot navigate, toast, write cache, roll back another identity or release its lock.
  This is client-side completion isolation only; a request already dispatched to the server is not
  claimed to be cancelled.
- F2: rejected promises, resolved transport failures and malformed favorite replies are treated as
  ambiguous after dispatch. They trigger one read-only reconciliation and never an automatic second
  write. When that read also fails, the last valid cache is restored with an explicit uncertainty
  warning and a read retry. A proven server rejection still follows the ordinary failure/rollback
  path, while a confirmed mutation followed by refresh failure remains a separate state.
- F3: favorites preference and conversation reads no longer normalize `null` to a verified empty
  array. Character availability accepts only the existing string enum without coercion, and a
  profile response must match the requested character ID. Legal empty arrays, zero values and
  nullable fields remain accepted according to the existing contract.
- RED evidence: the focused regression run failed 8 of 25 cases on the reviewed snapshot, matching
  the confirmed lifecycle, rejected-transport, null-normalization, availability and profile-ID
  gaps. The subsequent StrictMode regression also reproduced the effect cleanup/setup defect before
  the lifecycle setup was corrected.
- Current focused result: 43/43 passed across `client-character-profile`,
  `client-favorites-workflow` and the preserved `client-discovery-states` suite. Coverage includes
  unmount/remount and StrictMode, A→B→A scopes, stale locks and reads, explicit and ambiguous write
  outcomes, failed reconciliation with recovery, `null` versus `[]`, strict enums, wrong profile ID
  and legal nullable payloads.
- Final repository verification on the correction snapshot: full Vitest 382 passed / 24 skipped (26
  files passed, 6 skipped); format, changed-file lint, typecheck and client/SSR build passed. The
  existing jsdom navigation notice, large client chunk warning and `punycode` deprecation remained.
- Browser RTL/mobile/desktop and live Auth/Supabase/RLS integration remain **NOT VERIFIED**. The
  regression evidence uses real screens/hooks with mocked I/O and does not prove server-side
  cancellation, authorization or idempotency. No backend, RPC, schema, migration, RLS, dependency,
  workflow or runtime environment was changed.

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

## Connected server contracts — offline draft, 2026-11-05

- A forward-only migration extends the existing active-client guard so the approved mandatory
  onboarding flag is enforced by server RPCs, not only by the profile screen. Existing users remain
  on the current rollout behavior while the flag is disabled.
- Discovery distance is calculated from the stored client and character city coordinates with a
  server-side maximum-distance predicate. Missing coordinates remain unknown; they are not rendered
  as a false zero distance.
- A successful Like creates or refreshes one canonical client/character Lead. Retry does not create
  a duplicate, and Lead reads are limited to admins and operators assigned to the character. It does
  not create a chat message, NEW item or outreach action.
- The existing conversation entry RPC now opens or returns the canonical client/character
  conversation without assigning an operator. Historical hidden conversations remain the same
  canonical conversation rather than being replaced by a parallel history.
- Existing profile, Discovery, favorites and conversation component regressions pass on the local
  draft. The new DB contract suite is written for an authorized future environment and is **NOT
  RUN** here.

P07 is now decided and implemented Offline: the canonical row keeps `new`/`in_progress`/`closed`,
Unlike closes without deleting audit history, and a later Like marks renewed interest without
reopening the closed Lead. An assigned operator or Admin must explicitly resume treatment through
the existing authorized RPC. Live migrations, RLS, distance data, Auth and end-to-end conversation
integration are **NOT VERIFIED**; WP04 and AC09–AC11 remain open pending those gates.

## Existing profile completion slice — 2026-11-04

- Baseline: merged `main` at `652047682250f3f2bcbf7a921ba843cbde721d44`, isolated on
  `codex/product-completion`. WP01.5 remains paused on its separate unchanged snapshot.
- KEEP: the current profile route, two-write save contract, returned-row verification, avatar
  queue/retry behavior, identity lifetime guards, onboarding values and Discovery contracts.
- EXTEND: the same profile form now exposes the already-approved stored fields `first_name`,
  `last_name`, `date_of_birth`, `city_id`, preferred age range and distance, plus content and
  character preferences. Active cities come from the existing `discovery_cities` read; no parallel
  profile screen or new data contract was introduced.
- Changed extended fields are sent through the existing user-scoped `client_profiles` update.
  Untouched null/legacy values are not normalized or resent. Date-of-birth changes keep the existing
  legacy `age` and `computed_age` values aligned; local validation rejects invalid adult age,
  preference range and distance before either write starts.
- RED: five new component expectations failed on the baseline because the fields were absent. The
  final focused profile suite passes 34/34. Typecheck passes after representing the city-list mock
  as the array response used by the real query.
- Consolidated final gates on this local snapshot: full Vitest 393 passed / 24 existing skipped;
  format, changed-file lint, typecheck, client build and SSR build passed. The existing jsdom
  navigation notice, `punycode` deprecation and large client-chunk advisory remain non-failing.
- Browser RTL/mobile/desktop and live Auth/Supabase/RLS integration remain **NOT VERIFIED**. No
  schema, migration, grant, RLS, dependency, runtime service or environment was changed or applied.
- This slice does not resolve the server gate, Lead lifecycle, presence/distance semantics, multiple
  profile images or continuous conversation acceptance. WP04 and AC09–AC11 therefore remain open.
- Focused completion review: the direct profile update remains within the existing authenticated
  active-owner `UPDATE` policy and the database constraints for age, preference range and distance;
  the onboarding-completion RPC is therefore not substituted for this edit path. The review did
  find that the newly added active-city query trusted an unchecked array cast. City rows are now
  accepted only when every consumed `id` and Hebrew display name is a string. A malformed response
  keeps the form non-writable and exposes the existing generic retryable load state. The focused
  profile and audit suites pass 46/46 after this correction. Live PostgREST/RLS behavior and browser
  layout remain **NOT VERIFIED**.

## Efficiency and responsive UX evidence — 2026-11-05

- Profile bootstrap requests only consumed fields and runs independent reads together. Discovery
  remains a server-filtered single-card read keyed by identity and filters; Lead access is a bounded
  server read rather than a browser-side scan. Existing profile data and drafts remain visible during
  same-identity writes/refreshes, with local pending controls and stale-identity guards.
- Offline regressions cover conditional payloads, double-submit protection, pending avatar
  completion, retained drafts, late responses, identity replacement, Discovery filters and the
  bounded Lead request.
- Browser RTL/responsive/focus behavior, live query plans and whether Lead history needs a cursor
  beyond the current bounded 100-row contract remain **NOT VERIFIED**. No latency benchmark or
  comparative performance claim was made.

## Lead lifecycle completion — offline implementation, 2026-11-11

- A true Like creates one canonical Lead. Unlike closes the active interest but retains the same
  historical row. A later Like updates interest/timestamps without resetting status or `closed_at`;
  retry of the same transition does not duplicate the Lead.
- Assigned operators and admins can move an active Lead through `new`, `in_progress` and `closed`.
  The RPC verifies authorization and returns the updated row; the existing workspace validates that
  response and blocks duplicate status submissions.
- Component regressions cover the status update contract, duplicate-submit protection, a closed
  unlike result and explicit staff resume after re-like. The pgTAP lifecycle cases for authorization,
  close, preserved audit and explicit resume are written and
  **NOT RUN**. Live RLS, DB triggers, Realtime and browser behavior remain **NOT VERIFIED**.

## Connected completion gaps — offline draft, 2026-11-05

- Discovery availability now derives its online signal from an active assigned operator with an
  `online` presence and a heartbeat inside the existing stale window. The configured character
  state is retained only while that server-side condition holds; otherwise the returned state is
  `offline`. No client-side presence inference was introduced.
- The existing ONLINE list keeps its currently authorized display-name search. R03 city/age search,
  real client presence and server-side cursor pagination require a read contract that exposes those
  fields without undoing the existing operator PII boundary. The later RLS migration explicitly
  removes direct operator access to `client_profiles`; the attempted direct enrichment was therefore
  rejected before delivery. These fields remain dependent on the accepted WP01.5 read-access
  integration and were not replaced with a parallel authority surface.
- A versioned consent document/acceptance contract and onboarding UI are present but disabled by
  default. Enabling the flag without at least one active required document fails closed. The UI
  loads the configured title/link, requires each required document and records its exact document
  ID before completing onboarding. No legal text, version or production URL was invented by the
  migration; activation requires separately approved content and configuration.
- Focused UI regressions pass 22/22 for ONLINE routing/list, Discovery states and onboarding consent
  sequencing, including disabled rollout and fail-closed requirement loading. The consolidated
  Offline Vitest snapshot passes 444 tests with 27 existing skips. The pgTAP cases for
  default-disabled rollout, fail-closed configuration,
  idempotent version acceptance, server gating and heartbeat-derived availability are written and
  **NOT RUN**. Browser RTL/responsive behavior and live Auth/PostgREST/RLS/Realtime behavior remain
  **NOT VERIFIED**.

## Profile-image management — offline implementation, 2026-11-11

- Profile and onboarding now share one RTL/responsive image manager for up to six images, explicit
  primary selection, keyboard-operable ordering and removal. Removing the primary selects the next
  image in order; an empty list renders an explicit empty state.
- Legacy profiles above six retain every image and may reorder or remove them, but cannot add. The
  server RPC locks the profile row, validates newly added objects against the authenticated owner's
  Storage folder, MIME and five-megabyte limit, and commits ordered images plus the public avatar
  projection in one transaction.
- Removed owned paths enter a private `pending_reference_check` queue. Browser code does not delete
  Storage objects from URLs, and no worker may delete until it proves that no profile still refers
  to the object; uncertain objects are retained.
- Focused component and Offline migration regressions cover the cap, legacy behavior, next-primary,
  ordering, atomic returned-row verification and retained cleanup. pgTAP Storage/RLS/concurrency
  cases are written and **NOT RUN**. Live Storage, Auth and RLS behavior remains **NOT VERIFIED**;
  no migration was applied.

## Personal hide and canonical resume, 2026-11-26

The existing RPC skipped hidden conversations and created a second history.
A forward-only migration now restores the owner's hidden, non-closed row
under the existing pair lock, with WP10 deletion access enforced. The chat
dialog describes a reversible hide. Existing visible conversations are
preferred; closed rows and historical duplicates are not merged or revived.

Live pgTAP passed 102/102 after reproducing the duplicate and the review's
deletion-block edge case. A real two-session race verified that a competing
admin status change leaves the losing hidden history intact. A synthetic
browser journey showed an empty list after hide and then the original
conversation and message after reopen; the original single charge and
balance were unchanged. Full Vitest passed 817/817 and typecheck passed.
The task resources were removed without changing the pre-existing inventory.
Evidence: `wp04-conversation-reopen-20261126-01/REPORT.md` in local task
evidence. This verifies the scoped AC11 route, not the formal Product run or
a backfill of previously split histories.

## Profile images in a browser, 2026-11-26

- The authenticated profile owner uploaded two synthetic WebP files via the
  browser crop dialog. Both served from Storage and decoded at 512×512.
  Choosing a different primary and reordering by keyboard persisted through
  reload. Removing the primary selected the remaining image and updated the
  avatar projection. The old object stayed in Storage under the owner's
  folder, with one `pending_reference_check` row, not a client-side deletion.
- The crop dialog sent focus to the document body on Escape. Its custom
  file chooser opener is not a Radix dialog trigger, so the close handler
  now explicitly restores focus to that button when available. Escape and
  keyboard Cancel returned focus in the browser; the 375px RTL Escape check
  showed no horizontal overflow. Two direct regressions were RED before the
  change. No upload or image change occurred on cancellation.
- Live SQL suites passed 146/146, including 12 image management checks;
  full Vitest passed 828/828, typecheck passed, and the final focused
  Vitest run passed 63/63.
  A different authenticated user received `profile_image_not_owned`
  when trying to persist the owner's object. The task removed only its own
  resources. Evidence:
  `F:/project love/character/.codex-task/wp04-profile-20261126-01/REPORT.md`.
  Onboarding, provider delivery and formal Product acceptance are separate.

## Mandatory onboarding and activation, 2026-11-26

- Real Auth rejected signup without admission and created no user. In a
  separate disposable account, mandatory onboarding blocked both protected
  navigation and `start_or_get_conversation` before completion. The
  onboarding writes were also blocked by two circular prerequisites:
  readiness and registration activation.
- Draft and completion now share the same account/recovery/deletion
  safeguards as business operations. A registered, unactivated client
  must have a verified email and the applicable age declaration before
  saving. A configured consent policy must be valid; completion still
  requires its accepted documents. Business callers still require
  activation, consent and readiness. The numeric-step matcher now accepts
  the browser's valid JSON number and keeps the existing 0–3 range.
- The browser showed the age error for rejected underage data, resumed the
  saved draft after reload, completed all steps and opened the same
  protected chat returned by the authenticated RPC. PostgreSQL confirmed
  exact fields, one activation, one signup credit, and no consent records
  in the live browser fixture. The final DB applied 176 migrations with no
  seed; five live pgTAP suites passed 204/204. Full Vitest passed 829/829
  with two workers after one unrelated timeout at default concurrency.
- Evidence:
  `F:/project love/character/.codex-task/wp04-onboarding-20261126-01/REPORT.md`.
  Successful external signup/email delivery, real consent rollout and
  integrated Product are not established by this scope.
