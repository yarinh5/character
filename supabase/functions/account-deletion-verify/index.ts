import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  type AccountDeletionJson,
  withAccountDeletionHttp,
} from "../_shared/account-deletion-http.ts";
import { confirmAccountDeletion } from "../_shared/deletion-verification-orchestration.ts";

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
    await confirmAccountDeletion(
      {
        sha256,
        async currentIdentity() {
          const { data, error } = await caller.auth.getUser();
          const user = data.user;
          if (error || !user?.id || !user.email) throw new Error("unauthorized");
          return { id: user.id, email: user.email, emailConfirmed: !!user.email_confirmed_at };
        },
        async verifyDeletion(requestId, tokenHash, userId) {
          const { error } = await trusted.rpc("verify_account_deletion_for_server", {
            _request_id: requestId,
            _token_hash: tokenHash,
            _verified_user_id: userId,
          });
          if (error) throw new Error("deletion_verification_failed");
        },
        async claimAccountStep(requestId) {
          const { data, error } = await trusted.rpc("claim_account_deletion_step_for_server", {
            _request_id: requestId,
          });
          if (error) throw new Error("session_revocation_claim_failed");
          return Array.isArray(data) ? (data[0] ?? null) : null;
        },
        async revokeGlobalSessions(jwt) {
          const { error } = await trusted.auth.admin.signOut(jwt, "global");
          if (error) throw new Error("auth_session_revocation_failed");
        },
        async completeAccountStep(requestId, stepName, claimToken, evidence) {
          const { error } = await trusted.rpc("complete_account_deletion_step_for_server", {
            _request_id: requestId,
            _step_name: stepName,
            _claim_token: claimToken,
            _evidence: evidence,
          });
          if (error) throw new Error("session_revocation_completion_failed");
        },
        async failAccountStep(requestId, stepName, claimToken, failureCode) {
          const { error } = await trusted.rpc("fail_account_deletion_step_for_server", {
            _request_id: requestId,
            _step_name: stepName,
            _claim_token: claimToken,
            _failure_code: failureCode,
          });
          if (error) throw new Error("session_revocation_failure_persistence_failed");
        },
      },
      body.request_id,
      body.token,
      accessToken,
    );
    return json(200, { status: "cancellation_window", sessions_revoked: true });
  } catch (error) {
    const code = error instanceof Error ? error.message : "account_deletion_verification_failed";
    return json(code === "unauthorized" ? 401 : 400, { code });
  }
}
