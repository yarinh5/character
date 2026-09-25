# V3-2 Disposable Load Fixture

This fixture is for an isolated, disposable Supabase project only. It must never
be executed against QA or production.

## Approved run

- Project: `character-load-v3-2`
- Project ref: `micmgokyckvfpewxgrzf`
- Run ID: `load_v3_2_20260731_pilot_01`
- Tier: `pilot`
- Cleanup owner: `Yarin`
- Retention: owner-managed; no automatic deletion deadline
- Migration baseline: 104 local files / 104 target history entries
- Target history range: `20260731134101` through `20260731134814`

The data is deterministic, synthetic, and uses only `example.invalid`
identities. It creates no Storage objects and sends no email, Auth message, or
financial RPC.

## Execution order

1. `00_bootstrap.sql`
2. `10_core.sql`
3. `20_activity.sql`
4. `30_inventory.sql`
5. `40_verify.sql`
6. `50_preflight_readonly.sql`
7. `60_benchmark_readonly.sql`

Run each file through an authorized SQL channel scoped to the disposable
project. Do not use a connection string or key from QA or production.
Before running any fixture or `cleanup.sql`, manually confirm the Supabase
project ref is `micmgokyckvfpewxgrzf`. The stored ref is documentation and
fixture metadata, not a SQL-enforced environment guard.

Every UUID created by the fixture is deterministic and is recorded in
`load_v3_2.fixture_manifest`. Composite keys are recorded in the same table as
JSON. The manifest is the source of truth for targeted cleanup.

## Read-Only Baseline

Run `50_preflight_readonly.sql` only after the fixture is `ready`. It uses
`BEGIN TRANSACTION READ ONLY` and returns one PASS/FAIL row per preflight
check. Do not continue unless every row passes.

Run `60_benchmark_readonly.sql` in a fresh SQL Editor session after the
preflight succeeds. It creates only a session-local `pg_temp` result table,
runs one fresh-session and five warm `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`
samples for each of 11 direct SELECT workloads, commits the temporary results,
and finishes with one 66-row SELECT.

Use the SQL Editor result-grid **Export CSV** action on that final SELECT.
Keep the raw CSV outside Git; copy only sanitized aggregates and plan evidence
into `benchmark-results-2026-09-25.md`. The harness does not clear shared
buffers, so the first sample is a cache baseline rather than a controlled
physical-cache cold read.

## Cleanup

Run `cleanup.sql` and delete the disposable project only after an explicit
Owner decision. When authorized, verify that the generated rows are absent;
project deletion remains the final cleanup guarantee.

The historical migration chain creates an empty `gift-media` bucket before the
later Gifts removal migration. The bucket has no objects, callers, tables,
functions, or setting. It is excluded from this database-only fixture because
bucket deletion requires the Storage API. Gifts remain absent from the product
and fixture data.
