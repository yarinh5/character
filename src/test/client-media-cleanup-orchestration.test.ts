import { describe, expect, it, vi } from "vitest";

import {
  runClientMediaCleanup,
  type ClientMediaCleanupIo,
} from "../../supabase/functions/cleanup-client-media/orchestration.ts";

const clientClaim = {
  upload_id: "00000000-0000-4000-8000-000000000601",
  bucket_id: "client-media",
  source_path:
    "clients/00000000-0000-4000-8000-000000000001/conversations/00000000-0000-4000-8000-000000000301/uploads/00000000-0000-4000-8000-000000000601/source.webp",
  preview_path:
    "clients/00000000-0000-4000-8000-000000000001/conversations/00000000-0000-4000-8000-000000000301/uploads/00000000-0000-4000-8000-000000000601/preview.webp",
  claim_token: "00000000-0000-4000-8000-000000000701",
};

const profileClaim = {
  queue_id: "00000000-0000-4000-8000-000000000801",
  owner_user_id: "00000000-0000-4000-8000-000000000001",
  bucket_id: "user-avatars",
  object_path: "00000000-0000-4000-8000-000000000001/profile.webp",
  claim_token: "00000000-0000-4000-8000-000000000901",
};

function cleanupIo(overrides: Partial<ClientMediaCleanupIo> = {}): ClientMediaCleanupIo {
  return {
    claimClientMedia: vi.fn(async () => []),
    claimProfileImages: vi.fn(async () => []),
    authorizeProfileImageRemoval: vi.fn(async () => "delete" as const),
    remove: vi.fn(async () => undefined),
    objectExists: vi.fn(async () => false),
    completeClientMedia: vi.fn(async () => undefined),
    failClientMedia: vi.fn(async () => undefined),
    completeProfileImage: vi.fn(async () => "deleted" as const),
    failProfileImage: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("client media cleanup orchestration", () => {
  it("deletes every recorded client-media path and verifies absence before completion", async () => {
    const io = cleanupIo({ claimClientMedia: vi.fn(async () => [clientClaim]) });

    const result = await runClientMediaCleanup(io, 25);

    expect(io.remove).toHaveBeenCalledWith("client-media", [
      clientClaim.source_path,
      clientClaim.preview_path,
    ]);
    expect(io.objectExists).toHaveBeenCalledTimes(2);
    expect(io.completeClientMedia).toHaveBeenCalledWith(
      clientClaim.upload_id,
      clientClaim.claim_token,
    );
    expect(result).toMatchObject({ claimed: 1, deleted: 1, failed: 0 });
  });

  it("keeps partial Storage deletion retryable and never records false completion", async () => {
    const io = cleanupIo({
      claimClientMedia: vi.fn(async () => [clientClaim]),
      objectExists: vi.fn(async (_bucket, path) => path === clientClaim.preview_path),
    });

    const result = await runClientMediaCleanup(io, 25);

    expect(io.completeClientMedia).not.toHaveBeenCalled();
    expect(io.failClientMedia).toHaveBeenCalledWith(
      clientClaim.upload_id,
      clientClaim.claim_token,
      "storage_object_still_present",
    );
    expect(result).toMatchObject({ deleted: 0, failed: 1 });
  });

  it("treats an already absent object as an idempotent successful deletion", async () => {
    const io = cleanupIo({ claimClientMedia: vi.fn(async () => [clientClaim]) });

    await runClientMediaCleanup(io, 25);

    expect(io.remove).toHaveBeenCalledOnce();
    expect(io.completeClientMedia).toHaveBeenCalledOnce();
  });

  it("does not remove a profile image retained by the authoritative reference check", async () => {
    const io = cleanupIo({
      claimProfileImages: vi.fn(async () => [profileClaim]),
      authorizeProfileImageRemoval: vi.fn(async () => "retained" as const),
    });

    const result = await runClientMediaCleanup(io, 25);

    expect(io.remove).not.toHaveBeenCalled();
    expect(io.completeProfileImage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ retained: 1, deleted: 0, failed: 0 });
  });

  it("uses the fenced profile claim and verifies absence before marking it deleted", async () => {
    const io = cleanupIo({ claimProfileImages: vi.fn(async () => [profileClaim]) });

    const result = await runClientMediaCleanup(io, 25);

    expect(io.authorizeProfileImageRemoval).toHaveBeenCalledWith(
      profileClaim.queue_id,
      profileClaim.claim_token,
    );
    expect(io.remove).toHaveBeenCalledWith("user-avatars", [profileClaim.object_path]);
    expect(io.objectExists).toHaveBeenCalledWith("user-avatars", profileClaim.object_path);
    expect(io.completeProfileImage).toHaveBeenCalledWith(
      profileClaim.queue_id,
      profileClaim.claim_token,
    );
    expect(result).toMatchObject({ claimed: 1, deleted: 1, failed: 0 });
  });

  it("preserves the primary failure if recording the retry also fails", async () => {
    const io = cleanupIo({
      claimClientMedia: vi.fn(async () => [clientClaim]),
      remove: vi.fn(async () => {
        throw new Error("ambiguous transport");
      }),
      failClientMedia: vi.fn(async () => {
        throw new Error("persistence unavailable");
      }),
    });

    const result = await runClientMediaCleanup(io, 25);

    expect(result).toMatchObject({ failed: 1, recoveryFailed: 1 });
    expect(io.completeClientMedia).not.toHaveBeenCalled();
  });

  it("rejects unowned paths before invoking Storage", async () => {
    const io = cleanupIo({
      claimProfileImages: vi.fn(async () => [
        { ...profileClaim, object_path: "another-user/profile.webp" },
      ]),
    });

    const result = await runClientMediaCleanup(io, 25);

    expect(io.remove).not.toHaveBeenCalled();
    expect(io.failProfileImage).toHaveBeenCalledWith(
      profileClaim.queue_id,
      profileClaim.claim_token,
      "cleanup_claim_invalid",
    );
    expect(result.failed).toBe(1);
  });
});
