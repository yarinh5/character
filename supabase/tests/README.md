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
Sequential claim coverage is not a true two-session concurrency test. API,
Edge/Storage, and multi-session tests remain deferred.

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
