export type RestoreReconciliationEntry = {
  category: string;
  outcome: "matched" | "gap" | "unknown";
  matchedCount: number;
  gapCount: number;
  unknownCount: number;
  evidenceHash: string;
};

export type RestoreDeletionEntry = {
  requestKind: "account" | "conversation";
  requestId: string;
  policyVersion: string;
  completedAt: string;
  evidenceHash: string;
  hold: boolean;
};

export type RestoreRecoveryImport = {
  eventId: string;
  contractVersion: string;
  externalLockId: string;
  externalLockEvidenceHash: string;
  externalAuthorityId: string;
  sourceSnapshotId: string;
  sourceSnapshotAt: string;
  ownerAdminId: string;
  manifestId: string;
  sequence: number;
  previousManifestHash: string | null;
  manifestHash: string;
  coverageThrough: string;
  generatedAt: string;
  deletionCoverageComplete: boolean;
  reconciliation: RestoreReconciliationEntry[];
  deletions: RestoreDeletionEntry[];
};

export type RestoreRecoveryIo = {
  verifyExternalEnvelope(input: RestoreRecoveryImport, signature: string): Promise<boolean>;
  beginEvent(input: RestoreRecoveryImport): Promise<{ eventVersion: number }>;
  importAuthorityManifest(input: RestoreRecoveryImport, eventVersion: number): Promise<void>;
  recordReconciliation(
    eventId: string,
    eventVersion: number,
    entry: RestoreReconciliationEntry,
  ): Promise<void>;
  stageDeletionReplay(
    eventId: string,
    eventVersion: number,
    entry: RestoreDeletionEntry,
  ): Promise<void>;
  finalizeImport(
    eventId: string,
    eventVersion: number,
  ): Promise<{ status: "blocked"; eventVersion: number }>;
  failImport(eventId: string, eventVersion: number, failureCode: string): Promise<void>;
};

function safeFailureCode(error: unknown) {
  const code = error instanceof Error ? error.message : "recovery_import_failed";
  return /^[a-z0-9_]{3,120}$/.test(code) ? code : "recovery_import_failed";
}

export async function runRestoreRecoveryImport(
  io: RestoreRecoveryIo,
  input: RestoreRecoveryImport,
  signature: string,
) {
  if (!(await io.verifyExternalEnvelope(input, signature))) {
    throw new Error("recovery_external_authority_unverified");
  }

  const { eventVersion } = await io.beginEvent(input);
  try {
    await io.importAuthorityManifest(input, eventVersion);
    for (const entry of input.reconciliation) {
      await io.recordReconciliation(input.eventId, eventVersion, entry);
    }
    for (const entry of input.deletions) {
      await io.stageDeletionReplay(input.eventId, eventVersion, entry);
    }
    return await io.finalizeImport(input.eventId, eventVersion);
  } catch (error) {
    const code = safeFailureCode(error);
    try {
      await io.failImport(input.eventId, eventVersion, code);
    } catch {
      // Preserve the primary import failure.
    }
    throw error;
  }
}
