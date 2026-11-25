import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildServerConfigurationStatus } from "../_shared/configuration-connections.ts";

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });

Deno.serve(async (request) => {
  if (request.method !== "GET" && request.method !== "POST") {
    return json(404, { code: "not_found" });
  }
  const url = Deno.env.get("SUPABASE_URL");
  const publishable = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  const authorization = request.headers.get("Authorization") ?? "";
  if (!url || !publishable || !service) return json(503, { code: "status_boundary_unconfigured" });
  if (!authorization.startsWith("Bearer ")) return json(401, { code: "unauthorized" });

  const caller = createClient(url, publishable, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const trusted = createClient(url, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: identity, error: identityError } = await caller.auth.getUser();
  if (identityError || !identity.user?.id) return json(401, { code: "unauthorized" });
  const { data: role, error: roleError } = await trusted
    .from("user_roles")
    .select("role")
    .eq("user_id", identity.user.id)
    .eq("role", "admin")
    .maybeSingle();
  if (roleError || !role) return json(403, { code: "admin_required" });

  const status = buildServerConfigurationStatus({
    AUTH_REDIRECT_ALLOWED_ORIGINS: Deno.env.get("AUTH_REDIRECT_ALLOWED_ORIGINS"),
    AUTH_EMAIL_VERIFICATION_REDIRECT_URL: Deno.env.get(
      "AUTH_EMAIL_VERIFICATION_REDIRECT_URL",
    ),
    ACCOUNT_DELETION_CONFIRM_REDIRECT_URL: Deno.env.get(
      "ACCOUNT_DELETION_CONFIRM_REDIRECT_URL",
    ),
    ACCOUNT_DELETION_CANCEL_REDIRECT_URL: Deno.env.get(
      "ACCOUNT_DELETION_CANCEL_REDIRECT_URL",
    ),
    RESTORE_RECOVERY_AUTHORITY_HMAC_KEY: Deno.env.get("RESTORE_RECOVERY_AUTHORITY_HMAC_KEY"),
    RESTORE_RECOVERY_EXPECTED_LOCK_ID: Deno.env.get("RESTORE_RECOVERY_EXPECTED_LOCK_ID"),
    RESTORE_RECOVERY_EXPECTED_AUTHORITY_ID: Deno.env.get(
      "RESTORE_RECOVERY_EXPECTED_AUTHORITY_ID",
    ),
    RESTORE_RECOVERY_CONTRACT_VERSION: Deno.env.get("RESTORE_RECOVERY_CONTRACT_VERSION"),
    RESTORE_RECOVERY_IMPORT_ENABLED: Deno.env.get("RESTORE_RECOVERY_IMPORT_ENABLED"),
    RESTORE_RECOVERY_RELEASE_ENABLED: Deno.env.get("RESTORE_RECOVERY_RELEASE_ENABLED"),
    RESTORE_RECOVERY_REPLAY_ENABLED: Deno.env.get("RESTORE_RECOVERY_REPLAY_ENABLED"),
  });

  const { data: legalDocuments, error: legalError } = await trusted
    .from("client_consent_documents")
    .select("id,lifecycle_status,approved_at,retired_at,required")
    .eq("required", true)
    .eq("lifecycle_status", "active")
    .is("retired_at", null);
  status.push({
    key: "approved_legal_content",
    state:
      !legalError && legalDocuments?.some((document) => !!document.approved_at)
        ? "verified"
        : "not_configured",
    actionsEnabled: false,
    requiredBy: "client_consent_activation",
  });
  return json(200, { status });
});
