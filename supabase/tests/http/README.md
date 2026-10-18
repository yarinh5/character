# V4-3-C HTTP authorization tests

These suites run only against the repository-local Supabase stack. The
`test:http` script obtains the local API and service-role values from
`supabase status --output json` without printing them. It verifies that the
loopback API and database endpoints agree with `supabase/config.toml` and the
exact local Docker mappings for `qmgkmsarzfjnqltljkjl`, then starts Vitest with
those values in memory. No key, password or fixture token is stored in the
repository.

Fixture setup and cleanup use the local service-role/admin boundary. All
authorization assertions use real PostgREST/Auth clients with anonymous or
authenticated JWTs. The service role is never used to prove a public access
decision.

Covered through HTTP:

- canonical NEW queue filtering by assignment and operator block;
- assigned claim and safe rejection of a competing operator; the WP01 claim
  assertion also proves that a new claim returns its authoritative `cycle_id`,
  an authenticated replay returns the same ID, and exactly one matching active
  cycle exists;
- active-cycle send responsibility: the owning Operator can send, while an
  assigned non-owner and an Admin acting as Worker are rejected without message,
  attachment, sticker-attempt, score, ledger, notification, or analytics effects;
  the owner write records its active-cycle shadow token; after explicit release,
  an assigned Operator can send again only through legacy compatibility and that
  no-cycle write is visibly classified as `unclassified` for reconciliation;
- assigned Operators can update only legacy `status` directly through
  PostgREST; RLS rejects an unassigned Operator, anonymous access is denied, and
  column grants reject direct mutation of `needs_handling`, `pending_since` and
  `handling_next_sequence`; the Admin status RPC remains available;
- owner-only conversation/message/sticker access;
- non-Admin rejection and one-row Admin operations snapshot;
- paid sticker authorization, first send, same-key retry, message identity,
  debit/payout identities, signed amounts and wallet balances;
- anonymous credit-wallet rows are not exposed at the HTTP boundary.
- Client and Operator denial, Admin success, redaction, cleanup effects, and
  idempotent replay for the existing client PII archive RPC.
- local character-media catalog and reservation authorization for assigned,
  unassigned, Client and Admin actors;
- owner/assigned attachment visibility, private Storage access, and the
  `media-view-url` JWT boundary with short-lived signed URLs;
- Permanent reissue, View Once open/completion, Paid Open debit/payout and
  completion, and locked-media denial while the existing flag is disabled.

The direct anonymous invocation of the revoked Admin RPC remains explicitly
skipped because local `public.ecr.aws/supabase/postgres:17.6.1.106` has a
known SIGSEGV on the affected revoked-function path. The existing ACL/pgTAP
coverage remains the evidence for that contract; this phase does not repeat
the crash. DB-level two-session NEW claim concurrency is covered by
`npm run test:concurrency`; HTTP claim races and Realtime remain deferred.

The media suite creates one tiny synthetic `character-media` object and uses
only `v4_3_media_*` names and `example.invalid` identities. It verifies that
the public Edge response contains only `url` and `expires_at`, while direct
anonymous and Client Storage reads remain denied. The service role is used
only for fixture setup, inspection, signing inside the existing Edge Function,
and best-effort cleanup. Anonymous media RPC denial is proven by ACL pgTAP
checks rather than directly invoking the revoked functions on the affected
local PostgreSQL image. The suite does not alter `locked_images_enabled` or
any other feature setting.

The paid-sticker suite is skipped when the existing local `stickers_enabled`
setting is not `true`; the suite itself never changes feature flags. V4-3-D3
proved the HTTP contract with a separately approved, journaled local-only
activation from `false` to `true`, followed by verified restoration to
`false`. The targeted suite passed both authorization/idempotency tests, and
the full HTTP run passed all paid-sticker assertions without changing pricing
or payout rules. Future enabled runs require the same external recovery and
restoration procedure rather than flag mutation inside the test suite.

The active-cycle suite verifies the Sticker send guard before the disabled
`stickers_enabled` gate. Locked-media send remains an explicit skip while
`locked_images_enabled=false`, because that function rejects the disabled flag
before reaching the shared send guard. No feature flag is changed by these
tests.

The WP01 shadow assertions do not treat `needs_handling` as active authority.
They verify only compatibility metadata written in the same database transaction
as the existing send RPC. Cutover remains disabled, and unresolved no-cycle
writes are intentionally visible to the private readiness/reconciliation path.

The PII archive suite uses synthetic `example.invalid` users only. It proves
the database RPC contract, including that an archived Client session cannot
update its active profile through the Data API. It does not cover the
application server's Auth ban or avatar Storage deletion, and it does not
invoke the revoked anonymous RPC path on the affected local image.

Run one suite with:

```text
npm run test:http -- supabase/tests/http/authorization_new.integration.test.ts
```

Run all HTTP suites with:

```text
npm run test:http -- supabase/tests/http
```

Normal runs clean their deterministic fixture rows and Auth users in
`afterAll`, with postflight baseline checks providing the cleanup evidence.
Partial setup and failed-test paths track every Auth user immediately and
attempt every cleanup step; any cleanup failure is reported after all attempts
instead of being hidden. A clean baseline is claimed only after the explicit
postflight checks pass.

The runner records sanitized counts for `notifications`, `analytics_events`
and `audit_logs` before and after each HTTP invocation and fails on any delta.
Suites collect fixture-owned event IDs before deleting parents that can apply
`SET NULL`, repeat that collection after cleanup, and assert that no owned
events remain. The active-responsibility suite also proves that a synthetic
non-owned sentinel survives fixture cleanup and then removes it separately.
