import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { ImageMagick, initializeImageMagick, MagickFormat } from "npm:@imagemagick/magick-wasm@0.0.30";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let ready: Promise<void> | null = null;
function headers(origin: string | null) { return { "Access-Control-Allow-Origin": origin ?? "null", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Cache-Control": "private, no-store, max-age=0", Vary: "Authorization, Origin", "Content-Type": "application/json" }; }
function response(status: number, code: string, origin: string | null) { return new Response(JSON.stringify({ code }), { status, headers: headers(origin) }); }
function isWebp(bytes: Uint8Array) { return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"; }
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
    if (blob.size < 1 || blob.size > 524288) throw new Error("source_too_large");
    const bytes = new Uint8Array(await blob.arrayBuffer()); if (!isWebp(bytes)) throw new Error("source_mime_invalid");
    await init();
    const output = ImageMagick.read(bytes, (image) => { if (image.width < 1 || image.height < 1 || image.width > 4096 || image.height > 4096) throw new Error("source_dimensions_invalid"); image.strip(); return { width: image.width, height: image.height, bytes: image.write(MagickFormat.Webp, (result) => result) }; });
    if (output.bytes.byteLength > 524288) throw new Error("source_too_large");
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
    return response(422, "sticker_processing_failed", origin);
  }
});
