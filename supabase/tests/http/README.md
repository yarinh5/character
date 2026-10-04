# V4-3-C HTTP authorization tests

These suites run only against the repository-local Supabase stack. The
`test:http` script obtains the local API and service-role values from
`supabase status --output json` without printing them, verifies ports 60421 and
60422, and then starts Vitest with those values in memory. No key, password or
fixture token is stored in the repository.

Fixture setup and cleanup use the local service-role/admin boundary. All
authorization assertions use real PostgREST/Auth clients with anonymous or
authenticated JWTs. The service role is never used to prove a public access
decision.

Covered through HTTP:

- canonical NEW queue filtering by assignment and operator block;
- assigned claim and safe rejection of a competing operator;
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
the crash. True two-session concurrency and Realtime coverage remain deferred.

The media suite creates one tiny synthetic `character-media` object and uses
only `v4_3_media_*` names and `example.invalid` identities. It verifies that
the public Edge response contains only `url` and `expires_at`, while direct
anonymous and Client Storage reads remain denied. The service role is used
only for fixture setup, inspection, signing inside the existing Edge Function,
and best-effort cleanup. Anonymous media RPC denial is proven by ACL pgTAP
checks rather than directly invoking the revoked functions on the affected
local PostgreSQL image. The suite does not alter `locked_images_enabled` or
any other feature setting.

The paid-sticker suite is also skipped when the existing local
`stickers_enabled` setting is not `true`; the suite never changes feature
flags. In the current local stack that setting is `false`, so paid-sticker
HTTP proof remains blocked by the local feature prerequisite rather than being
reported as a passed financial regression.

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
