import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RENDER_BYTES = 524288;
const MAX_RENDER_SIDE = 768;

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

function littleEndian(bytes: Uint8Array, offset: number, length: number) {
  let value = 0;
  for (let index = 0; index < length; index += 1) value |= bytes[offset + index] << (index * 8);
  return value >>> 0;
}

function getWebpDimensions(bytes: Uint8Array) {
  if (
    bytes.length < 30 ||
    String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" ||
    String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP"
  ) return null;
  const kind = String.fromCharCode(...bytes.slice(12, 16));
  if (kind === "VP8X" && bytes.length >= 30) {
    return { width: 1 + littleEndian(bytes, 24, 3), height: 1 + littleEndian(bytes, 27, 3) };
  }
  if (kind === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: littleEndian(bytes, 26, 2) & 0x3fff, height: littleEndian(bytes, 28, 2) & 0x3fff };
  }
  if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = littleEndian(bytes, 21, 4);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  if (request.method !== "POST") return reply(404, "gift_processing_not_available", origin);
  const authorization = request.headers.get("Authorization");
  if (!authorization) return reply(401, "unauthorized", origin);
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return reply(400, "invalid_request", origin); }
  if (typeof body.gift_id !== "string" || !UUID.test(body.gift_id)) return reply(400, "invalid_request", origin);

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  if (!url || !key || !service) return reply(404, "gift_processing_not_available", origin);
  const caller = createClient(url, key, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: auth } = await caller.auth.getUser();
  if (!auth.user) return reply(401, "unauthorized", origin);
  const trusted = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

  let failureCode = "gift_processing_failed";
  try {
    const { data: rows, error } = await trusted.rpc("begin_gift_processing_for_server", {
      _actor_user_id: auth.user.id,
      _gift_id: body.gift_id,
    });
    const begin = Array.isArray(rows) ? rows[0] : null;
    if (error) {
      const code = error.message.includes("gift_processing_in_progress")
        ? "gift_processing_in_progress"
        : error.message.includes("gift_deletion_in_progress")
          ? "gift_deletion_in_progress"
          : "gift_processing_not_available";
      return reply(code === "gift_processing_in_progress" ? 409 : 422, code, origin);
    }
    if (!begin?.gift_id || !begin.object_path) return reply(404, "gift_processing_not_available", origin);
    if (begin.already_ready) {
      return new Response(JSON.stringify({ gift_id: begin.gift_id, ingest_status: "ready", already_ready: true }), { status: 200, headers: headers(origin) });
    }

    const { data: blob, error: downloadError } = await trusted.storage.from("gift-media").download(begin.object_path);
    if (downloadError || !blob) throw new Error("render_missing");
    if (blob.size < 1 || blob.size > MAX_RENDER_BYTES) throw new Error("render_too_large");
    const dimensions = getWebpDimensions(new Uint8Array(await blob.arrayBuffer()));
    if (!dimensions) throw new Error("render_mime_invalid");
    if (dimensions.width < 1 || dimensions.height < 1 || dimensions.width > MAX_RENDER_SIDE || dimensions.height > MAX_RENDER_SIDE) {
      throw new Error("render_dimensions_invalid");
    }

    const { data: finalized, error: finalizeError } = await trusted.rpc("complete_gift_processing_for_server", {
      _actor_user_id: auth.user.id,
      _gift_id: begin.gift_id,
      _width: dimensions.width,
      _height: dimensions.height,
      _byte_size: blob.size,
    });
    if (finalizeError) throw new Error("finalize_failed");
    const result = Array.isArray(finalized) ? finalized[0] : null;
    return new Response(JSON.stringify({ gift_id: result?.gift_id ?? begin.gift_id, ingest_status: "ready", already_ready: Boolean(result?.already_ready) }), { status: 200, headers: headers(origin) });
  } catch (error) {
    failureCode = error instanceof Error ? error.message : failureCode;
    await trusted.rpc("fail_gift_processing_for_server", {
      _actor_user_id: auth.user.id,
      _gift_id: body.gift_id,
      _failure_code: failureCode,
    });
    const code = failureCode === "render_missing" || failureCode === "render_too_large" || failureCode === "render_mime_invalid" || failureCode === "render_dimensions_invalid"
      ? failureCode
      : "gift_processing_failed";
    return reply(422, code, origin);
  }
});
