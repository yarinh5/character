# Master Engineering Plan V3

## V3 Kickoff

V3 starts from the V2 closeout at source commit `83d573e99a8cf45c2f9cddc598f6e4cfc65537d3`.
Production deployment remains a product decision and is not implied by this plan.

## Guiding Principles

- Work one phase at a time.
- Every task declares one Loop Type: `Planning`, `Phase`, `QA`, `Regression`, `Release`, or `Deploy`.
- Avoid multi-feature mega prompts; each phase has one bounded outcome and acceptance criteria.
- Phase work stops at a staging preview. Commit requires explicit approval.
- Push and deploy are separate explicit gates after commit and verification.
- Preserve existing contracts unless a product owner explicitly reopens them.

## Candidate V3 Tracks

### 1. Production Readiness And Observability

Scope: environment inventory, deploy checklist, runtime monitoring, alert ownership, rollback rehearsal, and production smoke criteria.

Pros: reduces release risk, makes deferred production deployment a deliberate decision, and validates the V2 operational surface before more features.

Risks: requires accurate environment ownership and access; it should not turn into an unbounded infrastructure rewrite.

### 2. Notifications Scheduler And Alert Operations

Scope: evaluate and, only after approval, add a server-side scheduler for SLA critical notifications; define dedupe, load, alert ownership, and failure handling.

Pros: completes automatic critical SLA escalation without dashboard read side effects.

Risks: scheduled work can create notification noise or load if thresholds and ownership are not defined first.

### 3. Performance And Load Validation

Scope: query plans and load checks for NEW, chat hydration, media picker, analytics, and realtime/cache invalidation; add only evidence-backed indexes or narrow fixes.

Pros: protects the most concurrency-sensitive V2 workflows before wider rollout.

Risks: synthetic tests can be misleading without representative QA data and a defined load target.

### 4. Admin Analytics And Operations Dashboards

Scope: refine operational dashboards around NEW SLA, presence, outreach, moderation, and inventory metrics using the V2 analytics foundation.

Pros: improves daily operational visibility without changing business rules.

Risks: dashboard reads must remain read-only and metrics require clear definitions to avoid conflicting sources of truth.

### 5. Client And Operator UX Polish

Scope: targeted accessibility, mobile/RTL, discovery/profile, and operator workflow improvements with no contract changes.

Pros: improves usability on already-built workflows.

Risks: broad polish can become scope creep; work must remain route- and workflow-specific.

### Future Option: Payments And Top-ups

This is not a V3 default track. Consider it only after explicit product approval, with a separate financial, compliance, and webhook design phase.

## Recommended First Track

Start with **V3-1: Production Readiness And Observability**.

V2 is feature-complete and source-pushed, while production deployment remains deliberately deferred. The highest-value next step is to make the release decision observable, repeatable, and reversible rather than introducing new monetization or product surface area.

## Do Not Touch Without Explicit Approval

- Gifts remain removed; do not reintroduce them.
- Stickers remain the monetized gift-like mechanic.
- Credits, stickers, payouts, client-message credits, and the operator message streak model are closed.
- Paid Images remain per-open sessions, not permanent unlocks.
- NEW and ONLINE responsibility rules remain the current source of truth.
- Media tags and Admin media hard delete remain closed contracts.
- Client archive remains archive plus PII anonymization; do not hard-delete `auth.users`.
- Production deployment remains deferred.

## Proposed V3-1 Plan: Production Readiness And Observability

### Objective

Produce a release-ready operational package without changing product behavior or deploying production.

### Deliverables

1. **Environment matrix**: local, QA/staging, and production ownership; app URL, Supabase project, migration state, and Edge Function versions.
2. **Deploy checklist**: source parity, migration order, approved function deployments, config/flag verification, smoke owners, and go/no-go criteria.
3. **Edge Function inventory**: function name, JWT mode, last approved source commit, environment status, and rollback route.
4. **Feature-flag state**: read-only inventory, expected defaults, owner, and activation prerequisites. Mandatory onboarding remains disabled unless separately approved.
5. **Runtime QA checklist**: isolated Admin, Operator A, Operator B, and Client QA flows covering NEW, ONLINE, media, stickers, paid images, archive, and admin operations.
6. **Monitoring and logging gaps**: identify only actionable gaps for errors, RPC failures, notification/event delivery, financial invariants, and storage deletion failures.
7. **Rollback plan**: source rollback, migration-forward policy, Edge Function rollback, and feature-flag response paths.
8. **Production smoke test**: minimal, pre-approved post-deploy checks with ownership and stop conditions.

### Non-Goals

- No production deployment.
- No new scheduler, new monetization flow, or broad infrastructure rewrite.
- No reopening of closed V2 product contracts.

### Exit Criteria

- Product owner has an explicit go/no-go decision packet for production deployment.
- Every deployment dependency has an owner, environment target, and rollback response.
- Any unresolved runtime QA limitation is classified as environmental, operational, or a concrete product defect.

## Open Decisions For Product Owner

1. Deploy production now, or continue local/QA-only operation?
2. Enable mandatory onboarding, keep it disabled, or plan a controlled rollout?
3. Add pg_cron for SLA-critical alerts after a threshold and ownership review?
4. Prioritize UX polish, observability, or a separately approved monetization initiative after V3-1?

## V3 Closeout

### Completion Status

- Date: 2026-09-28.
- Status: Local/QA complete.
- Production: NO-GO until separately approved.
- No P0/P1 source or QA contract blockers remain.

### Track Summary

| Track | Completion |
| --- | --- |
| V3-1 | Production readiness and security baseline complete. |
| V3-2 | Representative load baseline complete: 30/30 preflight checks, 66/66 benchmark rows, zero spills, and no performance migration required. |
| V3-3 | QA notification scheduler operational with two approved cron jobs, no recent failures, and no semantic duplicates. |
| V3-4 | Canonical Admin operations snapshot and dashboard complete. |
| V3-5 | Operator SLA fail-closed hardening and targeted Client/Operator UX and accessibility polish complete. |

### Closed Product Contracts

V3 did not reopen the following contracts:

- NEW/ONLINE responsibility.
- Credits, payouts, and sticker pricing.
- Paid Image per-open sessions.
- Media tags and Admin media hard delete.
- Client PII archive.
- Gifts remain removed.

### Accepted And Deferred Items

- Global NEW claim disabling is accepted safe behavior; throughput refinement is deferred.
- Admin and Operator visual QA remains manual and non-blocking.
- Full keyboard/focus QA and profile fault injection remain manual.
- True two-session advisory-lock QA is required before any Production scheduler activation.
- Leaked-password protection requires an Auth-owner decision.
- Legacy Gift Edge Function deletion remains permission-blocked.
- External monitoring ownership and backup/restore rehearsal remain open.

### Production Prerequisites

- Explicit Production project and owners.
- Migration, secret, and flag baseline.
- Backup and rollback authority.
- Production smoke-test identities.
- Monitoring and incident route.
- Separate scheduler approval.
- Legal, privacy, and support approval where required.

### Next-Step Rule

- Any Production deployment or new product initiative begins a new, explicitly approved loop.
- Payments and top-ups remain optional and are not implied by V3 completion.
