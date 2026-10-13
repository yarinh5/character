# Local database regression tests

V4-3 database tests run only against the repository-local Supabase stack.
They use synthetic deterministic UUIDs and `example.invalid` identities. Each
suite creates pgTAP inside its own transaction and finishes with `ROLLBACK`, so
fixtures, settings, ledger effects, and helper functions do not persist.

pgTAP `1.3.3` is currently installed persistently as local test tooling. A
`CREATE EXTENSION IF NOT EXISTS` statement inside a transaction that rolls back
does not itself persist a new installation; this is distinct from the runner's
local tooling setup and from transactional fixtures.

Run the first authorization and idempotency batch with:

```powershell
npm run test:db
```

`test:db` uses `run-db-local.mjs`, not `supabase test db`. Before it copies a
test or executes SQL, the runner requires an exact agreement among
`supabase/config.toml`, `supabase status --output json`, and Docker for the
repository project ID, loopback API/DB ports, and the running healthy DB and
API container IDs. pgTAP executes through `docker exec` in that validated DB
container only. Test files are copied to a run-scoped `/tmp` directory inside
that container and removed in `finally`; validation failure happens before any
copy, extension installation, or SQL. The runner never accepts `--linked`, a
remote endpoint, or a database URL override.
The current batch covers RLS ownership, the canonical NEW queue and sequential
claim behavior, Admin-only operations snapshots, and paid-sticker idempotency.
Sequential pgTAP claim coverage is not a true two-session concurrency test.
Separate HTTP and local Edge/Storage coverage is documented in
`http/README.md`.

## Two-session claim concurrency

Run `npm run test:concurrency` against the already running repository-local
stack. The runner discovers API and database ports from `supabase/config.toml`,
`supabase status --output json`, and the exact local Docker container mappings;
all three must agree on the expected project identity and loopback endpoints.
The dependency-free Node harness opens two independent `psql` sessions inside
the exact local DB container and a third observer connection. Each claim runs
as `authenticated` with transaction-local operator JWT claims; both the SQL
role and `auth.uid()` are asserted before calling the product RPC.

Session A claims the item and holds its transaction open. Session B attempts
the same claim. The observer must see B waiting on a PostgreSQL lock with A
in `pg_blocking_pids(B)` before A commits. Polling alone is not proof. Both
operator orders are tested, including loser rejection, a single active cycle,
matching responsibility, no extra work item/cycle, winner retry, and unchanged
ledger counts. Query, lock, idle-transaction and host watchdog timeouts bound
execution. No claim implementation, settings, grants, or triggers are changed.

Fixtures use run-specific UUIDs and `example.invalid` identities. Setup is
atomic; cleanup closes actor sessions, terminates only exact harness-named
backends if necessary, and removes only the run's fixture graph in FK order.
Counts, all settings, and migration history are compared with the pre-run
baseline after each scenario. Cleanup failure is a failing run, not a pass.
Abrupt host/Docker failure can interrupt cleanup; do not reset or blindly rerun
if postflight is unverified.

This proves DB claim exclusivity only. HTTP claim races, Realtime, message
sending rules, capacity, fairness, and oldest-first scheduling are not covered
by this harness.

## WP01 handling-order and cutover-barrier concurrency

Run `npm run test:handling-concurrency` after applying the WP01 shadow
migrations. The harness uses two physical writer sessions plus an observer. It
calls the real send RPCs as authenticated actors and proves Client/Client
serialization plus both orders for competing Client and cycle-owner business
messages: Client then Operator ends with `needs_handling=false`; Operator then
Client ends with `needs_handling=true`. Every run produces unique contiguous
per-conversation sequences in PostgreSQL lock order.

A barrier scenario first holds the conversation row lock, then starts the real
Client send RPC. The observer must see the RPC waiting on that row while an
independent exclusive cutover session waits behind the RPC's already-held
shared barrier. A final race runs backfill while a live RPC holds the
conversation lock and verifies that both historical and live messages retain
complete metadata and state. The exclusive session rolls back without changing
`legacy_shadow`; the test does not perform cutover.

## WP01 113-to-116 upgrade rehearsal

Run `npm run test:upgrade:wp01` only against the isolated local stack. It
discovers the active local ports through the same config/status/Docker agreement
and uses the CLI's local versioned reset to build migration 113, loads the deterministic
`wp01-shadow-113-fixture.sql`, applies migrations 114-116 normally, executes the
backfill, and verifies classified Client, Operator, closed, active-cycle and
ambiguous Admin histories. The ambiguous Admin row remains an explicit
unresolved issue, `shadow_consistent` remains false for that fixture, and
`cutover_authorized` remains false. Target validation completes before any
reset, migration, fixture, or cleanup call. Once the first reset has begun, a
best-effort `finally` reset restores an empty local 116-migration baseline even
when the rehearsal fails. The harness never edits migration history and never
accepts a linked or remote target. Every reset is bound to the validated
project ID, config hash, API/DB ports, and exact running Docker container IDs.
A successful database reset may rebind only the DB container ID after the same
project/config/ports/API identity is revalidated; other identity drift rejects
the reset and requires manual cleanup of the original validated target.

The WP01 pgTAP suite also verifies that direct authenticated conversation
updates are limited to `status`, every conversation statement participates in
the writer barrier, and an active-cycle owner can use the real send RPC without
reading or mutating a contradictory legacy lock. Reconciliation treats sequence
gaps as legal, derives business state by sequence rather than timestamps, checks
the rolling 180-second expiry, and requires unresolved evidence for every
state-changing `unclassified` message. Empty, none-only and System-only histories
remain non-pending; System messages never create reconciliation issues.

This is DB transaction evidence for WP01.1-WP01.3 only. It does not activate
the shadow state, remove the legacy first-response trigger, implement timeout,
capacity, fairness, release semantics, Admin takeover, HTTP races or Realtime.

The local Supabase Postgres image `17.6.1.106` matches upstream reports where a
revoked-function invocation by reserved `anon` or `authenticated` crashes the
local database with SIGSEGV and recovery instead of returning a permission
error. See [supabase/postgres#2112](https://github.com/supabase/postgres/issues/2112)
and [supabase/supabase#48614](https://github.com/supabase/supabase/issues/48614).
The local stack also loads `supautils`, but its involvement is an upstream
hypothesis rather than an independently proven root cause here. The Admin
snapshot suite therefore verifies anonymous EXECUTE ACLs, rather than directly
invoking a function that has no anonymous EXECUTE grant. Direct anonymous RPC
invocation remains unverified locally until that runtime issue is resolved.
