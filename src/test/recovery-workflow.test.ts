import { describe, expect, it } from "vitest";

import { evaluateRecoveryGate } from "@/lib/recoveryWorkflow";

const complete = {
  eventId: "00000000-0000-4000-8000-000000091001",
  version: 4,
  status: "ready_for_approval" as const,
  externalLock: "verified" as const,
  ledgerReconciliation: "verified" as const,
  deletionReplay: "verified" as const,
  personalDataReview: "verified" as const,
  approvalEventId: "00000000-0000-4000-8000-000000091001",
  approvalVersion: 4,
};

describe("restore recovery gate", () => {
  it("blocks normal activity when no current recovery event can be proven", () => {
    expect(evaluateRecoveryGate(null)).toEqual({
      blocked: true,
      code: "recovery_state_unknown",
    });
  });

  it("rejects approval from an older event version", () => {
    expect(evaluateRecoveryGate({ ...complete, approvalVersion: 3 })).toEqual({
      blocked: true,
      code: "recovery_approval_stale",
    });
  });

  it.each([
    ["externalLock", "missing", "recovery_external_lock_unverified"],
    ["ledgerReconciliation", "gap", "recovery_ledger_gap"],
    ["ledgerReconciliation", "unknown", "recovery_ledger_unknown"],
    ["deletionReplay", "pending", "recovery_deletions_unverified"],
    ["personalDataReview", "failed", "recovery_personal_data_unverified"],
  ] as const)("blocks when %s is %s", (field, value, code) => {
    expect(evaluateRecoveryGate({ ...complete, [field]: value })).toEqual({ blocked: true, code });
  });

  it("opens only the exact event and version with every requirement verified", () => {
    expect(evaluateRecoveryGate({ ...complete, status: "reopened" })).toEqual({
      blocked: false,
      code: "recovery_open",
    });
  });
});
