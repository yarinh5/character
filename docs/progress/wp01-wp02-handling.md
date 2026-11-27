# WP01.6 / WP02 — handling ownership and automatic allocation

Date: 2026-11-05 (Asia/Jerusalem)

## Offline implementation draft

- The existing handling-cycle authority remains the sole send authority. Manual release, timeout
  and Admin transfer close that authority under the same conversation lock and create at most one
  NEW work item only when `needs_handling = true`.
- Automatic allocation selects the oldest pending work item and an eligible assigned operator who
  is active, available, online, within the heartbeat TTL and below the capacity of five. The choice
  is deterministic and biased toward the lowest active load/oldest previous assignment; viewing an
  ONLINE conversation does not consume capacity.
- The inactivity deadline is 180 seconds from the last successful business message. Heartbeat does
  not extend it. A successful owner response clears `needs_handling` without ending the cycle;
  release with no pending client work leaves the conversation unowned and out of NEW.
- Admin reassignment requires a reason and creates audit evidence. UI callers use the existing
  allocation/release/reassign RPC contracts rather than a browser-side ownership model.

Focused component tests pass on this draft. A pgTAP suite covers capacity, pending order, release,
requeue and documented Admin transfer but is written only and **NOT RUN**. WP01.5 is unchanged and
remains open; live DB/RLS/concurrency and integration against its accepted contracts remain required
before WP01.6/WP02 acceptance.

## Efficiency and responsive UX evidence — 2026-11-05

- Queue allocation stays server-side, bounded by the requested assignment count and protected by
  `SKIP LOCKED`; the browser does not download history to decide fairness or capacity. Queue and SLA
  caches are operator-scoped, Realtime channels are removed on identity/unmount, and claim controls
  expose a local pending state instead of blocking the whole route.
- Offline component coverage verifies the existing assignment/open states and actionable claim
  failures. The DB suite that exercises ordering, capacity and concurrent allocation is written but
  **NOT RUN**.
- Query plans under production volume, live Realtime/poll interaction, browser responsiveness and
  contention behavior still require an authorized live measurement. No comparative speed claim is
  made.

## Offline integration order and protected overlap — 2026-11-05

1. Review and accept the protected WP01.5 snapshot independently; do not merge or regenerate its
   manifests as part of this branch.
2. Reconcile its final read-access/cycle migrations before the local WP01.6/WP02 migration, then
   review overlaps in generated types, attachment-access hooks, operator chat/conversation routes
   and their HTTP/concurrency tests. The local migration assumes those authority contracts exist;
   it is not independently deployable proof.
3. Apply later drafts in dependency order: WP05 catalog, WP04 Leads, WP06 uploads, WP07 Gifts,
   WP08 points, WP07 requests/WP09 levels, WP10/WP11 workflows, then the disabled P01 policy draft.
   Regenerate types from the applied schema only after live migration review.
4. P01 is approved for new regular `view_once` attachments: the first authorized server open starts
   a 60-second window, while legacy rows retain seven seconds. Keep destructive deletion blocked
   until P04 retention approval. Edge functions/jobs and Realtime publication changes need
   separate environment review before any live invocation.

Required acceptance still includes empty-database and historical upgrade, DB×2/HTTP×2, concurrency,
Edge/Storage/Auth, browser RTL/mobile/accessibility, security/recovery and WP01.5's protected full
verification. None of those live gates ran in this offline package.

## Timeout cycle-binding correction — 2026-11-05

- `private.finish_handling_cycle` now loads and locks the current cycle before comparing it with the
  caller's expected cycle ID. A missing or replacement cycle still returns `released = false`, while
  the expected cycle can proceed to the existing operator and expiry revalidation.
- The pgTAP contract keeps the non-expired, refreshed-heartbeat, replacement-cycle, genuine-expiry
  and repeat-finish cases and adds an explicit missing-current-cycle case. The SQL suite is written
  but **NOT RUN**; this is static/offline evidence only and does not close the concurrency or live DB
  acceptance gap.

## Automatic allocation at capacity (2026-11-26)

- Two allocator transactions could both read four active cycles before either acquired the operator
  row. A controlled PostgreSQL schedule reproduced six active cycles after both transactions committed.
- Forward migration `20261126152000` rechecks the count in a separate statement after the operator
  row is locked, before creating a cycle. The same schedule left five cycles and kept the sixth
  request in `new` with its original waiting timestamp. Function ACLs were unchanged.
- Both offline suites passed 37/37. A fresh DB applied all 180 migrations and passed the expiry
  pgTAP 30/30. With no diagnostic hook installed, 20 authenticated `operator_heartbeat` calls filled
  100 slots, five per operator; six requests stayed in `new` and all 100 assignments matched their
  work item, conversation owner and audit record. This is scoped capacity evidence, not the two
  formal WP02 DB passes or a full Product run.
- Evidence: `F:/project love/character/.codex-task/wp02-capacity-race-20261126-01/REPORT.md`.

## Admin transfer after inactivity expiry (2026-11-27)

- A live, authenticated Admin transfer on the task-only project created an active cycle while the
  conversation's 180-second business-message deadline had already elapsed. The new owner then
  received `handling_cycle_expired` on send. This invalidates treating the earlier Admin UI
  assignment as a usable transfer; it does not invalidate the observed UI submission or audit.
- Forward migration `20261127020000` rejects a missing or elapsed deadline while holding the
  conversation lock, before changing ownership, cycles, work items, or audit. Admin activity does
  not extend the business-message clock. Its function body is byte-equivalent to the prior body
  after removing that guard. The migration was applied directly to the dedicated task DB for this
  focused check; the local migration ledger was not advanced by that direct `psql` invocation.
- WP02 pgTAP now scopes two fixture queries and the selected race cycle to its own test character
  and operator. Before migration, the new expired-transfer assertion failed as expected. After
  migration, the complete WP02 file passed 38/38; adjacent expiry and cycle-bound files passed
  30/30 and 21/21. These files run in rollback transactions.
- On the same task project, expired transfer was denied without changing the owner or cycle.
  A subsequent synthetic Client business message opened a new 180-second window, and Admin
  transfer to a second operator succeeded. The old operator's cycle-token send was denied with
  no message written; the old operator retained historical read access; the new operator sent one
  message. The old cycle had ended by timeout on the Client message, not by reassignment.
- `handling_shadow_foundation.test.sql` completed 255 assertions but reported 23 failures in
  global readiness/consistency cases against this reused task DB. Their cause remains unproven;
  this run is **not** a passing regression or integrated Product acceptance. A clean isolated DB
  pass and the formal Product gates remain required.
