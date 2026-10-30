# WP03 — ONLINE UI alignment, first implementation slice

Date: 2026-10-30

## Sources

- Execution source: `WP03 — Existing ONLINE UI Alignment, First Implementation Slice` task packet supplied for this run.
- Approved delta assessment: `C:\Users\Yarin\AppData\Local\Temp\wp03-existing-product-delta-20261029\WP03-Existing-Product-Delta-Assessment.md`.
- Delta assessment SHA-256: `A9D7B2AD196946D34141DE81E2A99BD7A0829F17D9F3268C8A44BA7CD30BA7F7`.
- Customer commitment check: אישור לקוח לא אותר.

## KEEP / MODIFY / EXTEND / REMOVE

- KEEP: `/operator/conversations` remains the existing list implementation, with its query, cache key, subscriptions, local search, status and character filters, unread-first ordering, last-message activity ordering, chat route, NEW route and existing operator guard.
- MODIFY: the operator navigation now exposes one `ONLINE` item whose destination is `/operator/conversations`; the dashboard list link uses the same ONLINE terminology.
- EXTEND: the list now distinguishes accessible initial loading, generic retryable error, true empty inbox and filtered no-results with local reset. Retry is disabled while a refetch is pending, and `last_message_at` is described as last-message activity rather than presence.
- REMOVE: the `/operator/online` route no longer mounts the outreach candidates/composer UI. It redirects with replace to `/operator/conversations`.
- KEEP OUT OF SCOPE: outreach hooks, RPCs and backend data were not deleted or changed; no claim, capacity, permissions, timeout, backend, migration or RLS work was added.

## Delivery states

These states are intentionally separate. Commit and remote hashes are reported in the final implementation report because this file is contained by that commit.

| State              | Result                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Existing in code   | YES — implementation and tests are in the containing WP03 commit                                                     |
| Tested             | YES — focused tests 10/10; full Vitest 73 passed and 24 skipped; format, lint, typecheck and production build passed |
| Committed          | YES — containing commit on `codex/wp03-online-ui`; exact hash in final report                                        |
| Pushed             | YES — `origin/codex/wp03-online-ui`; exact remote hash in final report                                               |
| Merged             | NO — explicitly not requested                                                                                        |
| Delivered/deployed | NO — no deployment was authorized or performed                                                                       |

Browser coverage: NOT RUN. This slice was verified by component/routing tests and the required repository gates; no isolated existing authenticated browser fixture was required by the packet.

## WP01.5 overlap and deferred integration

`src/routes/operator.conversations.tsx` overlaps with the open/paused WP01.5 work. The WP01.5 worktree and snapshot were not modified. A future integration must preserve WP01.5 query/cache/subscription/revocation behavior and apply this UI delta on top; it must not restore the older baseline implementation from this branch over WP01.5.

Before integration or any declaration that full WP03 is complete, WP01.5 verification and the relevant WP01–WP02 contracts must be completed. No branch merge is performed here to resolve the overlap.

The following remain DEFERRED rather than solved by this slice:

- ownership presentation in the list;
- presence;
- city/age;
- backend retirement.

## Acceptance boundary

The defined frontend-only ONLINE alignment slice is implemented and verified. This record does not declare full WP03 DONE and does not declare AC08 end-to-end PASS.
