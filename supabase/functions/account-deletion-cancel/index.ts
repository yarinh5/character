import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  type AccountDeletionJson,
  withAccountDeletionHttp,
} from "../_shared/account-deletion-http.ts";
import { confirmAccountDeletionCancellation } from "../_shared/deletion-verification-orchestration.ts";

const sha256 = async (value: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

Deno.serve(
  withAccountDeletionHttp(handleRequest, () => Deno.env.get("AUTH_REDIRECT_ALLOWED_ORIGINS")),
);

async function handleRequest(request: Request, json: AccountDeletionJson) {
  const url = Deno.env.get("SUPABASE_URL");
  const publishable = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  const authorization = request.headers.get("Authorization") ?? "";
  const accessToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!url || !publishable || !service)
    return json(503, { code: "account_deletion_not_configured" });
  if (!accessToken) return json(401, { code: "unauthorized" });
  const caller = createClient(url, publishable, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const trusted = createClient(url, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    const body = (await request.json()) as { request_id?: string; token?: string };
    if (!body.request_id || !body.token) return json(400, { code: "verification_token_required" });
    await confirmAccountDeletionCancellation(
      {
        sha256,
        async currentIdentity() {
          const { data, error } = await caller.auth.getUser();
          const user = data.user;
          if (error || !user?.id || !user.email) throw new Error("unauthorized");
          return { id: user.id, email: user.email, emailConfirmed: !!user.email_confirmed_at };
        },
        async cancelDeletion(requestId, userId, tokenHash) {
          const { error } = await trusted.rpc("cancel_account_deletion_for_server", {
            _request_id: requestId,
            _verified_user_id: userId,
            _token_hash: tokenHash,
          });
          if (error) throw new Error("account_deletion_cancellation_failed");
        },
      },
      body.request_id,
      body.token,
    );
    const { error: signOutError } = await trusted.auth.admin.signOut(accessToken, "global");
    if (signOutError) return json(500, { code: "post_cancellation_session_revocation_failed" });
    return json(200, { status: "cancelled", requires_new_login: true });
  } catch (error) {
    const code = error instanceof Error ? error.message : "account_deletion_cancellation_failed";
    return json(code === "unauthorized" ? 401 : 400, { code });
  }
}
