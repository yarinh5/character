import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function response(status: number, body: Record<string, unknown>, origin: string | null) {
  return new Response(JSON.stringify(body), { status, headers: headers(origin) });
}

function failureCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("media_asset_in_use")) return "media_asset_in_use";
  if (message.includes("media_asset_not_found")) return "media_asset_not_found";
  if (message.includes("admin_required")) return "admin_required";
  return "media_delete_failed";
}

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  if (request.method !== "POST") return response(404, { code: "media_delete_not_available" }, origin);

  const authorization = request.headers.get("Authorization");
  if (!authorization) return response(401, { code: "unauthorized" }, origin);

  let body: { asset_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return response(400, { code: "invalid_request" }, origin);
  }
  if (typeof body.asset_id !== "string" || !UUID_PATTERN.test(body.asset_id)) {
    return response(400, { code: "invalid_request" }, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
    console.error("delete_character_media_configuration_missing");
    return response(404, { code: "media_delete_not_available" }, origin);
  }

  const caller = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await caller.auth.getUser();
  if (userError || !userData.user) return response(401, { code: "unauthorized" }, origin);

  const trusted = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: rows, error: beginError } = await trusted.rpc("begin_character_media_hard_delete_for_server", {
    _actor_user_id: userData.user.id,
    _asset_id: body.asset_id,
  });
  const asset = Array.isArray(rows) ? rows[0] : null;
  if (beginError || !asset || typeof asset.bucket_id !== "string") {
    const code = failureCode(beginError);
    return response(code === "admin_required" ? 403 : code === "media_asset_in_use" ? 409 : 404, { code }, origin);
  }

  const paths = [asset.source_path, asset.preview_path, asset.locked_teaser_path, asset.locked_delivery_path]
    .filter((path): path is string => typeof path === "string" && path.length > 0);
  const { error: storageError } = await trusted.storage.from(asset.bucket_id).remove(paths);
  if (storageError) {
    console.error("delete_character_media_storage_remove_failed");
    return response(502, { code: "media_delete_failed" }, origin);
  }

  const { error: finalizeError } = await trusted.rpc("finalize_character_media_hard_delete_for_server", {
    _actor_user_id: userData.user.id,
    _asset_id: body.asset_id,
  });
  if (finalizeError) {
    console.error("delete_character_media_finalize_failed");
    return response(409, { code: failureCode(finalizeError) }, origin);
  }

  return response(200, { deleted: true }, origin);
});
