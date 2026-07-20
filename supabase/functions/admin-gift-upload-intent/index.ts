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

function reply(status: number, code: string, origin: string | null) {
  return new Response(JSON.stringify({ code }), { status, headers: headers(origin) });
}

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  if (request.method !== "POST") return reply(404, "gift_upload_not_available", origin);

  const authorization = request.headers.get("Authorization");
  if (!authorization) return reply(401, "unauthorized", origin);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return reply(400, "invalid_request", origin);
  }

  if (
    typeof body.collection_id !== "string" ||
    !UUID.test(body.collection_id) ||
    typeof body.name !== "string" ||
    body.name.trim().length < 1 ||
    body.name.trim().length > 120 ||
    typeof body.price_credits !== "number" ||
    !Number.isInteger(body.price_credits) ||
    body.price_credits <= 0 ||
    body.content_type !== "image/webp" ||
    (body.sort_order !== undefined && (typeof body.sort_order !== "number" || !Number.isInteger(body.sort_order)))
  ) {
    return reply(400, "invalid_request", origin);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  if (!url || !key || !service) return reply(404, "gift_upload_not_available", origin);

  const caller = createClient(url, key, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth } = await caller.auth.getUser();
  if (!auth.user) return reply(401, "unauthorized", origin);

  const trusted = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: rows, error } = await trusted.rpc("create_gift_upload_intent_for_server", {
    _actor_user_id: auth.user.id,
    _collection_id: body.collection_id,
    _gift_name: body.name.trim(),
    _price_credits: body.price_credits,
    _sort_order: body.sort_order ?? 0,
  });
  const intent = Array.isArray(rows) ? rows[0] : null;
  if (error || !intent?.gift_id || !intent.object_path) {
    return reply(error?.message.includes("admin_required") ? 403 : 422, "gift_upload_not_available", origin);
  }

  const { data: signed, error: signError } = await trusted.storage
    .from("gift-media")
    .createSignedUploadUrl(intent.object_path);
  if (signError || !signed?.signedUrl) return reply(404, "gift_upload_not_available", origin);

  const uploadUrl = /^https?:\/\//i.test(signed.signedUrl)
    ? signed.signedUrl
    : new URL(
      signed.signedUrl.startsWith("/storage/")
        ? signed.signedUrl
        : `/storage/v1${signed.signedUrl.startsWith("/") ? "" : "/"}${signed.signedUrl}`,
      url,
    ).toString();

  return new Response(
    JSON.stringify({ gift_id: intent.gift_id, upload_url: uploadUrl, expires_at: new Date(Date.now() + 7200000).toISOString() }),
    { status: 200, headers: headers(origin) },
  );
});
