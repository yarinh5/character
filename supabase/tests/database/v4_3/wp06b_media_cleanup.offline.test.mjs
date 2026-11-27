import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../../migrations/20261111123000_wp06b_media_cleanup.sql",
  import.meta.url,
);
const workerUrl = new URL("../../../functions/cleanup-client-media/index.ts", import.meta.url);
const orchestrationUrl = new URL(
  "../../../functions/cleanup-client-media/orchestration.ts",
  import.meta.url,
);

const migration = await readFile(migrationUrl, "utf8");
const worker = await readFile(workerUrl, "utf8");
const orchestration = await readFile(orchestrationUrl, "utf8");

const avatarGuardMatch = migration.match(
  /CREATE OR REPLACE FUNCTION private\.guard_profile_avatar_cleanup_reference\(\)([\s\S]*?)\n\$\$;/,
);
assert.ok(avatarGuardMatch, "the canonical avatar cleanup guard must exist");
const avatarGuard = avatarGuardMatch[1];

test("profile cleanup is fenced, reference-aware and service-role only", () => {
  for (const functionName of [
    "claim_client_profile_image_cleanup_for_server",
    "authorize_client_profile_image_cleanup_for_server",
    "complete_client_profile_image_cleanup_for_server",
    "fail_client_profile_image_cleanup_for_server",
  ]) {
    assert.match(migration, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${functionName}`));
    assert.match(
      migration,
      new RegExp(
        `REVOKE ALL ON FUNCTION public\\.${functionName}[\\s\\S]*?FROM PUBLIC, anon, authenticated`,
      ),
    );
  }
  assert.match(migration, /status = 'claimed'[\s\S]*claim_token = _claim_token/);
  assert.match(migration, /profile_image_cleanup_in_progress/);
  assert.match(migration, /private\.client_profile_image_is_referenced/);
  assert.match(migration, /storage_identity_changed/);
});

test("the avatar reference guard has unambiguous INSERT and UPDATE branches", () => {
  assert.doesNotMatch(avatarGuard, /IS NOT DISTINCT FROM\s+CASE\b/);
  assert.match(
    avatarGuard,
    /IF TG_OP = 'UPDATE' AND NEW\.avatar_url IS NOT DISTINCT FROM OLD\.avatar_url THEN\s+RETURN NEW;\s+END IF;/,
  );
  assert.match(
    avatarGuard,
    /IF TG_OP = 'INSERT' AND NEW\.avatar_url IS NULL THEN\s+RETURN NEW;\s+END IF;/,
  );
  assert.match(avatarGuard, /pg_advisory_xact_lock/);
  assert.match(avatarGuard, /queue\.owner_user_id = NEW\.user_id/);
  assert.match(avatarGuard, /queue\.bucket_id = 'user-avatars'/);
  assert.match(avatarGuard, /queue\.object_path = _object_path/);
  assert.match(avatarGuard, /queue\.status = 'claimed'/);
  assert.match(avatarGuard, /RAISE EXCEPTION 'profile_image_cleanup_in_progress'/);
  assert.match(avatarGuard, /SET status = 'retained'/);
});

test("client and profile completion require authoritative Storage absence", () => {
  assert.match(migration, /client_media_storage_object_still_present/);
  assert.match(migration, /profile_image_storage_object_still_present/);
  assert.match(orchestration, /await io\.remove\(bucketId, paths\)/);
  assert.match(orchestration, /await io\.objectExists\(bucketId, path\)/);
  assert.ok(
    orchestration.indexOf("await io.objectExists(bucketId, path)") <
      orchestration.indexOf("await io.completeClientMedia"),
  );
  assert.match(worker, /for \(let offset = 0; offset < 1_000; offset \+= 100\)/);
  assert.match(worker, /storage_verification_inconclusive/);
});

test("retry work is bounded and exposes backlog without enabling a scheduler", () => {
  assert.match(migration, /attempts BETWEEN 0 AND 8/);
  assert.match(migration, /cleanup_attempts < 8/);
  assert.match(migration, /get_media_cleanup_backlog_for_server/);
  assert.doesNotMatch(migration, /cron\.schedule|net\.http_post|CREATE EXTENSION[^;]*pg_cron/i);
  assert.match(worker, /CLIENT_MEDIA_CLEANUP_ENABLED/);
  assert.match(worker, /cleanup_disabled/);
});

test("the worker uses recorded paths and never derives deletion targets from URLs", () => {
  assert.match(orchestration, /claim\.source_path/);
  assert.match(orchestration, /claim\.preview_path/);
  assert.match(orchestration, /claim\.object_path/);
  assert.doesNotMatch(orchestration, /new URL|source_url|publicUrl|signedUrl/i);
  assert.doesNotMatch(worker, /console\.(?:log|error)\([^)]*(?:path|claim|url)/i);
});
