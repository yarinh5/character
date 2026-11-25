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
