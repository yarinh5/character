# WP06 — client media upload, access and cleanup

Date: 2026-11-05 (Asia/Jerusalem)

## Offline implementation draft

- The private `client-media` bucket accepts only JPEG, PNG and WebP up to 10 MiB. The client first
  obtains a conversation-bound upload intent; finalize is service-only, validates the actor, type,
  size and deadline, then atomically creates one message/attachment and charges exactly 10 Client
  Credits under an idempotency key.
- Client media uses a durable 24-hour access deadline independent of physical deletion. The resolver
  rejects expired access and caps signed-URL TTL at the smaller remaining window. It never treats a
  successful access expiry as proof that Storage bytes were deleted.
- Cleanup is a durable claim/complete/fail workflow with `SKIP LOCKED`, attempt evidence and bounded
  backoff. The Edge worker deletes source and preview paths and marks completion only after Storage
  confirms the operation; failures remain retryable.
- The existing chat route exposes upload/finalize progress and failure states without changing
  character-media or locked-media rights. Attachment rendering distinguishes available and expired
  client media.

The focused component suite passes. A pgTAP lifecycle suite and live HTTP/Storage cases are prepared
for future authorization but are **NOT RUN**. Device validation, real Storage uploads, signed URL
expiry, physical deletion, retry recovery and browser RTL/mobile remain **NOT VERIFIED**. Therefore
WP06-A/B and AC14–AC16 are not closed.

## Efficiency and responsive UX evidence — 2026-11-05

- Upload intent, byte upload and finalize remain one ordered flow; finalize retry reuses the same
  idempotency key and never re-uploads the source. The upload control has stable dimensions, a local
  pending state and identity-generation guards, while cleanup claims are bounded and use `SKIP
LOCKED` with a due-work index.
- Offline component coverage now also proves that two file-input events before the first intent
  resolves create exactly one upload intent. Existing tests cover ambiguous finalize retry and late
  completion after identity replacement.
- Real upload throughput, Storage latency, derivative layout, cleanup query plans and browser
  responsive/focus behavior remain **NOT VERIFIED**. No runtime service or comparative benchmark was
  used.

## Cleanup retry correction — 2026-11-05

- Cleanup selection now distinguishes an unfinalized abandoned upload from finalized media. A
  failed abandoned upload becomes eligible again only after both its upload deadline and
  `next_cleanup_at`; finalized media continues to require expired access plus the same retry
  schedule.
- Row locking, lease expiry, new claim tokens, stale-worker rejection and the existing backoff are
  unchanged. The pgTAP contract covers no early retry, a fresh token after the due time, stale-token
  rejection, successful completion and the equivalent finalized-media retry boundary.
- The SQL suite is written but **NOT RUN**. No Storage object was deleted and no DB, Edge or
  concurrency behavior was exercised in a live environment.

## WP06-B and profile-image cleanup — implemented Offline 2026-11-11

- The existing `cleanup-client-media` worker now runs a bounded client-media batch and a bounded
  profile-image queue batch. It removes only source/preview/object paths returned by the trusted
  claim RPCs, verifies every path is absent through the Storage API, and then crosses a second DB
  absence check before recording `deleted`. An already absent object is idempotent; partial or
  ambiguous removal remains failed work rather than a false success.
- Existing client-media claims retain their five-minute lease and token fencing. Retries are capped
  at eight claims with bounded backoff. Pending uploads, expired finalize leases, failed derivative
  artifacts and delivered media continue to use their existing upload/access deadlines; no new
  retention interval was introduced.
- `private.client_profile_image_cleanup_queue` now owns the profile cleanup lifecycle. Claim and
  pre-remove authorization prove the `user-avatars` bucket, canonical owner folder, Storage
  `owner_id` and object identity. The update triggers serialize reference restoration with the
  claim; a reference restored before claim is retained, while a reference cannot be re-added during
  an active deletion claim. `client_profiles.profile_image_url`, `profile_image_urls` and
  `profiles.avatar_url` are all checked. Unknown ownership/identity is blocked and retained for
  review, including legacy images; folder-shaped URLs alone never authorize deletion.
- The service-role-only backlog RPC reports due/exhausted/blocked counts and the oldest due time.
  Error codes are bounded and responses contain counts rather than paths, URLs, signed links or
  personal content.
- Deployment remains deliberately disabled: the Edge endpoint requires the existing service-role
  boundary and `CLIENT_MEDIA_CLEANUP_ENABLED=true`. A future scheduler may invoke the deployed
  function only after the migration and live DB/Storage suites pass. No migration creates a cron
  job and opening a product screen is not an execution path.

Offline orchestration tests cover expiration work returned by the DB claim, partial Storage
failure, repeated deletion, active/restored profile references, stale ownership paths and recovery
persistence failure. The pgTAP lifecycle suite is **WRITTEN / NOT RUN**. No migration was applied,
no Storage object was removed and no scheduler was enabled. Physical deletion, Storage list
consistency, DB locking/fencing under real concurrency, backlog lag and operational alerting remain
**NOT VERIFIED LIVE**.
