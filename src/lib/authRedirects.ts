export function resolvePublicPasswordResetRedirect(
  environment: Record<string, string | undefined>,
): string | null {
  const configured = environment.VITE_PASSWORD_RESET_REDIRECT_URL?.trim();
  const allowedOrigins = new Set(
    (environment.VITE_AUTH_REDIRECT_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (!configured || allowedOrigins.size === 0) return null;
  try {
    const target = new URL(configured);
    if (!["http:", "https:"].includes(target.protocol) || !allowedOrigins.has(target.origin)) {
      return null;
    }
    return target.toString();
  } catch {
    return null;
  }
}
