import { describe, expect, it, vi } from "vitest";
import {
  confirmAccountDeletion,
  confirmAccountDeletionCancellation,
  requestAccountDeletionVerification,
} from "../../supabase/functions/_shared/deletion-verification-orchestration";
import {
  runDeletionWorkflowStep,
  type DeletionWorkflowIo,
} from "../../supabase/functions/process-deletion-workflows/orchestration";

describe("account deletion verification orchestration", () => {
  it("binds a one-time email proof to the request and verified identity", async () => {
    const prepareVerification = vi.fn().mockResolvedValue(undefined);
    const sendMagicLink = vi.fn().mockResolvedValue(undefined);
    const request = await requestAccountDeletionVerification(
      {
        randomToken: () => "one-time-token",
        sha256: async () => "a".repeat(64),
        requestDeletion: async () => ({
          id: "request-a",
          status: "awaiting_verification",
          requested_at: "now",
        }),
        currentIdentity: async () => ({
          id: "user-a",
          email: "a@example.com",
          emailConfirmed: true,
        }),
        prepareVerification,
        sendMagicLink,
      },
      "idempotency-a",
      "https://app.example/verify-account-deletion",
    );

    expect(request.id).toBe("request-a");
    expect(prepareVerification).toHaveBeenCalledWith(
      "request-a",
      "a".repeat(64),
      expect.any(String),
    );
    expect(sendMagicLink).toHaveBeenCalledWith(
      "a@example.com",
      "https://app.example/verify-account-deletion?request=request-a&token=one-time-token",
    );
  });

  it("records provider-confirmed global revocation before completing the claimed step", async () => {
    const revoke = vi.fn().mockResolvedValue(undefined);
    const complete = vi.fn().mockResolvedValue(undefined);
    await confirmAccountDeletion(
      {
        sha256: async () => "b".repeat(64),
        currentIdentity: async () => ({
          id: "user-a",
          email: "a@example.com",
          emailConfirmed: true,
        }),
        verifyDeletion: vi.fn().mockResolvedValue(undefined),
        claimAccountStep: async () => ({
          request_id: "request-a",
          step_name: "session_revocation",
          attempt_count: 1,
          claim_token: "claim-a",
          lease_expires_at: "later",
        }),
        revokeGlobalSessions: revoke,
        completeAccountStep: complete,
        failAccountStep: vi.fn(),
      },
      "request-a",
      "token",
      "fresh-jwt",
    );

    expect(revoke).toHaveBeenCalledWith("fresh-jwt");
    expect(complete).toHaveBeenCalledWith("request-a", "session_revocation", "claim-a", {
      operation: "supabase_auth_global_signout",
      provider_confirmed: true,
    });
    expect(revoke.mock.invocationCallOrder[0]).toBeLessThan(complete.mock.invocationCallOrder[0]);
  });

  it("fails the same claim without reporting completion when provider revocation fails", async () => {
    const complete = vi.fn();
    const fail = vi.fn().mockResolvedValue(undefined);
    await expect(
      confirmAccountDeletion(
        {
          sha256: async () => "c".repeat(64),
          currentIdentity: async () => ({
            id: "user-a",
            email: "a@example.com",
            emailConfirmed: true,
          }),
          verifyDeletion: vi.fn().mockResolvedValue(undefined),
          claimAccountStep: async () => ({
            request_id: "request-a",
            step_name: "session_revocation",
            attempt_count: 1,
            claim_token: "claim-a",
            lease_expires_at: "later",
          }),
          revokeGlobalSessions: async () => {
            throw new Error("provider unavailable");
          },
          completeAccountStep: complete,
          failAccountStep: fail,
        },
        "request-a",
        "token",
        "fresh-jwt",
      ),
    ).rejects.toThrow("provider unavailable");
    expect(complete).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(
      "request-a",
      "session_revocation",
      "claim-a",
      "auth_session_revocation_failed",
    );
  });

  it("consumes cancellation proof with the freshly authenticated user", async () => {
    const cancelDeletion = vi.fn().mockResolvedValue(undefined);
    await confirmAccountDeletionCancellation(
      {
        sha256: async () => "d".repeat(64),
        currentIdentity: async () => ({
          id: "user-a",
          email: "a@example.com",
          emailConfirmed: true,
        }),
        cancelDeletion,
      },
      "request-a",
      "one-time-token",
    );
    expect(cancelDeletion).toHaveBeenCalledWith("request-a", "user-a", "d".repeat(64));
  });
});

describe("deletion worker orchestration", () => {
  it("completes database work only with evidence returned by the real operation", async () => {
    const io = workflowIo("database_content");
    io.executeDatabase = vi
      .fn()
      .mockResolvedValue({ operation: "database_content_minimized", rows: 3 });
    await expect(runDeletionWorkflowStep(io, "account", "request-a")).resolves.toEqual({
      status: "completed",
      step: "database_content",
    });
    expect(io.complete).toHaveBeenCalledWith(
      "account",
      "request-a",
      "database_content",
      "claim-a",
      { operation: "database_content_minimized", rows: 3 },
    );
  });

  it("does not complete Storage after a partial or ambiguous provider failure", async () => {
    const io = workflowIo("storage");
    io.listStorage = vi
      .fn()
      .mockResolvedValue([{ bucket_id: "client-media", object_path: "owned/a.webp" }]);
    io.removeStorage = vi.fn().mockRejectedValue(new Error("storage unavailable"));
    await expect(runDeletionWorkflowStep(io, "account", "request-a")).rejects.toThrow(
      "storage unavailable",
    );
    expect(io.completeStorageObject).not.toHaveBeenCalled();
    expect(io.complete).not.toHaveBeenCalled();
    expect(io.fail).toHaveBeenCalledWith(
      "account",
      "request-a",
      "storage",
      "claim-a",
      "deletion_step_failed",
    );
  });

  it("requires provider-confirmed Auth deletion before completing the claim", async () => {
    const io = workflowIo("auth_delete");
    io.softDeleteAuthUser = vi.fn().mockRejectedValue(new Error("auth_soft_delete_failed"));
    await expect(runDeletionWorkflowStep(io, "account", "request-a")).rejects.toThrow(
      "auth_soft_delete_failed",
    );
    expect(io.complete).not.toHaveBeenCalled();
    expect(io.fail).toHaveBeenCalledWith(
      "account",
      "request-a",
      "auth_delete",
      "claim-a",
      "auth_soft_delete_failed",
    );
  });

  it("persists partial retention evidence without completing the fenced claim", async () => {
    const io = workflowIo("retention_minimization");
    io.executeRetentionMinimization = vi.fn().mockResolvedValue({
      operation: "retention_minimization_evaluated",
      completion_ready: false,
      minimized: ["admin_audit", "blocks"],
      protected: ["financial_records"],
    });

    await expect(runDeletionWorkflowStep(io, "account", "request-a")).resolves.toEqual({
      status: "blocked",
      step: "retention_minimization",
    });
    expect(io.executeRetentionMinimization).toHaveBeenCalledWith("request-a", "claim-a");
    expect(io.blockRetention).toHaveBeenCalledWith(
      "request-a",
      "claim-a",
      {
        operation: "retention_minimization_evaluated",
        completion_ready: false,
        minimized: ["admin_audit", "blocks"],
        protected: ["financial_records"],
      },
    );
    expect(io.complete).not.toHaveBeenCalled();
  });

  it("completes retention only when every required condition is resolved", async () => {
    const io = workflowIo("retention_minimization");
    io.executeRetentionMinimization = vi.fn().mockResolvedValue({
      operation: "retention_minimization_evaluated",
      completion_ready: true,
    });

    await expect(runDeletionWorkflowStep(io, "account", "request-a")).resolves.toEqual({
      status: "completed",
      step: "retention_minimization",
    });
    expect(io.blockRetention).not.toHaveBeenCalled();
    expect(io.complete).toHaveBeenCalledWith(
      "account",
      "request-a",
      "retention_minimization",
      "claim-a",
      {
        operation: "retention_minimization_evaluated",
        completion_ready: true,
      },
    );
  });

  it("does not complete retention work when the fenced RPC fails", async () => {
    const io = workflowIo("retention_minimization");
    io.executeRetentionMinimization = vi
      .fn()
      .mockRejectedValue(new Error("retention_minimization_failed"));

    await expect(runDeletionWorkflowStep(io, "account", "request-a")).rejects.toThrow(
      "retention_minimization_failed",
    );
    expect(io.complete).not.toHaveBeenCalled();
    expect(io.fail).toHaveBeenCalledWith(
      "account",
      "request-a",
      "retention_minimization",
      "claim-a",
      "retention_minimization_failed",
    );
  });
});

function workflowIo(stepName: string): DeletionWorkflowIo {
  return {
    claim: vi
      .fn()
      .mockResolvedValue({
        request_id: "request-a",
        step_name: stepName,
        attempt_count: 1,
        claim_token: "claim-a",
        lease_expires_at: "later",
      }),
    executeDatabase: vi.fn(),
    listStorage: vi.fn().mockResolvedValue([]),
    removeStorage: vi.fn(),
    storageObjectExists: vi.fn().mockResolvedValue(false),
    completeStorageObject: vi.fn(),
    summarizeStorage: vi
      .fn()
      .mockResolvedValue({ operation: "storage_objects_deleted", deleted_count: 0 }),
    executeRetentionMinimization: vi.fn(),
    blockRetention: vi.fn(),
    getAccountSubject: vi.fn().mockResolvedValue("user-a"),
    softDeleteAuthUser: vi.fn().mockResolvedValue(undefined),
    recordFinalization: vi.fn().mockResolvedValue({ operation: "completion_ledger_recorded" }),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
  };
}
