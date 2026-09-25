# V3-2 Benchmark Results

Run ID: `load_v3_2_20260731_pilot_01`
Project: `character-load-v3-2` (`micmgokyckvfpewxgrzf`)
Fixture tier: `pilot`
Source: local 66-row benchmark CSV, intentionally excluded from Git.

## Baseline Outcome

- Preflight: **30/30 PASS**.
- Benchmark output: **66/66 rows**: 11 query paths, one fresh-session sample
  and five warm samples per path.
- Every documented timing was verified against the exported CSV.
- All plan nodes reported `Temp Read Blocks = 0` and
  `Temp Written Blocks = 0`; no disk spill was observed.
- Decision: **No performance migration required** for the pilot baseline.

The first sample is a fresh-session baseline only. It is not a guaranteed
physical-cache cold read because this harness never clears PostgreSQL shared
buffers. Use the warm distribution for the comparable pilot baseline.

## Timings

| Query path | Cold execution ms | Warm min / median / max ms | Rows | Top node | Finding | Recommendation |
|---|---:|---:|---:|---|---|---|
| NEW queue (`new_queue`) | 12.372 | 0.713 / **0.759** / 0.826 | 40 | Sort | Stable warm plan | No action |
| Operator SLA summary (`operator_sla_summary`) | 0.961 | 0.769 / **0.787** / 0.867 | 1 | Aggregate | Stable warm plan | No action |
| Admin SLA summary (`admin_sla_summary`) | 375.550 | 2.636 / **2.756** / 3.071 | 100 | Sort | Cold-cache outlier only | Observe |
| Chat pagination (`chat_pagination`) | 1.922 | 0.027 / **0.027** / 0.033 | 20 | Limit | Expected index-backed pagination | No action |
| Attachment hydration (`attachment_hydration`) | 2.972 | 0.026 / **0.027** / 0.034 | 1 | Nested Loop | Expected targeted lookup | No action |
| ONLINE candidates (`online_candidates`) | 99.961 | 2.625 / **2.749** / 2.891 | 50 | Limit | Cold-cache outlier only | Observe |
| Discovery filters (`discovery_filters`) | 8.004 | 0.168 / **0.177** / 0.194 | 2 | Limit | Stable selective filter | No action |
| Operator media catalog (`operator_media_catalog`) | 5.100 | 0.069 / **0.070** / 0.076 | 10 | Sort | Small in-memory ordering | No action |
| Notifications unread (`notifications_unread`) | 9.049 | 0.032 / **0.033** / 0.044 | 17 | Limit | Expected index-backed lookup | No action |
| Wallet balance (`wallet_balance`) | 3.762 | 0.014 / **0.015** / 0.017 | 1 | Index Scan | Primary-key lookup | No action |
| Ledger history (`ledger_history`) | 41.794 | 0.058 / **0.062** / 0.111 | 50 | Limit | Expected index-backed history | No action |

## Plan Evidence

The exported plans showed the expected access paths:

- Chat pagination: `idx_messages_conversation_created_desc`.
- Attachment hydration: `message_attachments_message_position_idx`.
- Ledger history: `idx_credit_transactions_user_created`.
- Notifications unread: `idx_notifications_user`.
- Wallet balance: `credit_wallets_pkey`.
- Operator media catalog:
  `character_media_assets_media_tag_catalog_idx` and
  `character_media_assets_ready_idx`.
- NEW, SLA, and ONLINE: primary/secondary indexes across conversations,
  messages, profiles, character assignments, and operator-client blocks.

The plans also contained small sequential scans for work items and handling
cycles. At the pilot cardinality they are not a performance finding; revisit
them only with a larger representative tier or a demonstrated latency issue.

## Coverage Gaps

- This is a deterministic pilot dataset, not a production-load simulation.
- The harness measures query plans only; it does not measure concurrent claims,
  lock contention, Realtime fan-out, or cache invalidation.
- The cold sample is not a controlled physical-cache measurement.
- Discovery distance/coordinates and full city-distribution behavior are not
  representative in this fixture.
- Storage and signed-media delivery are deliberately out of scope because the
  fixture creates zero Storage objects.
- Financial product sends are deliberately out of scope; the fixture contains
  ledger rows but invokes no financial RPC.

## Decision

No material warm-query bottleneck or temporary-file spill was found at the
pilot tier. Do not add an index, change RLS, or change query contracts from
this result alone. Re-run this harness in a larger disposable tier before any
performance migration is proposed.
