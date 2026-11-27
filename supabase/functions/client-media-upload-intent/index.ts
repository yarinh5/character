import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function headers(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin ?? "null",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "private, no-store, max-age=0",
    Vary: "Authorization, Origin",
    "Content-Type": "application/json",
  };
}

function errorResponse(status: number, code: string, origin: string | null) {
  return new Response(JSON.stringify({ code }), { status, headers: headers(origin) });
}

function normalizeSignedUploadUrl(supabaseUrl: string, signedUrl: string) {
  if (/^https?:\/\//i.test(signedUrl)) return signedUrl;
  const storagePath = signedUrl.startsWith("/storage/v1/")
    ? signedUrl
    : `/storage/v1${signedUrl.startsWith("/") ? "" : "/"}${signedUrl}`;
  return new URL(storagePath, supabaseUrl).toString();
}

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: headers(origin) });
  if (request.method !== "POST") return errorResponse(404, "upload_intent_not_available", origin);

  const authorization = request.headers.get("Authorization");
  if (!authorization) return errorResponse(401, "unauthorized", origin);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_request", origin);
  }
  if (
    typeof body.conversation_id !== "string" ||
    !UUID_PATTERN.test(body.conversation_id) ||
    typeof body.content_type !== "string" ||
    !ALLOWED_CONTENT_TYPES.has(body.content_type)
  ) {
    return errorResponse(400, "invalid_request", origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey =
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
    console.error("client_media_upload_intent_configuration_missing");
    return errorResponse(404, "upload_intent_not_available", origin);
  }

  const caller = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await caller.auth.getUser();
  if (userError || !userData.user) return errorResponse(401, "unauthorized", origin);

  const { data: rows, error: createError } = await caller.rpc("create_client_media_upload_intent", {
    _conversation_id: body.conversation_id,
    _content_type: body.content_type,
  });
  const intent = Array.isArray(rows) ? rows[0] : null;
  if (
    createError ||
    !intent ||
    typeof intent.upload_id !== "string" ||
    typeof intent.source_path !== "string" ||
    typeof intent.upload_expires_at !== "string"
  ) {
    return errorResponse(404, "upload_intent_not_available", origin);
  }

  const trusted = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signedUpload, error: signError } = await trusted.storage
    .from("client-media")
    .createSignedUploadUrl(intent.source_path);
  if (signError || !signedUpload?.signedUrl) {
    console.error("client_media_upload_intent_sign_failed");
    return errorResponse(404, "upload_intent_not_available", origin);
  }

  return new Response(
    JSON.stringify({
      upload_id: intent.upload_id,
      upload_url: normalizeSignedUploadUrl(supabaseUrl, signedUpload.signedUrl),
      expires_at: intent.upload_expires_at,
    }),
    { status: 200, headers: headers(origin) },
  );
});
