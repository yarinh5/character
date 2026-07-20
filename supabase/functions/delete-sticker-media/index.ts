import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function response(status: number, code: string, origin: string | null) {
  return new Response(JSON.stringify({ code }), { status, headers: headers(origin) });
}

function errorCode(message: string) {
  if (message.includes("sticker_in_use")) return "sticker_in_use";
  if (message.includes("sticker_not_found")) return "sticker_not_found";
  if (message.includes("admin_required")) return "admin_required";
  return "sticker_delete_not_available";
}

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  if (request.method !== "POST") return response(404, "sticker_delete_not_available", origin);

  const authorization = request.headers.get("Authorization");
  if (!authorization) return response(401, "unauthorized", origin);

  let body: { sticker_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return response(400, "invalid_request", origin);
  }
  if (typeof body.sticker_id !== "string" || !UUID.test(body.sticker_id)) {
    return response(400, "invalid_request", origin);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  if (!url || !key || !service) return response(404, "sticker_delete_not_available", origin);

  const caller = createClient(url, key, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth } = await caller.auth.getUser();
  if (!auth.user) return response(401, "unauthorized", origin);

  const trusted = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await trusted.rpc("begin_sticker_hard_delete_for_server", {
    _actor_user_id: auth.user.id,
    _sticker_id: body.sticker_id,
  });
  if (error) {
    const code = errorCode(error.message);
    return response(code === "sticker_in_use" ? 409 : code === "admin_required" ? 403 : 422, code, origin);
  }

  const pending = Array.isArray(data) ? data[0] : null;
  if (!pending?.sticker_id || !Array.isArray(pending.source_paths) || typeof pending.object_path !== "string") {
    return response(404, "sticker_delete_not_available", origin);
  }

  const paths = [...new Set([...pending.source_paths, pending.object_path].filter((path): path is string => typeof path === "string" && path.length > 0))];
  const { error: removeError } = await trusted.storage.from("sticker-media").remove(paths);
  if (removeError) return response(422, "sticker_storage_cleanup_failed", origin);

  const { error: completeError } = await trusted.rpc("complete_sticker_hard_delete_for_server", {
    _actor_user_id: auth.user.id,
    _sticker_id: body.sticker_id,
  });
  if (completeError) {
    const code = errorCode(completeError.message);
    return response(code === "sticker_in_use" ? 409 : 422, code, origin);
  }

  return new Response(JSON.stringify({ deleted: true }), { status: 200, headers: headers(origin) });
});
