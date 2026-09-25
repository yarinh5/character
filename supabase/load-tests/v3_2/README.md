# V3-2 Disposable Load Fixture

This fixture is for an isolated, disposable Supabase project only. It must never
be executed against QA or production.

## Approved run

- Project: `character-load-v3-2`
- Project ref: `micmgokyckvfpewxgrzf`
- Run ID: `load_v3_2_20260731_pilot_01`
- Tier: `pilot`
- Cleanup owner: `Yarin`
- Delete no later than: `2026-08-02T12:07:36Z`
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

Run each file through an authorized SQL channel scoped to the disposable
project. Do not use a connection string or key from QA or production.

Every UUID created by the fixture is deterministic and is recorded in
`load_v3_2.fixture_manifest`. Composite keys are recorded in the same table as
JSON. The manifest is the source of truth for targeted cleanup.

## Cleanup

Run `cleanup.sql`, verify that the generated rows are absent, and then delete
the entire disposable project. Project deletion is the final cleanup guarantee.

The historical migration chain creates an empty `gift-media` bucket before the
later Gifts removal migration. The bucket has no objects, callers, tables,
functions, or setting. It is excluded from this database-only fixture because
bucket deletion requires the Storage API. Gifts remain absent from the product
and fixture data.
