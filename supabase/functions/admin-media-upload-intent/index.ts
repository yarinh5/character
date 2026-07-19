import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type UploadIntent = {
  character_id?: unknown;
  content_type?: unknown;
  display_name?: unknown;
};

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

function errorResponse(status: number, code: "unauthorized" | "invalid_request" | "media_upload_not_available", origin: string | null) {
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
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  if (request.method !== "POST") return errorResponse(404, "media_upload_not_available", origin);

  const authorization = request.headers.get("Authorization");
  if (!authorization) return errorResponse(401, "unauthorized", origin);

  let body: UploadIntent;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_request", origin);
  }

  if (
    typeof body.character_id !== "string" ||
    !UUID_PATTERN.test(body.character_id) ||
    typeof body.content_type !== "string" ||
    !ALLOWED_CONTENT_TYPES.has(body.content_type) ||
    (body.display_name !== undefined && typeof body.display_name !== "string") ||
    (typeof body.display_name === "string" && body.display_name.length > 200)
  ) {
    return errorResponse(400, "invalid_request", origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
    console.error("admin_media_upload_intent_configuration_missing");
    return errorResponse(404, "media_upload_not_available", origin);
  }

  const caller = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await caller.auth.getUser();
  if (userError || !userData.user) return errorResponse(401, "unauthorized", origin);

  const trusted = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: assetRows, error: createError } = await trusted.rpc("create_character_media_upload_intent_for_server", {
    _actor_user_id: userData.user.id,
    _character_id: body.character_id,
    _content_type: body.content_type,
    _display_name: typeof body.display_name === "string" ? body.display_name : null,
  });
  const asset = Array.isArray(assetRows) ? assetRows[0] : null;
  if (createError || !asset || typeof asset.asset_id !== "string" || typeof asset.source_path !== "string") {
    return errorResponse(createError?.message.includes("admin_required") ? 403 : 404, "media_upload_not_available", origin);
  }

  const { data: signedUpload, error: signError } = await trusted.storage
    .from("character-media")
    .createSignedUploadUrl(asset.source_path);
  if (signError || !signedUpload?.signedUrl) {
    console.error("admin_media_upload_intent_sign_failed");
    return errorResponse(404, "media_upload_not_available", origin);
  }

  return new Response(
    JSON.stringify({
      asset_id: asset.asset_id,
      upload_url: normalizeSignedUploadUrl(supabaseUrl, signedUpload.signedUrl),
      expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    }),
    { status: 200, headers: headers(origin) },
  );
});
