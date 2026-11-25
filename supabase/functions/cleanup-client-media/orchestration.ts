export type ClientMediaCleanupClaim = {
  upload_id: string;
  bucket_id: string;
  source_path: string;
  preview_path: string | null;
  claim_token: string;
};

export type ProfileImageCleanupClaim = {
  queue_id: string;
  owner_user_id: string;
  bucket_id: string;
  object_path: string;
  claim_token: string;
};

export type ProfileRemovalDecision = "delete" | "retained" | "blocked";
export type ProfileCleanupCompletion = "deleted" | "retained" | "blocked";

export type ClientMediaCleanupIo = {
  claimClientMedia(limit: number): Promise<ClientMediaCleanupClaim[]>;
  claimProfileImages(limit: number): Promise<ProfileImageCleanupClaim[]>;
  authorizeProfileImageRemoval(
    queueId: string,
    claimToken: string,
  ): Promise<ProfileRemovalDecision>;
  remove(bucketId: string, paths: string[]): Promise<void>;
  objectExists(bucketId: string, path: string): Promise<boolean>;
  completeClientMedia(uploadId: string, claimToken: string): Promise<void>;
  failClientMedia(uploadId: string, claimToken: string, errorCode: string): Promise<void>;
  completeProfileImage(queueId: string, claimToken: string): Promise<ProfileCleanupCompletion>;
  failProfileImage(queueId: string, claimToken: string, errorCode: string): Promise<void>;
};

export type ClientMediaCleanupSummary = {
  claimed: number;
  deleted: number;
  retained: number;
  blocked: number;
  failed: number;
  recoveryFailed: number;
};

function clientMediaPaths(claim: ClientMediaCleanupClaim) {
  const uploadSegment = `/uploads/${claim.upload_id}/`;
  const sourceValid =
    claim.bucket_id === "client-media" &&
    claim.source_path.startsWith("clients/") &&
    claim.source_path.includes("/conversations/") &&
    claim.source_path.includes(uploadSegment) &&
    /\/source\.(?:jpg|png|webp)$/.test(claim.source_path);
  const expectedPreview = claim.source_path.replace(/\/source\.[^/]+$/, "/preview.webp");
  const previewValid = claim.preview_path === null || claim.preview_path === expectedPreview;
  if (!sourceValid || !previewValid) throw new Error("cleanup_claim_invalid");
  return [
    ...new Set([claim.source_path, claim.preview_path].filter((path): path is string => !!path)),
  ];
}

function profileImagePath(claim: ProfileImageCleanupClaim) {
  if (
    claim.bucket_id !== "user-avatars" ||
    !claim.object_path.startsWith(`${claim.owner_user_id}/`) ||
    claim.object_path.includes("\\") ||
    claim.object_path
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("cleanup_claim_invalid");
  }
  return claim.object_path;
}

async function removeAndVerify(io: ClientMediaCleanupIo, bucketId: string, paths: string[]) {
  await io.remove(bucketId, paths);
  for (const path of paths) {
    if (await io.objectExists(bucketId, path)) throw new Error("storage_object_still_present");
  }
}

function cleanupErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message === "cleanup_claim_invalid" || message === "storage_object_still_present") {
    return message;
  }
  return "storage_cleanup_failed";
}

export async function runClientMediaCleanup(
  io: ClientMediaCleanupIo,
  limit = 25,
): Promise<ClientMediaCleanupSummary> {
  const batchLimit = Math.min(Math.max(Math.trunc(limit) || 25, 1), 100);
  const summary: ClientMediaCleanupSummary = {
    claimed: 0,
    deleted: 0,
    retained: 0,
    blocked: 0,
    failed: 0,
    recoveryFailed: 0,
  };

  const clientClaims = await io.claimClientMedia(batchLimit);
  const profileClaims = await io.claimProfileImages(batchLimit);
  summary.claimed = clientClaims.length + profileClaims.length;

  for (const claim of clientClaims) {
    try {
      const paths = clientMediaPaths(claim);
      await removeAndVerify(io, claim.bucket_id, paths);
      await io.completeClientMedia(claim.upload_id, claim.claim_token);
      summary.deleted += 1;
    } catch (error) {
      summary.failed += 1;
      try {
        await io.failClientMedia(claim.upload_id, claim.claim_token, cleanupErrorCode(error));
      } catch {
        summary.recoveryFailed += 1;
      }
    }
  }

  for (const claim of profileClaims) {
    try {
      const path = profileImagePath(claim);
      const decision = await io.authorizeProfileImageRemoval(claim.queue_id, claim.claim_token);
      if (decision === "retained") {
        summary.retained += 1;
        continue;
      }
      if (decision === "blocked") {
        summary.blocked += 1;
        continue;
      }
      await removeAndVerify(io, claim.bucket_id, [path]);
      const completion = await io.completeProfileImage(claim.queue_id, claim.claim_token);
      summary[completion] += 1;
    } catch (error) {
      summary.failed += 1;
      try {
        await io.failProfileImage(claim.queue_id, claim.claim_token, cleanupErrorCode(error));
      } catch {
        summary.recoveryFailed += 1;
      }
    }
  }

  return summary;
}
