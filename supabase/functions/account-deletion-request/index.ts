import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { requestAccountDeletionVerification } from "../_shared/deletion-verification-orchestration.ts";
import { resolveAllowedAuthRedirect } from "../_shared/configuration-connections.ts";

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });

const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

const sha256 = async (value: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

Deno.serve(async (request) => {
  if (request.method !== "POST") return json(404, { code: "not_found" });
  const url = Deno.env.get("SUPABASE_URL");
  const publishable = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  const redirect = resolveAllowedAuthRedirect(
    {
      AUTH_REDIRECT_ALLOWED_ORIGINS: Deno.env.get("AUTH_REDIRECT_ALLOWED_ORIGINS"),
      ACCOUNT_DELETION_CONFIRM_REDIRECT_URL: Deno.env.get(
        "ACCOUNT_DELETION_CONFIRM_REDIRECT_URL",
      ),
    },
    "ACCOUNT_DELETION_CONFIRM_REDIRECT_URL",
  );
  const authorization = request.headers.get("Authorization") ?? "";
  if (!url || !publishable || !service || !redirect) {
    return json(503, { code: "account_deletion_email_not_configured" });
  }
  if (!authorization.startsWith("Bearer ")) return json(401, { code: "unauthorized" });

  const caller = createClient(url, publishable, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const trusted = createClient(url, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const mailer = createClient(url, publishable, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    const body = (await request.json()) as { idempotency_key?: string };
    if (!body.idempotency_key) return json(400, { code: "idempotency_key_required" });
    const result = await requestAccountDeletionVerification(
      {
        randomToken,
        sha256,
        async requestDeletion(idempotencyKey) {
          const { data, error } = await caller.rpc("request_account_deletion", {
            _idempotency_key: idempotencyKey,
          });
          const row = Array.isArray(data) ? data[0] : null;
          if (error || !row) throw new Error("deletion_request_failed");
          return row;
        },
        async currentIdentity() {
          const { data, error } = await caller.auth.getUser();
          const user = data.user;
          if (error || !user?.id || !user.email) throw new Error("unauthorized");
          return { id: user.id, email: user.email, emailConfirmed: !!user.email_confirmed_at };
        },
        async prepareVerification(requestId, tokenHash, expiresAt) {
          const { error } = await trusted.rpc("prepare_account_deletion_verification_for_server", {
            _request_id: requestId,
            _token_hash: tokenHash,
            _expires_at: expiresAt,
          });
          if (error) throw new Error("verification_prepare_failed");
        },
        async sendMagicLink(email, redirectTo) {
          const { error } = await mailer.auth.signInWithOtp({
            email,
            options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
          });
          if (error) throw new Error("verification_email_failed");
        },
      },
      body.idempotency_key,
      redirect,
    );
    return json(200, {
      request: result,
      delivery_status: "provider_requested",
      delivery_provider: "supabase_auth_email",
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "account_deletion_request_failed";
    return json(code === "unauthorized" ? 401 : 400, { code });
  }
});
