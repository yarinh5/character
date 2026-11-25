export type ConfigurationState = "not_configured" | "configured_not_verified" | "verified";

type Environment = Record<string, string | undefined>;

export function resolveAllowedAuthRedirect(
  environment: Environment,
  variableName: string,
): string | null {
  const configured = environment[variableName]?.trim();
  const allowedOrigins = new Set(
    (environment.AUTH_REDIRECT_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (!configured || allowedOrigins.size === 0) return null;
  try {
    const target = new URL(configured);
    if (!['http:', 'https:'].includes(target.protocol) || !allowedOrigins.has(target.origin)) {
      return null;
    }
    return target.toString();
  } catch {
    return null;
  }
}

export type RecoveryConnectionConfig = {
  expectedLockId: string;
  expectedAuthorityId: string;
  contractVersion: string;
  importEnabled: boolean;
  releaseEnabled: boolean;
  replayEnabled: boolean;
  authorityKeyConfigured: true;
};

export type ServerConfigurationStatus = {
  key: string;
  state: ConfigurationState;
  actionsEnabled: boolean;
  requiredBy: string;
};

export function buildServerConfigurationStatus(
  environment: Environment,
): ServerConfigurationStatus[] {
  const registrationRedirect = resolveAllowedAuthRedirect(
    environment,
    "AUTH_EMAIL_VERIFICATION_REDIRECT_URL",
  );
  const deletionConfirm = resolveAllowedAuthRedirect(
    environment,
    "ACCOUNT_DELETION_CONFIRM_REDIRECT_URL",
  );
  const deletionCancel = resolveAllowedAuthRedirect(
    environment,
    "ACCOUNT_DELETION_CANCEL_REDIRECT_URL",
  );
  const recovery = readRecoveryConnectionConfig(environment);
  return [
    {
      key: "registration_email_redirect",
      state: registrationRedirect ? "configured_not_verified" : "not_configured",
      actionsEnabled: !!registrationRedirect,
      requiredBy: "new_registration_email_verification",
    },
    {
      key: "account_deletion_email_redirects",
      state:
        deletionConfirm && deletionCancel ? "configured_not_verified" : "not_configured",
      actionsEnabled: !!deletionConfirm && !!deletionCancel,
      requiredBy: "account_deletion_verification_and_cancellation",
    },
    {
      key: "restore_recovery_authority",
      state: recovery ? "configured_not_verified" : "not_configured",
      actionsEnabled: !!recovery && (recovery.importEnabled || recovery.releaseEnabled),
      requiredBy: "restore_import_release_and_replay",
    },
    {
      key: "bot_protection_provider",
      state: "not_configured",
      actionsEnabled: false,
      requiredBy: "automated_registration_protection",
    },
    {
      key: "trusted_proxy_boundary",
      state: "not_configured",
      actionsEnabled: false,
      requiredBy: "source_address_rate_limiting",
    },
  ];
}

export function readRecoveryConnectionConfig(
  environment: Environment,
): RecoveryConnectionConfig | null {
  const expectedLockId = environment.RESTORE_RECOVERY_EXPECTED_LOCK_ID?.trim();
  const expectedAuthorityId = environment.RESTORE_RECOVERY_EXPECTED_AUTHORITY_ID?.trim();
  const contractVersion = environment.RESTORE_RECOVERY_CONTRACT_VERSION?.trim();
  const authorityKey = environment.RESTORE_RECOVERY_AUTHORITY_HMAC_KEY;
  if (!expectedLockId || !expectedAuthorityId || !contractVersion || !authorityKey) return null;
  return {
    expectedLockId,
    expectedAuthorityId,
    contractVersion,
    importEnabled: environment.RESTORE_RECOVERY_IMPORT_ENABLED === "true",
    releaseEnabled: environment.RESTORE_RECOVERY_RELEASE_ENABLED === "true",
    replayEnabled: environment.RESTORE_RECOVERY_REPLAY_ENABLED === "true",
    authorityKeyConfigured: true,
  };
}

export function validateRecoveryEnvelopeConfiguration(
  input: { externalLockId: string; externalAuthorityId: string; contractVersion: string },
  config: RecoveryConnectionConfig,
): string | null {
  if (input.externalLockId !== config.expectedLockId) return "recovery_external_lock_mismatch";
  if (input.externalAuthorityId !== config.expectedAuthorityId) {
    return "recovery_external_authority_mismatch";
  }
  if (input.contractVersion !== config.contractVersion) {
    return "recovery_contract_version_mismatch";
  }
  return null;
}

export function getDeliveryConfigurationStatus(
  recipientConfigured: boolean,
  adapterVerified: boolean,
): ConfigurationState {
  if (!recipientConfigured) return "not_configured";
  return adapterVerified ? "verified" : "configured_not_verified";
}
