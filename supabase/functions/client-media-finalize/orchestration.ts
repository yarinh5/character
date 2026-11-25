export type ClientMediaFinalizeClaim = {
  upload_id: string;
  bucket_id: string;
  source_path: string;
  preview_path: string | null;
  content_type: string;
  status: string;
  claim_token: string | null;
};

export type SanitizedClientMedia = {
  bytes: Uint8Array;
  contentType: string;
};

export type ClientMediaOutcomeCertainty = "authoritative" | "ambiguous";

export class ClientMediaOperationError extends Error {
  constructor(
    readonly operation: "claim" | "renew" | "download" | "upload" | "finalize" | "fail" | "cleanup",
    readonly certainty: ClientMediaOutcomeCertainty,
    readonly operationCode: string,
  ) {
    super(operationCode);
    this.name = "ClientMediaOperationError";
  }
}

export type ClientMediaFinalizeIo = {
  claim(actorUserId: string, uploadId: string): Promise<ClientMediaFinalizeClaim>;
  renew(uploadId: string, claimToken: string): Promise<boolean>;
  download(bucketId: string, path: string): Promise<Uint8Array>;
  validate(bytes: Uint8Array, contentType: string): Promise<SanitizedClientMedia>;
  upload(bucketId: string, path: string, media: SanitizedClientMedia): Promise<void>;
  remove(bucketId: string, paths: string[]): Promise<void>;
  finalize(input: {
    actorUserId: string;
    uploadId: string;
    idempotencyKey: string;
    contentType: string;
    byteSize: number;
    claimToken: string | null;
  }): Promise<unknown>;
  fail(uploadId: string, claimToken: string, errorCode: string): Promise<void>;
  markArtifactForCleanup(uploadId: string, claimToken: string, errorCode: string): Promise<void>;
};

export class ClientMediaFinalizeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly certainty: ClientMediaOutcomeCertainty = "authoritative",
    readonly recoveryFailure?: string,
  ) {
    super(code);
    this.name = "ClientMediaFinalizeError";
  }
}

function previewPathFor(claim: ClientMediaFinalizeClaim) {
  return claim.preview_path ?? claim.source_path.replace(/\/source\.[^/]+$/, "/preview.webp");
}

function assertOwnedPaths(
  claim: ClientMediaFinalizeClaim,
  actorUserId: string,
  previewPath: string,
) {
  const expectedSourcePrefix = `clients/${actorUserId}/conversations/`;
  const expectedUploadSegment = `/uploads/${claim.upload_id}/source.`;
  if (
    !claim.source_path.startsWith(expectedSourcePrefix) ||
    !claim.source_path.includes(expectedUploadSegment) ||
    previewPath === claim.source_path ||
    previewPath !== claim.source_path.replace(/\/source\.[^/]+$/, "/preview.webp")
  ) {
    throw new ClientMediaFinalizeError(422, "client_media_validation_failed");
  }
}

function asFinalizeError(error: unknown) {
  if (error instanceof ClientMediaFinalizeError) return error;
  if (error instanceof ClientMediaOperationError) {
    if (error.operationCode.includes("insufficient_credits")) {
      return new ClientMediaFinalizeError(402, "insufficient_credits", error.certainty);
    }
    if (error.operationCode.includes("client_media_processing_failed")) {
      return new ClientMediaFinalizeError(503, "client_media_processing_failed", error.certainty);
    }
    return new ClientMediaFinalizeError(409, "client_media_finalize_failed", error.certainty);
  }
  const message = error instanceof Error ? error.message : "";
  if (message.includes("insufficient_credits")) {
    return new ClientMediaFinalizeError(402, "insufficient_credits");
  }
  return new ClientMediaFinalizeError(409, "client_media_finalize_failed", "ambiguous");
}

function withRecoveryFailure(failure: ClientMediaFinalizeError) {
  return new ClientMediaFinalizeError(
    failure.status,
    failure.code,
    failure.certainty,
    "client_media_finalize_recovery_failed",
  );
}

export async function runClientMediaFinalize(
  input: { actorUserId: string; uploadId: string; idempotencyKey: string },
  io: ClientMediaFinalizeIo,
) {
  const claim = await io.claim(input.actorUserId, input.uploadId);
  if (claim.status !== "processing" || !claim.claim_token) {
    return io.finalize({
      actorUserId: input.actorUserId,
      uploadId: claim.upload_id,
      idempotencyKey: input.idempotencyKey,
      contentType: claim.content_type,
      byteSize: 1,
      claimToken: null,
    });
  }

  const previewPath = previewPathFor(claim);
  assertOwnedPaths(claim, input.actorUserId, previewPath);
  let previewAttempted = false;
  try {
    let sourceBytes: Uint8Array;
    let validationContentType = claim.content_type;
    let removeOriginal = true;
    try {
      sourceBytes = await io.download(claim.bucket_id, claim.source_path);
    } catch {
      try {
        sourceBytes = await io.download(claim.bucket_id, previewPath);
      } catch {
        throw new ClientMediaFinalizeError(422, "client_media_validation_failed");
      }
      validationContentType = "image/webp";
      removeOriginal = false;
    }

    const sanitized = await io.validate(sourceBytes, validationContentType);
    if (!(await io.renew(claim.upload_id, claim.claim_token))) {
      throw new ClientMediaFinalizeError(409, "client_media_finalize_failed");
    }

    previewAttempted = true;
    await io.upload(claim.bucket_id, previewPath, sanitized);
    const result = await io.finalize({
      actorUserId: input.actorUserId,
      uploadId: claim.upload_id,
      idempotencyKey: input.idempotencyKey,
      contentType: claim.content_type,
      byteSize: sanitized.bytes.length,
      claimToken: claim.claim_token,
    });

    if (removeOriginal) {
      try {
        await io.remove(claim.bucket_id, [claim.source_path]);
      } catch {
        // The finalized row already schedules both paths for durable cleanup.
      }
    }
    return result;
  } catch (error) {
    const failure = asFinalizeError(error);
    let claimReleased = false;
    try {
      await io.fail(claim.upload_id, claim.claim_token, failure.code);
      claimReleased = true;
    } catch {
      // A commit with a lost response or a newer cleanup claim can own the row.
    }

    if (previewAttempted && !claimReleased) {
      try {
        return await io.finalize({
          actorUserId: input.actorUserId,
          uploadId: claim.upload_id,
          idempotencyKey: input.idempotencyKey,
          contentType: claim.content_type,
          byteSize: 1,
          claimToken: null,
        });
      } catch {
        // A failed read-back is not proof that finalize did not commit.
      }
      try {
        await io.markArtifactForCleanup(
          claim.upload_id,
          claim.claim_token,
          "late_finalize_artifact_outcome_ambiguous",
        );
      } catch {
        throw withRecoveryFailure(failure);
      }
    }
    throw failure;
  }
}
