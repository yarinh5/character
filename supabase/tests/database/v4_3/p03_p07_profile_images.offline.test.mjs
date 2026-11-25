import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (name) =>
  readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8");

const levels = read("20261111100000_p03_completed_message_levels.sql");
const leads = read("20261111101000_p07_lead_lifecycle.sql");
const images = read("20261111102000_profile_image_management.sql");
const clientArchiveSql = readFileSync(
  new URL("./client_pii_archive.test.sql", import.meta.url),
  "utf8",
);
const clientArchiveHttp = readFileSync(
  new URL("../../http/client_pii_archive.integration.test.ts", import.meta.url),
  "utf8",
);

const archiveClientId = "00000000-0000-4000-8000-000000040102";
const archiveImagePath = `${archiveClientId}/v4-3-d1-profile.webp`;
const archiveImageUrl =
  `https://project.invalid/storage/v1/object/public/user-avatars/${archiveImagePath}`;

test("P03 counts a canonical Gift completion without counting started/open replays", () => {
  assert.match(levels, /OLD\.status\s+NOT\s+IN\s*\('purchased',\s*'opened'\)/u);
  assert.match(levels, /NEW\.status\s*=\s*'purchased'/u);
  assert.match(levels, /NEW\.gift_message_id\s+IS\s+NOT\s+NULL/u);
  assert.doesNotMatch(levels, /UPDATE\s+public\.client_level_progress/u);
  assert.doesNotMatch(levels, /credit_wallet|operator_points/u);
});

test("P07 records renewed interest without resetting a closed Lead", () => {
  const conflict = leads.match(/ON CONFLICT[\s\S]+?ELSIF/u)?.[0] ?? "";
  assert.match(conflict, /interest_active\s*=\s*TRUE/u);
  assert.match(conflict, /last_liked_at\s*=\s*GREATEST/u);
  assert.doesNotMatch(conflict, /status\s*=\s*'new'/u);
  assert.doesNotMatch(conflict, /closed_at\s*=\s*NULL/u);
  assert.match(leads, /closed_at\s*=\s*COALESCE\(lead\.closed_at,\s*_now\)/u);
});

test("profile images are atomically bounded and newly added files are server validated", () => {
  assert.match(images, /cardinality\(NEW\.profile_image_urls\)\s*>\s*6/u);
  assert.match(images, /cardinality\(_old_urls\)\s*>\s*6/u);
  assert.match(images, /legacy_profile_image_limit_exceeded/u);
  assert.match(images, /FROM\s+storage\.objects/u);
  assert.match(images, /object\.owner_id\s*=\s*NEW\.user_id::TEXT/u);
  assert.match(images, /_owner_id\s+IS\s+DISTINCT\s+FROM\s+NEW\.user_id::TEXT/u);
  assert.match(images, /'image\/jpeg',\s*'image\/png',\s*'image\/webp'/u);
  assert.match(images, /_size\s*>\s*5242880/u);
  assert.match(images, /FOR UPDATE/u);
  assert.match(images, /public\.update_client_profile_images/u);
  assert.match(images, /DEFERRABLE INITIALLY DEFERRED/u);
});

test("removed profile images are retained for trusted reference-checked cleanup", () => {
  assert.match(images, /private\.client_profile_image_cleanup_queue/u);
  assert.match(images, /pending_reference_check/u);
  assert.match(images, /profile_image_object_path\(_removed_url,\s*NEW\.user_id\)/u);
  assert.match(images, /object\.owner_id\s*=\s*NEW\.user_id::TEXT/u);
  assert.doesNotMatch(images, /DELETE\s+FROM\s+storage\.objects/u);
});

test("client archive SQL fixture creates its owned canonical avatar before profile update", () => {
  assert.doesNotMatch(clientArchiveSql, /example\.invalid\/v4-3-d1-profile\.png/u);

  const storageInsert = clientArchiveSql.indexOf("INSERT INTO storage.objects");
  const profileUpdate = clientArchiveSql.indexOf("UPDATE public.client_profiles");
  assert.notEqual(storageInsert, -1, "fixture must create the Storage metadata row");
  assert.notEqual(profileUpdate, -1, "fixture must update the client profile");
  assert.ok(storageInsert < profileUpdate, "Storage metadata must exist before the guarded update");

  assert.match(clientArchiveSql, /'user-avatars'/u);
  assert.match(clientArchiveSql, new RegExp(archiveImagePath.replaceAll(".", "\\."), "u"));
  assert.match(clientArchiveSql, new RegExp(archiveClientId, "u"));
  assert.match(clientArchiveSql, /jsonb_build_object\('mimetype',\s*'image\/webp',\s*'size',\s*1024\)/u);
  assert.equal(
    clientArchiveSql.split(archiveImageUrl).length - 1,
    2,
    "the primary image and ordered image list must use the same canonical URL",
  );
});

test("client archive HTTP fixture uploads an owned avatar before profile upsert and removes it", () => {
  assert.doesNotMatch(clientArchiveHttp, /example\.invalid\/v4-3-d1-profile\.png/u);

  const clientSignIn = clientArchiveHttp.indexOf(
    "clientSession = await signInSyntheticUser(emails.client, clientUser.password)",
  );
  const avatarUpload = clientArchiveHttp.indexOf(
    ".storage.from(profileImageBucket).upload",
  );
  const profileUpsert = clientArchiveHttp.search(
    /await upsertRow\(\s*admin,\s*"client_profiles"/u,
  );
  assert.notEqual(clientSignIn, -1, "client session must be established");
  assert.notEqual(avatarUpload, -1, "fixture must upload the avatar through Storage");
  assert.notEqual(profileUpsert, -1, "fixture must upsert the profile");
  assert.ok(clientSignIn < avatarUpload, "the owner must sign in before uploading");
  assert.ok(avatarUpload < profileUpsert, "the Storage object must exist before profile upsert");

  assert.match(
    clientArchiveHttp,
    /`\$\{clientUser\.user\.id\}\/v4-3-d1-profile\.webp`/u,
  );
  assert.match(clientArchiveHttp, /contentType:\s*"image\/webp"/u);
  assert.match(clientArchiveHttp, /upsert:\s*false/u);
  assert.match(clientArchiveHttp, /getPublicUrl\(objectPath\)/u);
  assert.match(clientArchiveHttp, /profile_image_url:\s*profileImageUrl/u);
  assert.match(clientArchiveHttp, /profile_image_urls:\s*\[profileImageUrl\]/u);
  assert.match(
    clientArchiveHttp,
    /\.storage\s*\.from\(profileImageBucket\)\s*\.remove\(\[profileImagePath\]\)/u,
  );
});
