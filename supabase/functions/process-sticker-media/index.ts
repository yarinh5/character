import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { ImageMagick, initializeImageMagick, MagickFormat } from "npm:@imagemagick/magick-wasm@0.0.30";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SOURCE_SIDE = 8192;
const MAX_SOURCE_PIXELS = 24000000;
const MAX_RENDER_SIDE = 768;
const MAX_RENDER_BYTES = 524288;
let ready: Promise<void> | null = null;
function headers(origin: string | null) { return { "Access-Control-Allow-Origin": origin ?? "null", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Cache-Control": "private, no-store, max-age=0", Vary: "Authorization, Origin", "Content-Type": "application/json" }; }
function response(status: number, code: string, origin: string | null) { return new Response(JSON.stringify({ code }), { status, headers: headers(origin) }); }
function detectSourceContentType(bytes: Uint8Array) {
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}
function expectedSourceContentType(sourcePath: string) {
  if (sourcePath.endsWith(".webp")) return "image/webp";
  if (sourcePath.endsWith(".png")) return "image/png";
  if (sourcePath.endsWith(".jpg") || sourcePath.endsWith(".jpeg")) return "image/jpeg";
  return null;
}
async function init() { ready ??= Deno.readFile(new URL("magick.wasm", import.meta.resolve("npm:@imagemagick/magick-wasm@0.0.30"))).then(initializeImageMagick); return ready; }

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  if (request.method !== "POST") return response(404, "sticker_processing_not_available", origin);
  const authorization = request.headers.get("Authorization");
  if (!authorization) return response(401, "unauthorized", origin);
  let body: { sticker_id?: unknown }; try { body = await request.json(); } catch { return response(400, "invalid_request", origin); }
  if (typeof body.sticker_id !== "string" || !UUID.test(body.sticker_id)) return response(400, "invalid_request", origin);
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY"), service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  if (!url || !key || !service) return response(404, "sticker_processing_not_available", origin);
  const caller = createClient(url, key, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: auth } = await caller.auth.getUser(); if (!auth.user) return response(401, "unauthorized", origin);
  const trusted = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  let sourcePath: string | null = null, objectPath: string | null = null, wroteRender = false;
  try {
    const { data: rows, error } = await trusted.rpc("begin_sticker_processing_for_server", { _actor_user_id: auth.user.id, _sticker_id: body.sticker_id });
    const begin = Array.isArray(rows) ? rows[0] : null;
    if (error) return response(error.message.includes("in_progress") ? 409 : 422, error.message.includes("upload_required") ? "sticker_upload_required" : "sticker_processing_not_available", origin);
    if (!begin?.sticker_id) return response(404, "sticker_processing_not_available", origin);
    if (begin.already_ready) return new Response(JSON.stringify({ sticker_id: begin.sticker_id, ingest_status: "ready", already_ready: true }), { status: 200, headers: headers(origin) });
    sourcePath = begin.source_path; objectPath = begin.object_path;
    if (!sourcePath || !objectPath) throw new Error("storage_temporary_failure");
    const { data: blob, error: downloadError } = await trusted.storage.from("sticker-media").download(sourcePath);
    if (downloadError || !blob) throw new Error("storage_temporary_failure");
    if (blob.size < 1 || blob.size > 5242880) throw new Error("source_too_large");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const sourceContentType = detectSourceContentType(bytes);
    if (!sourceContentType || sourceContentType !== expectedSourceContentType(sourcePath)) throw new Error("source_mime_invalid");
    await init();
    let output: { width: number; height: number; bytes: Uint8Array };
    try {
      output = ImageMagick.read(bytes, (image) => {
        if (
          image.width < 1 ||
          image.height < 1 ||
          image.width > MAX_SOURCE_SIDE ||
          image.height > MAX_SOURCE_SIDE ||
          image.width * image.height > MAX_SOURCE_PIXELS
        ) {
          throw new Error("source_dimensions_unsafe");
        }

        const scale = Math.min(1, MAX_RENDER_SIDE / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        if (scale < 1) image.resize(width, height);
        image.strip();
        image.quality = 82;
        return { width, height, bytes: image.write(MagickFormat.Webp, (result) => result) };
      });
    } catch (error) {
      if (error instanceof Error && error.message === "source_dimensions_unsafe") throw error;
      throw new Error("source_decode_failed");
    }
    if (output.bytes.byteLength > MAX_RENDER_BYTES) throw new Error("render_too_large");
    const { error: uploadError } = await trusted.storage.from("sticker-media").upload(objectPath, output.bytes, { contentType: "image/webp", cacheControl: "0", upsert: true });
    if (uploadError) throw new Error("render_temporary_failure"); wroteRender = true;
    const { data: finalized, error: finalizeError } = await trusted.rpc("complete_sticker_processing_for_server", { _actor_user_id: auth.user.id, _sticker_id: body.sticker_id, _width: output.width, _height: output.height, _byte_size: output.bytes.byteLength });
    if (finalizeError) throw new Error("finalize_temporary_failure");
    await trusted.storage.from("sticker-media").remove([sourcePath]);
    const result = Array.isArray(finalized) ? finalized[0] : null;
    return new Response(JSON.stringify({ sticker_id: result?.sticker_id ?? body.sticker_id, ingest_status: "ready", already_ready: result?.already_ready === true }), { status: 200, headers: headers(origin) });
  } catch (error) {
    if (wroteRender && objectPath) await trusted.storage.from("sticker-media").remove([objectPath]);
    const code = error instanceof Error ? error.message : "render_temporary_failure";
    await trusted.rpc("fail_sticker_processing_for_server", { _actor_user_id: auth.user.id, _sticker_id: body.sticker_id, _failure_code: code });
    return response(
      422,
      ["source_too_large", "source_mime_invalid", "source_dimensions_unsafe", "source_decode_failed", "render_too_large"].includes(code)
        ? code
        : "sticker_processing_failed",
      origin,
    );
  }
});
