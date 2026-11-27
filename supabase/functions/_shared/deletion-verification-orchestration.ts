export type DeletionRequest = {
  id: string;
  status: string;
  requested_at: string;
};

export type VerifiedIdentity = {
  id: string;
  email: string;
  emailConfirmed: boolean;
};

export type DeletionStepClaim = {
  request_id: string;
  step_name: string;
  attempt_count: number;
  claim_token: string;
  lease_expires_at: string;
};

export type VerificationIo = {
  randomToken(): string;
  sha256(value: string): Promise<string>;
  requestDeletion(idempotencyKey: string): Promise<DeletionRequest>;
  currentIdentity(): Promise<VerifiedIdentity>;
  prepareVerification(requestId: string, tokenHash: string, expiresAt: string): Promise<void>;
  sendMagicLink(email: string, redirectTo: string): Promise<void>;
  verifyDeletion(requestId: string, tokenHash: string, userId: string): Promise<void>;
  claimAccountStep(requestId: string): Promise<DeletionStepClaim | null>;
  revokeGlobalSessions(accessToken: string): Promise<void>;
  completeAccountStep(
    requestId: string,
    stepName: string,
    claimToken: string,
    evidence: Record<string, unknown>,
  ): Promise<void>;
  failAccountStep(
    requestId: string,
    stepName: string,
    claimToken: string,
    failureCode: string,
  ): Promise<void>;
  getDeletionStatus(): Promise<{ id: string; status: string }>;
  prepareCancellation(
    requestId: string,
    userId: string,
    tokenHash: string,
    expiresAt: string,
  ): Promise<void>;
  cancelDeletion(requestId: string, userId: string, tokenHash: string): Promise<void>;
};

type RequestVerificationIo = Pick<
  VerificationIo,
  | "randomToken"
  | "sha256"
  | "requestDeletion"
  | "currentIdentity"
  | "prepareVerification"
  | "sendMagicLink"
>;
type ConfirmVerificationIo = Pick<
  VerificationIo,
  | "sha256"
  | "currentIdentity"
  | "verifyDeletion"
  | "claimAccountStep"
  | "revokeGlobalSessions"
  | "completeAccountStep"
  | "failAccountStep"
>;
type RequestCancellationIo = Pick<
  VerificationIo,
  | "randomToken"
  | "sha256"
  | "currentIdentity"
  | "getDeletionStatus"
  | "prepareCancellation"
  | "sendMagicLink"
>;
type ConfirmCancellationIo = Pick<VerificationIo, "sha256" | "currentIdentity" | "cancelDeletion">;

function addQuery(url: string, values: Record<string, string>) {
  const target = new URL(url);
  for (const [key, value] of Object.entries(values)) target.searchParams.set(key, value);
  return target.toString();
}

function expiry(minutes: number) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export async function requestAccountDeletionVerification(
  io: RequestVerificationIo,
  idempotencyKey: string,
  confirmRedirectUrl: string,
) {
  const request = await io.requestDeletion(idempotencyKey);
  if (request.status !== "awaiting_verification") {
    throw new Error("deletion_request_not_awaiting_verification");
  }
  const identity = await io.currentIdentity();
  if (!identity.emailConfirmed) throw new Error("verified_email_required");
  const token = io.randomToken();
  const tokenHash = await io.sha256(token);
  await io.prepareVerification(request.id, tokenHash, expiry(30));
  await io.sendMagicLink(
    identity.email,
    addQuery(confirmRedirectUrl, { request: request.id, token }),
  );
  return request;
}

export async function confirmAccountDeletion(
  io: ConfirmVerificationIo,
  requestId: string,
  token: string,
  accessToken: string,
) {
  const identity = await io.currentIdentity();
  const tokenHash = await io.sha256(token);
  await io.verifyDeletion(requestId, tokenHash, identity.id);
  const claim = await io.claimAccountStep(requestId);
  if (!claim || claim.step_name !== "session_revocation") {
    throw new Error("session_revocation_claim_unavailable");
  }
  try {
    await io.revokeGlobalSessions(accessToken);
    await io.completeAccountStep(requestId, claim.step_name, claim.claim_token, {
      operation: "supabase_auth_global_signout",
      provider_confirmed: true,
    });
  } catch (error) {
    try {
      await io.failAccountStep(
        requestId,
        claim.step_name,
        claim.claim_token,
        "auth_session_revocation_failed",
      );
    } catch {
      // The primary provider failure must remain the reported failure.
    }
    throw error;
  }
}

export async function requestAccountDeletionCancellation(
  io: RequestCancellationIo,
  cancelRedirectUrl: string,
) {
  const identity = await io.currentIdentity();
  if (!identity.emailConfirmed) throw new Error("verified_email_required");
  const request = await io.getDeletionStatus();
  if (request.status !== "cancellation_window") {
    throw new Error("deletion_request_not_cancellable");
  }
  const token = io.randomToken();
  const tokenHash = await io.sha256(token);
  await io.prepareCancellation(request.id, identity.id, tokenHash, expiry(30));
  await io.sendMagicLink(
    identity.email,
    addQuery(cancelRedirectUrl, { request: request.id, token }),
  );
  return request;
}

export async function confirmAccountDeletionCancellation(
  io: ConfirmCancellationIo,
  requestId: string,
  token: string,
) {
  const identity = await io.currentIdentity();
  await io.cancelDeletion(requestId, identity.id, await io.sha256(token));
}
