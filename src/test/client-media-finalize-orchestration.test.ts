import { describe, expect, it, vi } from "vitest";
import {
  ClientMediaFinalizeError,
  runClientMediaFinalize,
  type ClientMediaFinalizeClaim,
  type ClientMediaFinalizeIo,
} from "../../supabase/functions/client-media-finalize/orchestration";

const actorUserId = "00000000-0000-4000-8000-000000000001";
const uploadId = "00000000-0000-4000-8000-000000000002";
const sourcePath = `clients/${actorUserId}/conversations/00000000-0000-4000-8000-000000000003/uploads/${uploadId}/source.png`;
const previewPath = sourcePath.replace(/\/source\.[^/]+$/, "/preview.webp");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function processingClaim(): ClientMediaFinalizeClaim {
  return {
    upload_id: uploadId,
    bucket_id: "client-media",
    source_path: sourcePath,
    preview_path: previewPath,
    content_type: "image/png",
    status: "processing",
    claim_token: "00000000-0000-4000-8000-000000000004",
  };
}

function createIo(overrides: Partial<ClientMediaFinalizeIo> = {}) {
  const order: string[] = [];
  const io: ClientMediaFinalizeIo = {
    claim: vi.fn(async () => {
      order.push("claim");
      return processingClaim();
    }),
    renew: vi.fn(async () => {
      order.push("renew");
      return true;
    }),
    download: vi.fn(async () => {
      order.push("download");
      return new Uint8Array([1, 2, 3]);
    }),
    validate: vi.fn(async (bytes) => {
      order.push("validate");
      return { bytes, contentType: "image/webp" };
    }),
    upload: vi.fn(async () => {
      order.push("upload");
    }),
    remove: vi.fn(async (_bucket, paths) => {
      order.push(paths.includes(sourcePath) ? "remove-source" : "remove-preview");
    }),
    finalize: vi.fn(async () => {
      order.push("finalize");
      return { already_finalized: false, message: { id: "message" } };
    }),
    fail: vi.fn(async () => {
      order.push("fail");
    }),
    markArtifactForCleanup: vi.fn(async () => {
      order.push("mark-cleanup");
    }),
    ...overrides,
  };
  return { io, order };
}

describe("client media finalize orchestration", () => {
  it("claims and renews before writing, then finalizes before removing the source", async () => {
    const { io, order } = createIo();

    await expect(
      runClientMediaFinalize({ actorUserId, uploadId, idempotencyKey: "attempt-1" }, io),
    ).resolves.toMatchObject({ already_finalized: false });

    expect(order).toEqual([
      "claim",
      "download",
      "validate",
      "renew",
      "upload",
      "finalize",
      "remove-source",
    ]);
  });

  it("releases a failed validation claim without writing or finalizing", async () => {
    const { io } = createIo({
      validate: vi.fn(async () => {
        throw new ClientMediaFinalizeError(422, "client_media_validation_failed");
      }),
    });

    await expect(
      runClientMediaFinalize({ actorUserId, uploadId, idempotencyKey: "attempt-invalid" }, io),
    ).rejects.toMatchObject({ status: 422, code: "client_media_validation_failed" });
    expect(io.fail).toHaveBeenCalledWith(
      uploadId,
      processingClaim().claim_token,
      "client_media_validation_failed",
    );
    expect(io.upload).not.toHaveBeenCalled();
    expect(io.finalize).not.toHaveBeenCalled();
  });

  it("replays a finalized response without touching Storage", async () => {
    const { io } = createIo({
      claim: vi.fn(async () => ({
        ...processingClaim(),
        status: "cleanup_pending",
        claim_token: null,
      })),
      finalize: vi.fn(async (input) => ({
        already_finalized: true,
        idempotency_key: input.idempotencyKey,
      })),
    });

    await expect(
      runClientMediaFinalize({ actorUserId, uploadId, idempotencyKey: "attempt-replay" }, io),
    ).resolves.toEqual({ already_finalized: true, idempotency_key: "attempt-replay" });
    expect(io.download).not.toHaveBeenCalled();
    expect(io.upload).not.toHaveBeenCalled();
    expect(io.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: null, idempotencyKey: "attempt-replay" }),
    );
  });

  it("durably requeues a preview written after cleanup won the lease race", async () => {
    const uploadEntered = deferred();
    const allowLateWrite = deferred();
    let previewExists = false;
    let rowState = "processing";
    const { io, order } = createIo({
      upload: vi.fn(async () => {
        order.push("upload-start");
        uploadEntered.resolve();
        await allowLateWrite.promise;
        previewExists = true;
        order.push("upload-finished");
      }),
      finalize: vi.fn(async () => {
        order.push("finalize-rejected");
        throw new Error("client_media_upload_expired_or_changed");
      }),
      fail: vi.fn(async () => {
        order.push("fail-fenced");
        throw new Error("client_media_finalize_claim_not_found");
      }),
      remove: vi.fn(async (_bucket, paths) => {
        if (paths.includes(previewPath)) previewExists = false;
        order.push("remove-preview");
      }),
    });

    const result = runClientMediaFinalize(
      { actorUserId, uploadId, idempotencyKey: "attempt-race" },
      io,
    );
    await uploadEntered.promise;
    rowState = "deleted";
    previewExists = false;
    allowLateWrite.resolve();

    await expect(result).rejects.toBeInstanceOf(ClientMediaFinalizeError);
    expect(rowState).toBe("deleted");
    expect(previewExists).toBe(true);
    expect(order).toEqual([
      "claim",
      "download",
      "validate",
      "renew",
      "upload-start",
      "upload-finished",
      "finalize-rejected",
      "fail-fenced",
      "finalize-rejected",
      "mark-cleanup",
    ]);
    expect(io.remove).not.toHaveBeenCalledWith("client-media", [previewPath]);
  });

  it("reconciles a committed finalize whose first response was lost", async () => {
    let committed = false;
    const { io } = createIo({
      finalize: vi.fn(async (input) => {
        if (input.claimToken) {
          committed = true;
          throw new Error("transport_response_lost");
        }
        if (committed) return { already_finalized: true, message: { id: "message" } };
        throw new Error("not_finalized");
      }),
      fail: vi.fn(async () => {
        throw new Error("client_media_finalize_claim_not_found");
      }),
    });

    await expect(
      runClientMediaFinalize({ actorUserId, uploadId, idempotencyKey: "attempt-lost" }, io),
    ).resolves.toMatchObject({ already_finalized: true });
    expect(io.upload).toHaveBeenCalledTimes(1);
    expect(io.remove).not.toHaveBeenCalled();
    expect(io.markArtifactForCleanup).not.toHaveBeenCalled();
  });

  it("preserves an ambiguous committed preview until the same key can recover it", async () => {
    let committed = false;
    let retrying = false;
    const { io } = createIo({
      claim: vi.fn(async () =>
        retrying
          ? { ...processingClaim(), status: "cleanup_pending", claim_token: null }
          : processingClaim(),
      ),
      finalize: vi.fn(async (input) => {
        if (retrying) {
          return {
            already_finalized: true,
            idempotency_key: input.idempotencyKey,
            message: { id: "message" },
          };
        }
        if (input.claimToken) {
          committed = true;
          throw new Error("transport_response_lost");
        }
        throw new Error("reconciliation_transport_failed");
      }),
      fail: vi.fn(async () => {
        throw new Error("fail_transport_failed");
      }),
    });

    await expect(
      runClientMediaFinalize({ actorUserId, uploadId, idempotencyKey: "attempt-ambiguous" }, io),
    ).rejects.toMatchObject({ code: "client_media_finalize_failed" });
    expect(committed).toBe(true);
    expect(io.remove).not.toHaveBeenCalledWith("client-media", [previewPath]);

    retrying = true;
    await expect(
      runClientMediaFinalize({ actorUserId, uploadId, idempotencyKey: "attempt-ambiguous" }, io),
    ).resolves.toMatchObject({
      already_finalized: true,
      idempotency_key: "attempt-ambiguous",
    });
    expect(io.upload).toHaveBeenCalledTimes(1);
  });

  it("durably records an upload that wrote before returning an ambiguous failure", async () => {
    let previewExists = false;
    let recoveryPending = false;
    const { io } = createIo({
      upload: vi.fn(async () => {
        previewExists = true;
        throw new Error("storage_response_lost");
      }),
      fail: vi.fn(async () => {
        throw new Error("client_media_finalize_claim_not_found");
      }),
      finalize: vi.fn(async () => {
        throw new Error("client_media_upload_expired_or_changed");
      }),
      markArtifactForCleanup: vi.fn(async () => {
        recoveryPending = true;
      }),
    });

    await expect(
      runClientMediaFinalize({ actorUserId, uploadId, idempotencyKey: "attempt-upload-lost" }, io),
    ).rejects.toMatchObject({ code: "client_media_finalize_failed", certainty: "ambiguous" });
    expect(previewExists).toBe(true);
    expect(recoveryPending).toBe(true);
    expect(io.remove).not.toHaveBeenCalledWith("client-media", [previewPath]);
  });

  it("does not let a stale worker remove a preview owned by a newer attempt", async () => {
    const { io } = createIo({
      finalize: vi.fn(async () => {
        throw new Error("client_media_upload_expired_or_changed");
      }),
      fail: vi.fn(async () => {
        throw new Error("client_media_finalize_claim_not_found");
      }),
      markArtifactForCleanup: vi.fn(async () => {
        throw new Error("client_media_finalize_claim_not_found");
      }),
    });

    await expect(
      runClientMediaFinalize({ actorUserId, uploadId, idempotencyKey: "attempt-stale-owner" }, io),
    ).rejects.toMatchObject({ code: "client_media_finalize_failed" });
    expect(io.remove).not.toHaveBeenCalledWith("client-media", [previewPath]);
  });

  it("reports recovery failure without replacing the primary finalize failure", async () => {
    const { io } = createIo({
      finalize: vi.fn(async () => {
        throw new Error("primary_finalize_failure");
      }),
      fail: vi.fn(async () => {
        throw new Error("client_media_finalize_claim_not_found");
      }),
      markArtifactForCleanup: vi.fn(async () => {
        throw new Error("cleanup_persistence_failed");
      }),
    });

    await expect(
      runClientMediaFinalize({ actorUserId, uploadId, idempotencyKey: "attempt-recovery-gap" }, io),
    ).rejects.toMatchObject({
      code: "client_media_finalize_failed",
      recoveryFailure: "client_media_finalize_recovery_failed",
    });
  });

  it("durably requeues a stale worker artifact without unsafe Storage removal", async () => {
    const { io } = createIo({
      finalize: vi.fn(async () => {
        throw new Error("client_media_upload_expired_or_changed");
      }),
      fail: vi.fn(async () => {
        throw new Error("client_media_finalize_claim_not_found");
      }),
    });

    await expect(
      runClientMediaFinalize({ actorUserId, uploadId, idempotencyKey: "attempt-stale" }, io),
    ).rejects.toMatchObject({ code: "client_media_finalize_failed" });
    expect(io.markArtifactForCleanup).toHaveBeenCalledWith(
      uploadId,
      processingClaim().claim_token,
      "late_finalize_artifact_outcome_ambiguous",
    );
    expect(io.remove).not.toHaveBeenCalledWith("client-media", [previewPath]);
  });
});
