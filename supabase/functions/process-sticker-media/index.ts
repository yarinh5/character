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

function response(status: number, code: string, origin: string | null) {
  return new Response(JSON.stringify({ code }), { status, headers: headers(origin) });
}

function readUint24LE(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUint16LE(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function equalsAscii(bytes: Uint8Array, offset: number, value: string) {
  return value.split("").every((char, index) => bytes[offset + index] === char.charCodeAt(0));
}

function getWebpDimensions(bytes: Uint8Array) {
  if (
    bytes.length < 20 ||
    !equalsAscii(bytes, 0, "RIFF") ||
    !equalsAscii(bytes, 8, "WEBP")
  ) {
    return null;
  }

  for (let offset = 12; offset + 8 <= bytes.length;) {
    const chunkSize = bytes[offset + 4] |
      (bytes[offset + 5] << 8) |
      (bytes[offset + 6] << 16) |
      (bytes[offset + 7] << 24);
    const dataOffset = offset + 8;
    const nextOffset = dataOffset + chunkSize + (chunkSize % 2);
    if (chunkSize < 0 || nextOffset > bytes.length) return null;

    if (equalsAscii(bytes, offset, "VP8X") && chunkSize >= 10) {
      return {
        width: readUint24LE(bytes, dataOffset + 4) + 1,
        height: readUint24LE(bytes, dataOffset + 7) + 1,
      };
    }

    if (
      equalsAscii(bytes, offset, "VP8 ") &&
      chunkSize >= 10 &&
      bytes[dataOffset + 3] === 0x9d &&
      bytes[dataOffset + 4] === 0x01 &&
      bytes[dataOffset + 5] === 0x2a
    ) {
      return {
        width: readUint16LE(bytes, dataOffset + 6) & 0x3fff,
        height: readUint16LE(bytes, dataOffset + 8) & 0x3fff,
      };
    }

    if (equalsAscii(bytes, offset, "VP8L") && chunkSize >= 5 && bytes[dataOffset] === 0x2f) {
      const width = 1 + bytes[dataOffset + 1] + ((bytes[dataOffset + 2] & 0x3f) << 8);
      const height = 1 + ((bytes[dataOffset + 2] >> 6) | (bytes[dataOffset + 3] << 2) | ((bytes[dataOffset + 4] & 0x0f) << 10));
      return { width, height };
    }

    offset = nextOffset;
  }

  return null;
}

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  if (request.method !== "POST") return response(404, "sticker_processing_not_available", origin);

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
  if (!url || !key || !service) return response(404, "sticker_processing_not_available", origin);

  const caller = createClient(url, key, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth } = await caller.auth.getUser();
  if (!auth.user) return response(401, "unauthorized", origin);

  const trusted = createClient(url, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let code = "sticker_processing_failed";
  try {
    const { data: rows, error } = await trusted.rpc("begin_sticker_processing_for_server", {
      _actor_user_id: auth.user.id,
      _sticker_id: body.sticker_id,
    });
    const begin = Array.isArray(rows) ? rows[0] : null;
    if (error) {
      code = error.message.includes("sticker_processing_in_progress")
        ? "sticker_processing_in_progress"
        : error.message.includes("sticker_deletion_in_progress")
          ? "sticker_deletion_in_progress"
          : "sticker_processing_not_available";
      return response(code === "sticker_processing_in_progress" ? 409 : 422, code, origin);
    }

    if (!begin?.sticker_id || !begin.object_path) {
      return response(404, "sticker_processing_not_available", origin);
    }

    if (begin.already_ready) {
      return new Response(
        JSON.stringify({ sticker_id: begin.sticker_id, ingest_status: "ready", already_ready: true }),
        { status: 200, headers: headers(origin) },
      );
    }

    const { data: blob, error: downloadError } = await trusted.storage
      .from("sticker-media")
      .download(begin.object_path);
    if (downloadError || !blob) throw new Error("render_missing");
    if (blob.size < 1 || blob.size > MAX_RENDER_BYTES) throw new Error("render_too_large");

    const dimensions = getWebpDimensions(new Uint8Array(await blob.arrayBuffer()));
    if (!dimensions) throw new Error("render_mime_invalid");
    if (
      dimensions.width < 1 ||
      dimensions.height < 1 ||
      dimensions.width > MAX_RENDER_SIDE ||
      dimensions.height > MAX_RENDER_SIDE
    ) {
      throw new Error("render_dimensions_invalid");
    }

    const { data: finalized, error: finalizeError } = await trusted.rpc(
      "complete_sticker_processing_for_server",
      {
        _actor_user_id: auth.user.id,
        _sticker_id: body.sticker_id,
        _width: dimensions.width,
        _height: dimensions.height,
        _byte_size: blob.size,
      },
    );
    if (finalizeError) throw new Error("render_finalize_failed");

    const result = Array.isArray(finalized) ? finalized[0] : null;
    return new Response(
      JSON.stringify({
        sticker_id: result?.sticker_id ?? body.sticker_id,
        ingest_status: "ready",
        already_ready: result?.already_ready === true,
      }),
      { status: 200, headers: headers(origin) },
    );
  } catch (error) {
    code = error instanceof Error ? error.message : code;
    await trusted.rpc("fail_sticker_processing_for_server", {
      _actor_user_id: auth.user.id,
      _sticker_id: body.sticker_id,
      _failure_code: code,
    }).catch(() => undefined);

    return response(
      422,
      ["render_missing", "render_too_large", "render_mime_invalid", "render_dimensions_invalid"].includes(code)
        ? code
        : "sticker_processing_failed",
      origin,
    );
  }
});
