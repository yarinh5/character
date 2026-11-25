export type RecoveryRequirementState = "verified" | "pending" | "missing" | "gap" | "unknown" | "failed";

export type RecoveryGateState = {
  eventId: string;
  version: number;
  status:
    | "blocked"
    | "reconciling"
    | "deletions_pending"
    | "ready_for_approval"
    | "approved_pending_external_release"
    | "reopened"
    | "failed";
  externalLock: RecoveryRequirementState;
  ledgerReconciliation: RecoveryRequirementState;
  deletionReplay: RecoveryRequirementState;
  personalDataReview: RecoveryRequirementState;
  approvalEventId: string | null;
  approvalVersion: number | null;
};

export type RecoveryGateDecision = { blocked: boolean; code: string };

export function evaluateRecoveryGate(state: RecoveryGateState | null): RecoveryGateDecision {
  if (!state) return { blocked: true, code: "recovery_state_unknown" };
  if (state.externalLock !== "verified") {
    return { blocked: true, code: "recovery_external_lock_unverified" };
  }
  if (state.ledgerReconciliation === "gap") {
    return { blocked: true, code: "recovery_ledger_gap" };
  }
  if (state.ledgerReconciliation !== "verified") {
    return { blocked: true, code: "recovery_ledger_unknown" };
  }
  if (state.deletionReplay !== "verified") {
    return { blocked: true, code: "recovery_deletions_unverified" };
  }
  if (state.personalDataReview !== "verified") {
    return { blocked: true, code: "recovery_personal_data_unverified" };
  }
  if (
    state.approvalEventId !== state.eventId ||
    state.approvalVersion !== state.version
  ) {
    return { blocked: true, code: "recovery_approval_stale" };
  }
  if (state.status !== "reopened") {
    return { blocked: true, code: "recovery_not_reopened" };
  }
  return { blocked: false, code: "recovery_open" };
}
