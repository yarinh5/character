import { describe, expect, it } from "vitest";

import {
  buildServerConfigurationStatus,
  getDeliveryConfigurationStatus,
  readRecoveryConnectionConfig,
  resolveAllowedAuthRedirect,
  validateRecoveryEnvelopeConfiguration,
} from "../../supabase/functions/_shared/configuration-connections";

describe("product configuration connections", () => {
  it("accepts only a configured Auth redirect on an explicitly allowed origin", () => {
    expect(
      resolveAllowedAuthRedirect(
        {
          AUTH_REDIRECT_ALLOWED_ORIGINS: "https://product.example,https://account.example",
          ACCOUNT_DELETION_CONFIRM_REDIRECT_URL: "https://account.example/verify-account-deletion",
        },
        "ACCOUNT_DELETION_CONFIRM_REDIRECT_URL",
      ),
    ).toBe("https://account.example/verify-account-deletion");
    expect(
      resolveAllowedAuthRedirect(
        {
          AUTH_REDIRECT_ALLOWED_ORIGINS: "https://product.example",
          ACCOUNT_DELETION_CONFIRM_REDIRECT_URL: "https://attacker.example/steal",
        },
        "ACCOUNT_DELETION_CONFIRM_REDIRECT_URL",
      ),
    ).toBeNull();
    expect(
      resolveAllowedAuthRedirect(
        { AUTH_REDIRECT_ALLOWED_ORIGINS: "https://product.example" },
        "ACCOUNT_DELETION_CONFIRM_REDIRECT_URL",
      ),
    ).toBeNull();
  });

  it("requires every recovery authority binding without exposing the HMAC key", () => {
    const config = readRecoveryConnectionConfig({
      RESTORE_RECOVERY_AUTHORITY_HMAC_KEY: "secret-value",
      RESTORE_RECOVERY_EXPECTED_LOCK_ID: "lock-91",
      RESTORE_RECOVERY_EXPECTED_AUTHORITY_ID: "authority-91",
      RESTORE_RECOVERY_CONTRACT_VERSION: "p06-recovery-v1",
      RESTORE_RECOVERY_IMPORT_ENABLED: "false",
      RESTORE_RECOVERY_RELEASE_ENABLED: "false",
      RESTORE_RECOVERY_REPLAY_ENABLED: "false",
    });

    expect(config).toEqual({
      expectedLockId: "lock-91",
      expectedAuthorityId: "authority-91",
      contractVersion: "p06-recovery-v1",
      importEnabled: false,
      releaseEnabled: false,
      replayEnabled: false,
      authorityKeyConfigured: true as const,
    });
    expect(JSON.stringify(config)).not.toContain("secret-value");
    expect(
      readRecoveryConnectionConfig({
        RESTORE_RECOVERY_AUTHORITY_HMAC_KEY: "secret-value",
        RESTORE_RECOVERY_EXPECTED_LOCK_ID: "lock-91",
      }),
    ).toBeNull();
  });

  it("rejects a recovery envelope for another authority or contract version", () => {
    const config = {
      expectedLockId: "lock-91",
      expectedAuthorityId: "authority-91",
      contractVersion: "p06-recovery-v1",
      importEnabled: false,
      releaseEnabled: false,
      replayEnabled: false,
      authorityKeyConfigured: true as const,
    };

    expect(
      validateRecoveryEnvelopeConfiguration(
        {
          externalLockId: "lock-91",
          externalAuthorityId: "authority-91",
          contractVersion: "p06-recovery-v1",
        },
        config,
      ),
    ).toBeNull();
    expect(
      validateRecoveryEnvelopeConfiguration(
        {
          externalLockId: "lock-91",
          externalAuthorityId: "other",
          contractVersion: "p06-recovery-v1",
        },
        config,
      ),
    ).toBe("recovery_external_authority_mismatch");
    expect(
      validateRecoveryEnvelopeConfiguration(
        { externalLockId: "lock-91", externalAuthorityId: "authority-91", contractVersion: "v2" },
        config,
      ),
    ).toBe("recovery_contract_version_mismatch");
  });

  it("does not treat a configured recipient as a verified delivery adapter", () => {
    expect(getDeliveryConfigurationStatus(false, false)).toBe("not_configured");
    expect(getDeliveryConfigurationStatus(true, false)).toBe("configured_not_verified");
    expect(getDeliveryConfigurationStatus(true, true)).toBe("verified");
  });

  it("reports configuration presence without returning server secrets or claiming delivery", () => {
    const status = buildServerConfigurationStatus({
      AUTH_REDIRECT_ALLOWED_ORIGINS: "https://product.example",
      AUTH_EMAIL_VERIFICATION_REDIRECT_URL: "https://product.example/verify-email",
      ACCOUNT_DELETION_CONFIRM_REDIRECT_URL: "https://product.example/verify-deletion",
      ACCOUNT_DELETION_CANCEL_REDIRECT_URL: "https://product.example/cancel-deletion",
      RESTORE_RECOVERY_AUTHORITY_HMAC_KEY: "must-not-leak",
      RESTORE_RECOVERY_EXPECTED_LOCK_ID: "lock-91",
      RESTORE_RECOVERY_EXPECTED_AUTHORITY_ID: "authority-91",
      RESTORE_RECOVERY_CONTRACT_VERSION: "p06-recovery-v1",
      RESTORE_RECOVERY_IMPORT_ENABLED: "false",
      RESTORE_RECOVERY_RELEASE_ENABLED: "false",
      RESTORE_RECOVERY_REPLAY_ENABLED: "false",
    });

    expect(status).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "registration_email_redirect",
          state: "configured_not_verified",
        }),
        expect.objectContaining({
          key: "account_deletion_email_redirects",
          state: "configured_not_verified",
        }),
        expect.objectContaining({
          key: "restore_recovery_authority",
          state: "configured_not_verified",
        }),
        expect.objectContaining({ key: "bot_protection_provider", state: "not_configured" }),
        expect.objectContaining({ key: "trusted_proxy_boundary", state: "not_configured" }),
      ]),
    );
    expect(JSON.stringify(status)).not.toContain("must-not-leak");
    expect(status.find((item) => item.key === "restore_recovery_authority")?.actionsEnabled).toBe(
      false,
    );
  });
});
