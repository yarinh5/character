# Legacy Migration History

Last verified: 2026-07-16
Active project: `qmgkmsarzfjnqltljkjl`

## Status

The repository migration filenames and the active project's remote migration
history are legacy-aligned by schema state, not by migration timestamp.
Do not treat `supabase migration list` as a schema-parity check for this
project until a separately approved baseline-reconciliation effort is complete.

At verification time:

- The repository contained 26 migration files.
- The active project contained 29 remote migration-history records.
- One migration matched by both semantic name and timestamp:
  `phase_2f_fk_index_hardening`.
- Twenty-one migrations matched by semantic name but had different timestamps.
- Four local files had no remote record with the same name, including
  `phase_2e_sla_operational_monitoring`.
- Seven remote records had no local file with the same name, including
  notification and analytics hardening records.

The final Phase 2E SLA function and supporting indexes exist in the active
schema through the later SLA repair migrations, despite the missing original
Phase 2E history record.

## Operating Decision

Leave the current migration history and filenames unchanged. Do not run
`supabase migration repair` or rename migration files as part of ordinary
feature work.

`migration repair` changes history metadata only; it cannot prove that a local
SQL file and a remote history record are equivalent. The current mismatches are
not one-to-one, so repairing timestamps would risk recording an inaccurate
execution history. Renaming files would have the same provenance problem and
would disrupt existing branches without reconciling the unmatched records.

## Future Reconciliation Prerequisites

Any future reconciliation must be separately approved and should first:

1. Capture and review a live-schema baseline.
2. Map every unmatched local file and remote record by reviewed SQL effect.
3. Choose one authoritative migration chain for all environments.
4. Perform history repair or filename changes only after that mapping is
   reviewed and backed up.

This document records an operational limitation only. It does not alter schema,
remote migration history, or migration filenames.
