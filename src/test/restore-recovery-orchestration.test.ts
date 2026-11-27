import { describe, expect, it, vi } from "vitest";

import {
  runRestoreRecoveryImport,
  type RestoreRecoveryImport,
  type RestoreRecoveryIo,
} from "../../supabase/functions/process-restore-recovery/orchestration";

const input: RestoreRecoveryImport = {
  eventId: "00000000-0000-4000-8000-000000091001",
  contractVersion: "p06-recovery-v1",
  externalLockId: "external-lock-91",
  externalLockEvidenceHash: "e".repeat(64),
  externalAuthorityId: "recovery-authority-primary",
  sourceSnapshotId: "snapshot-2026-11-11",
  sourceSnapshotAt: "2026-11-11T19:30:00.000Z",
  ownerAdminId: "00000000-0000-4000-8000-000000091201",
  manifestId: "manifest-91",
  sequence: 7,
  previousManifestHash: "a".repeat(64),
  manifestHash: "b".repeat(64),
  coverageThrough: "2026-11-11T20:00:00.000Z",
  generatedAt: "2026-11-11T20:01:00.000Z",
  deletionCoverageComplete: true,
  reconciliation: [
    {
      category: "credit_ledger",
      outcome: "matched",
      matchedCount: 12,
      gapCount: 0,
      unknownCount: 0,
      evidenceHash: "c".repeat(64),
    },
  ],
  deletions: [
    {
      requestKind: "account",
      requestId: "00000000-0000-4000-8000-000000091101",
      policyVersion: "p04-v1",
      completedAt: "2026-11-11T19:00:00.000Z",
      evidenceHash: "d".repeat(64),
      hold: false,
    },
  ],
};

function createIo(overrides: Partial<RestoreRecoveryIo> = {}): RestoreRecoveryIo {
  return {
    verifyExternalEnvelope: vi.fn().mockResolvedValue(true),
    beginEvent: vi.fn().mockResolvedValue({ eventVersion: 1 }),
    importAuthorityManifest: vi.fn().mockResolvedValue({ imported: true }),
    recordReconciliation: vi.fn().mockResolvedValue(undefined),
    stageDeletionReplay: vi.fn().mockResolvedValue(undefined),
    finalizeImport: vi.fn().mockResolvedValue({ status: "blocked", eventVersion: 2 }),
    failImport: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("restore recovery import orchestration", () => {
  it("does not mutate the database when the external envelope cannot be verified", async () => {
    const io = createIo({ verifyExternalEnvelope: vi.fn().mockResolvedValue(false) });

    await expect(runRestoreRecoveryImport(io, input, "bad-signature")).rejects.toThrow(
      "recovery_external_authority_unverified",
    );
    expect(io.beginEvent).not.toHaveBeenCalled();
    expect(io.failImport).not.toHaveBeenCalled();
  });

  it("records reconciliation and deletion replay work without executing either correction", async () => {
    const io = createIo();

    await expect(runRestoreRecoveryImport(io, input, "signed-envelope")).resolves.toEqual({
      status: "blocked",
      eventVersion: 2,
    });
    expect(io.recordReconciliation).toHaveBeenCalledTimes(1);
    expect(io.stageDeletionReplay).toHaveBeenCalledTimes(1);
    expect(Object.keys(io)).not.toContain("applyLedgerCorrection");
    expect(Object.keys(io)).not.toContain("executeDeletionReplay");
  });

  it("preserves a partial import as a failure and never marks the event ready", async () => {
    const io = createIo({
      stageDeletionReplay: vi.fn().mockRejectedValue(new Error("recovery_deletion_stage_failed")),
    });

    await expect(runRestoreRecoveryImport(io, input, "signed-envelope")).rejects.toThrow(
      "recovery_deletion_stage_failed",
    );
    expect(io.failImport).toHaveBeenCalledWith(input.eventId, 1, "recovery_deletion_stage_failed");
    expect(io.finalizeImport).not.toHaveBeenCalled();
  });
});
