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

The current batch covers RLS ownership, the canonical NEW queue and sequential
claim behavior, Admin-only operations snapshots, and paid-sticker idempotency.
Sequential pgTAP claim coverage is not a true two-session concurrency test.
Separate HTTP and local Edge/Storage coverage is documented in
`http/README.md`.

## Two-session claim concurrency

Run `npm run test:concurrency` against the already running repository-local
stack (API 60421, DB 60422; 109 migrations, latest 20260926232222).
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
