import { describe, expect, it } from "vitest";

import { resolvePublicPasswordResetRedirect } from "@/lib/authRedirects";

describe("public Auth redirect configuration", () => {
  it("returns the fixed reset route only when its origin is allowlisted", () => {
    expect(
      resolvePublicPasswordResetRedirect({
        VITE_PASSWORD_RESET_REDIRECT_URL: "https://product.example/reset-password",
        VITE_AUTH_REDIRECT_ALLOWED_ORIGINS: "https://product.example",
      }),
    ).toBe("https://product.example/reset-password");
  });

  it("rejects missing, malformed and non-allowlisted redirects", () => {
    expect(resolvePublicPasswordResetRedirect({})).toBeNull();
    expect(
      resolvePublicPasswordResetRedirect({
        VITE_PASSWORD_RESET_REDIRECT_URL: "not-a-url",
        VITE_AUTH_REDIRECT_ALLOWED_ORIGINS: "https://product.example",
      }),
    ).toBeNull();
    expect(
      resolvePublicPasswordResetRedirect({
        VITE_PASSWORD_RESET_REDIRECT_URL: "https://attacker.example/reset-password",
        VITE_AUTH_REDIRECT_ALLOWED_ORIGINS: "https://product.example",
      }),
    ).toBeNull();
  });
});
