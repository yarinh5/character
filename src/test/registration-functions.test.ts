import { describe, expect, it, vi } from "vitest";

import { RegistrationFailure, registerClientWithDependencies } from "@/lib/registration.functions";

const request = {
  displayName: "לקוחה חדשה",
  email: " Client@Example.com ",
  password: "correct-horse-battery",
  ageConfirmed: true,
  termsAccepted: true,
  redirectUrl: "https://attacker.example/steal",
};

describe("registerClientWithDependencies", () => {
  it("uses a server-issued admission nonce and returns verification_pending", async () => {
    const issueAdmission = vi.fn().mockResolvedValue({
      allowed: true,
      admissionToken: "one-time-token",
      expiresAt: "2026-11-11T16:10:00.000Z",
    });
    const signUp = vi.fn().mockResolvedValue({ userId: "user-1" });

    await expect(
      registerClientWithDependencies(
        request,
        { issueAdmission, signUp },
        { emailVerificationRedirectUrl: "https://product.example/verify-email" },
      ),
    ).resolves.toEqual({ status: "verification_pending" });

    expect(issueAdmission).toHaveBeenCalledWith({
      email: "client@example.com",
      ageConfirmed: true,
      termsAccepted: true,
    });
    expect(signUp).toHaveBeenCalledWith({
      email: "client@example.com",
      password: request.password,
      redirectUrl: "https://product.example/verify-email",
      metadata: {
        display_name: request.displayName,
        registration_admission_token: "one-time-token",
      },
    });
  });

  it("rejects registration before Auth when the server redirect is not configured", async () => {
    const issueAdmission = vi.fn().mockResolvedValue({
      allowed: true,
      admissionToken: "one-time-token",
      expiresAt: "2026-11-11T16:10:00.000Z",
    });
    const signUp = vi.fn();

    await expect(
      registerClientWithDependencies(request, { issueAdmission, signUp }, null),
    ).rejects.toMatchObject({ code: "registration_unavailable" });
    expect(issueAdmission).not.toHaveBeenCalled();
    expect(signUp).not.toHaveBeenCalled();
  });

  it("does not call Auth when registrations are paused", async () => {
    const issueAdmission = vi.fn().mockResolvedValue({
      allowed: false,
      reason: "registration_paused",
    });
    const signUp = vi.fn();

    await expect(
      registerClientWithDependencies(
        request,
        { issueAdmission, signUp },
        {
          emailVerificationRedirectUrl: "https://product.example/verify-email",
        },
      ),
    ).rejects.toMatchObject({ code: "registration_paused" });
    expect(signUp).not.toHaveBeenCalled();
  });

  it("does not call Auth after a bounded registration-rate denial", async () => {
    const issueAdmission = vi.fn().mockResolvedValue({
      allowed: false,
      reason: "registration_rate_limited",
      retryAfterSeconds: 600,
    });
    const signUp = vi.fn();

    await expect(
      registerClientWithDependencies(
        request,
        { issueAdmission, signUp },
        {
          emailVerificationRedirectUrl: "https://product.example/verify-email",
        },
      ),
    ).rejects.toMatchObject({ code: "registration_rate_limited" });
    expect(signUp).not.toHaveBeenCalled();
  });

  it("preserves an Auth failure without reporting false success", async () => {
    const issueAdmission = vi.fn().mockResolvedValue({
      allowed: true,
      admissionToken: "one-time-token",
      expiresAt: "2026-11-11T16:10:00.000Z",
    });
    const signUp = vi.fn().mockRejectedValue(new RegistrationFailure("auth_failed"));

    await expect(
      registerClientWithDependencies(
        request,
        { issueAdmission, signUp },
        {
          emailVerificationRedirectUrl: "https://product.example/verify-email",
        },
      ),
    ).rejects.toMatchObject({ code: "auth_failed" });
  });

  it("rejects missing declarations before issuing an admission", async () => {
    const issueAdmission = vi.fn();
    const signUp = vi.fn();

    await expect(
      registerClientWithDependencies(
        { ...request, ageConfirmed: false },
        { issueAdmission, signUp },
      ),
    ).rejects.toMatchObject({ code: "eligibility_declaration_required" });
    expect(issueAdmission).not.toHaveBeenCalled();
    expect(signUp).not.toHaveBeenCalled();
  });
});
