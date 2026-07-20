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
function reply(status: number, code: string, origin: string | null) { return new Response(JSON.stringify({ code }), { status, headers: headers(origin) }); }

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  if (request.method !== "POST") return reply(404, "gift_delete_not_available", origin);
  const authorization = request.headers.get("Authorization");
  if (!authorization) return reply(401, "unauthorized", origin);
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return reply(400, "invalid_request", origin); }
  if (typeof body.gift_id !== "string" || !UUID.test(body.gift_id)) return reply(400, "invalid_request", origin);

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  if (!url || !key || !service) return reply(404, "gift_delete_not_available", origin);
  const caller = createClient(url, key, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: auth } = await caller.auth.getUser();
  if (!auth.user) return reply(401, "unauthorized", origin);
  const trusted = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: rows, error: beginError } = await trusted.rpc("begin_gift_hard_delete_for_server", {
    _actor_user_id: auth.user.id,
    _gift_id: body.gift_id,
  });
  const begin = Array.isArray(rows) ? rows[0] : null;
  if (beginError || !begin?.gift_id) {
    const code = beginError?.message.includes("gift_in_use") ? "gift_in_use" : "gift_delete_not_available";
    return reply(code === "gift_in_use" ? 409 : 422, code, origin);
  }

  if (typeof begin.object_path === "string" && begin.object_path) {
    const { error: removeError } = await trusted.storage.from("gift-media").remove([begin.object_path]);
    if (removeError) return reply(422, "gift_storage_delete_failed", origin);
  }

  const { error: completeError } = await trusted.rpc("complete_gift_hard_delete_for_server", {
    _actor_user_id: auth.user.id,
    _gift_id: begin.gift_id,
  });
  if (completeError) {
    const code = completeError.message.includes("gift_in_use") ? "gift_in_use" : "gift_delete_failed";
    return reply(code === "gift_in_use" ? 409 : 422, code, origin);
  }
  return new Response(JSON.stringify({ deleted: true }), { status: 200, headers: headers(origin) });
});
