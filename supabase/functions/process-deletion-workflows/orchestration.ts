export type DeletionKind = "account" | "conversation";
export type DeletionClaim = {
  request_id: string;
  step_name: string;
  attempt_count: number;
  claim_token: string;
  lease_expires_at: string;
};
export type DeletionStorageObject = { bucket_id: string; object_path: string };

export type DeletionWorkflowIo = {
  claim(kind: DeletionKind, requestId: string): Promise<DeletionClaim | null>;
  executeDatabase(
    kind: DeletionKind,
    requestId: string,
    claimToken: string,
  ): Promise<Record<string, unknown>>;
  listStorage(
    kind: DeletionKind,
    requestId: string,
    claimToken: string,
  ): Promise<DeletionStorageObject[]>;
  removeStorage(bucketId: string, objectPath: string): Promise<void>;
  storageObjectExists(bucketId: string, objectPath: string): Promise<boolean>;
  completeStorageObject(
    kind: DeletionKind,
    requestId: string,
    claimToken: string,
    object: DeletionStorageObject,
  ): Promise<void>;
  summarizeStorage(
    kind: DeletionKind,
    requestId: string,
    claimToken: string,
  ): Promise<Record<string, unknown>>;
  executeRetentionMinimization(
    requestId: string,
    claimToken: string,
  ): Promise<Record<string, unknown>>;
  blockRetention(
    requestId: string,
    claimToken: string,
    evidence: Record<string, unknown>,
  ): Promise<void>;
  getAccountSubject(requestId: string, stepName: string, claimToken: string): Promise<string>;
  softDeleteAuthUser(userId: string): Promise<void>;
  recordFinalization(
    kind: DeletionKind,
    requestId: string,
    claimToken: string,
  ): Promise<Record<string, unknown>>;
  complete(
    kind: DeletionKind,
    requestId: string,
    stepName: string,
    claimToken: string,
    evidence: Record<string, unknown>,
  ): Promise<void>;
  fail(
    kind: DeletionKind,
    requestId: string,
    stepName: string,
    claimToken: string,
    failureCode: string,
  ): Promise<void>;
};

function failureCode(error: unknown) {
  const code = error instanceof Error ? error.message : "deletion_step_failed";
  return /^[a-z0-9_]{3,120}$/.test(code) ? code : "deletion_step_failed";
}

export async function runDeletionWorkflowStep(
  io: DeletionWorkflowIo,
  kind: DeletionKind,
  requestId: string,
) {
  const claim = await io.claim(kind, requestId);
  if (!claim) return { status: "blocked_or_idle" as const, step: null };
  try {
    let evidence: Record<string, unknown>;
    if (claim.step_name === "session_revocation") {
      throw new Error("session_revocation_requires_verified_user_token");
    } else if (claim.step_name === "database_content") {
      evidence = await io.executeDatabase(kind, requestId, claim.claim_token);
    } else if (claim.step_name === "storage") {
      const objects = await io.listStorage(kind, requestId, claim.claim_token);
      for (const object of objects) {
        await io.removeStorage(object.bucket_id, object.object_path);
        if (await io.storageObjectExists(object.bucket_id, object.object_path)) {
          throw new Error("storage_object_still_present");
        }
        await io.completeStorageObject(kind, requestId, claim.claim_token, object);
      }
      evidence = await io.summarizeStorage(kind, requestId, claim.claim_token);
    } else if (claim.step_name === "retention_minimization") {
      if (kind !== "account") throw new Error("invalid_deletion_step");
      evidence = await io.executeRetentionMinimization(requestId, claim.claim_token);
      if (evidence.completion_ready !== true) {
        await io.blockRetention(requestId, claim.claim_token, evidence);
        return { status: "blocked" as const, step: claim.step_name };
      }
    } else if (claim.step_name === "auth_delete") {
      if (kind !== "account") throw new Error("invalid_deletion_step");
      const userId = await io.getAccountSubject(requestId, claim.step_name, claim.claim_token);
      await io.softDeleteAuthUser(userId);
      evidence = { operation: "supabase_auth_soft_delete", provider_confirmed: true };
    } else if (claim.step_name === "finalize") {
      evidence = await io.recordFinalization(kind, requestId, claim.claim_token);
    } else {
      throw new Error("invalid_deletion_step");
    }
    await io.complete(kind, requestId, claim.step_name, claim.claim_token, evidence);
    return { status: "completed" as const, step: claim.step_name };
  } catch (error) {
    try {
      await io.fail(kind, requestId, claim.step_name, claim.claim_token, failureCode(error));
    } catch {
      // Preserve the primary operation failure.
    }
    throw error;
  }
}
