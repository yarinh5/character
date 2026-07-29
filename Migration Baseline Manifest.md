# Migration Baseline Manifest

## Purpose

This manifest records the evidence-backed relationship between the local migration files and the QA migration history. It is a baseline reference, not a migration-history repair plan.

- QA project: `qmgkmsarzfjnqltljkjl`
- Snapshot source commit: `e4d836a49241d52dbd9b8589fe479e8ea312ca7a`
- QA currently has no known schema gap.

## Baseline Summary

- Local migration files: 102
- QA migration-history entries: 105
- Exact normalized-name matches: 98
- The remaining entries are semantic aliases, one-to-many historical hardening, or superseded migrations.
- No migration-history repair is currently justified.

## Semantic Counterparts

| Local migration or baseline | QA migration history | Scope | Confidence |
| --- | --- | --- | --- |
| `20260512194305_343cc389-05cd-47ac-8a65-f42104c4d6d1.sql` | `20260519160128 initial_lovable_schema` | Core schema, types, and tables | High |
| `20260512194338_c0c5d01b-c5f4-4c94-9a70-1efaae76e426.sql` | `20260519160214 security_function_and_storage_policy_hardening` | Storage and function hardening | High |
| `20260517100932_a845b98e-ab76-45f5-b9f7-db3c7ede27d4.sql` | `20260519160324 invites_audit_logs_notifications` | Invites, audit logs, and notifications | High |
| Initial local baseline pair | `20260519160505 tighten_trigger_functions_and_storage_reads` | One-to-many early-baseline hardening | Medium |
| `phase_2a_notifications_polish` | `20260522124538 tighten_notification_settings_grants` | Grants, RLS, and helpers | High |
| `phase_2d_analytics_events_foundation` | `20260522131607 restrict_public_analytics_event_names` | Analytics allowlist and validation | High |
| `phase_2d_analytics_events_foundation` | `20260522131733 harden_analytics_trigger_functions` | Trigger, search-path, and revoke hardening | High |
| `20260524104315_phase_2e_sla_operational_monitoring.sql` | Later QA migrations `fix_sla_rpc_active_database` and `fix_sla_rpc_ambiguous_columns` | Superseded by forward fixes | High |

The initial local baseline pair is intentionally named descriptively because the corresponding local files use hash-only names. This document does not invent missing hash suffixes.

## Environment Rules

- QA continuing from its current history requires no repair or mutation.
- An existing production environment requires a read-only migration inventory and baseline comparison before deployment.
- A fresh empty production environment requires a rehearsal of all local migrations in a disposable project before approval.
- Local migrations remain the source chain for a fresh environment.
- Remote QA history remains the factual history of QA.

## Prohibited Actions

- Never run migration repair merely to align labels or timestamps.
- Never rename or edit an already-applied migration.
- Never delete historical Gift migrations.
- Never reset a shared environment.
- Use rollback-forward migrations for schema corrections.
- Require a proven deployment blocker and explicit approval before any history repair.

## Current Operational Notes

- The production environment remains undefined and deployment is deferred.
- Legacy Gift Edge Function retirement is operationally blocked by permissions.
- This Gift cleanup does not indicate any Gift schema or product restoration.
- `supabase/.temp/cli-latest` is local metadata and must stay outside commits.
